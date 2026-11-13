# omp-switchboard

Context-aware model router for [Oh My Pi](https://github.com/can1357/oh-my-pi). Before each user prompt it asks a cheap decision model how hard the task is and whether it is a new task, then pins the matching model + thinking level.

## Install

```sh
omp plugin link /path/to/omp-switchboard     # or: omp -e /path/to/omp-switchboard/src/index.ts
```

## Config: `~/.omp/agent/switchboard.json`

All keys optional; this is the default (`${VAR}` is expanded in strings):

```json
{
  "enabled": true,
  "mode": "shadow",
  "decision": { "model": "@smol", "timeoutMs": 15000 },
  "routing": {
    "sticky": true,
    "allowEscalation": true,
    "cacheAware": true,
    "cacheGuardTokens": 60000,
    "minConfidence": 0.6,
    "historyMessages": 6
  },
  "tiers": {
    "fast":     { "model": "@smol", "thinking": "low" },
    "standard": { "model": "@task", "thinking": "medium" },
    "deep":     { "model": "@slow", "thinking": "high" }
  },
  "logging": true,
  "logPrompts": false
}
```

`mode`: `shadow` (default; log recommendations, never switch), `auto`, `off`.

### Decision engine

Chosen by the API of `decision.model`:

- **Judgment API** (`openai-decisions`, `google-decisions`, `typesafe`, ...): OMP's native judge answers two typed `choice` questions with real probabilities. Declare the model in `models.yml` with that `api`; the gateway must serve `{baseUrl}/decisions`.
- **Any other model**: prompted to return JSON (`{task, tier, confidences}`). Works with any chat model, including Bifrost ones.

## Routing rules

- New task (or first prompt): re-route to the classified tier.
- Follow-up: stay pinned; escalate (never downgrade) if harder and `allowEscalation`.
- Confidence below `minConfidence`, engine error/timeout, or unresolvable tier model: keep the current model.
- Cache guard: with more than `cacheGuardTokens` of context, non-escalating model changes are refused (they would discard the prompt cache). Escalation and `deep` pass.
- Subagents are never routed.

## Commands

`/switchboard on|off|shadow|status|explain|stats|models|reload` (on/off/shadow are session-scoped).

## Log

`~/.omp/agent/switchboard/decisions.jsonl`: one `decision` record per prompt (engine, latency, cost, classification, applied vs would-switch) and one `outcome` record per run (model, duration, tool calls/errors, aborted). Prompts are not stored unless `logPrompts` is true. Note the decision model receives the latest request and recent conversation text.

## Interactions

- Routing happens once per run; steer/follow-up batches inside a running turn are not re-classified.
- OMP's own `prewalk.auto` and `defaultThinkingLevel: auto` also pick models per task. If enabled they can override Switchboard's choice at task start; use one router at a time.

## Not yet

Learning from outcomes, per-task cost estimation, project-level config.
