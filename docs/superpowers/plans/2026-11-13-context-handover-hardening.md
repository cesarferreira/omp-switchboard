# Context Handover Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve task continuity across model switches, compaction, resume, and branch navigation without introducing a second conversation-transfer system.

**Architecture:** OMP remains responsible for replaying the conversation. Switchboard gets a less lossy classifier snapshot, conservative task-boundary semantics, metadata-based admission checks, and branch-local durable routing state. Reuse live provider usage and OMP's readable-compaction selector; do not reconstruct or re-tokenize the full transcript on the routing path.

**Tech Stack:** TypeScript, Bun tests, existing OMP extension/session APIs. No new package dependencies.

**Spec:** The Design Contract section in this document is the self-contained proposed spec. Source request: the conversation's context-handover assessment and request for a fix plan. Implementation requires approval of this plan; this document does not authorize source changes or commits.

## Global Constraints

- Keep OMP peer compatibility at `^18.20.0` unless implementation proves a required public API absent at that floor.
- No model-generated handover on every switch, second transcript, forced compaction, silent history truncation, or provider-specific replay implementation.
- Keep current config names, built-in routes, route ranks, thinking levels, default shadow mode, and existing cache guard.
- Preserve subagent exclusion, manual model hold, retry-fallback handling, and once-per-running-task routing.
- Route pin changes describe the state actually applied; a shadow recommendation is never durable applied state.
- No prompts, tool-output text, image bytes, or compaction summaries in decision logs unless already covered by the existing explicit prompt-preview opt-in. New diagnostics contain counts and reasons only.
- Use LSP references before modifying exported symbols. Migrate every caller in the same task; no compatibility aliases.
- Work inline by default. The tasks below share contracts and orchestration; do not fan them out as independent edits.
- Run only the named focused checks for each completed task, then the final package checks once. No repeated broad audits.
- No full-context rebuild, historical-message tokenization, or tool-schema serialization in `before_agent_start`. Reuse one active-branch snapshot for evidence, checkpoint restoration, and admission metadata.

## Design Contract

### A. Task boundaries are separate from route keywords

A keyword identifies a work category, not whether the user changed goals. The keyword engine returns `newTask: false` and `newTaskConfidence: 0` for matches and misses. Existing policy already routes when no pin exists or `sticky` is false, and already permits confident upward escalation. Do not change decision-model task-boundary classification.

An initial keyword miss may apply the `default` model/thinking baseline but does not identify or pin a task, in either auto or shadow mode. It is not counted as a task start. The next genuine keyword match can still select `quick-edit` without reset. A decision-model classification of `default`, or an explicit configured keyword matching that route, remains eligible for pinning.

Add `/switchboard reset`: clear the task pin and expected-model comparison, persist the cleared state, and leave the live model, thinking level, and manual hold unchanged. The next eligible prompt can select a fresh route. `/switchboard on` remains the explicit way to clear manual hold. With keyword-only sticky routing, lowering the route requires `reset`; this is an intentional safety tradeoff, not an NLP heuristic. `sticky: false` continues to permit per-prompt rerouting.

### B. The router sees bounded evidence, not just reply openings

`Snapshot.latestRequest` holds the full request locally, so keywords inspect the entire input. Only the decision-engine serialization clips it. Introduce a shared `clipMiddle(text, maxChars)` helper: preserve the beginning and end, insert `\n…[middle omitted]…\n`, and include that marker in the maximum. Split remaining space evenly, giving the extra character to the beginning. Leave strings under the maximum unchanged.

Classifier text budgets are internal constants, not new configuration:

| Part | Maximum characters |
|---|---:|
| Latest request in decision payload | 8,000 |
| Readable portable compaction summary | 4,000 |
| Combined recent evidence | 12,000 |
| Each recent evidence item | 1,200 |

These bound text, not total JSON size or tokens. Do not claim a character budget is a token guarantee. Choose recent evidence newest-first within its allowance, then return it chronologically. `historyMessages` remains the maximum number of user/assistant messages; add at most four recent tool results within the same evidence budget. A limit of zero produces no recent evidence. Avoid collecting/clipping the whole journal only to discard most of it.

