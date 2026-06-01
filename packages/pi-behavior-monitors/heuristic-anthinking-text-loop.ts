/**
 * Heuristic antThinking-text-loop detector.
 *
 * Sibling to heuristic-thinking-loop (Shape #1 LONG-REPEAT + Shape #2
 * POST-BUDGET). Targets Shape #3 — the antThinking-text-loop pathology
 * where the model routes reasoning through inline `<antThinking>…
 * </antThinking>` pseudo-XML tags inside TEXT content blocks instead of
 * proper THINKING blocks. The paragraph-repeat shape is the same family
 * as Shape #1/#2 but a DIFFERENT content channel (block.type === "text"
 * not "thinking"), so the sibling thinking-loop analyzer is blind to it.
 *
 * Canonical fixture: T-Phase5-CoverageExpansion R7 ghost-db-mysql-rotation
 * session at ~/.pi/agent/sessions/--Users-hany-Documents-Projects-ansible-
 * v3--/2026-05-31T17-22-53-245Z_019e7f0f-... — last assistant message at
 * L20 has a 4633-char text block with 22 antThinking segments, where 22×
 * (all of them) are the SAME 165-char paragraph ("All services show 1/1,
 * including ghost_db and ghost_web..."). Earlier L13 in the same session
 * has 37× repetition of a 68-char paragraph ("I need to use the ssh_exec
 * tool directly..."). Both shapes are SHORT-paragraph repetition — well
 * below the 500-char min of Shape #1's LONG-REPEAT path.
 *
 * Detection runs both shape thresholds (long-repeat AND short-prefix-
 * repeat) like heuristic-thinking-loop, but on extracted antThinking
 * payload rather than thinking-block content. This catches both:
 *   - v6 T8-style ≥3× long-paragraph repeats (hypothetical antThinking
 *     equivalent; not yet observed but the family supports it)
 *   - R7-style ≥10× short-paragraph-prefix repeats (observed at L13/L20)
 *
 * Hook choice: message_end only (no message_update). Rationale: text-
 * block content is stable at message_end. message_update[text_end] could
 * be added later for mid-stream catch if observed shapes require it; for
 * now MVP is end-of-message only. Tracked as iter-N+ candidate.
 *
 * Ships in OBSERVE-MODE: records audit entries + emits pi.appendEntry.
 * Steer-mode promotion path: ≥2 accurate fires + low FP rate on corpus,
 * then flip opts.steer = true + add a setTimeout(0)-deferred sendMessage
 * mirroring heuristic-announce-without-act lines 293-312. The steer text
 * for this shape is roughly "you appear to be repeating the same
 * antThinking reasoning — wrap up and emit your final answer."
 *
 * Loop limit: dedupe by (userMessageId, paragraphHash) so re-emission of
 * the same message_end event doesn't repeat-fire. Namespaced "anthinking|"
 * separately from the thinking-loop hashes.
 *
 * Toggle: respects package-level `monitorsEnabled` + honors env override
 * PI_ANTTHINKING_TEXT_LOOP_MONITOR=off for debugging / replay harness.
 *
 * Why the OPENING TAG is `<antThinking>` (note the leading `ant`):
 * this is a qwen-3 artifact — the model fragments its own anthropic-trained
 * "thinking" prefix in some configurations. The literal sequence
 * `<antThinking>...</antThinking>` is what surfaces in TEXT-block content
 * when the routing goes wrong. Detection is on the literal pseudo-XML,
 * not on any structural reasoning.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

import { hashParagraph } from "./heuristic-thinking-loop.js";

export const ANTTHINKING_TEXT_LOOP_MONITOR_NAME = "anthinking-text-loop";

// Shape #1-equivalent (long-repeat) on antThinking extracted text.
const PARAGRAPH_MIN_CHARS = 500;
const REPEAT_THRESHOLD = 3;
const PARAGRAPH_SPLIT_RE = /\n\s*\n+/;

// Shape #2-equivalent (short-prefix-repeat) on antThinking extracted text.
// R7 L20 has 22× of a 165-char paragraph; L13 has 37× of a 68-char paragraph.
// Threshold 10 catches both with margin to spare.
const SHORT_PREFIX_LEN = 50;
const SHORT_PARAGRAPH_MIN_CHARS = 20;
const SHORT_REPEAT_THRESHOLD = 10;

// Match the pseudo-XML wrapping. Tolerates leading/trailing whitespace
// inside the wrapper because that's how qwen-3 emits it (e.g. "\n…\n").
const ANTTHINKING_RE = /<antThinking>([\s\S]*?)<\/antThinking>/g;

export interface AntThinkingTextLoopMetrics {
	textChars: number; // total characters of TEXT blocks scanned (denominator)
	antThinkingSegmentCount: number; // number of <antThinking>…</antThinking> pairs extracted
	antThinkingChars: number; // total characters extracted from antThinking wrappers
	paragraphCount: number; // total paragraphs after splitting extracted content
	// Shape-1-equivalent (long-repeat): identical paragraph repetition.
	largestRepeatCount: number;
	largestRepeatHash: string | null;
	largestRepeatSample: string;
	// Shape-2-equivalent (short-prefix-repeat): first-50-char prefix.
	largestPrefixRepeatCount: number;
	largestPrefixRepeatHash: string | null;
	largestPrefixRepeatSample: string;
	userMessageId: string | null;
	messageId: string | null;
}

export interface AntThinkingTextLoopAuditEntry {
	timestamp: string;
	metrics: AntThinkingTextLoopMetrics;
	fired: boolean;
	mode: "observe" | "steer"; // forward-compatible; default observe
	steered: boolean;
	reason?: string;
	/** Which sub-detector triggered — useful for cross-iter aggregation. */
	detector?: "long-repeat" | "short-prefix-repeat";
}

