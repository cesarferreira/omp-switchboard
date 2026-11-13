import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configPath, effectiveMode, loadConfig } from "./config";
import { createEngine, resolveDecisionModel } from "./engines";
import { appendLog, type DecisionRecord, readLog, summarize } from "./log";
import { decide } from "./policy";
import { buildSnapshot } from "./snapshot";
import { type Classification, type DecisionEngine, type Mode, type SwitchboardConfig, TIERS, type Tier } from "./types";

type ModelRef = NonNullable<ExtensionContext["model"]>;
const ref = (m: ModelRef): string => `${m.provider}/${m.id}`;

export default function switchboard(pi: ExtensionAPI) {
	let loaded = loadConfig();
	let config: SwitchboardConfig = loaded.config;
	let override: Mode | undefined;
	let pinnedTier: Tier | undefined;
	let engine: { key: string; value: DecisionEngine } | undefined;
	let last: DecisionRecord | undefined;
	let turn: { id: string; startedAt: number; toolCalls: number; toolErrors: number } | undefined;
	let handledPrompt: string | undefined;

	pi.setLabel("Switchboard");

	const reload = (ctx: ExtensionContext) => {
		loaded = loadConfig();
		config = loaded.config;
		engine = undefined;
		if (loaded.error) ctx.ui.notify(`switchboard: ${loaded.error}`, "warning");
	};

	pi.on("session_start", async (_e, ctx) => {
		pinnedTier = undefined;
		last = undefined;
		handledPrompt = undefined;
		reload(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.reason !== "prompt" || ctx.agent.kind !== "main") return;
		const mode = effectiveMode(config, override);
		if (mode === "off" || !ctx.model) return;
		// The chain re-fires for the same submission and for steer/follow-up batches mid-run.
		// Route once per run: skip while a run is open so counters and the pin stay stable.
		if (turn && !ctx.isIdle()) return;
		// Same-submission policy retries fire before agent_start; the memo is cleared in agent_end.
		if (handledPrompt === event.prompt) return;

		const currentModel = ref(ctx.model);
		const resolved: Record<Tier, ModelRef | undefined> = {
			fast: ctx.models.resolve(config.tiers.fast.model),
			standard: ctx.models.resolve(config.tiers.standard.model),
			deep: ctx.models.resolve(config.tiers.deep.model),
		};
		const tierModels: Record<Tier, string | undefined> = {
			fast: resolved.fast && ref(resolved.fast),
			standard: resolved.standard && ref(resolved.standard),
			deep: resolved.deep && ref(resolved.deep),
		};

		const snapshot = buildSnapshot(ctx, event.prompt, currentModel, pinnedTier, config.routing.historyMessages);
		const started = Date.now();
		let cls: Classification | undefined;
		let error: string | undefined;
		let engineLabel = config.decision.model;
		try {
			if (engine?.key !== config.decision.model) {
				engine = { key: config.decision.model, value: await createEngine(ctx, config) };
			}
			engineLabel = engine.value.label;
			cls = await engine.value.classify(snapshot, AbortSignal.timeout(config.decision.timeoutMs));
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		const engineLatencyMs = Date.now() - started;

		const verdict = decide({
			cls,
			pinnedTier,
			currentModel,
			tierModels,
			contextTokens: snapshot.contextTokens,
			config: config.routing,
		});

		const currentThinking = pi.getThinkingLevel();
		let applied = false;
		let reason = verdict.reason;
		let nextPin = verdict.pinnedTier;
		if (verdict.desiredTier && mode === "auto") {
			const target = resolved[verdict.desiredTier];
			const tierCfg = config.tiers[verdict.desiredTier];
			try {
				if (verdict.switchModel && target) {
					if (await pi.setModel(target)) {
						applied = true;
					} else {
						reason += "; setModel refused (no credentials?)";
						nextPin = pinnedTier;
					}
				}
				// setModel resets thinking to the model default, so always re-apply the tier's level.
				if (nextPin === verdict.desiredTier && tierCfg.thinking && pi.getThinkingLevel() !== tierCfg.thinking) {
					pi.setThinkingLevel(tierCfg.thinking);
					applied = true;
				}
			} catch (e) {
				reason += `; switch failed: ${e instanceof Error ? e.message : String(e)}`;
				nextPin = pinnedTier;
			}
		}
		pinnedTier = nextPin;

		handledPrompt = event.prompt;
		const id = crypto.randomUUID();
		turn = { id, startedAt: Date.now(), toolCalls: 0, toolErrors: 0 };
		last = {
			type: "decision",
			id,
			ts: Date.now(),
			sessionId: ctx.sessionManager.getSessionId(),
			mode,
			engine: engineLabel,
			engineLatencyMs,
			engineCostUsd: cls?.costUsd,
			currentModel,
			currentThinking,
			tierModels,
			classification: cls && {
				newTask: cls.newTask,
				newTaskConfidence: cls.newTaskConfidence,
				tier: cls.tier,
				tierConfidence: cls.tierConfidence,
			},
			desiredTier: verdict.desiredTier,
			pinnedTier,
			taskStart: verdict.taskStart,
			applied,
			wouldSwitch: verdict.switchModel,
			contextTokens: snapshot.contextTokens,
			reason,
			error,
			promptPreview: config.logPrompts ? event.prompt.slice(0, 120) : undefined,
		};
		if (config.logging) appendLog(last);
	});

	pi.on("tool_result", async event => {
		if (!turn) return;
		turn.toolCalls++;
		if (event.isError) turn.toolErrors++;
	});

	pi.on("agent_end", async (e, ctx) => {
		const finished = turn;
		turn = undefined;
		handledPrompt = undefined;
		if (!finished || !config.logging) return;
		appendLog({
			type: "outcome",
			id: finished.id,
			ts: Date.now(),
			model: ctx.model ? ref(ctx.model) : "unknown",
			durationMs: Date.now() - finished.startedAt,
			toolCalls: finished.toolCalls,
			toolErrors: finished.toolErrors,
			aborted: e.messages.some(m => m.role === "assistant" && m.stopReason === "aborted"),
		});
	});

	pi.registerCommand("switchboard", {
		description: "Model router: on | off | shadow | status | explain | stats | models | reload",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "status";
			const say = (s: string) => ctx.ui.notify(s, "info");
			switch (sub) {
				case "on":
					override = "auto";
					return say("switchboard: auto (switches models)");
				case "off":
					override = "off";
					return say("switchboard: off");
				case "shadow":
					override = "shadow";
					return say("switchboard: shadow (logs recommendations, never switches)");
				case "reload":
					reload(ctx);
					return say(`switchboard: config reloaded from ${configPath()}`);
				case "status":
					return say(
						[
							`mode: ${effectiveMode(config, override)}${override ? " (session override)" : ""}`,
							`decision model: ${config.decision.model}`,
							`pinned tier: ${pinnedTier ?? "none"}`,
							`current: ${ctx.model ? ref(ctx.model) : "none"} / thinking ${pi.getThinkingLevel()}`,
							`config: ${configPath()}`,
						].join("\n"),
					);
				case "models": {
					const rows = TIERS.map(t => {
						const m = ctx.models.resolve(config.tiers[t].model);
						return `${t}: ${config.tiers[t].model} -> ${m ? ref(m) : "UNRESOLVED"} (${config.tiers[t].thinking ?? "default"})`;
					});
					const d = resolveDecisionModel(ctx, config.decision.model);
					rows.push(`decision: ${config.decision.model} -> ${d ? `${ref(d)} [${d.api}]` : "UNRESOLVED"}`);
					return say(rows.join("\n"));
				}
				case "stats":
					return say(summarize(readLog()));
				case "explain": {
					if (!last) return say("switchboard: no decision recorded this session yet");
					const c = last.classification;
					return say(
						[
							`mode ${last.mode}; engine ${last.engine} (${last.engineLatencyMs}ms)`,
							c
								? `classified: ${c.newTask ? "new task" : "follow-up"} (${c.newTaskConfidence.toFixed(2)}), tier ${c.tier} (${c.tierConfidence.toFixed(2)})`
								: `classification failed: ${last.error ?? "unknown"}`,
							`was on ${last.currentModel} (${last.contextTokens ?? "?"} ctx tokens)`,
							`decision: ${last.reason}`,
							last.applied ? "applied" : last.wouldSwitch ? "NOT applied (shadow)" : "no switch",
						].join("\n"),
					);
				}
				default:
					return ctx.ui.notify(`switchboard: unknown subcommand "${sub}"`, "warning");
			}
		},
	});
}
