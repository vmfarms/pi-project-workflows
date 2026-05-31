import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeTurn, installAnnounceWithoutActMonitor, shouldFire } from "./heuristic-announce-without-act.js";

// Synthetic fixtures mirror the two known-positive shapes from Phase 5:
//   - iter-30 (canonical): substantive announce-intent ("I'll investigate ...
//     Let me check ..."), thinking 323 chars, visible 178 chars, 0 tools,
//     stopReason=stop
//   - phase5-t2-2 (boundary): 21-char visible "<think></think>" artifact,
//     thinking 777 chars; in null-output's domain, MUST NOT fire here.

function makeAssistantEntry(opts: {
	id?: string;
	thinking?: string;
	text?: string;
	stopReason?: string;
	toolCalls?: number;
}) {
	const content: any[] = [];
	if (opts.thinking !== undefined) content.push({ type: "thinking", thinking: opts.thinking });
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
		content.push({ type: "toolCall", name: "bash", input: {} });
	}
	return {
		type: "message",
		id: opts.id ?? "m-assistant-1",
		message: {
			role: "assistant",
			content,
			stopReason: opts.stopReason ?? "stop",
		},
	};
}

function makeUserEntry(id = "m-user-1") {
	return {
		type: "message",
		id,
		message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
	};
}

const ITER30_VISIBLE =
	"I'll investigate the WordPress \"Error establishing a database connection\" issue on braveshores-01. " +
	"Let me check the current state of the WordPress container and its database.";

describe("analyzeTurn", () => {
	it("aggregates a single assistant turn correctly", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(323), text: ITER30_VISIBLE }),
		];
		const m = analyzeTurn(branch as any);
		expect(m.thinkingChars).toBe(323);
		expect(m.visibleChars).toBe(ITER30_VISIBLE.length);
		expect(m.toolCallCount).toBe(0);
		expect(m.stopReason).toBe("stop");
		expect(m.matchedPattern).not.toBeNull();
		expect(m.userMessageId).toBe("m-user-1");
	});

	it("stops at the most recent user message (does not walk into prior turns)", () => {
		const branch = [
			makeUserEntry("u-old"),
			makeAssistantEntry({ id: "a-old", thinking: "y".repeat(500), text: "old reply with no announce" }),
			makeUserEntry("u-new"),
			makeAssistantEntry({ id: "a-new", thinking: "z".repeat(250), text: ITER30_VISIBLE }),
		];
		const m = analyzeTurn(branch as any);
		expect(m.thinkingChars).toBe(250); // only the new-turn's thinking
		expect(m.userMessageId).toBe("u-new");
		expect(m.matchedPattern).not.toBeNull();
	});
});

describe("shouldFire (known-positive shapes)", () => {
	it("fires on iter-30 canonical shape (\"I'll investigate ... Let me check ...\")", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(323), text: ITER30_VISIBLE }),
		];
		const m = analyzeTurn(branch as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(true);
	});

	it("fires on minimal announce-intent shape (\"I'll start by ...\")", () => {
		const visible =
			"I'll start by checking the container status and then reviewing the database connection settings.";
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(250), text: visible })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(true);
	});

	it("fires on \"Let me check ...\" announce", () => {
		const visible =
			"Let me check the WordPress container logs to see what's happening before I dig into the database side.";
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(250), text: visible })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(true);
	});

	it("fires on \"I will investigate ...\" variant", () => {
		const visible =
			"I will investigate the database connection failure on the wordpress site and report back the root cause.";
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(250), text: visible })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(true);
	});
});

describe("shouldFire (boundary cases)", () => {
	it("does NOT fire on phase5-t2-2 shape (21-char `<think></think>` artifact — null-output's domain)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(777), text: "\n\n<think>\n\n</think>\n\n" }),
		];
		const m = analyzeTurn(branch as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
		expect(d.reason).toMatch(/null-output's domain/);
	});

	it("does NOT fire on pure-whitespace null-output shape", () => {
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(300), text: "\n\n" })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire on bare opening code fence", () => {
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(656), text: "\n\n```" })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});
});

