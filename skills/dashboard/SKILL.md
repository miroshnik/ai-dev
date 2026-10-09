---
name: dashboard
description: A browser task dashboard served by the script itself, in two tabs. «Сессии» (Sessions, main) — In progress tasks, their Claude Code sessions and what each is waiting for (CI, merge, deploy, human reply, working, silence), the task's PR, and the «Ждут владельца» (Waiting for the owner) block with questions from session answers and from tasks with the «вопросы» (questions) label; refreshes itself. «Оценка и факт» (Estimate and actual) — a chart by task close time (estimate and actual in hours, actual to estimate, tokens and cost) with a rolling median, a summary and a table. Use when asked "what's up with the sessions", "is anything stuck", "which tasks are hanging", "what is the session waiting for", which questions await an answer; asked for a dashboard, a chart or "show it visually", how accurately tasks are estimated, whether they get pricier or cheaper, how a flow change affected hours, tokens and cost — even if the word "dashboard" wasn't said. A single table in the terminal — `est history`.
allowed-tools: Bash(bun *skills/dashboard/scripts/dashboard.ts *)
---

# dashboard — sessions at work, estimate, actual and cost of tasks

With a couple dozen parallel sessions you can't see which one is busy with
what and what it is waiting for, and questions to the owner are scattered
across sessions. And the flow is edited for the sake of two quantities:
estimate accuracy and the cost of a task, while the `est history` table shows
tasks one at a time, without a trend. The `scripts/dashboard.ts` script brings
up a page with two tabs:

- **«Сессии»** (Sessions; `/`, the main one) — In progress tasks, their
  sessions and what each is waiting for, with «Ждут владельца» (Waiting for
  the owner) at the top;
- **«Оценка и факт»** (Estimate and actual; `/est`) — a chart by task close
  date: GitHub project fields and the «Оценка» (estimate) and «Факт» (actual)
  comment markers.

It writes nothing to GitHub.

```bash
bun <skill dir>/scripts/dashboard.ts [--repo o/r | --all-repos] [--since 90d] [--port N] [--no-open]
```

The skill dir is the one this file is in (in Claude Code —
`${CLAUDE_SKILL_DIR}`). The data is read by the `est` script next to it
(`../est/scripts/est.ts`) — the skills are installed together. It needs `gh`
with the `project` scope, as for `est`. A task's session is found by the pin
file written by `github task status <N> "В работе"` (In progress)
(`~/.config/ai-dev/sessions/<session id>` or in `$AI_DEV_CONFIG_DIR`), its
state — by the transcript `~/.claude/projects/<dir>/<id>.jsonl`.

## How to run

The script is a server: it prints the address, opens it in the browser and
lives until stopped. So run it as a **background command**, not a regular
call: a regular one won't return until the timeout.

1. Before showing «Оценка и факт» — `est fact --sweep --since 90d --write`
   (the `est` skill): the chart draws only recorded actuals. «Сессии» doesn't
   need it.
2. Run the script in the background and read its output: the first line is
   `дашборд: http://127.0.0.1:<port>/ — …` (dashboard), the second is
   `браузер: открываю …` (browser: opening) or `браузер: не открываю (…)`
   (browser: not opening).
