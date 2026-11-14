import { isObj } from "./config";
import { decide, type PolicyRoute } from "./policy";
import {
	type Classification,
	type DecisionEngine,
	type ResolvedRoute,
	type Snapshot,
	type SwitchboardConfig,
	TASK_INTENTS,
	type TaskIntent,
} from "./types";

/**
 * Reusable evaluation algorithms. This module makes no model calls itself: the caller supplies the
 * decision engine (routing evaluation) or the select/complete callbacks (answer benchmark).
 */

export type RoutingSplit = "development" | "holdout";
const SPLITS: readonly RoutingSplit[] = ["development", "holdout"];

export const ROUTING_LIMITATION =
	"The starter routing corpus is synthetic, hand-labeled and split into development and holdout cases; it is not an independent benchmark. " +
	"Reported accuracies describe agreement with those labels only. Classifier confidence is not calibrated, and passing synthetic cases does not show real agent quality.";

export const BENCHMARK_LIMITATION =
	"Bounded single-turn JSON answer benchmark over a small synthetic task set. It is not a full coding-agent evaluation: " +
	"tool use, prompt-cache effects, retries and multi-turn context are not modelled. Routed and baseline runs are separate fresh completions, " +
	"so latency and cost are not equivalent to a real session.";

// ---------------------------------------------------------------------------
// Routing evaluation
// ---------------------------------------------------------------------------

export interface RoutingCase {
	id: string;
	split: RoutingSplit;
	latestRequest: string;
	recent: { role: string; text: string }[];
	/** Route whose resolved policy target is the live model when the request arrives. */
	currentRoute: string;
	/** Route pinned for the running task; null when no task is pinned. */
	pinnedRoute: string | null;
	contextTokens: number;
	expected: {
		intent: TaskIntent;
		/** Any listed route counts as a correct classification. */
		routes: string[];
		/** Route pinned after the policy verdict; null when nothing is pinned. */
		pinnedRoute: string | null;
		/** Whether the policy should report a confident phase boundary. */
		phaseChange: boolean;
	};
}

export interface EvaluationOptions {
	routes: ResolvedRoute[];
	policyRoutes: PolicyRoute[];
	routing: SwitchboardConfig["routing"];
	/** Per-classification deadline. The evaluator aborts the engine and records an error. */
	timeoutMs: number;
}

export interface RoutingCaseResult {
	id: string;
	split: RoutingSplit;
	/** Set when the engine threw, timed out or returned a malformed classification. No fallback is applied. */
	error?: string;
	classification?: {
		intent: TaskIntent;
		intentConfidence: number;
		route: string;
		routeConfidence: number;
		costUsd?: number;
	};
	verdict?: {
		pinnedRoute: string | null;
		desiredRoute: string | null;
		switchModel: boolean;
		taskStart: boolean;
		phaseChange: boolean;
		reason: string;
	};
	intentCorrect: boolean;
	routeCorrect: boolean;
	policyCorrect: boolean;
	classifierLatencyMs: number;
}

export interface RoutingMetrics {
	total: number;
	errors: number;
	intentCorrect: number;
	routeCorrect: number;
	policyCorrect: number;
	/** Cases where intent, route and policy outcome all matched. */
	allCorrect: number;
	/** Correct / total, errors included in the denominator. Undefined when total is 0. */
	intentAccuracy: number | undefined;
	routeAccuracy: number | undefined;
	policyAccuracy: number | undefined;
	classifierLatencyMs: { mean: number; p50: number; max: number } | undefined;
	/** Costs the engine reported. Cases without a reported cost are unknown, never counted as zero. */
	classifierCost: { knownUsd: number; casesWithCost: number; cases: number; complete: boolean };
}

export interface RoutingEvaluationReport {
	limitation: string;
	engine: string;
	overall: RoutingMetrics;
	splits: Record<RoutingSplit, RoutingMetrics>;
	cases: RoutingCaseResult[];
}

type Fields = Record<string, unknown>;

