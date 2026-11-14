import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config";
import { stateOf } from "../src/engines";
import { matchKeywords, resolveRoutes } from "../src/routes";
import {
	boundRecent,
	buildSnapshot,
	clipMiddle,
	LATEST_REQUEST_CHARS,
	MAX_TOOL_RESULTS,
	OMISSION_MARKER,
	RECENT_ITEM_CHARS,
	RECENT_TOTAL_CHARS,
	SUMMARY_CHARS,
} from "../src/snapshot";

type Ctx = Parameters<typeof buildSnapshot>[0];

const anthropic = { provider: "anthropic", id: "claude", api: "anthropic-messages" };
const openai = { provider: "openai", id: "gpt", api: "openai-responses" };

let seq = 0;
function entry(fields: Record<string, unknown>, id = `e${++seq}`): SessionEntry {
	return { id, parentId: null, timestamp: "2026-11-13T00:00:00Z", ...fields } as unknown as SessionEntry;
}
const user = (text: string, id?: string) => entry({ type: "message", message: { role: "user", content: text, timestamp: 0 } }, id);
const assistant = (content: unknown, id?: string) =>
	entry({ type: "message", message: { role: "assistant", content, timestamp: 0 } }, id);
const text = (t: string) => assistant([{ type: "text", text: t }]);
const tool = (name: string, output: string, isError = false) =>
	entry({ type: "message", message: { role: "toolResult", toolCallId: "c", toolName: name, content: [{ type: "text", text: output }], isError, timestamp: 0 } });
const compaction = (fields: Record<string, unknown>, id?: string) =>
	entry({ type: "compaction", summary: "", firstKeptEntryId: "", tokensBefore: 1000, ...fields }, id);
const reset = () => entry({ type: "reset_boundary" });
const nativeRemote = { openaiRemoteCompaction: { provider: "openai", replacementHistory: [{ type: "message" }] } };

function snapshotOf(branch: SessionEntry[], model: object | undefined, limit = 6, prompt = "next", images?: unknown[]) {
	const ctx = { model, sessionManager: { getBranch: () => branch }, getContextUsage: () => ({ tokens: 42 }) } as unknown as Ctx;
	return buildSnapshot(ctx, prompt, "anthropic/claude", undefined, limit, images as never);
}

const texts = (s: { recent: { text: string }[] }) => s.recent.map(r => r.text);
const hasLoneSurrogate = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe("clipMiddle", () => {
	test("clipping preserves the goal and final restriction", () => {
		const input = `Investigate the regression. ${"x".repeat(5000)} Do not edit production files.`;
		const clipped = clipMiddle(input, 1200);
		expect(clipped.startsWith("Investigate the regression.")).toBe(true);
		expect(clipped.endsWith("Do not edit production files.")).toBe(true);
		expect(clipped).toContain("[middle omitted]");
		expect(clipped.length).toBeLessThanOrEqual(1200);
	});

	test("the marker counts toward the maximum and the odd character goes to the beginning", () => {
		const input = "H".repeat(60) + "T".repeat(60);
		expect(clipMiddle(input, 51)).toBe("H".repeat(16) + OMISSION_MARKER + "T".repeat(15));
		expect(clipMiddle(input, 50)).toBe("H".repeat(15) + OMISSION_MARKER + "T".repeat(15));
		expect(clipMiddle(input, 120)).toBe(input);
		expect(clipMiddle("short", 1200)).toBe("short");
	});

	test("never splits a surrogate pair and never exceeds the maximum", () => {
		const input = `${"😀".repeat(100)}${"🧪".repeat(100)}`;
		for (let max = 0; max <= 80; max++) {
			const clipped = clipMiddle(input, max);
			expect(clipped.length).toBeLessThanOrEqual(max);
			expect(hasLoneSurrogate(clipped)).toBe(false);
		}
		const clipped = clipMiddle(input, 45);
		expect(clipped.startsWith("😀")).toBe(true);
		expect(clipped.endsWith("🧪")).toBe(true);
	});

	test("a maximum too small for the marker keeps only a Unicode-safe beginning", () => {
		expect(clipMiddle("abcdef", 5)).toBe("abcde");
		expect(clipMiddle("😀😀", 1)).toBe("");
		expect(clipMiddle("abcdef", 0)).toBe("");
	});
});

