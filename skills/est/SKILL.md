---
name: est
description: Estimates GitHub tasks from the project's history (the «Оценка, ч» field from analogs with actuals) and records the actual from Claude Code, Codex and claude.ai/code cloud session transcripts when a task is closed. When — always when «Оценка, ч» is set on a new task or an epic's subtask; when a task is closed or a PR is merged (actual); in a cloud session when closing a task — its part of the actual («Факт (облако)»); when the cloud part wasn't counted (a Claude-Session trailer in commits, «не импортирована» (not imported) in the actual) — importing the session's events; when asked "how many hours", "estimate it", "how accurate are the estimates", for estimate history, an estimate backtest, the k coefficient, an actuals backfill or estimate vs actual; when comparing the flow before and after a change or spend over a period across all of a repo's sessions (`est period`) — even if the word "estimate" wasn't said but the talk is about planning the amount of work.
allowed-tools: Bash(bun *skills/est/scripts/est.ts *) Bash(gh issue view *) Bash(gh pr view *)
---

# est — estimate from history, actual from transcripts

An estimate "off the top of the head" can't be checked. Here the estimate is
derived from the actuals of already closed tasks, and the actual is measured from
the agent's transcripts (Claude Code, Codex), not reported from memory. The script
`scripts/est.ts` does everything deterministic (transcripts, GraphQL, project
fields, comments, picking analogs); the agent's part is the correction for a named
difference and explaining discrepancies.

**Unit:** «Оценка, ч» (estimate, h) = «Факт, ч» (actual, h) = the agent's active
hours on the task (agent work + pauses ≤ 30 min between records). Not
person-hours, not calendar time. Manual work outside the agent (> 0.5 h) the human
adds themselves as a line «+ вручную: N ч» ("+ manually: N h") in the actual
comment. Old estimates without the `<!-- est -->` marker (set before `est` was
introduced, in other units) don't go into calibration (k).

**The source of the actual is the agent's transcripts** (Claude Code, Codex,
claude.ai/code cloud sessions — section "Cloud session"), not memory and not a
number by eye. A task done by an agent whose transcripts `est` doesn't read has
its actual "unavailable" until its source is added.

**Project fields are set only by the skill:** «Оценка, ч» — `est estimate --write`
(from analogs with actuals, not off the top of the head); «Факт, ч», «Токены, млн»
(tokens, M), «Стоимость, $» (cost, $) — `est fact --write` when the task is
closed; never touch them by hand.

Run: `bun <skill folder>/scripts/est.ts <subcommand> …` (Bun, no dependencies) —
the skill folder is the one holding this file (`~/.claude/skills/est`,
`~/.agents/skills/est`, the project's `.agents/skills/est` or an ai-dev clone; in
Claude Code — `${CLAUDE_SKILL_DIR}`); below abbreviated to `est`. `--repo
owner/repo` can be omitted when you work in the repository's folder. The
repository registry (which ones exist, where they live locally, the project
number) is a personal file `~/.config/ai-dev/repos.json` (or
`$AI_DEV_CONFIG_DIR/repos.json`; the old `~/.claude/est` moves by itself), not
part of the skill; the format is described at the top of `est.ts`. Without a
registry entry the script determines the repo from `git remote origin`, and the
project from its link to the repository.

## What to run when

| Moment | Action |
|---|---|
| You create a small task or an epic's subtask | `est estimate <N> --type <type> --write` — section "Estimating a new task" below |
| PR merged / issue closed | `github task close <N>` — runs `est fact <N> --write` inside; recomputing the actual — `est fact <N> --write` |
| `est history` prints «закрытых за 90 дней без факта: N» (closed in 90 days without an actual) | `est fact --sweep --since 90d --write` — fill in the actuals of closed tasks |
| A model's rate in the price list was fixed or added | `est fact --sweep --model <id> --write` — recompute the recorded actuals with it and their epics |
| Asked about accuracy / history | `est history [--grep word]`, `est backtest`; the trend over time — as a chart, the `dashboard` skill |
| Compare the flow before and after a change, spend over a period without tasks | `est period --since <before> --until <change> --since <change>` — section "Period summary" |

