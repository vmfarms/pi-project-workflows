/**
 * Heuristic wrapper-bypass detector.
 *
 * Sibling to heuristic-announce-without-act / heuristic-null-output /
 * heuristic-thinking-loop. Targets the "agent built a raw `ssh_exec` shell call
 * for a docker subcommand that already has a shipped wrapper tool" failure
 * shape. Surfaced at n=5 across 4 iters by the LLM-judged
 * T-Tool-Candidates-LLM-WorkerDirect-Run mining (2026-05-31): the agent
 * constructs `sudo docker logs <container>` (or `inspect`, `ps`, `volume
 * inspect`, `service inspect`, `service ls/ps`) through ssh_exec when the
 * shipped pi-vmfarms-tools provides `docker_logs(host, container, …)`
 * (resp. `docker_inspect`, `docker_ps`, `docker_volume_inspect`,
 * `docker_service_inspect`, `swarm_service_status`).
 *
 * Why this matters: the shipped wrapper tools encode the standard
 * provenance contract (host + container + parsed output + error-recovery
 * hints) — bypassing them throws that away, silently produces less-rich
 * tool output, and re-implements common ops boilerplate in raw shell each
 * turn. The wrappers also pre-validate inputs and surface known failure
 * modes; raw `ssh_exec` opens MORE silent-failure surface.
 *
 * Detection is heuristic (regex on the ssh_exec `command` argument)
 * per the same-model constraint — no LLM dispatch.
 *
 * Hook choice: `message_end` (not `message_update`). Rationale:
 *   - tool_use content blocks are stable at message_end (no partial-JSON
 *     parsing). message_update only adds latency without enabling
 *     intervention because the hook's return is void.
 *   - The existing announce-without-act + thinking-loop monitors hook at
 *     message_end / agent_end — this monitor mirrors that contract for
 *     consistency.
 *   - A future steer-mode promotion would use a `tool_call` hook (which
 *     CAN return `{block:true}` to suppress execution). For OBSERVE-MODE,
 *     message_end is sufficient and matches the existing pattern.
 *
 * Ships in OBSERVE-MODE: records an audit entry + emits `pi.appendEntry`
 * payload that includes the ready-to-emit steer text so a future steer
 * promotion is a one-line flip (set `opts.steer = true`).
 *
 * Loop limit: dedupe by `toolCallId` so re-emitted message_end events
 * (e.g., from session replay) don't repeat-fire.
 *
 * Toggle: respects the package-level `monitorsEnabled` flag. Additionally
 * honors `PI_WRAPPER_BYPASS_MONITOR=off` as a hard-disable env override
 * for debugging / replay harness use.
 *
 * Source of truth for shipped wrapper names:
 *   `vmfarms/hindsight-vmf` repo `tools/tool_candidates/shipped_tools.json`
 *   (synced 2026-05-31). Vendored inline below; bump alongside that JSON.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const WRAPPER_BYPASS_MONITOR_NAME = "wrapper-bypass";

/**
 * Vendored mapping from docker subcommand to shipped pi-vmfarms-tools wrapper.
 *
 * Multi-token patterns (`service inspect`, `service ls`, `volume inspect`)
 * MUST come before single-token patterns so the more-specific match wins.
 *
 * `docker exec` is INTENTIONALLY absent: no shipped wrapper exists for it
 * (would be T-Extension-DockerExec MEDIUM territory). When detected, the
 * monitor skips silently — it does NOT fire because there is no wrapper
 * to recommend. The audit entry separately records exec-detected counts
 * so the cross-iter aggregator can surface the wrapper-gap signal.
 *
 * Synced from `hindsight-vmf/tools/tool_candidates/shipped_tools.json`
 * (2026-05-31). When new wrappers ship, add the pattern here AND bump
 * `_last_synced_at` in that JSON.
 */
export interface WrapperPattern {
	readonly pattern: RegExp;
	readonly wrapper: string;
	readonly subcmd: string;
}

/**
 * The optional `sudo\s+` prefix matches both `sudo docker logs …` (the common
 * shape — pi-vmfarms-tools wrappers themselves go through sudo) AND `docker
 * logs …` (some agent variants drop sudo; the LLM-judged corpus from
 * T-Tool-Candidates-LLM-WorkerDirect-Run 2026-05-31 included the no-sudo
 * variant as a wrapper-bypass too). Detection is per-command not per-pipeline,
 * so composite shells like `sudo docker logs … 2>&1 | head -100` still hit
 * the first match.
 */
const SUDO_DOCKER_PREFIX = /(?:^|\W)(?:sudo\s+)?docker\s+/i;
function withDockerPrefix(re: RegExp): RegExp {
	// Re-encode each pattern with the optional-sudo prefix so the union of
	// authoring forms is captured. The literal subcmd tail comes from the
	// per-pattern source.
	return new RegExp(SUDO_DOCKER_PREFIX.source + re.source, "i");
}

