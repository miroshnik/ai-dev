# Shared rules for all projects

## This file and skills

The canon of rules for any agent: Claude Code, Codex, Gemini CLI, Cursor,
Copilot, OpenCode and Amp read `AGENTS.md` themselves or via a link from
their own file. It lives in the **miroshnik/ai-dev** repository together
with the skills (`skills/*`) and references (`docs/`; `docs/…` paths in the
rules are next to this file). Install: `npx -y github:miroshnik/ai-dev
install` (latest release): everything is copied into the project's
`.agents/`, and the copy is committed; `-g` puts only the skills and the hook
on the machine, `-g --link` from a clone uses symlinks (README,
"Installation"). Only what is shared by all projects lives here; anything
project-specific goes into the project's spec in `tests/` (section "Project
knowledge and handoff"). A change to a rule or skill coming from another
project's session is a task in ai-dev (project #6), without that project's
names or details, done by a separate session; I don't edit an ai-dev clone
from someone else's session.

A Claude Code **cloud session** sees only the repository: it has the canon and
skills only if the flow is installed in the project; it has no GitHub
Projects — how to close a task from there: `docs/cloud-sessions.md`.

**The repository is public.** It holds only shared rules and skills: no
names, owners, paths or project numbers of other repositories, no names of
colleagues or clients — not in files, git history or ai-dev issues; examples
are made up. Personal configuration (the repository registry for `est`)
stays local.

**A skill is `SKILL.md` + `scripts/`** in TypeScript under Bun, following the
Agent Skills standard (README, "Repository layout"); anything that depends on
specific repositories goes into local configuration, not into the skill.
**The core of the canon — this file — is at most 32 KiB** (standard
`canon-size`): reference material lives in skills and `docs/`; here is what
always applies and where to go. Autonomous routines read the rules too; a
rule change reaches a project with an ai-dev release and `update` (next
section).

## First step of a session — an up-to-date flow

Rules are loaded into context when a session starts: with a stale flow, the
session works by old rules. So the very first thing, before the task, is
`npx -y github:miroshnik/ai-dev check -g` (machine) and `check` (project); in
Claude Code the `SessionStart` hook runs them and puts the output at the start
of the context. The project's `check` also prints its mode and language.

A copy (project; machine skills without `--link`) follows ai-dev releases —
tags `vYYYY.MM.DD` (a same-day patch is `.N`); a `--link` clone follows
`origin/main`. A release is the owner's step (`ai-dev release` from the
clone); the `check` line about flow changes not yet released is a reminder to
them; the agent cuts a release only when the owner asks.

- **Behind** — `update` (`-g` for the machine): a `--link` clone does `git
  pull --ff-only`, a copy is reinstalled. Commit the project copy as a
  separate `chore(agents): …` commit with the ai-dev tag (`update` prints the
  command) into the current task's branch, without asking; no task branch —
  don't commit, say so. Then re-read what was updated and follow it, not what
  was loaded at the start.
- **`update` refused** (clone not on `main`, dirty) or **the check is
  unavailable** — don't fix the clone; work by the current flow and say so.
- **A cloud session** doesn't update — it works by the copy in the project.

## Language

The flow is written in English; the agent works in the **project language** —
`language` in `.agents/ai-dev.json` (set by `install --lang <code>`, printed by
`check` and the hook). In it, and briefly: talking with the user, issues
(titles, descriptions, comments, checklists), prompts to subagents and chips,
documents and plans, commit and PR descriptions, `describe`/`it` names and
decision docs. Always in English: code, identifiers, terms, conventional-commit
type and scope.

Names that scripts write and parse are written in the project language
exactly as below (scripts read only the `ru` ones so far):

| | `en` | `ru` |
|---|---|---|
| issue types | `Task`, `Bug`, `Epic` | `Задача`, `Баг`, `Эпик` |
| issue sections | `## Questions`, `## Scenarios` | `## Вопросы`, `## Сценарии` |
| open-questions label | `questions` | `вопросы` |
| `Status` | `Backlog` → `In progress` → `Done` | `Бэклог` → `В работе` → `Готово` |
| project fields | `Estimate, h`, `Actual, h` | `Оценка, ч`, `Факт, ч` |
| comments | `State`, `Actual: …` | `Состояние`, `Факт: …` |
| subagent prompt | `Task #N`, `epic #M` | `Задача #N`, `эпик #M` |
| standard issue | `Standard · …` | `Стандарт · …` |
| auto answer | ✅ auto | ✅ авто |
| last line | `All done. The session can be closed.` · `All done, but there are questions: …` · `Remaining: …` | `Всё сделано. Сессию можно закрывать.` · `Всё сделано, но есть вопросы: …` · `Осталось: …` |

