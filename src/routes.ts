import type { Classification, DecisionEngine, ResolvedRoute, RouteConfig, SwitchboardConfig } from "./types";

export const BUILTIN_ROUTES: Record<string, Required<Pick<RouteConfig, "description" | "rank" | "keywords">> & RouteConfig> = {
	plan: {
		model: "@slow",
		thinking: "high",
		rank: 3,
		description: "Design, architecture, trade-offs and review BEFORE execution. Examples: 'design the migration', 'is this approach sound?', 'how would we implement it?'. Not an instruction to implement an approved plan, a rote edit, or root-causing an unexplained failure.",
		keywords: ["plan", "think through", "design", "architecture", "trade-offs", "tradeoffs", "should we", "roadmap", "strategy"],
	},
	implement: {
		model: "@task",
		thinking: "medium",
		rank: 2,
		description: "Execute code changes, a known bug fix, refactoring or tests. Examples: 'implement the approved plan', 'now add the unit tests', 'apply that fix'. Not merely discussing how implementation might work, asking for design review, or investigating an unknown cause.",
		keywords: ["implement", "build", "add", "create", "write", "refactor", "fix", "make it"],
	},
	"deep-dive": {
		model: "@slow",
		thinking: "high",
		rank: 3,
		description: "Investigate or explain an unclear problem across code/evidence. Examples: 'why are these tests flaky?', 'find the cause of this crash', 'explain how this subsystem works'. Not a known fix ready to apply or a mechanical rename.",
		keywords: ["explain", "understand", "how does", "analyze", "analyse", "deep dive", "extract", "audit", "root cause", "investigate"],
	},
	"quick-edit": {
		model: "@smol",
		thinking: "low",
		rank: 0,
		description: "Bounded mechanical work: rename, typo, formatting, small move or version bump. Examples: 'rename foo to bar', 'correct the spelling in this comment'. Not a broad refactor, an unexplained failure, or permission to leave an ongoing work phase; a local correction can have intent continue.",
		keywords: ["rename", "move", "delete", "typo", "tweak", "bump", "quick fix", "format", "reformat"],
	},
	default: {
		model: "@default",
		thinking: "medium",
		rank: 1,
		description: "Ordinary questions or requests with no better configured route. Examples: a greeting or general factual question. Not a fallback for a clear design, implementation, investigation or mechanical-edit request.",
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
			intent: "continue",
			intentConfidence: 0,
			route: hit?.route ?? snapshot.pinnedRoute ?? "default",
			routeConfidence: 1,
			matched: hit?.matched,
			costUsd: 0,
		};
	}
}