function findCurrentUserMessageId(branch: SessionEntry[]): string | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; id?: string; message?: { role?: string } };
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") return entry.id ?? null;
	}
	return null;
}

/**
 * Walk all TEXT blocks of a message, extract every `<antThinking>…
 * </antThinking>` payload via a global regex, concat the payloads (blank-
 * line separated), split on blank-line into paragraphs, and compute both
 * long-paragraph repetition AND first-50-char-prefix repetition stats.
 *
 * Exported because the replay smoke harness needs to call this directly
 * on captured session messages.
 */
export function analyzeMessage(
	message: { id?: string; content?: unknown },
	branch: SessionEntry[],
): AntThinkingTextLoopMetrics {
	let textChars = 0;
	const extracted: string[] = [];
	let segmentCount = 0;
	const content = message?.content;
	if (Array.isArray(content)) {
		for (const part of content as Array<Record<string, unknown>>) {
			if (part?.type !== "text") continue;
			const t = part.text;
			if (typeof t !== "string") continue;
			textChars += t.length;
			// reset lastIndex per text-block iteration (regex is /g; reuse safely)
			ANTTHINKING_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = ANTTHINKING_RE.exec(t)) !== null) {
				if (typeof match[1] === "string") {
					extracted.push(match[1]);
					segmentCount++;
				}
			}
		}
	}

	const joined = extracted.join("\n\n");
	const paragraphs = joined.split(PARAGRAPH_SPLIT_RE).map((p) => p.trim()).filter((p) => p.length > 0);

	// Long-repeat counts (whole paragraphs ≥500 chars)
	const longByHash = new Map<string, { count: number; sample: string }>();
	for (const p of paragraphs) {
		if (p.length < PARAGRAPH_MIN_CHARS) continue;
		const h = hashParagraph(p);
		const existing = longByHash.get(h);
		if (existing) existing.count++;
		else longByHash.set(h, { count: 1, sample: p.slice(0, 120) });
	}
	let largestLongCount = 0;
	let largestLongHash: string | null = null;
	let largestLongSample = "";
	for (const [h, v] of longByHash) {
		if (v.count > largestLongCount) {
			largestLongCount = v.count;
			largestLongHash = h;
			largestLongSample = v.sample;
		}
	}

	// Short-prefix-repeat counts (first-50-char prefix; paragraphs ≥20 chars)
	const prefixByHash = new Map<string, { count: number; sample: string }>();
	for (const p of paragraphs) {
		if (p.length < SHORT_PARAGRAPH_MIN_CHARS) continue;
		const prefix = p.slice(0, SHORT_PREFIX_LEN);
		const h = hashParagraph(prefix);
		const existing = prefixByHash.get(h);
		if (existing) existing.count++;
		else prefixByHash.set(h, { count: 1, sample: p.slice(0, 120) });
	}
	let largestPrefixCount = 0;
	let largestPrefixHash: string | null = null;
	let largestPrefixSample = "";
	for (const [h, v] of prefixByHash) {
		if (v.count > largestPrefixCount) {
			largestPrefixCount = v.count;
			largestPrefixHash = h;
			largestPrefixSample = v.sample;
		}
	}

	return {
		textChars,
		antThinkingSegmentCount: segmentCount,
		antThinkingChars: joined.length,
		paragraphCount: paragraphs.length,
		largestRepeatCount: largestLongCount,
		largestRepeatHash: largestLongHash,
		largestRepeatSample: largestLongSample,
		largestPrefixRepeatCount: largestPrefixCount,
		largestPrefixRepeatHash: largestPrefixHash,
		largestPrefixRepeatSample: largestPrefixSample,
		userMessageId: findCurrentUserMessageId(branch),
		messageId: message?.id ?? null,
	};
}

