/**
 * Heuristic thinking-loop detector.
 *
 * Sibling to heuristic-announce-without-act and heuristic-null-output. Targets
 * a distinct failure shape that surfaced 2× in hindsight-vmf Phase 5 stress
 * tests at n=2 promotion threshold (2026-05-31):
 *   - v6 T8 wp-white-screen-redherring: 28 tool calls, no agent_end, 300s
 *     timeout, last thinking block repeats same 3-paragraph pattern × 3
 *   - T-Phase5-CoverageExpansion R7 ghost-db-mysql-rotation: same shape
 *
 * The model emits a substantive thinking block that contains the SAME long
 * paragraph (>=500 chars) repeated 3+ times within the same message. Visible
 * symptom: agent appears stuck reasoning; tool dispatch stalls or times out.
 *
 * Distinction from PCM6b (the same-pattern detector in `tools/tool_candidates/
 * detectors/thinking_loop.py`):
 *   - PCM6b runs post-hoc on session JSONLs and counts paragraph repeats for
 *     surfacing as a tool-candidate (offline analysis).
 *   - THIS monitor runs LIVE on each `message_end` event and would FLAG (and
 *     in a future steer-mode iter could intercept) the pathology in-stream.
 *   - PCM6b currently has an inflation bug (H5: counts re-emissions of the
 *     incrementally-streamed thinking block). This monitor avoids that by
 *     analyzing the FINAL thinking block at message_end time only — by then
 *     the streaming is settled and the content is stable, so a single
 *     in-message paragraph count is correct.
 *
 * Detection is heuristic (paragraph splitting + duplicate counting) — no LLM
 * dispatch, per the same-model constraint. Currently SHIPS IN OBSERVE-MODE:
 * records an audit entry and emits `pi.appendEntry` row but does NOT inject
 * a steer message. Promotion to steer mode is deferred until 2+ accurate
 * fires accumulate in the wild with low false-positive rate.
 *
 * Loop limit: dedupe-by-(userMessageId, paragraphHash) so the audit log
 * doesn't repeat-fire on the same loop across multiple message_end events
 * within a single turn.
 *
 * Toggle: respects the package-level `monitorsEnabled` flag. Additionally
 * honors `PI_THINKING_LOOP_MONITOR=off` as a hard-disable env override for
 * debugging / replay harness use.
 *
 * 2026-05-31: ALSO hooks `message_update` (specifically the `thinking_end`
 * inner event) so loops that stall mid-stream — where `message_end` never
 * fires because the agent times out before the message settles — are still
 * caught while the in-flight thinking is observable. R7 ghost-db-mysql-
 * rotation is the canonical case the prior message_end-only hook missed
 * (T-Mechanism-Bundle PRIMARY-6 PARTIAL gap closure). The two hooks share
 * the same dedupe set so a loop caught mid-stream does not double-fire when
 * message_end later settles. See T-Monitors-Bundle PRIMARY-4 for rationale.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

export const THINKING_LOOP_MONITOR_NAME = "thinking-loop";

const PARAGRAPH_MIN_CHARS = 500; // paragraphs smaller than this don't count as loop-of-substance
const REPEAT_THRESHOLD = 3; // 3+ copies of the same paragraph trigger FLAG
const PARAGRAPH_SPLIT_RE = /\n\s*\n+/; // split on blank-line boundaries

export interface ThinkingLoopMetrics {
	thinkingChars: number;
	paragraphCount: number;
	largestRepeatCount: number;
	largestRepeatHash: string | null;
	largestRepeatSample: string; // first 120 chars of the repeated paragraph
	userMessageId: string | null;
	messageId: string | null;
}

export interface ThinkingLoopAuditEntry {
	timestamp: string;
	metrics: ThinkingLoopMetrics;
	fired: boolean;
	mode: "observe" | "steer"; // forward-compatible; current default observe
	steered: boolean;
	reason?: string;
}

/**
 * Fast non-crypto hash for paragraph-fingerprinting. We only need stable
 * equality for in-process deduping; collisions across distinct paragraphs
 * are essentially impossible for paragraphs of this length, and we ship
 * the first 120 chars verbatim in the audit so any collision would be
 * obvious in review.
 */
