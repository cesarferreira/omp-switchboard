import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { completeSimple, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { logDir } from "./config";
import { assessTargetContext } from "./context-budget";
import { createEngine } from "./engines";
import { benchmarkTasks, evaluateRouting, parseBenchmarkTasks, parseRoutingCases, type BenchmarkAnswer, type BenchmarkSelection, type BenchmarkTask } from "./evaluation";
import { decide, type PolicyRoute } from "./policy";
import { KeywordEngine, resolveRoutes } from "./routes";
import type { Snapshot, SwitchboardConfig } from "./types";
import { hasUsablePrices, summarizeExecutionUsage } from "./usage";

const BENCHMARK_COMPLETION_TIMEOUT_MS = 60_000;

/** Keep completion failures and normalized spend visible to the benchmark rather than retrying them. */
export function benchmarkReply(
	message: Pick<AssistantMessage, "role" | "content" | "usage" | "stopReason" | "errorMessage">,
	pricingKnown: boolean, latencyMs: number,
): BenchmarkAnswer {
	const usage = summarizeExecutionUsage([message]);
	const costUsd = pricingKnown ? usage.executionCostUsd : undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		// SDK transport errors synthesize zero usage even when the provider may have billed work.
		const failedCost = costUsd !== undefined && costUsd > 0 ? costUsd : undefined;
		throw Object.assign(new Error(message.errorMessage ?? `completion ${message.stopReason}`), { costUsd: failedCost });
	}
	const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").trim();
	let answer: unknown;
	try { answer = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
	catch { throw Object.assign(new Error(`completion did not return valid JSON (stop=${message.stopReason}, textChars=${text.length})`), { costUsd }); }
	return { answer, costUsd, latencyMs };
}

/** Explicit, billable evaluations: never change the live model, pin, thinking, or working files. */
export async function runEvaluationCommand(
	kind: "evaluate" | "benchmark", path: string | undefined, ctx: ExtensionCommandContext,
	config: SwitchboardConfig, currentThinking: string | undefined,
): Promise<string> {
	const inputPath = path ? resolve(ctx.cwd, path) : new URL(`../evaluation/${kind === "evaluate" ? "routing-cases" : "tasks"}.json`, import.meta.url);
	const input: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
	if (!ctx.model) throw new Error("a current model is required for evaluation");
	const current = ctx.model;
	const currentRef = `${current.provider}/${current.id}`;
	const routes = resolveRoutes(config);
	const resolved = new Map(routes.map(route => [route.name, route.model ? ctx.models.resolve(route.model) : current]));
	const policyRoutes: PolicyRoute[] = routes.map(route => {
		const model = route.model ? resolved.get(route.name) : undefined;
		return { name: route.name, rank: route.rank, hasModel: route.model !== undefined,
			target: model && `${model.provider}/${model.id}`, contextWindow: model?.contextWindow ?? undefined };
	});
	const engine = config.decision.model ? await createEngine(ctx, config) : new KeywordEngine();
	let report: unknown;
	const costBasis = "Normalized OMP/SDK usage, not invoices; absent or unpriced model cost is unknown, not zero. Verify custom price cards.";
	let summary: string;
	if (kind === "evaluate") {
		const cases = parseRoutingCases(input);
		const result = await evaluateRouting(cases, engine, {
			routes, policyRoutes, routing: config.routing, timeoutMs: config.decision.timeoutMs,
		});
		report = { ...result, costBasis };
		summary = JSON.stringify({ engine: result.engine, overall: result.overall, splits: result.splits, limitation: result.limitation }, null, 2);
	} else {
		const tasks = parseBenchmarkTasks(input);
		const baselines = ["plan", "default", "quick-edit"];
		for (const name of baselines) if (!resolved.get(name)) throw new Error(`baseline route ${name} cannot be resolved`);
		const select = async (task: BenchmarkTask): Promise<BenchmarkSelection> => {
			const started = performance.now();
			const snapshot: Snapshot = { currentModel: currentRef, latestRequest: task.prompt, recent: [],
				contextTokens: 0, pinnedRoute: undefined, attachmentCount: 0, compactedEvidenceUnavailable: false };
			const classification = await engine.classify(snapshot, routes, AbortSignal.timeout(config.decision.timeoutMs));
			const verdict = decide({ cls: classification, pinnedRoute: undefined, currentModel: currentRef,
				routes: policyRoutes, contextTokens: 0, config: config.routing });
			const name = verdict.desiredRoute ?? "current";
			const target = name === "current" ? current : resolved.get(name);
			if (!target) throw new Error(`selected route ${name} cannot be resolved`);
			const admission = assessTargetContext({ branch: [], current, target, liveTokens: 0,
				prompt: task.prompt, imageCount: 0, fraction: config.routing.contextWindowFraction });
			// A fresh task has no inherited history or warm-cache cost. Still apply target-window admission.
			return { route: admission.kind === "estimated-fit" ? name : "current",
				costUsd: classification.costUsd, latencyMs: performance.now() - started };
		};
		const complete = async (task: BenchmarkTask, name: string): Promise<BenchmarkAnswer> => {
			const started = performance.now();
			const route = routes.find(candidate => candidate.name === name);
			const model = name === "current" ? current : resolved.get(name);
			if (!model) throw new Error(`completion route ${name} cannot be resolved`);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			if (!auth.apiKey) throw new Error(`no credentials for ${model.provider}`);
			const level = name === "current" ? currentThinking : route?.thinking;
			const reasoning = THINKING_EFFORTS.find(effort => effort === level);
			const message = await completeSimple(model, {
				systemPrompt: ["Solve the self-contained coding task. Return only the requested JSON value. Do not call tools."],
				messages: [{ role: "user", content: [{ type: "text", text: task.prompt }], timestamp: Date.now() }],
			}, { apiKey: auth.apiKey, headers: auth.headers, reasoning, disableReasoning: level === "off",
				maxTokens: Math.min(model.maxTokens ?? 4096, 4096), signal: AbortSignal.timeout(BENCHMARK_COMPLETION_TIMEOUT_MS) });
			return benchmarkReply(message, hasUsablePrices(model), performance.now() - started);
		};
		const result = await benchmarkTasks(tasks, baselines, select, complete);
		report = { ...result, engine: engine.label, maxOutputTokens: 4096, costBasis,
			modelAssignments: Object.fromEntries([...resolved].map(([name, model]) => [name, model && `${model.provider}/${model.id}`])),
			modelPricing: Object.fromEntries([...resolved].map(([name, model]) => [name, model && { status: model.pricingStatus, usable: hasUsablePrices(model), rates: model.cost }])) };
		summary = JSON.stringify({ routed: result.routed, baselines: result.baselines,
			costComparisons: result.costComparisons, limitation: result.limitation }, null, 2);
	}
	mkdirSync(logDir(), { recursive: true });
	const reportPath = join(logDir(), `${kind}-${crypto.randomUUID()}.json`);
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	return `${kind} report: ${reportPath}\n${summary}`;
}
