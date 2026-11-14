import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	assessTargetContext,
	type ContextAssessment,
	type ContextAssessmentInput,
	PENDING_IMAGE_BUDGET_TOKENS,
} from "../src/context-budget";

const model = (provider: string, api: string, o: Partial<Model> = {}): Model =>
	({
		id: `${provider}-model`,
		provider,
		api,
		input: ["text", "image"],
		contextWindow: 200_000,
		...o,
	}) as unknown as Model;

const openai = model("openai", "openai-responses");
const anthropic = model("anthropic", "anthropic-messages");

let seq = 0;
const base = () => ({ id: `e${++seq}`, parentId: null, timestamp: "2026-11-13T00:00:00.000Z" });
const entry = (e: Record<string, unknown>) => ({ ...base(), ...e }) as unknown as SessionEntry;

const msg = (text = "history") =>
	entry({ type: "message", message: { role: "user", content: text, timestamp: 0 } });
const reset = () => entry({ type: "reset_boundary" });

/** Host-valid OpenAI native compaction payload (`openaiRemoteCompaction` v2 preserve slot). */
const nativePreserve = (provider = "openai") => ({
	openaiRemoteCompaction: { version: "v2", provider, replacementHistory: [], usedTokens: 0 },
});

const compaction = (tokensBefore: unknown, native = false) =>
	entry({
		type: "compaction",
		summary: "summary",
		firstKeptEntryId: "none",
		tokensBefore,
		...(native ? { preserveData: nativePreserve() } : {}),
	});

const assess = (o: Partial<ContextAssessmentInput> = {}): ContextAssessment =>
	assessTargetContext({
		branch: [],
		current: openai,
		target: openai,
		liveTokens: 1000,
		prompt: "",
		imageCount: 0,
		fraction: 0.8,
		...o,
	});

const known = (a: ContextAssessment) => {
	if (a.kind === "unknown") throw new Error(`unexpected unknown: ${a.reason}`);
	return a;
};