/**
 * Decision: fire if EITHER the long-repeat OR the short-prefix-repeat
 * threshold is crossed. Returns the matching detector branch in `detector`.
 *
 * Long-repeat takes precedence in the (extremely unlikely) case that both
 * fire on the same message, just to keep audit consumers simple. Both
 * shapes share the same monitor name, so cross-iter aggregation is
 * uniform.
 */
export function shouldFire(
	m: AntThinkingTextLoopMetrics,
): { fire: boolean; detector: "long-repeat" | "short-prefix-repeat" | null; reason: string } {
	if (m.largestRepeatCount >= REPEAT_THRESHOLD && m.largestRepeatHash !== null) {
		return {
			fire: true,
			detector: "long-repeat",
			reason: `antThinking paragraph repeated ${m.largestRepeatCount}× (threshold ${REPEAT_THRESHOLD}, ≥${PARAGRAPH_MIN_CHARS} chars)`,
		};
	}
	if (m.largestPrefixRepeatCount >= SHORT_REPEAT_THRESHOLD && m.largestPrefixRepeatHash !== null) {
		return {
			fire: true,
			detector: "short-prefix-repeat",
			reason: `antThinking prefix repeated ${m.largestPrefixRepeatCount}× (threshold ${SHORT_REPEAT_THRESHOLD}, prefix ${SHORT_PREFIX_LEN} chars, ≥${SHORT_PARAGRAPH_MIN_CHARS}-char paragraphs)`,
		};
	}
	const noteSeg = m.antThinkingSegmentCount > 0 ? ` (${m.antThinkingSegmentCount} antThinking segments scanned)` : "";
	return {
		fire: false,
		detector: null,
		reason: `no antThinking loop detected${noteSeg}`,
	};
}

/**
 * Install. Idempotent for one extension-load: registers one message_end
 * listener. Loop limit dedupes by composite key per (detector branch,
 * userMessageId, hash) so each distinct loop fires once per turn.
 *
 * Returns the in-memory audit log; production callers can ignore.
 *
 * NOTE: observe-mode default. Steer-mode flip is deferred until 2+
 * accurate wild fires accumulate; see file header for the promotion
 * recipe.
 */
export function installAntThinkingTextLoopMonitor(
	pi: ExtensionAPI,
	opts: { isEnabled?: () => boolean; steer?: boolean } = {},
): { audit: AntThinkingTextLoopAuditEntry[] } {
	const audit: AntThinkingTextLoopAuditEntry[] = [];
	const firedKeys = new Set<string>();
	const isEnabled = opts.isEnabled ?? (() => true);
	const mode: "observe" | "steer" = opts.steer ? "steer" : "observe";

	if (process.env.PI_ANTTHINKING_TEXT_LOOP_MONITOR !== "off") {
		console.error(
			`[anthinking-text-loop] heuristic monitor installed (message_end hook, mode=${mode})`,
		);
	} else {
		console.error("[anthinking-text-loop] heuristic monitor DISABLED via PI_ANTTHINKING_TEXT_LOOP_MONITOR=off");
	}

	pi.on("message_end", async (ev: unknown, ctx: ExtensionContext) => {
		if (process.env.PI_ANTTHINKING_TEXT_LOOP_MONITOR === "off") return;
		if (!isEnabled()) return;

		const event = ev as { message?: { id?: string; role?: string; content?: unknown } };
		const msg = event?.message;
		if (!msg || msg.role !== "assistant") return;

		const branch = ctx.sessionManager.getBranch();
		const metrics = analyzeMessage(msg, branch);
		const decision = shouldFire(metrics);
		if (!decision.fire) return;

		const matchingHash =
			decision.detector === "long-repeat" ? metrics.largestRepeatHash : metrics.largestPrefixRepeatHash;
		const dedupeKey = `anthinking|${decision.detector}|${metrics.userMessageId ?? "?"}|${matchingHash}`;
		const entry: AntThinkingTextLoopAuditEntry = {
			timestamp: new Date().toISOString(),
			metrics,
			fired: true,
			mode,
			steered: false,
			reason: decision.reason,
			detector: decision.detector ?? undefined,
		};
		if (firedKeys.has(dedupeKey)) {
			entry.reason = `loop-limit: already fired for (detector=${decision.detector}, userMessage=${metrics.userMessageId}, hash=${matchingHash})`;
			audit.push(entry);
			pi.appendEntry(ANTTHINKING_TEXT_LOOP_MONITOR_NAME, entry);
			return;
		}
		firedKeys.add(dedupeKey);
		audit.push(entry);
		pi.appendEntry(ANTTHINKING_TEXT_LOOP_MONITOR_NAME, entry);
	});

	return { audit };
}
