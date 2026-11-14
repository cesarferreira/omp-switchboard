import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import {
	type BenchmarkAnswer,
	type BenchmarkSelection,
	type BenchmarkTask,
	benchmarkTasks,
	evaluateRouting,
	type EvaluationOptions,
	jsonEquals,
	parseBenchmarkTasks,
	parseRoutingCases,
	type RoutingCase,
} from "../src/evaluation";
import { decide, type PolicyRoute } from "../src/policy";
import { resolveRoutes } from "../src/routes";
import type { Classification, DecisionEngine, Snapshot } from "../src/types";

const routes = resolveRoutes(DEFAULT_CONFIG);
const policyRoutes: PolicyRoute[] = [
	{ name: "plan", rank: 3, hasModel: true, target: "p/deep" },
	{ name: "implement", rank: 2, hasModel: true, target: "p/code" },
	{ name: "deep-dive", rank: 3, hasModel: true, target: "p/read" },
	{ name: "quick-edit", rank: 0, hasModel: true, target: "p/fast" },
	{ name: "default", rank: 1, hasModel: true, target: "p/std" },
	{ name: "inherit", rank: 1, hasModel: false, target: undefined },
];
const options: EvaluationOptions = { routes, policyRoutes, routing: DEFAULT_CONFIG.routing, timeoutMs: 1000 };

const cls = (o: Partial<Classification> = {}): Classification => ({
	intent: "new_task",
	intentConfidence: 0.9,
	route: "implement",
	routeConfidence: 0.9,
	...o,
});

type ClassifyFn = (snapshot: Snapshot, index: number, signal: AbortSignal) => Promise<Classification> | Classification;

class FakeEngine implements DecisionEngine {
	readonly label = "fake";
	readonly calls: Snapshot[] = [];
	constructor(private readonly fn: ClassifyFn) {}
	async classify(snapshot: Snapshot, _routes: unknown, signal: AbortSignal): Promise<Classification> {
		this.calls.push(snapshot);
		return this.fn(snapshot, this.calls.length - 1, signal);
	}
}

const mk = (id: string, o: Partial<RoutingCase> = {}): RoutingCase => ({
	id,
	split: "development",
	latestRequest: `request for ${id}`,
	recent: [],
	currentRoute: "default",
	pinnedRoute: null,
	contextTokens: 1000,
	expected: { intent: "new_task", routes: ["implement"], pinnedRoute: "implement", phaseChange: false },
	...o,
});

const corpus = (): RoutingCase[] =>
	parseRoutingCases(JSON.parse(readFileSync(join(import.meta.dir, "../evaluation/routing-cases.json"), "utf8")));

describe("shipped corpora", () => {
	test("routing cases parse, cover both splits and reference configured routes", () => {
		const cases = corpus();
		expect(cases.length).toBeGreaterThanOrEqual(18);
		expect(new Set(cases.map(c => c.split))).toEqual(new Set(["development", "holdout"]));
		const known = new Set(routes.map(r => r.name));
		for (const c of cases) {
			expect(known.has(c.currentRoute)).toBe(true);
			if (c.pinnedRoute !== null) expect(known.has(c.pinnedRoute)).toBe(true);
			for (const r of c.expected.routes) expect(known.has(r)).toBe(true);
		}
		expect(new Set(cases.map(c => c.expected.intent))).toEqual(new Set(["continue", "phase_change", "new_task"]));
	});

	test("policy fixtures: decide() on each case's labeled classification gives the labeled pin and phaseChange", () => {
		// Checks the pinnedRoute/phaseChange fixtures against the policy only. It says nothing about classifier accuracy.
		for (const c of corpus()) {
			const verdict = decide({
				cls: cls({ intent: c.expected.intent, route: c.expected.routes[0] }),
				pinnedRoute: c.pinnedRoute ?? undefined,
				currentModel: policyRoutes.find(r => r.name === c.currentRoute)?.target ?? "",
				routes: policyRoutes,
				contextTokens: c.contextTokens,
				config: DEFAULT_CONFIG.routing,
			});
			expect({ id: c.id, pinnedRoute: verdict.pinnedRoute ?? null, phaseChange: verdict.phaseChange }).toEqual({
				id: c.id,
				pinnedRoute: c.expected.pinnedRoute,
				phaseChange: c.expected.phaseChange,
			});
		}
	});

	test("benchmark tasks parse and are self-contained JSON-answer tasks", () => {
		const tasks = parseBenchmarkTasks(JSON.parse(readFileSync(join(import.meta.dir, "../evaluation/tasks.json"), "utf8")));
		expect(tasks).toHaveLength(6);
		for (const t of tasks) expect(t.prompt).toContain("JSON");
	});
});

