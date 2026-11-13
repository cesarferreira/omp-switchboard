import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isObj } from "./config";
import type { Snapshot } from "./types";

const MAX_MESSAGE_CHARS = 1200;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(b => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []))
		.join("\n");
}

function clip(s: string): string {
	return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…` : s;
}

/** Last `limit` user/assistant text messages on the active branch, oldest first. */
export function recentMessages(ctx: ExtensionContext, limit: number): { role: string; text: string }[] {
	const out: { role: string; text: string }[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isObj(entry) || entry.type !== "message" || !isObj(entry.message)) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(content).trim();
		if (text) out.push({ role, text: clip(text) });
	}
	return out.slice(-limit);
}

export function buildSnapshot(
	ctx: ExtensionContext,
	prompt: string,
	currentModel: string,
	pinnedRoute: string | undefined,
	historyMessages: number,
): Snapshot {
	return {
		currentModel,
		latestRequest: clip(prompt),
		recent: recentMessages(ctx, historyMessages),
		contextTokens: ctx.getContextUsage()?.tokens ?? undefined,
		pinnedRoute,
	};
}