## What I do without asking and what needs a yes

- **Without asking:** reading and search, tests, lint, typecheck, build, local
  edits in my own checkout, local infrastructure (Docker, dev database),
  reading logs and read-only requests to external systems; task tracking per
  "Task tracking" (issues, comments, project fields, milestones, labels);
  re-running my own CI run, closing my own duplicate PR, deleting my own
  merged branch after the merge; updating the flow and committing its copy.
- **Only on an explicit "yes"** — anything irreversible or external: `git
  commit`, `git push`, merge, deploy, tag, migrations and writes to live
  databases, external service settings, deleting others' or unmerged remote
  branches and data, outgoing messages.
- **Permission is for a specific action and for this time.** "Commit" ≠ "and
  push", "fix whatever is needed" ≠ consent to merge; a past "yes" doesn't
  carry over; one "commit" covers all current work in logical steps. A
  repository may set a different mode in its `AGENTS.md`. "Do it all
  yourself" lifts intermediate confirmations for the named task; stop only on
  a discrepancy that changes scope or approach. An autonomous routine's
  permission is its assignment: exactly what is named; merge, deploy and
  external settings only if named explicitly.
- **`"auto": true` in `.agents/ai-dev.json` — the whole task without asking**
  (a project setting, set by `install`): commit, push, fixing CI and merging
  my own PR on green checks — myself; I answer the task's open questions with
  a recorded recommendation, marked ✅ auto in the issue. A question of my own
  that I'd ask without auto goes there too, into the questions section, with
  the decision and ✅ auto, before code: in chat the decision gets lost. No
  clear recommendation, a critical decision, or one that must come from a
  human — I ask; I also stop on a discrepancy that changes scope or approach.
  Everything else irreversible or external still needs a "yes".
- **Secrets and bypassing protections — only with permission:** tokens, keys,
  bypass secrets, disabling checks at the host, CI or cloud — I first say
  what will appear and where. I never store a secret from chat; when done I
  remind to rotate it.

## Task tracking

- Tasks live in the project repository's **GitHub Issues**, not in local
  lists, TODO files or the agent's task list; no repository — ask where to
  keep them. The `github` skill creates and runs tasks (`task new`, `task
  status`, `task close`, `task drop`, `pr labels`); how tasks, the project and
  milestones are organized — its `reference.md`.
- **Every issue has a type** — exactly three: Task (one PR), Bug, Epic; a
  personal account has no types — an epic gets the `epic` label. **Decision
  labels** — the decision's name (`tests/…/<name>` or a model module), kind
  by color; a code task carries the labels of the decisions it introduces or
  changes, an epic — their union.
- **A big task is an epic + subtasks** (sub-issues; the epic has a short
  prefix `<Prefix> · …`, a subtask is one PR); **dependencies only as GitHub
  links** (sub-issue, blocked by), not in text: a task with a non-empty
  *blocked by* isn't taken into work. Before creating — check that it doesn't
  exist yet (`gh issue list --search`).
- **GitHub Project** — exactly one per repository, named after the
  repository, holding all tasks and epics; `project check` once per session,
  ❌ — `project fix`. Status is only the project's `Status` field: Backlog →
  In progress → Done, which I set **myself, immediately** (`task status`;
  closing — `task close`; won't do or duplicate — `task drop`: not planned
  and out of the project). Estimate and actual fields — only via the `est`
  skill. Priority — the issue field `Priority` (`Urgent` → `Low`), required
  on an open task, `Medium` by default. A milestone is a named set of tasks
  (an epic stage `<Epic> · <N> · <Name>`, a release), optional; I close it
  myself with its last task.

### Session and branch — one task

