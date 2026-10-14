---
name: est
description: Estimates GitHub tasks from the project's history (the «Estimate, h» field from analogs with actuals — `github task new` sets it by itself, the agent has no step) and records the actual from Claude Code, Codex and claude.ai/code cloud session transcripts when a task is closed. When — a task created past `task new` (the GitHub UI) has no estimate; when a task is closed or a PR is merged (actual); in a cloud session when closing a task — its part of the actual («Actual (cloud)»); when the cloud part wasn't counted (a Claude-Session trailer in commits, «not imported» in the actual) — importing the session's events; when asked "how many hours", "estimate it", "how accurate are the estimates", for estimate history, an estimate backtest, the k coefficient, a manual re-estimate on the owner's request, an actuals backfill or estimate vs actual; when comparing the flow before and after a change or spend over a period across all of a repo's sessions (`est period`).
allowed-tools: Bash(bun *skills/est/scripts/est.ts *) Bash(gh issue view *) Bash(gh pr view *)
---

# est — estimate from history, actual from transcripts

An estimate "off the top of the head" can't be checked. Here the estimate is
derived from the actuals of already closed tasks, and the actual is measured from
the agent's transcripts (Claude Code, Codex), not reported from memory. The script
`scripts/est.ts` does everything deterministic (transcripts, GraphQL, project
fields, comments, picking analogs); the agent's part is the correction for a named
difference and explaining discrepancies. The mechanics — `reference.md` next to
this file; syntax and flags — `est --help` and `est <command> --help`.

**Unit:** «Estimate, h» = «Actual, h» (in the project language —
`locales/<language>.json` of the `github` skill) = the agent's active
hours on the task (agent work + pauses ≤ 30 min between records). Not
person-hours, not calendar time. Manual work outside the agent (> 0.5 h) the human
adds themselves as a line «+ manually: N h» in the actual
comment. Old estimates and the comments' language — reference.md, "Unit and comment language".

**The source of the actual is the agent's transcripts** (Claude Code, Codex,
claude.ai/code cloud sessions — section "Cloud session"), not memory and not a
number by eye. A task done by an agent whose transcripts `est` doesn't read has
its actual "unavailable" until its source is added.

**Project fields are set only by the scripts:** «Estimate, h» — `est estimate --write`
inside `github task new` (from analogs with actuals, not off the top of the head);
«Actual, h», «Tokens, M», «Cost, $» — `est fact --write` inside `github task close`;
never touch them by hand.

Run: `bun --no-env-file <skill folder>/scripts/est.ts <subcommand> …` (Bun, no
dependencies) — the skill folder is the one holding this file (`~/.claude/skills/est`,
`~/.agents/skills/est`, the project's `.agents/skills/est` or an ai-dev clone; in
Claude Code — `${CLAUDE_SKILL_DIR}`); below abbreviated to `est`. `--repo
owner/repo` can be omitted when you work in the repository's folder (the
registry — reference.md, "Repository registry"). Without `--write` everything is
only printed — check what the script found before writing to GitHub; reruns
update the same comment (reference.md, "Writing and reruns").

## What to run when

| Moment | Action |
|---|---|
| You create a task or an epic's subtask | nothing: `github task new --branch-type <type>` sets the estimate itself — section "The estimate of a new task" below |
| A task without an estimate (created in the GitHub UI or by another tool), before taking it into work | `est estimate <N> --type <type> --write` — the same call `task new` makes, one call, nothing to choose |
| PR merged / issue closed | `github task close <N>` — runs `est fact <N> --write` inside; recomputing the actual — `est fact <N> --write` |
| `est history` prints «closed in 90 days without an actual: N» | `est fact --sweep --since 90d --write` — fill in the actuals of closed tasks |
| A model's rate in the price list was fixed or added | `est fact --sweep --model <id> --write` — recompute the recorded actuals with it and their epics |
| The actual says «Not counted again: N h already in the actual of #M» or «Overlap with the actual of #M … — recompute #M», and #M's actual is the wrong one | `est fact M --write`, then this task again — reference.md, "Double counting and shared commits" |
| `--write` ended with «not written: …» (exit code 1) | the command to retry it prints |
| The actual says «Cloud session … not imported — est cloud-import» | the import — section "Cloud session" |
| Asked about accuracy / history | `est history [--grep word]`, `est backtest`; the trend over time — as a chart, the `dashboard` skill |
| Compare the flow before and after a change, spend over a period without tasks | `est period --since <before> --until <change> --since <change>` — section "Period summary" |

