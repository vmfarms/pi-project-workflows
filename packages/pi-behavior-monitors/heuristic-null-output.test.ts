import { describe, expect, it } from "vitest";
import { analyzeTurn, shouldFire } from "./heuristic-null-output.js";

// Synthetic fixtures mirror the 4 historical true-null shapes documented in
// hindsight-vmf test-prompts/analysis/T-NullOutput-Investigation-final.md
// §PRIMARY-3 — plus negative cases that the spec must NOT fire on.

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

describe("analyzeTurn", () => {
	it("aggregates a single assistant turn correctly", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(300), text: "\n\n" }),
		];
		const m = analyzeTurn(branch as any);
		expect(m.thinkingChars).toBe(300);
		expect(m.visibleChars).toBe(2);
		expect(m.toolCallCount).toBe(0);
		expect(m.stopReason).toBe("stop");
		expect(m.matchedNullShape).toBe(true);
		expect(m.userMessageId).toBe("m-user-1");
	});

	it("stops at the most recent user message (does not walk into prior turns)", () => {
		const branch = [
			makeUserEntry("u-old"),
			makeAssistantEntry({ id: "a-old", thinking: "y".repeat(500), text: "old reply" }),
			makeUserEntry("u-new"),
			makeAssistantEntry({ id: "a-new", thinking: "z".repeat(250), text: "\n\n" }),
		];
		const m = analyzeTurn(branch as any);
		expect(m.thinkingChars).toBe(250); // only the new-turn's thinking
		expect(m.userMessageId).toBe("u-new");
	});
});

describe("shouldFire (true-null shapes)", () => {
	it("fires on pure whitespace text (shape: '\\n\\n')", () => {
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(227), text: "\n\n" })];
		const m = analyzeTurn(branch as any);
		expect(shouldFire(m).fire).toBe(true);
	});

	it("fires on empty <think></think> artifact (T2-2 shape)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(777), text: "\n\n<think>\n\n</think>\n\n" }),
		];
		const m = analyzeTurn(branch as any);
		expect(shouldFire(m).fire).toBe(true);
	});

	it("fires on bare opening code fence", () => {
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(656), text: "\n\n```" })];
		const m = analyzeTurn(branch as any);
		expect(shouldFire(m).fire).toBe(true);
	});
});

describe("shouldFire (negative cases)", () => {
	it("does NOT fire on legitimate short reply ('Your name is Hany...')", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({
				thinking: "x".repeat(298),
				text: "\n\nYour name is Hany, based on the home directory path `/Users/hany/`.",
			}),
		];
		const m = analyzeTurn(branch as any);
		expect(shouldFire(m).fire).toBe(false);
	});

	it("does NOT fire when thinking is too short (<200 chars)", () => {
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(50), text: "\n\n" })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire when tool calls are present (turn is not empty)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({ thinking: "x".repeat(300), text: "\n\n", toolCalls: 1 }),
		];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire when stopReason is 'aborted' (user interrupted)", () => {
		const branch = [makeUserEntry(), makeAssistantEntry({ thinking: "x".repeat(300), text: "\n\n", stopReason: "aborted" })];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});

	it("does NOT fire on near-null recovery (literal <think></think> + substantive content after)", () => {
		const branch = [
			makeUserEntry(),
			makeAssistantEntry({
				thinking: "x".repeat(471),
				text: "\n\nIt's late — I'll keep this quick and do it in one shot.\n\n<think>\n\n</think>\n\n<patch_content>...",
			}),
		];
		expect(shouldFire(analyzeTurn(branch as any)).fire).toBe(false);
	});
});
