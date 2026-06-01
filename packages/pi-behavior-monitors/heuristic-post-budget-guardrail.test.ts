import { describe, expect, it } from "vitest";
import {
	BUDGET_RATIO_THRESHOLD,
	DEFAULT_TOOL_CALL_BUDGET,
	installPostBudgetGuardrailMonitor,
	parseBudgetFromSystemPrompt,
	POST_BUDGET_GUARDRAIL_MONITOR_NAME,
	renderSteerText,
	shouldFire,
} from "./heuristic-post-budget-guardrail.js";

// =============================================================================
// parseBudgetFromSystemPrompt — pattern-matching unit
// =============================================================================

describe("parseBudgetFromSystemPrompt — positive matches", () => {
	it("parses `tool_call_budget: 20`", () => {
		expect(parseBudgetFromSystemPrompt("... tool_call_budget: 20 ...")).toBe(20);
	});

	it("parses `tool_call_budget=20`", () => {
		expect(parseBudgetFromSystemPrompt("config: tool_call_budget=20")).toBe(20);
	});

	it("parses `Tool-call budget: 20` (humanized)", () => {
		expect(parseBudgetFromSystemPrompt("Tool-call budget: 20 per turn.")).toBe(20);
	});

	it("parses `tool call budget of 20` (prose)", () => {
		expect(parseBudgetFromSystemPrompt("You have a tool call budget of 20 calls per turn.")).toBe(20);
	});

	it("parses `budget of 20 tool calls` (reverse phrasing)", () => {
		expect(parseBudgetFromSystemPrompt("A budget of 20 tool calls applies.")).toBe(20);
	});

	it("returns the FIRST matching budget when multiple shapes appear", () => {
		// First-match policy is deterministic across pattern reordering.
		expect(parseBudgetFromSystemPrompt("tool_call_budget: 30 ... tool call budget of 25")).toBe(30);
	});

	it("parses non-default values like 50", () => {
		expect(parseBudgetFromSystemPrompt("tool_call_budget: 50")).toBe(50);
	});
});

describe("parseBudgetFromSystemPrompt — negative matches", () => {
	it("returns null when no budget term present", () => {
		expect(parseBudgetFromSystemPrompt("You are a helpful assistant.")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseBudgetFromSystemPrompt("")).toBeNull();
	});

	it("returns null for budget out of bounds (>200; port number etc.)", () => {
		expect(parseBudgetFromSystemPrompt("tool_call_budget: 8080")).toBeNull();
	});

	it("returns null for budget of 0", () => {
		expect(parseBudgetFromSystemPrompt("tool_call_budget: 0")).toBeNull();
	});

	it("does NOT match unrelated 'budget' phrases", () => {
		// "budget concerns" / "fiscal budget" should NOT yield a number.
		expect(parseBudgetFromSystemPrompt("Stay within budget concerns.")).toBeNull();
	});
});

// =============================================================================
// shouldFire — decision rule unit
// =============================================================================

describe("shouldFire — ratio threshold", () => {
	it("does NOT fire when ratio < 0.9 (17/20 = 0.85)", () => {
		const fired = new Set<string>();
		const d = shouldFire(17, 20, "sess-1|turn-1", fired);
		expect(d.fire).toBe(false);
	});

	it("fires at ratio == 0.9 (18/20)", () => {
		const fired = new Set<string>();
		const d = shouldFire(18, 20, "sess-1|turn-1", fired);
		expect(d.fire).toBe(true);
	});

	it("fires at ratio > 0.9 (19/20)", () => {
		const fired = new Set<string>();
		const d = shouldFire(19, 20, "sess-1|turn-1", fired);
		expect(d.fire).toBe(true);
	});

	it("fires at ratio = 1.0 (20/20)", () => {
		const fired = new Set<string>();
		const d = shouldFire(20, 20, "sess-1|turn-1", fired);
		expect(d.fire).toBe(true);
	});

	it("does NOT fire when budget non-positive (defensive)", () => {
		const fired = new Set<string>();
		expect(shouldFire(0, 0, "sess|t", fired).fire).toBe(false);
		expect(shouldFire(5, -1, "sess|t", fired).fire).toBe(false);
	});
});

