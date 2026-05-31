import { describe, expect, it } from "vitest";
import {
	analyzeMessage,
	detectWrapperBypass,
	DOCKER_EXEC_RE,
	DOCKER_WRAPPER_PATTERNS,
	renderSteerText,
	shouldFire,
} from "./heuristic-wrapper-bypass.js";

// Synthetic fixtures mirror the 5 cases surfaced by
// T-Tool-Candidates-LLM-WorkerDirect-Run (2026-05-31) across 4 iters:
// agent constructs `sudo docker <SUBCMD>` via ssh_exec when the shipped
// pi-vmfarms-tools wrappers cover SUBCMD.

function makeSshExecCall(opts: { id?: string; host?: string; command: string }) {
	return {
		type: "toolCall",
		id: opts.id ?? "tc-1",
		name: "ssh_exec",
		input: { host: opts.host ?? "braveshores-01", command: opts.command },
	};
}

function makeOtherToolCall(opts: { id?: string; name: string; input?: Record<string, unknown> }) {
	return {
		type: "toolCall",
		id: opts.id ?? "tc-other-1",
		name: opts.name,
		input: opts.input ?? {},
	};
}

function makeAssistantMessage(opts: { id?: string; toolCalls?: unknown[]; text?: string }) {
	const content: unknown[] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	if (opts.toolCalls) content.push(...opts.toolCalls);
	return {
		id: opts.id ?? "m-asst-1",
		content,
	};
}

function makeUserEntry(id = "m-user-1") {
	return {
		type: "message",
		id,
		message: { role: "user", content: [{ type: "text", text: "investigate" }] },
	};
}

function makeBranch(message: ReturnType<typeof makeAssistantMessage>) {
	return [
		makeUserEntry(),
		{ type: "message", id: message.id, message: { role: "assistant", content: message.content } },
	];
}

// =============================================================================
// detectWrapperBypass — pattern-matching unit
// =============================================================================

describe("detectWrapperBypass — positive matches", () => {
	it("matches `sudo docker logs <ctr>` → docker_logs", () => {
		const r = detectWrapperBypass("sudo docker logs ghost_db.1.abc --tail 100");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("docker_logs");
		expect(r!.subcmd).toBe("logs");
	});

	it("matches `sudo docker inspect <ctr>` → docker_inspect (not the multi-token service rule)", () => {
		const r = detectWrapperBypass("sudo docker inspect ghost_db.1.abc");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("docker_inspect");
	});

	it("matches `sudo docker service inspect <svc>` → docker_service_inspect (multi-token wins)", () => {
		const r = detectWrapperBypass("sudo docker service inspect ghost_db --format '{{.Spec.TaskTemplate.ContainerSpec.Env}}'");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("docker_service_inspect");
		expect(r!.subcmd).toBe("service inspect");
	});

	it("matches `sudo docker service ls` → swarm_service_status", () => {
		const r = detectWrapperBypass("sudo docker service ls --format '{{.Name}} {{.Replicas}}'");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("swarm_service_status");
	});

	it("matches `sudo docker service ps` → swarm_service_status", () => {
		const r = detectWrapperBypass("sudo docker service ps ghost_db --no-trunc");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("swarm_service_status");
	});

	it("matches `sudo docker ps` → docker_ps", () => {
		const r = detectWrapperBypass("sudo docker ps --filter name=ghost_db");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("docker_ps");
	});

	it("matches `sudo docker volume inspect` → docker_volume_inspect", () => {
		const r = detectWrapperBypass("sudo docker volume inspect ghost_db_data");
		expect(r).not.toBeNull();
		expect(r!.wrapper).toBe("docker_volume_inspect");
	});
});

describe("detectWrapperBypass — negative matches", () => {
	it("does NOT match `sudo docker exec` (no shipped wrapper for exec)", () => {
		expect(detectWrapperBypass("sudo docker exec -it ghost_db.1.abc /bin/bash")).toBeNull();
	});

	it("does NOT match a docker-unrelated ssh command", () => {
		expect(detectWrapperBypass("sudo tail -f /var/log/syslog")).toBeNull();
	});

	it("ALSO matches `docker logs` WITHOUT sudo (optional-sudo per LLM-judged corpus 2026-05-31)", () => {
		// The LLM-judged wrapper-bypass corpus included `docker service ls 2>&1`
		// (no sudo) as a valid bypass case. Detection is optional-sudo to cover
		// both authoring forms; the wrapper still applies regardless of sudo prefix.
		expect(detectWrapperBypass("docker logs ghost_db.1.abc")).not.toBeNull();
	});

	it("does NOT match `sudo docker rm` (no shipped wrapper for rm; not bypass-of-wrapper)", () => {
		expect(detectWrapperBypass("sudo docker rm ghost_db.1.abc")).toBeNull();
	});

	it("does NOT match mid-word substring (e.g., `pseudologinsspecial`)", () => {
		expect(detectWrapperBypass("sudo docker pseudologin")).toBeNull();
	});
});

describe("DOCKER_EXEC_RE", () => {
	it("matches `sudo docker exec` independently", () => {
		expect(DOCKER_EXEC_RE.test("sudo docker exec -it foo /bin/bash")).toBe(true);
	});

	it("does NOT match text that contains `exec` only as a substring inside another word", () => {
		// `execve`, `execute`, `executable` — none of these appear after
		// `sudo docker `, but the word-boundary discipline is what guards them.
		expect(DOCKER_EXEC_RE.test("sudo docker execve foo")).toBe(false);
		expect(DOCKER_EXEC_RE.test("sudo docker execute foo")).toBe(false);
	});
});

// =============================================================================
// analyzeMessage — message-walking unit
// =============================================================================