Select bounded evidence directly from the active branch, after its latest reset and current readable-compaction boundary. Use OMP's `getReadableCompactionEntry(branch, ctx.model)` rather than reproducing provider compatibility checks. For a portable summary, select retained messages from `firstKeptEntryId`; for native replay use entries after `providerReplayThroughEntryId` when present, otherwise select only entries after the compaction marker and flag unavailable earlier evidence. If a retained boundary cannot be located, restrict selection to entries after the compaction marker and flag the limitation rather than resurrecting compacted messages. Walk backward until the evidence limits are filled, then reverse the bounded result; never build a complete replay transcript. Include user/assistant text, a portable readable compaction summary, and tool name/error status plus text excerpts. Never serialize thinking blocks, signatures, opaque provider-native compaction payloads, or base64 image data to the classifier. Tool evidence remains untrusted data under the existing classifier instruction. Document the expanded decision-model disclosure.

When the active native compaction contains no portable summary, say that textual compacted evidence is unavailable; do not represent its placeholder as a real task summary. Earlier summaries may be included only if clearly labeled older context, not as the current state. Avoid duplicating the selected summary in both the summary field and recent evidence.

### C. Admit switches using live usage and compaction metadata

Only assess a candidate after routing policy selects an actual model change. Reuse `ctx.getContextUsage()?.tokens`; it already accounts for the current system prompt, tools, messages, and historical attachments. Do not count or serialize those again. Compare the IDs returned by `getReadableCompactionEntry(branch, current)` and `getReadableCompactionEntry(branch, target)` on the same reset-bounded branch. A different, older target boundary means history may expand.

Start with live usage and add a deliberately padded allowance for the unsubmitted text: `Buffer.byteLength(prompt, "utf8")`. Count the request once; an identical historical message is not this submission. This byte allowance is cheap and conservative for ordinary byte-tokenized text, not a universal tokenizer guarantee.

For expansion, add the recorded `tokensBefore` for **each** compaction after the target's readable boundary through the current model's readable boundary. If the target boundary is newer, keep the live usage floor without an expansion allowance. Do not subtract `tokensAfter`: that field is optional display metadata, and subtracting it would imply accuracy these records do not provide. Define:

```ts
const compactionAllowanceTokens = skippedCompactions.reduce(
  (total, entry) => total + entry.tokensBefore, 0,
);
const pendingTextBudgetTokens = Buffer.byteLength(prompt, "utf8");
const pendingImageBudgetTokens = imageCount * 8192;
const estimatedInputTokens =
  liveTokens + compactionAllowanceTokens + pendingTextBudgetTokens + pendingImageBudgetTokens;
const inputLimit = Math.floor(target.contextWindow * routing.contextWindowFraction);
```

This intentionally overcounts some compressed history to preserve the live tail and cover multiple skipped compactions. `max(liveTokens, tokensBefore)` is insufficient: a compaction's historical total excludes messages appended afterward, and one entry need not cover all older compactions the target cannot replay. The existing fraction supplies headroom; do not add a second reservation based on the model's advertised maximum output, which is not the actual configured output budget.

This is a conservative **admission heuristic**, not an exact target-token bound. Tokenizer differences, archive representation, and model-dependent scaffolding remain OMP's responsibility. Pending images add a fixed 8,192-token allowance each; allow a vision-capable target when the total estimate fits. This is not a universal bound, and base64 length is not a hard bound on visual tokens. Return `unknown` for missing/invalid live usage, target-window metadata or required skipped-compaction totals, never because an opaque historical payload cannot be decoded locally. A text-only target cannot receive pending images. Never substitute zero for missing required inputs.

Apply the check to every model change, including escalation, before `pi.setModel`. On refusal, retain model, thinking, and applied pin. Record live usage, pending text allowance, compaction allowance, skipped-compaction count, estimate, limit, and reason; show a concise keep-current notice in auto mode and expose details through `/switchboard explain`. No raw context in logs. Cache guard remains based on actual live usage, not the padded expansion estimate; the new admission check is separate. Shadow evaluates the same metadata without mutating host state. Exact replay reconstruction/tokenization is outside this plan, not an automatic fallback on this hot path.

### D. Routing state follows session ancestry

Persist versioned custom entries with `pi.appendEntry("switchboard-state", data)`. OMP explicitly excludes these from model context. Restore from the newest such entry on `getBranch()`, not the globally newest entry from sibling branches. Scan only after the latest reset boundary. A newer invalid/incompatible checkpoint must not cause resurrection of an older pin.

