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
	/** Relative strength for within-phase escalation; explicit phase changes can move either way. */
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
		/** Keep the route within a work phase; confident new tasks or phase changes may re-route. */
		sticky: boolean;
		/** Allow automatic higher-rank escalation within a phase. */
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
	/** Full request as typed; only the remote decision projection clips it. */
	latestRequest: string;
	/** Bounded recent user/assistant text and tool-result excerpts, oldest first. */
	recent: { role: string; text: string }[];
	/** Readable portable compaction summary for the current boundary, when one exists. */
	summary?: string;
	/** Images attached to the latest request; count only, never content. */
	attachmentCount: number;
	/** Compacted text history cannot be shown (provider-native placeholder or unlocatable retained boundary). */
	compactedEvidenceUnavailable: boolean;
	contextTokens: number | undefined;
	pinnedRoute: string | undefined;
}

export const TASK_INTENTS = ["continue", "phase_change", "new_task"] as const;
export type TaskIntent = typeof TASK_INTENTS[number];

export interface Classification {
	intent: TaskIntent;
	intentConfidence: number;
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
