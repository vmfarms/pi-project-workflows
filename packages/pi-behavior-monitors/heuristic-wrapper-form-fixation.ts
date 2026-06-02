/**
 * Heuristic wrapper-form-fixation detector.
 *
 * Sibling to heuristic-wrapper-bypass (which targets the DIFFERENT shape
 * "agent uses raw `sudo docker SUBCMD` through ssh_exec when a shipped
 * wrapper exists"). This monitor targets the inverse shape:
 *
 *   agent STRINGIFIES a structured-arg tool invocation INTO the bash tool's
 *   `command` argument — instead of invoking that tool natively.
 *
 * Concrete observed shapes:
 *   bash command='ssh_exec_docker host="braveshores-01" command="docker network ls | grep mealie"'
 *   bash command='ssh_exec host=braveshores-01 command="docker stack ls -a"'
 *   bash command='docker_service_logs host="X" service="Y"'
 *
 * Why this matters: the wrapper tool encodes the standard provenance
 * contract (host + structured params + parsed output + error-recovery
 * hints) and pi's tool-call channel gives the model a parameterized
 * invocation interface. Stringifying it into bash throws BOTH away:
 *  - The wrapper's structured output is reduced to whatever bash echoes.
 *  - The wrapper's parameter validation is bypassed (the agent often
 *    quotes parameters incorrectly, producing silent failures).
 *  - The model loses the bash-vs-native split that the same-model
 *    discipline relies on for cleaner tool-result attribution.
 *
 * Detection is heuristic (regex on the bash `command` argument)
 * per the same-model constraint — no LLM dispatch.
 *
 * Hook choice: `message_end` (matches wrapper-bypass / announce-without-act).
 * Rationale:
 *   - tool_use content blocks are stable at message_end (no partial-JSON
 *     parsing). message_update only adds latency without enabling
 *     intervention because the hook's return is void.
 *   - The existing sibling-pattern detectors (wrapper-bypass, announce-
 *     without-act, thinking-loop) all hook at message_end / agent_end —
 *     this monitor mirrors that contract for consistency.
 *
 * Ships in STEER-MODE by default (per iter-name "Promote"; n=2 recurrence
 * threshold met per `feedback_extension_monitor_promotion_threshold_2plus`
 * + Memory-Phase5 S11 + Wrapper-Remeasure S11 evidence pair 2026-06-02).
 * Includes the ready-to-emit steer text in the audit entry so a future
 * observe-mode rollback is a one-line flip.
 *
 * Loop limit: dedupe by `toolCallId` so re-emitted message_end events
 * (e.g., from session replay) don't repeat-fire.
 *
 * Toggle: respects the package-level `monitorsEnabled` flag. Additionally
 * honors `PI_WRAPPER_FORM_FIXATION_MONITOR=off` as a hard-disable env
 * override for debugging / replay harness use, and `PI_WRAPPER_FORM_
 * FIXATION_STEER=off` to keep the audit but suppress the steer dispatch
 * (fail-soft toggle mirroring wrapper-bypass + announce-without-act).
 *
 * Source of truth for known tool names that warrant native invocation:
 *   `vmfarms/hindsight-vmf` repo `tools/tool_candidates/shipped_tools.json`
 *   (synced 2026-06-02). Vendored inline below; bump alongside that JSON.
 *   ALSO includes the pi-coding-agent built-in `ssh_exec` (which is NOT
 *   a pi-vmfarms-tools wrapper but is the canonical structured-arg base
 *   tool agents stringify into bash — surfaced empirically on
 *   Memory-Phase5 S11 2026-06-02 as part of the n=2 pair).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const WRAPPER_FORM_FIXATION_MONITOR_NAME = "wrapper-form-fixation";

/**
 * Vendored set of tool names that warrant native invocation. When the agent
 * stringifies any of these as the FIRST TOKEN of a bash command followed by
 * `param=value` syntax, that's the wrapper-form-fixation anti-pattern.
 *
 * Includes:
 *   - All 14 shipped pi-vmfarms-tools wrappers (per shipped_tools.json
 *     2026-06-02): docker_logs, docker_inspect, docker_service_inspect,
 *     swarm_service_status, docker_volume_inspect, docker_service_resources,
 *     ssh_exec_docker, docker_ps, docker_exec, docker_service_diagnose,
 *     lsattr, docker_service_ps, docker_service_logs, docker_node_labels
 *   - pi-coding-agent's built-in `ssh_exec` (structured-arg base tool;
 *     Memory-Phase5 S11 2026-06-02 fires here).
 *
 * Bump alongside `hindsight-vmf/tools/tool_candidates/shipped_tools.json`
 * when new wrappers ship.
 */
export const KNOWN_WRAPPER_TOOL_NAMES: ReadonlySet<string> = new Set([
	// pi-coding-agent built-in (structured-arg base tool)
	"ssh_exec",
	// pi-vmfarms-tools shipped wrappers (synced 2026-06-02 from shipped_tools.json)
	"docker_logs",
	"docker_inspect",
	"docker_service_inspect",
	"swarm_service_status",
	"docker_volume_inspect",
	"docker_service_resources",
	"ssh_exec_docker",
	"docker_ps",
	"docker_exec",
	"docker_service_diagnose",
	"lsattr",
	"docker_service_ps",
	"docker_service_logs",
	"docker_node_labels",
]);