3. Give the user the address. If the agent has its own browser (the app
   panel) — run with `--no-open` and open the address there; otherwise the
   script opens the system one itself (`BROWSER=<command>` — what to open it
   with, `BROWSER=none` — don't open).
4. The user has looked — stop the background command.

| Parameter | What it does |
|---|---|
| `--repo o/r` | repository; by default — from the directory's `git remote origin` |
| `--all-repos` | all repositories in the personal `est` registry (`~/.config/ai-dev/repos.json`); each task names its repository |
| `--since 90d` | default period of «Оценка и факт» (`d`, `w`, `m`); without it — all time. On the page — «30 дней», «90 дней», «всё время» (30 days, 90 days, all time) |
| `--port N` | port; by default — a free one, a busy one is an error |
| `--no-open` | don't open the browser |

## Sessions tab

- **A row per In progress task** of the project (an epic isn't a row: its
  session plans): the task and its epic; the session — how long ago the last
  transcript (or subagent) record was, its name — if it doesn't repeat the
  task; what it is waiting for — as a colored label; the task's PR
  (`Closes #N` or branch `<type>/<N>-…`) — number, checks, conflict, merged,
  and whether a deploy is running. At the top — those waiting for the owner,
  then silent and red ones.
- **What it is waiting for.** A session's background task (command,
  subagent, Monitor) without a completion notification — the session is
  waiting for it: PR open and checks running — «CI идёт» (CI running), red —
  «CI красный» (CI red), PR merged and the merge commit's checks running —
  «деплой» (deploy), otherwise «работает» (working) with the background task's
  description. The last turn is a model answer without a tool call:
  «ответ человека» (human's reply), and with a green mergeable PR — «мерж»
  (merge); «Всё сделано. Сессию можно закрывать.» (the "all done, can be
  closed" line) or self-archiving — «можно закрывать» (can be closed). No
  records for more than 15 min and nothing in the background — «тишина»
  (silence) (a tool call without a result is named: waiting for permission
  or hung). A background task older than 2 h without a notification is
  considered lost. No pin — «сессии нет» (no session); a PR with the
  `Claude-Session` trailer — «облако, состояние не видно» (cloud, state not
  visible): a cloud session doesn't pin its task.
- **«Ждут владельца».** Questions from the last answers of task sessions
  («ответ человека», «мерж»): from the line «Всё сделано, но есть вопросы…»
  (all done, but there are questions) or «Осталось: …» (remaining) to the end
  of the answer; without them — the last paragraph. Sessions in the
  repository's directories (`paths` of the `est` registry) without an In
  progress task that wrote within the last day — only with an explicit
  question (these lines or a paragraph ending in "?"); routines
  (`<scheduled-task>`) don't count. In progress tasks with the «вопросы»
  (questions) label — as a row, the open items of «## Вопросы» (the questions
  section) under a disclosure; tasks not in work with the label — as a
  collapsed group.
- It refreshes itself every 30 s (and on returning to the tab): what's
  expanded stays expanded. Pins and transcripts are re-read, GitHub — at most
  once a minute and in the background: the page answers from cache, fresh
  data arrives by the next refresh.

## Estimate and actual tab

- **Summary.** Estimate accuracy — k (the median of "actual / estimate" over
  the last 20 tasks with the `est` marker and `full` coverage) and the share
  of tasks within the ×0.5…×2 tolerance, the same numbers as in
  `est history`. Hours, tokens and cost of a task — the median of the last 10
  closed tasks and the change against the previous 10. The
  «Стоимость по моделям» (Cost by model) tile — each model's share of $ for
  the last 10 tasks and for the previous 10: the model changed — the rate
  changed.
- **Chart** — four panels on a shared time axis (close date): hours (ring —
  estimate, dot — actual, the segment between them — the error), actual to
  estimate (the ×1 line — the estimate matched, the band — the ×0.5…×2
  tolerance), tokens, M, and cost, $ (ring — the forecast from the «Оценка»
  comment). The line is a rolling median of the last 10 tasks, the number at
  its end — the current value. The scales are logarithmic: an equal step — an
  equal ratio.
- **Table** — the same values per task, newest on top; hovering over a point
  highlights the row.

Tasks — closed ones with an actual, as in `est history`; an epic isn't
included (its hours are the sum of its subtasks). Estimate — only with the
`est` marker: old estimates are in other units; such tasks have an actual but
no ring and no ratio.

## How to read the chart

- Estimates converge — the trend of the "actual to estimate" panel lies near
  ×1 and the dots gather inside the band. A trend above ×1 — tasks are
  underestimated.
- A task gets cheaper — the cost and token trend goes down with the same task
  size: check against the hours panel and the task types in the table,
  otherwise "cheaper" means "tasks got smaller".
- The $ trend mixes the flow with the model's rate: a model change changes
  the cost several-fold under the same flow. The «Стоимость по моделям» tile
  shows whether the model changed; the flow's effect — by tokens and hours.
- The effect of a flow change — compare the trend before and after the date
  of an ai-dev release (tags `vYYYY.MM.DD`) or of the
  `chore(agents): флоу ai-dev …` commit (the flow update) in the project;
  fewer than ten tasks after the change so far — too early to draw a
  conclusion. The chart doesn't see flow without tasks (PRs without an issue)
  — the period summary over all sessions shows it, `est period`.

## Pitfalls

- GitHub is re-read when the page opens, but at most once a minute; the
  «Обновить» (Refresh) link — immediately. A GitHub error is shown on the
  page, the server keeps running.
- «Оценка и факт» reads project rows in full, with comments: with
  `--all-repos` the first opening of the tab takes tens of seconds.
  «Сессии» doesn't wait for them: In progress tasks come from a project
  filter on GitHub's side.
- An In progress task without a session — `github task status` was run not
  from Claude Code, or the pin was removed; two sessions per task (after
  `/clear`) — the one that wrote last is shown.
- The page is local: the server listens only on `127.0.0.1` and answers only
  to the names `127.0.0.1` and `localhost`. Don't expose it — it contains task
  titles of non-public repositories.
- A Claude Code cloud session (`CLAUDE_CODE_REMOTE=true`): GitHub Projects are
  closed there, and its localhost isn't visible to the user's browser — the
  script exits with an explanation (`docs/cloud-sessions.md` in ai-dev).
- Few or no dots — closed tasks have no actual: `est fact --sweep --write`.
