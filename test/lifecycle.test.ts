import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import switchboard from "../src/index";
import { readLog, type DecisionRecord, type OutcomeRecord } from "../src/log";

// The isolated host never sends provider requests; only these metadata fields are consumed.
const model = (id: string, contextWindow = 200_000): Model => {
	const fixture = { id, provider: "test", api: "openai-completions", name: id, baseUrl: "http://localhost/unused",
		reasoning: true, input: ["text", "image"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow, maxTokens: 8192 } as unknown as Model;
	return fixture;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;
interface TestHarness {
	ctx: ExtensionContext;
	notices: string[];
	current: string;
	readonly thinking: string;
	branch: SessionEntry[];
	tokens: number | undefined;
	idle: boolean;
	refuse: boolean;
	command(args: string): Promise<void>;
	prompt(text: string, images?: unknown[]): Promise<void>;
	prepare(text: string): Promise<void>;
	end(willContinue?: boolean, history?: unknown[]): Promise<void>;
	emit(name: string, event?: unknown): Promise<void>;
	install(): void;
	decisions(): DecisionRecord[];
	outcomes(): OutcomeRecord[];
}

async function withRouter(run: (h: TestHarness) => Promise<void>, overrides: Record<string, unknown> = {}) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "switchboard-lifecycle-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "switchboard.json"), JSON.stringify({ mode: "auto", logging: true, stamp: false,
		routes: { plan: { model: "test/deep" }, implement: { model: "test/code" },
			"deep-dive": { model: "test/deep" }, "quick-edit": { model: "test/fast" }, default: { model: "test/std" } },
		...overrides,
	}));
	try { await run(harness(dir)); } finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

function harness(dir: string): TestHarness {
	const models = [model("std"), model("deep"), model("code"), model("fast")];
	let current = models[0]!;
	let thinking = "medium";
	let branch: SessionEntry[] = [];
	let idle = true;
	let running = false;
	let refuse = false;
	let tokens: number | undefined = 1000;
	const notices: string[] = [];
	const handlers: Record<string, EventHandler> = {};
	const commands: Record<string, CommandHandler> = {};
	// A narrow in-process host implements exactly the extension boundaries exercised below.
	const ctx = {
		get model() { return current; },
		agent: { kind: "main", id: "main", name: "main", depth: 0 },
		models: { current: () => current, resolve: (ref: string) => models.find(m => `${m.provider}/${m.id}` === ref) },
		modelRegistry: { find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) },
		getContextUsage: () => tokens === undefined ? undefined : { tokens, contextWindow: current.contextWindow, percent: 0 },
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
		ui: { notify: (text: string) => notices.push(text), rerenderMessage: () => {} },
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, fn: EventHandler) => { handlers[name] = fn; },
		registerCommand: (name: string, command: { handler: CommandHandler }) => { commands[name] = command.handler; },
		setLabel: () => {}, registerAssistantTextRenderer: () => {},
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; },
		setModel: async (next: Model) => { if (refuse) return false; current = next; thinking = "medium"; return true; },
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data,
			id: crypto.randomUUID(), parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() }),
		pi: { settings: {} },
	} as unknown as ExtensionAPI;
	const install = () => { running = false; idle = true; switchboard(api); };
	install();
	const emit = async (name: string, event: unknown = {}) => {
		await handlers[name]?.(event, ctx);
		if (name === "agent_start") running = true;
	};
	const command = async (args: string) => { await commands.switchboard!(args, ctx); };
	const prepare = async (text: string, images: unknown[] = []) => {
		await emit("input", { text, images, source: "interactive" });
		idle = false;
		await emit("before_agent_start", { reason: "prompt", prompt: text, images, systemPrompt: [] });
	};
	const prompt = async (text: string, images: unknown[] = []) => {
		const wasRunning = running;
		await prepare(text, images);
		if (wasRunning) return;
		await emit("agent_start");
		const message = { role: "user" as const, content: text, timestamp: Date.now() };
		branch.push({ type: "message", message, id: crypto.randomUUID(), parentId: branch.at(-1)?.id ?? null,
			timestamp: new Date().toISOString() });
		await emit("message_end", { message });
	};
	const end = async (willContinue = false, history: unknown[] = []) => {
		await emit("agent_end", { willContinue, messages: history });
		if (!willContinue) { running = false; idle = true; }
	};
	const decisions = () => readLog(join(dir, "switchboard/decisions.jsonl"))
		.filter((r): r is DecisionRecord => r.type === "decision");
	const outcomes = () => readLog(join(dir, "switchboard/decisions.jsonl"))
		.filter((r): r is OutcomeRecord => r.type === "outcome");
	return { ctx, notices, command, prompt, prepare, end, emit, install, decisions, outcomes,
		get current() { return current.id; }, get thinking() { return thinking; },
		get branch() { return branch; }, set branch(value: SessionEntry[]) { branch = value; },
		set current(value: string) { current = models.find(m => m.id === value)!; },
		set tokens(value: number | undefined) { tokens = value; },
		set idle(value: boolean) { idle = value; }, set refuse(value: boolean) { refuse = value; },
	};
}