function hashParagraph(s: string): string {
	// FNV-1a 32-bit — small, fast, no deps.
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * Find the user-message id that owns the current turn — the most recent
 * user message walking backward from the tail of the branch.
 */
function findCurrentUserMessageId(branch: SessionEntry[]): string | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; id?: string; message?: { role?: string } };
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") return entry.id ?? null;
	}
	return null;
}

/**
 * Analyze a single message-end event for the thinking-loop pathology.
 *
 * Walks the message's content blocks, concatenates all `thinking` content,
 * splits on blank-line boundaries, counts duplicates of paragraphs that
 * exceed PARAGRAPH_MIN_CHARS, and returns the largest duplicate group.
 *
 * Returning the largest group (not a list) keeps the audit small and
 * matches the decision shape: shouldFire only cares whether the worst-case
 * paragraph repeated REPEAT_THRESHOLD times.
 */
export function analyzeMessage(
	message: { id?: string; content?: unknown },
	branch: SessionEntry[],
): ThinkingLoopMetrics {
	let thinkingChars = 0;
	const thinkingParts: string[] = [];
	const content = message?.content;
	if (Array.isArray(content)) {
		for (const part of content as Array<Record<string, unknown>>) {
			if (part?.type === "thinking") {
				const t = part.thinking;
				if (typeof t === "string") {
					thinkingChars += t.length;
					thinkingParts.push(t);
				}
			}
		}
	}

	const joined = thinkingParts.join("\n\n");
	const paragraphs = joined.split(PARAGRAPH_SPLIT_RE).map((p) => p.trim()).filter((p) => p.length > 0);

	const countByHash = new Map<string, { count: number; sample: string }>();
	for (const p of paragraphs) {
		if (p.length < PARAGRAPH_MIN_CHARS) continue;
		const h = hashParagraph(p);
		const existing = countByHash.get(h);
		if (existing) {
			existing.count++;
		} else {
			countByHash.set(h, { count: 1, sample: p.slice(0, 120) });
		}
	}

	let largestCount = 0;
	let largestHash: string | null = null;
	let largestSample = "";
	for (const [h, v] of countByHash) {
		if (v.count > largestCount) {
			largestCount = v.count;
			largestHash = h;
			largestSample = v.sample;
		}
	}

	return {
		thinkingChars,
		paragraphCount: paragraphs.length,
		largestRepeatCount: largestCount,
		largestRepeatHash: largestHash,
		largestRepeatSample: largestSample,
		userMessageId: findCurrentUserMessageId(branch),
		messageId: message?.id ?? null,
	};
}

/**
 * Decision rule. Fires when the largest paragraph-duplicate-group in the
 * thinking block has >= REPEAT_THRESHOLD copies of a paragraph that itself
 * exceeds PARAGRAPH_MIN_CHARS (already filtered at analyze time).
 *
 * Single conjunction — no other criteria. Thinking loops are structurally
 * unambiguous: a long paragraph appearing 3+ times in one message's
 * thinking content is the pathology.
 */
export function shouldFire(m: ThinkingLoopMetrics): { fire: boolean; reason: string } {
	if (m.largestRepeatCount < REPEAT_THRESHOLD) {
		return {
			fire: false,
			reason: `largestRepeatCount ${m.largestRepeatCount} < ${REPEAT_THRESHOLD}`,
		};
	}
	if (m.largestRepeatHash === null) {
		return { fire: false, reason: "no qualifying paragraph (none >= min chars)" };
	}
	return {
		fire: true,
		reason: `paragraph repeated ${m.largestRepeatCount}× (threshold ${REPEAT_THRESHOLD}, ≥${PARAGRAPH_MIN_CHARS} chars)`,
	};
}

/**
 * Install the monitor. Idempotent for a single extension-load: registers
 * exactly one message_end listener. Loop limit dedupes by
 * (userMessageId, paragraphHash) so a single loop spanning multiple
 * message_end events fires once per (turn, loop) pair.
 *
 * Returns the audit log (in-memory) for tests/replay tooling. Production
 * callers can ignore the return.
 *
 * NOTE: observe-mode default. To enable steer mode in the future, set
 * opts.steer = true at install time (after 2+ accurate wild fires accumulate
 * with no FPs — separate promotion track).
 */
