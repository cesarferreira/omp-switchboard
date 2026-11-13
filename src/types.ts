export type Mode = "auto" | "shadow" | "off";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** One route as written in config. Every field is optional; unset fields inherit the built-in route of the same name. */
export interface RouteConfig {
	/** `provider/id`, bare id, or role alias such as `@smol`. Unset keeps the current model. */
	model?: string;
	thinking?: ThinkingLevel;
	/** Phrases that select this route. Setting it replaces the built-in list. */
	keywords?: string[];
	/** What the route is for; shown to the decision model. */
	description?: string;
	/** Relative strength. A follow-up may escalate to a higher rank, never down. */
	rank?: number;
}

export interface ResolvedRoute {
	name: string;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	keywords: string[];
	description: string;
	rank: number;
}

export interface SetupConfig {
	routes: Record<string, RouteConfig>;
}

export interface SwitchboardConfig {
	enabled: boolean;
	mode: Mode;
	decision: {
		/**
		 * Optional. Model (or role alias) that picks the route. A judgment-API model
		 * (`openai-decisions`, ...) uses the native judge; any chat model is prompted.
		 * Empty means keyword matching only.
		 */
		model: string;
		timeoutMs: number;
	};
	routing: {
		/** Keep the pinned route across follow-ups; only re-route on a new task. */
		sticky: boolean;
		/** In a sticky task, allow moving to a higher-rank route (never lower). */
		allowEscalation: boolean;
		/** Refuse non-escalating model switches when the conversation is large. */
		cacheAware: boolean;
		cacheGuardTokens: number;
		/** Refuse a switch when the conversation exceeds this fraction of the target model's context window. */
		contextWindowFraction: number;
		/** Below this decision-model confidence, keep the current model. */
		minConfidence: number;
		/** Number of recent messages given to the decision model. */
		historyMessages: number;
	};
	routes: Record<string, RouteConfig>;
	activeSetup?: string;
	setups: Record<string, SetupConfig>;
	/** Append a one-line stamp to the final response of each routed run. */
	stamp: boolean;
	logging: boolean;
	/** Store a prompt preview in the log. Off by default. */
	logPrompts: boolean;
}

export interface Snapshot {
	currentModel: string;
	latestRequest: string;
	recent: { role: string; text: string }[];
	contextTokens: number | undefined;
	pinnedRoute: string | undefined;
}

export interface Classification {
	newTask: boolean;
	newTaskConfidence: number;
	route: string;
	routeConfidence: number;
	/** Keywords that matched (keyword engine only). */
	matched?: string[];
	costUsd?: number;
}

export interface DecisionEngine {
	readonly label: string;
	classify(snapshot: Snapshot, routes: ResolvedRoute[], signal: AbortSignal): Promise<Classification>;
}
