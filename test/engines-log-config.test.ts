import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, sanitizeRoutes } from "../src/config";
import { parseChatJson } from "../src/engines";
import { type DecisionRecord, type LogRecord, summarize } from "../src/log";
import { resolveRoutes } from "../src/routes";

const routes = resolveRoutes(DEFAULT_CONFIG);

describe("parseChatJson", () => {
	test("extracts the JSON object from surrounding prose or code fences", () => {
		const r = parseChatJson('Sure:\n```json\n{"task":"new_task","task_confidence":0.9,"route":"plan","route_confidence":0.8}\n```', routes);
		expect(r).toMatchObject({ newTask: true, newTaskConfidence: 0.9, route: "plan", routeConfidence: 0.8 });
	});

	test("rejects routes that are not configured and malformed replies", () => {
		expect(() => parseChatJson('{"task":"follow_up","route":"nope"}', routes)).toThrow(/bad route/);
		expect(() => parseChatJson('{"task":"maybe","route":"plan"}', routes)).toThrow(/bad task/);
		expect(() => parseChatJson("no json here", routes)).toThrow(/no JSON/);
	});

	test("out-of-range or missing confidences fall back to 0.5 instead of trusting them", () => {
		const r = parseChatJson('{"task":"follow_up","task_confidence":7,"route":"default"}', routes);
		expect(r).toMatchObject({ newTaskConfidence: 0.5, routeConfidence: 0.5, newTask: false });
	});
});

describe("config validation", () => {
	test("drops bad route fields with one warning each and keeps the good ones", () => {
		const config = {
			...DEFAULT_CONFIG,
			routes: { plan: { model: "a/b", thinking: "hgih", keywords: "plan", rank: "high" } },
			setups: { s: { routes: { implement: { thinking: "low" }, quick: 3 } } },
		} as unknown as typeof DEFAULT_CONFIG;
		const warnings = sanitizeRoutes(config);
		expect(warnings).toHaveLength(4);
		expect(config.routes.plan).toEqual({ model: "a/b" });
		expect(config.setups.s?.routes.implement).toEqual({ thinking: "low" });
		expect(config.setups.s?.routes.quick).toBeUndefined();
	});

	test("loadConfig reports invalid fields and a missing activeSetup, and survives bad JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "sb-"));
		try {
			const good = join(dir, "good.json");
			writeFileSync(good, JSON.stringify({ routes: { plan: { thinking: "nope" } }, activeSetup: "ghost" }));
			const loaded = loadConfig(good);
			expect(loaded.error).toContain("plan.thinking");
			expect(loaded.error).toContain('activeSetup "ghost"');
			expect(loaded.config.routes.plan).toEqual({});

			const bad = join(dir, "bad.json");
			writeFileSync(bad, "{ not json");
			expect(loadConfig(bad).config).toEqual(DEFAULT_CONFIG);
			expect(loadConfig(bad).error).toContain("bad.json");

			expect(loadConfig(join(dir, "missing.json"))).toEqual({ config: DEFAULT_CONFIG });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("summarize", () => {
	const decision = (o: Partial<DecisionRecord>): DecisionRecord => ({
		type: "decision",
		id: "x",
		ts: 0,
		sessionId: "s",
		mode: "shadow",
		engine: "keywords",
		engineLatencyMs: 100,
		currentModel: "p/m",
		currentThinking: "medium",
		routeModels: {},
		taskStart: true,
		applied: false,
		wouldSwitch: false,
		reason: "",
		...o,
	});

	test("reports counts, switches, latency percentiles and tool errors", () => {
		const recs: LogRecord[] = [
			decision({ id: "a", desiredRoute: "plan", wouldSwitch: true, engineLatencyMs: 100 }),
			decision({ id: "b", desiredRoute: "plan", applied: true, modelChanged: true, engineLatencyMs: 300, error: "boom" }),
			decision({ id: "c", desiredRoute: "quick-edit", taskStart: false, engineLatencyMs: 200 }),
			{ type: "outcome", id: "a", ts: 0, model: "p/m", durationMs: 1, toolCalls: 4, toolErrors: 1, aborted: false },
		];
		const out = summarize(recs);
		expect(out).toContain("decisions: 3 (errors 1)");
		expect(out).toContain("plan=2");
		expect(out).toContain("quick-edit=1");
		expect(out).toContain("task starts: 2");
		expect(out).toContain("applied 1, would-switch 1");
		expect(out).toContain("p50 200ms p95 300ms");
		expect(out).toContain("tool errors 1/4");
	});

	test("thinking-only applications are not reported as model switches", () => {
		const out = summarize([
			decision({ id: "thinking", applied: true, modelChanged: false, thinkingChanged: true }),
			decision({ id: "legacy", applied: true, wouldSwitch: false }),
		]);
		expect(out).toContain("model switches: applied 0");
		expect(out).toContain("thinking changes: 1");
	});

	test("empty log", () => {
		expect(summarize([])).toBe("No decisions logged yet.");
	});
});
