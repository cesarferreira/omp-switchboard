import { expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { restoreCheckpoint, routeSignature, type RoutingCheckpoint } from "../src/state";

const signature = "routes-v1";
const checkpoint = (over: Partial<RoutingCheckpoint> = {}): RoutingCheckpoint => ({
	version: 1, pinnedRoute: "plan", expectedModel: "p/deep", manualHold: false, routeSignature: signature, ...over,
});
const entry = (data: unknown, id = "pin"): SessionEntry => ({
	type: "custom", customType: "switchboard-state", data, id, parentId: null, timestamp: "2026-01-01",
});
const names: Record<string, true> = { plan: true, "quick-edit": true };

test("restores only the checkpoint on selected ancestry", () => {
	expect(restoreCheckpoint([entry(checkpoint())], signature, names)?.pinnedRoute).toBe("plan");
	expect(restoreCheckpoint([], signature, names)).toBeUndefined();
});

test("reset tombstone cannot resurrect an older pin", () => {
	const branch = [entry(checkpoint()), entry(checkpoint({ pinnedRoute: null, expectedModel: null }), "reset")];
	expect(restoreCheckpoint(branch, signature, names)?.pinnedRoute).toBeNull();
});

test("clear and malformed latest state never fall back to stale pins", () => {
	const reset: SessionEntry = { type: "reset_boundary", id: "clear", parentId: "pin", timestamp: "2026-01-01" };
	expect(restoreCheckpoint([entry(checkpoint()), reset], signature, names)).toBeUndefined();
	expect(restoreCheckpoint([entry(checkpoint()), entry({ version: 2 }, "bad")], signature, names)).toBeUndefined();
});

test("config changes discard route expectation without releasing a manual hold", () => {
	const state = restoreCheckpoint([entry(checkpoint({ manualHold: true }))], "changed", names);
	expect(state).toMatchObject({ pinnedRoute: null, expectedModel: null, manualHold: true, routeSignature: "changed" });
	const removed = restoreCheckpoint([entry(checkpoint())], signature, { "quick-edit": true });
	expect(removed?.pinnedRoute).toBeNull();
});

test("route signature is order independent but tracks resolved model and thinking", () => {
	const a = { name: "plan", target: "p/deep", thinking: "high", rank: 3 };
	const b = { name: "quick-edit", target: "p/fast", thinking: "low", rank: 0 };
	expect(routeSignature([a, b])).toBe(routeSignature([b, a]));
	expect(routeSignature([a])).not.toBe(routeSignature([{ ...a, target: "p/other" }]));
	expect(routeSignature([a])).not.toBe(routeSignature([{ ...a, thinking: "low" }]));
});
