/**
 * Heuristic announce-without-act detector + steer monitor.
 *
 * Sibling to heuristic-null-output. Targets a distinct failure shape that
 * surfaced 2x in hindsight-vmf Phase 5 stress tests (phase5-t2-2 boundary +
 * iter-30 canonical, 2026-05-27 / 2026-05-28):
 *   The model engages structured thinking (>200 chars), emits a substantive
 *   "I'll investigate / let me check ..." announce-intent visible (≥50 chars
 *   of real prose), then exits naturally with stopReason "stop" and ZERO tool
 *   calls. The user sees the announce; nothing executes.
 *
 * Distinction from null-output: null-output owns the empty / near-empty
 * visible side (`\n\n`, empty `<think></think>` artifact, bare ```). The
 * 50-char floor here partitions cleanly: phase5-t2-2's 21-char visible falls
 * inside null-output's domain; iter-30's 178-char "I'll investigate ..." falls
 * inside announce-without-act's domain.
 *
 * Detection is heuristic (regex + counts) per the same-model constraint and
 * to keep per-turn overhead negligible. Runs at `agent_end` after the assistant
 * turn settles; if the failure signature is present, the detector currently
 * SHIPS IN OBSERVE-MODE — it records an audit entry and emits a `pi.appendEntry`
 * row but does NOT inject a steer message. Promotion to steer mode is deferred
 * until 2+ accurate fires accumulate in the wild without false positives.
 *
 * Loop limit: same dedupe-by-user-message-id pattern as null-output, applied
 * even in observe-mode so the audit log doesn't repeat-fire on the same turn
 * once steer is enabled.
 *
 * Toggle: respects the package-level `monitorsEnabled` flag (driven by
 * `/monitors on|off`). Additionally honors `PI_ANNOUNCE_WITHOUT_ACT_MONITOR=off`
 * as a hard-disable env override for debugging / replay harness use.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

export const ANNOUNCE_WITHOUT_ACT_MONITOR_NAME = "announce-without-act";

const THINKING_MIN_CHARS = 200;
const VISIBLE_MIN_CHARS = 50; // floor — separates this monitor's domain from null-output's
const VISIBLE_MAX_CHARS = 500; // ceiling — separates pure-announce from substantive answers
const ANNOUNCE_POSITION_MAX = 100; // announce regex must match within first N chars of visible (trimmed leading whitespace)

// Tight regex set anchored to substantive-announce prose observed in iter-30
// + handoff spec. Case-insensitive because the model's capitalization is
// variable. `\b` word boundaries prevent mid-word matches (e.g., "will-call",
// "checklist"). Discipline reminder: tight beats broad — per
// `feedback_handoff_detection_spec_tight_not_broad`, errors of false positive
// are more costly than errors of false negative for observe-mode monitors.
const ANNOUNCE_INTENT_PATTERNS: readonly RegExp[] = [
	/\bI'll\s+(investigate|check|look|examine|run|see|inspect|start|begin)\b/i,
	/\bI\s+will\s+(investigate|check|look|examine|run|see|inspect|start|begin)\b/i,
	/\bLet\s+me\s+(check|look|run|see|inspect|examine|investigate|start)\b/i,
	/\bStarting\s+(with|by)\b/i,
	/\bFirst,?\s+I'll\b/i,
];

export interface AnnounceWithoutActMetrics {
	thinkingChars: number;
	visibleChars: number;
	toolCallCount: number;
	stopReason: string | null;
	visibleSample: string; // first 120 chars of joined visible text
	matchedPattern: string | null; // source of first matching regex, null if no match
	matchPosition: number | null; // position of first match in left-trimmed visible (null if no match)
	userMessageId: string | null;
}

export interface AnnounceWithoutActAuditEntry {
	timestamp: string;
	metrics: AnnounceWithoutActMetrics;
	fired: boolean;
	mode: "observe" | "steer"; // forward-compatible; current default observe
	steered: boolean;
	reason?: string;
}

/**
 * Walk the branch backward from the tail to the most recent user message,
 * aggregating thinking/text/toolCall stats across every assistant message in
 * the current turn. Same aggregation pattern as null-output's analyzeTurn so
 * a multi-message turn (assistant → toolCall → toolResult → trailing
 * assistant text) accumulates correctly.
 */
