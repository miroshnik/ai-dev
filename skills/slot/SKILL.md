---
name: slot
description: "A queue for heavy runs on the machine — project checks (`lint`, `typecheck`, `test`, `test:*`) go through `slot`, and installing the flow wraps the `package.json` scripts in it; two runs at a time, together half of the cores, the rest wait in arrival order and print whom they wait for; the command gets `AI_DEV_SLOT_CPUS` (a quarter of the cores) for the runner's workers. When — you run a full project check, tests, typecheck, lint, e2e; a run is silent with the line «slot: жду очередь машины» (waiting for the machine queue); parallel sessions choke the machine and runs hit timeouts; you set up runner workers (Vitest, Playwright, Jest) locally; a heavy command bypasses the project's scripts — even if the word 'queue' was never said."
allowed-tools: Bash(bun *skills/slot/scripts/slot.ts *) Bash(node *skills/slot/scripts/slot.ts *)
---

# slot — the machine's heavy runs in a queue

Parallel sessions run the full check all at once, and each runner is sized for
the whole machine: a run that takes seconds alone drags on for minutes next to
a dozen neighbors and gets cut off by the tool timeout, and a retry adds load.
The `scripts/slot.ts` script next to this file lets two heavy runs go at a
time, the rest wait in arrival order; together the slots take half of the
cores, the other half is for the human, the app and the agents themselves. Why
it is so and what was rejected — `tests/capabilities/slot/slot.md` in ai-dev.

```bash
bun <skill dir>/scripts/slot.ts '<command>' [arguments…]
```

The command runs through `sh`, the arguments are appended to its end, as with
`npm run`; the exit code is the command's. No queue in CI (`CI`) and inside a
slot (`AI_DEV_SLOT`): a script that calls another queued script would
otherwise wait for itself.

## How it is enabled

Installing the flow (`install`, `update`) wraps the project's `package.json`
scripts `lint`, `typecheck`, `test` and `test:*` in `slot`:
`"test": "node .agents/skills/slot/scripts/slot.ts 'vitest run'"` (`bun` for a
project on Bun). Everyone calls them — the agent, a human in a terminal,
`github pr premerge` — and everyone joins one queue. `build` isn't wrapped —
the host and Docker run it, where a copy of the skill may be missing; watch
isn't either: it's long and would hold a slot for a long time. Removed the
wrapper by hand — `check` names the script, `update` puts it back.

## What the agent does

| Moment | Action |
|---|---|
| Full check before a commit, e2e | via the project's scripts (`npm run test`, `bun run typecheck`): they are already queued. As a background command with a generous timeout (Claude Code — `run_in_background`, up to 2 h): waiting in the queue doesn't eat the tool timeout, completion wakes the session |
| `slot: жду очередь машины — идут …` (waiting for the machine queue — running …) | not a hang: who holds the slots (directory, command) and how long they have been running. Don't kill someone else's run or delete its ticket |
| `slot: дождался за …` (waited for …) | the time in the queue; compare run speed without it — by CI or by `user` from `time` |
| A targeted run (`vitest run <file>`) | bypasses the queue — it's cheap |
| A heavy command bypassing the project's scripts | `bun <skill dir>/scripts/slot.ts '<command>'` |
| Runner workers locally | from `AI_DEV_SLOT_CPUS` — below |

## Runner workers

In a slot the command gets `AI_DEV_SLOT_CPUS` — a quarter of the cores. A
runner that counts workers from all cores takes the whole machine even in a
slot; its config reads the variable, and in CI and outside the queue it keeps
its own default:

```ts
// vitest.config.ts
maxWorkers: Number(process.env.AI_DEV_SLOT_CPUS) || undefined,
// playwright.config.ts
workers: Number(process.env.AI_DEV_SLOT_CPUS) || (process.env.CI ? 2 : undefined),
// jest — via a script flag: jest --maxWorkers=${AI_DEV_SLOT_CPUS:-50%}
```

**A monorepo on turbo.** turbo 2 in strict env mode (the default) passes to
tasks only the variables named in `turbo.json`: without pass-through the
runner config doesn't see `AI_DEV_SLOT_CPUS` and takes the whole machine, and
a nested script in `slot` without `AI_DEV_SLOT` waits for its own slot. In the
root of `turbo.json`:

```json
"globalPassThroughEnv": ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"]
```

Not `env` and not `globalEnv`: they go into the cache hash, while
`AI_DEV_SLOT` is different for every run and the share of cores depends on the
machine. A script in `slot` calls turbo without pass-through — `install` and
`check` warn with a ready-made line.

## Queue

A run's ticket is a file `<time>-<pid>` in `slots/` of the personal
configuration directory (`$AI_DEV_CONFIG_DIR`, otherwise `~/.config/ai-dev`);
it holds the directory, the command and the start time. Who is in the queue —
`ls` of that directory. A process died, even one killed without cleanup — its
ticket doesn't count and is removed by the first one to see it: there is
nothing to clean up by hand.