describe("shouldFire — per-turn dedupe", () => {
	it("does NOT fire twice for the same turn key", () => {
		const fired = new Set<string>();
		const key = "sess-1|turn-1";
		expect(shouldFire(18, 20, key, fired).fire).toBe(true);
		fired.add(key);
		expect(shouldFire(19, 20, key, fired).fire).toBe(false);
		expect(shouldFire(20, 20, key, fired).fire).toBe(false);
	});

	it("DOES fire again for a different turn key (new RPC turn)", () => {
		const fired = new Set<string>();
		const k1 = "sess-1|turn-1";
		const k2 = "sess-1|turn-2";
		expect(shouldFire(18, 20, k1, fired).fire).toBe(true);
		fired.add(k1);
		expect(shouldFire(18, 20, k2, fired).fire).toBe(true);
	});
});

// =============================================================================
// renderSteerText — pure-function exact-wording test
// =============================================================================

describe("renderSteerText", () => {
	it("renders the canonical observe-mode steer text with substituted values", () => {
		const text = renderSteerText({
			currentToolCalls: 18,
			toolCallBudget: 20,
			ratio: 0.9,
			sessionId: "sess",
			userMessageId: "u-1",
		});
		expect(text).toContain("18/20");
		expect(text).toContain("Summarize what you've found");
		expect(text).toContain("final answer");
		expect(text).toContain("current evidence");
	});
});

// =============================================================================
// installPostBudgetGuardrailMonitor — integration
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

function makeCtx(opts: { sessionId?: string; userMessageId?: string } = {}) {
	const sessionId = opts.sessionId ?? "sess-1";
	const branch =
		opts.userMessageId !== undefined
			? [
					{
						type: "message",
						id: opts.userMessageId,
						message: { role: "user", content: [{ type: "text", text: "investigate" }] },
					},
				]
			: [];
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as never;
}

async function flushSetTimeout() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installPostBudgetGuardrailMonitor — observe-mode (default)", () => {
	it("registers before_agent_start + tool_result hooks", () => {
		const { pi, handlers } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);
		expect(Object.keys(handlers).sort()).toEqual(["before_agent_start", "tool_result"]);
	});

	it("does not fire when fewer than 0.9 ratio tool_results have arrived", async () => {
		const { pi, handlers, appended, sent } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-1" }),
		);
		for (let i = 0; i < 17; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		expect(appended.length).toBe(0);
		expect(sent.length).toBe(0);
	});

	it("fires on the 18th tool_result (ratio 0.9 hit) with observe-mode audit + no dispatch", async () => {
		const { pi, handlers, appended, sent } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-1" }),
		);
		for (let i = 0; i < 18; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		await flushSetTimeout();
		expect(appended.length).toBe(1);
		expect(appended[0]!.name).toBe(POST_BUDGET_GUARDRAIL_MONITOR_NAME);
		const entry = appended[0]!.entry as {
			fired: boolean;
			mode: string;
			steered: boolean;
			metrics: { currentToolCalls: number; toolCallBudget: number; ratio: number; sessionId: string; userMessageId: string | null };
			steerSuggestions: string[];
		};
		expect(entry.fired).toBe(true);
		expect(entry.mode).toBe("observe");
		expect(entry.steered).toBe(false);
		expect(entry.metrics.currentToolCalls).toBe(18);
		expect(entry.metrics.toolCallBudget).toBe(20);
		expect(entry.metrics.ratio).toBeCloseTo(0.9);
		expect(entry.metrics.userMessageId).toBe("u-1");
		expect(entry.steerSuggestions.length).toBe(1);
		expect(entry.steerSuggestions[0]).toContain("18/20");
		expect(sent.length).toBe(0); // observe-mode never dispatches
	});

	it("fires exactly ONCE per turn even when more tool_results arrive", async () => {
		const { pi, handlers, appended } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-1" }),
		);
		for (let i = 0; i < 20; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		expect(appended.length).toBe(1); // only the first crossing fires
	});

	it("resets counter on the next before_agent_start (per-RPC-turn semantics)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);

		// Turn 1: budget pressure, fires.
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-1" }),
		);
		for (let i = 0; i < 18; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		expect(appended.length).toBe(1);

		// Turn 2: counter resets; only 5 calls, no fire.
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-2" }),
		);
		for (let i = 0; i < 5; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-2" }));
		}
		expect(appended.length).toBe(1);

		// Turn 3: again 18, NEW turn key — fires again.
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-3" }),
		);
		for (let i = 0; i < 18; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-3" }));
		}
		expect(appended.length).toBe(2);
	});

	it("falls back to DEFAULT_TOOL_CALL_BUDGET when systemPrompt has no budget", async () => {
		const { pi, handlers, appended } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);
		await handlers["before_agent_start"]!(
			{ systemPrompt: "You are a helpful assistant." },
			makeCtx({ userMessageId: "u-1" }),
		);
		// Use the default budget directly to verify the fallback branch
		const fireAt = Math.ceil(DEFAULT_TOOL_CALL_BUDGET * BUDGET_RATIO_THRESHOLD);
		for (let i = 0; i < fireAt; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		expect(appended.length).toBe(1);
		const entry = appended[0]!.entry as { metrics: { toolCallBudget: number } };
		expect(entry.metrics.toolCallBudget).toBe(DEFAULT_TOOL_CALL_BUDGET);
	});

	it("parses custom budget from systemPrompt and computes ratio against it", async () => {
		const { pi, handlers, appended } = makePiStub();
		installPostBudgetGuardrailMonitor(pi);
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 50" },
			makeCtx({ userMessageId: "u-1" }),
		);
		// Use 44 calls (44/50 = 0.88) — should NOT fire
		for (let i = 0; i < 44; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		expect(appended.length).toBe(0);

		// One more (45/50 = 0.90) — fires
		await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		expect(appended.length).toBe(1);
		const entry = appended[0]!.entry as { metrics: { toolCallBudget: number; currentToolCalls: number } };
		expect(entry.metrics.toolCallBudget).toBe(50);
		expect(entry.metrics.currentToolCalls).toBe(45);
	});

	it("respects PI_POST_BUDGET_GUARDRAIL_MONITOR=off (hard-disable; no fire, no audit)", async () => {
		process.env.PI_POST_BUDGET_GUARDRAIL_MONITOR = "off";
		try {
			const { pi, handlers, appended } = makePiStub();
			installPostBudgetGuardrailMonitor(pi);
			await handlers["before_agent_start"]!(
				{ systemPrompt: "tool_call_budget: 20" },
				makeCtx({ userMessageId: "u-1" }),
			);
			for (let i = 0; i < 20; i++) {
				await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
			}
			expect(appended.length).toBe(0);
		} finally {
			delete process.env.PI_POST_BUDGET_GUARDRAIL_MONITOR;
		}
	});

	it("respects isEnabled() returning false (no fire, no audit)", async () => {
		const { pi, handlers, appended } = makePiStub();
		installPostBudgetGuardrailMonitor(pi, { isEnabled: () => false });
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-1" }),
		);
		for (let i = 0; i < 20; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		expect(appended.length).toBe(0);
	});
});