describe("assessTargetContext arithmetic", () => {
	test("same model, no compaction: live floor plus pending text", () => {
		const a = known(assess({ liveTokens: 1000, prompt: "abc" }));
		expect(a).toMatchObject({
			kind: "estimated-fit",
			liveTokens: 1000,
			pendingTextBudgetTokens: 3,
			pendingImageBudgetTokens: 0,
			compactionAllowanceTokens: 0,
			skippedCompactions: 0,
			estimatedInputTokens: 1003,
			inputLimit: 160_000,
		});
	});

	test("pending text counts UTF-8 bytes, not characters", () => {
		const prompt = "héllo✓"; // 1 + 2 + 1 + 1 + 1 + 3
		expect(known(assess({ prompt })).pendingTextBudgetTokens).toBe(9);
	});

	test("tail: 80k before-compaction, 20k after, 50k later tail is not assessed as 80k", () => {
		const branch = [msg(), compaction(80_000, true), msg()];
		const a = known(assess({ branch, target: anthropic, liveTokens: 70_000, prompt: "abc" }));
		expect(a.compactionAllowanceTokens).toBe(80_000);
		expect(a.skippedCompactions).toBe(1);
		expect(a.estimatedInputTokens).toBe(70_000 + 80_000 + 3);
		expect(a.estimatedInputTokens).not.toBe(80_000);
	});

	test("multiple skipped compactions add after the target's portable boundary, not max", () => {
		const branch = [
			msg(),
			compaction(10_000), // portable: target boundary, not skipped
			msg(),
			compaction(30_000, true),
			msg(),
			compaction(60_000, true), // current boundary, skipped
			msg(),
		];
		const a = known(assess({ branch, target: anthropic, liveTokens: 5_000 }));
		expect(a.skippedCompactions).toBe(2);
		expect(a.compactionAllowanceTokens).toBe(90_000);
		expect(a.estimatedInputTokens).toBe(95_000);
	});

	test("target with no readable compaction skips every compaction through current", () => {
		const branch = [compaction(1_000, true), msg(), compaction(2_000, true)];
		const a = known(assess({ branch, target: anthropic }));
		expect(a.skippedCompactions).toBe(2);
		expect(a.compactionAllowanceTokens).toBe(3_000);
	});

	test("equal boundaries add no expansion", () => {
		const branch = [compaction(50_000, true), msg(), compaction(70_000)];
		// both models read the newest (portable) compaction
		const a = known(assess({ branch, target: anthropic, liveTokens: 4_000 }));
		expect(a.skippedCompactions).toBe(0);
		expect(a.compactionAllowanceTokens).toBe(0);
		expect(a.estimatedInputTokens).toBe(4_000);
	});

	test("same model never expands", () => {
		const branch = [compaction(50_000, true), msg()];
		expect(known(assess({ branch })).skippedCompactions).toBe(0);
	});

	test("newer target boundary keeps the live floor without allowance", () => {
		const branch = [compaction(10_000), msg(), compaction(90_000, true), msg()];
		// anthropic reads only the portable compaction; openai reads the newer native one
		const a = known(assess({ branch, current: anthropic, target: openai, liveTokens: 12_000, prompt: "xy" }));
		expect(a.skippedCompactions).toBe(0);
		expect(a.compactionAllowanceTokens).toBe(0);
		expect(a.estimatedInputTokens).toBe(12_002);
	});

	test("only entries after the latest reset participate", () => {
		const branch = [compaction(Number.NaN, true), msg(), reset(), msg(), compaction(20_000, true), msg()];
		const a = known(assess({ branch, target: anthropic, liveTokens: 1_000 }));
		expect(a.skippedCompactions).toBe(1);
		expect(a.compactionAllowanceTokens).toBe(20_000);
	});

	test("a compaction before the reset adds nothing and its bad metadata is ignored", () => {
		const branch = [compaction("bad", true), reset(), msg()];
		const a = known(assess({ branch, target: anthropic }));
		expect(a.skippedCompactions).toBe(0);
		expect(a.estimatedInputTokens).toBe(1_000);
	});

	test("invalid tokensBefore outside the skipped range is ignored", () => {
		const branch = [compaction(Number.NaN), msg(), compaction(5_000, true)];
		const a = known(assess({ branch, target: anthropic }));
		expect(a.compactionAllowanceTokens).toBe(5_000);
	});

	test("opaque native payload contents alone do not make the estimate unknown", () => {
		const opaque = entry({
			type: "compaction",
			summary: "",
			firstKeptEntryId: "none",
			tokensBefore: 10,
			preserveData: {
				openaiRemoteCompaction: {
					version: "v2",
					provider: "openai",
					replacementHistory: [{ type: "compaction", encrypted_content: "\u0000not-decodable" }],
					usedTokens: 0,
				},
			},
		});
		expect(known(assess({ branch: [opaque], target: anthropic })).compactionAllowanceTokens).toBe(10);
		expect(known(assess({ branch: [opaque] })).kind).toBe("estimated-fit");
	});
});

describe("assessTargetContext limit", () => {
	test("exactly at the limit fits; one token over blocks", () => {
		const t = model("openai", "openai-responses", { contextWindow: 10_000 });
		expect(known(assess({ target: t, liveTokens: 7_992, prompt: "12345678" }))).toMatchObject({
			kind: "estimated-fit",
			estimatedInputTokens: 8_000,
			inputLimit: 8_000,
		});
		const over = known(assess({ target: t, liveTokens: 7_993, prompt: "12345678" }));
		expect(over.kind).toBe("blocked");
		expect(over.reason).toContain("8001");
	});

	test("inputLimit floors window * fraction", () => {
		const t = model("openai", "openai-responses", { contextWindow: 1_001 });
		expect(known(assess({ target: t, fraction: 0.5 })).inputLimit).toBe(500);
	});

	test("expansion can block an otherwise fitting switch", () => {
		const branch = [compaction(150_000, true), msg()];
		const a = known(assess({ branch, target: anthropic, liveTokens: 20_000 }));
		expect(a.kind).toBe("blocked");
		expect(a.estimatedInputTokens).toBe(170_000);
	});
});

