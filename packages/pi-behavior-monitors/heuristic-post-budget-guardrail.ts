/**
 * Heuristic post-budget guardrail (observe-mode).
 *
 * T-Monitor-PromptFix-PreEmptive-Bundle PRIMARY-2 (2026-05-31). Operator-
 * authorized as "additive monitor, not budget change."
 *
 * Targets the pre-emptive guardrail shape:
 *   When the agent has used >=90% of its tool-call budget within an RPC turn,
 *   log an audit entry with pre-rendered steer text suggesting the agent
 *   summarize what it has and emit a final answer rather than continuing
 *   investigative calls. The intent is to head off the post-budget thinking-
 *   loop pathology (the sibling heuristic-thinking-loop monitor detects the
 *   loop AFTER it begins; this monitor offers steer signal BEFORE the budget
 *   exhausts).
 *
 * Distinct from heuristic-thinking-loop's analyzePostBudgetLoop:
 *   - thinking-loop's post-budget detector fires when thinking text shows a
 *     paragraph-cycling pattern AFTER budget exhaustion.
 *   - this monitor fires PRE-EXHAUSTION at 0.9 ratio. Adjacent signals; not
 *     competing.
 *
 * OBSERVE-MODE ONLY at ship: records an audit entry with pre-rendered steer
 * text in `steerSuggestions[]` so a future steer-mode promotion is a one-line
 * flip (set `opts.steer = true`). Per operator authorization, steer-mode is
 * a separate iter with explicit sign-off — observe-mode here is the
 * authorized scope.
 *
 * Hook choice: `tool_result` (fires after each tool call settles) for counter
 * increment + `before_agent_start` for per-RPC-turn counter reset + budget
 * re-parse. The two-hook layout matches the per-RPC-turn semantics the
 * handoff pitfall calls out: S1's 20-tool-call loop happened within ONE pi
 * --mode rpc dispatch, so the counter must reset between RPC turns, not
 * accumulate across the session.
 *
 * Budget source: parsed from `BeforeAgentStartEvent.systemPrompt` using a
 * regex that tolerates the standard tool-call-budget phrasing pi-coding-agent
 * uses ("tool_call_budget", "Tool-call budget", "tool call budget"). On
 * parse failure, falls back to constant `DEFAULT_TOOL_CALL_BUDGET = 20` —
 * the current observed value across all 2026-05-* pi sessions (per
 * T-Monitor-PromptFix-PreEmptive-Bundle handoff §"State at handoff").
 *
 * Dedupe: per (sessionId, userMessageId) tuple — fires MAX ONCE per RPC turn.
 * The dedupe key uses userMessageId because BeforeAgentStartEvent fires once
 * per turn at the start; after we increment past the threshold, subsequent
 * tool_results in the same turn don't re-fire. The next turn (new
 * before_agent_start) resets the firedTurnKeys entry.
 *
 * Toggle: respects the package-level `monitorsEnabled` flag. Additionally
 * honors `PI_POST_BUDGET_GUARDRAIL_MONITOR=off` as a hard-disable env
 * override for debugging / replay harness use.
 *
 * Steer text is pre-computed at audit time and stashed in
 * `steerSuggestions[]`. Format:
 *   "You're at <count>/<budget> tool calls. Summarize what you've found ..."
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const POST_BUDGET_GUARDRAIL_MONITOR_NAME = "post-budget-guardrail";

/** Default tool-call budget when systemPrompt parsing fails. Current observed value 2026-05. */
export const DEFAULT_TOOL_CALL_BUDGET = 20;

/** Fire when used/budget >= this ratio. 0.9 = 18/20 typical fire point. */
export const BUDGET_RATIO_THRESHOLD = 0.9;

/**
 * Parse tool-call budget from the assembled system prompt.
 *
 * Tolerates the variants pi-coding-agent emits across versions:
 *   - "tool_call_budget: 20"
 *   - "tool_call_budget=20"
 *   - "Tool-call budget: 20"
 *   - "tool call budget of 20"
 *   - "budget of 20 tool calls" (reverse phrasing)
 *
 * Returns the first numeric match >= 1. Returns null if no match — caller
 * falls back to DEFAULT_TOOL_CALL_BUDGET. Bounded to 1-200 to reject
 * accidentally-matched large numbers (e.g., port numbers, container IDs).
 */