test("reset allows a fresh cheaper task, without keyword downgrades in its predecessor", async () => {
	await withRouter(async h => {
		await h.emit("session_start");
		await h.prompt("plan the migration"); await h.end();
		expect(h.current).toBe("deep");
		await h.prompt("fix the typo you just added"); await h.end();
		expect(h.current).toBe("deep");
		await h.command("reset");
		await h.prompt("rename the variable"); await h.end();
		expect(h.current).toBe("fast");
	});
});

test("resuming restores the pin and shadow proposals never become applied state", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("rename the variable"); await h.end();
		await h.command("shadow"); await h.prompt("plan the migration"); await h.end();
		expect(h.current).toBe("fast");
		h.install(); await h.emit("session_start"); await h.prompt("yes continue"); await h.end();
		expect(h.current).toBe("fast");
		expect(h.decisions().at(-1)?.pinnedRoute).toBe("quick-edit");
	});
});

test("tree navigation restores destination ancestry and clear cannot resurrect a pin", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("rename the variable"); await h.end();
		const cheapBranch = [...h.branch];
		await h.prompt("plan the migration"); await h.end();
		h.branch = cheapBranch;
		await h.emit("session_tree"); await h.prompt("continue"); await h.end();
		expect(h.decisions().at(-1)?.pinnedRoute).toBe("quick-edit");
		expect(h.current).toBe("deep");
		expect(h.notices.some(n => n.includes("changed by hand"))).toBe(false);
		h.branch.push({ type: "reset_boundary", id: "clear", parentId: h.branch.at(-1)!.id, timestamp: "2026-01-01" });
		await h.prompt("continue"); await h.end();
		expect(h.current).toBe("std");
	});
});

test("manual model hold survives resume until explicitly re-enabled", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan the migration"); await h.end();
		h.current = "code"; await h.prompt("rename the variable"); await h.end();
		h.install(); await h.emit("session_start"); await h.prompt("rename the variable"); await h.end();
		expect(h.current).toBe("code");
		await h.command("on"); await h.command("reset");
		await h.prompt("rename the variable"); await h.end();
		expect(h.current).toBe("fast");
	});
});

test("refused and over-budget switches leave the model, thinking, and pin unchanged", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); h.refuse = true;
		await h.prompt("plan the migration"); await h.end();
		expect(h.current).toBe("std"); expect(h.thinking).toBe("medium");
		expect(h.decisions().at(-1)?.modelChanged).toBe(false);
		expect(h.decisions().at(-1)?.pinnedRoute).toBeUndefined();
		h.refuse = false; h.tokens = 159_999;
		await h.prompt("plan " + "x".repeat(1000)); await h.end();
		expect(h.current).toBe("std"); expect(h.thinking).toBe("medium");
		expect(h.notices.some(n => n.includes("context"))).toBe(true);
	});
});

test("small image requests can route and thinking-only changes are reported separately", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan this diagram", [{ type: "image", data: "", mimeType: "image/png" }]); await h.end();
		expect(h.current).toBe("deep");
		expect(h.decisions().at(-1)?.contextAssessment?.kind).toBe("estimated-fit");
		await h.command("reset"); await h.prompt("plan the next task"); await h.end();
		expect(h.decisions().at(-1)).toMatchObject({ modelChanged: false, resultModel: "test/deep" });
	});
});

test("routing state persists even when diagnostic logging is disabled", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan the migration"); await h.end();
		expect(h.branch.some(e => e.type === "custom" && e.customType === "switchboard-state")).toBe(true);
		h.install(); await h.emit("session_start"); await h.command("status");
		expect(h.notices.at(-1)).toContain("pinned route: plan");
	}, { logging: false });
});

test("active runs and automatic continuation are not reclassified", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("rename the variable");
		h.idle = false;
		await h.prompt("plan the migration"); await h.end(true);
		await h.prompt("plan the migration");
		expect(h.current).toBe("fast");
		expect(h.decisions()).toHaveLength(1);
		h.idle = true; await h.end();
		await h.prompt("plan the migration"); await h.end();
		expect(h.current).toBe("deep");
	});
});

