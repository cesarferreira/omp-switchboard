import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./config";
import type { Mode } from "./types";
import type { ContextAssessment } from "./context-budget";

export interface DecisionRecord {
	type: "decision";
	id: string;
	ts: number;
	sessionId: string;
	mode: Mode;
	engine: string;
	engineLatencyMs: number;
	engineCostUsd?: number;
	currentModel: string;
	currentThinking: string;
	routeModels: Record<string, string | undefined>;
	classification?: { newTask: boolean; newTaskConfidence: number; route: string; routeConfidence: number; matched?: string[] };
	desiredRoute?: string;
	pinnedRoute?: string;
	taskStart: boolean;
	applied: boolean;
	/** Actual model/thinking mutations; absent on legacy decision records. */
	modelChanged?: boolean;
	thinkingChanged?: boolean;
	resultModel?: string;
	contextAssessment?: ContextAssessment;
	/** In shadow mode: the switch the router would have made. */
	wouldSwitch: boolean;
	contextTokens?: number;
	reason: string;
	error?: string;
	promptPreview?: string;
}

export interface OutcomeRecord {
	type: "outcome";
	id: string;
	ts: number;
	model: string;
	durationMs: number;
	toolCalls: number;
	toolErrors: number;
	aborted: boolean;
}

export type LogRecord = DecisionRecord | OutcomeRecord;

export function appendLog(rec: LogRecord): void {
	try {
		mkdirSync(logDir(), { recursive: true });
		appendFileSync(join(logDir(), "decisions.jsonl"), `${JSON.stringify(rec)}\n`);
	} catch {
		// Logging must never break a turn.
	}
}

export function readLog(path = join(logDir(), "decisions.jsonl")): LogRecord[] {
	if (!existsSync(path)) return [];
	const out: LogRecord[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const r: unknown = JSON.parse(line);
			if (typeof r === "object" && r !== null && "type" in r && (r.type === "decision" || r.type === "outcome")) {
				out.push(r as LogRecord);
			}
		} catch {
			// skip torn line
		}
	}
	return out;
}

export function summarize(recs: LogRecord[]): string {
	const decisions = recs.filter((r): r is DecisionRecord => r.type === "decision");
	if (decisions.length === 0) return "No decisions logged yet.";
	const outcomes = new Map(recs.filter((r): r is OutcomeRecord => r.type === "outcome").map(r => [r.id, r]));
	const by = <K extends string>(f: (d: DecisionRecord) => K | undefined) => {
		const m = new Map<string, number>();
		for (const d of decisions) {
			const k = f(d);
			if (k) m.set(k, (m.get(k) ?? 0) + 1);
		}
		return [...m].map(([k, n]) => `${k}=${n}`).join(" ") || "-";
	};
	const lat = decisions.map(d => d.engineLatencyMs).sort((a, b) => a - b);
	const p50 = lat[Math.floor(lat.length / 2)];
	const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))];
	const cost = decisions.reduce((s, d) => s + (d.engineCostUsd ?? 0), 0);
	const errors = decisions.filter(d => d.error).length;
	const would = decisions.filter(d => d.wouldSwitch).length;
	const applied = decisions.filter(d => d.modelChanged ?? (d.applied && d.wouldSwitch)).length;
	const thinking = decisions.filter(d => d.thinkingChanged).length;
	const done = [...outcomes.values()];
	const toolErr = done.reduce((s, o) => s + o.toolErrors, 0);
	const toolCalls = done.reduce((s, o) => s + o.toolCalls, 0);
	return [
		`decisions: ${decisions.length} (errors ${errors})`,
		`desired route: ${by(d => d.desiredRoute)}`,
		`task starts: ${decisions.filter(d => d.taskStart).length}`,
		`model switches: applied ${applied}, would-switch ${would}`,
		`thinking changes: ${thinking}`,
		`engine latency: p50 ${p50}ms p95 ${p95}ms; cost $${cost.toFixed(4)}`,
		`outcomes: ${done.length} turns, tool errors ${toolErr}/${toolCalls}`,
	].join("\n");
}