- **Session = task:** `task status` won't take a second one. Another task
  goes to Backlog and, as a chip `#263 …`, into a new session (no chips —
  first prompt `#263`); "do it here" and the chip's "here" button — a
  one-sentence refusal and the chip again. My own regression and a fix for a
  green PR are the same task. An epic's session plans and hands out work and
  doesn't take In progress.
- **The session is named `#<number> <task title>`** — the issue title with
  the number in front: `#42 Billing · Export invoices to PDF`. I rename it
  myself as soon as the task is clear (no tool — ask the user): `est` links
  the session to the task by its name. A session without a task — named by
  meaning, without a number.
- **Branch = `<type>/<issue>-<slug>`**: `feat/42-invoice-export`,
  `research/73-search-engine-choice` — one slash, number joined by a hyphen.
  `type` — conventional-commit types (`feat fix docs refactor perf test chore
  ci build`) plus `research` (a spike without code); the same list is the
  task type in `est`. Slug — Latin, kebab-case, 2–5 words; an area prefix
  adopted in the repository goes first: `backend/fix/263-…`. A branch named
  by a worktree tool — I rename it before the first push (`git branch -m`).
- **PR:** the title is a conventional commit (`feat(scope): description`),
  the body has `Closes #263`. **Merge — rebase only** (`gh pr merge <N>
  --rebase`; `github project fix` turns other methods off): the commits
  themselves land in `main` — each a conventional commit, and `Closes` in any
  of them would close the task, so commits say `Refs #263`. In a repo without
  PRs — `Closes #N` in the last commit.

### Open questions — at the start of work

A task's questions live in its description, in the questions section (a
numbered list; while any are unanswered — the questions label). Taking a task
into work, **first of all** — before the plan, code and subagents — I read the
questions of the task and its epic and **ask the user all open ones (without
✅)** in one message, with options and a recommendation for each: the answer
may change scope and approach.

- First I filter out what already has an answer (comments, code): ✅ with the
  answer. My own questions — in the same message and in the questions
  section, continuing the numbering.
- While waiting, I do what doesn't depend on the answer; what depends on it I
  don't start, and I don't replace the answer with an assumption.
- Answer received — straight into the issue: ✅ and the answer at the
  question, numbering unchanged; no open ones left — I remove the label.
- An autonomous routine (no one to ask) doesn't take a task with open
  questions.

### Estimate and actual — the `est` skill

- **Unit** — the agent's active hours on the task (work + pauses ≤ 30 min),
  not person-hours and not calendar time.
- **Estimate** — only via the `est` skill, from analogs with actuals; no
  analogs — "expert, confidence C". The estimate field is never written by
  hand and never rewritten after work starts.
- **Actual at closing** (PR merged / issue closed) — `github task close <N>`
  (runs `est fact <N> --write` inside): the actual comment and the actual
  fields; never touch them by hand; no actual — "actual unavailable", not a
  number by eye.
- **Work is linked to the task** by pinning the session (`task status` In
  progress), otherwise by the session name, the branch
  `<type>/<issue>-<slug>`, `Closes #N` in the PR and the task number in every
  subagent's assignment (form — "Subagents and worktrees") — otherwise there
  will be no actual. More — the `est` skill.

### Epic refresh on task close

Once a task is merged, **a subagent with a fresh context** brings the open
tasks of the same epic in line with what shipped; the session at peak context
doesn't do it itself. `github task actualize <N>` prints the assignment with
the five checks (no epic or no open tasks in it — not needed) — in the same
turn as `ci-wait merged <PR>` in the background; the subagent and the deploy
wait run in parallel, after both — `github task close`. Merged, deploy
awaited, branch removed, epic refreshed, no questions — the last line of the
answer is the "all done, can be closed" line; done, but the owner has
something to decide — the "all done, but there are questions" line with the
questions themselves; otherwise — the "remaining" line with what the session
waits for and from whom (exact wording — "Language"). In auto mode, after the
"can be closed" line the session archives itself where the agent has the tool;
information without a decision (a deadline, a warning) doesn't prevent it.

## Git, PRs and merging

- **Taking a task into work** — check it isn't already going in a parallel
  session (an open PR, a branch `*/<N>-*` after `git fetch --prune`). It is —
  I continue that work or wait for the merge; two PRs for one thing — I close
  the second.