/**
 * Detection regex: first token (snake_case lowercase identifier) followed
 * by at least one whitespace, then a snake_case-or-camelCase identifier
 * followed by `=`. Anchored to the START of the bash command argument so
 * legitimate composite shells like `echo foo && ssh_exec ...` don't match
 * (the wrapper-form-fixation shape is invariably the ENTIRE command, not
 * a sub-pipe).
 *
 * Capture group is the first-token candidate; callers verify membership
 * in KNOWN_WRAPPER_TOOL_NAMES to suppress FPs like `python script.py arg=1`.
 */
export const FORM_FIXATION_RE = /^([a-z_][a-z_0-9]*)\s+[a-zA-Z_][a-zA-Z_0-9]*=/;

export interface FormFixationMatch {
	readonly tool: string; // The first-token wrapper tool name (e.g., "ssh_exec_docker")
	readonly matchedText: string; // The matched prefix (for diagnostics)
	readonly toolCallId: string | null;
	readonly fullCommand: string;
}

export interface FormFixationMetrics {
	matches: FormFixationMatch[]; // one entry per form-fixation bash call in this message
	bashCount: number; // total bash tool_use blocks in this message
	userMessageId: string | null;
	messageId: string | null;
}

export interface FormFixationAuditEntry {
	timestamp: string;
	fired: boolean;
	mode: "observe" | "steer";
	steered: boolean;
	metrics: FormFixationMetrics;
	steerSuggestions: string[];
	reason?: string;
}

/**
 * Run the form-fixation regex against a raw bash command. Returns the
 * matched tool name + matched-prefix substring, or null if no match or
 * the first token isn't in the known set.
 */
export function detectFormFixation(command: string): { tool: string; matchedText: string } | null {
	const m = FORM_FIXATION_RE.exec(command);
	if (!m) return null;
	const tool = m[1];
	if (!KNOWN_WRAPPER_TOOL_NAMES.has(tool)) return null;
	return { tool, matchedText: m[0] };
}

/**
 * Find the user-message id that owns the current turn — most recent user
 * message walking backward from the tail of the branch. Mirrors the
 * pattern in heuristic-wrapper-bypass / heuristic-thinking-loop.
 */
function findCurrentUserMessageId(branch: unknown[]): string | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; id?: string; message?: { role?: string } } | undefined;
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") return entry.id ?? null;
	}
	return null;
}

/**
 * Render the steer text for one form-fixation match. Pure function so
 * tests can assert on the exact wording.
 */
export function renderSteerText(match: FormFixationMatch): string {
	return `Don't wrap the ${match.tool} tool inside bash — invoke ${match.tool} directly with its native parameters. The wrapper provides structured output and error-recovery you lose when stringifying.`;
}

/**
 * Extract the `command` argument from a toolCall content block. Handles
 * both runtime shape (`input.command`) AND persisted-JSONL shape
 * (`arguments.command`) so the same analyzer drives both live message_end
 * dispatch AND replay validation against captured sessions.
 */
function extractBashCommand(part: Record<string, unknown>): string {
	const input = part?.input as Record<string, unknown> | undefined;
	if (typeof input?.command === "string") return input.command;
	const args = part?.arguments as Record<string, unknown> | undefined;
	if (typeof args?.command === "string") return args.command;
	return "";
}

/**
 * Analyze one assistant message at message_end time. Walks the message's
 * content blocks for tool_use / toolCall entries with `name === "bash"`,
 * extracts the `command` argument, and runs detectFormFixation on each.
 *
 * Returns metrics including:
 *  - matches: one per form-fixation bash call (may be 0)
 *  - bashCount: total bash calls (denominator for the fixation rate)
 *
 * Non-bash tool calls are ignored entirely — this monitor scopes only to
 * the bash-as-stringifier failure shape. Wrapper-bypass handles the
 * complementary ssh_exec-shell-bypass shape.
 */
export function analyzeMessage(
	message: { id?: string; content?: unknown },
	branch: unknown[],
): FormFixationMetrics {
	const matches: FormFixationMatch[] = [];
	let bashCount = 0;
	const content = message?.content;
	if (Array.isArray(content)) {
		for (const part of content as Array<Record<string, unknown>>) {
			const ptype = part?.type;
			if (ptype !== "toolCall" && ptype !== "tool_use") continue;
			const name = part?.name;
			if (name !== "bash") continue;
			bashCount++;
			const cmd = extractBashCommand(part);
			if (!cmd) continue;
			const det = detectFormFixation(cmd);
			if (det) {
				const toolCallId =
					typeof part?.id === "string"
						? (part.id as string)
						: typeof part?.toolCallId === "string"
							? (part.toolCallId as string)
							: null;
				matches.push({
					tool: det.tool,
					matchedText: det.matchedText,
					toolCallId,
					fullCommand: cmd,
				});
			}
		}
	}
	return {
		matches,
		bashCount,
		userMessageId: findCurrentUserMessageId(branch),
		messageId: message?.id ?? null,
	};
}

