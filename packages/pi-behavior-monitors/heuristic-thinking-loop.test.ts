import { describe, expect, it } from "vitest";
import { analyzeMessage, shouldFire } from "./heuristic-thinking-loop.js";

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