describe("analyzeMessage", () => {
	it("counts ssh_exec tool calls and surfaces bypass matches", () => {
		const msg = makeAssistantMessage({
			toolCalls: [
				makeSshExecCall({ id: "tc-1", command: "sudo docker logs ghost_db.1.abc --tail 100" }),
				makeSshExecCall({ id: "tc-2", command: "sudo docker service inspect ghost_db" }),
			],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.sshExecCount).toBe(2);
		expect(m.matches.length).toBe(2);
		expect(m.matches[0]!.wrapper).toBe("docker_logs");
		expect(m.matches[1]!.wrapper).toBe("docker_service_inspect");
		expect(m.matches[0]!.toolCallId).toBe("tc-1");
		expect(m.execDetectedCount).toBe(0);
	});

	it("tracks `docker exec` separately (not in matches; not fired)", () => {
		const msg = makeAssistantMessage({
			toolCalls: [
				makeSshExecCall({ id: "tc-1", command: "sudo docker exec -it ghost_db.1.abc /bin/bash" }),
				makeSshExecCall({ id: "tc-2", command: "sudo docker logs ghost_db.1.abc" }),
			],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.sshExecCount).toBe(2);
		expect(m.execDetectedCount).toBe(1);
		expect(m.matches.length).toBe(1);
		expect(m.matches[0]!.wrapper).toBe("docker_logs");
	});

	it("ignores non-ssh_exec tool calls", () => {
		const msg = makeAssistantMessage({
			toolCalls: [
				makeOtherToolCall({ id: "tc-1", name: "ctx_search", input: { queries: ["docker logs"] } }),
				makeOtherToolCall({ id: "tc-2", name: "docker_logs", input: { host: "h", container: "c" } }),
				makeSshExecCall({ id: "tc-3", command: "sudo docker ps" }),
			],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.sshExecCount).toBe(1);
		expect(m.matches.length).toBe(1);
		expect(m.matches[0]!.wrapper).toBe("docker_ps");
	});

	it("returns no matches when ssh_exec uses a docker-unrelated command", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeSshExecCall({ command: "sudo tail -f /var/log/syslog" })],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.sshExecCount).toBe(1);
		expect(m.matches.length).toBe(0);
		expect(m.execDetectedCount).toBe(0);
	});

	it("returns empty when message has no tool calls (text-only assistant message)", () => {
		const msg = makeAssistantMessage({ text: "Here's what I found …" });
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.sshExecCount).toBe(0);
		expect(m.matches.length).toBe(0);
	});

	it("finds the current user message id", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeSshExecCall({ command: "sudo docker logs c" })],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.userMessageId).toBe("m-user-1");
	});
});

// =============================================================================
// shouldFire — decision rule
// =============================================================================

describe("shouldFire", () => {
	it("fires when matches > 0", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeSshExecCall({ command: "sudo docker logs c" })],
		});
		const decision = shouldFire(analyzeMessage(msg, makeBranch(msg)));
		expect(decision.fire).toBe(true);
		expect(decision.reason).toMatch(/wrapper-bypass match/);
	});

	it("does NOT fire when only exec was detected (no shipped wrapper)", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeSshExecCall({ command: "sudo docker exec -it c /bin/bash" })],
		});
		const decision = shouldFire(analyzeMessage(msg, makeBranch(msg)));
		expect(decision.fire).toBe(false);
		expect(decision.reason).toMatch(/'docker exec' call\(s\) skipped/);
	});

	it("does NOT fire when no ssh_exec calls", () => {
		const msg = makeAssistantMessage({ text: "no tools needed" });
		expect(shouldFire(analyzeMessage(msg, makeBranch(msg))).fire).toBe(false);
	});
});

// =============================================================================
// renderSteerText — output formatting
// =============================================================================

describe("renderSteerText", () => {
	it("emits the canonical steer wording", () => {
		const text = renderSteerText({
			wrapper: "docker_logs",
			subcmd: "logs",
			matchedText: "sudo docker logs",
			toolCallId: "tc-1",
			fullCommand: "sudo docker logs ghost_db.1.abc",
		});
		expect(text).toContain("docker_logs");
		expect(text).toContain("logs");
		expect(text).toContain("instead of raw");
		// Quote conventions: subcmd in single-quotes
		expect(text).toContain("'logs'");
	});

	it("includes the subcmd label for multi-token wrappers", () => {
		const text = renderSteerText({
			wrapper: "docker_service_inspect",
			subcmd: "service inspect",
			matchedText: "sudo docker service inspect",
			toolCallId: "tc-2",
			fullCommand: "sudo docker service inspect ghost_db",
		});
		expect(text).toContain("docker_service_inspect");
		expect(text).toContain("'service inspect'");
	});
});

// =============================================================================
// Pattern set — sanity invariant
// =============================================================================

describe("DOCKER_WRAPPER_PATTERNS — invariants", () => {
	it("declares multi-token patterns before their single-token prefix collisions", () => {
		// `service inspect` must appear in the list before bare `inspect` so
		// `sudo docker service inspect …` resolves to docker_service_inspect.
		const subcmds = DOCKER_WRAPPER_PATTERNS.map((p) => p.subcmd);
		const inspectIdx = subcmds.indexOf("inspect");
		const serviceInspectIdx = subcmds.indexOf("service inspect");
		const volumeInspectIdx = subcmds.indexOf("volume inspect");
		expect(serviceInspectIdx).toBeLessThan(inspectIdx);
		expect(volumeInspectIdx).toBeLessThan(inspectIdx);
	});

	it("does NOT include `exec` (no shipped wrapper)", () => {
		const subcmds = DOCKER_WRAPPER_PATTERNS.map((p) => p.subcmd);
		expect(subcmds).not.toContain("exec");
	});
});