describe("latest request", () => {
	test("stays complete locally so keywords after character 1200 still match", () => {
		const prompt = `${"background ".repeat(150)}now think through the sharding plan`;
		expect(prompt.indexOf("think through")).toBeGreaterThan(1200);
		const s = snapshotOf([], anthropic, 6, prompt);
		expect(s.latestRequest).toBe(prompt);
		expect(matchKeywords(s.latestRequest, resolveRoutes(DEFAULT_CONFIG))?.route).toBe("plan");
	});

	test("is clipped only in the remote projection, keeping the beginning and end", () => {
		const prompt = `Goal: migrate the billing tables. ${"y".repeat(20_000)} Never touch the invoices table.`;
		const s = snapshotOf([], anthropic, 6, prompt);
		const state = stateOf(s);
		const sent = state.latest_request as string;
		expect(sent.length).toBeLessThanOrEqual(LATEST_REQUEST_CHARS);
		expect(sent.startsWith("Goal: migrate")).toBe(true);
		expect(sent.endsWith("Never touch the invoices table.")).toBe(true);
		expect(state.latest_request_truncated).toBe(true);
		expect(stateOf(snapshotOf([], anthropic, 6, "short")).latest_request_truncated).toBe(false);
	});

	test("reports attachment count without any image content", () => {
		const image = { type: "image", data: "QkFTRTY0UEFZTE9BRA==", mimeType: "image/png" };
		const s = snapshotOf([], anthropic, 6, "look", [image, image]);
		expect(s.attachmentCount).toBe(2);
		expect(JSON.stringify(stateOf(s))).not.toContain("QkFTRTY0");
		expect(stateOf(s).attachment_count).toBe(2);
		expect(snapshotOf([], anthropic).attachmentCount).toBe(0);
	});
});