describe("shouldFire (negative cases)", () => {
	it("does NOT fire when announce-intent is followed by tool calls (productive turn)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({
				thinking: "x".repeat(300),
				text: ITER30_VISIBLE,
				toolCalls: 1,
			}),
		];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire on substantive answer with rhetorical 'Let me check' early (FP corpus case 019e4266)", () => {
		// 3300+ char real technical answer that opens with "Good questions. Let me check ..."
		const longBody = "x".repeat(600);
		const visible =
			"\n\nGood questions. Let me check what data the tools already have in their response payloads vs what actually gets formatted for the LLM. " +
			longBody;
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(4500), text: visible })];
		const d = shouldFire(analyzeTurn(branch as any));
		expect(d.fire).toBe(false);
		expect(d.reason).toMatch(/likely substantive answer/);
	});

	it("does NOT fire on late-night refusal where announce appears late (FP corpus case 019e5359)", () => {
		// Agent refuses to act due to late-night guard; "I'll start" appears at
		// position ~120 — beyond the 100-char start anchor.
		const visible =
			"\n\nIt's 1:40 AM. Go to bed. This task requires reading files from disk, which is task execution. " +
			"Tomorrow, I'll start by reviewing the relevant config files.";
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(1800), text: visible })];
		const d = shouldFire(analyzeTurn(branch as any));
		expect(d.fire).toBe(false);
		expect(d.reason).toMatch(/announce not at start of visible/);
	});

	it("does NOT fire when thinking is too short (<200 chars)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(50), text: ITER30_VISIBLE }),
		];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire when stopReason is 'aborted' (user interrupted)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(300), text: ITER30_VISIBLE, stopReason: "aborted" }),
		];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire on substantive answer without announce-intent prose", () => {
		const visible =
			"The WordPress container is failing because the database password was changed but the env var was not rotated. Fix: update WORDPRESS_DB_PASSWORD secret and restart.";
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(400), text: visible })];
		const d = shouldFire(analyzeTurn(branch as any));
		expect(d.fire).toBe(false);
		expect(d.reason).toMatch(/did not match any announce-intent pattern/);
	});

	it("does NOT fire on mid-word matches (word-boundary discipline)", () => {
		// 'will-call', 'checklist', 'investigated' should NOT trip the regex due to \b boundaries
		const visible =
			"The will-call list is empty and the checklist already investigated all candidate hosts — no further action needed at this time.";
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(300), text: visible })];
		const d = shouldFire(analyzeTurn(branch as any));
		expect(d.fire).toBe(false);
	});
});

// =============================================================================
// installAnnounceWithoutActMonitor — steer-mode integration (2026-05-31)
// =============================================================================
//
// Steer-mode promoted in T-Monitors-Bundle PRIMARY-5 after 9 production
// fires in one day without observed false positives. These tests assert the
// dispatch path: setTimeout(0)-deferred sendMessage with the canonical
// STEER_TEXT + customType "announce-without-act-recovery", and the
// PI_ANNOUNCE_WITHOUT_ACT_STEER=off fail-soft toggle.

interface SentMessageRecord {
	customType: string;
	content: string;
	display?: boolean;
	opts: { deliverAs?: string; triggerTurn?: boolean };
}

function makePiStub() {
	const handlers: Record<string, (ev: unknown, ctx: unknown) => Promise<void> | void> = {};
	const appended: Array<{ name: string; entry: unknown }> = [];
	const sent: SentMessageRecord[] = [];
	const pi = {
		on(event: string, handler: (ev: unknown, ctx: unknown) => Promise<void> | void) {
			handlers[event] = handler;
		},
		appendEntry(name: string, entry: unknown) {
			appended.push({ name, entry });
		},
		sendMessage(msg: { customType?: string; content?: string; display?: boolean }, opts: { deliverAs?: string; triggerTurn?: boolean }) {
			sent.push({
				customType: msg.customType ?? "",
				content: msg.content ?? "",
				display: msg.display,
				opts,
			});
		},
	} as never;
	return { pi, handlers, appended, sent };
}