describe("parseRoutingCases", () => {
	interface Draft {
		split: string;
		latestRequest: string;
		recent: unknown;
		pinnedRoute?: string | null;
		contextTokens: unknown;
		expected: { intent: string; routes: string[]; phaseChange?: boolean; [key: string]: unknown };
		[key: string]: unknown;
	}
	const valid = (): Draft => JSON.parse(JSON.stringify(mk("a")));

	test("accepts a valid case", () => {
		expect(parseRoutingCases([valid()])).toEqual([mk("a")]);
	});

	test("rejects non-arrays and empty input", () => {
		expect(() => parseRoutingCases({})).toThrow("cases");
		expect(() => parseRoutingCases([])).toThrow("must not be empty");
	});

	test("rejects duplicate ids", () => {
		expect(() => parseRoutingCases([valid(), valid()])).toThrow('duplicate case id "a"');
	});

	test.each<[string, (c: Draft) => unknown, string]>([
		["split", c => (c.split = "test"), "cases[0].split"],
		["intent", c => (c.expected.intent = "other"), "cases[0].expected.intent"],
		["unknown field", c => (c.extra = 1), "cases[0].extra"],
		["unknown expected field", c => (c.expected.extra = 1), "cases[0].expected.extra"],
		["contextTokens", c => (c.contextTokens = -1), "cases[0].contextTokens"],
		["contextTokens type", c => (c.contextTokens = "5"), "cases[0].contextTokens"],
		["empty routes", c => (c.expected.routes = []), "cases[0].expected.routes"],
		["duplicate routes", c => (c.expected.routes = ["plan", "plan"]), "cases[0].expected.routes"],
		["missing phaseChange", c => delete c.expected.phaseChange, "cases[0].expected.phaseChange"],
		["blank request", c => (c.latestRequest = "  "), "cases[0].latestRequest"],
		["missing pinnedRoute", c => delete c.pinnedRoute, "cases[0].pinnedRoute"],
		["recent shape", c => (c.recent = [{ role: "user" }]), "cases[0].recent[0].text"],
	])("rejects bad %s", (_name, mutate, path) => {
		const c = valid();
		mutate(c);
		expect(() => parseRoutingCases([c])).toThrow(path);
	});
});

