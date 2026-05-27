/**
 * Heuristic null-output detector + steer monitor.
 *
 * Stop-gap for the qwen3-thinking-mode + vLLM "null-output" failure mode
 * characterized in hindsight-vmf T-NullOutput-Investigation (2026-05-27):
 *   The model engages structured thinking, plans a tool call, closes its first
 *   </think>, then emits either pure whitespace, an empty `<think></think>`
 *   artifact, or a bare opening code fence — and stops without producing a
 *   tool call or any substantive content. Historical rate measured at 0.081%
 *   (4 / 4923 qwen turns).
 *
 * Detection is heuristic (no LLM classifier) per the same-model constraint
 * and to keep per-turn overhead negligible. The detector runs at `agent_end`
 * after the assistant turn has settled; if the failure signature is present,
 * it injects a custom-role steer message and triggers a fresh agent turn so
 * the model gets one chance to emit its planned action.
 *
 * Loop limit: 1 re-prod per turn. A turn is keyed by the id of the
 * user-message entry that initiated it; if we've already steered for that
 * user-message id, the detector returns without re-firing — preventing an
 * infinite loop if the re-prod also empty-outputs.
 *
 * Toggle: respects the package-level `monitorsEnabled` flag (driven by
 * `/monitors on|off`). Additionally honors `PI_NULL_OUTPUT_MONITOR=off` as a
 * hard-disable env override for debugging / replay harness use.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

export const NULL_OUTPUT_MONITOR_NAME = "null-output";

const THINKING_MIN_CHARS = 200;

const NULL_SHAPE_PATTERNS: readonly RegExp[] = [
	/^\s*$/, // pure whitespace
	/^\s*<think>\s*<\/think>\s*$/, // empty <think></think> artifact
	/^\s*`{1,}\s*$/, // bare opening code fence (1+ backticks, nothing else)
];

export interface NullOutputMetrics {
	thinkingChars: number;
	visibleChars: number; // raw, no stripping
	toolCallCount: number;
	stopReason: string | null;
	visibleSample: string; // first 80 chars of joined visible text
	matchedNullShape: boolean;
	userMessageId: string | null;
}

export interface NullOutputAuditEntry {
	timestamp: string;
	metrics: NullOutputMetrics;
	fired: boolean;
	steered: boolean;
	reason?: string; // populated when fired=false to explain why
}

const STEER_TEXT =
	"Your previous response had no visible answer or tool call. " +
	"Please emit your planned action now.";

/**
 * Walk the branch backward from the tail to the most recent user message,
 * aggregating thinking/text/toolCall stats across every assistant message in
 * the current turn. Multi-message turns (e.g., assistant message → toolCall →
 * toolResult → trailing assistant text) are accumulated together.
 */
export function analyzeTurn(branch: SessionEntry[]): NullOutputMetrics {
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
	const matchedNullShape = NULL_SHAPE_PATTERNS.some((p) => p.test(visible));

	return {
		thinkingChars,
		visibleChars,
		toolCallCount,
		stopReason,
		visibleSample: visible.slice(0, 80),
		matchedNullShape,
		userMessageId,
	};
}

/**
 * Decision rule. All criteria must hold:
 *   - thinking content ≥ 200 chars (model engaged reasoning)
 *   - zero tool calls in this turn (failure mode, not normal tool use)
 *   - stopReason == "stop" (clean EOS — not aborted, not toolUse, not error)
 *   - visible text matches one of the known null-shape patterns
 *
 * shouldFire == false when ANY criterion fails. Reason string returned for
 * the negative case is intentionally lossy — the audit entry captures the
 * raw metrics if a follow-up wants more detail.
 */
export function shouldFire(m: NullOutputMetrics): { fire: boolean; reason: string } {
	if (m.thinkingChars < THINKING_MIN_CHARS) {
		return { fire: false, reason: `thinkingChars ${m.thinkingChars} < ${THINKING_MIN_CHARS}` };
	}
	if (m.toolCallCount > 0) {
		return { fire: false, reason: `toolCallCount ${m.toolCallCount} > 0` };
	}
	if (m.stopReason !== "stop") {
		return { fire: false, reason: `stopReason ${m.stopReason} != stop` };
	}
	if (!m.matchedNullShape) {
		return { fire: false, reason: "visible text did not match any null-shape pattern" };
	}
	return { fire: true, reason: "all criteria matched" };
}

/**
 * Install the monitor on the given pi extension API. Idempotent in the sense
 * that calling once per extension load registers exactly one agent_end
 * listener. Loop limit + dedupe are tracked in closures captured at install
 * time, scoped to a single session.
 *
 * Returns the audit log (in-memory) for tests/replay tooling that wants to
 * inspect what the detector saw. Production callers can ignore the return.
 */
export function installNullOutputMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean } = {},
): { audit: NullOutputAuditEntry[] } {
	const audit: NullOutputAuditEntry[] = [];
	const steeredUserMessageIds = new Set<string>();
	const isEnabled = opts.isEnabled ?? (() => true);

	// Surface "armed" status to stderr so live-dry-run verification can grep
	// for evidence of installation. Quiet enough to not spam normal usage.
	if (process.env.PI_NULL_OUTPUT_MONITOR !== "off") {
		console.error("[null-output] heuristic monitor installed (agent_end hook)");
	} else {
		console.error("[null-output] heuristic monitor DISABLED via PI_NULL_OUTPUT_MONITOR=off");
	}

	pi.on("agent_end", async (_ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_NULL_OUTPUT_MONITOR === "off") return;
		if (!isEnabled()) return;

		const branch = ctx.sessionManager.getBranch();
		const metrics = analyzeTurn(branch);
		const decision = shouldFire(metrics);

		const entry: NullOutputAuditEntry = {
			timestamp: new Date().toISOString(),
			metrics,
			fired: decision.fire,
			steered: false,
			reason: decision.reason,
		};

		if (!decision.fire) {
			// Don't log every clean turn — keep audit tight.
			return;
		}

		if (metrics.userMessageId && steeredUserMessageIds.has(metrics.userMessageId)) {
			entry.reason = "loop-limit: already steered for this user message";
			audit.push(entry);
			pi.appendEntry(NULL_OUTPUT_MONITOR_NAME, entry);
			return;
		}
		if (metrics.userMessageId) steeredUserMessageIds.add(metrics.userMessageId);

		entry.steered = true;
		audit.push(entry);
		pi.appendEntry(NULL_OUTPUT_MONITOR_NAME, entry);

		// Deferred dispatch — see iter-18 wiring-gap fix in index.ts:1788-1808.
		// During agent_end the Agent is still inside runWithLifecycle
		// (isStreaming = true); a direct sendMessage({deliverAs:"steer",
		// triggerTurn:true}) gets queued into steeringQueue with no consumer
		// in scripted RPC mode. setTimeout(0) defers past finishRun() so the
		// prompt() branch fires and a fresh agent_start/agent_end cycle runs.
		setTimeout(() => {
			pi.sendMessage(
				{
					customType: "null-output-recovery",
					content: STEER_TEXT,
					display: true,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		}, 0);
	});

	return { audit };
}