export function installThinkingLoopMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean; steer?: boolean } = {},
): { audit: ThinkingLoopAuditEntry[] } {
	const audit: ThinkingLoopAuditEntry[] = [];
	const firedKeys = new Set<string>(); // `${userMessageId}|${paragraphHash}` — shared across hooks
	const isEnabled = opts.isEnabled ?? (() => true);
	const mode: "observe" | "steer" = opts.steer ? "steer" : "observe";

	if (process.env.PI_THINKING_LOOP_MONITOR !== "off") {
		console.error(
			`[thinking-loop] heuristic monitor installed (message_end + message_update[thinking_end] hooks, mode=${mode})`,
		);
	} else {
		console.error("[thinking-loop] heuristic monitor DISABLED via PI_THINKING_LOOP_MONITOR=off");
	}

	/**
	 * Shared decision + emit path. Used by both message_end and
	 * message_update[thinking_end] hooks. Dedupe key (userMessageId, paragraphHash)
	 * is shared across both hooks so a loop caught mid-stream does not
	 * double-fire when message_end later settles.
	 *
	 * `via` annotates the audit entry with which hook caught the loop;
	 * useful for cross-iter analysis of mid-stream vs end-of-message catches.
	 */
	function emit(
		msg: { id?: string; role?: string; content?: unknown },
		branch: unknown[],
		via: "message_end" | "message_update",
	): void {
		const metrics = analyzeMessage(msg as { id?: string; content?: unknown }, branch as never[]);
		const decision = shouldFire(metrics);
		if (!decision.fire) return; // Keep audit tight — only log fires + loop-limit suppressions.

		const dedupeKey = `${metrics.userMessageId ?? "?"}|${metrics.largestRepeatHash}`;
		const entry: ThinkingLoopAuditEntry = {
			timestamp: new Date().toISOString(),
			metrics,
			fired: true,
			mode,
			steered: false,
			reason: `${decision.reason} [via ${via}]`,
		};
		if (firedKeys.has(dedupeKey)) {
			entry.reason = `loop-limit: already fired for (userMessage=${metrics.userMessageId}, paragraphHash=${metrics.largestRepeatHash}) [via ${via}]`;
			audit.push(entry);
			pi.appendEntry(THINKING_LOOP_MONITOR_NAME, entry);
			return;
		}
		firedKeys.add(dedupeKey);
		audit.push(entry);
		pi.appendEntry(THINKING_LOOP_MONITOR_NAME, entry);

		// Observe-mode: stop here. No steer dispatch. Promotion path:
		//   1. accumulate >=2 accurate wild fires + >=1 stable-period without
		//      FPs on the corpus
		//   2. spec a follow-up track that flips opts.steer = true + decides
		//      the steer payload (likely "wrap up the current reasoning — you
		//      appear to be looping on the same paragraph")
	}

	pi.on("message_end", async (ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_THINKING_LOOP_MONITOR === "off") return;
		if (!isEnabled()) return;

		const event = ev as { message?: { id?: string; role?: string; content?: unknown } };
		const msg = event?.message;
		if (!msg || msg.role !== "assistant") return;

		const branch = ctx.sessionManager.getBranch();
		emit(msg, branch, "message_end");
	});

	// message_update fires per token delta — many hundreds per turn. Guard
	// early so the common case (text_delta / thinking_delta / toolcall_*) is
	// effectively a no-op. We only analyze when a thinking block has just
	// ENDED, because at that point the thinking content is stable in
	// `partial.content` and a single fingerprint pass is correct.
	pi.on("message_update", async (ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_THINKING_LOOP_MONITOR === "off") return;
		if (!isEnabled()) return;

		const event = ev as {
			assistantMessageEvent?: { type?: string; partial?: { id?: string; role?: string; content?: unknown } };
		};
		const inner = event?.assistantMessageEvent;
		if (!inner || inner.type !== "thinking_end") return;
		const partial = inner.partial;
		if (!partial || partial.role !== "assistant") return;

		const branch = ctx.sessionManager.getBranch();
		emit(partial, branch, "message_update");
	});

	return { audit };
}