describe("evaluateRouting", () => {
	test("builds the snapshot from the case without leaking mutations back", async () => {
		const c = mk("snap", {
			currentRoute: "plan",
			pinnedRoute: "plan",
			recent: [{ role: "user", text: "earlier" }],
			contextTokens: 4242,
		});
		const engine = new FakeEngine(s => {
			s.recent[0].text = "mutated";
			return cls({ intent: "continue", route: "plan" });
		});
		await evaluateRouting([c], engine, options);
		expect(engine.calls[0]).toMatchObject({
			currentModel: "p/deep",
			latestRequest: "request for snap",
			attachmentCount: 0,
			compactedEvidenceUnavailable: false,
			contextTokens: 4242,
			pinnedRoute: "plan",
		});
		expect(c.recent[0].text).toBe("earlier");
		const first = new FakeEngine(() => cls());
		await evaluateRouting([mk("nopin")], first, options);
		expect(first.calls[0].pinnedRoute).toBeUndefined();
	});

	test("report contains no raw prompt or history text", async () => {
		const c = mk("secret", { latestRequest: "TOP-SECRET-REQUEST", recent: [{ role: "user", text: "TOP-SECRET-HISTORY" }] });
		const report = await evaluateRouting([c], new FakeEngine(() => cls()), options);
		const json = JSON.stringify(report);
		expect(json).not.toContain("TOP-SECRET");
	});

	test("intent, route and policy correctness are scored independently", async () => {
		const wrongIntent = mk("wrong-intent");
		const wrongRoute = mk("wrong-route");
		const wrongPolicy = mk("wrong-policy");
		const answers: Record<string, Classification> = {
			// No task is pinned, so the policy pins the classified route whatever the intent says.
			"wrong-intent": cls({ intent: "continue" }),
			"wrong-route": cls({ route: "quick-edit" }),
			// Right intent and route, but too unsure for the policy to act.
			"wrong-policy": cls({ routeConfidence: 0.3 }),
		};
		const engine = new FakeEngine(s => answers[s.latestRequest.replace("request for ", "")]);
		const report = await evaluateRouting([wrongIntent, wrongRoute, wrongPolicy], engine, options);
		const byId = Object.fromEntries(report.cases.map(r => [r.id, r]));
		expect(byId["wrong-intent"]).toMatchObject({ intentCorrect: false, routeCorrect: true, policyCorrect: true });
		expect(byId["wrong-route"]).toMatchObject({ intentCorrect: true, routeCorrect: false, policyCorrect: false });
		expect(byId["wrong-policy"]).toMatchObject({ intentCorrect: true, routeCorrect: true, policyCorrect: false });
		expect(byId["wrong-policy"].verdict).toMatchObject({ pinnedRoute: null, switchModel: false });
		expect(report.overall).toMatchObject({ total: 3, intentCorrect: 2, routeCorrect: 2, policyCorrect: 1, allCorrect: 0 });
		expect(report.overall.intentAccuracy).toBeCloseTo(2 / 3);
	});

	test("a confident phase change may move down in rank; policy label and flag are checked", async () => {
		const c = mk("approve", {
			currentRoute: "plan",
			pinnedRoute: "plan",
			expected: { intent: "phase_change", routes: ["implement"], pinnedRoute: "implement", phaseChange: true },
		});
		const report = await evaluateRouting([c], new FakeEngine(() => cls({ intent: "phase_change" })), options);
		expect(report.cases[0].verdict).toMatchObject({ pinnedRoute: "implement", phaseChange: true, switchModel: true });
		expect(report.cases[0].policyCorrect).toBe(true);
	});

	test("uncertain phase-change confidence stays safe on the pinned route", async () => {
		const c = mk("unsure", {
			currentRoute: "plan",
			pinnedRoute: "plan",
			expected: { intent: "continue", routes: ["plan"], pinnedRoute: "plan", phaseChange: false },
		});
		const unsure = new FakeEngine(() => cls({ intent: "phase_change", intentConfidence: 0.3 }));
		const report = await evaluateRouting([c], unsure, options);
		expect(report.cases[0].verdict).toMatchObject({ pinnedRoute: "plan", switchModel: false, phaseChange: false });
		expect(report.cases[0].policyCorrect).toBe(true);
		expect(report.cases[0].intentCorrect).toBe(false);
	});

	test("caller routing guards still apply", async () => {
		const c = mk("guarded", {
			currentRoute: "plan",
			pinnedRoute: "plan",
			contextTokens: 90_000,
			expected: { intent: "phase_change", routes: ["implement"], pinnedRoute: "plan", phaseChange: false },
		});
		const engine = new FakeEngine(() => cls({ intent: "phase_change" }));
		const guarded = await evaluateRouting([c], engine, options);
		expect(guarded.cases[0].verdict).toMatchObject({ pinnedRoute: "plan", switchModel: false, phaseChange: false });
		expect(guarded.cases[0].policyCorrect).toBe(true);
		const unguarded = await evaluateRouting([c], engine, {
			...options,
			routing: { ...options.routing, cacheAware: false },
		});
		expect(unguarded.cases[0].verdict).toMatchObject({ pinnedRoute: "implement", switchModel: true, phaseChange: true });
	});

	test("a phase_change that names the pinned route is not a phase change", async () => {
		const c = mk("same-route", {
			currentRoute: "implement",
			pinnedRoute: "implement",
			expected: { intent: "phase_change", routes: ["implement"], pinnedRoute: "implement", phaseChange: false },
		});
		const report = await evaluateRouting([c], new FakeEngine(() => cls({ intent: "phase_change" })), options);
		expect(report.cases[0].verdict).toMatchObject({ pinnedRoute: "implement", switchModel: false, phaseChange: false });
		expect(report.cases[0].policyCorrect).toBe(true);
	});

	test("engine errors count in every denominator and never fall back", async () => {
		const engine = new FakeEngine((_s, i) => {
			if (i === 1) throw new Error("provider exploded");
			return cls();
		});
		const report = await evaluateRouting([mk("ok"), mk("boom", { split: "holdout" })], engine, options);
		const boom = report.cases[1];
		expect(boom.error).toContain("provider exploded");
		expect(boom).toMatchObject({ intentCorrect: false, routeCorrect: false, policyCorrect: false });
		expect(boom.classification).toBeUndefined();
		expect(boom.verdict).toBeUndefined();
		expect(report.overall).toMatchObject({ total: 2, errors: 1, intentCorrect: 1, routeCorrect: 1, policyCorrect: 1 });
		expect(report.overall.intentAccuracy).toBe(0.5);
		expect(report.splits.holdout).toMatchObject({ total: 1, errors: 1, intentAccuracy: 0 });
		expect(report.splits.development).toMatchObject({ total: 1, errors: 0, intentAccuracy: 1 });
	});

	test("error text is bounded", async () => {
		const engine = new FakeEngine(() => {
			throw new Error("x".repeat(500));
		});
		const report = await evaluateRouting([mk("long")], engine, options);
		expect(report.cases[0].error?.length).toBeLessThanOrEqual(200);
	});

	test("malformed classifications are errors, not repaired", async () => {
		const bad: Partial<Classification>[] = [
			{ route: "" },
			{ intentConfidence: Number.NaN },
			{ routeConfidence: 1.5 },
			{ intent: "maybe" as Classification["intent"] },
			{ costUsd: -1 },
		];
		const engine = new FakeEngine((_s, i) => cls(bad[i]));
		const report = await evaluateRouting(
			bad.map((_, i) => mk(`bad-${i}`)),
			engine,
			options,
		);
		expect(report.overall).toMatchObject({ total: 5, errors: 5, policyCorrect: 0 });
		for (const r of report.cases) expect(r.error).toContain("malformed classification");
	});

	test("a classifier that ignores the deadline is aborted and recorded as an error", async () => {
		let aborted: AbortSignal | undefined;
		const engine = new FakeEngine((_s, _i, signal) => {
			aborted = signal;
			return Promise.withResolvers<Classification>().promise;
		});
		// Real timer on purpose: this exercises the evaluator's own deadline against an engine that never settles.
		const report = await evaluateRouting([mk("slow")], engine, { ...options, timeoutMs: 20 });
		expect(report.cases[0].error).toContain("timed out");
		expect(aborted?.aborted).toBe(true);
		expect(report.overall.errors).toBe(1);
	});

	test("reports classifier latency and known costs with explicit coverage", async () => {
		const costs = [0.001, undefined, 0.002];
		const engine = new FakeEngine((_s, i) => cls({ costUsd: costs[i] }));
		const report = await evaluateRouting([mk("a"), mk("b"), mk("c", { split: "holdout" })], engine, options);
		expect(report.overall.classifierCost).toMatchObject({ casesWithCost: 2, cases: 3, complete: false });
		expect(report.overall.classifierCost.knownUsd).toBeCloseTo(0.003);
		expect(report.splits.development.classifierCost).toEqual({ knownUsd: 0.001, casesWithCost: 1, cases: 2, complete: false });
		expect(report.splits.holdout.classifierCost).toEqual({ knownUsd: 0.002, casesWithCost: 1, cases: 1, complete: true });
		const latency = report.overall.classifierLatencyMs;
		expect(latency?.mean).toBeGreaterThanOrEqual(0);
		expect(latency?.max).toBeGreaterThanOrEqual(latency?.p50 ?? Infinity);
		expect(report.cases[1].classification?.costUsd).toBeUndefined();
		expect(report.engine).toBe("fake");
		expect(report.limitation).toContain("not an independent benchmark");
	});

	test("setup problems throw before any engine call", async () => {
		const engine = new FakeEngine(() => cls());
		await expect(evaluateRouting([mk("x", { currentRoute: "inherit" })], engine, options)).rejects.toThrow("no resolved model target");
		await expect(evaluateRouting([mk("x", { currentRoute: "nowhere" })], engine, options)).rejects.toThrow("no resolved model target");
		await expect(evaluateRouting([mk("x", { pinnedRoute: "nowhere" })], engine, options)).rejects.toThrow("not a policy route");
		await expect(
			evaluateRouting([mk("x", { expected: { intent: "new_task", routes: ["nowhere"], pinnedRoute: null, phaseChange: false } })], engine, options),
		).rejects.toThrow('expected route "nowhere"');
		await expect(evaluateRouting([mk("x"), mk("x")], engine, options)).rejects.toThrow("duplicate case id");
		await expect(evaluateRouting([], engine, options)).rejects.toThrow("no routing cases");
		await expect(evaluateRouting([mk("x")], engine, { ...options, timeoutMs: 0 })).rejects.toThrow("timeoutMs");
		expect(engine.calls).toHaveLength(0);
	});
});

