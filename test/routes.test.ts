import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, patchRoute, saveSetup, useSetup } from "../src/config";
import { matchKeywords, resolveRoutes } from "../src/routes";
import type { SwitchboardConfig } from "../src/types";

const cfg = (o: Partial<SwitchboardConfig> = {}): SwitchboardConfig => ({ ...DEFAULT_CONFIG, ...o });

describe("matchKeywords", () => {
	const routes = resolveRoutes(cfg());

	test("longer phrases outscore shorter ones", () => {
		// "quick fix" (2) on quick-edit beats "fix" (1) on implement
		expect(matchKeywords("do a quick fix on the header", routes)?.route).toBe("quick-edit");
	});

	test("matches whole words only", () => {
		expect(matchKeywords("this is an address book", routes)).toBeUndefined(); // "add" must not match "address"
		expect(matchKeywords("Rename utils.ts", routes)?.route).toBe("quick-edit");
	});

	test("tolerates case and extra whitespace in the prompt", () => {
		expect(matchKeywords("THINK   THROUGH the sharding", routes)?.route).toBe("plan");
	});

	test("ties keep the earliest route; no match is undefined", () => {
		expect(matchKeywords("plan and implement", routes)?.route).toBe("plan");
		expect(matchKeywords("hello there", routes)).toBeUndefined();
	});
});

describe("resolveRoutes", () => {
	test("config routes come first, built-ins fill in, default is last", () => {
		const r = resolveRoutes(cfg({ routes: { research: { keywords: ["benchmark"], model: "x/y" } } }));
		expect(r.map(x => x.name)).toEqual(["research", "plan", "implement", "deep-dive", "quick-edit", "default"]);
	});

	test("keywords replace the built-in list while other fields inherit", () => {
		const r = resolveRoutes(cfg({ routes: { plan: { keywords: ["blueprint"] } } })).find(x => x.name === "plan")!;
		expect(r.keywords).toEqual(["blueprint"]);
		expect(r.model).toBe("@slow");
	});

	test("active setup overrides top-level routes; missing setup is ignored", () => {
		const base = cfg({ routes: { plan: { model: "top/model" } }, setups: { cheap: { routes: { plan: { model: "cheap/model" } } } } });
		expect(resolveRoutes({ ...base, activeSetup: "cheap" }).find(x => x.name === "plan")?.model).toBe("cheap/model");
		expect(resolveRoutes({ ...base, activeSetup: "ghost" }).find(x => x.name === "plan")?.model).toBe("top/model");
	});

	test("empty model string means keep current model", () => {
		expect(resolveRoutes(cfg({ routes: { default: { model: "" } } })).find(x => x.name === "default")?.model).toBeUndefined();
	});

	test("custom route without keywords or description still has a description for the decision model", () => {
		const r = resolveRoutes(cfg({ routes: { docs: { model: "x/y" } } })).find(x => x.name === "docs")!;
		expect(r.description).toBe("docs");
	});
});

describe("config edits", () => {
	test("patchRoute writes to the setup when given, and removes fields set to undefined", () => {
		const raw: Record<string, unknown> = {};
		patchRoute(raw, "plan", { model: "a/b", thinking: "high" }, "cheap");
		expect(raw).toEqual({ setups: { cheap: { routes: { plan: { model: "a/b", thinking: "high" } } } } });
		patchRoute(raw, "plan", { thinking: undefined }, "cheap");
		expect(raw).toEqual({ setups: { cheap: { routes: { plan: { model: "a/b" } } } } });
		patchRoute(raw, "plan", { model: "c/d" });
		expect(raw.routes).toEqual({ plan: { model: "c/d" } });
	});

	test("saveSetup activates; useSetup validates the name and supports none", () => {
		const raw: Record<string, unknown> = {};
		saveSetup(raw, "quality", { plan: { model: "a/b" } });
		expect(raw.activeSetup).toBe("quality");
		expect(useSetup(raw, "ghost")).toBe(false);
		expect(raw.activeSetup).toBe("quality");
		expect(useSetup(raw, "none")).toBe(true);
		expect(raw.activeSetup).toBeUndefined();
	});
});
