import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Mode, RouteConfig, SwitchboardConfig } from "./types";

export const DEFAULT_CONFIG: SwitchboardConfig = {
	enabled: true,
	mode: "shadow",
	decision: { model: "", timeoutMs: 15_000 },
	routing: {
		sticky: true,
		allowEscalation: true,
		cacheAware: true,
		cacheGuardTokens: 60_000,
		minConfidence: 0.6,
		historyMessages: 6,
	},
	routes: {},
	setups: {},
	stamp: false,
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
		const warn =
			config.activeSetup && !config.setups[config.activeSetup]
				? `activeSetup "${config.activeSetup}" does not exist; using top-level routes`
				: undefined;
		return { config, error: warn };
	} catch (e) {
		return { config: DEFAULT_CONFIG, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
	}
}

export function effectiveMode(c: SwitchboardConfig, override: Mode | undefined): Mode {
	if (override) return override;
	return c.enabled ? c.mode : "off";
}

/** Raw (un-merged, un-expanded) config file contents, `{}` when absent. */
export function readRawConfig(path = configPath()): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isObj(raw)) throw new Error(`${path} must contain a JSON object`);
	return raw;
}

export function writeRawConfig(raw: Record<string, unknown>, path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

const objectAt = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
	const v = parent[key];
	if (isObj(v)) return v;
	const fresh: Record<string, unknown> = {};
	parent[key] = fresh;
	return fresh;
};

/** Set fields on a route of the active setup when `setup` is given, else on the top-level `routes`. */
export function patchRoute(raw: Record<string, unknown>, route: string, patch: RouteConfig, setup?: string): void {
	const routes = setup ? objectAt(objectAt(objectAt(raw, "setups"), setup), "routes") : objectAt(raw, "routes");
	const entry = objectAt(routes, route);
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) delete entry[k];
		else entry[k] = v;
	}
}

/** Snapshot `routes` (already effective) as a named setup and activate it. */
export function saveSetup(raw: Record<string, unknown>, name: string, routes: Record<string, RouteConfig>): void {
	objectAt(raw, "setups")[name] = { routes };
	raw.activeSetup = name;
}

/** Activate a setup, or deactivate with `none`. Returns false when the setup does not exist. */
export function useSetup(raw: Record<string, unknown>, name: string): boolean {
	if (name === "none") {
		delete raw.activeSetup;
		return true;
	}
	if (!isObj(raw.setups) || !isObj(raw.setups[name])) return false;
	raw.activeSetup = name;
	return true;
}
