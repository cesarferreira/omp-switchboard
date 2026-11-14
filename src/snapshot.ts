import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { getOpenAiRemoteCompactionPayload, getReadableCompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isObj } from "./config";
import type { Snapshot } from "./types";

/** Classifier text budgets (characters, not tokens). Internal, not configuration. */
export const LATEST_REQUEST_CHARS = 8000;
export const SUMMARY_CHARS = 4000;
export const RECENT_TOTAL_CHARS = 12000;
export const RECENT_ITEM_CHARS = 1200;
/** Recent tool-result excerpts, on top of the configured user/assistant message count. */
export const MAX_TOOL_RESULTS = 4;

/** Below this many remaining characters a clipped excerpt carries no signal; stop rather than emit a fragment. */
const MIN_EXCERPT_CHARS = 64;
const MAX_TOOL_NAME_CHARS = 80;

export const OMISSION_MARKER = "\n…[middle omitted]…\n";

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Keep the beginning and end of `text`, replacing the middle with {@link OMISSION_MARKER}.
 * The result, marker included, is at most `maxChars` UTF-16 units and never splits a surrogate
 * pair. Remaining space is split evenly; the beginning gets the odd unit. Text within the
 * maximum is returned unchanged. When `maxChars` cannot hold the marker plus both ends, only
 * the beginning is kept.
 */
export function clipMiddle(text: string, maxChars: number): string {
	const max = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
	if (text.length <= max) return text;
	const room = max - OMISSION_MARKER.length;
	if (room < 2) {
		let end = max;
		if (end > 0 && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end--;
		return text.slice(0, end);
	}
	let headEnd = Math.ceil(room / 2);
	if (isHigh(text.charCodeAt(headEnd - 1)) && isLow(text.charCodeAt(headEnd))) headEnd--;
	let tailStart = text.length - Math.floor(room / 2);
	if (isLow(text.charCodeAt(tailStart)) && isHigh(text.charCodeAt(tailStart - 1))) tailStart++;
	return text.slice(0, headEnd) + OMISSION_MARKER + text.slice(tailStart);
}

/** Fit one evidence excerpt into `remaining` characters (and the per-item cap), or `undefined` if no useful room is left. */
function fitExcerpt(text: string, remaining: number): string | undefined {
	const cap = Math.min(RECENT_ITEM_CHARS, remaining);
	if (cap <= 0) return undefined;
	if (text.length <= cap) return text;
	return cap >= MIN_EXCERPT_CHARS ? clipMiddle(text, cap) : undefined;
}

/**
 * Apply the item and combined budgets to chronologically ordered evidence. Newest items are
 * kept first; the result is chronological again. Idempotent for already-bounded input.
 */
export function boundRecent(items: readonly { role: string; text: string }[]): { role: string; text: string }[] {
	const out: { role: string; text: string }[] = [];
	let used = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		const text = fitExcerpt(items[i].text, RECENT_TOTAL_CHARS - used);
		if (text === undefined) break;
		used += text.length;
		out.push({ role: items[i].role, text });
	}
	return out.reverse();
}

/** Text blocks only: thinking, signatures, tool calls and image data never leave the session. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(b => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []))
		.join("\n");
}

/** Last index before `before` whose entry has `id`, or -1. Scans backwards: retained boundaries sit near the compaction. */
function indexOfIdBefore(branch: readonly SessionEntry[], id: string, before: number): number {
	for (let i = before - 1; i >= 0; i--) {
		if (branch[i].type === "reset_boundary") break;
		if (branch[i].id === id) return i;
	}
	return -1;
}

interface EvidenceWindow {
	/** First branch index that may contribute recent evidence. */
	start: number;
	/** Portable summary of everything before the window, when the current compaction has a readable one. */
	summary: string | undefined;
	/** Text of compacted history cannot be shown to the router. */
	compactedEvidenceUnavailable: boolean;
}

/**
 * Where evidence may come from on this branch. The newest reset boundary or readable compaction
 * wins; history behind either must not be resurrected. Mirrors OMP's replay rules using
 * `getReadableCompactionEntry` for provider compatibility, without building the message context.
 */