export const DOCKER_WRAPPER_PATTERNS: readonly WrapperPattern[] = [
	// Multi-token patterns FIRST
	{ pattern: withDockerPrefix(/service\s+inspect\b/), wrapper: "docker_service_inspect", subcmd: "service inspect" },
	{ pattern: withDockerPrefix(/service\s+(?:ls|ps)\b/), wrapper: "swarm_service_status", subcmd: "service ls/ps" },
	{ pattern: withDockerPrefix(/volume\s+inspect\b/), wrapper: "docker_volume_inspect", subcmd: "volume inspect" },
	// Single-token patterns
	{ pattern: withDockerPrefix(/logs\b/), wrapper: "docker_logs", subcmd: "logs" },
	{ pattern: withDockerPrefix(/inspect\b/), wrapper: "docker_inspect", subcmd: "inspect" },
	{ pattern: withDockerPrefix(/ps\b/), wrapper: "docker_ps", subcmd: "ps" },
];

/** Detected separately; no shipped wrapper exists. Optional-sudo per the same rationale. */
export const DOCKER_EXEC_RE = withDockerPrefix(/exec\b/);

export interface WrapperBypassMatch {
	readonly wrapper: string;
	readonly subcmd: string;
	readonly matchedText: string;
	readonly toolCallId: string | null;
	readonly fullCommand: string;
}

export interface WrapperBypassMetrics {
	matches: WrapperBypassMatch[]; // one entry per bypassing ssh_exec in this message
	execDetectedCount: number; // ssh_exec calls matching docker exec (no-wrapper; not fired)
	sshExecCount: number; // total ssh_exec tool_use blocks in this message
	userMessageId: string | null;
	messageId: string | null;
}

export interface WrapperBypassAuditEntry {
	timestamp: string;
	fired: boolean;
	mode: "observe" | "steer"; // forward-compatible; current default observe
	steered: boolean;
	metrics: WrapperBypassMetrics;
	// Ready-to-emit steer text per match — populated even in observe-mode so a
	// future steer promotion is a one-line flip (set `opts.steer = true`).
	steerSuggestions: string[];
	reason?: string;
}

/**
 * Run the wrapper pattern set against a raw shell command. Returns the first
 * matching wrapper or null. `docker exec` returns null because no wrapper
 * exists; callers should track exec separately.
 *
 * Multi-token patterns are tried first (declaration order in
 * DOCKER_WRAPPER_PATTERNS) — `docker service inspect` matches the
 * `service inspect` rule, NOT the bare `inspect` rule.
 */
export function detectWrapperBypass(command: string): WrapperPattern & { matchedText: string } | null {
	if (DOCKER_EXEC_RE.test(command)) return null;
	for (const wp of DOCKER_WRAPPER_PATTERNS) {
		const m = wp.pattern.exec(command);
		if (m) return { ...wp, matchedText: m[0] };
	}
	return null;
}

/**
 * Find the user-message id that owns the current turn — most recent user
 * message walking backward from the tail of the branch. Mirrors the
 * pattern in heuristic-thinking-loop.
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
 * Render the steer text for one bypass match. Kept as a pure function so
 * tests can assert on the exact wording.
 */
export function renderSteerText(match: WrapperBypassMatch): string {
	return `The ${match.wrapper} tool covers '${match.subcmd}' — use it instead of raw 'sudo docker ${match.subcmd}' through ssh_exec.`;
}

/**
 * Analyze one assistant message at message_end time. Walks the message's
 * content blocks for tool_use / toolCall entries with `name === "ssh_exec"`,
 * extracts the `command` argument, and runs detectWrapperBypass on each.
 *
 * Returns metrics including:
 *  - matches: one per bypassing ssh_exec call (may be 0)
 *  - execDetectedCount: ssh_exec calls matching `docker exec` (skipped; no wrapper)
 *  - sshExecCount: total ssh_exec calls (denominator for the bypass rate)
 *
 * Non-ssh_exec tool calls are ignored entirely — this monitor scopes only to
 * the shell-bypass-of-shipped-wrapper failure shape.
 */
