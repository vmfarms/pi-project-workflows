import { describe, expect, it } from "vitest";
import {
	analyzeMessage,
	detectFormFixation,
	FORM_FIXATION_RE,
	installWrapperFormFixationMonitor,
	KNOWN_WRAPPER_TOOL_NAMES,
	renderSteerText,
	shouldFire,
} from "./heuristic-wrapper-form-fixation.js";

// Synthetic fixtures mirror the n=2 evidence pair on 2026-06-02:
//   - Memory-Phase5 S11: bash command='ssh_exec host=braveshores-01 command="docker stack ls -a"' (pi built-in)
//   - Wrapper-Remeasure S11: bash command='ssh_exec_docker host="braveshores-01" command="..."' (shipped wrapper)
// Same prompt + same agent shape; the second TOKEN matters less than the
// FIRST: the agent stringified a structured-arg invocation into bash.

function makeBashCall(opts: { id?: string; command: string }) {
	return {
		type: "toolCall",
		id: opts.id ?? "tc-1",
		name: "bash",
		input: { command: opts.command },
	};
}

function makeBashCallArguments(opts: { id?: string; command: string }) {
	// Persisted-JSONL shape uses `arguments` not `input`. The detector accepts both.
	return {
		type: "toolCall",
		id: opts.id ?? "tc-1",
		name: "bash",
		arguments: { command: opts.command },
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
// detectFormFixation — pattern-matching unit
// =============================================================================

describe("detectFormFixation — positive matches", () => {
	it("matches `ssh_exec_docker host=...` (Wrapper-Remeasure S11 shape; shipped wrapper)", () => {
		const r = detectFormFixation(`ssh_exec_docker host="braveshores-01" command="docker network ls | grep mealie"`);
		expect(r).not.toBeNull();
		expect(r!.tool).toBe("ssh_exec_docker");
	});

	it("matches `ssh_exec host=...` (Memory-Phase5 S11 shape; pi built-in)", () => {
		const r = detectFormFixation(`ssh_exec host=braveshores-01 command="docker stack ls -a"`);
		expect(r).not.toBeNull();
		expect(r!.tool).toBe("ssh_exec");
	});

	it("matches `docker_service_logs host=...` (shipped wrapper)", () => {
		const r = detectFormFixation(`docker_service_logs host="X" service="Y" tail=100`);
		expect(r).not.toBeNull();
		expect(r!.tool).toBe("docker_service_logs");
	});

	it("matches `docker_service_ps host=...` (shipped wrapper)", () => {
		const r = detectFormFixation(`docker_service_ps host="X" service="Y"`);
		expect(r).not.toBeNull();
		expect(r!.tool).toBe("docker_service_ps");
	});

	it("matches with single-quoted params (variant of the same shape)", () => {
		const r = detectFormFixation(`ssh_exec host='braveshores-01' command='docker network ls --format json'`);
		expect(r).not.toBeNull();
		expect(r!.tool).toBe("ssh_exec");
	});
});

describe("detectFormFixation — negative matches", () => {
	it("does NOT match `python script.py arg=value` (python is not a known wrapper)", () => {
		expect(detectFormFixation("python script.py arg=value")).toBeNull();
	});

	it("does NOT match `sudo docker logs container` (no `param=` after the tool token)", () => {
		// This is wrapper-bypass's domain (raw sudo docker), not this monitor's.
		expect(detectFormFixation("sudo docker logs ghost_db.1.abc")).toBeNull();
	});

	it("does NOT match `ls -la` (no equals sign)", () => {
		expect(detectFormFixation("ls -la")).toBeNull();
	});

	it("does NOT match `make build CFLAGS=-O2` (make not a known wrapper)", () => {
		expect(detectFormFixation("make build CFLAGS=-O2")).toBeNull();
	});

	it("does NOT match mid-line stringified tool (must be at START of command)", () => {
		// Composite shell where a tool name appears later in the pipeline is NOT
		// the form-fixation shape — the agent constructed a real bash pipeline.
		expect(detectFormFixation(`echo foo | ssh_exec host=X command="..."`)).toBeNull();
	});

	it("does NOT match SHOUTY_CASE_NAMES (must be snake_case lowercase)", () => {
		// Convention: shipped wrapper names are snake_case lowercase. Upper-case
		// false starts are dropped to keep the surface narrow.
		expect(detectFormFixation(`SSH_EXEC host=X command="y"`)).toBeNull();
	});

	it("does NOT match when known tool name is mid-word (e.g., `ssh_executor`)", () => {
		// FORM_FIXATION_RE requires \s after the tool token, so `ssh_executor`
		// (no whitespace) won't capture as `ssh_exec`.
		expect(detectFormFixation(`ssh_executor host=X command="y"`)).toBeNull();
	});
});

// =============================================================================
// FORM_FIXATION_RE — regex sanity
// =============================================================================

describe("FORM_FIXATION_RE", () => {
	it("captures the first snake_case identifier as group 1", () => {
		const m = FORM_FIXATION_RE.exec(`docker_service_logs host="X"`);
		expect(m).not.toBeNull();
		expect(m![1]).toBe("docker_service_logs");
	});

	it("requires param=value syntax after the tool token", () => {
		expect(FORM_FIXATION_RE.test("ssh_exec something_else")).toBe(false);
	});

	it("is case-sensitive (lowercase only for tool token)", () => {
		expect(FORM_FIXATION_RE.test("Ssh_Exec host=X")).toBe(false);
	});
});

// =============================================================================
// KNOWN_WRAPPER_TOOL_NAMES — vendor invariants
// =============================================================================

describe("KNOWN_WRAPPER_TOOL_NAMES", () => {
	it("includes pi built-in ssh_exec (Memory-Phase5 S11 fires here)", () => {
		expect(KNOWN_WRAPPER_TOOL_NAMES.has("ssh_exec")).toBe(true);
	});

	it("includes shipped wrapper ssh_exec_docker (Wrapper-Remeasure S11 fires here)", () => {
		expect(KNOWN_WRAPPER_TOOL_NAMES.has("ssh_exec_docker")).toBe(true);
	});

	it("includes the 2026-06-01 ServiceCluster bundle wrappers", () => {
		expect(KNOWN_WRAPPER_TOOL_NAMES.has("docker_service_ps")).toBe(true);
		expect(KNOWN_WRAPPER_TOOL_NAMES.has("docker_service_logs")).toBe(true);
		expect(KNOWN_WRAPPER_TOOL_NAMES.has("docker_node_labels")).toBe(true);
	});

	it("matches the shipped_tools.json count (14) + 1 pi built-in (ssh_exec) = 15 total", () => {
		expect(KNOWN_WRAPPER_TOOL_NAMES.size).toBe(15);
	});
});

// =============================================================================
// analyzeMessage — message-walking unit
// =============================================================================

describe("analyzeMessage", () => {
	it("counts bash tool calls and surfaces form-fixation matches", () => {
		const msg = makeAssistantMessage({
			toolCalls: [
				makeBashCall({ id: "tc-1", command: `ssh_exec host=braveshores-01 command="docker stack ls -a"` }),
				makeBashCall({ id: "tc-2", command: `ssh_exec_docker host="X" command="docker network ls"` }),
			],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.bashCount).toBe(2);
		expect(m.matches.length).toBe(2);
		expect(m.matches[0]!.tool).toBe("ssh_exec");
		expect(m.matches[1]!.tool).toBe("ssh_exec_docker");
		expect(m.matches[0]!.toolCallId).toBe("tc-1");
	});

	it("accepts BOTH runtime `input.command` AND persisted-JSONL `arguments.command` (replay parity)", () => {
		// Empirically validated 2026-06-02: live message_end events carry
		// `input.command`; persisted session JSONLs carry `arguments.command`.
		// The detector must work against BOTH so the same code drives live
		// dispatch and replay validation.
		const msg = makeAssistantMessage({
			toolCalls: [
				makeBashCallArguments({ id: "tc-1", command: `ssh_exec host=X command="ls"` }),
			],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.bashCount).toBe(1);
		expect(m.matches.length).toBe(1);
		expect(m.matches[0]!.tool).toBe("ssh_exec");
	});

	it("ignores non-bash tool calls", () => {
		const msg = makeAssistantMessage({
			toolCalls: [
				makeOtherToolCall({ id: "tc-1", name: "ssh_exec", input: { host: "X", command: "uptime" } }),
				makeOtherToolCall({ id: "tc-2", name: "docker_logs", input: { host: "X", container: "Y" } }),
				makeBashCall({ id: "tc-3", command: `ssh_exec host=X command="ls"` }),
			],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.bashCount).toBe(1);
		expect(m.matches.length).toBe(1);
		expect(m.matches[0]!.tool).toBe("ssh_exec");
	});

	it("returns no matches when bash uses a legitimate command (no form-fixation)", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: "ls -la /var/log" })],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.bashCount).toBe(1);
		expect(m.matches.length).toBe(0);
	});

	it("returns no matches when bash uses python with arg= (non-wrapper FP guard)", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: "python script.py arg=value" })],
		});
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.bashCount).toBe(1);
		expect(m.matches.length).toBe(0);
	});

	it("returns empty when message has no tool calls (text-only assistant message)", () => {
		const msg = makeAssistantMessage({ text: "Here's what I found …" });
		const m = analyzeMessage(msg, makeBranch(msg));
		expect(m.bashCount).toBe(0);
		expect(m.matches.length).toBe(0);
	});

	it("finds the current user message id", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: `ssh_exec host=X command="ls"` })],
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
			toolCalls: [makeBashCall({ command: `ssh_exec host=X command="ls"` })],
		});
		const decision = shouldFire(analyzeMessage(msg, makeBranch(msg)));
		expect(decision.fire).toBe(true);
		expect(decision.reason).toMatch(/form-fixation match/);
	});

	it("does NOT fire when bash command is benign", () => {
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: "ls -la" })],
		});
		expect(shouldFire(analyzeMessage(msg, makeBranch(msg))).fire).toBe(false);
	});

	it("does NOT fire when no bash calls", () => {
		const msg = makeAssistantMessage({ text: "no tools needed" });
		expect(shouldFire(analyzeMessage(msg, makeBranch(msg))).fire).toBe(false);
	});
});