- **Branch only from a fresh `origin/main`** (`git fetch origin && git switch
  -c feat/263-slug origin/main --no-track`); the local `main` and the status
  snapshot at session start are stale. Into `main` only via a PR; a direct
  push to `main` and `gh pr merge --admin` — only on the owner's direct
  instruction.
- **I commit in logical steps** (conventional commits), not one commit per
  PR; tests go in the same commit as the code.
- **I merge a PR as soon as its CI is green and GitHub merges it without a
  conflict**, a branch that fell behind too. Rebase and a re-push
  (`--force-with-lease`) — only on a textual conflict or my own changes.
  **Before merging — `github pr premerge`:** if `main` moved after the PR's
  CI — fast checks (`typecheck`, `test:spec`) on the merge with a fresh
  `main`; red — I don't merge and fix the root cause; `main` is red by itself
  (exit code 3) — I don't merge and don't fix it in the PR: one bug for it,
  and I wait for it to close. **Before a push** — is it my branch.
- **Merge only with all checks green**, including the preview deploy; an
  empty check list means "not registered yet", not "passed"; for a merge that
  deploys — wait for the deploy on the merge SHA (the `ci-wait` skill), the
  epic refresh in parallel. **Then — `github task close`**: actual, Done, epic
  and milestone, the merged branch removed; I don't touch others' branches or
  unmerged work.
- **Before a commit — exactly the checks CI runs**, via the repository's
  scripts (`lint`, `typecheck`, `test`), before merging — a full build; in
  `script | tail` chains — `set -o pipefail`.
- Mechanics — the `github` skill, "Git, PRs and merging — mechanics"; the full
  SHA, waiting for checks and deploys — `docs/pr-checks.md`.

## Specification — decisions