describe("assessTargetContext pending images", () => {
	test("normal image-bearing first prompt is allowed with a fixed allowance", () => {
		const a = known(assess({ liveTokens: 0, prompt: "describe this", imageCount: 1 }));
		expect(a.kind).toBe("estimated-fit");
		expect(a.pendingImageBudgetTokens).toBe(PENDING_IMAGE_BUDGET_TOKENS);
		expect(PENDING_IMAGE_BUDGET_TOKENS).toBe(8192);
		expect(a.estimatedInputTokens).toBe("describe this".length + 8192);
	});

	test("allowance scales per image", () => {
		const a = known(assess({ liveTokens: 0, imageCount: 3 }));
		expect(a.pendingImageBudgetTokens).toBe(3 * 8192);
		expect(a.estimatedInputTokens).toBe(3 * 8192);
	});

	test("image prompt near the limit is blocked", () => {
		const t = model("openai", "openai-responses", { contextWindow: 10_000 }); // limit 8_000
		const a = known(assess({ target: t, liveTokens: 0, imageCount: 1 }));
		expect(a.kind).toBe("blocked");
		expect(a.estimatedInputTokens).toBe(8_192);
		expect(a.inputLimit).toBe(8_000);
	});

	test("image prompt with live usage close to the limit is blocked", () => {
		const a = known(assess({ liveTokens: 155_000, imageCount: 1 }));
		expect(a.kind).toBe("blocked");
	});

	test("text-only target blocks pending images, with room to spare", () => {
		const textOnly = model("openai", "openai-responses", { input: ["text"] });
		const a = known(assess({ target: textOnly, imageCount: 1 }));
		expect(a.kind).toBe("blocked");
		expect(a.reason).toContain("image");
	});

	test("text-only target is fine when there are no pending images", () => {
		const textOnly = model("openai", "openai-responses", { input: ["text"] });
		expect(known(assess({ target: textOnly, imageCount: 0 })).kind).toBe("estimated-fit");
	});

	test("images in history are not pending and are not counted", () => {
		const withImage = entry({
			type: "message",
			message: { role: "user", content: [{ type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" }] },
		});
		const a = known(assess({ branch: [withImage], liveTokens: 500 }));
		expect(a.pendingImageBudgetTokens).toBe(0);
		expect(a.estimatedInputTokens).toBe(500);
	});
});

describe("assessTargetContext unknown metadata", () => {
	test("missing or invalid live usage", () => {
		expect(assess({ liveTokens: undefined }).kind).toBe("unknown");
		expect(assess({ liveTokens: Number.NaN }).kind).toBe("unknown");
		expect(assess({ liveTokens: -1 }).kind).toBe("unknown");
	});

	test("missing or invalid target window", () => {
		expect(assess({ target: model("openai", "openai-responses", { contextWindow: null }) }).kind).toBe("unknown");
		expect(assess({ target: model("openai", "openai-responses", { contextWindow: 0 }) }).kind).toBe("unknown");
		expect(
			assess({ target: model("openai", "openai-responses", { contextWindow: Number.NaN }) }).kind,
		).toBe("unknown");
	});

	test("invalid fraction or image count", () => {
		expect(assess({ fraction: 0 }).kind).toBe("unknown");
		expect(assess({ fraction: Number.NaN }).kind).toBe("unknown");
		expect(assess({ imageCount: -1 }).kind).toBe("unknown");
		expect(assess({ imageCount: 1.5 }).kind).toBe("unknown");
	});

	test("invalid tokensBefore on a skipped compaction is unknown, never zero", () => {
		for (const bad of [undefined, "5", Number.NaN, -3, Number.POSITIVE_INFINITY]) {
			const a = assess({ branch: [compaction(bad, true), msg()], target: anthropic });
			expect(a.kind).toBe("unknown");
		}
	});

	test("one invalid entry among several skipped compactions is unknown", () => {
		const branch = [compaction(1_000, true), compaction(undefined, true)];
		expect(assess({ branch, target: anthropic }).kind).toBe("unknown");
	});
});