function evidenceWindow(branch: readonly SessionEntry[], model: Parameters<typeof getReadableCompactionEntry>[1]): EvidenceWindow {
	const compaction = getReadableCompactionEntry(branch, model);
	let compactionIdx = -1;
	if (compaction) {
		compactionIdx = branch.lastIndexOf(compaction);
		if (compactionIdx < 0) compactionIdx = branch.findLastIndex(e => e.type === "compaction" && e.id === compaction.id);
	}
	for (let i = branch.length - 1; i > compactionIdx; i--) {
		if (branch[i].type === "reset_boundary") return { start: i + 1, summary: undefined, compactedEvidenceUnavailable: false };
	}
	if (!compaction || compactionIdx < 0) return { start: 0, summary: undefined, compactedEvidenceUnavailable: false };

	const after = compactionIdx + 1;
	const replayedThrough = compaction.providerReplayThroughEntryId
		? indexOfIdBefore(branch, compaction.providerReplayThroughEntryId, compactionIdx)
		: -1;
	if (getOpenAiRemoteCompactionPayload(compaction)) {
		// OpenAI replacement history is opaque; other remote methods can return portable text.
		return { start: replayedThrough >= 0 ? replayedThrough + 1 : after, summary: undefined, compactedEvidenceUnavailable: true };
	}
	const summary = compaction.summary.trim() || undefined;
	let start = after;
	let unavailable = false;
	if (compaction.firstKeptEntryId) {
		const keptIdx = indexOfIdBefore(branch, compaction.firstKeptEntryId, compactionIdx);
		if (keptIdx >= 0) start = keptIdx;
		else unavailable = true;
	} else if (replayedThrough >= 0) {
		start = replayedThrough + 1;
	}
	return { start, summary, compactedEvidenceUnavailable: unavailable || summary === undefined };
}

interface Evidence {
	recent: { role: string; text: string }[];
	summary: string | undefined;
	compactedEvidenceUnavailable: boolean;
}

/**
 * Newest-first walk over the active branch inside the evidence window. Collects up to `limit`
 * user/assistant texts plus {@link MAX_TOOL_RESULTS} tool results within the character budget,
 * then restores chronological order. Only the bounded result is allocated.
 */
export function selectEvidence(
	branch: readonly SessionEntry[],
	model: Parameters<typeof getReadableCompactionEntry>[1],
	limit: number,
): Evidence {
	const window = evidenceWindow(branch, model);
	const summaryText = window.summary;
	const out: { role: string; text: string }[] = [];
	const maxMessages = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
	let messages = 0;
	let tools = 0;
	let used = 0;
	for (let i = branch.length - 1; i >= window.start && maxMessages > 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		let role: string;
		let text: string;
		if (message.role === "user" || message.role === "assistant") {
			if (messages >= maxMessages) break;
			role = message.role;
			text = textOf(message.content).trim();
			if (!text) continue;
		} else if (message.role === "toolResult") {
			if (tools >= MAX_TOOL_RESULTS) continue;
			const name = String(message.toolName ?? "tool").slice(0, MAX_TOOL_NAME_CHARS);
			role = `${message.isError ? "tool_error" : "tool"}:${name}`;
			text = textOf(message.content).trim();
			if (!text) {
				if (!message.isError) continue;
				text = "(no text output)";
			}
		} else {
			continue;
		}
		// The summary field already carries this text.
		if (summaryText !== undefined && text === summaryText) continue;
		const fitted = fitExcerpt(text, RECENT_TOTAL_CHARS - used);
		if (fitted === undefined) break;
		used += fitted.length;
		out.push({ role, text: fitted });
		if (role === "user" || role === "assistant") messages++;
		else tools++;
	}
	return {
		recent: out.reverse(),
		summary: summaryText === undefined ? undefined : clipMiddle(summaryText, SUMMARY_CHARS),
		compactedEvidenceUnavailable: window.compactedEvidenceUnavailable,
	};
}

type SnapshotContext = Pick<ExtensionContext, "model" | "getContextUsage"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
};

/**
 * `latestRequest` is the full local input; only the decision-engine projection clips it.
 * Pass the caller's single `branch` snapshot to avoid re-walking the session.
 */
export function buildSnapshot(
	ctx: SnapshotContext,
	prompt: string,
	currentModel: string,
	pinnedRoute: string | undefined,
	historyMessages: number,
	images?: readonly ImageContent[],
	branch?: readonly SessionEntry[],
): Snapshot {
	const evidence = selectEvidence(branch ?? ctx.sessionManager.getBranch(), ctx.model, historyMessages);
	return {
		currentModel,
		latestRequest: prompt,
		recent: evidence.recent,
		summary: evidence.summary,
		attachmentCount: images?.length ?? 0,
		compactedEvidenceUnavailable: evidence.compactedEvidenceUnavailable,
		contextTokens: ctx.getContextUsage()?.tokens ?? undefined,
		pinnedRoute,
	};
}
