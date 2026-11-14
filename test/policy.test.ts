import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { decide, type PolicyInput, type PolicyRoute } from "../src/policy";
import type { Classification } from "../src/types";
import { KeywordEngine, resolveRoutes } from "../src/routes";

const routes: PolicyRoute[] = [
	{ name: "quick-edit", rank: 0, hasModel: true, target: "p/fast" },
	{ name: "default", rank: 1, hasModel: true, target: "p/std" },
	{ name: "implement", rank: 2, hasModel: true, target: "p/code" },
	{ name: "plan", rank: 3, hasModel: true, target: "p/deep" },
	{ name: "inherit", rank: 1, hasModel: false, target: undefined },
];

const cls = (o: Partial<Classification> = {}): Classification => ({
	intent: "continue",
	intentConfidence: 0.9,
	route: "implement",
	routeConfidence: 0.9,
	...o,
});

const base = (o: Partial<PolicyInput> = {}): PolicyInput => ({
	cls: cls(),
	pinnedRoute: undefined,
	currentModel: "p/std",
	routes,
	contextTokens: 1000,
	config: DEFAULT_CONFIG.routing,
	...o,
});

describe("decide", () => {
	test("first message pins the classified route and switches", () => {
		expect(decide(base({ cls: cls({ route: "quick-edit" }) }))).toMatchObject({
			pinnedRoute: "quick-edit",
			switchModel: true,
			taskStart: true,
		});
	});

	test("follow-up at same or lower rank keeps the pinned task", () => {
		const v = decide(base({ pinnedRoute: "plan", currentModel: "p/deep", cls: cls({ route: "quick-edit" }) }));
		expect(v).toMatchObject({ pinnedRoute: "plan", switchModel: false, taskStart: false, desiredRoute: undefined });
	});

	test("follow-up with a higher-rank route escalates", () => {
		const v = decide(base({ pinnedRoute: "quick-edit", currentModel: "p/fast", cls: cls({ route: "plan" }) }));
		expect(v).toMatchObject({ pinnedRoute: "plan", switchModel: true });
	});

	test("escalation can be disabled", () => {
		const v = decide(
			base({
				pinnedRoute: "quick-edit",
				currentModel: "p/fast",
				cls: cls({ route: "plan" }),
				config: { ...DEFAULT_CONFIG.routing, allowEscalation: false },
			}),
		);
		expect(v.switchModel).toBe(false);
	});

	test("confident new task re-routes, including to a lower rank", () => {
		const v = decide(base({ pinnedRoute: "plan", currentModel: "p/deep", cls: cls({ intent: "new_task", route: "quick-edit" }) }));
		expect(v).toMatchObject({ pinnedRoute: "quick-edit", switchModel: true, taskStart: true });
	});

	test("low-confidence new-task signal is treated as follow-up", () => {
		const v = decide(
			base({
				pinnedRoute: "plan",
				currentModel: "p/deep",
				cls: cls({ intent: "new_task", intentConfidence: 0.3, route: "quick-edit" }),
			}),
		);
		expect(v).toMatchObject({ pinnedRoute: "plan", switchModel: false, taskStart: false });
	});

	test("low route confidence keeps the current model and leaves the pin unset", () => {
		const v = decide(base({ cls: cls({ route: "plan", routeConfidence: 0.2 }) }));
		expect(v).toMatchObject({ pinnedRoute: undefined, switchModel: false });
	});

	test("cache guard blocks a downgrade in a large conversation", () => {
		const v = decide(
			base({ pinnedRoute: "plan", currentModel: "p/deep", contextTokens: 200_000, cls: cls({ intent: "new_task", route: "quick-edit" }) }),
		);
		expect(v).toMatchObject({ pinnedRoute: "plan", switchModel: false });
		expect(v.reason).toContain("cache guard");
	});

	test("cache guard still allows escalation and a top-rank first route", () => {
		expect(decide(base({ pinnedRoute: "default", contextTokens: 200_000, cls: cls({ route: "plan" }) }))).toMatchObject({
			pinnedRoute: "plan",
			switchModel: true,
		});
		expect(decide(base({ contextTokens: 200_000, cls: cls({ route: "plan" }) })).switchModel).toBe(true);
		expect(decide(base({ contextTokens: 200_000, cls: cls({ route: "quick-edit" }) })).switchModel).toBe(false);
	});

	test("route without a model pins the route but never switches", () => {
		const v = decide(base({ cls: cls({ route: "inherit" }) }));
		expect(v).toMatchObject({ pinnedRoute: "inherit", switchModel: false, desiredRoute: "inherit" });
	});

	test("classifier failure and unknown routes keep everything", () => {
		expect(decide(base({ cls: undefined, pinnedRoute: "plan" }))).toMatchObject({ pinnedRoute: "plan", switchModel: false });
		expect(decide(base({ cls: cls({ route: "nope" }) })).switchModel).toBe(false);
	});

	test("context guard refuses a model whose window cannot hold the conversation", () => {
		const small = routes.map(r => (r.name === "quick-edit" ? { ...r, contextWindow: 200_000 } : r));
		const over = decide(base({ routes: small, contextTokens: 170_000, cls: cls({ route: "quick-edit" }), config: { ...DEFAULT_CONFIG.routing, cacheAware: false } }));
		expect(over.switchModel).toBe(false);
		expect(over.reason).toContain("context guard");
		const under = decide(base({ routes: small, contextTokens: 150_000, cls: cls({ route: "quick-edit" }), config: { ...DEFAULT_CONFIG.routing, cacheAware: false } }));
		expect(under.switchModel).toBe(true);
	});

	test("route whose model cannot be resolved keeps current model", () => {
		const broken = routes.map(r => (r.name === "plan" ? { ...r, target: undefined } : r));
		const v = decide(base({ routes: broken, cls: cls({ route: "plan" }) }));
		expect(v).toMatchObject({ switchModel: false, pinnedRoute: undefined });
	});
	test("keyword typo follow-up cannot downgrade a pinned plan", async () => {
		const classification = await new KeywordEngine().classify(
			{ latestRequest: "fix the typo you just added" }, resolveRoutes(DEFAULT_CONFIG),
		);
		const verdict = decide(base({ pinnedRoute: "plan", currentModel: "p/deep", cls: classification }));
		expect(verdict).toMatchObject({ pinnedRoute: "plan", switchModel: false, taskStart: false });
	});

	test("approved phase change can move plan to implementation without inventing a new task", () => {
		const v = decide(base({ pinnedRoute: "plan", currentModel: "p/deep", cls: cls({ intent: "phase_change", route: "implement" }) }));
		expect(v).toMatchObject({ pinnedRoute: "implement", switchModel: true, taskStart: false, phaseChange: true });
	});

	test("phase handoffs require both intent and destination confidence", () => {
		for (const classification of [cls({ intent: "phase_change", intentConfidence: 0.2 }), cls({ intent: "phase_change", routeConfidence: 0.2 })]) {
			expect(decide(base({ pinnedRoute: "plan", currentModel: "p/deep", cls: classification })))
				.toMatchObject({ pinnedRoute: "plan", switchModel: false, phaseChange: false });
		}
	});

	test("same-rank phase handoffs are allowed but still respect cache and context guards", () => {
		const equal = [...routes, { name: "research", rank: 3, hasModel: true, target: "p/research", contextWindow: 200_000 }];
		const input = base({ routes: equal, pinnedRoute: "plan", currentModel: "p/deep", cls: cls({ intent: "phase_change", route: "research" }) });
		expect(decide(input)).toMatchObject({ pinnedRoute: "research", phaseChange: true, switchModel: true });
		expect(decide({ ...input, contextTokens: 70_000 }).reason).toContain("cache guard");
		expect(decide({ ...input, contextTokens: 170_000 }).reason).toContain("context guard");
	});
});