An epic isn't estimated separately: its estimate and actual are the sum of its
subtasks (`est fact <epic>` sums them itself and says how many subtasks have no
actual).

## Estimating a new task

An estimate is a **forecast from the actuals of similar tasks**, in one call: the
script picks the analogs itself and computes hours, tokens and cost from their
actuals.

```bash
est estimate <N> --repo <r> --type feat --write
```

`--type` — like the branch prefix (feat / fix / docs / refactor / perf / test /
chore / ci / build / research). Without `--write` everything is only printed.

1. **Analogs** — the three most similar closed tasks with an actual (coverage
   `full`, not epics), **closed before the estimated one was created**.
   Similarity is a sum of features: a shared decision label ×3, the same type ×2,
   a shared title word ×1 (words are compared by their first four letters), minus
   3 × |ln| of the ratio of the issue description sizes (characters, without
   answers to questions — those are added after the estimate); on a tie — the
   more recently closed. The comment names the analogs and how they are similar:
   `Аналоги (подбор скриптом): #24 (факт 0.21 ч: метка est · тип feat · слова «оценка», «аналоги» · описание ×1.3); …`
   ("Analogs (picked by the script): #24 (actual 0.21 h: label est · type feat ·
   words "estimate", "analogs" · description ×1.3); …")
2. **Correction** — only for a named difference that the features don't see:
   ×0.5 / ×1 / ×1.5 / ×2 (`--mult`, the reason — `--note`, one sentence). No
   difference — ×1: in the backtest, agents' corrections on top of the mechanics
   didn't add accuracy. A downward correction against analogs from another repo
   isn't written without `--note` (`--write` refuses, without it — a warning):
   "someone else's project is slower" without a named difference underestimated
   big tasks threefold. If the fan-out differs from the analogs — also
   `--tok-mult` (×0.5 / ×1 / ×1.5 / ×2 / ×3, the reason — `--tok-note`): with
   parallel subagents hours shrink while tokens grow (each one re-reads the
   context), so tokens and cost get their own correction; without it — the same
   as for hours.
3. The script takes the median of the analogs' actuals × the correction and
   rounds it to the **nearest** step of the scale 0.1 · 0.25 · 0.5 · 1 · 1.5 · 2 ·
   3 · 5 · 8 · 13 h; the correction applies to the token and cost medians too. It
   sets the «Оценка, ч» field and writes a comment (the marker has `"auto": true`):
   `Оценка: 1 ч, ≈ 80.7 млн токенов, ≈ $136 (тип fix, доверие A; прогноз по фактам аналогов). Аналоги (подбор скриптом): #4 (факт 0.38 ч: …); #5 (факт 0.51 ч: …); #9 (факт 1.2 ч: …). Поправка: ×2 (вдвое больше правил). k=0.93 (n=20, уровень «репо»; справочно, к прогнозу не применяется).`
   ("Estimate: 1 h, ≈ 80.7M tokens, ≈ $136 (type fix, confidence A; forecast from
   the analogs' actuals). Analogs (picked by the script): … Correction: ×2 (twice
   as many rules). k=0.93 (n=20, level "repo"; for reference, not applied to the
   forecast).")
   If the analogs' actuals spread by more than ×3, the script adds a range; the
   field gets the median × correction rounded to the scale. The scale is capped
   at 13: if the analogs (before rounding) or `--hours` give more, the script
   warns — the task should be split.
4. k (actual/estimate over history) is for reference: it isn't applied to the
   analog forecast (the forecast already comes from actuals); `est history` shows
   it with the number of pairs, to see whether estimates match actuals.