describe("parseBenchmarkTasks", () => {
	const valid = () => ({ id: "t", prompt: "answer in JSON", expected: { a: [1, null] } });

	test("accepts valid tasks including null expected", () => {
		expect(parseBenchmarkTasks([valid(), { id: "n", prompt: "p", expected: null }])).toHaveLength(2);
	});

	test("rejects malformed input", () => {
		expect(() => parseBenchmarkTasks({})).toThrow("tasks");
		expect(() => parseBenchmarkTasks([])).toThrow("must not be empty");
		expect(() => parseBenchmarkTasks([valid(), valid()])).toThrow('duplicate task id "t"');
		expect(() => parseBenchmarkTasks([{ id: "t", prompt: "p" }])).toThrow("tasks[0].expected");
		expect(() => parseBenchmarkTasks([{ ...valid(), expected: Number.NaN }])).toThrow("must be a JSON value");
		expect(() => parseBenchmarkTasks([{ ...valid(), expected: { f: undefined } }])).toThrow("must be a JSON value");
		expect(() => parseBenchmarkTasks([{ ...valid(), prompt: "" }])).toThrow("tasks[0].prompt");
		expect(() => parseBenchmarkTasks([{ ...valid(), extra: 1 }])).toThrow("tasks[0].extra");
	});
});

