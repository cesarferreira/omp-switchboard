import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { getReadableCompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-context";

/**
 * Fixed allowance per incoming image. A conservative heuristic, NOT a universal
 * bound: provider image costs vary by model, resolution, and detail setting, and
 * encoded size (e.g. base64 length) is deliberately not used as a limit.
 */
export const PENDING_IMAGE_BUDGET_TOKENS = 8192;

export type ContextAssessment =
	| {
			kind: "estimated-fit" | "blocked";
			liveTokens: number;
			pendingTextBudgetTokens: number;
			pendingImageBudgetTokens: number;
			compactionAllowanceTokens: number;
			skippedCompactions: number;
			estimatedInputTokens: number;
			inputLimit: number;
			reason: string;
	  }
	| { kind: "unknown"; reason: string };

export interface ContextAssessmentInput {
	branch: readonly SessionEntry[];
	current: Model;
	target: Model;
	/** Host live usage (`ctx.getContextUsage()?.tokens`); undefined when unavailable. */
	liveTokens: number | undefined;
	prompt: string;
	/** Images in the unsubmitted request only; images already in live usage are not pending. */
	imageCount: number;
	fraction: number;
}

const unknown = (reason: string): ContextAssessment => ({ kind: "unknown", reason });

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Metadata-only admission estimate for switching to `target`.
 *
 * Reads live usage, the incoming prompt's UTF-8 byte length, a fixed per-image
 * allowance, and compaction metadata (`tokensBefore`, boundary ids). It never
 * reads historical message bodies, tool schemas, or native replay payloads, and
 * it is a conservative admission heuristic, not an exact target-token bound.
 * Work is O(branch entries + prompt bytes).
 */
export function assessTargetContext(input: ContextAssessmentInput): ContextAssessment {
	const { current, target, liveTokens, prompt, imageCount, fraction } = input;

	if (!isCount(liveTokens)) return unknown("live context usage is unavailable");
	const window = target.contextWindow;
	if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
		return unknown("target context window is unavailable");
	}
	if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction <= 0) {
		return unknown("context window fraction is invalid");
	}
	if (!Number.isInteger(imageCount) || imageCount < 0) return unknown("pending image count is invalid");

	// Only the segment after the latest reset participates in the active context.
	let start = 0;
	for (let i = input.branch.length - 1; i >= 0; i--) {
		if (input.branch[i].type === "reset_boundary") {
			start = i + 1;
			break;
		}
	}
	const branch = start === 0 ? input.branch : input.branch.slice(start);

	const compactions: Extract<SessionEntry, { type: "compaction" }>[] = [];
	for (const entry of branch) if (entry.type === "compaction") compactions.push(entry);

	// Compaction entries after the target's readable boundary through the current's.
	// A target boundary that equals or follows the current one adds no expansion.
	const currentBoundary = getReadableCompactionEntry(branch, current);
	const targetBoundary = getReadableCompactionEntry(branch, target);
	const currentPos = currentBoundary ? compactions.findIndex(c => c.id === currentBoundary.id) : -1;
	const targetPos = targetBoundary ? compactions.findIndex(c => c.id === targetBoundary.id) : -1;

	let compactionAllowanceTokens = 0;
	let skippedCompactions = 0;
	for (let i = targetPos + 1; i <= currentPos; i++) {
		const tokensBefore: unknown = compactions[i].tokensBefore;
		if (!isCount(tokensBefore)) return unknown("a skipped compaction has no valid tokensBefore");
		compactionAllowanceTokens += tokensBefore;
		skippedCompactions++;
	}

	const pendingTextBudgetTokens = Buffer.byteLength(prompt, "utf8");
	const pendingImageBudgetTokens = imageCount * PENDING_IMAGE_BUDGET_TOKENS;
	const estimatedInputTokens =
		liveTokens + compactionAllowanceTokens + pendingTextBudgetTokens + pendingImageBudgetTokens;
	const inputLimit = Math.floor(window * fraction);

	let kind: "estimated-fit" | "blocked";
	let reason: string;
	if (imageCount > 0 && !(Array.isArray(target.input) && target.input.includes("image"))) {
		kind = "blocked";
		reason = "target model does not accept image input";
	} else if (estimatedInputTokens > inputLimit) {
		kind = "blocked";
		reason = `estimated input ${estimatedInputTokens} tokens exceeds target limit ${inputLimit}`;
	} else {
		kind = "estimated-fit";
		reason = `estimated input ${estimatedInputTokens} tokens is within target limit ${inputLimit}`;
	}

	return {
		kind,
		liveTokens,
		pendingTextBudgetTokens,
		pendingImageBudgetTokens,
		compactionAllowanceTokens,
		skippedCompactions,
		estimatedInputTokens,
		inputLimit,
		reason,
	};
}
