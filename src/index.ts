import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	configPath,
	effectiveMode,
	loadConfig,
	patchRoute,
	readRawConfig,
	saveSetup,
	useSetup,
	writeRawConfig,
} from "./config";
import { createEngine, resolveDecisionModel } from "./engines";
import { appendLog, type DecisionRecord, readLog, summarize } from "./log";
import { decide, type PolicyRoute } from "./policy";
import { KeywordEngine, resolveRoutes } from "./routes";
import { buildSnapshot } from "./snapshot";
import { assessTargetContext, type ContextAssessment } from "./context-budget";
import { restoreCheckpoint, routeSignature, STATE_ENTRY, type RoutingCheckpoint } from "./state";
import { hasUsablePrices, summarizeExecutionUsage } from "./usage";
import { runEvaluationCommand } from "./evaluation-command";
import {
	type Classification,
	type DecisionEngine,
	type Mode,
	type RouteConfig,
	type SwitchboardConfig,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./types";

type ModelRef = NonNullable<ExtensionContext["model"]>;
const ref = (m: ModelRef): string => `${m.provider}/${m.id}`;

const USAGE =
	"/switchboard on | off | shadow | reset | status | explain | stats | routes | setups | save <name> | use <name|none> | reload | evaluate [file] | benchmark [file]\n/switchboard-setup  (interactive: pick model + thinking per route)";

const MAX_STAMPS = 200;

export default function switchboard(pi: ExtensionAPI) {
	let loaded = loadConfig();
	let config: SwitchboardConfig = loaded.config;
	let override: Mode | undefined;
	let pinnedRoute: string | undefined;
	let engine: { key: string; value: DecisionEngine } | undefined;
	let last: DecisionRecord | undefined;
	let turn: { id: string; startedAt: number; toolCalls: number; toolErrors: number; assistantMessages: AssistantMessage[] } | undefined;
	let handledPrompt: string | undefined;
	let pendingStamp: string | undefined;
	/** Model the session was left on by our last decision; a different one means a manual /model switch. */
	let expectedModel: string | undefined;
	let manualHold = false;
	let shadowPin: string | undefined;
	let activeSignature = "";
	let storedCheckpoint: RoutingCheckpoint | undefined;
	let fallbackPending = false;
	let agentRunning = false;
	let inputEpoch = 0;
	let provisionalModel: string | undefined;
	let pendingCheckpoint: { sessionId: string; afterId: string | null } | undefined;
	/** Display-only stamps keyed by the final assistant message's timestamp. */
	const stamps = new Map<number, string>();
	const keywords = new KeywordEngine();
	const rendererSetting = lookup("extensionRenderers.assistantText");
	const rendererSettingOn = (): boolean => rendererSetting?.get(pi.pi.settings) === true;

	pi.setLabel("Switchboard");

	const reload = (ctx: ExtensionContext) => {
		loaded = loadConfig();
		config = loaded.config;
		engine = undefined;
		if (loaded.error) ctx.ui.notify(`switchboard: ${loaded.error}`, "warning");
	};

	// Durable state is selected by ancestry, not by the last session visited in this process.
	const hydrate = (ctx: ExtensionContext, branch: readonly SessionEntry[] = ctx.sessionManager.getBranch()) => {
		const routes = resolveRoutes(config);
		const resolved = new Map(routes.map(r => [r.name, r.model ? ctx.models.resolve(r.model) : undefined]));
		activeSignature = routeSignature(routes.map(r => {
			const target = resolved.get(r.name);
			return { name: r.name, target: target && ref(target), thinking: r.thinking, rank: r.rank };
		}));
		const names: Record<string, true> = Object.fromEntries(routes.map(r => [r.name, true]));
		const state = restoreCheckpoint(branch, activeSignature, names);
		pinnedRoute = state?.pinnedRoute ?? undefined;
		expectedModel = state?.expectedModel ?? undefined;
		manualHold = state?.manualHold ?? false;
		fallbackPending = state?.fallbackPending ?? false;
		storedCheckpoint = state;
		return { branch, routes, resolved };
	};
	const persist = () => {
		const state: RoutingCheckpoint = { version: 1, pinnedRoute: pinnedRoute ?? null,
			expectedModel: expectedModel ?? null, manualHold, routeSignature: activeSignature, fallbackPending };
		if (storedCheckpoint && state.pinnedRoute === storedCheckpoint.pinnedRoute
			&& state.expectedModel === storedCheckpoint.expectedModel && state.manualHold === storedCheckpoint.manualHold
			&& state.routeSignature === storedCheckpoint.routeSignature
			&& state.fallbackPending === (storedCheckpoint.fallbackPending ?? false)) return;
		pi.appendEntry(STATE_ENTRY, state);
		storedCheckpoint = state;
	};
	// Save a decision only after its user message is durable, never as that message's parent.
	const commitPending = (ctx: ExtensionContext) => {
		if (!pendingCheckpoint || pendingCheckpoint.sessionId !== ctx.sessionManager.getSessionId()) return;
		const branch = ctx.sessionManager.getBranch();
		let hasUser = false;
		let foundParent = pendingCheckpoint.afterId === null;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.id === pendingCheckpoint.afterId) { foundParent = true; break; }
			if (entry.type === "message" && entry.message.role === "user") hasUser = true;
		}
		if (!foundParent || !hasUser) return;
		persist();
		pendingCheckpoint = undefined;
		provisionalModel = undefined;
	};
	const enterSession = (ctx: ExtensionContext) => {
		reload(ctx);
		hydrate(ctx);
		last = undefined;
		turn = undefined;
		handledPrompt = undefined;
		pendingStamp = undefined;
		shadowPin = undefined;
		agentRunning = false;
		inputEpoch++;
		pendingCheckpoint = undefined;
		provisionalModel = undefined;
	};
	pi.on("session_start", async (_e, ctx) => {
		enterSession(ctx);
		if (config.stamp && rendererSetting && !rendererSetting.isConfigured(pi.pi.settings)) {
			rendererSetting.override(pi.pi.settings, true);
		}
	});
	pi.on("session_switch", async (_e, ctx) => { override = undefined; enterSession(ctx); });
	const navigate = (ctx: ExtensionContext) => {
		enterSession(ctx);
		// Tree/branch navigation preserves the live model; a historical expectation is not a manual choice.
		if (expectedModel !== undefined && ctx.model && expectedModel !== ref(ctx.model)) {
			expectedModel = undefined;
			persist();
		}
	};
	pi.on("session_branch", async (_e, ctx) => { override = undefined; navigate(ctx); });
	pi.on("session_tree", async (_e, ctx) => { navigate(ctx); });
	pi.on("input", async (_e, ctx) => {
		if (ctx.agent.kind !== "main" || agentRunning) return;
		inputEpoch++;
		turn = undefined;
		handledPrompt = undefined;
		pendingStamp = undefined;
		pendingCheckpoint = undefined;
	});
	pi.on("agent_start", async () => { agentRunning = true; });
	pi.on("message_end", async (event, ctx) => {
		// Settled events can contain earlier context; collect only calls emitted while this run is open.
		if (turn && event.message.role === "assistant") turn.assistantMessages.push(event.message);
		// OMP queues message persistence before notifying extensions; later events also retry this check.
		await Promise.resolve();
		commitPending(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.reason !== "prompt" || ctx.agent.kind !== "main") return;
		const mode = effectiveMode(config, override);
		if (mode === "off" || !ctx.model) return;
		if (agentRunning) return;
		if (handledPrompt === event.prompt) return;

		const { branch, routes, resolved } = hydrate(ctx);
		const currentModel = ref(ctx.model);
		const epoch = inputEpoch;
		if (provisionalModel === currentModel) expectedModel = undefined;
		if (mode === "auto" && !manualHold && expectedModel !== undefined && currentModel !== expectedModel) {
			manualHold = true;
			persist();
			ctx.ui.notify("switchboard: model changed by hand; routing paused (/switchboard on to resume)", "info");
		}
		if (mode === "auto" && manualHold) return;
		const pin = mode === "shadow" ? shadowPin ?? pinnedRoute : pinnedRoute;
		const policyRoutes: PolicyRoute[] = routes.map(r => {
			const m = resolved.get(r.name);
			return { name: r.name, rank: r.rank, hasModel: r.model !== undefined,
				target: m && ref(m), contextWindow: m?.contextWindow ?? undefined };
		});
		const routeModels = Object.fromEntries(policyRoutes.map(r => [r.name, r.target]));
		const snapshot = buildSnapshot(ctx, event.prompt, currentModel, pin, config.routing.historyMessages, event.images, branch);
		const started = Date.now();
		let cls: Classification | undefined;
		let error: string | undefined;
		let engineLabel = keywords.label;
		try {
			if (config.decision.model) {
				if (engine?.key !== config.decision.model) {
					engine = { key: config.decision.model, value: await createEngine(ctx, config) };
				}
				engineLabel = engine.value.label;
				cls = await engine.value.classify(snapshot, routes, AbortSignal.timeout(config.decision.timeoutMs));
			}
		} catch (e) {
			error = `${e instanceof Error ? e.message : String(e)}; fell back to keywords`;
			engineLabel = `${config.decision.model} (failed)`;
		}
		const usedKeywords = cls === undefined;
		cls ??= await keywords.classify(snapshot, routes);
		if (epoch !== inputEpoch) return;
		const unclassified = usedKeywords && pin === undefined && !cls.matched?.length;
		const engineLatencyMs = Date.now() - started;
		const verdict = decide({ cls, pinnedRoute: pin, currentModel, routes: policyRoutes,
			contextTokens: snapshot.contextTokens, config: config.routing });
		const currentThinking = pi.getThinkingLevel();
		let reason = verdict.reason;
		let nextPin = verdict.pinnedRoute;
		let admitted = true;
		let contextAssessment: ContextAssessment | undefined;
		const route = routes.find(r => r.name === verdict.desiredRoute);
		const target = route && resolved.get(route.name);
		if (verdict.switchModel && target) {
			contextAssessment = assessTargetContext({ branch, current: ctx.model, target,
				liveTokens: snapshot.contextTokens, prompt: event.prompt, imageCount: event.images?.length ?? 0,
				fraction: config.routing.contextWindowFraction });
			admitted = contextAssessment.kind === "estimated-fit";
			if (!admitted) {
				nextPin = pin;
				reason = `context guard: ${contextAssessment.reason}; keeping ${currentModel}`;
				if (mode === "auto") ctx.ui.notify(`switchboard: ${reason}`, "info");
			}
		}
		if (route && mode === "auto" && admitted) {
			try {
				if (verdict.switchModel && target && !await pi.setModel(target)) {
					reason += "; setModel refused (no credentials?)";
					nextPin = pin;
					admitted = false;
				}
				if (admitted && nextPin === route.name && route.thinking && pi.getThinkingLevel() !== route.thinking) {
					const level = route.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0];
					pi.setThinkingLevel(level);
				}
			} catch (e) {
				reason += `; switch failed: ${e instanceof Error ? e.message : String(e)}`;
				nextPin = pin;
			}
		}
		const resultModel = ctx.models.current();
		const resultRef = resultModel ? ref(resultModel) : currentModel;
		const modelChanged = mode === "auto" && resultRef !== currentModel;
		const thinkingChanged = mode === "auto" && pi.getThinkingLevel() !== currentThinking;
		if (unclassified) {
			nextPin = undefined;
			reason += "; no keyword match; task remains unpinned";
		}
		if (mode === "auto") {
			pinnedRoute = nextPin;
			if (modelChanged) { fallbackPending = false; provisionalModel = resultRef; }
			expectedModel = fallbackPending ? undefined : resultRef;
			pendingCheckpoint = { sessionId: ctx.sessionManager.getSessionId(), afterId: branch.at(-1)?.id ?? null };
		} else {
			shadowPin = nextPin;
		}
		if (route && config.stamp) {
			const shownModel = mode === "shadow" && admitted ? routeModels[route.name] ?? currentModel : resultRef;
			const via = cls.matched?.length ? `matched: ${cls.matched.map(k => `"${k}"`).join(", ")}` : `decided by ${engineLabel}`;
			const thinking = mode === "shadow" && admitted ? route.thinking ?? currentThinking : pi.getThinkingLevel();
			pendingStamp = `${mode === "shadow" ? "Switchboard (shadow, not applied)" : "Switchboard"}: ${route.name} → ${shownModel} · thinking ${thinking} · ${via}`;
		} else pendingStamp = undefined;
		handledPrompt = event.prompt;
		const id = crypto.randomUUID();
		turn = { id, startedAt: Date.now(), toolCalls: 0, toolErrors: 0, assistantMessages: [] };
		const record: DecisionRecord = {
			type: "decision", id, ts: Date.now(), sessionId: ctx.sessionManager.getSessionId(), mode,
			engine: engineLabel, engineLatencyMs, engineCostUsd: error ? undefined : usedKeywords ? 0 : cls.costUsd, currentModel,
			currentThinking: String(currentThinking ?? "default"), routeModels,
			classification: { intent: cls.intent, intentConfidence: cls.intentConfidence,
				route: cls.route, routeConfidence: cls.routeConfidence, matched: cls.matched },
			desiredRoute: verdict.desiredRoute, pinnedRoute: mode === "shadow" ? shadowPin : pinnedRoute,
			taskStart: verdict.taskStart && !unclassified, applied: modelChanged || thinkingChanged,
			phaseChange: verdict.phaseChange && nextPin !== pin && nextPin === route?.name,
			modelChanged, thinkingChanged, resultModel: resultRef, contextAssessment,
			wouldSwitch: verdict.switchModel && admitted, contextTokens: snapshot.contextTokens, reason, error,
			promptPreview: config.logPrompts ? event.prompt.slice(0, 120) : undefined,
		};
		last = record;
		if (config.logging) appendLog(record);
	});

	// The stamp is display-only: remember it per final assistant message and draw it in the renderer,
	// so the session, exports and model context keep the reply as written.
	pi.on("assistant_message", async (event, ctx) => {
		if (!pendingStamp) return;
		const { content, timestamp } = event.message;
		if (!Array.isArray(content) || content.some(b => b.type === "toolCall") || !content.some(b => b.type === "text")) return;
		stamps.set(timestamp, pendingStamp);
		pendingStamp = undefined;
		if (stamps.size > MAX_STAMPS) stamps.delete(stamps.keys().next().value!);
		// The renderer caches a sealed block; ask for a redraw now that the stamp exists.
		ctx.ui.rerenderMessage(timestamp);
	});

	pi.registerAssistantTextRenderer(({ message, contentIndex, text, streaming }) => {
		if (streaming) return;
		const stamp = stamps.get(message.timestamp);
		if (!stamp || message.content.findLastIndex(b => b.type === "text") !== contentIndex) return;
		return `${text}\n\n---\n_${stamp}_`;
	});

	// Auto-retry may swap the model under us; forget what we expected so that is not mistaken for a manual choice.
	pi.on("retry_fallback_applied", async (_event, ctx) => {
		if (!pendingCheckpoint) hydrate(ctx);
		expectedModel = undefined;
		fallbackPending = true;
		if (pendingCheckpoint) commitPending(ctx);
		else persist();
	});

	pi.on("tool_result", async event => {
		if (!turn) return;
		turn.toolCalls++;
		if (event.isError) turn.toolErrors++;
	});

	pi.on("agent_end", async (e, ctx) => {
		commitPending(ctx);
		// The loop has not settled (automatic continuation or waiting on background jobs): the run is still open.
		if (e.willContinue) return;
		agentRunning = false;
		pendingCheckpoint = undefined;
		const finished = turn;
		turn = undefined;
		handledPrompt = undefined;
		pendingStamp = undefined;
		if (!finished || !config.logging) return;
		appendLog({
			type: "outcome",
			id: finished.id,
			ts: Date.now(),
			model: ctx.model ? ref(ctx.model) : "unknown",
			durationMs: Date.now() - finished.startedAt,
			toolCalls: finished.toolCalls,
			toolErrors: finished.toolErrors,
			usage: summarizeExecutionUsage(finished.assistantMessages, (provider, id) => {
				const model = ctx.modelRegistry.find(provider, id);
				return model !== undefined && hasUsablePrices(model);
			}),
			aborted: finished.assistantMessages.some(message => message.stopReason === "aborted"),
		});
	});

	/** Edit the raw config file, then reload. Surfaces parse/write errors instead of throwing into the TUI. */
	const editConfig = (ctx: ExtensionContext, edit: (raw: Record<string, unknown>) => string | undefined) => {
		try {
			const raw = readRawConfig();
			const failure = edit(raw);
			if (failure) return ctx.ui.notify(`switchboard: ${failure}`, "warning");
			writeRawConfig(raw);
			reload(ctx);
			return true;
		} catch (e) {
			ctx.ui.notify(`switchboard: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	};

	const activeSetup = (): string | undefined =>
		config.activeSetup && config.setups[config.activeSetup] ? config.activeSetup : undefined;

	pi.registerCommand("switchboard", {
		description: "Model router: on | off | shadow | reset | status | explain | stats | routes | setups | save | use | reload | evaluate | benchmark",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			hydrate(ctx);
			const say = (s: string) => ctx.ui.notify(s, "info");
			switch (sub) {
				case "evaluate":
				case "benchmark":
					try {
						return say(await runEvaluationCommand(sub, rest.length ? rest.join(" ") : undefined, ctx, config, pi.getThinkingLevel()));
					} catch (error) {
						ctx.ui.notify(`switchboard ${sub}: ${error instanceof Error ? error.message : String(error)}`, "error");
						return;
					}
				case "on":
					override = "auto";
					manualHold = false;
					expectedModel = undefined;
					shadowPin = undefined;
					persist();
					return say("switchboard: auto (switches models)");
				case "off":
					override = "off";
					return say("switchboard: off");
				case "shadow":
					override = "shadow";
					shadowPin = pinnedRoute;
					return say("switchboard: shadow (logs recommendations, never switches)");
				case "reset":
					pinnedRoute = undefined;
					shadowPin = undefined;
					expectedModel = undefined;
					persist();
					return say("switchboard: task pin reset; the next prompt may choose a fresh route");
				case "reload":
					reload(ctx);
					hydrate(ctx);
					return say(`switchboard: config reloaded from ${configPath()}`);
				case "status": {
					const d = config.decision.model ? resolveDecisionModel(ctx, config.decision.model) : undefined;
					return say(
						[
							`mode: ${effectiveMode(config, override)}${override ? " (session override)" : ""}`,
							`classifier: ${config.decision.model ? `${config.decision.model}${d ? ` [${d.api}]` : " (UNRESOLVED, falls back to keywords)"}` : "keywords"}`,
							`setup: ${activeSetup() ?? "none (top-level routes)"}`,
							`stamp: ${config.stamp ? (rendererSettingOn() ? "on" : "on, but Extension Reply Renderers is off (Tools > Extensions)") : "off"}`,
							`pinned route: ${pinnedRoute ?? "none"}`,
							`routing: ${manualHold ? "paused: you chose a model by hand (/switchboard on to resume)" : "active"}`,
							`current: ${ctx.model ? ref(ctx.model) : "none"} / thinking ${pi.getThinkingLevel()}`,
							`config: ${configPath()}`,
						].join("\n"),
					);
				}
				case "routes": {
					const rows = resolveRoutes(config).map(r => {
						const m = r.model ? ctx.models.resolve(r.model) : undefined;
						const model = r.model ? `${r.model} -> ${m ? ref(m) : "UNRESOLVED"}` : "keep current model";
						return `${r.name} (rank ${r.rank}): ${model}, thinking ${r.thinking ?? "unchanged"}, ${r.keywords.length} keywords`;
					});
					return say(rows.join("\n"));
				}
				case "setups": {
					const names = Object.keys(config.setups);
					if (names.length === 0) return say("switchboard: no setups. Use /switchboard save <name>");
					return say(names.map(n => `${n === activeSetup() ? "*" : " "} ${n}`).join("\n"));
				}
				case "save": {
					const name = rest[0];
					if (!name || !/^[\w.-]+$/.test(name) || name === "none") {
						return ctx.ui.notify("switchboard: usage /switchboard save <name> (letters, digits, . _ -)", "warning");
					}
					const snapshot: Record<string, RouteConfig> = Object.fromEntries(
						resolveRoutes(config).map(r => [
							r.name,
							{ model: r.model, thinking: r.thinking, keywords: r.keywords, description: r.description, rank: r.rank },
						]),
					);
					const ok = editConfig(ctx, raw => void saveSetup(raw, name, snapshot));
					return ok && say(`switchboard: saved and activated setup "${name}"`);
				}
				case "use": {
					const name = rest[0];
					if (!name) return say(`setups: ${Object.keys(config.setups).join(", ") || "(none)"}; use <name> or use none`);
					const ok = editConfig(ctx, raw => (useSetup(raw, name) ? undefined : `no setup named "${name}"`));
					return ok && say(name === "none" ? "switchboard: using top-level routes" : `switchboard: using setup "${name}"`);
				}
				case "stats":
					return say(summarize(readLog()));
				case "explain": {
					if (!last) return say("switchboard: no decision recorded this session yet");
					const c = last.classification;
					return say(
						[
							`mode ${last.mode}; classifier ${last.engine} (${last.engineLatencyMs}ms)`,
							c
								? `classified: ${c.intent ?? "legacy boundary"} (${c.intentConfidence?.toFixed(2) ?? "?"}), route ${c.route} (${c.routeConfidence.toFixed(2)})${c.matched?.length ? `, matched ${c.matched.join(", ")}` : ""}`
								: "no classification",
							...(last.error ? [`classifier error: ${last.error}`] : []),
							`was on ${last.currentModel} (${last.contextTokens ?? "?"} ctx tokens)`,
							`decision: ${last.reason}`,
							`now on ${last.resultModel ?? "unknown (legacy record)"}; model ${last.modelChanged ? "changed" : "unchanged"}, thinking ${last.thinkingChanged ? "changed" : "unchanged"}`,
							...(last.contextAssessment ? [`context admission (metadata estimate): ${JSON.stringify(last.contextAssessment)}`] : []),
							last.mode === "shadow" ? "shadow: not applied" : last.applied ? "applied" : "no mutation",
						].join("\n"),
					);
				}
				case "help":
					return say(USAGE);
				default:
					return ctx.ui.notify(`switchboard: unknown subcommand "${sub}"\n${USAGE}`, "warning");
			}
		},
	});

	pi.registerCommand("switchboard-setup", {
		description: "Interactively pick a model and thinking level for each route",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return ctx.ui.notify("switchboard-setup needs an interactive session", "warning");
			const refs = ctx.models.list().map(ref).sort();
			const setup = activeSetup();
			const patches: [string, RouteConfig][] = [];
			for (const r of resolveRoutes(config)) {
				const keepModel = `keep (${r.model ?? "current model"})`;
				const model = await ctx.ui.select(`Route "${r.name}": model`, [keepModel, "(current model: no switch)", ...refs]);
				if (model === undefined) return ctx.ui.notify("switchboard: setup cancelled; nothing saved", "info");
				const keepThinking = `keep (${r.thinking ?? "unchanged"})`;
				const thinking = await ctx.ui.select(`Route "${r.name}": thinking`, [keepThinking, "(unchanged)", ...THINKING_LEVELS]);
				if (thinking === undefined) return ctx.ui.notify("switchboard: setup cancelled; nothing saved", "info");
				const patch: RouteConfig = {};
				if (model === "(current model: no switch)") patch.model = "";
				else if (model !== keepModel) patch.model = model;
				if (thinking !== keepThinking && thinking !== "(unchanged)") patch.thinking = thinking as ThinkingLevel;
				if (Object.keys(patch).length) patches.push([r.name, patch]);
			}
			if (patches.length === 0) return ctx.ui.notify("switchboard: no changes", "info");
			const ok = editConfig(ctx, raw => {
				for (const [name, patch] of patches) patchRoute(raw, name, patch, setup);
				return undefined;
			});
			if (ok) ctx.ui.notify(`switchboard: updated ${patches.length} route(s) in ${setup ? `setup "${setup}"` : "top-level routes"}`, "info");
		},
	});
}