Persist route name or explicit `null` (reset tombstone), expected live model or `null`, manual hold, and a deterministic signature of effective resolved route names/models/thinking/ranks. Store no task text. If the signature or route no longer matches config, discard the pin and model expectation while preserving a valid manual hold. Do not guess which route a model represents: multiple routes can share one model.

Reload configuration before hydration at startup. Hydrate and clear transient run bookkeeping on `session_start`, `session_switch`, `session_branch`, and `session_tree`. Check for reset-boundary changes before routing so `/clear` cannot revive stale state. Compaction should preserve the pin when ancestry remains valid; test this rather than assuming all checkpoints remain visible.

Navigation keeps the host's live model, so clear a conflicting historical expectation after restoring the destination. Track actual run start/end rather than using `isIdle()` during prompt preparation. New input invalidates cancelled preparation bookkeeping, while same-submission policy retries remain deduplicated.

Persist applied transitions only after the triggering user message is present in the active branch; reset, hold and re-enable commands remain immediate. Retry pending commits on message/end boundaries without delaying host persistence. Compare checkpoint fields rather than JSON key order to suppress duplicate writes. Persist a backward-compatible `fallbackPending` flag so both fallback and later primary restoration remain host-owned until Switchboard successfully chooses a model. Failed/refused switches cannot persist the desired route as applied; partial failures retain actual model expectations and the prior pin.

Shadow mode uses a separate transient proposed pin. Entering auto restores the applied checkpoint, not the shadow pin. Shadow recommendations never append applied-state checkpoints; an explicit user `reset` still persists the cleared applied state. Session-scoped mode overrides remain session-scoped and are not made durable by this work.

## Verified Host APIs

The installed host is `18.20.0`. Declaration inspection and a Bun import probe confirmed this public subpath and selector are available:

```ts
import { getReadableCompactionEntry }
  from "@oh-my-pi/pi-coding-agent/session/session-context";
```

The earlier probe also loaded the context builder and tokenizer, but they are deliberately not used by the revised design. Import availability is not a proof of cross-provider replay fidelity; the integration scenario below remains necessary.

Also inspected: `ExtensionAPI.appendEntry<T>(customType, data): void`, lifecycle events, `CompactionEntry.tokensBefore`, `firstKeptEntryId`, `providerReplayThroughEntryId`, and `CustomEntry`. Use declared exports/subpaths, never `dist/` filesystem imports or private agent fields. Existing dependencies suffice; do not modify `package.json` or `bun.lock` for this work.

## File Map

| File | Responsibility |
|---|---|
| `src/routes.ts` | Conservative keyword boundary classification |
| `src/types.ts` | Richer snapshot evidence contracts |
| `src/snapshot.ts` | Compaction-aware bounded router evidence; middle clipping |
| `src/engines.ts` | Decision payload projection; retain full local keyword input |
| `src/context-budget.ts` (new) | Candidate-only target-context admission assessment |
| `src/state.ts` (new) | Versioned checkpoint parsing, ancestry restoration, compatibility |
| `src/index.ts` | Candidate guard, checkpoint lifecycle, explicit task reset, shadow/applied separation |
| `src/log.ts` | Optional numeric admission diagnostics; never context text |
| `README.md` | Updated keyword semantics, reset, privacy, persistence, admission limits |
| `test/routes.test.ts`, `test/policy.test.ts` | Existing routing behavior and cross-engine regressions |
| `test/snapshot.test.ts` (new) | Decision evidence selection and truncation edge cases |
| `test/context-budget.test.ts` (new) | Metadata admission, skipped compactions, missing-input rejection |
| `test/state.test.ts` (new) | Checkpoint restore/reset/branch behavior |
| `test/lifecycle.test.ts` (new) | Extension-level model, pin, and resume outcomes |

## Task 1: Stop keyword follow-ups from becoming certain task boundaries

**Files:** Modify `src/routes.ts`, `src/index.ts`, `test/routes.test.ts`, `test/policy.test.ts`, `README.md`. Add the command to existing usage/help text; do not create a second command dispatcher.

**Interfaces:** Keep `Classification` and `decide(PolicyInput): Verdict` unchanged. Produce `KeywordEngine.classify(...): Promise<Classification>` with the new boundary semantics and `/switchboard reset` as the explicit pin-clear path.

- [ ] Add this consumer-visible regression in `test/policy.test.ts`, importing `KeywordEngine` and `resolveRoutes` alongside existing imports:

