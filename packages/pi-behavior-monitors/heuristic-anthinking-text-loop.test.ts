import { describe, expect, it } from "vitest";
import {
	analyzeMessage,
	installAntThinkingTextLoopMonitor,
	shouldFire,
} from "./heuristic-anthinking-text-loop.js";

// =============================================================================
// Synthetic fixtures mirror two known live shapes from R7 ghost-db-mysql-
// rotation session 2026-05-31T17-22-53-245Z_019e7f0f-...:
//   L13: 37× repetition of a 68-char antThinking paragraph
//   L20: 22× repetition of a 165-char antThinking paragraph
// Plus a hypothetical Shape #1-equivalent long-paragraph repeat for
// completeness.
// =============================================================================

function makeAssistantMessage(opts: { id?: string; text?: string }) {
	const content: any[] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	return {
		id: opts.id ?? "m-assistant-1",
		role: "assistant",
		content,
	};
}

function makeBranchWithUser(userId = "u-1") {
	return [
		{
			type: "message",
			id: userId,
			message: { role: "user", content: [{ type: "text", text: "investigate" }] },
		},
	];
}

const R7_L20_PARA = "All services show 1/1, including ghost_db and ghost_web. They appear to be running. Let me check task-level status, logs";
const R7_L13_PARA = "I need to use the `ssh_exec` tool directly. Let me call it properly.";

// 500+ char antThinking paragraph (hypothetical long-repeat shape; not yet
// observed in the wild but Shape #1's family supports it via the inherited
// REPEAT_THRESHOLD=3 + PARAGRAPH_MIN_CHARS=500 rule).
const LONG_ANT_PARA =
	"The wordpress_web service is unable to establish a connection to wordpress_db. " +
	"I should check the Traefik route configuration, the swarm overlay network attachment, " +
	"and the credentials baked into the running container. The most likely cause is that " +
	"a recent redeploy did not pick up the updated env vars. Let me re-examine the service " +
	"definition and confirm the network attachment before concluding. I should also verify " +
	"that the docker_logs output is clean of TLS errors and the docker_inspect output " +
	"shows the right networks attached. Only then should I propose a recovery.";

function makeTextWithAntThinking(parts: string[]): string {
	return parts.map((p) => `<antThinking>\n${p}\n</antThinking>`).join("\n\nIntermediate prose.\n\n");
}

describe("analyzeMessage (antThinking-text-loop)", () => {
	it("extracts antThinking paragraphs from TEXT blocks (R7 L20-style)", () => {
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		expect(m.antThinkingSegmentCount).toBe(22);
		expect(m.largestPrefixRepeatCount).toBe(22);
		expect(m.largestPrefixRepeatHash).not.toBeNull();
	});

	it("counts long-paragraph repetition when paragraphs are ≥500 chars (hypothetical antThinking long-repeat)", () => {
		const text = makeTextWithAntThinking(Array(3).fill(LONG_ANT_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		expect(m.largestRepeatCount).toBe(3);
		expect(m.largestRepeatHash).not.toBeNull();
	});

	it("returns zero counts when message has no antThinking wrappers", () => {
		const text = "Just plain text. No pseudo-XML thinking here.";
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		expect(m.antThinkingSegmentCount).toBe(0);
		expect(m.largestRepeatCount).toBe(0);
		expect(m.largestPrefixRepeatCount).toBe(0);
	});

	it("returns zero when message has no TEXT blocks at all", () => {
		const msg = { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "thinking content" }] };
		const m = analyzeMessage(msg, makeBranchWithUser() as any);
		expect(m.textChars).toBe(0);
		expect(m.antThinkingSegmentCount).toBe(0);
	});

	it("ignores short paragraphs below SHORT_PARAGRAPH_MIN_CHARS (20)", () => {
		const text = makeTextWithAntThinking(Array(15).fill("hi"));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		expect(m.largestPrefixRepeatCount).toBe(0);
	});

	it("captures userMessageId from branch walk", () => {
		const branch = [
			{
				type: "message",
				id: "u-anthinking-target",
				message: { role: "user", content: [{ type: "text", text: "x" }] },
			},
		];
		const text = makeTextWithAntThinking([R7_L20_PARA]);
		const m = analyzeMessage(makeAssistantMessage({ text }), branch as any);
		expect(m.userMessageId).toBe("u-anthinking-target");
	});

	it("handles multiple TEXT blocks in one message", () => {
		const msg = {
			id: "m1",
			role: "assistant",
			content: [
				{ type: "text", text: makeTextWithAntThinking([R7_L20_PARA, R7_L20_PARA]) },
				{ type: "text", text: makeTextWithAntThinking([R7_L20_PARA, R7_L20_PARA]) },
			],
		};
		const m = analyzeMessage(msg, makeBranchWithUser() as any);
		expect(m.antThinkingSegmentCount).toBe(4);
		expect(m.largestPrefixRepeatCount).toBe(4);
	});
});

