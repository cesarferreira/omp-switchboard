import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mode, SwitchboardConfig } from "./types";

export const DEFAULT_CONFIG: SwitchboardConfig = {
	enabled: true,
	mode: "shadow",
	decision: { model: "@smol", timeoutMs: 15_000 },
	routing: {
		sticky: true,
		allowEscalation: true,
		cacheAware: true,
		cacheGuardTokens: 60_000,
		minConfidence: 0.6,
		historyMessages: 6,
	},
	tiers: {
		fast: { model: "@smol", thinking: "low" },
		standard: { model: "@task", thinking: "medium" },
		deep: { model: "@slow", thinking: "high" },
	},
	logging: true,
	logPrompts: false,
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
}

export const configPath = (): string => join(agentDir(), "switchboard.json");
export const logDir = (): string => join(agentDir(), "switchboard");

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function merge<T>(base: T, over: unknown): T {
	if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
	const out: Record<string, unknown> = { ...base };
	for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
	return out as T;
}

/** Expand `${VAR}` in every string value; unset variables become "". */
function expandEnv(v: unknown): unknown {
	if (typeof v === "string") return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "");
	if (Array.isArray(v)) return v.map(expandEnv);
	if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
	return v;
}

export interface LoadedConfig {
	config: SwitchboardConfig;
	error?: string;
}

export function loadConfig(path = configPath()): LoadedConfig {
	if (!existsSync(path)) return { config: DEFAULT_CONFIG };
	try {
		const raw = expandEnv(JSON.parse(readFileSync(path, "utf8")));
		const config = merge(DEFAULT_CONFIG, raw);
		const mode = isObj(raw) ? raw.mode : undefined;
		if (mode !== undefined && mode !== "auto" && mode !== "shadow" && mode !== "off") {
			return { config: DEFAULT_CONFIG, error: `invalid mode ${JSON.stringify(mode)}; expected auto|shadow|off` };
		}
		return { config };
	} catch (e) {
		return { config: DEFAULT_CONFIG, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
	}
}

export function effectiveMode(c: SwitchboardConfig, override: Mode | undefined): Mode {
	if (override) return override;
	return c.enabled ? c.mode : "off";
}