```ts
test("keyword typo follow-up does not downgrade a pinned plan", async () => {
  const classification = await new KeywordEngine().classify(
    { latestRequest: "fix the typo you just added" },
    resolveRoutes(DEFAULT_CONFIG),
  );
  const verdict = decide(base({
    pinnedRoute: "plan",
    currentModel: "p/deep",
    contextTokens: 1000,
    cls: classification,
  }));
  expect(verdict).toMatchObject({
    pinnedRoute: "plan", switchModel: false, taskStart: false,
  });
});
```

- [ ] Change keyword boundary output without changing keyword scoring:

```ts
newTask: false,
newTaskConfidence: 0,
```

- [ ] Implement `reset` by clearing `pinnedRoute` and `expectedModel`, leaving current model/thinking/manual hold unchanged. When Task 4 introduces durable state, route this command through the same checkpoint path, including explicit null state.
- [ ] Cover: first keyword prompt selects a route; matching lower-rank follow-up stays pinned; higher-rank follow-up may escalate; `allowEscalation: false` prevents it; reset permits a cheaper next task; `sticky: false` allows per-prompt routing; decision-model confident new tasks still downgrade normally; decision timeout fallback uses conservative keyword semantics.
- [ ] Update README's keyword and stickiness sections with the explicit reset tradeoff. Remove the claim that every keyword match establishes a new task.
- [ ] Run once after edits: `bun test test/routes.test.ts test/policy.test.ts`. The regression must fail on the old keyword behavior and pass with this change; do not re-pin an implementation-shaped assertion.

## Task 2: Give the classifier the relevant beginning, ending, and recent evidence

**Files:** Modify `src/types.ts`, `src/snapshot.ts`, `src/engines.ts`, `src/index.ts`, `README.md`; create `test/snapshot.test.ts`.

**Interfaces:** Keep `buildSnapshot` as the orchestration entry point and update all callers for request images. Export `clipMiddle(text: string, maxChars: number): string`. Extend `Snapshot` with `summary?: string`, `attachmentCount: number`, `compactedEvidenceUnavailable: boolean`; keep `recent` as labeled `{ role: string; text: string }[]`. `latestRequest` is full local input. Both decision engines consume the same bounded `stateOf` projection.

- [ ] Run LSP references for `Snapshot`, `buildSnapshot`, and `recentMessages`; make the contract migration in one patch. Keep snapshot/engine responsibilities distinct: snapshot selects evidence, engine projection limits the latest request sent remotely.
- [ ] Add beginning-and-conclusion coverage, not merely a length assertion:

```ts
test("clipping preserves the goal and final restriction", () => {
  const text = "Investigate the regression. " + "x".repeat(5000)
    + " Do not edit production files.";
  const clipped = clipMiddle(text, 1200);
  expect(clipped.startsWith("Investigate the regression.")).toBe(true);
  expect(clipped.endsWith("Do not edit production files.")).toBe(true);
  expect(clipped).toContain("[middle omitted]");
});
```

- [ ] Select bounded evidence from the active branch using the boundary rules in Design Contract B. Reuse the branch snapshot for state and admission work. Read compaction metadata, not reconstructed native payloads, and never collect the full transcript just to slice its tail.
- [ ] Select text and at most four recent tool-result excerpts with name/error labels. Preserve chronological order after newest-first budget selection. Keep attachment information structural, not image descriptions invented by the plugin.
- [ ] Clip only the remote `latest_request` inside `stateOf`; keywords receive the complete local request. Expose truncation/unavailable-evidence flags to both chat and judge engines so absence is not mistaken for completeness.
- [ ] Cover: routing keyword after character 1200 is recognized; assistant conclusion survives clipping; failed tool result reaches the decision payload; thinking/signatures/images never do; current portable summary survives; native placeholder is flagged unavailable; sibling branch evidence is excluded; `historyMessages: 0` yields no recent items; clipping preserves valid Unicode; budgets include omission markers.
- [ ] Update README's decision-model privacy paragraph to name tool excerpts, summaries, truncation, and attachment counts. No raw snapshot logging.
- [ ] Run once after edits: `bun test test/snapshot.test.ts test/routes.test.ts test/engines-log-config.test.ts`.

## Task 3: Add lightweight, observable context admission

**Files:** Create `src/context-budget.ts`, `test/context-budget.test.ts`; modify `src/index.ts`, `src/log.ts`, `README.md`. No dependency or lockfile changes.

