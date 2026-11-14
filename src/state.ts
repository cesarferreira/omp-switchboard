import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { isObj } from "./config";

export const STATE_ENTRY = "switchboard-state";

export interface RoutingCheckpoint {
	version: 1;
	pinnedRoute: string | null;
	expectedModel: string | null;
	manualHold: boolean;
	routeSignature: string;
	/** Host may later restore a retry primary without an extension event. */
	fallbackPending?: boolean;
}

/** Resolved identities, not aliases: config or role changes invalidate the pin. */
export function routeSignature(routes: readonly { name: string; target?: string; thinking?: string; rank: number }[]): string {
	return JSON.stringify([...routes].sort((a, b) => a.name.localeCompare(b.name))
		.map(r => [r.name, r.target ?? null, r.thinking ?? null, r.rank]));
}

/** The newest checkpoint wins, including null pins and invalidation barriers. */
export function restoreCheckpoint(
	branch: readonly SessionEntry[], signature: string, routeNames: Readonly<Record<string, true>>,
): RoutingCheckpoint | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "reset_boundary") break;
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const d: unknown = entry.data;
		if (!isObj(d) || d.version !== 1 || typeof d.manualHold !== "boolean" || typeof d.routeSignature !== "string"
			|| !(d.pinnedRoute === null || typeof d.pinnedRoute === "string")
			|| !(d.expectedModel === null || typeof d.expectedModel === "string")
			|| !(d.fallbackPending === undefined || typeof d.fallbackPending === "boolean")) return undefined;
		const compatible = d.routeSignature === signature && (d.pinnedRoute === null || Object.hasOwn(routeNames, d.pinnedRoute));
		return {
			version: 1, routeSignature: signature, manualHold: d.manualHold,
			fallbackPending: d.fallbackPending === true,
			pinnedRoute: compatible ? d.pinnedRoute as string | null : null,
			expectedModel: compatible ? d.expectedModel as string | null : null,
		};
	}
	return undefined;
}
