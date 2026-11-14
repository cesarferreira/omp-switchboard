# omp-switchboard

Automatic per-prompt model and thinking-level routing for [Oh My Pi](https://github.com/can1357/oh-my-pi), in the spirit of [pi-dialer](https://github.com/eSaadster/pi-dialer), with one addition: an optional **decision model** that picks the route instead of keywords.

Each prompt is matched to a task type (**route**): `plan`, `implement`, `deep-dive`, `quick-edit`, `default`, or your own. The route's model and thinking level are applied before the agent starts.

## Install

```sh
omp plugin link /path/to/omp-switchboard     # or: omp -e /path/to/omp-switchboard/src/index.ts
```

It starts in `shadow` mode (logs what it would do, never switches). `/switchboard on` enables switching for the session; `"mode": "auto"` makes it permanent.

**Status: experimental; auto mode is opt-in.** Routing overhead and correct-looking categories do not establish lower total cost or equal task quality. The measured starter run below did not beat the fixed-model baselines.

## How routes are chosen

1. **Keywords** (default, no model needed). Each matched phrase scores its word count; the highest total wins ("quick fix" beats "fix"); ties keep the earliest route. Keywords select the first route or escalate a pinned task, but do not prove a new task. Before any task is identified, a keyword miss may use `default` without pinning it, so "hi" does not prevent "rename foo" from selecting `quick-edit`. Use `/switchboard reset` before a cheaper, unrelated task, or disable `routing.sticky` for per-prompt routing.
2. **Decision model** (`decision.model` set). A model reads a bounded view of the latest request, recent conversation, portable compaction summary and recent tool results. It selects both a route and an intent (`continue`, `phase_change`, `new_task`). Judgment APIs (`openai-decisions`, `google-decisions`, ...) use OMP's native judge; chat models are prompted for JSON. Invalid answers or timeouts fall back to conservative keywords during normal routing. Neither model-reported probabilities nor numbers in a chat reply are assumed to be calibrated.

## Why a decision model, and what it decides

The router asks bounded questions; the selected coding model still does the actual work. This keeps the routing interface small and inspectable without adding another planner, summarizer, learning service or transcript-transfer mechanism. OMP owns conversation replay and compaction.

**Task continuity is not model continuity.** Route type and permission to change phase are separate judgments:

| Latest request, given the conversation | Intent | Policy with a pinned planning route |
|---|---|---|
| "Yes, continue" | `continue` | Keep the phase |
| "Correct the typo in that plan" | `continue` | A `quick-edit` classification alone cannot downgrade it |
| "How would we implement this?" | `continue` | Discuss implementation; do not assume execution approval |
| "Implement the approved plan" | `phase_change` | May move to `implement`, even at a lower rank |
| "Do that then", after an explicit implementation proposal | `phase_change` | Interpret the approval using the recent evidence |
| "Unrelated: fix the login screen" | `new_task` | Choose a fresh route |

Built-in route descriptions and the intent criteria include examples and counterexamples. Custom route descriptions should do the same: describe the requested work, where it ends, and which similar requests belong elsewhere. The decision model chooses a category; it does **not** establish that a particular provider/model is best at that category.

An explicit phase handoff requires **both intent confidence and route confidence** to meet `routing.minConfidence`. Rank is used only for automatic within-phase escalation, not as a permanent prohibition on moving to another phase. `allowEscalation: false` disables those automatic upgrades; it does not turn an explicit, confident phase handoff into a continuation. A same-route phase judgment needs no handoff. Keywords cannot establish phase changes and retain the safer reset-based downgrade path.

The default confidence threshold is an operating setting, not a measured accuracy guarantee. Missing or invalid chat confidence becomes zero; malformed native decisions fail closed to keyword fallback. Do not copy a threshold from a paper and assume it applies to your judge, descriptions or traffic.

## Design evidence, not a savings promise

- [Haldar's decision-model harness experiments](https://vivekhaldar.com/articles/llms-do-too-much-offload-to-decision-models/) offload narrow completion and business-classification decisions, with uncertainty falling back to the main LLM. Those are not direct tests of coding-model selection.
- [Tetrate's Jev-directed routing](https://tetrate.io/blog/jev-directed-model-routing) closely matches the typed-choice approach here. Its measurements concern the routing decision, not downstream task quality or a whole session's bill.
- [Not Diamond Code](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents) considers session history and cache economics. Switchboard's context-size cache guard is only a heuristic, not that learned optimizer.
- [RouteLLM](https://www.lmsys.org/blog/2024-07-01-routellm/) learns from response-quality preferences and evaluates cost/quality tradeoffs. Switchboard's route-to-model mappings are user choices, not trained capability estimates.
- [Fast Models, Slow Evidence](https://arxiv.org/abs/2610.02267) found weak zero-shot model-routing results for the tested Laya/Jev models. That is a caution to measure, not a verdict on a configured Luna judge or this plugin.
- [Decision Models as Policy Gates for Coding Agents](https://arxiv.org/abs/2611.02155) motivates testing explicit boundaries and counterexamples. Its synthetic policy-gating results do not establish routing accuracy here.

These sources justify evaluating the architecture. They do not validate our model assignments, thresholds, cache policy or production savings. In the session that motivated this work, the recorded classifier decisions all chose `plan`; they did not show an `implement` recommendation being blocked. Staying on the planning model in those records was consistent with the classifier and pin.


## Config: `~/.omp/agent/switchboard.json`

All keys optional. `${VAR}` is expanded in strings.

```json
{
  "mode": "shadow",
  "decision": { "model": "bifrost-decisions/gpt-6-luna", "timeoutMs": 15000 },
  "routing": {
    "sticky": true,
    "allowEscalation": true,
    "cacheAware": true,
    "cacheGuardTokens": 60000,
    "contextWindowFraction": 0.8,
    "minConfidence": 0.6,
    "historyMessages": 6
  },
  "routes": {
    "plan":       { "model": "@slow",  "thinking": "high" },
    "quick-edit": { "model": "@smol",  "thinking": "low", "keywords": ["rename", "typo", "bump"] },
    "research":   { "model": "bifrost/gpt-6-sol", "thinking": "xhigh", "keywords": ["benchmark"],
                    "description": "Comparing libraries or surveying the state of the art.", "rank": 3 }
  },
  "stamp": false,
  "logging": true,
  "logPrompts": false
}
```

Per route:

| Field | Default | Meaning |
|---|---|---|
| `model` | built-in route's model; unset or `""` = keep current model | `provider/id`, bare id, or role alias (`@smol`, `@task`, `@slow`, `@default`) |
| `thinking` | built-in route's level | `off` `minimal` `low` `medium` `high` `xhigh` |
| `keywords` | built-in list | Phrases that select the route. Setting it **replaces** the built-in list. A custom route needs keywords (or a decision model plus `description`) to be chosen. |
| `description` | built-in text, else derived from keywords | What the route is for; shown to the decision model |
| `rank` | built-in rank, else 1 | Relative strength for within-phase escalation; a confident explicit phase handoff may move either way |

Built-in routes (all overridable): `plan` and `deep-dive` use `@slow`/high, `implement` uses `@task`/medium, `quick-edit` uses `@smol`/low, `default` uses `@default`/medium.

`decision.model` accepts `provider/id`. Declare judgment-API models in `models.yml` with `api: openai-decisions` (the gateway must serve `{baseUrl}/decisions`).

## Named setups

```
/switchboard save quality     # snapshot the current routes as "quality" and activate it
/switchboard-setup            # edits now apply to the active setup
/switchboard save cheap
/switchboard use quality
/switchboard use none         # back to the top-level routes
```

Stored under `setups` (same `routes` shape) with `activeSetup` naming the one in effect. A setup's routes override the top-level ones per field. These commands rewrite `switchboard.json` (JSON formatting is normalised; `${VAR}` references you wrote by hand are kept).

## Commands

`/switchboard on|off|shadow|reset|status|explain|stats|routes|setups|save <name>|use <name|none>|reload|evaluate [file]|benchmark [file]|help`. on/off/shadow are session-scoped. `reset` clears the task pin, not the conversation or live model; it does not release a manual-model hold (`on` does that). Restart or reload OMP to load changed plugin code; `/switchboard reload` only re-reads configuration.

`/switchboard-setup` picks a model and thinking level per route interactively and writes them to the active setup, or to the top-level `routes`.

## Stickiness, escalation, cache guard

- An identified task starts when nothing is pinned or the judge confidently selects `new_task`. Continuations keep the pin unless an allowed higher-rank escalation is selected.
- A confident `phase_change` can hand off to a different route of any rank without counting it as a new goal. This changes the pin only if application succeeds. Shadow keeps a separate proposed pin.
- Cache guard: above `cacheGuardTokens` of live context, non-escalating model changes are refused, **including phase handoffs and new tasks**. This is a coarse protection against losing a valuable prompt cache; it does not query actual cache warmth, cache expiry, future work, or monetary break-even. An upgrade can still pass. `/switchboard explain` shows when this—not stickiness—kept a model. The guard was deliberately not weakened without workload evidence.
- Context guard: the existing live-usage check is followed by a metadata-only estimate for the proposed target. It includes the incoming text's UTF-8 byte count, an **8,192-token allowance per pending image**, and recorded pre-compaction totals for history the target must re-expand. Estimates above `contextWindowFraction` (default 80%) of the target window keep the current model. Images can route when they fit and the target supports image input.
- Below `minConfidence` or with an unresolvable route model, the current model is kept. A decision-engine error falls back to conservative keywords, which cannot downgrade a pinned task.
- Subagents are never routed.
- Context guard and cache guard both keep the current model rather than failing the prompt.
- This estimate is deliberately padded, not a guaranteed target-token count. Tokenizers, image resolutions and provider scaffolding vary. Missing required metadata also keeps the current model with an auto-mode notice and details in `/switchboard explain`. The routing path never rebuilds or tokenizes the full history and adds no dependency.
- Applied route pins and manual holds are stored as branch-local session metadata, outside model context, independently of diagnostic logging. A derived checkpoint follows its durable user message, so editing or cancelling that request cannot inherit its own pin. Resume/fork/tree navigation restores the selected ancestry; clear/reset cannot resurrect an older pin. Config/model-role changes invalidate incompatible pins. Shadow recommendations are separate and never become applied pins.
- The classifier keeps message beginnings and endings rather than only openings. Local keywords see the full request. Remote text budgets are 8,000 characters for the latest request, 4,000 for a portable summary, and 12,000 combined recent evidence (1,200 per item, at most four tool results in addition to `historyMessages` user/assistant items). A zero history limit omits recent evidence. Native-only compacted evidence is labeled unavailable rather than presented as a real summary.

## Response stamp

With `"stamp": true` (default `false`), the TUI draws a line under the final text of each routed run:

```
---
_Switchboard: quick-edit → bifrost/gpt-6-luna · thinking low · matched: "rename"_
```

In shadow mode it reads "Switchboard (shadow, not applied)". The stamp is display-only: it is drawn by an assistant-text renderer, so the session, exports and model context keep the reply exactly as written. It appears in the TUI only (not in print/RPC output) and is not restored when you resume a session.

**Opt-in.** Reply renderers only run while OMP's `extensionRenderers.assistantText` setting is on (Tools → Extensions → Extension Reply Renderers), and turning it on changes streaming and scrollback behaviour for all replies and all extensions' renderers. Setting `"stamp": true` is your consent: Switchboard then turns that setting on for the running process (never persisted, and only if you have not configured it yourself). If OMP moves the setting's registry module, Switchboard logs a warning and keeps routing; enable the setting by hand to get the stamp back.

## Log

`~/.omp/agent/switchboard/decisions.jsonl`: one `decision` per routed prompt (engine, intent/route confidence, selected route, phase handoff, actual model/thinking mutations, metadata admission and reason) and one settled `outcome` per run. Outcomes include duration, tool errors, assistant-call token/cache usage and normalized execution costs from the host. Errored and aborted assistant messages with reported usage count too.

`/switchboard stats` separates **model switches** from **thinking changes**, routing overhead from execution cost, and known costs from missing data. It reports pricing coverage; unknown usage is not silently treated as zero. Old JSONL remains readable, but old rows without cost/intent data cannot supply those measurements. `/switchboard explain` shows the classifier's intent, route, guard reason and actual before/after model.

**Cost provenance:** normalized OMP/SDK usage may be calculated using catalog or custom-model prices; it is not an invoice. Verify those prices, particularly zero-valued custom-model pricing. All-zero custom cards are unknown unless explicitly marked free/included, and unknown/variable pricing is not counted as a known bill. Field coverage does not establish that a price is correct. Synthetic zero usage on an errored/aborted response cannot establish a free failed request. Provider-hidden retries, compaction charges, other agents and external tool bills are not inferred. Normal logs alone cannot establish routing accuracy or counterfactual savings: they have neither correct-route labels nor answers from models that were not run.

Normal prompt logging remains off unless `logPrompts` is true (a short preview only). Decision models receive the bounded conversation/summary/tool evidence and attachment counts described above, not hidden reasoning, signatures or image bytes. Explicit evaluation reports below are separate local artifacts; benchmark reports include generated answers.

## Evaluating your configuration

The repository ships a **synthetic starter corpus**, not a production accuracy claim:

- `evaluation/routing-cases.json`: 21 manually labeled scenarios, separated into development and holdout splits, including contextual approval, local corrections, unrelated goals, ambiguous requests and guard refusals. Route, intent and final policy outcome are scored independently; classifier errors stay in the denominator.
- `evaluation/tasks.json`: six self-contained coding/comprehension and mechanical-transform questions with hand-derived JSON answers. Answers are compared structurally, not by prose wording. No model-generated code is executed.

```text
/switchboard evaluate
/switchboard evaluate /absolute/path/to/routing-cases.json
/switchboard benchmark
/switchboard benchmark /absolute/path/to/tasks.json
```

**These commands make billable calls**, even in shadow mode. They do not change the live model, thinking level, task pin or repository files. They use your configured decision engine (`keywords` when none is configured), models and credentials. Classifications use `decision.timeoutMs`; answer completions have a separate 60-second deadline and a 4,096-token output cap (or the model's lower advertised cap), so deadlines and reasoning settings affect results. Evaluation records judge errors rather than disguising them with normal keyword fallback.

`evaluate` measures the actual classifier against the labels and then runs the real routing policy. Development/holdout summaries include intent accuracy, route accuracy, policy agreement, latency, errors and reported classifier costs. A policy can correctly refuse a classifier's requested handoff because of cache/context protection. A policy-only unit test proves no classifier accuracy.

A fixture's `currentRoute` must name a route with a resolvable model, because it defines that case's starting model. Candidate routes configured to keep the current model still use production's model-less policy semantics, rather than inventing a target/window for them.

`benchmark` makes a separate routed completion and fixed-route completions for `plan`, `default` and `quick-edit` for each task: six routing classifications and 24 answer attempts with the bundled file. Routed totals include classification overhead. Baseline order rotates to reduce order bias; no answer is reused across paths even when they pick the same model. Reports show correctness and failure counts, latency, reported costs and coverage. Savings percentages are omitted when costs are incomplete or a baseline cost is zero.

Complete JSON reports are written under `~/.omp/agent/switchboard/evaluate-*.json` or `benchmark-*.json` (respecting `PI_CODING_AGENT_DIR`). The command prints the report path and summary. Routing reports omit raw prompts/history; benchmark reports contain model answers. Do not commit private prompts or reports unintentionally. Manual reports are created even with `logging: false`.

**Limits:** this is not a full coding-agent benchmark. Each answer task starts without inherited conversation or a pin, uses no tools, and does not reproduce multi-turn cache/compaction/retry behavior. Provider caches and load are not controlled. A high starter-corpus score or a cheaper short answer is not proof of equal repository-level task quality or lower long-session cost.

Use the development cases to improve descriptions, then evaluate untouched, representative held-out requests. For a deployment decision, also run complete disposable agent tasks against fixed-model baselines and compare task completion/tests, total normalized cost and latency, including routing, retries and cache effects. The plugin cannot infer that counterfactual from normal logs.

Local verification:

```sh
bun test
bun run check
```

### One measured starter run

Using the configured native `bifrost-decisions/gpt-6-luna` judge, the bundled routing corpus produced **20/21 route matches, 18/21 intent matches and 16/21 desired policy outcomes**, with no classifier errors. Some otherwise correctly named handoffs were conservatively refused because confidence did not meet the existing threshold. These labels are synthetic and these counts are not a production-accuracy estimate; they were not used to lower the threshold or relabel failures.

The separate six-task JSON-answer benchmark used SOL/high for `plan`, Sonnet/medium for `default`, and Luna/off for `quick-edit`:

| Path | Correct answers | Errors | Normalized cost (USD) | Mean latency (ms) |
|---|---:|---:|---:|---:|
| Routed | 3 | 3 | 0.006522 | 2151 |
| Fixed `plan` | 6 | 0 | 0.003958 | 2944 |
| Fixed `default` | 3 | 3 | 0.006838 | 1291 |
| Fixed `quick-edit` | 6 | 0 | 0.000227 | 1468 |

The errors were invalid-JSON answers and remain failures; they were not filtered out or repaired until the scores looked good. This initial run used the earlier shared 15-second deadline; the current command separates the 60-second completion deadline from classifier timeouts. The gateway reported zero classifier spend for that run, so normalized totals are not audited invoices. On these small tasks, the routed policy was **not** a quality/cost winner. This motivates measuring your mappings and request distribution, not enabling automatic routing by default or concluding that a fixed small model solves long-horizon repository work.

## Interactions

- Routing happens once per started run; steer/follow-up batches and automatic continuation are not re-classified. A cancelled preparation does not keep the next submission locked out.
- A manual `/model` switch is respected: when the live model is not the one Switchboard left, auto-routing pauses (you get a notice, and `/switchboard status` shows `routing: paused`) until you run `/switchboard on`. Shadow mode keeps logging. Navigation re-baselines historical model expectations without changing the live model. Retry fallback and the host's later primary restoration are not mistaken for manual choices; while that host-managed transition is pending, Switchboard cannot infer manual changes from model identity alone.
- Invalid route fields in `switchboard.json` (an unknown `thinking` level, `keywords` that is not a list, ...) are dropped with a warning at load, never passed to the host.
- OMP's own `prewalk.auto` and `defaultThinkingLevel: auto` also pick models per task. If enabled they can override Switchboard's choice at task start; use one router at a time.

## Not yet

Project-local config, a virtual "Switchboard" model in the picker, learning from outcomes, per-task cost estimation.