export function parseBudgetFromSystemPrompt(systemPrompt: string): number | null {
	if (!systemPrompt) return null;
	const patterns: RegExp[] = [
		/tool[_-]?call[_-]?budget\s*[:=]\s*(\d+)/i,
		/Tool[- ]call budget\s*[:=]?\s*(\d+)/i,
		/tool[ _-]?call[ _-]?budget(?:\s+of)?\s+(\d+)/i,
		/budget\s+of\s+(\d+)\s+tool[ _-]?calls?/i,
	];
	for (const re of patterns) {
		const m = re.exec(systemPrompt);
		if (m) {
			const n = parseInt(m[1], 10);
			if (Number.isFinite(n) && n >= 1 && n <= 200) return n;
		}
	}
	return null;
}

export interface PostBudgetGuardrailMetrics {
	currentToolCalls: number;
	toolCallBudget: number;
	ratio: number;
	sessionId: string;
	userMessageId: string | null;
}

export interface PostBudgetGuardrailAuditEntry {
	timestamp: string;
	fired: boolean;
	mode: "observe" | "steer";
	steered: boolean;
	metrics: PostBudgetGuardrailMetrics;
	steerSuggestions: string[];
	reason?: string;
}

/**
 * Render the steer text for one fire. Pure function so tests can assert
 * on exact wording. Pre-rendered into steerSuggestions[] at audit time;
 * dispatched verbatim if/when steer-mode is enabled.
 */
export function renderSteerText(metrics: PostBudgetGuardrailMetrics): string {
	return `You're at ${metrics.currentToolCalls}/${metrics.toolCallBudget} tool calls. Summarize what you've found from the calls you've made and emit your final answer based on current evidence. Avoid additional investigative calls.`;
}

/**
 * Decision rule: fire when ratio >= BUDGET_RATIO_THRESHOLD AND fire hasn't
 * happened for this turn yet.
 */
export function shouldFire(
	count: number,
	budget: number,
	turnKey: string,
	firedTurnKeys: Set<string>,
): { fire: boolean; reason: string } {
	if (budget <= 0) return { fire: false, reason: "budget non-positive" };
	const ratio = count / budget;
	if (ratio < BUDGET_RATIO_THRESHOLD) {
		return { fire: false, reason: `ratio ${ratio.toFixed(2)} below threshold ${BUDGET_RATIO_THRESHOLD}` };
	}
	if (firedTurnKeys.has(turnKey)) {
		return { fire: false, reason: "already fired this turn (dedupe)" };
	}
	return {
		fire: true,
		reason: `ratio ${ratio.toFixed(2)} >= ${BUDGET_RATIO_THRESHOLD}`,
	};
}

/**
 * Install the monitor. Idempotent for a single extension-load: registers
 * exactly one before_agent_start listener + one tool_result listener.
 *
 * Returns the audit log (in-memory) for tests/replay tooling. Production
 * callers can ignore the return.
 *
 * NOTE: observe-mode default per T-Monitor-PromptFix-PreEmptive-Bundle
 * authorized scope. Future steer-mode promotion would be a one-line flip
 * (set opts.steer = true at install time) plus steer-dispatch wiring
 * mirroring heuristic-wrapper-bypass's setTimeout(0)-deferred sendMessage
 * pattern (added 2026-05-31 in T-Monitor-ThinkingLoopShapes-Bundle).
 */
export function installPostBudgetGuardrailMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean; steer?: boolean } = {},
): { audit: PostBudgetGuardrailAuditEntry[] } {
	const audit: PostBudgetGuardrailAuditEntry[] = [];
	const isEnabled = opts.isEnabled ?? (() => true);
	const mode: "observe" | "steer" = opts.steer ? "steer" : "observe";

	// Per-turn state (reset on each before_agent_start)
	let currentBudget: number = DEFAULT_TOOL_CALL_BUDGET;
	let currentToolCalls = 0;
	let currentUserMessageId: string | null = null;
	let currentSessionId: string = "unknown";

	// Per-(session,turn) dedupe — fire MAX ONCE per RPC turn.
	const firedTurnKeys = new Set<string>();

	if (process.env.PI_POST_BUDGET_GUARDRAIL_MONITOR !== "off") {
		const steerSuffix =
			mode === "steer" && process.env.PI_POST_BUDGET_GUARDRAIL_STEER === "off"
				? " (steer dispatch DISABLED via PI_POST_BUDGET_GUARDRAIL_STEER=off; observe-mode audit still active)"
				: "";
		console.error(
			`[post-budget-guardrail] heuristic monitor installed (before_agent_start + tool_result hooks, mode=${mode}, threshold=${BUDGET_RATIO_THRESHOLD})${steerSuffix}`,
		);
	} else {
		console.error("[post-budget-guardrail] heuristic monitor DISABLED via PI_POST_BUDGET_GUARDRAIL_MONITOR=off");
	}

	pi.on("before_agent_start", async (ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_POST_BUDGET_GUARDRAIL_MONITOR === "off") return;
		if (!isEnabled()) return;

		const event = ev as { systemPrompt?: string };
		const sp = event?.systemPrompt ?? "";
		const parsed = parseBudgetFromSystemPrompt(sp);
		currentBudget = parsed ?? DEFAULT_TOOL_CALL_BUDGET;
		currentToolCalls = 0; // reset counter for the new RPC turn

		// Pull session + most-recent user message id from the branch for the
		// dedupe key. Branch walks newest-first via reverse iteration.
		currentSessionId = ctx.sessionManager.getSessionId() ?? "unknown";
		const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; id?: string; message?: { role?: string } }>;
		currentUserMessageId = null;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "message") continue;
			if (entry.message?.role === "user") {
				currentUserMessageId = entry.id ?? null;
				break;
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (_ev: unknown, _ctx: ExtensionContext) => {
		if (process.env.PI_POST_BUDGET_GUARDRAIL_MONITOR === "off") return;
		if (!isEnabled()) return;

		currentToolCalls++;

		const turnKey = `${currentSessionId}|${currentUserMessageId ?? "no-turn"}`;
		const decision = shouldFire(currentToolCalls, currentBudget, turnKey, firedTurnKeys);
		if (!decision.fire) return;

		firedTurnKeys.add(turnKey);

		const metrics: PostBudgetGuardrailMetrics = {
			currentToolCalls,
			toolCallBudget: currentBudget,
			ratio: currentToolCalls / currentBudget,
			sessionId: currentSessionId,
			userMessageId: currentUserMessageId,
		};
		const steerSuggestions = [renderSteerText(metrics)];
		const steerActive = mode === "steer" && process.env.PI_POST_BUDGET_GUARDRAIL_STEER !== "off";

		const entry: PostBudgetGuardrailAuditEntry = {
			timestamp: new Date().toISOString(),
			fired: true,
			mode,
			steered: steerActive,
			metrics,
			steerSuggestions,
			reason: decision.reason,
		};
		audit.push(entry);
		pi.appendEntry(POST_BUDGET_GUARDRAIL_MONITOR_NAME, entry);

		if (steerActive) {
			// Mirrors heuristic-wrapper-bypass's deferred-dispatch pattern.
			// During tool_result the Agent is still inside runWithLifecycle;
			// setTimeout(0) defers past finishRun() so the prompt() branch
			// fires and a fresh agent_start/agent_end cycle runs.
			const steerText = steerSuggestions[0];
			setTimeout(() => {
				pi.sendMessage(
					{
						customType: "post-budget-guardrail-recovery",
						content: steerText,
						display: true,
					},
					{ deliverAs: "steer", triggerTurn: true },
				);
			}, 0);
		}
		return undefined;
	});

	return { audit };
}
