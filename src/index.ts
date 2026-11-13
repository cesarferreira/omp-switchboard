import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
	"/switchboard on | off | shadow | status | explain | stats | routes | setups | save <name> | use <name|none> | reload\n/switchboard-setup  (interactive: pick model + thinking per route)";

const MAX_STAMPS = 200;

export default function switchboard(pi: ExtensionAPI) {
	let loaded = loadConfig();
	let config: SwitchboardConfig = loaded.config;
	let override: Mode | undefined;
	let pinnedRoute: string | undefined;
	let engine: { key: string; value: DecisionEngine } | undefined;
	let last: DecisionRecord | undefined;
	let turn: { id: string; startedAt: number; toolCalls: number; toolErrors: number } | undefined;
	let handledPrompt: string | undefined;
	let pendingStamp: string | undefined;
	/** Display-only stamps keyed by the final assistant message's timestamp. */
	const stamps = new Map<number, string>();
	const keywords = new KeywordEngine();

	pi.setLabel("Switchboard");

	const reload = (ctx: ExtensionContext) => {
		loaded = loadConfig();
		config = loaded.config;
		engine = undefined;
		if (loaded.error) ctx.ui.notify(`switchboard: ${loaded.error}`, "warning");
	};

	pi.on("session_start", async (_e, ctx) => {
		// Assistant-text renderers only run while `extensionRenderers.assistantText` is on (default off).
		// `stamp: true` is the user's opt-in, so turn that setting on for this process unless they set it.
		// The registry subpath is documented but not part of the stable root exports, so it is loaded
		// lazily: if it ever moves, the stamp is lost and routing keeps working.
		if (config.stamp) {
			try {
				const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
				const setting = lookup("extensionRenderers.assistantText");
				if (setting && !setting.isConfigured(pi.pi.settings)) setting.override(pi.pi.settings, true);
			} catch (e) {
				pi.logger.warn("switchboard: cannot enable reply renderers; enable Tools > Extensions > Extension Reply Renderers for the stamp", {
					error: String(e),
				});
			}
		}
		pinnedRoute = undefined;
		last = undefined;
		handledPrompt = undefined;
		pendingStamp = undefined;
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
		const routes = resolveRoutes(config);
		const resolved = new Map<string, ModelRef | undefined>(
			routes.map(r => [r.name, r.model ? ctx.models.resolve(r.model) : undefined]),
		);
		const policyRoutes: PolicyRoute[] = routes.map(r => {
			const m = resolved.get(r.name);
			return { name: r.name, rank: r.rank, hasModel: r.model !== undefined, target: m && ref(m) };
		});
		const routeModels = Object.fromEntries(policyRoutes.map(r => [r.name, r.target]));

		const snapshot = buildSnapshot(ctx, event.prompt, currentModel, pinnedRoute, config.routing.historyMessages);
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
		cls ??= await keywords.classify(snapshot, routes);
		const engineLatencyMs = Date.now() - started;

		const verdict = decide({
			cls,
			pinnedRoute,
			currentModel,
			routes: policyRoutes,
			contextTokens: snapshot.contextTokens,
			config: config.routing,
		});

		const currentThinking = pi.getThinkingLevel();
		let applied = false;
		let reason = verdict.reason;
		let nextPin = verdict.pinnedRoute;
		const route = routes.find(r => r.name === verdict.desiredRoute);
		if (route && mode === "auto") {
			const target = resolved.get(route.name);
			try {
				if (verdict.switchModel && target) {
					if (await pi.setModel(target)) {
						applied = true;
					} else {
						reason += "; setModel refused (no credentials?)";
						nextPin = pinnedRoute;
					}
				}
				// setModel resets thinking to the model default, so always re-apply the route's level.
				if (nextPin === route.name && route.thinking && pi.getThinkingLevel() !== route.thinking) {
					// Config values are validated strings; the host's thinking enum members are the same strings.
					const level = route.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0];
					pi.setThinkingLevel(level);
					applied = true;
				}
			} catch (e) {
				reason += `; switch failed: ${e instanceof Error ? e.message : String(e)}`;
				nextPin = pinnedRoute;
			}
		}
		pinnedRoute = nextPin;

		if (route && config.stamp) {
			const target = routeModels[route.name] ?? currentModel;
			const via = cls.matched?.length ? `matched: ${cls.matched.map(k => `"${k}"`).join(", ")}` : `decided by ${engineLabel}`;
			const thinking = route.thinking ?? currentThinking;
			pendingStamp = `${mode === "shadow" ? "Switchboard (shadow, not applied)" : "Switchboard"}: ${route.name} → ${target} · thinking ${thinking} · ${via}`;
		} else {
			pendingStamp = undefined;
		}

		handledPrompt = event.prompt;
		const id = crypto.randomUUID();
		turn = { id, startedAt: Date.now(), toolCalls: 0, toolErrors: 0 };
		const record: DecisionRecord = {
			type: "decision",
			id,
			ts: Date.now(),
			sessionId: ctx.sessionManager.getSessionId(),
			mode,
			engine: engineLabel,
			engineLatencyMs,
			engineCostUsd: cls.costUsd,
			currentModel,
			currentThinking: String(currentThinking ?? "default"),
			routeModels,
			classification: {
				newTask: cls.newTask,
				newTaskConfidence: cls.newTaskConfidence,
				route: cls.route,
				routeConfidence: cls.routeConfidence,
				matched: cls.matched,
			},
			desiredRoute: verdict.desiredRoute,
			pinnedRoute,
			taskStart: verdict.taskStart,
			applied,
			wouldSwitch: verdict.switchModel,
			contextTokens: snapshot.contextTokens,
			reason,
			error,
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

	pi.on("tool_result", async event => {
		if (!turn) return;
		turn.toolCalls++;
		if (event.isError) turn.toolErrors++;
	});

	pi.on("agent_end", async (e, ctx) => {
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
			aborted: e.messages.some(m => m.role === "assistant" && m.stopReason === "aborted"),
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
		description: "Model router: on | off | shadow | status | explain | stats | routes | setups | save | use | reload",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
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
				case "status": {
					const d = config.decision.model ? resolveDecisionModel(ctx, config.decision.model) : undefined;
					return say(
						[
							`mode: ${effectiveMode(config, override)}${override ? " (session override)" : ""}`,
							`classifier: ${config.decision.model ? `${config.decision.model}${d ? ` [${d.api}]` : " (UNRESOLVED, falls back to keywords)"}` : "keywords"}`,
							`setup: ${activeSetup() ?? "none (top-level routes)"}`,
							`pinned route: ${pinnedRoute ?? "none"}`,
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
								? `classified: ${c.newTask ? "new task" : "follow-up"} (${c.newTaskConfidence.toFixed(2)}), route ${c.route} (${c.routeConfidence.toFixed(2)})${c.matched?.length ? `, matched ${c.matched.join(", ")}` : ""}`
								: "no classification",
							...(last.error ? [`classifier error: ${last.error}`] : []),
							`was on ${last.currentModel} (${last.contextTokens ?? "?"} ctx tokens)`,
							`decision: ${last.reason}`,
							last.applied ? "applied" : last.wouldSwitch ? "NOT applied (shadow)" : "no switch",
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
