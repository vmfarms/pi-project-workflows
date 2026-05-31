import { describe, expect, it } from "vitest";
import { analyzeMessage, installThinkingLoopMonitor, shouldFire } from "./heuristic-thinking-loop.js";

// Synthetic fixtures mirror the v6 T8 thinking-loop pathology: a thinking
// block containing the same long paragraph (≥500 chars) repeated 3 times.

function makeAssistantMessage(opts: { id?: string; thinking?: string; text?: string }) {
	const content: any[] = [];
	if (opts.thinking !== undefined) content.push({ type: "thinking", thinking: opts.thinking });
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

const LONG_PARA_A =
	"The wp-config.php file appears to have the database credentials configured correctly, " +
	"but the WordPress container is unable to establish a connection to the wordpress_db service. " +
	"This may be due to a missing Traefik route, a network partition between the swarm overlay " +
	"and the database container, or a credential mismatch between the application config and " +
	"what the database server is actually expecting. I should re-examine the service definition " +
	"and confirm the network attachment before concluding.";

const LONG_PARA_B =
	"On further reflection, the most likely cause is that the wordpress_web service was " +
	"redeployed without picking up the new credential set, leaving it pointing at a stale " +
	"copy of the credentials baked into its image layer. The fix would be to redeploy the " +
	"service with the updated env vars. But first I should verify by reading the actual " +
	"env vars of the running container and comparing them to the secret store. Let me " +
	"inspect the running container's environment to compare against the documented " +
	"credentials in the secret store.";

describe("analyzeMessage", () => {
	it("returns largest repeat count = 3 when paragraph appears 3 times", () => {
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const m = analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any);
		expect(m.largestRepeatCount).toBe(3);
		expect(m.largestRepeatHash).not.toBeNull();
		expect(m.largestRepeatSample.length).toBeLessThanOrEqual(120);
	});

	it("returns largest repeat count = 1 when paragraphs are all distinct", () => {
		const thinking = [LONG_PARA_A, LONG_PARA_B].join("\n\n");
		const m = analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any);
		expect(m.largestRepeatCount).toBe(1);
	});

	it("ignores paragraphs below PARAGRAPH_MIN_CHARS (500)", () => {
		const shortPara = "This is a short paragraph that should NOT count.";
		const thinking = [shortPara, shortPara, shortPara, shortPara].join("\n\n");
		const m = analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any);
		expect(m.largestRepeatCount).toBe(0);
		expect(m.largestRepeatHash).toBeNull();
	});

	it("returns largest of multiple duplicate groups", () => {
		const thinking = [
			LONG_PARA_A,
			LONG_PARA_A, // A x2
			LONG_PARA_B,
			LONG_PARA_B,
			LONG_PARA_B, // B x3
		].join("\n\n");
		const m = analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any);
		expect(m.largestRepeatCount).toBe(3);
	});

	it("captures userMessageId from the branch walk", () => {
		const branch = [
			{
				type: "message",
				id: "u-target",
				message: { role: "user", content: [{ type: "text", text: "x" }] },
			},
		];
		const m = analyzeMessage(
			makeAssistantMessage({ thinking: LONG_PARA_A }),
			branch as any,
		);
		expect(m.userMessageId).toBe("u-target");
	});
});

describe("shouldFire", () => {
	it("fires when largestRepeatCount >= 3", () => {
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const m = analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(true);
		expect(d.reason).toContain("3×");
	});

	it("does NOT fire at exactly 2 repeats (threshold is 3)", () => {
		const thinking = [LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const m = analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
		expect(d.reason).toMatch(/< 3/);
	});

	it("does NOT fire when no paragraph qualifies (no thinking content)", () => {
		const m = analyzeMessage(makeAssistantMessage({ text: "answer" }), makeBranchWithUser() as any);
		const d = shouldFire(m);
		expect(d.fire).toBe(false);
	});

	it("does NOT fire on long-but-distinct paragraphs", () => {
		const thinking = [LONG_PARA_A, LONG_PARA_B].join("\n\n");
		const d = shouldFire(analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any));
		expect(d.fire).toBe(false);
	});

	it("fires at 4+ repeats (anything above threshold)", () => {
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const d = shouldFire(analyzeMessage(makeAssistantMessage({ thinking }), makeBranchWithUser() as any));
		expect(d.fire).toBe(true);
		expect(d.reason).toContain("4×");
	});
});

