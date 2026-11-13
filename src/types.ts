export type Tier = "fast" | "standard" | "deep";
export const TIERS: readonly Tier[] = ["fast", "standard", "deep"];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

export type Mode = "auto" | "shadow" | "off";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TierConfig {
	/** `provider/id`, bare id, or role alias such as `@smol`. */
	model: string;
	thinking?: ThinkingLevel;
}

export interface SwitchboardConfig {
	enabled: boolean;
	mode: Mode;
	decision: {
		/** Model (or role alias) that answers the routing question. A judgment-API model (`openai-decisions`, ...) uses the native judge; any chat model is prompted. */
		model: string;
		timeoutMs: number;
	};
	routing: {
		/** Keep the pinned tier across follow-ups; only re-route on a new task. */
		sticky: boolean;
		/** In a sticky task, allow upgrading (never downgrading) when a follow-up is harder. */
		allowEscalation: boolean;
		/** Refuse non-escalating model switches when the conversation is large. */
		cacheAware: boolean;
		cacheGuardTokens: number;
		/** Below this classifier confidence, keep the current model. */
		minConfidence: number;
		/** Number of recent messages given to the decision model. */
		historyMessages: number;
	};
	tiers: Record<Tier, TierConfig>;
	logging: boolean;
	/** Store a prompt preview in the log. Off by default. */
	logPrompts: boolean;
}

export interface Snapshot {
	currentModel: string;
	latestRequest: string;
	recent: { role: string; text: string }[];
	contextTokens: number | undefined;
	pinnedTier: Tier | undefined;
}

export interface Classification {
	newTask: boolean;
	newTaskConfidence: number;
	tier: Tier;
	tierConfidence: number;
	costUsd?: number;
}

export interface DecisionEngine {
	readonly label: string;
	classify(snapshot: Snapshot, signal: AbortSignal): Promise<Classification>;
}