A project's spec is **decisions with a mechanical check**, functional and
non-functional: a test, a lint rule, a check over the architecture model.
**No check — no decision; no decision — no code:** behavior without a check
may be changed without agreement; code that no decision claims is dead. The
test is written before the code and is red first. Three roots of `tests/`, by
the reader's question: `capabilities/<name>` (what the system does),
`architecture` (what it's made of — a model with checks), `standards/<name>`
(code rules and cross-cutting qualities); a decision is a folder
(`<folder>.md` — why, `<folder>.test.ts` — the statements, the mechanism next
to it). Exceptions — a mark in the element's file or in the decision folder's
`exceptions/`, one file per exception, with an `#issue` and a reason, with a
ratchet. `describe` and `it` names are statements in the project language. A
code task gets the scenarios section (future `it` names) before code. The PR
body is `spec-diff` output: the diff of checks is the diff of the spec.
Documentation is generated (`spec-doc`), it isn't in `main` — CI publishes it
to the `spec` branch. A recurring decision — a "Standard · …" issue and a rule
in `tests/standards/`. The full canon and how to wire each mechanism — the
`spec` skill (`canon.md`, `checks.md`).

## Tests and code

- **A test failed — I fix the root cause** (the test or the logic), even if
  the failure is unrelated to my changes and a green rerun exists; not "a
  pre-existing flake", not timeouts and retries: I remove a race by its cause
  (wait for the real event, not a pause). A flake suspicion is checked with
  the same run on the base branch: red there too — I compare the delta,
  otherwise someone else's flake becomes my regression.
- **A run's result — by the runner's summary**, not the wrapper's exit code:
  a run killed mid-tests can be "green". Project checks go through the
  machine queue (the `slot` skill), a full run — in the background. Runs, e2e,
  UI in a browser — `docs/testing.md`.
- **A regression test and a "no defect" guard must be able to fail**: I
  revert the fix, see red, restore it. It didn't fail — either it guards
  against overcorrection (and I name it so) or it is deleted.
- **An external API contract — by its schema or docs**, not by intuition
  about REST; on a mismatch with the schema I fix the test, not the code to
  fit the test.
- **Intentionally different behavior in two places** — mirrored comments with
  the reason in both, otherwise the next reader will "fix" it.
- **I check what reached the human,** not my own output: the delivered email,
  the page at the recipient — someone else's system changes the result after
  us while our checks are green. A component on several surfaces (site and
  email) — I check it in the isolation of each.
- **Judgment and edits:** before a run — which of our mistakes would give the
  same outcome; I align labels after checking what the numbers mean; I edit
  exactly what was named; "doesn't reproduce" — say what I measured with.
  `docs/judgment.md`.

## Production and debugging

- **The production database is read-only.** Data and schema changes — via a
  migration in a PR through the regular rollout. DDL on production — only on
  the owner's direct instruction: a migration file in the repository; if the
  environment refuses — explain, don't look for a workaround. Data managed by
  the application (roles, permissions, audited settings) is never changed by
  direct DML — the audit is lost and guards are bypassed; what the UI lacks
  is a code change, not DML.
- **Production numbers — first, is it the right database:** the first query
  checks it against the repository (migrations, columns, orders of
  magnitude); doesn't match — stop.
- **"Didn't help" → production facts, not a third reproduction:** first the
  logs of the real request and production data (the row, `updated_at`,
  audit), then a new hypothesis.

## Subagents and worktrees

- **Subagents don't share a dirty worktree.** An agent that may install
  packages or touch files "to try" gets an isolated worktree or "read-only
  plus a temp folder" with `git checkout/restore/stash/clean` forbidden: for
  it, "cleaning up after itself" means reverting everything uncommitted,
  including others' work. Several agents in one worktree — on non-overlapping
  files, without git commands, shared files have one owner, dependent groups
  run as a pipeline. After a fan-out — `git status` and `git diff --stat`
  before continuing.
- **The session's temp folder is shared with subagents:** temp files get a
  unique prefix (task, role), otherwise a subagent silently overwrites a file
  with the same name.
- **A fresh worktree lacks untracked files** (dependencies, `.env*.local`): I
  install them and copy from the main checkout. All paths in commands and
  subagent assignments lead into the worktree: a path "from memory" goes to
  the main checkout, and the edit lands on `main`. Before and after an edit —
  `git -C <worktree> status`.
- **Parallel checkouts share ports, databases and `.git/config`:** the server
  and e2e of each worktree run on their own port and database from
  environment variables; I don't kill someone else's busy port; the rule, a
  config fragment and the "what moves" checklist — `docs/parallel-checkouts.md`.
- **A subagent gets a unit of ~50 turns** (one decision's folder, one file,
  one spec), not a 200-turn zone: a subagent carries the same preamble and
  costs like a session, and the price ≈ N×P + N²×r/2 is quadratic in the
  number of turns N (P — preamble ≈ 100k tokens, r — context growth per turn
  ≈ 1.6k). The assignment has the task number after the word for "task" or at
  the start, the epic after the word for "epic" (exact words — "Language"):
  that's how `est` links its work.
- **Fewer turns:** a file in one full read, not slices of 1–2k; independent
  tool calls in one turn; read up front only what the unit needs. Turns and
  the task's tail show up in its actual (`est`).

## Project knowledge and handoff

- **Shared — in ai-dev, project-specific — in the project's tests.** A rule
  for any project lives only in ai-dev: this file, `docs/`, skills; the
  project has the installed copy. Project-specific goes into the project's
  spec: what the system does — `tests/capabilities`, what it's made of — the
  `tests/architecture` model, which rules the code obeys — `tests/standards`,
  the reason — in the decision's `<folder>.md`. What is neither shared nor
  mechanically checkable (operations, product documents) — the project's
  `docs/`. The project's `AGENTS.md` — the install block and only how its
  mode differs from the canon (permissions). An agreement from chat I write
  there too, not into the agent's memory: memory is a cache, not a source.
- **I don't revisit the stack** and don't drag in extra dependencies; if
  something is in the way — a question to the user, not a silent
  replacement. Versions — latest stable; a question about a tool — its
  official documentation first, not a guess.
- **Before a pause or an agent change — a State comment in the issue:** what
  is done, the branch, what's next, what blocks — so any agent can continue.

## CI: parallel tasks

- **Branches and PRs run in parallel:** only my own stale run of the same
  branch is cancelled.
- **`main`, tags and manual runs are never cancelled** (`queue: max`);
  deploy — a queue per environment; CI and deploy — in different workflows.
- **I don't cancel or re-run others' runs.** The full rule and workflow
  fragments — `docs/ci-concurrency.md`.
