# omp-model-router

Automatic, intent-based model routing for the [omp](https://github.com/oh-my-pi) / Pi Agent coding harness.

It classifies each turn's *intent* before the agent runs and switches the active model and reasoning effort to match — no need to say "use model X" or manually flip `/model` before planning vs. quick edits vs. heavy refactors.

## Why

Most coding-agent sessions mix very different kinds of work in one conversation: a quick lookup, a multi-file refactor, an architecture decision, a one-line fix. Each of those wants a different model tier and reasoning budget, but manually switching before every message is friction nobody keeps up. This extension automates that switch using the model **roles** you already configure in omp — it never hardcodes a specific model or vendor.

## What it does

On every user turn, before the agent starts, the router:

1. Classifies the prompt into one of four intent tiers using lightweight pattern matching (code blocks and inline code are stripped first, so pasted source won't skew the classification).
2. Resolves the tier to one of your configured model **roles** and sets the model + reasoning effort for that turn.
3. Shows the decision on the status line and logs it, so routing is never a silent black box.

| Tier | Role used | Reasoning | Typical trigger |
|---|---|---|---|
| **plan** | `@plan` (interactive) or `@slow` (headless) | max / high | "plan", "architect", "design", "how should we…", "figure out how…" |
| **heavy** | `@slow` | high | refactor, migrate, rewrite, security/infra/money keywords, ≥3 files referenced |
| **default** | `@default` | inherited | everything else — the fallthrough workhorse tier |
| **trivial** | `@tiny` | low | typo/rename/format fixes, short lookups |

### Why plan-tier splits interactive vs. headless

Some providers' top reasoning tiers behave differently — or refuse outright — when invoked non-interactively (e.g. via `-p`/print mode, or from a subagent). To avoid that failure mode, the router **never** selects the `@plan` role when there's no interactive UI (`ctx.hasUI === false`); headless planning routes to `@slow` instead, with an injected rigor directive that asks the model to apply the same disciplined reasoning process regardless of tier.

### Fallback on mid-run failure

If the plan-tier model errors out partway through a run, the router falls back to the `@slow` role (configurable) for the remainder of the session and notifies you. This is a best-effort continuity guard, not a guarantee against every failure shape — a provider that returns a "soft refusal" as a normal (non-error) response won't trigger it. If that happens, use `/route heavy` to force a different tier immediately.

## Requirements

You need at least the following model roles configured (omp's `/models` UI, or `modelRoles:` in your `config.yml`):

- `@plan` — your best/most expensive reasoning model, for architecture-grade work
- `@slow` — a strong general-purpose model for heavy implementation work
- `@default` — your everyday workhorse model
- `@tiny` — a fast/cheap model for trivial tasks

If a role isn't configured, the router logs a warning and leaves the model untouched for that turn — it never crashes your session.

## Install

Clone or add as a submodule, then point omp at it:

```bash
git clone https://github.com/<owner>/omp-model-router ~/.omp/agent/extensions/omp-model-router
```

omp auto-discovers one-level subdirectories under `~/.omp/agent/extensions/` that have an `index.ts`/`index.js` or a `package.json` manifest with an `omp.extensions` field — this repo ships exactly that. Restart your session and the router loads automatically.

Alternatively, load it explicitly for a single run:

```bash
omp -e /path/to/omp-model-router/src/router.ts
```

## Configuration

Everything is tunable without touching code via `~/.omp/agent/router.config.json` (deep-merged over the built-in defaults):

```json
{
  "enabled": true,
  "tiers": {
    "planInteractive": { "model": "@plan", "thinking": "max" },
    "planHeadless": { "model": "@slow", "thinking": "high" },
    "heavy": { "model": "@slow", "thinking": "high" },
    "default": { "model": "@default", "thinking": "inherit" },
    "trivial": { "model": "@tiny", "thinking": "low" }
  },
  "planFallback": { "model": "@slow", "thinking": "high" }
}
```

`model` accepts a configured role alias (`@plan`, `@slow`, …) or an explicit `provider/model-id`. `thinking` accepts `inherit | off | minimal | low | medium | high | xhigh | max` — `inherit` defers to your harness's own default reasoning-effort policy instead of pinning one.

To disable the extension entirely without removing it:

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:router
```

## Runtime controls

A `/route` slash command is registered:

| Command | Effect |
|---|---|
| `/route` | Show current routing state and the last decision |
| `/route why` | Explain the last routing decision |
| `/route off` | Disable auto-routing; model stays as-is |
| `/route on` / `/route auto` | Re-enable auto-routing |
| `/route plan` \| `heavy` \| `default` \| `trivial` | Pin the tier manually until `/route auto` |

## How it works internally

The router hooks the `before_agent_start` extension event, which fires after a prompt is submitted but before the agent loop starts, and calls the extension API's `setModel()` / `setThinkingLevel()`. This applies to the **current** turn (not the next one), and stays stable across multi-step tool-using turns — verified against a live omp session before release. See [`src/router.ts`](./src/router.ts) for the full implementation; it's a single self-contained file, deliberately kept small enough to read end to end.

## License

MIT — see [LICENSE](./LICENSE).