function makeFiringBranch() {
	return [
		makeUserEntry("u-firing-1"),
		makeAssistantEntry({ thinking: "x".repeat(323), text: ITER30_VISIBLE }),
	];
}

function makeCtxWithBranch(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}

async function flushSetTimeout() {
	// setTimeout(0) defers to the next macrotask; await one tick to drain it.
	await new Promise((r) => setTimeout(r, 0));
}

describe("installAnnounceWithoutActMonitor — steer-mode dispatch", () => {
	const originalEnv = process.env.PI_ANNOUNCE_WITHOUT_ACT_STEER;
	beforeEach(() => {
		delete process.env.PI_ANNOUNCE_WITHOUT_ACT_STEER;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_ANNOUNCE_WITHOUT_ACT_STEER;
		else process.env.PI_ANNOUNCE_WITHOUT_ACT_STEER = originalEnv;
	});

	it("dispatches a steer message when steer=true and fires", async () => {
		const { pi, handlers, appended, sent } = makePiStub();
		installAnnounceWithoutActMonitor(pi, { steer: true });
		await handlers["agent_end"]!({ type: "agent_end" }, makeCtxWithBranch(makeFiringBranch()));
		await flushSetTimeout();
		expect(appended.length).toBe(1);
		expect((appended[0]!.entry as { steered: boolean }).steered).toBe(true);
		expect((appended[0]!.entry as { mode: string }).mode).toBe("steer");
		expect(sent.length).toBe(1);
		expect(sent[0]!.customType).toBe("announce-without-act-recovery");
		expect(sent[0]!.content).toMatch(/announced intent without executing/);
		expect(sent[0]!.opts.deliverAs).toBe("steer");
		expect(sent[0]!.opts.triggerTurn).toBe(true);
	});

	it("does NOT dispatch steer when steer=false (observe-mode default; backward compat)", async () => {
		const { pi, handlers, appended, sent } = makePiStub();
		installAnnounceWithoutActMonitor(pi /* no steer */);
		await handlers["agent_end"]!({ type: "agent_end" }, makeCtxWithBranch(makeFiringBranch()));
		await flushSetTimeout();
		expect(appended.length).toBe(1);
		expect((appended[0]!.entry as { steered: boolean }).steered).toBe(false);
		expect((appended[0]!.entry as { mode: string }).mode).toBe("observe");
		expect(sent.length).toBe(0);
	});

	it("PI_ANNOUNCE_WITHOUT_ACT_STEER=off suppresses dispatch but keeps observe audit", async () => {
		process.env.PI_ANNOUNCE_WITHOUT_ACT_STEER = "off";
		const { pi, handlers, appended, sent } = makePiStub();
		installAnnounceWithoutActMonitor(pi, { steer: true });
		await handlers["agent_end"]!({ type: "agent_end" }, makeCtxWithBranch(makeFiringBranch()));
		await flushSetTimeout();
		expect(appended.length).toBe(1);
		expect((appended[0]!.entry as { steered: boolean }).steered).toBe(false);
		// mode field still reports "steer" (install-time decision) — the override
		// affects DISPATCH, not the install-mode label
		expect((appended[0]!.entry as { mode: string }).mode).toBe("steer");
		expect(sent.length).toBe(0);
	});

	it("loop-limit: does NOT re-dispatch steer on second fire for same userMessageId", async () => {
		const { pi, handlers, appended, sent } = makePiStub();
		installAnnounceWithoutActMonitor(pi, { steer: true });
		const branch = makeFiringBranch();
		await handlers["agent_end"]!({ type: "agent_end" }, makeCtxWithBranch(branch));
		await flushSetTimeout();
		await handlers["agent_end"]!({ type: "agent_end" }, makeCtxWithBranch(branch));
		await flushSetTimeout();
		// Two audit entries (one normal fire + one loop-limit), but one steer dispatch
		expect(appended.length).toBe(2);
		expect(sent.length).toBe(1);
		expect((appended[1]!.entry as { reason?: string }).reason).toMatch(/loop-limit/);
	});
});
