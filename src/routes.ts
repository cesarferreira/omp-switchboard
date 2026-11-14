import type { Classification, DecisionEngine, ResolvedRoute, RouteConfig, SwitchboardConfig } from "./types";

export const BUILTIN_ROUTES: Record<string, Required<Pick<RouteConfig, "description" | "rank" | "keywords">> & RouteConfig> = {
	plan: {
		model: "@slow",
		thinking: "high",
		rank: 3,
		description: "Planning and design: architecture, trade-offs, strategy, 'should we', thinking a problem through before coding.",
		keywords: ["plan", "think through", "design", "architecture", "trade-offs", "tradeoffs", "should we", "roadmap", "strategy"],
	},
	implement: {
		model: "@task",
		thinking: "medium",
		rank: 2,
		description: "Building: implement a feature, fix a clear bug, refactor, write tests or code.",
		keywords: ["implement", "build", "add", "create", "write", "refactor", "fix", "make it"],
	},
	"deep-dive": {
		model: "@slow",
		thinking: "high",
		rank: 3,
		description: "Understanding or investigating: explain code, analyze, audit, root-cause unclear failures, read across a large codebase.",
		keywords: ["explain", "understand", "how does", "analyze", "analyse", "deep dive", "extract", "audit", "root cause", "investigate"],
	},
	"quick-edit": {
		model: "@smol",
		thinking: "low",
		rank: 0,
		description: "Trivial or mechanical: rename, move, delete, typo, formatting, tiny tweaks, simple lookups.",
		keywords: ["rename", "move", "delete", "typo", "tweak", "bump", "quick fix", "format", "reformat"],
	},
	default: {
		model: "@default",
		thinking: "medium",
		rank: 1,
		description: "Everything else: ordinary questions and requests that fit no other route.",
		keywords: [],
	},
};

const BUILTIN_ORDER = ["plan", "implement", "deep-dive", "quick-edit"];

/**
 * Effective routes: built-ins, then top-level `routes`, then the active setup's `routes`.
 * Fields override per route; `keywords` replace. Order is config-defined routes first (file order),
 * then the remaining built-ins, with `default` always last.
 */
export function resolveRoutes(config: SwitchboardConfig): ResolvedRoute[] {
	const setup = config.activeSetup ? config.setups[config.activeSetup] : undefined;
	const layers = [config.routes, setup?.routes ?? {}];
	const names: string[] = [];
	for (const layer of layers) {
		for (const n of Object.keys(layer)) if (n !== "default" && !names.includes(n)) names.push(n);
	}
	for (const n of BUILTIN_ORDER) if (!names.includes(n)) names.push(n);
	names.push("default");

	return names.map(name => {
		const base = BUILTIN_ROUTES[name];
		const merged: RouteConfig = { ...base };
		for (const layer of layers) {
			const r = layer[name];
			if (!r) continue;
			for (const k of Object.keys(r) as (keyof RouteConfig)[]) {
				if (r[k] !== undefined) Object.assign(merged, { [k]: r[k] });
			}
		}
		const keywords = merged.keywords ?? [];
		return {
			name,
			model: merged.model || undefined,
			thinking: merged.thinking,
			keywords,
			description: merged.description ?? (keywords.length ? `Requests about: ${keywords.join(", ")}.` : name),
			rank: merged.rank ?? 1,
		};
	});
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, word-boundary, whitespace-tolerant phrase match. */
function phraseRegex(phrase: string): RegExp {
	const body = phrase.trim().split(/\s+/).map(escapeRe).join("\\s+");
	return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * Each matched phrase scores its word count; the highest total wins and ties keep the earliest route.
 * Returns undefined when nothing matches.
 */
export function matchKeywords(prompt: string, routes: ResolvedRoute[]): { route: string; matched: string[] } | undefined {
	let best: { route: string; score: number; matched: string[] } | undefined;
	for (const r of routes) {
		let score = 0;
		const matched: string[] = [];
		for (const kw of r.keywords) {
			if (!kw.trim() || !phraseRegex(kw).test(prompt)) continue;
			score += kw.trim().split(/\s+/).length;
			matched.push(kw);
		}
		if (score > 0 && (!best || score > best.score)) best = { route: r.name, score, matched };
	}
	return best && { route: best.route, matched: best.matched };
}

/**
 * Keywords identify work, not a new goal. With a pin, policy may escalate but
 * requires a decision-model boundary or an explicit reset before downgrading.
 */
export class KeywordEngine implements DecisionEngine {
	readonly label = "keywords";

	async classify(snapshot: { latestRequest: string; pinnedRoute?: string }, routes: ResolvedRoute[]): Promise<Classification> {
		const hit = matchKeywords(snapshot.latestRequest, routes);
		return {
			newTask: false,
			newTaskConfidence: 0,
			route: hit?.route ?? snapshot.pinnedRoute ?? "default",
			routeConfidence: 1,
			matched: hit?.matched,
		};
	}
}