// =============================================================================
// installPostBudgetGuardrailMonitor — steer-mode (future-friendly; not the
// shipped default). Mirrors heuristic-wrapper-bypass steer-mode test shape.
// =============================================================================

describe("installPostBudgetGuardrailMonitor — steer-mode (future-friendly)", () => {
	it("dispatches a setTimeout(0)-deferred sendMessage when opts.steer=true and a fire happens", async () => {
		const { pi, handlers, sent, appended } = makePiStub();
		installPostBudgetGuardrailMonitor(pi, { steer: true });
		await handlers["before_agent_start"]!(
			{ systemPrompt: "tool_call_budget: 20" },
			makeCtx({ userMessageId: "u-1" }),
		);
		for (let i = 0; i < 18; i++) {
			await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
		}
		await flushSetTimeout();
		expect(sent.length).toBe(1);
		const d = sent[0]!;
		expect(d.customMsg.customType).toBe("post-budget-guardrail-recovery");
		expect(d.customMsg.content).toContain("18/20");
		expect(d.customMsg.display).toBe(true);
		expect(d.opts.deliverAs).toBe("steer");
		expect(d.opts.triggerTurn).toBe(true);
		expect((appended[0]!.entry as { steered?: boolean }).steered).toBe(true);
	});

	it("respects PI_POST_BUDGET_GUARDRAIL_STEER=off: audit fires but no dispatch", async () => {
		process.env.PI_POST_BUDGET_GUARDRAIL_STEER = "off";
		try {
			const { pi, handlers, sent, appended } = makePiStub();
			installPostBudgetGuardrailMonitor(pi, { steer: true });
			await handlers["before_agent_start"]!(
				{ systemPrompt: "tool_call_budget: 20" },
				makeCtx({ userMessageId: "u-1" }),
			);
			for (let i = 0; i < 18; i++) {
				await handlers["tool_result"]!({}, makeCtx({ userMessageId: "u-1" }));
			}
			await flushSetTimeout();
			expect(sent.length).toBe(0);
			expect(appended.length).toBe(1);
			expect((appended[0]!.entry as { steered?: boolean }).steered).toBe(false);
			expect((appended[0]!.entry as { mode?: string }).mode).toBe("steer");
		} finally {
			delete process.env.PI_POST_BUDGET_GUARDRAIL_STEER;
		}
	});
});