**Interfaces:** Produce this pure assessment contract, consumed by orchestration and focused tests:

```ts
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";

export type ContextAssessment =
  | {
      kind: "estimated-fit" | "blocked";
      liveTokens: number;
      pendingTextBudgetTokens: number;
      pendingImageBudgetTokens: number;
      compactionAllowanceTokens: number;
      skippedCompactions: number;
      estimatedInputTokens: number;
      inputLimit: number;
      reason: string;
    }
  | { kind: "unknown"; reason: string };

export function assessTargetContext(input: {
  branch: readonly SessionEntry[];
  current: Model;
  target: Model;
  liveTokens: number | undefined;
  prompt: string;
  imageCount: number;
  fraction: number;
}): ContextAssessment;
```

- [ ] Implement Design Contract C directly from live usage, pending UTF-8 text bytes, and readable-compaction metadata. Strip entries before the latest reset before selecting boundaries. Compare boundary IDs, not object identity. Sum every skipped compaction through the current readable boundary; do not replace the live tail with a historical maximum. Only inspect metadata and the incoming text, never historical message bodies, system prompts, tool schemas, or native replay payload contents.
- [ ] Add arithmetic regressions: before-compaction usage 80,000, post-compaction usage 20,000, and a later 50,000-token tail must not be assessed as only 80,000 before pending input. Cover multiple skipped compactions so a single maximum cannot accidentally replace the additive rule.
- [ ] Insert admission between policy selection and `pi.setModel`. Only `estimated-fit` permits the candidate to proceed. On `blocked`/`unknown`, retain live model, thinking, and applied pin; record the reason and show an auto-mode keep-current notice. Prevent route thinking reapplication after refusal. Shadow evaluates the same function without changing the host.
- [ ] Add optional numeric diagnostics to `DecisionRecord`: `pendingTextBudgetTokens`, `compactionAllowanceTokens`, `skippedCompactions`, `targetContextTokens`, and `targetInputLimit`; existing `contextTokens` remains live usage. Keep older JSONL readable and statistics unchanged. Extend existing `explain` output with those components and the explicit metadata-estimate label.
- [ ] Cover: unchanged/older/newer compaction boundaries, retained live tail, multiple skipped compactions, pending long/non-ASCII text, reset boundaries, exact limit, missing metadata, small first-prompt image accepted on a vision target, near-limit image refused, text-only target refused, historical images not recounted, cache guard distinct, escalation admission, same-model decisions skipping admission.
- [ ] Use synthetic typed branch metadata for arithmetic tests. Test real selector behavior separately with a host-valid native-compaction fixture; do not invent an encrypted replay format. The pure arithmetic tests do not claim to verify provider wire replay.
- [ ] Run a throwaway long-branch smoke scenario with large historical message payloads and measure assessment time. It must not reconstruct/tokenize those payloads; report observed timing without a machine-dependent permanent timing assertion. Remove the throwaway scenario afterward.
- [ ] Run once after edits: `bun test test/context-budget.test.ts test/policy.test.ts test/engines-log-config.test.ts`. Document the intentional overestimation, pending-image limit, tokenizer/scaffolding uncertainty, and visible rejection reasons in README. Do not advertise exact sizing or guaranteed fit.

## Task 4: Restore the applied route after resume and branch navigation

**Files:** Create `src/state.ts`, `test/state.test.ts`, `test/lifecycle.test.ts`; modify `src/index.ts`, `README.md`.

**Interfaces:** State stays outside classifier input and inside session custom entries:

```ts
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export interface RoutingCheckpoint {
  version: 1;
  pinnedRoute: string | null;
  expectedModel: string | null;
  manualHold: boolean;
  routeSignature: string;
  fallbackPending?: boolean;
}

export function restoreCheckpoint(
  branch: readonly SessionEntry[],
  routeSignature: string,
  routeNames: Readonly<Record<string, true>>,
): RoutingCheckpoint | undefined;
```

