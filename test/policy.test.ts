import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { decide, type PolicyInput } from "../src/policy";
import type { Classification } from "../src/types";

const cls = (o: Partial<Classification> = {}): Classification => ({
	newTask: false,
	newTaskConfidence: 0.9,
	tier: "standard",
	tierConfidence: 0.9,
	...o,
});

const base = (o: Partial<PolicyInput> = {}): PolicyInput => ({
	cls: cls(),
	pinnedTier: undefined,
	currentModel: "p/std",
	tierModels: { fast: "p/fast", standard: "p/std", deep: "p/deep" },
	contextTokens: 1000,
	config: DEFAULT_CONFIG.routing,
	...o,
});

describe("decide", () => {
	test("first message pins the classified tier and switches", () => {
		const v = decide(base({ cls: cls({ tier: "fast" }) }));
		expect(v).toMatchObject({ pinnedTier: "fast", switchModel: true, taskStart: true });
	});

	test("follow-up at same or lower tier keeps the pinned task", () => {
		const v = decide(base({ pinnedTier: "deep", currentModel: "p/deep", cls: cls({ tier: "fast" }) }));
		expect(v).toMatchObject({ pinnedTier: "deep", switchModel: false, taskStart: false, desiredTier: undefined });
	});

	test("follow-up that is harder escalates", () => {
		const v = decide(base({ pinnedTier: "fast", currentModel: "p/fast", cls: cls({ tier: "deep" }) }));
		expect(v).toMatchObject({ pinnedTier: "deep", switchModel: true });
	});

	test("escalation can be disabled", () => {
		const v = decide(
			base({
				pinnedTier: "fast",
				currentModel: "p/fast",
				cls: cls({ tier: "deep" }),
				config: { ...DEFAULT_CONFIG.routing, allowEscalation: false },
			}),
		);
		expect(v.switchModel).toBe(false);
	});

	test("confident new task re-routes, including downgrade", () => {
		const v = decide(base({ pinnedTier: "deep", currentModel: "p/deep", cls: cls({ newTask: true, tier: "fast" }) }));
		expect(v).toMatchObject({ pinnedTier: "fast", switchModel: true, taskStart: true });
	});

	test("low-confidence new-task signal is treated as follow-up", () => {
		const v = decide(
			base({ pinnedTier: "deep", currentModel: "p/deep", cls: cls({ newTask: true, newTaskConfidence: 0.3, tier: "fast" }) }),
		);
		expect(v).toMatchObject({ pinnedTier: "deep", switchModel: false, taskStart: false });
	});

	test("low tier confidence keeps the current model and leaves the pin unset", () => {
		const v = decide(base({ cls: cls({ tier: "deep", tierConfidence: 0.2 }) }));
		expect(v).toMatchObject({ pinnedTier: undefined, switchModel: false });
	});

	test("cache guard blocks a downgrade in a large conversation", () => {
		const v = decide(
			base({
				pinnedTier: "deep",
				currentModel: "p/deep",
				contextTokens: 200_000,
				cls: cls({ newTask: true, tier: "fast" }),
			}),
		);
		expect(v).toMatchObject({ pinnedTier: "deep", switchModel: false });
		expect(v.reason).toContain("cache guard");
	});

	test("cache guard still allows escalation to deep", () => {
		const v = decide(base({ pinnedTier: "standard", contextTokens: 200_000, cls: cls({ tier: "deep" }) }));
		expect(v).toMatchObject({ pinnedTier: "deep", switchModel: true });
	});

	test("engine failure keeps everything", () => {
		const v = decide(base({ cls: undefined, pinnedTier: "fast" }));
		expect(v).toMatchObject({ pinnedTier: "fast", switchModel: false });
	});

	test("unresolvable tier model keeps current model", () => {
		const v = decide(base({ cls: cls({ tier: "deep" }), tierModels: { fast: "p/fast", standard: "p/std", deep: undefined } }));
		expect(v.switchModel).toBe(false);
		expect(v.pinnedTier).toBeUndefined();
	});
});
