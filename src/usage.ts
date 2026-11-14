import { isObj } from "./config";
import type { Model } from "@oh-my-pi/pi-ai";

/**
 * Spend and tokens of one run, summed from normalized OMP/SDK assistant usage. Costs may be catalog-derived
 * estimates, not provider invoices; this function does not invent or correct the upstream price card.
 * A missing, negative or non-finite cost is unpriced and contributes nothing to knownExecutionCostUsd.
 * executionCostUsd exists only when every assistant message exposes a valid cost, including reported zero.
 * Completeness describes available fields, not billing accuracy: zero-valued custom prices need verification.
 * With no assistant calls the aggregate is exactly zero.
 *
 * Only the messages handed in are counted. Provider-hidden retries, server-side compaction, and any other
 * charge the provider does not expose on an assistant message cannot be counted.
 */
export interface ExecutionUsage {
	assistantCalls: number;
	/** Assistant calls that reported a valid (finite, nonnegative) `usage.cost.total`. */
	pricedCalls: number;
	/** Sum of valid reported costs only; partial (a lower bound) unless `pricedCalls === assistantCalls`. */
	knownExecutionCostUsd: number;
	/** Present only when every assistant call has a valid reported cost. */
	executionCostUsd?: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** False when any assistant call lacks usage, a valid cost, or any valid token field. */
	usageComplete: boolean;
}

const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A missing/all-zero custom card is unknown, unless the host explicitly marks it free or included. */
export function hasUsablePrices(model: Pick<Model, "cost" | "pricingStatus">): boolean {
	if (model.pricingStatus !== undefined) return model.pricingStatus === "free" || model.pricingStatus === "included";
	return (valid(model.cost.input) && model.cost.input > 0) || (valid(model.cost.output) && model.cost.output > 0)
		|| (valid(model.cost.cacheRead) && model.cost.cacheRead > 0) || (valid(model.cost.cacheWrite) && model.cost.cacheWrite > 0);
}

/**
 * Summarize assistant usage from run-local messages (e.g. the `agent_end` event). Errored and aborted assistant
 * messages count: they carry whatever the provider billed. Non-assistant and malformed entries are ignored.
 */
export function summarizeExecutionUsage(
	messages: readonly unknown[], hasPricing?: (provider: string, model: string) => boolean,
): ExecutionUsage {
	let assistantCalls = 0;
	let pricedCalls = 0;
	let knownExecutionCostUsd = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let usageComplete = true;

	for (const m of messages) {
		if (!isObj(m) || m.role !== "assistant") continue;
		assistantCalls++;
		const usage = m.usage;
		if (!isObj(usage)) {
			usageComplete = false;
			continue;
		}
		const total = isObj(usage.cost) ? usage.cost.total : undefined;
		if (valid(total) && (!hasPricing || (typeof m.provider === "string" && typeof m.model === "string" && hasPricing(m.provider, m.model)))) {
			pricedCalls++;
			knownExecutionCostUsd += total;
		} else {
			usageComplete = false;
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const n = usage[key];
			if (!valid(n)) {
				usageComplete = false;
				continue;
			}
			if (key === "input") inputTokens += n;
			else if (key === "output") outputTokens += n;
			else if (key === "cacheRead") cacheReadTokens += n;
			else cacheWriteTokens += n;
		}
	}

	return {
		assistantCalls,
		pricedCalls,
		knownExecutionCostUsd,
		...(pricedCalls === assistantCalls ? { executionCostUsd: knownExecutionCostUsd } : {}),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		usageComplete,
	};
}