// =============================================================================
// installThinkingLoopMonitor — integration: message_end + message_update[thinking_end]
// =============================================================================

/**
 * Lightweight pi stub: captures registered handlers and the appendEntry payload.
 * Lets us drive synthetic message_end / message_update events and inspect what
 * the install function did, without spinning up a full pi runtime.
 */
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

describe("installThinkingLoopMonitor — message_update[thinking_end] hook (2026-05-31)", () => {
	it("registers BOTH message_end and message_update handlers", () => {
		const { pi, handlers } = makePiStub();
		installThinkingLoopMonitor(pi);
		expect(typeof handlers["message_end"]).toBe("function");
		expect(typeof handlers["message_update"]).toBe("function");
	});

	it("fires on message_update when thinking_end carries a loop (mid-stream catch)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installThinkingLoopMonitor(pi);
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const partial = makeAssistantMessage({ thinking });
		const ev = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking, partial },
		};
		await handlers["message_update"]!(ev, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended.length).toBe(1);
		expect((appended[0]!.entry as { reason?: string }).reason).toMatch(/via message_update/);
	});

	it("does NOT fire on non-thinking_end inner events (text_delta, toolcall_start, etc.)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installThinkingLoopMonitor(pi);
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const partial = makeAssistantMessage({ thinking });
		for (const innerType of ["text_delta", "thinking_delta", "toolcall_start", "start", "done"]) {
			const ev = {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: innerType, partial },
			};
			await handlers["message_update"]!(ev, makeCtxWithBranch(makeBranchWithUser()));
		}
		expect(appended.length).toBe(0);
	});

	it("dedupes across message_update + message_end (shared firedKeys; loop caught once)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installThinkingLoopMonitor(pi);
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const partial = makeAssistantMessage({ thinking });
		const branch = makeBranchWithUser();

		// Mid-stream: thinking_end fires
		await handlers["message_update"]!(
			{
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking, partial },
			},
			makeCtxWithBranch(branch),
		);
		expect(appended.length).toBe(1);
		// Then message_end fires for the same message — should be deduped (one loop, one entry that fired + one loop-limit entry)
		await handlers["message_end"]!(
			{ type: "message_end", message: { ...partial } },
			makeCtxWithBranch(branch),
		);
		// Total appended = 2 (1 fire + 1 loop-limit suppression entry)
		expect(appended.length).toBe(2);
		const reasons = appended.map((a) => (a.entry as { reason?: string }).reason ?? "");
		expect(reasons.filter((r) => r.includes("loop-limit")).length).toBe(1);
	});

	it("does NOT fire on assistantMessageEvent absent (non-message_update events ignored)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installThinkingLoopMonitor(pi);
		const partial = makeAssistantMessage({ thinking: [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n") });
		await handlers["message_update"]!(
			{ type: "message_update", message: partial /* no assistantMessageEvent */ },
			makeCtxWithBranch(makeBranchWithUser()),
		);
		expect(appended.length).toBe(0);
	});
});

describe("installThinkingLoopMonitor — message_end hook still works (backward compat)", () => {
	it("fires on message_end alone (no message_update precedes)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installThinkingLoopMonitor(pi);
		const thinking = [LONG_PARA_A, LONG_PARA_A, LONG_PARA_A].join("\n\n");
		const msg = makeAssistantMessage({ thinking });
		await handlers["message_end"]!({ type: "message_end", message: msg }, makeCtxWithBranch(makeBranchWithUser()));
		expect(appended.length).toBe(1);
		expect((appended[0]!.entry as { reason?: string }).reason).toMatch(/via message_end/);
	});
});
