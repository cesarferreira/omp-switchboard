# omp-switchboard

Automatic per-prompt model and thinking-level routing for [Oh My Pi](https://github.com/can1357/oh-my-pi), in the spirit of [pi-dialer](https://github.com/eSaadster/pi-dialer), with one addition: an optional **decision model** that picks the route instead of keywords.

Each prompt is matched to a task type (**route**): `plan`, `implement`, `deep-dive`, `quick-edit`, `default`, or your own. The route's model and thinking level are applied before the agent starts.

## Install

```sh
omp plugin link /path/to/omp-switchboard     # or: omp -e /path/to/omp-switchboard/src/index.ts
```

It starts in `shadow` mode (logs what it would do, never switches). `/switchboard on` enables switching for the session; `"mode": "auto"` makes it permanent.

## How routes are chosen

1. **Keywords** (default, no model needed). Each matched phrase scores its word count; the highest total wins ("quick fix" beats "fix"); ties keep the earliest route. No match means `default`, which is treated as a follow-up and stays on the pinned route.
2. **Decision model** (`decision.model` set). A model reads the latest request plus recent conversation and picks a route using each route's `description`, and says whether it is a new task. A judgment-API model (`openai-decisions`, `google-decisions`, ...) answers through OMP's native judge with real probabilities; any chat model is prompted for JSON. If the decision model fails or times out, keywords are used for that prompt.

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

`/switchboard on|off|shadow|status|explain|stats|routes|setups|save <name>|use <name|none>|reload|help`. on/off/shadow are session-scoped.

`/switchboard-setup` picks a model and thinking level per route interactively and writes them to the active setup, or to the top-level `routes`.

## Stickiness, escalation, cache guard

- A prompt starts a task when nothing is pinned or the classifier is confident it is a new task. Otherwise the pinned route stays (so "yes, continue" does not re-route).
- With a decision model, a follow-up can escalate to a higher-`rank` route (never down) when confident.
- Cache guard: above `cacheGuardTokens` of context, non-escalating model changes are refused because they would discard the prompt cache.
- Context guard: a switch is refused when the conversation is larger than `contextWindowFraction` (default 80%) of the target model's context window, so a route with a small-window model cannot be entered from a long session.
- Below `minConfidence`, an engine error, or an unresolvable route model: the current model is kept.
- Subagents are never routed.

## Response stamp

With `"stamp": true` (default `false`), the TUI draws a line under the final text of each routed run:

```
---
_Switchboard: quick-edit → bifrost/gpt-6-luna · thinking low · matched: "rename"_
```

In shadow mode it reads "Switchboard (shadow, not applied)". The stamp is display-only: it is drawn by an assistant-text renderer, so the session, exports and model context keep the reply exactly as written. It appears in the TUI only (not in print/RPC output) and is not restored when you resume a session.

**Opt-in.** Reply renderers only run while OMP's `extensionRenderers.assistantText` setting is on (Tools → Extensions → Extension Reply Renderers), and turning it on changes streaming and scrollback behaviour for all replies and all extensions' renderers. Setting `"stamp": true` is your consent: Switchboard then turns that setting on for the running process (never persisted, and only if you have not configured it yourself). If OMP moves the setting's registry module, Switchboard logs a warning and keeps routing; enable the setting by hand to get the stamp back.

## Log

`~/.omp/agent/switchboard/decisions.jsonl`: one `decision` record per prompt (classifier, latency, cost, route, matched keywords, applied vs would-switch) and one `outcome` record per run (model, duration, tool calls/errors, aborted). Prompts are not stored unless `logPrompts` is true. With a decision model, the latest request and recent conversation text are sent to it.

## Interactions

- Routing happens once per run; steer/follow-up batches inside a running turn are not re-classified.
- OMP's own `prewalk.auto` and `defaultThinkingLevel: auto` also pick models per task. If enabled they can override Switchboard's choice at task start; use one router at a time.

## Not yet

Project-local config, a virtual "Switchboard" model in the picker, learning from outcomes, per-task cost estimation.