**Analogs by hand** — `--analogs 254,260`, when the agent sees a difference the
features don't catch (a subsystem without a label, a different scope with a
similar description); then — 2–3 analogs from `est history --repo <r> [--grep
<word>]` («аг.» — the task's subagents, «ходы» — model responses (turns), a size
signal), and when in doubt about scope —
`gh issue view <k> --json body,closedByPullRequestsReferences` and
`gh pr view <pr> --json additions,deletions,changedFiles`. Only actuals with
`full` coverage go into analogs (partial is marked «не учтён», "not counted"), at
least two are needed. If parallel subagents will do the task (fan-out) — analogs
with a similar «аг.» count.

**Backtest** — `est backtest [--repo <r>] [--all-repos]`: every closed task with
an actual is estimated by the mechanics the way the script would have estimated
it on its creation day (analogs — only those closed earlier), and it prints the
share within the ×0.5…×2 tolerance and k for the mechanics, for manual estimates
and for the mechanics with the agent's correction — on one sample (tasks that also
have a manual estimate). It is how a change to the picking rule is checked: the
weights above were chosen with it (#279) — on a history of ~470 tasks the
mechanics lands within tolerance as often as manual picking.

Confidence: A — ≥ 3 analogs with an actual and ≥ 5 closed tasks of the same type
with an actual (coverage full) in this repo; B — ≥ 2 analogs with an actual; C — an
expert estimate (`--hours`, with or without analogs).

**Cold start — honestly.** If the repo has < 2 actuals closed before the task was
created, the script won't pick analogs and says so → analogs from other repos by
hand (`--analogs owner/repo#254`, the list — `est history --all-repos`; in the
comment they are labeled «из проекта …», "from project …", confidence B). An
analog from a non-public repo isn't written into a public repo: `--write` refuses
before writing (without it — a warning), since the other task's name and number
would stay in the comment's edit history too; take analogs from this repo or use
`--hours`. No analogs with an actual anywhere → `--hours H` as an expert estimate
(confidence C), and the comment says so; no "starting rates per operation" — that
is made-up precision. `--hours` together with analogs is an expert estimate on top
of the forecast (confidence C): the comment shows what the analogs would give,
tokens and cost are recomputed in proportion to the hours. `--hours` is rounded to
the scale, and the script warns about it.

**Don't rewrite the estimate after work starts.** A discrepancy is explained in
the actual comment: the actual there is compared with the «Оценка, ч» field, and k
in history — with the hours from the `<!-- est -->` marker.

## Actual at closing

After the PR is merged and deployed (or the issue is closed without a PR) —
`github task close <N>` (the `github` skill: actual, status, epic, milestone,
branch in one call); the actual in it is computed by:

```bash
est fact <N> --repo <r> --write
```

The script finds the task's sessions. First — by pinning: the session in which
`github task status` set the task to In progress (the file
`~/.config/ai-dev/sessions/<session id>` with the line `owner/repo#N`), all of it
— with its subagents (they have the same id) and the time before In progress; the
transcript is looked up by id in any folder of `~/.claude/projects`. A session
pinned to another task doesn't go to this one, whatever features it has. Sessions
without pinning (before it, cloud, Codex, an epic's session, the file deleted) —
by features: the PR's commit hashes in tool outputs, `pr-link` records of its
repository, a branch with the task number, `#N` in the session's name and first
prompt or in a subagent's assignment. Then it computes active hours — including
the work of subagents and workflows inside the session — and writes a comment:

`Факт: 3,1 ч активных в Claude Code (оценка 3 ч, ×1,03). 2 сессии, 14 промптов, 4 субагента, стена 10,2 ч, покрытие full. PR #336; 8 коммитов, дифф 2140 строк.`

("Actual: 3.1 active hours in Claude Code (estimate 3 h, ×1.03). 2 sessions, 14
prompts, 4 subagents, wall clock 10.2 h, coverage full. PR #336; 8 commits, diff
2140 lines.")

("N subagents" — how many subagents worked on the task; a fan-out signal for
picking analogs, `agents` in the marker)

and on a second line — the model spend:

`Токены: 150,9 млн (вход 0,01 · выход 0,18 · запись кэша 6,4 · чтение кэша 144,3); стоимость по API-тарифам ≈ $134,61 (claude-opus-5 $83,95, claude-fable-5-1 $50,67).`

("Tokens: 150.9M (input 0.01 · output 0.18 · cache write 6.4 · cache read 144.3);
cost at API rates ≈ $134.61 (…)")

and on a third — turns and context (absent if there are no linked model
responses):

`Ходы: 250 (субагентов 2, их ходов 120), преамбула 104 тыс., контекст в конце 581 тыс., ходов с контекстом > 400 тыс. — 31 %.`

("Turns: 250 (subagents 2, their turns 120), preamble 104k, context at the end
581k, turns with context > 400k — 31 %.")

A turn is one model response (by `message.id`); a task's price grows
quadratically with their number: every turn re-reads the whole context. The
preamble is the context of the first top-level turn of the earliest session
(rules and tools), the context at the end — of the last turn of the latest one;
the tail is the share of turns with context over 400k (they were 20 % of turns
and 45 % of tokens). Turns of a shared PR aren't split into shares — each task
gets the whole turn. In the marker — `steps`, `steps_agents`, `tail` (a number),
`preamble`, `ctx_end`.

plus the fields «Факт, ч», «Токены, млн», «Стоимость, $» (the last two — if the
project has them). Tokens are taken from `message.usage` of the same linked
records as the time (including subagents), once per `message.id` — in a
transcript, usage repeats on every block of a response, and a resumed session
copies the history. Cost is the **API equivalent** at public rates (the `PRICES`
table at the top of `est.ts`, the date is there too; cache write = input ×1.25 for
a 5-min TTL and ×2 for 1 h; fast mode — at its own rate). On a subscription this
money isn't charged — it is a measure for comparing tasks and models. The price
key is the model id without the date: a date in the id (`-20251001`, on Vertex AI
`@20251101`) doesn't change the rate, while a different continuation of the name
is a different version (`claude-opus-5-5` with the key `claude-opus-5`), and the
previous version's rate doesn't carry over to it. A new model or your own prices
— in the personal `~/.config/ai-dev/prices.json`: `{"<model id>": [input,
output, cache_read]}`; a model outside the price list gives tokens without a
price, and the comment marks that. Actuals recorded before a rate was fixed are
recomputed by `est fact --sweep --model <id> --write`: closed tasks in the
`--since` window whose spend (the actual marker, `models`) includes this model
version, then their closed epics — an epic adds up the already fixed actuals of
its subtasks. The bulk of tokens is always cache reads — look at the cost and the
output, not the total volume.

A session from the folder of another registry repository (the conversation there
grew into a task of this one: the task was created, the session renamed, the
commit and PR are here) is a guest: a candidate only if its transcript contains
the task repository's name, and linked only by this repository's features (the
task's PR and commits, the exact branch of its PR, the issue URL); the number in
the name and in the first prompt counts only together with them, that
repository's branches don't count. Records before the rename stay with that
repository's task, and the "#N …" period with this repository's PR doesn't go to
it. An app session without a chosen folder (a temp folder
`…/Claude/scratch-workspaces/…`) is a guest candidate for any registry
repository: having moved into a repository, it writes its transcript into the
temp folder's directory until the app moves it into the repository's directory.
If it moved into the task repository's folder, it is the repository's own
session, linked like a session from that folder.

Coverage: `full` — all of the task's PRs are visible in transcripts; `partial` —
part of the work went past Claude Code (a second developer, another tool); `none`
— no sessions, the field isn't set, the comment says «факт недоступен» ("actual
unavailable"). Only `full` goes into k and analogs. Don't add a number by eye if
the script found no actual — "no data" is worth more than a made-up number.

If actual/estimate is outside ×0.5…×2 and the estimate is ≥ 2 h — add to the same
comment the line
`Причина: <пропущена работа | вырос объём | внешний блокер | неверный аналог | иное>: <1–2 sentences>`
("Reason: missed work | scope grew | external blocker | wrong analog | other"; the
script keeps this line on a rerun).

Tasks we "won't do" and duplicates get no actual (they are no longer in the
project).

### Cloud session

A Claude Code cloud session (claude.ai/code) counts its own part: when a task is
closed, `est fact <N>` in the cloud takes this session's transcript in the
container (linking — the branch `<type>/<N>-…` or "#N" in the first prompt; PRs
and commits aren't visible from there) and prints the comment «Факт (облако): …»
("Actual (cloud)") with hours, tokens and a link to the session, with a part
marker (`cloud`) — the agent writes it into the issue with a GitHub tool. Project
fields can't be set from the cloud: they are set by the nearest local `est fact
<N> --write` or `--sweep` (closed tasks without the «Факт, ч» field), which adds
the cloud part to the local work without double counting; the part is kept in the
marker on rewrites too.

Cloud session commits carry the trailer `Claude-Session:
https://claude.ai/code/session_…`: a PR with such a commit, for whose session
there is neither a part nor an imported export, gets coverage `partial` and the
line «Облачная сессия … не импортирована — est cloud-import» ("Cloud session …
not imported") in the actual. This happens with old tasks and when the cloud
couldn't link the transcript to the task — then a local session imports the
events; an export of the same session takes precedence over the part.

The import is done by a local session through a browser where the user is signed
in to claude.ai (Claude in Chrome): in a claude.ai tab, run the snippet below — it
takes the session's metadata and all its events and saves `<session>.json` to
downloads (the download — with the user's permission: file name, source, size);
then

```bash
est cloud-import ~/Downloads/session_….json   # → ~/.config/ai-dev/cloud/<owner>/<repo>/
est fact <N> --write
```

```js
// in a claude.ai tab; save=false — summary only, no download
async function cloudExport(session, save) {
  const h = { "anthropic-version": "2023-06-01" };
  const get = async (u) => { const r = await fetch(u, { headers: h }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
  const meta = await get(`/v1/code/sessions/${session}`);
  const m = meta.response_shape ?? meta;
  const events = [];
  for (let cur = null, i = 0; i < 1000; i++) {
    const j = await get(`/v1/code/sessions/${session}/events` + (cur ? `?cursor=${encodeURIComponent(cur)}` : ""));
    events.push(...j.data);
    if (!j.next_cursor || !j.data.length) break;
    cur = j.next_cursor;
  }
  const repo = String(m.config?.sources?.[0]?.url ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const out = { v: 1, session, repo, title: m.title ?? "", events };
  const json = JSON.stringify(out);
  if (save) Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: `${session}.json` }).click();
  return { repo, title: out.title, events: events.length, bytes: json.length };
}
await cloudExport("session_…", true)
```

A cloud session is counted by the same rules as a local one: the name "#N …"
links, the branch comes from commit events (before the first commit — neutral),
the human is the client's prompts, tokens — once per response, subagents — by
their own streams. The export is personal (prompts, tool outputs) — only in the
state folder, not in the repository.

## Period summary — the flow before and after

A task's actual sees only the work linked to the task. In a flow without tasks (a
PR without an issue, a worktree branch before the rename, a shared branch of
several PRs) it is understated or split wrongly — you can't compare the flow
before and after a change by it. `est period` takes **all of the repo's sessions
over the period**, without linking:

```bash
est period --since 2026-08-01 --until 2026-09-05 --since 2026-09-05   # before the flow change and after
```

A period is a pair `--since … [--until …]` (the i-th `--until` closes the i-th
`--since`; without it — up to now; a date `YYYY-MM-DD` is midnight local time, or
an ISO time, or `90d`). Sessions come from the repo's folders, including short
ones without commits (the actual discards them as routines), and those pinned to
its tasks; no guests (sessions of another repo). The script prints the totals and
the same per PR merged in the period: agent hours (sum over sessions), machine
hours (union of sessions) and their ratio — parallelism, tokens, output, $, turns,
subagents, human prompts, $ per 1M tokens; for two periods — the «после / до»
("after / before") ratio, and below the table — the $ share by model for each
period.

**$ is flow × model rate.** A model change changes $ per PR several-fold with the
same flow; the flow's effect shows in tokens, output and hours per PR, a rate
shift — in «$ за 1 млн токенов» ("$ per 1M tokens") and the $ share by model
(`est history` prints it too). Work on a PR may have started before the period —
compare periods longer than a typical task.

## So the actual is found — linking work to the task

Without this the coverage will be `partial`/`none`, and no history accumulates:

- the task is taken into work (`github task status <N> "В работе"`, In progress)
  in the session that does it: pinning links the whole session directly; the
  features below are a fallback for sessions without it and for history before it;
- the session is named `#<number> <task title>` — the name is read from the
  transcript and links to the task explicitly (stronger than the first prompt),
  and from the moment of the rename: the first name applies from the start of the
  session, each next one — from its rename. That's how old sessions that ran
  tasks one after another are split: records on a branch without a number go to
  the task under whose name they were made, not to the last one. Now a new task
  is a new session: `github task status` won't take a second one into work;
- one session — one task; a branch by the convention `<type>/<issue>-<slug>`
  (`feat/42-invoice-export`, an area prefix is allowed: `backend/fix/42-…`; the
  old `issue-42-…` is recognized too) — the script takes from it both the task
  number and the type for history;
- the task number (`#263` or a link) — in the session's first prompt **and in the
  assignment of every subagent / workflow agent** that does this task: subagent
  transcripts count as part of the session, and the number in the assignment
  links their work to its task even when several tasks run in parallel (without a
  number, parallel work is split by commit order — roughly). The task is the
  number after the word «Задача» ("Task") or at the very start of the assignment
  (`Задача #263 (эпик #250). …`, `#263 …`); a number after «эпик» ("epic") isn't
  the task; two numbers without these markers (`look at #263 and #261`) give no
  hint;
- `Closes #263` in the PR body;
- commit in logical steps, not one commit per PR;
- in a repo where tasks are closed by commits without a PR — `Closes #N` in the
  commit message;
- work in the session's folder, switching the branch, not in a neighboring
  worktree from the same session: a transcript record's branch is the branch of
  the session's folder, and work on a "foreign" branch doesn't get into the
  actual (coverage `none`);
- don't silence the output of `git commit`, `git push`, `git worktree add`,
  `gh pr create` with `-q`: a session is linked by the branch name and commit
  hashes in tool **outputs**; before `est fact` it helps to print
  `gh pr view <N> --json headRefName,mergeCommit,commits` in a separate call.
  A hash in a listing's output (`git worktree list`, `git branch`, `git log`,
  `git fetch`, reading via `gh` other than `gh pr view`; a command made only of
  these and utilities like `head`, `grep`, including inside a `for` or `while`
  loop and an `if` condition) links only if that commit is also in the session's
  own output: `git log` of a neighboring worktree doesn't hand the session's time
  to someone else's task.

## Command reference

```bash
est history [--repo o/r] [--grep WORD] [--all-repos] [--last N]
est fact <N> [--repo o/r] [--write] [--gap 30] [--json]
est fact --sweep [--since 90d] [--repo o/r] [--write]
est fact --sweep --model <id> [--since 90d] [--repo o/r] [--write]   # recompute recorded actuals with the model and their epics
est estimate <N> [--repo o/r] --type <type> \
    [--mult 0.5|1|1.5|2] [--note "reason"] \
    [--tok-mult 0.5|1|1.5|2|3 [--tok-note "reason"]] [--write]   # the script picks analogs; hours, tokens, $ from their actuals
est estimate <N> [--repo o/r] --type <type> --analogs a,b[,c] [--mult …] [--write]   # analogs by hand
est estimate <N> [--repo o/r] --type <type> --hours H [--write]   # expert, when there are no analogs
est backtest [--repo o/r] [--all-repos]   # mechanics vs manual estimates on closed tasks
est period --since DATE [--until DATE] [--since DATE [--until DATE]] [--repo o/r] [--gap 30]   # all of the repo's sessions over the period
# an analog from another registry repo: --analogs owner/repo#254
# <type> — like the branch prefix: feat fix docs refactor perf test chore ci build research
```

Without `--write` everything is only printed — so you can check what the script
found before writing to GitHub. Comments are idempotent: the markers
`<!-- est {…} -->` and `<!-- fact {…} -->` at the end of a comment; a rerun
updates the existing comment instead of adding new ones. `--sweep --write` writes
only tasks with coverage `full`/`partial` — it doesn't mass-post "unavailable";
for a single task `est fact <N> --write` does write «факт недоступен» ("actual
unavailable") (that is the honest record at closing).

A `gh` network failure (timeout, dropped connection, GitHub 5xx) the script
retries with pauses of 2, 5 and 15 s; a request error (404, permissions,
validation) — it doesn't; it doesn't retry a new comment after a dropped response:
GitHub may have accepted it. `--sweep` on one task's error prints `#N: ошибка …`
("error") and moves on; a network that didn't come back within the retries stops
the sweep. With `--write`, at the end — «не записано: …» ("not written") and the
command to retry, exit code 1.

One record — one task: the `<!-- fact … -->` marker stores intervals per session
(`iv`), and a record linked only by the session name or the first prompt but
already included in a recorded actual of another task of the same session isn't
counted again — the comment says so: «Не засчитано повторно: N ч уже в факте #M»
("Not counted again: N h already in the actual of #M"). If that actual is the
wrong one — `est fact M --write`, then this task again. A record linked by
pinning, a branch, a subagent or its own commit stays its own; the overlap is
printed («Пересечение с фактом #M … — пересчитать #M», "Overlap with the actual
of #M … — recompute #M"). Actuals recorded before `iv` appeared aren't checked.
`--sweep` at the end checks the sum of hours against the union of intervals
within each session: parallel sessions at the same time aren't double counting; a
warning comes only when records of one session went into the actuals of two tasks.

The number is the **issue** number, not a PR's: given a PR number the script
warns and computes the actual for the PR itself. A shared commit/PR that closed
several tasks is split among them equally (the script's output says «без деления:
N ч», "unsplit: N h"; the comment — «общий коммит … (доля 1/k)», "shared commit …
(share 1/k)").

## Pitfalls

- Project fields are looked up by exact name via GraphQL; in the JSON of
  `gh project item-list` the keys of fields with Cyrillic names are mangled —
  don't rely on them.
- Codex sessions (`~/.codex/sessions/**/*.jsonl`, `archived_sessions`) are read
  the same way: prompts — `UserMessage`, commit hashes — from tool outputs,
  tokens — `token_usage_record` (once per response); records have no branch, so
  linking is by the number in the first prompt and by commit hashes. `gpt-*`
  models aren't in the price list — tokens are counted, the cost is marked
  «без цены» ("no price") until it is set in `prices.json`.
- Claude Code transcripts live in `~/.claude/projects/<path-with-dashes>*/` and
  are cleaned up per `cleanupPeriodDays` (`settings.json` must have 365). The
  actual comment and the field are already the archive of the result; transcripts
  are needed only for recomputing.
- Sessions with < 3 prompts and no PR or commits (automatic routines) the script
  skips; if a task's actual is suspiciously small — check whether the work was in
  such a session or on someone else's branch.
- A Claude Code cloud session (`CLAUDE_CODE_REMOTE=true`): GraphQL and GitHub
  Projects are closed there. `est fact <N>` in the cloud prints «Факт (облако)»
  with this session's hours and tokens (or «Факт недоступен (облако)», "actual
  unavailable (cloud)", if the transcript isn't linked to the task) — write it
  into the issue with a GitHub tool; other commands fail with an explanation
  (`docs/cloud-sessions.md` in ai-dev). Project fields are set by a local
  `est fact <N> --write` / `--sweep` (section "Cloud session").
