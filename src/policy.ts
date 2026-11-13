import type { Classification, SwitchboardConfig } from "./types";

export interface PolicyRoute {
	name: string;
	rank: number;
	/** The route names a model (as opposed to "keep the current model"). */
	hasModel: boolean;
	/** Resolved `provider/id`; undefined when the route names no model or the model cannot be resolved. */
	target: string | undefined;
}

export interface PolicyInput {
	cls: Classification | undefined;
	/** Route pinned for the running task, if any. */
	pinnedRoute: string | undefined;
	/** `provider/id` of the live model. */
	currentModel: string;
	routes: PolicyRoute[];
	contextTokens: number | undefined;
	config: SwitchboardConfig["routing"];
}

export interface Verdict {
	/** Route to pin afterwards (unchanged when the request was not acted on). */
	pinnedRoute: string | undefined;
	/** Route the router wants, if any. */
	desiredRoute: string | undefined;
	switchModel: boolean;
	taskStart: boolean;
	reason: string;
}

export function decide(i: PolicyInput): Verdict {
	const keep = (reason: string, taskStart = false): Verdict => ({
		pinnedRoute: i.pinnedRoute,
		desiredRoute: undefined,
		switchModel: false,
		taskStart,
		reason,
	});
	const { cls, config } = i;
	if (!cls) return keep("classifier unavailable; keeping current model");

	const byName = new Map(i.routes.map(r => [r.name, r]));
	const wanted = byName.get(cls.route);
	if (!wanted) return keep(`unknown route "${cls.route}"; keeping current model`);
	const pinned = i.pinnedRoute === undefined ? undefined : byName.get(i.pinnedRoute);

	const taskStart =
		pinned === undefined || !config.sticky || (cls.newTask && cls.newTaskConfidence >= config.minConfidence);

	let desired = wanted;
	let why: string;
	if (taskStart) {
		if (cls.routeConfidence < config.minConfidence) {
			return keep(`low confidence (${cls.routeConfidence.toFixed(2)}) for ${cls.route}; keeping current model`, true);
		}
		why = `new task routed to ${desired.name}`;
	} else if (
		pinned &&
		config.allowEscalation &&
		wanted.rank > pinned.rank &&
		cls.routeConfidence >= config.minConfidence
	) {
		why = `follow-up escalated ${pinned.name} -> ${desired.name}`;
	} else {
		return keep(`follow-up; task stays on ${i.pinnedRoute}`);
	}

	if (desired.hasModel && !desired.target) {
		return keep(`route ${desired.name}: model cannot be resolved; keeping current model`, taskStart);
	}

	const sameModel = desired.target === undefined || desired.target === i.currentModel;
	const isUpgrade = pinned !== undefined && desired.rank > pinned.rank;
	const maxRank = Math.max(...i.routes.map(r => r.rank));
	if (
		!sameModel &&
		config.cacheAware &&
		(i.contextTokens ?? 0) > config.cacheGuardTokens &&
		!isUpgrade &&
		!(pinned === undefined && desired.rank >= maxRank)
	) {
		return keep(
			`cache guard: ${i.contextTokens} context tokens > ${config.cacheGuardTokens}; not switching to ${desired.target} for ${desired.name}`,
			taskStart,
		);
	}

	return {
		pinnedRoute: desired.name,
		desiredRoute: desired.name,
		switchModel: !sameModel,
		taskStart,
		reason: sameModel ? `${why}; staying on ${i.currentModel}` : `${why}; switching to ${desired.target}`,
	};
}
