---
name: slot
description: "A queue for heavy runs on the machine — project checks (`lint`, `typecheck`, `test`, `test:*`) go through `slot`, and installing the flow wraps the `package.json` scripts in it; two runs at a time, together half of the cores, the rest wait in arrival order and print whom they wait for; the command gets `AI_DEV_SLOT_CPUS` (a quarter of the cores) for the runner's workers. When — you run a full project check, tests, typecheck, lint, e2e; a run is silent with the line 'slot: waiting for the machine queue'; parallel sessions choke the machine and runs hit timeouts; you set up runner workers (Vitest, Playwright, Jest) locally; a heavy command bypasses the project's scripts — even if the word 'queue' was never said."
allowed-tools: Bash(bun *skills/slot/scripts/slot.ts *)
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
bun --no-env-file <skill dir>/scripts/slot.ts '<command>' [arguments…]
```

The command runs through `sh`, the arguments are appended to its end, as with
`npm run`; the exit code is the command's. No queue in CI (`CI`) and inside a
slot (`AI_DEV_SLOT`): a script that calls another queued script would
otherwise wait for itself. A `package.json` script doesn't pass its command to
`slot.ts` — it sources `scripts/slot.sh` (below).

## How it is enabled

Installing the flow (`install`, `update`) wraps the project's `package.json`
scripts `lint`, `typecheck`, `test` and `test:*` in `slot`:
`"test": ". .agents/skills/slot/scripts/slot.sh && vitest run"`. The script's
shell sources `slot.sh`: `slot.ts --for <shell PID>` takes a slot for that
shell — held until it exits — and the shell exports `AI_DEV_SLOT` and
`AI_DEV_SLOT_CPUS` to the command. The command stays a plain command of the
script: knip sees its binary as a used dependency, and `bun test` gives knip
the test files and the `preload` of `bunfig.toml` as entries; passed to
`slot.ts` as a string, it was hidden, and the project's dead code went red from
the flow install. Yarn 2+ runs scripts in its own shell, without `.`: there
the command stays a string of `slot.ts`
(`"test": "bun --no-env-file .agents/skills/slot/scripts/slot.ts 'vitest run'"`),
hidden from knip. Everyone calls the scripts — the agent, a human in a
terminal, `github pr premerge` — and everyone joins one queue. `build` isn't
wrapped — the host and Docker run it, where a copy of the skill may be missing;
watch isn't either: it's long and would hold a slot for a long time. Removed
the wrapper by hand, or it's a previous install's (the command a string of
`slot.ts`) — `check` names the script, `update` puts the wrapper back.

## The project's env files are off

Bun loads the env files of the working directory — `.env`,
`.env.<NODE_ENV>`, `.env.local` — into its process by itself, and `slot.ts`
passes its environment to the command. `.env.local` often holds production
keys (`vercel env pull`): without `--no-env-file` they reach a runner that
never saw them before the wrapper — tests of "the key isn't set" go red
locally and green in CI, a test calling an external service goes there with a
production key. With the flag the command gets exactly the environment it
would get without the wrapper: `npm run` and `bun run` don't load env files
for a `package.json` script, and a runner that loads them itself (`bun test`
— `.env.test`) still does. A script's command doesn't go through `slot.ts`
at all — it gets the script's environment and the two queue variables;
`slot.sh` calls `slot.ts` with the flag too. Not `env = false` in the
project's `bunfig.toml`:
it would turn env files off for every `bun` of a Bun project, its own
`bun test` and `bun run dev` included. The same flag is on every call of a
skill script (`tests/standards/no-env-file` in ai-dev): a child `bun` inherits
what its parent loaded.

## What the agent does

| Moment | Action |
|---|---|
| Check before a commit, a full run, e2e | via the project's scripts (`npm run test -- --changed=origin/main`, `bun run typecheck`): they are already queued; which tests before a commit — `docs/testing.md`. As a background command with a generous timeout (Claude Code — `run_in_background`, up to 2 h): waiting in the queue doesn't eat the tool timeout, completion wakes the session |
| `slot: waiting for the machine queue — running …` | not a hang: who holds the slots (directory, command) and how long they have been running. Don't kill someone else's run or delete its ticket |
| `slot: waited …` | the time in the queue; compare run speed without it — by CI or by `user` from `time` |
| A targeted run (`vitest run <file>`) | bypasses the queue — it's cheap |
| A heavy command bypassing the project's scripts | `bun --no-env-file <skill dir>/scripts/slot.ts '<command>'` |
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

An agent's sandbox doesn't let the configuration be written: there the ticket
goes to `ai-dev/slots` of the temp directory (`$TMPDIR`; Claude Code's sandbox
gives all sessions of the user one), and the queue is read from all places at
once, Claude Code's temp directory (`$CLAUDE_TMPDIR`) included — runs inside
and outside the sandbox wait for each other; a human's terminal doesn't see
the sandbox's runs. The checks run in the sandbox, without disabling it. No
place takes the ticket — one line `slot: running without the queue — …` and
the command runs anyway.