- [ ] Implement validated backward restoration from active ancestry, stopping at reset boundaries. Define a stable signature from resolved `[name, targetModelOrNull, thinkingOrNull, rank]` tuples sorted by route name; serialize with JSON, not a new hash dependency. Do not include credentials or prompt text.
- [ ] Persist changed checkpoints with `pi.appendEntry`, including reset tombstones. Keep this separate from `appendLog` and logging enablement. Reject unknown checkpoint versions and malformed state without throwing into the UI.
- [ ] Register hydration for start/switch/branch/tree. Clear only transient run state on transition; restore pin/model expectation/manual hold from the destination ancestry. Detect a reset boundary before the next route classification.
- [ ] Separate shadow proposal pins from applied pins. `/switchboard on` rehydrates applied state and clears manual hold/expected comparison intentionally; it does not inherit a hypothetical shadow downgrade. Route reset updates durable state even if logging is disabled.
- [ ] Preserve actual-state semantics on refused credentials, thrown switch/thinking calls, and retry fallback. Never checkpoint a route that failed admission or application.
- [ ] Cover: resume then `yes, continue` keeps the applied model; reset tombstone prevents resurrection; same-file tree navigation restores its own ancestor pin; a fork inherits only shared ancestry; switching sessions cannot retain another session's pin/manual hold; compaction preserves valid routing state; `/clear` invalidates it; removed/reconfigured routes do not restore stale pins; `logging: false` still persists state; shadow recommendations never become applied pins; manual hold and retry fallback survive resume correctly.
- [ ] Test the user-visible lifecycle through registered extension handlers in an isolated fake host with real branch entries. Do not load user config or write user sessions. Assertions concern final model/pin/hold, not counts of event registrations or source text.
- [ ] Run once after edits: `bun test test/state.test.ts test/lifecycle.test.ts`. Update README's command, resume, branch, and shadow descriptions.

## Task 5: Verify the actual switching surface and document limits

**Files:** No new production module. Modify only README if observed host behavior requires a factual correction. Use disposable sessions/config; do not change the user's real Switchboard config.

- [ ] Run package verification once after integration: `bun test && bun run check`.
- [ ] Launch the plugin in OMP using the documented local-extension mechanism and an isolated `PI_CODING_AGENT_DIR`. Exercise `/switchboard status`, `explain`, and `reset`; inspect visible model/thinking and decision reasons, not just unit-test return values.
- [ ] Live scenario: pin planning, submit `fix the typo you just added`, verify no keyword downgrade; reset, submit a genuinely cheap task, verify its route is now eligible.
- [ ] Live scenario: long prompt ending in a restriction, with a recent failed tool result; inspect the bounded decision payload in a disposable local harness, not production logs. Confirm the ending/error is present and no hidden reasoning or image bytes are sent.
- [ ] Live scenario: compact a disposable session using a provider-native method, request a route to another provider with a smaller window, and verify the metadata allowance and decision reason are visible. Observe an allowed switch end to end without claiming the heuristic proves exact fit. Resume and tree-navigate that session; confirm the applied pin follows ancestry.
- [ ] If provider credentials make a live scenario unavailable, do not claim that scenario passed. Record the exact unverified scenario and the local checks that did run. Do not replace a live cross-provider claim with a mocked provider success.
- [ ] Remove disposable harnesses/session files created by this work. Keep permanent behavioral regression tests and README changes. No commits, PRs, or config changes without user instruction.

## Acceptance Summary

1. A routine keyword follow-up cannot downgrade an active sticky task; an explicit reset or decision-model-confirmed new goal can.
2. The classifier receives bounded starts/endings, portable task context, and recent failure evidence; local keywords retain the full input.
3. Every actual model change receives a cheap metadata admission check including live usage, pending text, and skipped compactions. Missing required inputs and oversized estimates keep the current model with a visible reason; no historical replay reconstruction/tokenization occurs on the routing path.
4. Resume, fork, tree navigation, compaction, and clear/reset produce branch-correct applied routing state, independently of diagnostic logging.
5. Shadow, manual model choice, retry fallback, subagent exclusion, and once-per-run routing retain their documented semantics.
6. OMP remains the only owner of transcript transfer and compaction. No additional summarization model call is introduced.

## Recommended Execution Order and Tradeoffs

Execute Tasks 1–4 in order, then Task 5. Keyword safety lands first because it prevents unnecessary handovers before context representation changes. Keep review checkpoints at each task boundary; run focused checks only after that task's edits are complete.

Deliberate tradeoffs: keyword-only sticky sessions require `reset` for a downgrade; additive compaction allowances, UTF-8 text budgeting and fixed image allowances can refuse switches that would fit. Explain refusals rather than claiming exact sizing. Tokenizer, image-resolution and model-scaffolding differences still mean the heuristic cannot guarantee provider acceptance. User-approved refinement: image prompts are not categorically unroutable.