describe("recent evidence", () => {
	test("an assistant conclusion survives the per-item clip", () => {
		const reply = `Plan: ${"detail ".repeat(400)}Conclusion: ship behind a flag.`;
		const s = snapshotOf([user("what now?"), text(reply)], anthropic);
		const item = s.recent[1];
		expect(item.role).toBe("assistant");
		expect(item.text.length).toBeLessThanOrEqual(RECENT_ITEM_CHARS);
		expect(item.text.startsWith("Plan:")).toBe(true);
		expect(item.text.endsWith("Conclusion: ship behind a flag.")).toBe(true);
	});

	test("keeps the newest user/assistant messages, oldest first, within the configured count", () => {
		const branch: SessionEntry[] = [];
		for (let i = 1; i <= 5; i++) branch.push(user(`u${i}`), text(`a${i}`));
		const s = snapshotOf(branch, anthropic, 3);
		expect(texts(s)).toEqual(["a4", "u5", "a5"]);
		expect(s.recent.map(r => r.role)).toEqual(["assistant", "user", "assistant"]);
	});

	test("adds at most four of the newest tool results on top of the message count", () => {
		const branch = [user("u1"), ...[1, 2, 3, 4, 5, 6].map(i => tool("bash", `out${i}`)), text("a1")];
		const s = snapshotOf(branch, anthropic, 2);
		expect(texts(s)).toEqual(["u1", "out3", "out4", "out5", "out6", "a1"]);
		expect(s.recent.filter(r => r.role.startsWith("tool"))).toHaveLength(MAX_TOOL_RESULTS);
	});

	test("historyMessages 0 produces no recent items, tool results included", () => {
		const s = snapshotOf([user("hello"), tool("bash", "boom", true), text("hi")], anthropic, 0);
		expect(s.recent).toEqual([]);
	});

	test("failed tool results reach the decision payload with name and error label", () => {
		const s = snapshotOf([user("run it"), tool("bash", "exit 2: ENOENT cargo", true), tool("read", "file body")], anthropic);
		expect(s.recent.map(r => r.role)).toEqual(["user", "tool_error:bash", "tool:read"]);
		const payload = JSON.stringify(stateOf(s));
		expect(payload).toContain("tool_error:bash");
		expect(payload).toContain("ENOENT cargo");
	});

	test("thinking, signatures, tool-call arguments and image bytes never appear", () => {
		const secretThinking = "SECRET-CHAIN-OF-THOUGHT";
		const branch = [
			entry({
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see screenshot" },
						{ type: "image", data: "AAAABASE64BYTESAAAA", mimeType: "image/png" },
					],
					timestamp: 0,
				},
			}),
			assistant([
				{ type: "thinking", thinking: secretThinking, thinkingSignature: "SIG-123" },
				{ type: "text", text: "visible answer" },
				{ type: "toolCall", id: "c", name: "bash", arguments: { command: "TOOLARGS" } },
			]),
			entry({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c",
					toolName: "bash",
					content: [{ type: "image", data: "TOOLIMGBYTES", mimeType: "image/png" }],
					isError: false,
					timestamp: 0,
				},
			}),
		];
		const payload = JSON.stringify(stateOf(snapshotOf(branch, anthropic)));
		for (const leaked of [secretThinking, "SIG-123", "TOOLARGS", "AAAABASE64", "TOOLIMGBYTES"]) {
			expect(payload).not.toContain(leaked);
		}
		expect(payload).toContain("visible answer");
		expect(payload).toContain("see screenshot");
	});

	test("combined evidence stays within budget, newest first, with item clips", () => {
		const branch: SessionEntry[] = [];
		for (let i = 1; i <= 15; i++) branch.push(text(`msg${i} ${"z".repeat(5000)} end${i}`));
		const s = snapshotOf(branch, anthropic, 15);
		const total = s.recent.reduce((n, r) => n + r.text.length, 0);
		expect(total).toBeLessThanOrEqual(RECENT_TOTAL_CHARS);
		expect(s.recent.every(r => r.text.length <= RECENT_ITEM_CHARS)).toBe(true);
		expect(s.recent.every(r => r.text.includes("[middle omitted]"))).toBe(true);
		expect(s.recent).toHaveLength(Math.floor(RECENT_TOTAL_CHARS / RECENT_ITEM_CHARS));
		expect(s.recent.at(-1)?.text.endsWith("end15")).toBe(true);
		expect(s.recent[0].text.startsWith("msg6 ")).toBe(true);
	});

	test("boundRecent is idempotent on bounded input and re-bounds oversized input", () => {
		const bounded = snapshotOf([text("a".repeat(5000)), text("b".repeat(5000))], anthropic).recent;
		expect(boundRecent(bounded)).toEqual(bounded);
		const raw = Array.from({ length: 30 }, (_, i) => ({ role: "assistant", text: `${i} ${"q".repeat(3000)}` }));
		const out = boundRecent(raw);
		expect(out.reduce((n, r) => n + r.text.length, 0)).toBeLessThanOrEqual(RECENT_TOTAL_CHARS);
		expect(out.at(-1)?.text.startsWith("29 ")).toBe(true);
	});

	test("evidence comes from the caller's branch snapshot, not a second session walk", () => {
		const ctx = {
			model: anthropic,
			sessionManager: {
				getBranch: () => {
					throw new Error("getBranch must not run when a branch is supplied");
				},
			},
			getContextUsage: () => undefined,
		} as unknown as Ctx;
		const s = buildSnapshot(ctx, "p", "m", undefined, 6, undefined, [user("shared root"), text("active reply")]);
		expect(texts(s)).toEqual(["shared root", "active reply"]);
	});
});