export function analyzeMessage(
	message: { id?: string; content?: unknown },
	branch: unknown[],
): WrapperBypassMetrics {
	const matches: WrapperBypassMatch[] = [];
	let execDetectedCount = 0;
	let sshExecCount = 0;
	const content = message?.content;
	if (Array.isArray(content)) {
		for (const part of content as Array<Record<string, unknown>>) {
			const ptype = part?.type;
			if (ptype !== "toolCall" && ptype !== "tool_use") continue;
			const name = part?.name;
			if (name !== "ssh_exec") continue;
			sshExecCount++;
			const input = part?.input as Record<string, unknown> | undefined;
			const cmd = typeof input?.command === "string" ? input.command : "";
			if (!cmd) continue;
			if (DOCKER_EXEC_RE.test(cmd)) {
				execDetectedCount++;
				continue;
			}
			const det = detectWrapperBypass(cmd);
			if (det) {
				const toolCallId =
					typeof part?.id === "string"
						? (part.id as string)
						: typeof part?.toolCallId === "string"
							? (part.toolCallId as string)
							: null;
				matches.push({
					wrapper: det.wrapper,
					subcmd: det.subcmd,
					matchedText: det.matchedText,
					toolCallId,
					fullCommand: cmd,
				});
			}
		}
	}
	return {
		matches,
		execDetectedCount,
		sshExecCount,
		userMessageId: findCurrentUserMessageId(branch),
		messageId: message?.id ?? null,
	};
}

/** Decision rule: fire when at least one bypass match was found. */
export function shouldFire(m: WrapperBypassMetrics): { fire: boolean; reason: string } {
	if (m.matches.length === 0) {
		const noteExec = m.execDetectedCount > 0 ? ` (${m.execDetectedCount} 'docker exec' call(s) skipped — no shipped wrapper)` : "";
		return { fire: false, reason: `no wrapper-bypass detected${noteExec}` };
	}
	return {
		fire: true,
		reason: `${m.matches.length} wrapper-bypass match(es) of ${m.sshExecCount} ssh_exec call(s)`,
	};
}

/**
 * Install the monitor. Idempotent for a single extension-load: registers
 * exactly one message_end listener. Loop limit dedupes by toolCallId so a
 * given ssh_exec call fires once per session even if message_end re-emits.
 *
 * Returns the audit log (in-memory) for tests/replay tooling. Production
 * callers can ignore the return.
 *
 * NOTE: observe-mode default. To enable steer mode in the future, set
 * opts.steer = true at install time (after 2+ accurate wild fires accumulate
 * with no FPs — separate promotion track). Steer dispatch wiring will mirror
 * heuristic-null-output's setTimeout(0)-deferred sendMessage pattern.
 */
export function installWrapperBypassMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean; steer?: boolean } = {},
): { audit: WrapperBypassAuditEntry[] } {
	const audit: WrapperBypassAuditEntry[] = [];
	const firedToolCallIds = new Set<string>();
	const isEnabled = opts.isEnabled ?? (() => true);
	const mode: "observe" | "steer" = opts.steer ? "steer" : "observe";

	if (process.env.PI_WRAPPER_BYPASS_MONITOR !== "off") {
		console.error(`[wrapper-bypass] heuristic monitor installed (message_end hook, mode=${mode})`);
	} else {
		console.error("[wrapper-bypass] heuristic monitor DISABLED via PI_WRAPPER_BYPASS_MONITOR=off");
	}

	pi.on("message_end", async (ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_WRAPPER_BYPASS_MONITOR === "off") return;
		if (!isEnabled()) return;

		const event = ev as { message?: { id?: string; role?: string; content?: unknown } };
		const msg = event?.message;
		if (!msg || msg.role !== "assistant") return;

		const branch = ctx.sessionManager.getBranch();
		const metrics = analyzeMessage(msg, branch);
		const decision = shouldFire(metrics);

		if (!decision.fire) {
			// Keep audit tight — only log fires.
			return;
		}

		// Loop-limit: skip matches whose toolCallId we've already fired on this
		// session. If all matches are duplicates, suppress the entry entirely.
		const newMatches = metrics.matches.filter((m) => {
			if (m.toolCallId === null) return true; // can't dedupe without id; fire
			if (firedToolCallIds.has(m.toolCallId)) return false;
			firedToolCallIds.add(m.toolCallId);
			return true;
		});
		if (newMatches.length === 0) {
			// All matches already fired — silently skip.
			return;
		}

		const dedupedMetrics: WrapperBypassMetrics = { ...metrics, matches: newMatches };
		const steerSuggestions = newMatches.map(renderSteerText);

		const entry: WrapperBypassAuditEntry = {
			timestamp: new Date().toISOString(),
			fired: true,
			mode,
			steered: false,
			metrics: dedupedMetrics,
			steerSuggestions,
			reason: decision.reason,
		};
		audit.push(entry);
		pi.appendEntry(WRAPPER_BYPASS_MONITOR_NAME, entry);

		// Observe-mode: stop here. No steer dispatch. Promotion path:
		//   1. accumulate ≥2 accurate wild fires + ≥1 stable-period without
		//      FPs on the corpus (cross-iter aggregator surfaces both)
		//   2. spec a follow-up track that flips opts.steer = true + wires a
		//      setTimeout(0)-deferred sendMessage analogous to null-output's
		//      pattern at line 213-222 of heuristic-null-output.ts. The steer
		//      text is already pre-computed in entry.steerSuggestions.
	});

	return { audit };
}
