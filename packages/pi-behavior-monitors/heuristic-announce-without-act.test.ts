import { describe, expect, it } from "vitest";
import { analyzeTurn, shouldFire } from "./heuristic-announce-without-act.js";

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