/** Decision rule: fire when at least one form-fixation match was found. */
export function shouldFire(m: FormFixationMetrics): { fire: boolean; reason: string } {
	if (m.matches.length === 0) {
		return { fire: false, reason: "no form-fixation detected" };
	}
	return {
		fire: true,
		reason: `${m.matches.length} form-fixation match(es) of ${m.bashCount} bash call(s)`,
	};
}

/**
 * Install the monitor. Idempotent for a single extension-load: registers
 * exactly one message_end listener. Loop limit dedupes by toolCallId so a
 * given bash call fires once per session even if message_end re-emits.
 *
 * Returns the audit log (in-memory) for tests/replay tooling. Production
 * callers can ignore the return.
 *
 * Steer-mode default per iter-name "Promote" + n=2 recurrence per
 * `feedback_extension_monitor_promotion_threshold_2plus`. To fall back to
 * observe-mode (e.g., if a future FP surfaces in the wild), set
 * opts.steer = false at install time OR set PI_WRAPPER_FORM_FIXATION_
 * STEER=off as a fail-soft env override.
 */
export function installWrapperFormFixationMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean; steer?: boolean } = {},
): { audit: FormFixationAuditEntry[] } {
	const audit: FormFixationAuditEntry[] = [];
	const firedToolCallIds = new Set<string>();
	const isEnabled = opts.isEnabled ?? (() => true);
	// Default to STEER mode (n=2 promotion).
	const mode: "observe" | "steer" = opts.steer === false ? "observe" : "steer";

	if (process.env.PI_WRAPPER_FORM_FIXATION_MONITOR !== "off") {
		const steerSuffix =
			mode === "steer" && process.env.PI_WRAPPER_FORM_FIXATION_STEER === "off"
				? " (steer dispatch DISABLED via PI_WRAPPER_FORM_FIXATION_STEER=off; observe-mode audit still active)"
				: "";
		console.error(`[wrapper-form-fixation] heuristic monitor installed (message_end hook, mode=${mode})${steerSuffix}`);
	} else {
		console.error("[wrapper-form-fixation] heuristic monitor DISABLED via PI_WRAPPER_FORM_FIXATION_MONITOR=off");
	}

	pi.on("message_end", async (ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_WRAPPER_FORM_FIXATION_MONITOR === "off") return;
		if (!isEnabled()) return;

		const event = ev as { message?: { id?: string; role?: string; content?: unknown } };
		const msg = event?.message;
		if (!msg || msg.role !== "assistant") return;

		const branch = ctx.sessionManager.getBranch();
		const metrics = analyzeMessage(msg, branch);
		const decision = shouldFire(metrics);

		if (!decision.fire) {
			// Keep audit tight — only log fires (sibling-pattern convention).
			return;
		}

		// Loop-limit: skip matches whose toolCallId we've already fired on this
		// session. If all matches are duplicates, suppress the entry entirely.
		const newMatches = metrics.matches.filter((m) => {
			if (m.toolCallId === null) return true;
			if (firedToolCallIds.has(m.toolCallId)) return false;
			firedToolCallIds.add(m.toolCallId);
			return true;
		});
		if (newMatches.length === 0) {
			return;
		}

		const dedupedMetrics: FormFixationMetrics = { ...metrics, matches: newMatches };
		const steerSuggestions = newMatches.map(renderSteerText);

		const steerActive = mode === "steer" && process.env.PI_WRAPPER_FORM_FIXATION_STEER !== "off";

		const entry: FormFixationAuditEntry = {
			timestamp: new Date().toISOString(),
			fired: true,
			mode,
			steered: steerActive,
			metrics: dedupedMetrics,
			steerSuggestions,
			reason: decision.reason,
		};
		audit.push(entry);
		pi.appendEntry(WRAPPER_FORM_FIXATION_MONITOR_NAME, entry);

		if (steerActive) {
			// Deferred dispatch — see heuristic-wrapper-bypass.ts §steer-mode for
			// the setTimeout(0) rationale: during message_end the Agent is still
			// inside runWithLifecycle (isStreaming = true); a direct sendMessage
			// gets queued into steeringQueue with no consumer in scripted RPC
			// mode. setTimeout(0) defers past finishRun() so the prompt() branch
			// fires and a fresh agent_start/agent_end cycle runs.
			//
			// Multi-match messages join with newline so the LLM sees all bypass
			// instances pointed out in one steer. One steer per turn keeps the
			// agent from being flooded with multiple parallel re-trigger turns.
			const steerText = steerSuggestions.join("\n");
			setTimeout(() => {
				pi.sendMessage(
					{
						customType: "wrapper-form-fixation-recovery",
						content: steerText,
						display: true,
					},
					{ deliverAs: "steer", triggerTurn: true },
				);
			}, 0);
		}
	});

	return { audit };
}