describe("jsonEquals", () => {
	test("object key order is ignored, array order is not", () => {
		expect(jsonEquals({ a: 1, b: { c: [1, 2], d: "x" } }, { b: { d: "x", c: [1, 2] }, a: 1 })).toBe(true);
		expect(jsonEquals([1, 2, 3], [1, 2, 3])).toBe(true);
		expect(jsonEquals([3, 2, 1], [1, 2, 3])).toBe(false);
		expect(jsonEquals({ a: [{ x: 1 }, { y: 2 }] }, { a: [{ y: 2 }, { x: 1 }] })).toBe(false);
	});

	test("is strict about types, missing and extra keys", () => {
		expect(jsonEquals(1, "1" as never)).toBe(false);
		expect(jsonEquals("1", 1)).toBe(false);
		expect(jsonEquals(null, null)).toBe(true);
		expect(jsonEquals(undefined, null)).toBe(false);
		expect(jsonEquals(0, false)).toBe(false);
		expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
		expect(jsonEquals({ a: undefined }, { b: 1 })).toBe(false);
		expect(jsonEquals({ a: 1 }, [1])).toBe(false);
		expect(jsonEquals([1], { 0: 1 })).toBe(false);
		expect(jsonEquals(Number.NaN, 1)).toBe(false);
		expect(jsonEquals("{\"a\":1}", { a: 1 })).toBe(false);
	});
});

