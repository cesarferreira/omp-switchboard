# omp-switchboard

Automatic per-prompt model and thinking-level routing for [Oh My Pi](https://github.com/can1357/oh-my-pi), in the spirit of [pi-dialer](https://github.com/eSaadster/pi-dialer), with one addition: an optional **decision model** that picks the route instead of keywords.

Each prompt is matched to a task type (**route**): `plan`, `implement`, `deep-dive`, `quick-edit`, `default`, or your own. The route's model and thinking level are applied before the agent starts.

## Install

```sh
omp plugin link /path/to/omp-switchboard     # or: omp -e /path/to/omp-switchboard/src/index.ts
```

It starts in `shadow` mode (logs what it would do, never switches). `/switchboard on` enables switching for the session; `"mode": "auto"` makes it permanent.

## How routes are chosen

1. **Keywords** (default, no model needed). Each matched phrase scores its word count; the highest total wins ("quick fix" beats "fix"); ties keep the earliest route. Keywords select the first route or escalate a pinned task, but do not prove a new task. Before any task is identified, a keyword miss may use `default` without pinning it, so "hi" does not prevent "rename foo" from selecting `quick-edit`. Use `/switchboard reset` before a cheaper, unrelated task, or disable `routing.sticky` for per-prompt routing.
2. **Decision model** (`decision.model` set). A model reads a bounded view of the latest request, recent conversation, portable compaction summary and recent tool results, then picks a route using each route's `description` and says whether it is a new task. A judgment-API model (`openai-decisions`, `google-decisions`, ...) answers through OMP's native judge with real probabilities; any chat model is prompted for JSON. If the decision model fails or times out, conservative keywords are used for that prompt.

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
| `rank` | built-in rank, else 1 | Strength. Follow-ups may escalate to a higher rank, never down |

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

`/switchboard on|off|shadow|reset|status|explain|stats|routes|setups|save <name>|use <name|none>|reload|help`. on/off/shadow are session-scoped. `reset` clears the task pin, not the conversation or live model; it does not release a manual-model hold (`on` does that).

`/switchboard-setup` picks a model and thinking level per route interactively and writes them to the active setup, or to the top-level `routes`.

## Stickiness, escalation, cache guard

- An identified task starts when nothing is pinned or the classifier is confident it is a new task. Otherwise an existing pin stays (so "yes, continue" does not re-route).
- With a decision model, a follow-up can escalate to a higher-`rank` route (never down) when confident.
- Cache guard: above `cacheGuardTokens` of context, non-escalating model changes are refused because they would discard the prompt cache.
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

`~/.omp/agent/switchboard/decisions.jsonl`: one `decision` record per prompt (classifier, latency, cost, route, matched keywords, actual model/thinking changes, admission estimate and reason) and one `outcome` record per run (model, duration, tool calls/errors, aborted). `/switchboard stats` reports **model switches** separately from **thinking changes**; legacy `applied` records are counted as model switches only when they also requested a model switch. `/switchboard explain` shows before/after model identities and whether anything actually changed. Prompts are not stored unless `logPrompts` is true, and then only a short preview is logged. Decision models receive the bounded request/conversation/summary/tool excerpts and attachment counts described above, never hidden reasoning, signatures or image bytes.

## Interactions

- Routing happens once per started run; steer/follow-up batches and automatic continuation are not re-classified. A cancelled preparation does not keep the next submission locked out.
- A manual `/model` switch is respected: when the live model is not the one Switchboard left, auto-routing pauses (you get a notice, and `/switchboard status` shows `routing: paused`) until you run `/switchboard on`. Shadow mode keeps logging. Navigation re-baselines historical model expectations without changing the live model. Retry fallback and the host's later primary restoration are not mistaken for manual choices; while that host-managed transition is pending, Switchboard cannot infer manual changes from model identity alone.
- Invalid route fields in `switchboard.json` (an unknown `thinking` level, `keywords` that is not a list, ...) are dropped with a warning at load, never passed to the host.
- OMP's own `prewalk.auto` and `defaultThinkingLevel: auto` also pick models per task. If enabled they can override Switchboard's choice at task start; use one router at a time.

## Not yet

Project-local config, a virtual "Switchboard" model in the picker, learning from outcomes, per-task cost estimation.