export function analyzeTurn(branch: SessionEntry[]): AnnounceWithoutActMetrics {
	let thinkingChars = 0;
	let visibleChars = 0;
	let toolCallCount = 0;
	let stopReason: string | null = null;
	let userMessageId: string | null = null;
	const visibleParts: string[] = [];

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; id?: string; message?: { role?: string; stopReason?: string; content?: unknown } };
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "user") {
			userMessageId = entry.id ?? null;
			break;
		}
		if (msg.role !== "assistant") continue;
		if (stopReason === null && typeof msg.stopReason === "string") {
			stopReason = msg.stopReason;
		}
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const part of content as Array<Record<string, unknown>>) {
			const ptype = part?.type;
			if (ptype === "thinking") {
				const t = part.thinking;
				if (typeof t === "string") thinkingChars += t.length;
			} else if (ptype === "text") {
				const t = part.text;
				if (typeof t === "string") {
					visibleChars += t.length;
					visibleParts.unshift(t);
				}
			} else if (ptype === "toolCall" || ptype === "tool_use") {
				toolCallCount++;
			}
		}
	}

	const visible = visibleParts.join("");
	// Trim leading whitespace before measuring position — short preambles like
	// `\n\n` shouldn't count toward the position budget.
	const trimmedVisible = visible.replace(/^\s+/, "");
	let matchedPattern: string | null = null;
	let matchPosition: number | null = null;
	for (const p of ANNOUNCE_INTENT_PATTERNS) {
		const m = p.exec(trimmedVisible);
		if (m !== null) {
			matchedPattern = p.source;
			matchPosition = m.index;
			break;
		}
	}

	return {
		thinkingChars,
		visibleChars,
		toolCallCount,
		stopReason,
		visibleSample: visible.slice(0, 120),
		matchedPattern,
		matchPosition,
		userMessageId,
	};
}

/**
 * Decision rule. ALL criteria must hold (4-criterion conjunction + two
 * structural bounds tightened from corpus replay 2026-05-28):
 *   - 50 ≤ visible text length ≤ 500 chars (≥50 separates from null-output's
 *     domain; ≤500 separates from substantive-answer FPs where "Let me check"
 *     appears as a discourse marker in a long technical response)
 *   - thinking content ≥ 200 chars (model engaged reasoning)
 *   - zero tool calls in this turn (the failure mode, not normal tool use)
 *   - stopReason == "stop" (clean EOS — not aborted, not toolUse, not error)
 *   - visible text matches ≥1 announce-intent regex within the first 100 chars
 *     of the LEFT-TRIMMED visible (catches "announce at start" structural
 *     shape; rejects late-night-refusal and meta-summary FPs where the
 *     regex matches only deep into the response)
 *
 * The two bounds are corpus-derived (4924 historical assistant turns scanned
 * 2026-05-28); see `heuristic-announce-without-act.test.ts` + the replay
 * harness at `tools/announce-without-act-monitor/replay_test.py` for the
 * empirical justification.
 *
 * shouldFire == false when ANY criterion fails. Reason string returned for
 * the negative case is intentionally lossy — the audit entry captures the raw
 * metrics if a follow-up wants more detail.
 */