describe("benchmarkTasks", () => {
	const tasks: BenchmarkTask[] = [
		{ id: "t1", prompt: "p1", expected: { v: 1 } },
		{ id: "t2", prompt: "p2", expected: { v: 2 } },
		{ id: "t3", prompt: "p3", expected: [1, 2] },
	];
	const right = (t: BenchmarkTask): unknown => t.expected;
	const pick =
		(route: string, costUsd?: number, latencyMs = 10) =>
		async (): Promise<BenchmarkSelection> => ({ route, costUsd, latencyMs });

	test("includes routed selection latency and cost in the routed path", async () => {
		const report = await benchmarkTasks(
			tasks,
			["big"],
			pick("small", 0.001, 100),
			async (t, route) => ({ answer: right(t), costUsd: route === "small" ? 0.002 : 0.01, latencyMs: route === "small" ? 50 : 400 }),
		);
		expect(report.cases[0].routed).toMatchObject({ route: "small", latencyMs: 150, correct: true, costComplete: true });
		expect(report.cases[0].routed.knownCostUsd).toBeCloseTo(0.003);
		expect(report.routed).toMatchObject({ runs: 3, correct: 3, errors: 0, incorrect: 0, totalLatencyMs: 450, costComplete: true });
		expect(report.routed.knownCostUsd).toBeCloseTo(0.009);
		expect(report.baselines[0]).toMatchObject({ label: "baseline:big", correct: 3, totalLatencyMs: 1200 });
		expect(report.baselines[0].knownCostUsd).toBeCloseTo(0.03);
		const cmp = report.costComparisons[0];
		expect(cmp.savingsUsd).toBeCloseTo(0.021);
		expect(cmp.savingsPercent).toBeCloseTo(70);
		expect(report.routedRouteCounts).toEqual({ small: 3 });
		expect(report.limitation).toContain("not a full coding-agent evaluation");
	});

	test("every path makes a fresh completion; nothing is reused, even for the same route", async () => {
		let counter = 0;
		const seen: string[] = [];
		const report = await benchmarkTasks(tasks, ["same", "other"], pick("same"), async (t, route) => {
			counter++;
			seen.push(`${t.id}:${route}`);
			return { answer: { v: counter }, latencyMs: 1 };
		});
		expect(counter).toBe(tasks.length * 3);
		const answers = report.cases.flatMap(c => [c.routed.answer, ...c.baselines.map(b => b.run.answer)]);
		expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(tasks.length * 3);
		for (const t of tasks) expect(seen.filter(s => s.startsWith(`${t.id}:same`))).toHaveLength(2);
	});

	test("rotates the execution order across tasks and reports it truthfully", async () => {
		const log: string[] = [];
		const report = await benchmarkTasks(
			tasks,
			["a", "b"],
			async t => {
				log.push(`${t.id}:routed`);
				return { route: "a", latencyMs: 1 };
			},
			async (t, route) => {
				// The routed completion directly follows its selection; tag it by the route sequence instead.
				log.push(`${t.id}:complete:${route}`);
				return { answer: right(t), latencyMs: 1 };
			},
		);
		expect(report.cases.map(c => c.order)).toEqual([
			["routed", "baseline:a", "baseline:b"],
			["baseline:a", "baseline:b", "routed"],
			["baseline:b", "routed", "baseline:a"],
		]);
		expect(log.filter(l => l.startsWith("t2:")).slice(0, 2)).toEqual(["t2:complete:a", "t2:complete:b"]);
		expect(log.filter(l => l.startsWith("t3:"))[0]).toBe("t3:complete:b");
		expect(log.filter(l => l.startsWith("t1:"))[0]).toBe("t1:routed");
	});

	test("unknown costs are never treated as zero and block savings", async () => {
		const report = await benchmarkTasks(tasks, ["big"], pick("small", 0.001), async (t, route) =>
			route === "big" ? { answer: right(t), latencyMs: 5 } : { answer: right(t), costUsd: 0.002, latencyMs: 5 },
		);
		expect(report.baselines[0]).toMatchObject({ costComplete: false, costCompleteRuns: 0, knownCostUsd: 0 });
		expect(report.routed.costComplete).toBe(true);
		const cmp = report.costComparisons[0];
		expect(cmp).toEqual({ baseline: "big" });
	});

	test("partially reported routed cost is a marked lower bound", async () => {
		const report = await benchmarkTasks(tasks.slice(0, 1), ["big"], pick("small", undefined), async (t, route) => ({
			answer: right(t),
			costUsd: route === "small" ? 0.002 : 0.01,
			latencyMs: 5,
		}));
		expect(report.routed).toMatchObject({ costComplete: false, costCompleteRuns: 0 });
		expect(report.routed.knownCostUsd).toBeCloseTo(0.002);
		expect(report.costComparisons[0].savingsPercent).toBeUndefined();
		expect(report.costComparisons[0].savingsUsd).toBeUndefined();
	});

	test("no savings percentage when the baseline cost is zero", async () => {
		const report = await benchmarkTasks(tasks.slice(0, 1), ["free"], pick("small", 0.001), async (t, route) => ({
			answer: right(t),
			costUsd: route === "free" ? 0 : 0.002,
			latencyMs: 5,
		}));
		expect(report.costComparisons[0].savingsUsd).toBeCloseTo(-0.003);
		expect(report.costComparisons[0].savingsPercent).toBeUndefined();
	});

	test("failed model calls count as failures and keep reported costs", async () => {
		const report = await benchmarkTasks(
			tasks,
			["bad", "good"],
			pick("small", 0.001),
			async (t, route) => {
				if (route === "bad") throw Object.assign(new Error("model call failed"), { costUsd: 0.004 });
				if (route === "small" && t.id === "t2") throw new Error("no cost known");
				if (route === "small" && t.id === "t3") return { answer: { wrong: true }, costUsd: 0.002, latencyMs: 5 };
				return { answer: right(t), costUsd: 0.002, latencyMs: 5 };
			},
		);
		const bad = report.baselines[0];
		expect(bad).toMatchObject({ label: "baseline:bad", correct: 0, errors: 3, incorrect: 0, costComplete: true });
		expect(bad.knownCostUsd).toBeCloseTo(0.012);
		expect(report.cases[0].baselines[0].run.error).toContain("model call failed");
		expect(report.baselines[1]).toMatchObject({ correct: 3, errors: 0 });

		expect(report.routed).toMatchObject({ correct: 1, errors: 1, incorrect: 1, runs: 3, costCompleteRuns: 2, costComplete: false });
		const failed = report.cases[1].routed;
		expect(failed).toMatchObject({ completed: false, correct: false, route: "small", costComplete: false });
		expect(failed.knownCostUsd).toBeCloseTo(0.001);
		expect(failed.latencyMs).toBeGreaterThanOrEqual(10);
		expect(report.cases[2].routed).toMatchObject({ completed: true, correct: false });
	});

	test("selection failure fails the routed path without a completion", async () => {
		const completions: string[] = [];
		const report = await benchmarkTasks(
			tasks.slice(0, 2),
			["big"],
			async t => {
				if (t.id === "t1") throw new Error("selector down");
				return { route: "small", costUsd: 0.001, latencyMs: 1 };
			},
			async (t, route) => {
				completions.push(`${t.id}:${route}`);
				return { answer: right(t), costUsd: 0.01, latencyMs: 1 };
			},
		);
		expect(report.cases[0].routed).toMatchObject({ completed: false, correct: false, route: undefined, costComplete: false });
		expect(report.cases[0].routed.error).toContain("selector down");
		expect(completions).not.toContain("t1:small");
		expect(completions).toContain("t1:big");
		expect(report.routed).toMatchObject({ errors: 1, correct: 1 });
		expect(report.routedRouteCounts).toEqual({ small: 1 });
	});

	test("malformed selections and completions are failures", async () => {
		const report = await benchmarkTasks(
			tasks.slice(0, 2),
			["big"],
			async t => (t.id === "t1" ? ({ route: "", latencyMs: 1 } as BenchmarkSelection) : { route: "small", latencyMs: 1 }),
			async (t, route) => {
				if (route === "big") return { latencyMs: 1 } as BenchmarkAnswer;
				return { answer: right(t), latencyMs: Number.NaN };
			},
		);
		expect(report.cases[0].routed.error).toContain("malformed selection");
		expect(report.cases[1].routed.error).toContain("malformed completion");
		expect(report.cases[0].baselines[0].run.error).toContain("malformed completion");
		expect(report.routed.correct + report.baselines[0].correct).toBe(0);
	});

	test("answers are compared structurally", async () => {
		const report = await benchmarkTasks(
			[{ id: "obj", prompt: "p", expected: { a: 1, b: [1, 2], c: { d: null } } }],
			["reordered", "wrong-order"],
			pick("reordered"),
			async (_t, route) => ({
				answer: route === "wrong-order" ? { c: { d: null }, b: [2, 1], a: 1 } : { c: { d: null }, b: [1, 2], a: 1 },
				latencyMs: 1,
			}),
		);
		expect(report.routed.correct).toBe(1);
		expect(report.baselines.map(b => b.correct)).toEqual([1, 0]);
		expect(report.baselines[1].incorrect).toBe(1);
	});

	test("rejects invalid setups", async () => {
		const noop = async (t: BenchmarkTask): Promise<BenchmarkAnswer> => ({ answer: right(t), latencyMs: 1 });
		await expect(benchmarkTasks([], ["a"], pick("a"), noop)).rejects.toThrow("no benchmark tasks");
		await expect(benchmarkTasks(tasks, [], pick("a"), noop)).rejects.toThrow("at least one baseline");
		await expect(benchmarkTasks(tasks, ["a", "a"], pick("a"), noop)).rejects.toThrow("unique");
		await expect(benchmarkTasks(tasks, [""], pick("a"), noop)).rejects.toThrow("non-empty");
		await expect(benchmarkTasks([tasks[0], tasks[0]], ["a"], pick("a"), noop)).rejects.toThrow("duplicate task id");
	});
});