describe("shouldFire (antThinking-text-loop)", () => {
	it("fires short-prefix-repeat on R7 L20-style 22× repetition", () => {
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(true);
		expect(d.detector).toBe("short-prefix-repeat");
		expect(d.reason).toContain("22×");
	});

	it("fires short-prefix-repeat on R7 L13-style 37× repetition of a 68-char paragraph", () => {
		const text = makeTextWithAntThinking(Array(37).fill(R7_L13_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(true);
		expect(d.detector).toBe("short-prefix-repeat");
	});

	it("fires long-repeat on hypothetical ≥3× of ≥500-char antThinking paragraph", () => {
		const text = makeTextWithAntThinking(Array(3).fill(LONG_ANT_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(true);
		expect(d.detector).toBe("long-repeat");
	});

	it("does NOT fire at 9 short-prefix repeats (threshold is 10)", () => {
		const text = makeTextWithAntThinking(Array(9).fill(R7_L20_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
	});

	it("does NOT fire at exactly 2 long repeats (threshold is 3)", () => {
		const text = makeTextWithAntThinking(Array(2).fill(LONG_ANT_PARA));
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
	});

	it("does NOT fire when no antThinking wrappers in TEXT blocks (clean control)", () => {
		const msg = makeAssistantMessage({
			text: "I'll check the wordpress_db logs. Then I'll inspect the swarm services to confirm the network attachment. Finally I'll consult the customer's deploy doc.",
		});
		const m = analyzeMessage(msg, makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
	});

	it("does NOT fire when antThinking paragraphs are distinct (no repeat)", () => {
		const distincts = Array.from({ length: 15 }, (_, i) =>
			`I should check service ${i}: this is a long-enough paragraph but each one is distinct. ${i}.`,
		);
		const text = makeTextWithAntThinking(distincts);
		const m = analyzeMessage(makeAssistantMessage({ text }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
	});
});

// =============================================================================
// installAntThinkingTextLoopMonitor — integration: message_end hook
// =============================================================================

function makePiStub() {
	const handlers: Record<string, (ev: unknown, ctx: unknown) => Promise<void> | void> = {};
	const appended: Array<{ name: string; entry: unknown }> = [];
	const pi = {
		on(event: string, handler: (ev: unknown, ctx: unknown) => Promise<void> | void) {
			handlers[event] = handler;
		},
		appendEntry(name: string, entry: unknown) {
			appended.push({ name, entry });
		},
	} as never;
	return { pi, handlers, appended };
}

function makeCtxWithBranch(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}

describe("installAntThinkingTextLoopMonitor — install", () => {
	it("registers a message_end handler", () => {
		const { pi, handlers } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		expect(typeof handlers["message_end"]).toBe("function");
	});

	it("does NOT register a message_update handler (MVP only catches at message_end)", () => {
		const { pi, handlers } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		expect(handlers["message_update"]).toBeUndefined();
	});

	it("fires on message_end with R7 L20-style 22× short repetition", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const msg = makeAssistantMessage({ text });
		await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended.length).toBe(1);
		const entry = appended[0]!.entry as { detector?: string; reason?: string };
		expect(entry.detector).toBe("short-prefix-repeat");
		expect(entry.reason).toContain("22×");
	});

	it("does NOT fire on a clean-control message (no antThinking)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		const msg = makeAssistantMessage({ text: "Just a normal answer with no pseudo-XML at all." });
		await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended.length).toBe(0);
	});

	it("loop-limits: re-emitted message_end for same shape fires once then loop-limit", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const msg = makeAssistantMessage({ text });
		const ctx = makeCtxWithBranch(makeBranchWithUser());

		await handlers["message_end"]!({ message: msg }, ctx);
		await handlers["message_end"]!({ message: msg }, ctx);

		expect(appended.length).toBe(2);
		const reasons = appended.map((a) => (a.entry as { reason?: string }).reason ?? "");
		expect(reasons.filter((r) => r.includes("loop-limit")).length).toBe(1);
	});

	it("respects PI_ANTTHINKING_TEXT_LOOP_MONITOR=off (no fires)", async () => {
		process.env.PI_ANTTHINKING_TEXT_LOOP_MONITOR = "off";
		try {
			const { pi, handlers, appended } = makePiStub();
			installAntThinkingTextLoopMonitor(pi);
			const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
			const msg = makeAssistantMessage({ text });
			await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
			expect(appended.length).toBe(0);
		} finally {
			delete process.env.PI_ANTTHINKING_TEXT_LOOP_MONITOR;
		}
	});

	it("respects isEnabled() callback returning false", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi, { isEnabled: () => false });
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const msg = makeAssistantMessage({ text });
		await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended.length).toBe(0);
	});

	it("ignores non-assistant messages", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const msg = { id: "u", role: "user", content: [{ type: "text", text }] };
		await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended.length).toBe(0);
	});

	it("includes mode='observe' in audit entries by default", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const msg = makeAssistantMessage({ text });
		await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect((appended[0]!.entry as { mode?: string }).mode).toBe("observe");
	});

	it("uses the canonical monitor name when calling appendEntry", async () => {
		const { pi, handlers, appended } = makePiStub();
		installAntThinkingTextLoopMonitor(pi);
		const text = makeTextWithAntThinking(Array(22).fill(R7_L20_PARA));
		const msg = makeAssistantMessage({ text });
		await handlers["message_end"]!({ message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended[0]!.name).toBe("anthinking-text-loop");
	});
});
