# pi-behavior-monitors

Behavior monitors for [pi](https://github.com/badlogic/pi-mono) that watch agent activity, classify against pattern libraries, steer corrections, and write structured findings to JSON files.

Monitors are JSON files (`.monitor.json`) with typed blocks: classify (LLM side-channel), patterns (JSON library), actions (steer + write to JSON), and scope (main/subagent/workflow targeting).

## Install

```bash
pi install npm:@davidorex/pi-behavior-monitors
```

Or install all three extensions at once: `pi install npm:@davidorex/pi-project-workflows`

Five example monitors ship bundled with the package and load by default from a
three-tier search (project `.pi/monitors/` > global `~/.pi/agent/monitors/` >
bundled `examples/`); first match by name wins. To customize one, create
`.pi/monitors/<name>.monitor.json` in your project — the override fully replaces
the bundled version by name. Delete the override to revert and pick up bundled
updates automatically.

## Bundled Example Monitors

- **fragility** — detects when the agent leaves broken state behind (errors it noticed but didn't fix, TODO comments instead of solutions, empty catch blocks). Writes findings to `.project/issues.json`.
- **hedge** — detects when the agent deviates from what the user actually said (rephrasing questions, assuming intent, deflecting with counter-questions)
- **work-quality** — on-demand audit of work quality (trial-and-error, not reading before editing, fixing symptoms instead of root causes). Invoked via `/work-quality`. Writes findings to `.project/issues.json`.

## Heuristic monitors (regex + counts, no LLM dispatch)

Installed unconditionally alongside the classifier-monitor framework. Both fire at `agent_end` and run in observe-mode by default; both respect `/monitors off` and dedicated env-var overrides.

- **null-output** — qwen3-thinking-mode + vLLM stop-gap. Detects substantive thinking (≥200 chars) followed by a null-shaped visible (pure whitespace, empty `<think></think>` artifact, bare ``` opener) with zero tool calls and `stopReason == "stop"`. Default steers a re-prod prompt. Env toggle: `PI_NULL_OUTPUT_MONITOR=off`. Historical rate ~0.08% (4 / 4923 qwen turns). Source: `heuristic-null-output.ts`.
- **announce-without-act** — Sibling to null-output, distinct domain. Detects substantive thinking (≥200 chars) followed by a SUBSTANTIVE announce-intent visible (50 ≤ length ≤ 500 chars, e.g. "I'll investigate ...", "Let me check ...") with the announce-intent regex matching within the first 100 chars of the left-trimmed visible, zero tool calls, and `stopReason == "stop"`. Currently **observe-mode** (logs to `pi.appendEntry`, no steer dispatch); promotion to steer deferred until 2+ accurate fires accumulate in the wild without FPs. Env toggle: `PI_ANNOUNCE_WITHOUT_ACT_MONITOR=off`. Historical recurrence ~0.33% (17 / 5097 turns) across 510 sessions. Source: `heuristic-announce-without-act.ts`.

The two heuristic monitors partition cleanly by visible length: visible < 50 chars is null-output's domain; 50 ≤ visible ≤ 500 chars is announce-without-act's domain; visible > 500 chars is treated as a substantive answer and neither fires. iter-30 (canonical announce shape, visible 178 chars) fires on announce-without-act only; phase5-t2-2 (boundary, visible 21 chars `<think></think>` artifact) fires on null-output only.

## File Structure

Each monitor is a triad of JSON files:

```
.pi/monitors/
├── fragility.monitor.json       # Definition (classify + patterns + actions + scope)
├── fragility.patterns.json      # Known patterns (grows automatically)
└── fragility.instructions.json  # User corrections (optional)
```

## Writing Your Own

Create a `.monitor.json` file in `.pi/monitors/` conforming to `schemas/monitor.schema.json`. Ask the LLM to read the `pi-behavior-monitors` skill for the full schema and examples.

## Commands

| Command | Description |
|---------|-------------|
| `/monitors` | List all monitors, scope, and state |
| `/<name>` | Show monitor patterns and instructions |
| `/<name> <text>` | Add an instruction to calibrate the monitor |

## How It Works

1. A monitor fires on a configured event (e.g., after each assistant message)
2. It checks scope (main context, subagent, workflow) and activation conditions
3. It collects relevant conversation context (tool results, assistant text, etc.)
4. A side-channel LLM call classifies the context against the JSON pattern library
5. Based on the verdict, the monitor executes actions:
   - **steer**: inject a correction message into the conversation and force a new correction turn (main scope only)
   - **advisory**: persist an operator-visible advisory message in the session but DO NOT force a correction turn (main scope only; for structural defects like tool-budget overruns that cannot be retroactively corrected)
   - **write**: append structured findings to a JSON file (any scope)
   - **learn**: add new patterns to the library automatically
6. Downstream workflows can consume the JSON findings (e.g., issues.json → verify step → gate)

## Schemas

- `schemas/monitor.schema.json` — monitor definition format
- `schemas/monitor-pattern.schema.json` — pattern library entry format

## Development

Part of the [`pi-project-workflows`](../../README.md) monorepo. All workspace packages (pi-project, pi-jit-agents, pi-workflows, pi-behavior-monitors, pi-project-workflows meta) are versioned in lockstep — query `git describe --tags` for the current value.

`npm run build` compiles TypeScript to `dist/` via `tsc`. The package ships `dist/`, not `src/`. Tests use `vitest run` (`npm test`).