// =============================================================================
// renderSteerText — output formatting
// =============================================================================

describe("renderSteerText", () => {
	it("emits the canonical steer wording naming the wrapped tool", () => {
		const text = renderSteerText({
			tool: "ssh_exec_docker",
			matchedText: "ssh_exec_docker host=",
			toolCallId: "tc-1",
			fullCommand: `ssh_exec_docker host="X" command="docker ps"`,
		});
		expect(text).toContain("ssh_exec_docker");
		expect(text).toContain("invoke ssh_exec_docker directly");
		expect(text).toMatch(/Don't wrap/i);
		expect(text).toContain("native parameters");
	});

	it("calls out the structured-output / error-recovery rationale", () => {
		const text = renderSteerText({
			tool: "ssh_exec",
			matchedText: "ssh_exec host=",
			toolCallId: "tc-2",
			fullCommand: `ssh_exec host=X command="ls"`,
		});
		expect(text).toContain("structured output");
		expect(text).toContain("error-recovery");
	});
});

// =============================================================================
// installWrapperFormFixationMonitor — steer-mode (default per Promote iter)
// =============================================================================

interface PiStubSentMessage {
	customMsg: { customType?: string; content?: string; display?: boolean };
	opts: { deliverAs?: string; triggerTurn?: boolean };
}

function makePiStub() {
	const handlers: Record<string, (ev: unknown, ctx: unknown) => Promise<void> | void> = {};
	const appended: Array<{ name: string; entry: unknown }> = [];
	const sent: PiStubSentMessage[] = [];
	const pi = {
		on(event: string, handler: (ev: unknown, ctx: unknown) => Promise<void> | void) {
			handlers[event] = handler;
		},
		appendEntry(name: string, entry: unknown) {
			appended.push({ name, entry });
		},
		sendMessage(customMsg: unknown, opts: unknown) {
			sent.push({
				customMsg: customMsg as PiStubSentMessage["customMsg"],
				opts: opts as PiStubSentMessage["opts"],
			});
		},
	} as never;
	return { pi, handlers, appended, sent };
}

function makeCtxWithBranch(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}

async function flushSetTimeout() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installWrapperFormFixationMonitor — steer-mode dispatch (DEFAULT for this iter)", () => {
	it("DEFAULTS to steer mode (per `Promote` iter-name) and dispatches sendMessage on fire", async () => {
		const { pi, handlers, sent, appended } = makePiStub();
		installWrapperFormFixationMonitor(pi); // no opts.steer → defaults to steer
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: `ssh_exec_docker host="X" command="docker ps"` })],
		});
		await handlers["message_end"]!(
			{ message: { ...msg, role: "assistant" } },
			makeCtxWithBranch(makeBranch(msg)),
		);
		await flushSetTimeout();
		expect(sent.length).toBe(1);
		const dispatched = sent[0]!;
		expect(dispatched.customMsg.customType).toBe("wrapper-form-fixation-recovery");
		expect(dispatched.customMsg.content).toContain("ssh_exec_docker");
		expect(dispatched.customMsg.display).toBe(true);
		expect(dispatched.opts.deliverAs).toBe("steer");
		expect(dispatched.opts.triggerTurn).toBe(true);
		expect((appended[0]!.entry as { steered?: boolean }).steered).toBe(true);
		expect((appended[0]!.entry as { mode?: string }).mode).toBe("steer");
	});

	it("opts.steer=false drops to observe-mode (audit only, no dispatch)", async () => {
		const { pi, handlers, sent, appended } = makePiStub();
		installWrapperFormFixationMonitor(pi, { steer: false });
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: `ssh_exec host=X command="ls"` })],
		});
		await handlers["message_end"]!(
			{ message: { ...msg, role: "assistant" } },
			makeCtxWithBranch(makeBranch(msg)),
		);
		await flushSetTimeout();
		expect(sent.length).toBe(0);
		expect((appended[0]!.entry as { steered?: boolean }).steered).toBe(false);
		expect((appended[0]!.entry as { mode?: string }).mode).toBe("observe");
	});

	it("respects PI_WRAPPER_FORM_FIXATION_STEER=off (audit persists, dispatch suppressed)", async () => {
		process.env.PI_WRAPPER_FORM_FIXATION_STEER = "off";
		try {
			const { pi, handlers, sent, appended } = makePiStub();
			installWrapperFormFixationMonitor(pi); // steer default
			const msg = makeAssistantMessage({
				toolCalls: [makeBashCall({ command: `ssh_exec host=X command="ls"` })],
			});
			await handlers["message_end"]!(
				{ message: { ...msg, role: "assistant" } },
				makeCtxWithBranch(makeBranch(msg)),
			);
			await flushSetTimeout();
			expect(sent.length).toBe(0);
			expect(appended.length).toBe(1);
			expect((appended[0]!.entry as { steered?: boolean }).steered).toBe(false);
			expect((appended[0]!.entry as { mode?: string }).mode).toBe("steer");
		} finally {
			delete process.env.PI_WRAPPER_FORM_FIXATION_STEER;
		}
	});

	it("joins multi-match steerSuggestions with newline in the dispatched content", async () => {
		const { pi, handlers, sent } = makePiStub();
		installWrapperFormFixationMonitor(pi);
		const msg = makeAssistantMessage({
			toolCalls: [
				makeBashCall({ id: "tc-1", command: `ssh_exec host=X command="docker ps"` }),
				makeBashCall({ id: "tc-2", command: `ssh_exec_docker host="Y" command="docker network ls"` }),
			],
		});
		await handlers["message_end"]!(
			{ message: { ...msg, role: "assistant" } },
			makeCtxWithBranch(makeBranch(msg)),
		);
		await flushSetTimeout();
		expect(sent.length).toBe(1);
		const content = sent[0]!.customMsg.content ?? "";
		expect(content).toContain("ssh_exec");
		expect(content).toContain("ssh_exec_docker");
		expect(content.split("\n").length).toBeGreaterThanOrEqual(2);
	});

	it("does NOT dispatch when shouldFire returns false (benign bash command)", async () => {
		const { pi, handlers, sent, appended } = makePiStub();
		installWrapperFormFixationMonitor(pi);
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: "ls -la" })],
		});
		await handlers["message_end"]!(
			{ message: { ...msg, role: "assistant" } },
			makeCtxWithBranch(makeBranch(msg)),
		);
		await flushSetTimeout();
		expect(sent.length).toBe(0);
		expect(appended.length).toBe(0);
	});

	it("loop-limit: same toolCallId across re-emitted message_end fires once, dispatches once", async () => {
		const { pi, handlers, sent } = makePiStub();
		installWrapperFormFixationMonitor(pi);
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ id: "tc-dedupe", command: `ssh_exec host=X command="ls"` })],
		});
		const ctx = makeCtxWithBranch(makeBranch(msg));

		await handlers["message_end"]!({ message: { ...msg, role: "assistant" } }, ctx);
		await flushSetTimeout();
		expect(sent.length).toBe(1);

		await handlers["message_end"]!({ message: { ...msg, role: "assistant" } }, ctx);
		await flushSetTimeout();
		expect(sent.length).toBe(1);
	});

	it("PI_WRAPPER_FORM_FIXATION_MONITOR=off hard-disables the whole monitor", async () => {
		process.env.PI_WRAPPER_FORM_FIXATION_MONITOR = "off";
		try {
			const { pi, handlers, sent, appended } = makePiStub();
			installWrapperFormFixationMonitor(pi);
			const msg = makeAssistantMessage({
				toolCalls: [makeBashCall({ command: `ssh_exec host=X command="ls"` })],
			});
			await handlers["message_end"]!(
				{ message: { ...msg, role: "assistant" } },
				makeCtxWithBranch(makeBranch(msg)),
			);
			await flushSetTimeout();
			expect(sent.length).toBe(0);
			expect(appended.length).toBe(0);
		} finally {
			delete process.env.PI_WRAPPER_FORM_FIXATION_MONITOR;
		}
	});

	it("respects isEnabled() callback returning false (no fire, no dispatch)", async () => {
		const { pi, handlers, sent, appended } = makePiStub();
		installWrapperFormFixationMonitor(pi, { isEnabled: () => false });
		const msg = makeAssistantMessage({
			toolCalls: [makeBashCall({ command: `ssh_exec host=X command="ls"` })],
		});
		await handlers["message_end"]!(
			{ message: { ...msg, role: "assistant" } },
			makeCtxWithBranch(makeBranch(msg)),
		);
		await flushSetTimeout();
		expect(sent.length).toBe(0);
		expect(appended.length).toBe(0);
	});
});