export function shouldFire(m: AnnounceWithoutActMetrics): { fire: boolean; reason: string } {
	if (m.visibleChars < VISIBLE_MIN_CHARS) {
		return { fire: false, reason: `visibleChars ${m.visibleChars} < ${VISIBLE_MIN_CHARS} (null-output's domain)` };
	}
	if (m.visibleChars > VISIBLE_MAX_CHARS) {
		return { fire: false, reason: `visibleChars ${m.visibleChars} > ${VISIBLE_MAX_CHARS} (likely substantive answer)` };
	}
	if (m.thinkingChars < THINKING_MIN_CHARS) {
		return { fire: false, reason: `thinkingChars ${m.thinkingChars} < ${THINKING_MIN_CHARS}` };
	}
	if (m.toolCallCount > 0) {
		return { fire: false, reason: `toolCallCount ${m.toolCallCount} > 0` };
	}
	if (m.stopReason !== "stop") {
		return { fire: false, reason: `stopReason ${m.stopReason} != stop` };
	}
	if (m.matchedPattern === null) {
		return { fire: false, reason: "visible text did not match any announce-intent pattern" };
	}
	if (m.matchPosition === null || m.matchPosition > ANNOUNCE_POSITION_MAX) {
		return {
			fire: false,
			reason: `match position ${m.matchPosition} > ${ANNOUNCE_POSITION_MAX} (announce not at start of visible)`,
		};
	}
	return { fire: true, reason: "all criteria matched" };
}

/**
 * Install the monitor on the given pi extension API. Idempotent for a single
 * extension-load: registers exactly one agent_end listener. Loop limit +
 * dedupe are tracked in closures scoped to a single session.
 *
 * Returns the audit log (in-memory) for tests/replay tooling. Production
 * callers can ignore the return.
 *
 * NOTE: observe-mode default. To enable steer mode in the future, set
 * opts.steer = true at install time (after 2+ accurate wild fires accumulate
 * with no FPs — separate promotion track).
 */
export function installAnnounceWithoutActMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean; steer?: boolean } = {},
): { audit: AnnounceWithoutActAuditEntry[] } {
	const audit: AnnounceWithoutActAuditEntry[] = [];
	const firedUserMessageIds = new Set<string>();
	const isEnabled = opts.isEnabled ?? (() => true);
	const mode: "observe" | "steer" = opts.steer ? "steer" : "observe";

	// Surface "armed" status to stderr so live-dry-run verification can grep
	// for evidence of installation. Quiet enough to not spam normal usage.
	if (process.env.PI_ANNOUNCE_WITHOUT_ACT_MONITOR !== "off") {
		console.error(`[announce-without-act] heuristic monitor installed (agent_end hook, mode=${mode})`);
	} else {
		console.error("[announce-without-act] heuristic monitor DISABLED via PI_ANNOUNCE_WITHOUT_ACT_MONITOR=off");
	}

	pi.on("agent_end", async (_ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_ANNOUNCE_WITHOUT_ACT_MONITOR === "off") return;
		if (!isEnabled()) return;

		const branch = ctx.sessionManager.getBranch();
		const metrics = analyzeTurn(branch);
		const decision = shouldFire(metrics);

		const entry: AnnounceWithoutActAuditEntry = {
			timestamp: new Date().toISOString(),
			metrics,
			fired: decision.fire,
			mode,
			steered: false,
			reason: decision.reason,
		};

		if (!decision.fire) {
			// Don't log every clean turn — keep audit tight.
			return;
		}

		if (metrics.userMessageId && firedUserMessageIds.has(metrics.userMessageId)) {
			entry.reason = "loop-limit: already fired for this user message";
			audit.push(entry);
			pi.appendEntry(ANNOUNCE_WITHOUT_ACT_MONITOR_NAME, entry);
			return;
		}
		if (metrics.userMessageId) firedUserMessageIds.add(metrics.userMessageId);

		audit.push(entry);
		pi.appendEntry(ANNOUNCE_WITHOUT_ACT_MONITOR_NAME, entry);

		// Observe-mode: stop here. No steer dispatch. Promotion path:
		//   1. accumulate ≥2 accurate wild fires + ≥1 stable-period without
		//      FPs on the corpus
		//   2. spec a follow-up track that flips `opts.steer = true` + wires
		//      a setTimeout(0)-deferred sendMessage analogous to null-output's
		//      pattern at line 213-222 of heuristic-null-output.ts
	});

	return { audit };
}