describe("compaction boundaries", () => {
	test("a portable summary survives, retained messages start at firstKeptEntryId, compacted ones stay out", () => {
		const branch = [
			user("compacted goal"),
			text("compacted answer"),
			user("kept question", "kept"),
			text("kept answer"),
			compaction({ summary: "Summary: migrating billing.", firstKeptEntryId: "kept" }),
			user("after compaction"),
		];
		const s = snapshotOf(branch, anthropic);
		expect(s.summary).toBe("Summary: migrating billing.");
		expect(texts(s)).toEqual(["kept question", "kept answer", "after compaction"]);
		expect(s.compactedEvidenceUnavailable).toBe(false);
		expect(stateOf(s).conversation_summary).toBe("Summary: migrating billing.");
	});

	test("the summary is not duplicated in recent evidence and is clipped to its budget", () => {
		const summary = `Goal ${"s".repeat(9000)} end-of-summary`;
		const branch = [user(summary, "kept"), compaction({ summary, firstKeptEntryId: "kept" }), text("later")];
		const s = snapshotOf(branch, anthropic);
		expect(texts(s)).toEqual(["later"]);
		expect(s.summary?.length).toBeLessThanOrEqual(SUMMARY_CHARS);
		expect(s.summary?.endsWith("end-of-summary")).toBe(true);
	});

	test("an unlocatable retained boundary restricts evidence to entries after the marker and flags it", () => {
		const branch = [user("old"), compaction({ summary: "Sum.", firstKeptEntryId: "missing" }), user("new")];
		const s = snapshotOf(branch, anthropic);
		expect(texts(s)).toEqual(["new"]);
		expect(s.summary).toBe("Sum.");
		expect(s.compactedEvidenceUnavailable).toBe(true);
	});

	test("a native placeholder is flagged unavailable, never offered as a summary", () => {
		const branch = [
			user("early", "early"),
			user("replayed tail", "tail"),
			compaction({
				summary: "Remote compaction preserved provider-native history for this session.",
				providerReplayThroughEntryId: "early",
				preserveData: nativeRemote,
			}),
			user("after"),
		];
		const s = snapshotOf(branch, openai);
		expect(s.summary).toBeUndefined();
		expect(s.compactedEvidenceUnavailable).toBe(true);
		expect(texts(s)).toEqual(["replayed tail", "after"]);
		expect(stateOf(s).conversation_summary).toBeNull();
		expect(stateOf(s).compacted_evidence_unavailable).toBe(true);
	});

	test("native compaction without a replay boundary selects only entries after the marker", () => {
		const branch = [user("early"), compaction({ summary: "placeholder", preserveData: nativeRemote }), user("after")];
		const s = snapshotOf(branch, openai);
		expect(texts(s)).toEqual(["after"]);
		expect(s.compactedEvidenceUnavailable).toBe(true);
	});

	test("a native compaction the current model cannot read leaves history live and unflagged", () => {
		const branch = [user("early"), compaction({ summary: "placeholder", preserveData: nativeRemote }), user("after")];
		const s = snapshotOf(branch, anthropic);
		expect(texts(s)).toEqual(["early", "after"]);
		expect(s.summary).toBeUndefined();
		expect(s.compactedEvidenceUnavailable).toBe(false);
	});

	test("a reset boundary after the compaction hides everything before it; one before is superseded", () => {
		const afterReset = [
			user("kept", "kept"),
			compaction({ summary: "Old summary", firstKeptEntryId: "kept" }),
			user("pre-reset"),
			reset(),
			user("post-reset"),
		];
		const a = snapshotOf(afterReset, anthropic);
		expect(texts(a)).toEqual(["post-reset"]);
		expect(a.summary).toBeUndefined();
		expect(a.compactedEvidenceUnavailable).toBe(false);

		const beforeCompaction = [
			user("pre-reset"),
			reset(),
			user("kept", "kept"),
			compaction({ summary: "Fresh summary", firstKeptEntryId: "kept" }),
			user("tail"),
		];
		const b = snapshotOf(beforeCompaction, anthropic);
		expect(texts(b)).toEqual(["kept", "tail"]);
		expect(b.summary).toBe("Fresh summary");
	});

	test("historyMessages 0 yields no recent items even past a compaction", () => {
		const branch = [user("kept", "kept"), compaction({ summary: "S", firstKeptEntryId: "kept" }), user("after")];
		expect(snapshotOf(branch, anthropic, 0).recent).toEqual([]);
	});

	test("the snapshot carries live context usage and the pinned route untouched", () => {
		const ctx = { model: anthropic, sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined } as unknown as Ctx;
		const s = buildSnapshot(ctx, "p", "m", "plan", 6);
		expect(s).toMatchObject({ contextTokens: undefined, pinnedRoute: "plan", attachmentCount: 0, recent: [] });
		expect(snapshotOf([], anthropic).contextTokens).toBe(42);
	});
});

test("a retained boundary before clear cannot resurrect discarded messages", () => {
	const branch = [user("discarded", "old"), reset(), user("after clear"),
		compaction({ summary: "current summary", firstKeptEntryId: "old" }), user("latest")];
	const s = snapshotOf(branch, anthropic);
	expect(texts(s)).toEqual(["latest"]);
	expect(s.compactedEvidenceUnavailable).toBe(true);
});

test("remote compaction with a portable text summary preserves its retained tail", () => {
	const branch = [user("early"), user("retained", "tail"),
		compaction({ method: "remote", summary: "Investigate the timeout; implementation is not approved.", firstKeptEntryId: "tail" }),
		user("latest")];
	const s = snapshotOf(branch, anthropic);
	expect(s.summary).toBe("Investigate the timeout; implementation is not approved.");
	expect(s.compactedEvidenceUnavailable).toBe(false);
	expect(texts(s)).toEqual(["retained", "latest"]);
});