function fail(path: string, why: string): never {
	throw new Error(`${path}: ${why}`);
}

function object(v: unknown, path: string, keys: readonly string[]): Fields {
	if (!isObj(v)) return fail(path, "must be an object");
	for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${path}.${k}`, "unknown field");
	return v;
}

function text(v: unknown, path: string, allowEmpty = false): string {
	if (typeof v !== "string" || (!allowEmpty && v.trim() === "")) return fail(path, "must be a non-empty string");
	return v;
}

function nullableText(v: unknown, path: string): string | null {
	return v === null ? null : text(v, path);
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
	const hit = allowed.find(a => a === v);
	if (hit === undefined) return fail(path, `must be one of ${allowed.join("|")}`);
	return hit;
}

function list(v: unknown, path: string): unknown[] {
	if (!Array.isArray(v)) return fail(path, "must be an array");
	return v;
}

function uniqueIds(items: readonly { id: string }[], what: string): void {
	const seen = new Set<string>();
	for (const { id } of items) {
		if (seen.has(id)) throw new Error(`duplicate ${what} id "${id}"`);
		seen.add(id);
	}
}

/** Validate untrusted JSON into routing cases. Throws with the offending path on the first problem. */
export function parseRoutingCases(input: unknown): RoutingCase[] {
	const items = list(input, "cases");
	if (items.length === 0) fail("cases", "must not be empty");
	const cases = items.map((raw, i): RoutingCase => {
		const p = `cases[${i}]`;
		const o = object(raw, p, [
			"id",
			"split",
			"latestRequest",
			"recent",
			"currentRoute",
			"pinnedRoute",
			"contextTokens",
			"expected",
		]);
		const recent = list(o.recent, `${p}.recent`).map((m, j) => {
			const mp = `${p}.recent[${j}]`;
			const mo = object(m, mp, ["role", "text"]);
			return { role: text(mo.role, `${mp}.role`), text: text(mo.text, `${mp}.text`, true) };
		});
		if (typeof o.contextTokens !== "number" || !Number.isFinite(o.contextTokens) || o.contextTokens < 0) {
			fail(`${p}.contextTokens`, "must be a finite number >= 0");
		}
		const e = object(o.expected, `${p}.expected`, ["intent", "routes", "pinnedRoute", "phaseChange"]);
		const routes = list(e.routes, `${p}.expected.routes`).map((r, j) => text(r, `${p}.expected.routes[${j}]`));
		if (routes.length === 0) fail(`${p}.expected.routes`, "must not be empty");
		if (new Set(routes).size !== routes.length) fail(`${p}.expected.routes`, "must not contain duplicates");
		if (typeof e.phaseChange !== "boolean") fail(`${p}.expected.phaseChange`, "must be a boolean");
		return {
			id: text(o.id, `${p}.id`),
			split: oneOf(o.split, `${p}.split`, SPLITS),
			latestRequest: text(o.latestRequest, `${p}.latestRequest`),
			recent,
			currentRoute: text(o.currentRoute, `${p}.currentRoute`),
			pinnedRoute: nullableText(o.pinnedRoute, `${p}.pinnedRoute`),
			contextTokens: o.contextTokens,
			expected: {
				intent: oneOf(e.intent, `${p}.expected.intent`, TASK_INTENTS),
				routes,
				pinnedRoute: nullableText(e.pinnedRoute, `${p}.expected.pinnedRoute`),
				phaseChange: e.phaseChange,
			},
		};
	});
	uniqueIds(cases, "case");
	return cases;
}

function describeError(e: unknown): string {
	const name = e instanceof Error ? e.name : "Error";
	const message = e instanceof Error ? e.message : String(e);
	const line = `${name}: ${message}`.replace(/\s+/g, " ");
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

const finiteIn01 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const validCost = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The evaluator never repairs engine output: anything unusable is an error for that case. */
function checkClassification(v: unknown): Classification {
	if (!isObj(v)) throw new Error("malformed classification: not an object");
	const intent = TASK_INTENTS.find(i => i === v.intent);
	if (intent === undefined) throw new Error("malformed classification: invalid intent");
	if (typeof v.route !== "string" || v.route === "") throw new Error("malformed classification: invalid route");
	if (!finiteIn01(v.intentConfidence)) throw new Error("malformed classification: intentConfidence must be in [0,1]");
	if (!finiteIn01(v.routeConfidence)) throw new Error("malformed classification: routeConfidence must be in [0,1]");
	if (v.costUsd !== undefined && !validCost(v.costUsd)) throw new Error("malformed classification: invalid costUsd");
	return {
		intent,
		intentConfidence: v.intentConfidence,
		route: v.route,
		routeConfidence: v.routeConfidence,
		...(Array.isArray(v.matched) ? { matched: v.matched.filter(m => typeof m === "string") } : {}),
		...(v.costUsd === undefined ? {} : { costUsd: v.costUsd }),
	};
}

async function classifyWithin(
	engine: DecisionEngine,
	snapshot: Snapshot,
	routes: ResolvedRoute[],
	timeoutMs: number,
): Promise<Classification> {
	const controller = new AbortController();
	const { promise: deadline, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const err = new Error(`classifier timed out after ${timeoutMs}ms`);
		controller.abort(err);
		reject(err);
	}, timeoutMs);
	try {
		return await Promise.race([engine.classify(snapshot, routes, controller.signal), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

interface PreparedCase {
	source: RoutingCase;
	currentModel: string;
}

function prepare(cases: readonly RoutingCase[], options: EvaluationOptions): PreparedCase[] {
	if (cases.length === 0) throw new Error("no routing cases to evaluate");
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
	if (options.routes.length === 0) throw new Error("routes must not be empty");
	uniqueIds(cases, "case");
	const policy = new Map(options.policyRoutes.map(r => [r.name, r]));
	const known = new Set(options.routes.map(r => r.name));
	return cases.map(c => {
		const target = policy.get(c.currentRoute)?.target;
		if (!target) throw new Error(`case "${c.id}": currentRoute "${c.currentRoute}" has no resolved model target`);
		if (c.pinnedRoute !== null && !policy.has(c.pinnedRoute)) {
			throw new Error(`case "${c.id}": pinnedRoute "${c.pinnedRoute}" is not a policy route`);
		}
		for (const r of [...c.expected.routes, ...(c.expected.pinnedRoute === null ? [] : [c.expected.pinnedRoute])]) {
			if (!known.has(r)) throw new Error(`case "${c.id}": expected route "${r}" is not a configured route`);
		}
		return { source: c, currentModel: target };
	});
}

function rate(n: number, total: number): number | undefined {
	return total === 0 ? undefined : n / total;
}

function routingMetrics(results: readonly RoutingCaseResult[]): RoutingMetrics {
	const total = results.length;
	const count = (f: (r: RoutingCaseResult) => boolean) => results.filter(f).length;
	const intentCorrect = count(r => r.intentCorrect);
	const routeCorrect = count(r => r.routeCorrect);
	const policyCorrect = count(r => r.policyCorrect);
	const latencies = results.map(r => r.classifierLatencyMs).sort((a, b) => a - b);
	const costs = results.flatMap(r => (r.classification?.costUsd === undefined ? [] : [r.classification.costUsd]));
	return {
		total,
		errors: count(r => r.error !== undefined),
		intentCorrect,
		routeCorrect,
		policyCorrect,
		allCorrect: count(r => r.intentCorrect && r.routeCorrect && r.policyCorrect),
		intentAccuracy: rate(intentCorrect, total),
		routeAccuracy: rate(routeCorrect, total),
		policyAccuracy: rate(policyCorrect, total),
		classifierLatencyMs:
			total === 0
				? undefined
				: {
						mean: latencies.reduce((a, b) => a + b, 0) / total,
						p50: latencies[Math.ceil(total / 2) - 1],
						max: latencies[total - 1],
					},
		classifierCost: {
			knownUsd: costs.reduce((a, b) => a + b, 0),
			casesWithCost: costs.length,
			cases: total,
			complete: costs.length === total,
		},
	};
}

/**
 * Run the real engine and the real policy over each case, sequentially. Engine failures are recorded as
 * errors (counted wrong and kept in every denominator); the evaluator never substitutes a fallback.
 * Setup problems (unknown routes, a current route without a model) throw before any engine call.
 */
export async function evaluateRouting(
	cases: readonly RoutingCase[],
	engine: DecisionEngine,
	options: EvaluationOptions,
): Promise<RoutingEvaluationReport> {
	const prepared = prepare(cases, options);
	const results: RoutingCaseResult[] = [];

	for (const { source: c, currentModel } of prepared) {
		const snapshot: Snapshot = {
			currentModel,
			latestRequest: c.latestRequest,
			recent: c.recent.map(m => ({ role: m.role, text: m.text })),
			attachmentCount: 0,
			compactedEvidenceUnavailable: false,
			contextTokens: c.contextTokens,
			pinnedRoute: c.pinnedRoute ?? undefined,
		};
		const started = performance.now();
		let cls: Classification | undefined;
		let error: string | undefined;
		try {
			cls = checkClassification(await classifyWithin(engine, snapshot, options.routes, options.timeoutMs));
		} catch (e) {
			error = describeError(e);
		}
		const classifierLatencyMs = performance.now() - started;

		const result: RoutingCaseResult = {
			id: c.id,
			split: c.split,
			intentCorrect: false,
			routeCorrect: false,
			policyCorrect: false,
			classifierLatencyMs,
		};
		if (cls === undefined) {
			result.error = error;
		} else {
			const verdict = decide({
				cls,
				pinnedRoute: snapshot.pinnedRoute,
				currentModel,
				routes: options.policyRoutes,
				contextTokens: snapshot.contextTokens,
				config: options.routing,
			});
			result.classification = {
				intent: cls.intent,
				intentConfidence: cls.intentConfidence,
				route: cls.route,
				routeConfidence: cls.routeConfidence,
				...(cls.costUsd === undefined ? {} : { costUsd: cls.costUsd }),
			};
			result.verdict = {
				pinnedRoute: verdict.pinnedRoute ?? null,
				desiredRoute: verdict.desiredRoute ?? null,
				switchModel: verdict.switchModel,
				taskStart: verdict.taskStart,
				phaseChange: verdict.phaseChange,
				reason: verdict.reason,
			};
			result.intentCorrect = cls.intent === c.expected.intent;
			result.routeCorrect = c.expected.routes.includes(cls.route);
			result.policyCorrect =
				result.verdict.pinnedRoute === c.expected.pinnedRoute && result.verdict.phaseChange === c.expected.phaseChange;
		}
		results.push(result);
	}

	return {
		limitation: ROUTING_LIMITATION,
		engine: engine.label,
		overall: routingMetrics(results),
		splits: {
			development: routingMetrics(results.filter(r => r.split === "development")),
			holdout: routingMetrics(results.filter(r => r.split === "holdout")),
		},
		cases: results,
	};
}

// ---------------------------------------------------------------------------
// Answer benchmark
// ---------------------------------------------------------------------------

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface BenchmarkTask {
	id: string;
	/** Self-contained prompt that asks for a JSON answer. Tasks are never executed as code. */
	prompt: string;
	expected: JSONValue;
}

export interface BenchmarkSelection {
	route: string;
	/** Undefined when the selector cannot report a cost; that is unknown, not zero. */
	costUsd?: number;
	latencyMs: number;
}

export interface BenchmarkAnswer {
	answer: unknown;
	costUsd?: number;
	latencyMs: number;
}

export interface BenchmarkRunResult {
	/** Route that produced the answer; undefined when route selection itself failed. */
	route: string | undefined;
	/** The completion returned a well-formed answer (it may still be wrong). */
	completed: boolean;
	correct: boolean;
	answer?: unknown;
	error?: string;
	/** Routed runs include selection latency. Failed calls contribute their measured wall time. */
	latencyMs: number;
	/** Sum of the costs actually reported for this run. */
	knownCostUsd: number;
	/** False when any call in this run (selection, completion) reported no cost. */
	costComplete: boolean;
	selection?: BenchmarkSelection;
}

export interface BenchmarkCaseResult {
	id: string;
	/** Execution order for this task: `routed` and `baseline:<route>`. Rotated per task to reduce order bias. */
	order: string[];
	routed: BenchmarkRunResult;
	baselines: { route: string; run: BenchmarkRunResult }[];
}

export interface BenchmarkPathSummary {
	/** `routed` or `baseline:<route>`. */
	label: string;
	runs: number;
	correct: number;
	/** Completed but not equal to the expected value. */
	incorrect: number;
	/** Selection or completion failed, or returned a malformed result. Counts as a failure. */
	errors: number;
	totalLatencyMs: number;
	meanLatencyMs: number;
	knownCostUsd: number;
	costCompleteRuns: number;
	/** True only when every run reported every cost; otherwise knownCostUsd is a lower bound. */
	costComplete: boolean;
}

export interface BenchmarkCostComparison {
	baseline: string;
	/** Defined only when routed and baseline costs are both complete. */
	routedUsd?: number;
	baselineUsd?: number;
	savingsUsd?: number;
	/** Defined only with complete costs and a positive baseline cost. */
	savingsPercent?: number;
}

export interface BenchmarkReport {
	limitation: string;
	tasks: number;
	routed: BenchmarkPathSummary;
	baselines: BenchmarkPathSummary[];
	/** Routed route -> number of tasks it was selected for. */
	routedRouteCounts: Record<string, number>;
	costComparisons: BenchmarkCostComparison[];
	cases: BenchmarkCaseResult[];
}

const MAX_JSON_DEPTH = 64;

function isJsonValue(v: unknown, depth = 0): v is JSONValue {
	if (depth > MAX_JSON_DEPTH) return false;
	if (v === null || typeof v === "boolean" || typeof v === "string") return true;
	if (typeof v === "number") return Number.isFinite(v);
	if (Array.isArray(v)) return v.every(x => isJsonValue(x, depth + 1));
	if (isPlainObject(v)) return Object.values(v).every(x => isJsonValue(x, depth + 1));
	return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/** Validate untrusted JSON into benchmark tasks. Throws with the offending path on the first problem. */
export function parseBenchmarkTasks(input: unknown): BenchmarkTask[] {
	const items = list(input, "tasks");
	if (items.length === 0) fail("tasks", "must not be empty");
	const tasks = items.map((raw, i): BenchmarkTask => {
		const p = `tasks[${i}]`;
		const o = object(raw, p, ["id", "prompt", "expected"]);
		if (!Object.hasOwn(o, "expected")) fail(`${p}.expected`, "is required");
		if (!isJsonValue(o.expected)) fail(`${p}.expected`, "must be a JSON value");
		return { id: text(o.id, `${p}.id`), prompt: text(o.prompt, `${p}.prompt`), expected: o.expected };
	});
	uniqueIds(tasks, "task");
	return tasks;
}

/**
 * Structural JSON equality: object key order is ignored, array order is significant, and no coercion happens
 * (1 !== "1", missing !== undefined-valued, extra keys differ).
 */
export function jsonEquals(actual: unknown, expected: JSONValue, depth = 0): boolean {
	if (depth > MAX_JSON_DEPTH) return false;
	if (expected === null || typeof expected !== "object") return actual === expected;
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => jsonEquals(actual[i], e, depth + 1))
		);
	}
	if (!isPlainObject(actual)) return false;
	const keys = Object.keys(expected);
	if (Object.keys(actual).length !== keys.length) return false;
	return keys.every(k => Object.hasOwn(actual, k) && jsonEquals(actual[k], expected[k], depth + 1));
}

function checkSelection(v: unknown): BenchmarkSelection {
	if (!isObj(v)) throw new Error("malformed selection: not an object");
	if (typeof v.route !== "string" || v.route === "") throw new Error("malformed selection: invalid route");
	if (!validCost(v.latencyMs)) throw new Error("malformed selection: invalid latencyMs");
	if (v.costUsd !== undefined && !validCost(v.costUsd)) throw new Error("malformed selection: invalid costUsd");
	return { route: v.route, latencyMs: v.latencyMs, ...(v.costUsd === undefined ? {} : { costUsd: v.costUsd }) };
}

function checkAnswer(v: unknown): BenchmarkAnswer {
	if (!isObj(v) || !Object.hasOwn(v, "answer")) throw new Error("malformed completion: missing answer");
	if (!validCost(v.latencyMs)) throw new Error("malformed completion: invalid latencyMs");
	if (v.costUsd !== undefined && !validCost(v.costUsd)) throw new Error("malformed completion: invalid costUsd");
	return { answer: v.answer, latencyMs: v.latencyMs, ...(v.costUsd === undefined ? {} : { costUsd: v.costUsd }) };
}

/** A thrown error may carry the cost already incurred by the failed call. */
function costOnError(e: unknown): number | undefined {
	return e instanceof Error && "costUsd" in e && validCost(e.costUsd) ? e.costUsd : undefined;
}

class CostTally {
	known = 0;
	complete = true;
	add(cost: number | undefined): void {
		if (cost === undefined) this.complete = false;
		else this.known += cost;
	}
}

async function runRouted(
	task: BenchmarkTask,
	select: (task: BenchmarkTask) => Promise<BenchmarkSelection>,
	complete: (task: BenchmarkTask, route: string) => Promise<BenchmarkAnswer>,
): Promise<BenchmarkRunResult> {
	const cost = new CostTally();
	const summary = (r: Omit<BenchmarkRunResult, "knownCostUsd" | "costComplete">): BenchmarkRunResult => ({
		...r,
		knownCostUsd: cost.known,
		costComplete: cost.complete,
	});

	let selection: BenchmarkSelection;
	const selectStart = performance.now();
	try {
		selection = checkSelection(await select(task));
	} catch (e) {
		cost.add(costOnError(e));
		return summary({
			route: undefined,
			completed: false,
			correct: false,
			error: describeError(e),
			latencyMs: performance.now() - selectStart,
		});
	}
	cost.add(selection.costUsd);

	const completeStart = performance.now();
	try {
		const out = checkAnswer(await complete(task, selection.route));
		cost.add(out.costUsd);
		return summary({
			route: selection.route,
			completed: true,
			correct: jsonEquals(out.answer, task.expected),
			answer: out.answer,
			latencyMs: selection.latencyMs + out.latencyMs,
			selection,
		});
	} catch (e) {
		cost.add(costOnError(e));
		return summary({
			route: selection.route,
			completed: false,
			correct: false,
			error: describeError(e),
			latencyMs: selection.latencyMs + (performance.now() - completeStart),
			selection,
		});
	}
}

async function runFixed(
	task: BenchmarkTask,
	route: string,
	complete: (task: BenchmarkTask, route: string) => Promise<BenchmarkAnswer>,
): Promise<BenchmarkRunResult> {
	const start = performance.now();
	try {
		const out = checkAnswer(await complete(task, route));
		return {
			route,
			completed: true,
			correct: jsonEquals(out.answer, task.expected),
			answer: out.answer,
			latencyMs: out.latencyMs,
			knownCostUsd: out.costUsd ?? 0,
			costComplete: out.costUsd !== undefined,
		};
	} catch (e) {
		const cost = costOnError(e);
		return {
			route,
			completed: false,
			correct: false,
			error: describeError(e),
			latencyMs: performance.now() - start,
			knownCostUsd: cost ?? 0,
			costComplete: cost !== undefined,
		};
	}
}

function summarize(label: string, runs: readonly BenchmarkRunResult[]): BenchmarkPathSummary {
	const correct = runs.filter(r => r.correct).length;
	const errors = runs.filter(r => !r.completed).length;
	const totalLatencyMs = runs.reduce((a, r) => a + r.latencyMs, 0);
	const costCompleteRuns = runs.filter(r => r.costComplete).length;
	return {
		label,
		runs: runs.length,
		correct,
		incorrect: runs.length - correct - errors,
		errors,
		totalLatencyMs,
		meanLatencyMs: runs.length === 0 ? 0 : totalLatencyMs / runs.length,
		knownCostUsd: runs.reduce((a, r) => a + r.knownCostUsd, 0),
		costCompleteRuns,
		costComplete: costCompleteRuns === runs.length,
	};
}

/**
 * Compare the routed path against fixed-route baselines on a bounded answer benchmark. Every path makes a
 * fresh completion call per task (no result is shared, even when the routed route equals a baseline). The
 * routed path includes its selection latency and cost. The execution order of the paths rotates per task.
 * Failures count as wrong answers; costs the callbacks did not report stay unknown.
 */
export async function benchmarkTasks(
	tasks: readonly BenchmarkTask[],
	baselines: readonly string[],
	select: (task: BenchmarkTask) => Promise<BenchmarkSelection>,
	complete: (task: BenchmarkTask, route: string) => Promise<BenchmarkAnswer>,
): Promise<BenchmarkReport> {
	if (tasks.length === 0) throw new Error("no benchmark tasks to run");
	if (baselines.length === 0) throw new Error("at least one baseline route is required");
	if (baselines.some(b => typeof b !== "string" || b === "")) throw new Error("baseline routes must be non-empty strings");
	if (new Set(baselines).size !== baselines.length) throw new Error("baseline routes must be unique");
	uniqueIds(tasks, "task");

	const labels = ["routed", ...baselines.map(b => `baseline:${b}`)];
	const cases: BenchmarkCaseResult[] = [];

	for (const [index, task] of tasks.entries()) {
		const shift = index % labels.length;
		const order = [...labels.slice(shift), ...labels.slice(0, shift)];
		const runs = new Map<string, BenchmarkRunResult>();
		for (const label of order) {
			runs.set(
				label,
				label === "routed" ? await runRouted(task, select, complete) : await runFixed(task, label.slice("baseline:".length), complete),
			);
		}
		const runOf = (label: string): BenchmarkRunResult => {
			const run = runs.get(label);
			if (!run) throw new Error(`internal: no run recorded for ${label}`);
			return run;
		};
		cases.push({
			id: task.id,
			order,
			routed: runOf("routed"),
			baselines: baselines.map(route => ({ route, run: runOf(`baseline:${route}`) })),
		});
	}

	const routed = summarize(
		"routed",
		cases.map(c => c.routed),
	);
	const baselineSummaries = baselines.map((route, i) =>
		summarize(
			`baseline:${route}`,
			cases.map(c => c.baselines[i].run),
		),
	);
	const routedRouteCounts: Record<string, number> = {};
	for (const c of cases) {
		if (c.routed.route !== undefined) routedRouteCounts[c.routed.route] = (routedRouteCounts[c.routed.route] ?? 0) + 1;
	}

	return {
		limitation: BENCHMARK_LIMITATION,
		tasks: tasks.length,
		routed,
		baselines: baselineSummaries,
		routedRouteCounts,
		costComparisons: baselineSummaries.map((b, i): BenchmarkCostComparison => {
			const baseline = baselines[i];
			if (!routed.costComplete || !b.costComplete) return { baseline };
			const savingsUsd = b.knownCostUsd - routed.knownCostUsd;
			return {
				baseline,
				routedUsd: routed.knownCostUsd,
				baselineUsd: b.knownCostUsd,
				savingsUsd,
				...(b.knownCostUsd > 0 ? { savingsPercent: (savingsUsd / b.knownCostUsd) * 100 } : {}),
			};
		}),
		cases,
	};
}
