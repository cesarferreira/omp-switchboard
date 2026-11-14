import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { benchmarkReply } from "../src/evaluation-command";

const reply = (stopReason: AssistantMessage["stopReason"], total: number, text = ""): Pick<AssistantMessage, "role" | "content" | "usage" | "stopReason" | "errorMessage"> => ({
	role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
});

test("synthetic zero usage on a failed completion cannot establish zero spend", () => {
	let caught: unknown;
	try { benchmarkReply(reply("aborted", 0), true, 10); } catch (error) { caught = error; }
	expect(caught).toBeInstanceOf(Error);
	expect(caught && typeof caught === "object" && "costUsd" in caught ? caught.costUsd : undefined).toBeUndefined();
});

test("a failed completion retains positive normalized spend when available", () => {
	let caught: unknown;
	try { benchmarkReply(reply("error", 0.02), true, 10); } catch (error) { caught = error; }
	expect(caught && typeof caught === "object" && "costUsd" in caught ? caught.costUsd : undefined).toBe(0.02);
});

test("invalid JSON remains a failed answer without losing priced usage", () => {
	let caught: unknown;
	try { benchmarkReply(reply("stop", 0.01, "not JSON"), true, 20); } catch (error) { caught = error; }
	expect(caught).toBeInstanceOf(Error);
	expect(caught && typeof caught === "object" && "costUsd" in caught ? caught.costUsd : undefined).toBe(0.01);
});

test("successful JSON retains structured answers and unknown pricing", () => {
	expect(benchmarkReply(reply("stop", 0, '{"result":9}'), false, 20))
		.toMatchObject({ answer: { result: 9 }, costUsd: undefined, latencyMs: 20 });
});
