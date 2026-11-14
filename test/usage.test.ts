import { describe, expect, test } from "bun:test";
import { summarizeExecutionUsage } from "../src/usage";

const assistant = (
	usage: Record<string, unknown> | undefined,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ role: "assistant", content: [], stopReason: "stop", ...extra, ...(usage ? { usage } : {}) });

const usage = (
	tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
	total: unknown,
): Record<string, unknown> => ({
	input: tokens.input,
	output: tokens.output,
	cacheRead: tokens.cacheRead ?? 0,
	cacheWrite: tokens.cacheWrite ?? 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

describe("summarizeExecutionUsage", () => {
	test("sums a successful multi-call run", () => {
		const s = summarizeExecutionUsage([
			{ role: "user", content: "go" },
			assistant(usage({ input: 100, output: 20 }, 0.25)),
			{ role: "toolResult", content: [] },
			assistant(usage({ input: 150, output: 30 }, 0.5)),
		]);
		expect(s.assistantCalls).toBe(2);
		expect(s.pricedCalls).toBe(2);
		expect(s.knownExecutionCostUsd).toBeCloseTo(0.75, 10);
		expect(s.executionCostUsd).toBeCloseTo(0.75, 10);
		expect(s.inputTokens).toBe(250);
		expect(s.outputTokens).toBe(50);
		expect(s.usageComplete).toBe(true);
	});

	test("sums cache read and write tokens and trusts the reported total that includes them", () => {
		const s = summarizeExecutionUsage([
			assistant({
				input: 10,
				output: 5,
				cacheRead: 4000,
				cacheWrite: 300,
				totalTokens: 4315,
				cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
			}),
			assistant(usage({ input: 1, output: 1, cacheRead: 500, cacheWrite: 0 }, 0.002)),
		]);
		expect(s.cacheReadTokens).toBe(4500);
		expect(s.cacheWriteTokens).toBe(300);
		expect(s.inputTokens).toBe(11);
		expect(s.outputTokens).toBe(6);
		expect(s.executionCostUsd).toBeCloseTo(0.012, 10);
		expect(s.usageComplete).toBe(true);
	});

	test("counts priced errored and aborted assistant calls", () => {
		const s = summarizeExecutionUsage([
			assistant(usage({ input: 50, output: 0 }, 0.04), { stopReason: "error", errorMessage: "overloaded" }),
			assistant(usage({ input: 70, output: 12 }, 0.06), { stopReason: "aborted" }),
			assistant(usage({ input: 80, output: 40 }, 0.1)),
		]);
		expect(s.assistantCalls).toBe(3);
		expect(s.pricedCalls).toBe(3);
		expect(s.executionCostUsd).toBeCloseTo(0.2, 10);
		expect(s.inputTokens).toBe(200);
		expect(s.outputTokens).toBe(52);
		expect(s.usageComplete).toBe(true);
	});

	test("a call without reported cost makes the total partial and unknown", () => {
		const s = summarizeExecutionUsage([
			assistant(usage({ input: 100, output: 10 }, 0.3)),
			assistant({ input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220 }),
		]);
		expect(s.assistantCalls).toBe(2);
		expect(s.pricedCalls).toBe(1);
		expect(s.knownExecutionCostUsd).toBeCloseTo(0.3, 10);
		expect(s.executionCostUsd).toBeUndefined();
		expect("executionCostUsd" in s).toBe(false);
		expect(s.inputTokens).toBe(300);
		expect(s.usageComplete).toBe(false);
	});

	test("all calls unpriced leaves a zero known cost but no full cost", () => {
		const s = summarizeExecutionUsage([assistant({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 })]);
		expect(s.pricedCalls).toBe(0);
		expect(s.knownExecutionCostUsd).toBe(0);
		expect(s.executionCostUsd).toBeUndefined();
		expect(s.usageComplete).toBe(false);
	});

	test("a missing usage object is an unpriced incomplete call", () => {
		const s = summarizeExecutionUsage([assistant(undefined), assistant(usage({ input: 1, output: 2 }, 0.01))]);
		expect(s.assistantCalls).toBe(2);
		expect(s.pricedCalls).toBe(1);
		expect(s.executionCostUsd).toBeUndefined();
		expect(s.inputTokens).toBe(1);
		expect(s.usageComplete).toBe(false);
	});

	test.each([
		["negative", -0.01],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["string", "0.5"],
		["null", null],
	])("invalid %s cost is unpriced", (_name, bad) => {
		const s = summarizeExecutionUsage([
			assistant(usage({ input: 10, output: 10 }, 0.2)),
			assistant(usage({ input: 10, output: 10 }, bad)),
		]);
		expect(s.pricedCalls).toBe(1);
		expect(s.knownExecutionCostUsd).toBeCloseTo(0.2, 10);
		expect(s.executionCostUsd).toBeUndefined();
		expect(s.inputTokens).toBe(20);
		expect(s.usageComplete).toBe(false);
	});

	test("missing or invalid token counts are skipped and mark usage incomplete", () => {
		const s = summarizeExecutionUsage([
			assistant({ output: 7, cacheRead: 3, cacheWrite: -1, cost: { total: 0.1 } }),
			assistant({ input: Number.NaN, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: 0.1 } }),
			assistant(usage({ input: 4, output: 4, cacheRead: 2, cacheWrite: 2 }, 0.1)),
		]);
		expect(s.pricedCalls).toBe(3);
		expect(s.executionCostUsd).toBeCloseTo(0.3, 10);
		expect(s.inputTokens).toBe(4);
		expect(s.outputTokens).toBe(12);
		expect(s.cacheReadTokens).toBe(6);
		expect(s.cacheWriteTokens).toBe(3);
		expect(s.usageComplete).toBe(false);
	});

	test("zero assistant calls is exactly zero cost", () => {
		expect(summarizeExecutionUsage([])).toEqual({
			assistantCalls: 0,
			pricedCalls: 0,
			knownExecutionCostUsd: 0,
			executionCostUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			usageComplete: true,
		});
	});

	test("ignores non-assistant and malformed messages", () => {
		const s = summarizeExecutionUsage([
			{ role: "user", content: "hi", usage: usage({ input: 999, output: 999 }, 9) },
			{ role: "toolResult", content: [] },
			null,
			undefined,
			"assistant",
			42,
			[],
			{ role: "assistant-ish" },
		]);
		expect(s.assistantCalls).toBe(0);
		expect(s.executionCostUsd).toBe(0);
		expect(s.inputTokens).toBe(0);
		expect(s.usageComplete).toBe(true);
	});

	test("reported zero cost is priced, not unknown", () => {
		const s = summarizeExecutionUsage([assistant(usage({ input: 1, output: 1 }, 0))]);
		expect(s.pricedCalls).toBe(1);
		expect(s.executionCostUsd).toBe(0);
		expect(s.usageComplete).toBe(true);
	});
});

test("unknown model pricing cannot turn a normalized zero into a free inference claim", () => {
	const result = summarizeExecutionUsage([
		assistant(usage({ input: 100, output: 10 }, 0), { provider: "custom", model: "unpriced" }),
	], () => false);
	expect(result.pricedCalls).toBe(0);
	expect(result.executionCostUsd).toBeUndefined();
	expect(result.usageComplete).toBe(false);
});
