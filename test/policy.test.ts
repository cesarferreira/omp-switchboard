import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { decide, type PolicyInput, type PolicyRoute } from "../src/policy";
import type { Classification } from "../src/types";

const routes: PolicyRoute[] = [
	{ name: "quick-edit", rank: 0, hasModel: true, target: "p/fast" },
	{ name: "default", rank: 1, hasModel: true, target: "p/std" },
	{ name: "implement", rank: 2, hasModel: true, target: "p/code" },
	{ name: "plan", rank: 3, hasModel: true, target: "p/deep" },
	{ name: "inherit", rank: 1, hasModel: false, target: undefined },
];

const cls = (o: Partial<Classification> = {}): Classification => ({
	newTask: false,
	newTaskConfidence: 0.9,
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
		const v = decide(base({ pinnedRoute: "plan", currentModel: "p/deep", cls: cls({ newTask: true, route: "quick-edit" }) }));
		expect(v).toMatchObject({ pinnedRoute: "quick-edit", switchModel: true, taskStart: true });
	});

	test("low-confidence new-task signal is treated as follow-up", () => {
		const v = decide(
			base({
				pinnedRoute: "plan",
				currentModel: "p/deep",
				cls: cls({ newTask: true, newTaskConfidence: 0.3, route: "quick-edit" }),
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
			base({ pinnedRoute: "plan", currentModel: "p/deep", contextTokens: 200_000, cls: cls({ newTask: true, route: "quick-edit" }) }),
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

	test("route whose model cannot be resolved keeps current model", () => {
		const broken = routes.map(r => (r.name === "plan" ? { ...r, target: undefined } : r));
		const v = decide(base({ routes: broken, cls: cls({ route: "plan" }) }));
		expect(v).toMatchObject({ switchModel: false, pinnedRoute: undefined });
	});
});