test("retry fallback is not restored as a manual model hold", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan the migration"); await h.end();
		h.current = "code"; await h.emit("retry_fallback_applied");
		h.install(); await h.emit("session_start");
		await h.prompt("continue"); await h.end();
		expect(h.current).toBe("code");
		expect(h.decisions().at(-1)?.reason).toContain("follow-up");
		expect(h.notices.some(n => n.includes("paused"))).toBe(false);
		h.current = "deep";
		await h.prompt("continue after primary restoration"); await h.end();
		expect(h.decisions().at(-1)?.reason).toContain("follow-up");
		expect(h.notices.some(n => n.includes("paused"))).toBe(false);
	});
});

test("switching to an unrelated session cannot inherit another session's pin", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan the migration"); await h.end();
		h.branch = []; h.current = "std";
		await h.emit("session_switch", { reason: "new" });
		await h.prompt("rename the variable"); await h.end();
		expect(h.current).toBe("fast");
	});
});

test("unchanged follow-ups do not append duplicate routing checkpoints", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan the migration"); await h.end();
		await h.prompt("continue"); await h.end();
		const checkpoints = h.branch.filter(e => e.type === "custom" && e.customType === "switchboard-state");
		expect(checkpoints).toHaveLength(1);
	});
});

test("cancelled preparations do not freeze routing or pin an undelivered request", async () => {
	await withRouter(async h => {
		await h.emit("session_start");
		await h.prepare("plan the migration");
		expect(h.branch.some(e => e.type === "custom" && e.customType === "switchboard-state")).toBe(false);
		await h.prompt("rename the variable"); await h.end();
		expect(h.current).toBe("fast");
		expect(h.decisions().at(-1)?.classification?.route).toBe("quick-edit");
	});
});

test("editing the first request cannot inherit its own derived route pin", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("plan the migration"); await h.end();
		const firstUser = h.branch.findIndex(e => e.type === "message" && e.message.role === "user");
		expect(firstUser).toBeGreaterThanOrEqual(0);
		expect(h.branch.slice(0, firstUser).some(e => e.type === "custom" && e.customType === "switchboard-state")).toBe(false);
		h.branch = h.branch.slice(0, firstUser);
		await h.emit("session_tree");
		await h.prompt("rename the variable"); await h.end();
		expect(h.current).toBe("fast");
	});
});

test("cancelling a model-changing preparation cannot turn an older checkpoint into a manual hold", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("rename the variable"); await h.end();
		await h.prepare("plan the migration");
		expect(h.current).toBe("deep");
		await h.prompt("continue"); await h.end();
		expect(h.notices.some(n => n.includes("changed by hand"))).toBe(false);
		expect(h.decisions().at(-1)?.pinnedRoute).toBe("quick-edit");
		expect(h.decisions().at(-1)?.reason).toContain("follow-up");
	});
});

test("an unmatched greeting does not prevent the first keyword task choosing a cheaper route", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("hi"); await h.end();
		expect(h.decisions().at(-1)?.pinnedRoute).toBeUndefined();
		await h.prompt("rename foo"); await h.end();
		expect(h.current).toBe("fast");
		expect(h.decisions().at(-1)?.pinnedRoute).toBe("quick-edit");
	});
});

test("shadow greetings also leave the first real task unpinned", async () => {
	await withRouter(async h => {
		await h.emit("session_start"); await h.prompt("hi"); await h.end();
		await h.prompt("rename foo"); await h.end();
		expect(h.decisions().at(-1)?.desiredRoute).toBe("quick-edit");
		expect(h.current).toBe("std");
	}, { mode: "shadow" });
});

test("outcome spend counts only assistant calls emitted during its own run", async () => {
	await withRouter(async h => {
		const assistant = (input: number, cost: number) => ({ role: "assistant", provider: "test", model: "deep",
			content: [], stopReason: "stop", usage: { input, output: 1, cacheRead: 0, cacheWrite: 0,
				cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } });
		const first = assistant(10, 0.01);
		const second = assistant(20, 0.02);
		await h.emit("session_start"); await h.prompt("plan the migration");
		await h.emit("message_end", { message: first }); await h.end(false, [first]);
		await h.prompt("continue");
		await h.emit("message_end", { message: second }); await h.end(false, [first, second]);
		expect(h.outcomes().at(-1)?.usage).toMatchObject({ assistantCalls: 1, inputTokens: 20, executionCostUsd: 0.02 });
		expect(h.decisions().at(-1)?.engineCostUsd).toBe(0);
	});
});