An epic isn't estimated separately: its estimate and actual are the sum of its
subtasks (`est fact <epic>` sums them itself and says how many subtasks have no
actual).

## The estimate of a new task

An estimate is a **forecast from the actuals of similar tasks**, and
`github task new --branch-type <type>` sets it itself: it runs
`est estimate <N> --type <type> --write` — the agent doesn't open this skill and
chooses nothing. A task created past `task new` (the GitHub UI, another tool)
gets the same call by hand before it's taken into work:
`est estimate <N> --type <branch type> --write`. Precision isn't the goal: every closed task becomes an analog
for the next estimates, so they follow the actuals by themselves.

The script picks the three most similar closed tasks with an actual, closed
before the estimated one was created, and sets the median of their actuals,
rounded to the scale 0.1 … 13 h; above 13 it warns — the task should be split.
Fewer than two such analogs — cold start: the script prints «No estimate: …»,
writes nothing and exits with 0; the task stays without an estimate. Similarity,
the comment, confidence and k — reference.md, "Estimate — the mechanics".

**A manual re-estimate — only on the owner's request,** before work starts:
`--analogs` (2–3 by hand, from `est history [--grep <word>]`; another registry
repo — `owner/repo#254`; an analog from a non-public repo isn't written into a
public repo), `--mult` with `--note`, `--tok-mult` with `--tok-note`, `--hours H`
(expert, confidence C) — reference.md, "Manual re-estimate". A change to the
picking rule is checked by `est backtest` (reference.md, "Backtest").

**Don't rewrite the estimate after work starts.** A discrepancy is explained in
the actual comment: the actual there is compared with the «Estimate, h» field, and k
in history — with the hours from the `<!-- est -->` marker.

## Actual at closing

After the PR is merged and deployed (or the issue is closed without a PR) —
`github task close <N>` (the `github` skill: actual, status, epic, milestone,
branch in one call); the actual in it is computed by:

```bash
est fact <N> --repo <r> --write
```

The number is the **issue** number, not a PR's. The script finds the task's
sessions — first by pinning (the session in which `github task status` set the
task to In progress, with its subagents), the rest by features (the PR's
commits, the branch, `#N` in the session's name, first prompt or a subagent's
assignment; reference.md, "Actual — how sessions are found"). It computes active
hours — including subagents and workflows — and writes a comment of three lines:
the actual (sessions, prompts, subagents, wall clock, coverage), the model spend
and turns with context (reference.md, "Actual — the comment"), plus the fields
«Actual, h», «Tokens, M», «Cost, $». Cost is the API equivalent at public rates,
not money charged; a model outside the price list gives tokens without a price
(reference.md, "Tokens and cost").

Coverage: `full` — all of the task's PRs are visible in transcripts; `partial` —
part of the work went past Claude Code (a second developer, another tool); `none`
— no sessions, the field isn't set, the comment says «actual unavailable».
Only `full` goes into k and analogs. Don't add a number by eye if
the script found no actual — "no data" is worth more than a made-up number.

If actual/estimate is outside ×0.5…×2 and the estimate is ≥ 2 h — add to the same
comment the line
`Reason: <missed work | scope grew | external blocker | wrong analog | other>: <1–2 sentences>`
(the script keeps this line on a rerun).

Tasks we "won't do" and duplicates get no actual (they are no longer in the
project).

### Cloud session

