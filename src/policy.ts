import { type Classification, type SwitchboardConfig, type Tier, tierRank } from "./types";

export interface PolicyInput {
	cls: Classification | undefined;
	/** Tier pinned for the running task, if any. */
	pinnedTier: Tier | undefined;
	/** `provider/id` of the live model. */
	currentModel: string;
	/** Resolved `provider/id` per tier; undefined when the tier's model cannot be resolved. */
	tierModels: Record<Tier, string | undefined>;
	contextTokens: number | undefined;
	config: SwitchboardConfig["routing"];
}

export interface Verdict {
	/** Tier to pin afterwards (unchanged pin when the request was not acted on). */
	pinnedTier: Tier | undefined;
	/** Tier the router wants, if any. */
	desiredTier: Tier | undefined;
	switchModel: boolean;
	taskStart: boolean;
	reason: string;
}

export function decide(i: PolicyInput): Verdict {
	const keep = (reason: string, taskStart = false): Verdict => ({
		pinnedTier: i.pinnedTier,
		desiredTier: undefined,
		switchModel: false,
		taskStart,
		reason,
	});
	const { cls, config } = i;
	if (!cls) return keep("decision engine unavailable; keeping current model");

	const taskStart =
		i.pinnedTier === undefined ||
		!config.sticky ||
		(cls.newTask && cls.newTaskConfidence >= config.minConfidence);

	let desired: Tier;
	let why: string;
	if (taskStart) {
		if (cls.tierConfidence < config.minConfidence) {
			return keep(`low confidence (${cls.tierConfidence.toFixed(2)}) for ${cls.tier}; keeping current model`, true);
		}
		desired = cls.tier;
		why = `new task classified ${cls.tier}`;
	} else if (
		config.allowEscalation &&
		tierRank(cls.tier) > tierRank(i.pinnedTier!) &&
		cls.tierConfidence >= config.minConfidence
	) {
		desired = cls.tier;
		why = `follow-up escalated ${i.pinnedTier} -> ${cls.tier}`;
	} else {
		return keep(`follow-up; task stays pinned to ${i.pinnedTier}`);
	}

	const target = i.tierModels[desired];
	if (!target) {
		return { ...keep(`no resolvable model for tier ${desired}; keeping current model`, taskStart) };
	}

	const sameModel = target === i.currentModel;
	const isUpgrade = i.pinnedTier !== undefined && tierRank(desired) > tierRank(i.pinnedTier);
	if (
		!sameModel &&
		config.cacheAware &&
		(i.contextTokens ?? 0) > config.cacheGuardTokens &&
		desired !== "deep" &&
		!isUpgrade
	) {
		return keep(
			`cache guard: ${i.contextTokens} context tokens > ${config.cacheGuardTokens}; not switching to ${target} for ${desired}`,
			taskStart,
		);
	}

	return {
		pinnedTier: desired,
		desiredTier: desired,
		switchModel: !sameModel,
		taskStart,
		reason: sameModel ? `${why}; already on ${target}` : `${why}; switching to ${target}`,
	};
}