A Claude Code cloud session (claude.ai/code, `CLAUDE_CODE_REMOTE=true`) counts
its own part; GraphQL and GitHub Projects are closed there. When a task is
closed, `est fact <N>` in the cloud takes this session's transcript in the
container (linking — the branch `<type>/<N>-…` or "#N" in the first prompt; PRs
and commits aren't visible from there) and prints the comment «Actual (cloud): …»
with hours, tokens and a link to the session, with a part
marker (`cloud`) (or «Actual unavailable (cloud)», if the transcript isn't linked
to the task) — the agent writes it into the issue with a GitHub tool. Other
commands fail with an explanation (`docs/cloud-sessions.md` in ai-dev). Project
fields can't be set from the cloud: they are set by the nearest local `est fact
<N> --write` or `--sweep` (closed tasks without the «Actual, h» field), which adds
the cloud part to the local work without double counting; the part is kept in the
marker on rewrites too.

Cloud session commits carry the trailer `Claude-Session:
https://claude.ai/code/session_…`: a PR with such a commit, for whose session
there is neither a part nor an imported export, gets coverage `partial` and the
line «Cloud session … not imported — est cloud-import» in the actual. Then a
local session imports the events through a browser where the user is signed in
to claude.ai (Claude in Chrome): run the snippet from reference.md, "Cloud session import",
in a claude.ai tab — it saves `<session>.json` to downloads (the download — with
the user's permission: file name, source, size); then

```bash
est cloud-import ~/Downloads/session_….json   # → ~/.config/ai-dev/cloud/<owner>/<repo>/
est fact <N> --write
```

## Period summary — the flow before and after

A task's actual sees only the work linked to the task — you can't compare the
flow before and after a change by it. `est period` takes **all of the repo's
sessions over the period**, without linking:

```bash
est period --since 2026-08-01 --until 2026-09-05 --since 2026-09-05   # before the flow change and after
```

**$ is flow × model rate:** a model change changes $ per PR several-fold with
the same flow; the flow's effect shows in tokens, output and hours per PR.
Periods, columns and how to read them — reference.md, "Period summary".

## So the actual is found — linking work to the task

Without this the coverage will be `partial`/`none`, and no history accumulates
(details — reference.md, "Linking — details"):

- the task is taken into work (`github task status <N> "In progress"`)
  in the session that does it: pinning links the whole session directly; the
  features below are a fallback for sessions without it and for history before it;
- the session is named `#<number> <task title>` — the name links to the task
  explicitly (stronger than the first prompt). A new task is a new session:
  `github task status` won't take a second one into work;
- one session — one task; a branch by the convention `<type>/<issue>-<slug>`
  (`feat/42-invoice-export`) — the script takes from it both the task
  number and the type for history;
- the task number (`#263` or a link) — in the session's first prompt **and in the
  assignment of every subagent / workflow agent** that does this task, after the
  word «Task» or at the very start (`Task #263 (epic #250). …`, `#263 …`);
- `Closes #263` in the PR body; in a repo where tasks are closed by commits
  without a PR — `Closes #N` in the commit message;
- commit in logical steps, not one commit per PR;
- work in the session's folder, switching the branch, not in a neighboring
  worktree from the same session: work on a "foreign" branch doesn't get into the
  actual (coverage `none`);
- don't silence the output of `git commit`, `git push`, `git worktree add`,
  `gh pr create` with `-q`: a session is linked by the branch name and commit
  hashes in tool **outputs**; before `est fact` it helps to print
  `gh pr view <N> --json headRefName,mergeCommit,commits` in a separate call.

## Pitfalls

- Project fields are looked up by exact name via GraphQL; in the JSON of
  `gh project item-list` the keys of fields with Cyrillic names are mangled —
  don't rely on them.
- Claude Code transcripts live in `~/.claude/projects/<path-with-dashes>*/` and
  are cleaned up per `cleanupPeriodDays` (`settings.json` must have 365). The
  actual comment and the field are already the archive of the result; transcripts
  are needed only for recomputing.
- Sessions with < 3 prompts and no PR or commits (automatic routines) the script
  skips; if a task's actual is suspiciously small — check whether the work was in
  such a session or on someone else's branch.
- Codex sessions are read too, with no branch in their records: linking — by the
  number in the first prompt and commit hashes; `gpt-*` models — «no price» until
  set in `prices.json` (reference.md, "Codex sessions").
