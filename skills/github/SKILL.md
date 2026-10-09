---
name: github
description: GitHub project and tasks by the AGENTS.md canon in one command — `project check` verifies the project, default-branch rule and merge method (✅/❌), `project fix` brings them to the canon (rebase-only merge, required checks, UI steps in the browser); `task new` creates a task with type, decision labels, project, Priority, epic, blocked by and milestone at once; `task status`, `task drop`; `task actualize` prints the epic-refresh subagent's assignment right after a merge; `task close` closes a merged task in one call (est actual, Done, epic, milestone, merged branch); `pr labels` labels by the PR diff; `pr premerge` checks the merge with a fresh default branch and tells a red PR from a red base (code 3). When — once per session before task work; creating a task or subtask; a PR opened, green or merged; taking, finishing, reopening or cancelling a task; asked whether the project is set up, why a task isn't in Done or on the board, why GitHub won't merge a PR — even if "project" and "task" weren't said.
allowed-tools: Bash(bun *skills/github/scripts/github.ts *) Bash(git remote get-url *)
---

# github — project and tasks by the canon, not from memory

Principles — `AGENTS.md`, section "Task tracking"; the full rules (types,
decision labels, epics, dependencies, the project, milestones, the five
epic-refresh checks) — `reference.md` next to this file. Done by hand from the
reference, projects drift apart (somewhere "Item closed" is off, somewhere a
filter hides tasks from the board), and a task gets created without a status,
priority or epic link. The script `scripts/github.ts` next to this file checks
the project against the canon, fixes what the API can, and creates a task with
all fields in one command; the agent goes through the UI steps and asks for
confirmation on anything destructive. Editing an existing task (Priority,
links) and milestones — `reference.md`, section "Manual commands". Mechanics of
branches, push and merge — section "Git, PRs and merging — mechanics" below.

```bash
bun <skill dir>/scripts/github.ts project check [--repo owner/repo]
bun <skill dir>/scripts/github.ts project fix [--repo owner/repo] [--confirm] [--template owner/N | none]
```

The repository — from `git remote get-url origin` or `--repo`. Needs `gh` with
the `project` scope (`gh auth refresh -s project`); the organization's issue
types — `admin:org`.

## What to run when

| Moment | Action |
|---|---|
| Session start, before working with tasks | `project check` — once per session |
| `check` gave ❌ | `project fix` → UI steps → confirmations → `check` again |
| Repository without a project | `project fix`: links the owner's project of the same name, otherwise copies the template, otherwise creates one |
| Cloud session | don't run: Projects v2 are unavailable to it (`docs/cloud-sessions.md`), the script exits with code 2 |

Codes: `0` — everything per the canon (for `fix` — and no steps left), `1` —
there are ❌, steps or errors, `2` — a call or access error, or a cloud session.

## What is checked

1. The project is linked to the repository, it is the only one, its title =
   the repository name.
2. Views `Доска` (board; BOARD, columns by `Status`), `Таблица` (table; TABLE),
   `Роадмэп` (roadmap; ROADMAP), filters empty, no others.
3. `Status`: `Бэклог` → `В работе` → `Готово` (Backlog → In progress → Done).
4. Fields «Оценка, ч», «Факт, ч», «Токены, млн», «Стоимость, $» (estimate h,
   actual h, tokens M, cost $; Number), no custom fields beyond the canon.
5. Organization only: `Priority` — the organization's issue field, connected,
   `Таблица` and `Доска` are sorted by it; issue types — exactly «Задача»,
   «Баг», «Эпик» (Task, Bug, Epic). A personal account has none — a `➖` line.
6. Workflows "Item added to project" (→ Backlog), "Item closed" (→ Done),
   "Auto-add to project" (`is:issue is:open`) are on.
7. Closed tasks — in Done; those closed without being done (not planned,
   duplicate) — outside the project.
8. The repository's open tasks — in the project, each has a `Status`.
9. Decision labels — by the spec tree of the default branch (via the API): the
   label name is the decision name (folder
   `tests/capabilities|standards|architecture/<name>` or a model module), kind
   — by color: capability `0E8A16`, standard `1D76DB`, architecture `D93F0B`.
   One name for decisions of different kinds — one label: the color of the
   senior kind (capability → standard → architecture), all paths in the
   description. A decision label is recognized by the description `Решение: …`
   (decision: …). A decision without a label — the label is created. A label
   without a decision on an open task — a new decision (`task new` puts it, it
   reaches the default branch with the task's PR): an `○` line with the task
   numbers, item ✅, the label is left alone. A label without a decision and
   without open tasks — deleted with `--confirm`; one such and one missing of
   the same kind — a rename with `--confirm` (tasks keep the label); a foreign
   color or description — fixed. An old `kind:name` label is renamed to `name`
   by itself, whether or not the decision is in the default branch; the name is
   already taken — a merge with `--confirm` (tasks get the label with the name,
   the old one is deleted). A regular label with a decision's name — ❌, it
   becomes a decision label with `--confirm`. A slice label — another slice of
   the project's tasks (apps, teams), recognized by the description
   `Разрез: <slice>[ — note]` (slice: …): with a decision's name — an `○` line
   with the slice, item ✅, `fix` doesn't touch it, the decision stays without a
   label. The model (`tests/architecture/model.ts`) is read by a separate
   process — if it didn't load, module labels are left alone, ❌ with the
   reason.
10. Merging into the default branch — only with green required checks: an
    active branch rule (`Ref.rules` — a repository or organization ruleset —
    or classic protection) with a non-empty list of required checks. None —
    `fix` sets the `ai-dev` ruleset: `~DEFAULT_BRANCH`, without strict (the
    rule doesn't require an up-to-date branch), required — the checks green on
    each of the last 10 merged PRs, bypass — the admin role (the owner's direct
    push). Its own ruleset keeps being checked: disabled, with strict or
    without bypass — fixed; a required check that the fresh head lacks (the
    last merged PR, an open PR with finished checks) leaves the list —
    otherwise a PR would wait for it forever; a new stable one is added.
    Someone else's rule with required checks — ✅, with strict or without: no
    own ruleset is created, the other rule isn't edited. A private repository
    on Free (GraphQL returns empty rules, REST — 403 "Upgrade to GitHub Pro")
    and merged PRs without a common green check — a `➖` line. This item
    doesn't need the project.
11. PR merge method — rebase only (canon, "PR"): in the repository settings
    merge commit and squash are off, rebase is on — otherwise a PR would be
    merged past the merge rule, and `gh pr merge --rebase` would be refused.
    `fix` sets this with one REST request (`PATCH repos/{owner}/{repo}`:
    GraphQL doesn't change merge settings); it needs admin rights — without
    them a `!` line with GitHub's response and a link to the settings. This
    item doesn't need the project.

## fix: who does what

- **API — the script itself:** linking, a template copy or a new project,
  missing views and fields, view layout, removing a filter, `Status` options,
  the `Priority` issue field, task statuses, adding open tasks, removing tasks
  closed without being done from the project, decision labels (creation,
  color), the default-branch ruleset (creation, editing its own), merge
  methods — rebase only (REST). `+` lines.
- **UI steps** (`Шаги в UI …`, "UI steps …") — what the API lacks. Calling
  `fix` is permission to configure this repository's project: the agent goes
  through the steps itself, in a browser where the user is signed in to GitHub
  (Claude in Chrome or the built-in browser after they sign in), without asking
  separately. No browser or sign-in — a list of steps with links for the user.
  The agent doesn't enter a password. After the steps — `check` again.
- **Confirmation** (`Нужно подтверждение …`, "confirmation needed …") —
  deleting and renaming in a project that already has tasks, unlinking extra
  projects, the organization's issue types (shared by all its repositories),
  deleting and renaming decision labels (they are on tasks). Show the list to
  the user, after a "yes" — `fix --confirm`. In a new project without tasks,
  deleting and renaming go without confirmation.
- **Error** — a `!` line with the reason (and a link to the UI if the step is
  done there): most often `gh` lacks a scope.

## UI steps — how to go through them

- **Workflow:** the link leads to a configured workflow
  (`<project>/workflows/<fullDatabaseId>`) or to the list `<project>/workflows`,
  where an unconfigured one is picked in the left menu. Edit → configure →
  **Save and turn on workflow**; `On` appears at the top right. In Set value
  `A value is required` — the `Status` option the workflow pointed at was
  deleted (options were replaced without ids): pick it again.
  - "Item added to project": trigger `issue, pull request` (default), Set
    value → `Status: Бэклог`.
  - "Item closed": Set value → `Status: Готово`.
  - "Auto-add to project": the repository — this project's, filter
    `is:issue is:open`, Enter — the "See N existing items" counter should
    update. Without `is:open` an updated closed task (a not planned one too)
    comes back into the project. Auto-add doesn't add already existing tasks —
    `fix` adds them.
- **Sorting by Priority, board columns:** the view → the `View` button on the
  right → `Sort by: Priority` / `Column by: Status` → `Save view` → the dialog
  "Save display options for …?" → `Save`. Escape closes the dialog without
  saving: the sorting stays only in the URL (`?sortedBy…`), and the tab's
  unsaved marker lies — `check` verifies the result.
- **The organization's issue fields** (the organization has no `Priority`) —
  the organization settings via the link from the step, then `fix` again.

## Details the script exists for

- **A workflow can't be turned on via the API, and its target can't be read:**
  `ProjectV2Workflow` returns only `name`, `number`, `fullDatabaseId`,
  `enabled`; there is no mutation to turn it on. An unconfigured workflow isn't
  in the list at all (for a new project — "Item closed", "Pull request merged",
  "Auto-close issue").
- **The "Item closed" target is seen from the result:** a closed task not in
  Done — the workflow is off or points at a deleted `Status` option. `fix` sets
  Done and leaves a step to check the target in the UI.
- **`Status` options are renamed keeping the same id**
  (`updateProjectV2Field`, `singleSelectOptions[].id`): task values and the
  "Item closed" target are kept. Replacing options without ids gives new ids —
  task statuses vanish, "Item closed" sets the deleted `Done`.
- **The template** — the ai-dev project (`miroshnik/6`): everything the API
  lacks is configured there once. A copy (`copyProjectV2`) carries over views
  with their settings, fields and configured workflows, except auto-add; it
  doesn't carry over tasks, collaborators or the repository link. The template
  is unavailable (someone else's account) or `--template none` — the project is
  created from scratch (`createProjectV2`) and brought up via the API:
  `Todo / In Progress / Done` → the canon with the same ids, `View 1` →
  `Таблица`, the rest is created.
- **The view filter is empty:** `iteration:@current` without an Iteration field
  silently hides tasks from the board.
- **`Priority` is the organization's issue field** (`isIssueField`), not a
  project field of the same name. The API reads the sorting (`sortByFields`)
  but doesn't set it; the board grouping too (`verticalGroupByFields`).
- **A project that has been used** — it has tasks.

## Tasks — task

```bash
bun <skill dir>/scripts/github.ts task new --title "…" [--body-file F | --body "…"] [--type Задача|Баг|Эпик] \
    [--epic N] [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low] \
    [--labels <decision>,<kind>:<new decision>,<label>] [--repo owner/repo]
bun <skill dir>/scripts/github.ts task status <N> "В работе"      # Бэклог | В работе | Готово (Backlog | In progress | Done)
bun <skill dir>/scripts/github.ts task drop <N> [--duplicate-of M]
bun <skill dir>/scripts/github.ts task actualize <N>               # right after the merge: the assignment for the epic-refresh subagent
bun <skill dir>/scripts/github.ts task close <N> [--no-git]         # after merge and deploy: actual, Done, epic, milestone, branch removed
bun <skill dir>/scripts/github.ts pr labels <PR>                 # decision labels from the PR diff
bun <skill dir>/scripts/github.ts pr premerge <PR>               # before the merge: the merge with a fresh default branch
```

| Moment | Action |
|---|---|
| New task, an epic's subtask, an epic | first — whether one already exists (`gh issue list --search`); `task new`; then the estimate — the `est` skill (an epic isn't estimated: its estimate is the sum of its subtasks, `reference.md`) |
| Took into work · reopened | `task status N "В работе"` — a separate call, no pipeline (`tail` hides the refusal code), before creating the branch |
| PR merged | in one turn — `task actualize N` and in the background `wait-ci.sh merged <PR>` (it takes the merge SHA itself); a refresh is needed — next turn, in the background, a subagent with the printed assignment; after both — `task close N` (exit code 0 from the wait — right away, don't read the output) |
| Task closed without a PR | `task actualize N`, the subagent; then `task close N` |
| Won't do, duplicate, replaced by others | `task drop N [--duplicate-of M]` |
| PR ready (and after new commits) | `pr labels <PR>` — decision labels for the task and the epic |
| PR's CI green (`ci-wait` PASS), before `gh pr merge` | `pr premerge <PR>` — a separate call; code `0` — merge, `3` — `main` is red: don't merge, wait for the bug |

**`task new`** — one `createIssue` mutation: the organization's issue type (in
a personal account an Epic gets the `epic` label, created if missing; Task and
Bug get no label there), the project, the epic (sub-issue), the milestone by
title among open ones, `Priority` in an organization (`Medium` by default).
Then `Status: Бэклог` — by itself, without waiting for the workflow — and
blocked by. A subtask's title gets the epic's prefix (`<Prefix> · …`) if it
lacks it; the epic's `Priority` is raised to the subtask's if the subtask is
more urgent. Everything is checked before creating — an error (code 2) doesn't
leave a half-made task: `--epic` is an open epic, the milestone exists, the
blockers exist (closed ones are skipped), there is no open task with the same
title, the type is enabled, `Priority` is one of the options; in a personal
account `--priority` is an error. `--labels` — the task's labels in the same
mutation: a decision from the default branch — by name (`billing`), a new
decision — `kind:name` (`capability:export`, the label is `export`, the line
«новое решение» (new decision): it will appear in the task's PR); no decision
label — created with the kind's color; a regular label must exist, otherwise an
error before creating. A slice label by name (`api`) is a regular task label,
not passed to the epic; `kind:name` with a slice label's name is an error
before creating: a decision with that name isn't marked by a label. Prints
`Создана #N …` (created), `+` lines and the next step; in a session with a
pinned task (`task status` below) — a second line «Дальше:» (next):
`сессия ведёт owner/repo#N — #M в новой сессии, первый промпт: #M` (the
session runs owner/repo#N — #M in a new session, first prompt: #M).

**`task status`** — sets `Status` (a task outside the project is added). A
subtask going In progress moves its epic from Backlog to In progress too.
Hints: the epic is closed but a subtask is in work again — reopen the epic and
its milestone; all subtasks are closed — close the epic and set it to Done.
In progress pins the task to the session: the file
`~/.config/ai-dev/sessions/<CLAUDE_CODE_SESSION_ID>` (or in
`$AI_DEV_CONFIG_DIR`) with the line `owner/repo#N`. Another task In progress in
the same session — a refusal (code 2) before any changes, in one line: the
pinned task, the new session's first prompt (`#M`) and the file path. The same
task again, an epic, Backlog and Done — no refusal. No command removes the pin:
a mistaken one is removed by a human, by deleting the file. `est` counts the
actual by the pin: the whole session goes to this task. No variable (not
Claude Code) — the line `○ сессия не опознана …` (session not recognized), the
status is set, no guard.

**`pr labels`** — decision labels from the PR's changed files (API):
`tests/capabilities|standards|architecture/<name>/…` — a decision label, a code
file — the label of the model module from the PR head (the longest matching
directory), `tests/lib` and files outside modules aren't decisions. A
mechanical edit doesn't change a decision and gives no label: a deleted file,
a rename without content changes, an exceptions file of a decision folder that
spec reads as an exception (`exceptions/*.json`, `names.exceptions/*.json`, the
former `exceptions.*` and `names.exceptions.*`; a copy of the spec rule
`exceptionFile`) — a decision touched only that way
comes out as an `○` line (a label is needed — set it by hand). A decision whose
name belongs to a slice label (module `web` and the app label `web`) — also an
`○` line: a slice label isn't set as a decision label. It labels the tasks from
"Closes #N" (the PR–task link; right after the PR is created GitHub hasn't set
it yet — the tasks from the PR body's keywords as GitHub understands them; none
at all — an error), creates a missing label with the kind's color; it doesn't
remove an earlier label of a decision missing from the diff — an `=` line. The
task's epic gets the same labels — the union of its subtasks; same with
`task new --epic --labels`.

**`pr premerge`** — before merging a green PR, from a repository checkout: CI
checked the merge with the default branch as it was at the time of the run,
and without a merge queue the branch moves ahead. Didn't move — `✅ вливать`
(merge), nothing is built. Moved — the PR head (`refs/pull/<N>/head`) merged
with a fresh `origin/<base>` in a temporary worktree (`git merge`, like
GitHub's merge-ref; the worktree is always removed), dependencies by the
merge's lockfile (`packageManager`, otherwise the lockfile:
`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`,
`yarn install --frozen-lockfile`, `npm ci`; no lockfile — no install) and the
project's fast checks — the `package.json` scripts that exist, in CI order
until the first red: `typecheck` (a semantic conflict of two PRs: one removed a
function, the other calls it — seconds, #292), then `test:spec` — standards and
architecture, where two green PRs break ("registry + invariant"), not the
whole `test`. None of them — an `○` line, merge. GitHub doesn't store what CI
checked, so "moved" is judged by time (REST): the earliest check suite of the
PR head against the branch's last event (Activity API); an event within a
minute before the check suite also counts as moved (the merge-ref is built
earlier); no checks or the event wasn't read — it is checked. Codes: `0` —
merge; `1` — don't merge: red `typecheck` (compiler errors), `test:spec`
(lines of failed tests) or a conflict (files) — fix the root cause in the PR:
rebase onto `origin/<base>`, edit, `push --force-with-lease`, `ci-wait` again;
`2` — couldn't check (not a checkout, PR not open, dependency install failed) —
don't merge either, investigate; `3` — **`main` is red, not this PR**.

**Red `main`** (#282). The merge is red — the failed check is also run on bare
`origin/<base>` in its own temporary worktree: red with the same — code `3`;
the PR breaks beyond it (failed tests and compiler errors of the merge that
aren't on `main`, ignoring run time and position in the file) — code `1` with
them. A red check on the default branch's last commit — a check-run (the last
run of each name: `failure`, `timed_out`, `startup_failure`; a cancelled one
isn't red) or a host status (`failure`, `error`) — the same code `3` before
checking the merge; checks not read — an `○` line, the check goes on. With
code `3` the session doesn't merge and doesn't fix it in its PR: one bug for
everyone — an open issue titled «`<base>` красный…» (`<base>` is red…; REST
search) that names the failed check (or script) — the whole name: `test` isn't
in "test:spec" (#338); open ones about another check — the line
`○ … про другой чек: не ждать` (about another check: don't wait). Found — a
line with the number and the wait command `wait-ci.sh issue <N>` (the `ci-wait`
skill, as a background command: its completion wakes the session), then
`premerge` again; for a failed check that none of them names — a hint to find
an open bug on the failed test (under another title) or the command
`task new --type Баг` with the title
«`<base>` красный: <check | typecheck | test:spec>» (`--priority Urgent` in an
organization; add the failed test's decision label), a chip for the bug and
the same wait. A PR that closes any open «`<base>` красный…» bug (`Closes #N`
in the body) is a fix, without matching the check: the same breakage is named
by a script one time and by a CI check another; a red `main` doesn't stop it
(an `○` line), its red merge is code `1`, as usual.

**`task drop`** — closes as not planned (with `--duplicate-of` — as a
duplicate with a link) and removes it from the project: otherwise "Item closed"
would put it in Done and into the epic's estimate. It doesn't touch a completed
one. A subtask — a hint to recalculate the epic's estimate.

**`task actualize`** — the assignment for the epic-refresh subagent, right
after the merge: the refresh doesn't depend on the deploy and runs in parallel
with it, while the session at peak context neither assembles the assignment
nor reads `reference.md`. It prints the whole assignment — pass it to the
subagent as is: the first line «Задача #N (эпик #M)» (Task #N (epic #M); `est`
links the subagent's work to the task by it), the task and its merged PR (the
link, otherwise the branch or "Closes #N" among recent PRs), the epic and its
open tasks, the five checks from `reference.md`, what may be changed (only
GitHub tasks; the task, the epic and their milestone are closed by
`task close`), where to write the edits (a comment in the epic) and the answer
form. No epic, or no open tasks in the epic other than this one — the line
`○ актуализация не нужна` (refresh not needed), no subagent. Read-only, changes
nothing. The order after the merge — fewer turns (measurement #285: the extra
turns were `gh pr view` for the SHA and reading the wait result): in one turn,
as separate calls, — `task actualize N` and a background
`wait-ci.sh merged <PR>` (where the merge deploys or runs CI on `main`; the
script takes the merge SHA from the PR itself), in Claude Code — also
`ToolSearch` for the `archive_session` schema if it isn't loaded yet; next — in
the background the subagent with the assignment, if a refresh is needed; a wait
notification with code 0 — `task close N` right away, don't read the output
file (not 0 — the `RESULT:` line in it); then the last line of the answer and
archiving — in one turn.

**`task close`** — the closing ritual in one call, not a step per turn at the
session's largest context. Only after the task's PR is merged (or a close
without a PR): a PR that is open or closed without a merge — an error before
any changes. GitHub sometimes doesn't link a merged PR to the task for hours —
then the task's PR is searched among the default branch's recent PRs by the
branch `<type>/<N>-<slug>` and "Closes #N" in the body: merged — the task is
closed with the comment «Закрыта по PR #M: GitHub не связал PR с задачей»
(closed by PR #M: GitHub didn't link the PR to the task), none — a refusal
listing what was checked (no manual `gh issue close` needed). Order:
close the task if the merged PR didn't; the actual — `est fact <N> --write` by
the est script next to it (`../est/scripts/est.ts`; missing — the line
`○ факт недоступен` (actual unavailable), failed — its error as a `!` line, the
rest is done); `Status` Done; the last sub-issue closed — the epic is closed
and gets Done; no open tasks left in the task's (and the epic's) milestone —
the milestone is closed (REST); the merged branch — per the "Right after a PR
merge" item of "Git, PRs and merging — mechanics" below: the checkout moves
off the task's branch to `origin/<base>` detached, the local and remote
branches are deleted; not merged, someone else's, or the directory isn't a
checkout of the repository — an `○` line, nothing is touched; the command
doesn't delete the session's worktree — the `Дальше` (next) hint. `--no-git` —
without the git step. The last output line — the end-of-session steps: the
epic has open tasks — a reminder about the epic refresh (its place is before
close, in parallel with the deploy; if it didn't happen — a subagent with the
`task actualize N` assignment), then the last line of the answer, one of three
(wording in the project language — `AGENTS.md`, "Language"):
`All done. The session can be closed.`; the owner has something to decide —
`All done, but there are questions: …` with the questions themselves;
something remains — `Remaining: …`. In auto mode after
`All done. The session can be closed.` — archiving the session where the agent
has the tool (the command doesn't read the manifest — the condition is stated
in words); after the other two lines — no. Information without a decision (an
observation, a deadline, a warning) isn't a question: the line and archiving
are the same. A cloud session — a refusal with an explanation
(`docs/cloud-sessions.md`).

## Git, PRs and merging — mechanics

Principles — `AGENTS.md`, section "Git, PRs and merging"; here — the full
rules. Waiting for checks, the full SHA and a merge that deploys —
`docs/pr-checks.md`.

- **Merge — rebase only:** `gh pr merge <N> --rebase`; other methods in the
  repository are turned off by `project fix` (item 11). The branch's commits
  themselves land in `main` — each a conventional commit with `Refs #N`.
- **Merge without a queue:** a PR is merged as soon as its own CI is green and
  GitHub merges it without a conflict; the branch needn't be up to date —
  GitHub merges a branch that fell behind: the default-branch ruleset
  (required checks, no strict) is set by `github project fix`. Rebase onto
  `origin/main` and `git push --force-with-lease` (not `--force`), with
  permission as usual, — only on a textual conflict or my own changes.
  **Before merging — `github pr premerge <N>`** (after `ci-wait` PASS): if
  `main` moved after the PR's CI — `typecheck` and `test:spec` on the merge
  with a fresh `main`; code `1` — don't merge, fix the root cause; code `3` —
  `main` is red by itself: don't merge and don't fix it in my PR — the
  «`main` красный…» bug (`main` is red), wait for it to close
  (`wait-ci.sh issue <N>`) and `premerge` again. A window remains: an
  incompatibility with a PR merged during the check itself shows up as red CI
  of the next PR (it checks the merge-ref on top of a fresh `main`) — fix the
  root cause. Someone else's branch rule with strict won't merge a branch that
  fell behind — then rebase, not `gh pr merge --admin` (a bypass — only on the
  owner's direct instruction).
- **Before a push** — `git branch --show-current` (my own branch, not the local
  `main`: after a series of checkouts and rebases a push went past the PR).
- **Merge in auto mode in Claude Code — as a separate call:**
  `gh pr merge <N> --rebase` — the whole command, without `cd`, a pipeline,
  `;` or `&&`. The app's permission classifier refuses a merge without human
  review; before the classifier it is decided by the narrow rule
  `Bash(gh pr merge *)` in `permissions.allow` of the machine settings
  (`~/.claude/settings.json`), but the rule must match each part of a compound
  command separately: a part without its own rule (`gh pr view`) hands the
  whole command to the classifier. The merge result is this call's exit code:
  `0` — merged. The rule is set by the owner: the agent doesn't widen its own
  permission settings, and the project's `"auto": true` doesn't bind the
  classifier. Refused even as a separate call — there is no rule: I don't retry
  the merge or push it through in another form; `Remaining: merge — from the
  owner` (a rule in the machine settings or a word in chat).
- **After such a merge `gh pr view` isn't needed:** the merge result is the
  exit code, the merge SHA is taken by `wait-ci.sh merged <N>` (an unmerged PR
  — ERROR), `task close <N>` reads the PR itself and refuses on an unmerged one
  before any changes. `gh pr view` isn't among the app's built-in read-only
  commands — the classifier decides it, and the classifier sees the session's
  calls but not their results or the rule the merge passed by: to it, this is a
  merge without review. If a read is still needed — a narrow query as a
  separate call (`gh pr view <N> --json state`); a wider query right after the
  merge (`--json state,mergedAt,mergeCommit`) was refused as
  `[Merge Without Review]`, its retry — as `[Auto-Mode Bypass]`: after a
  refusal I don't repeat the command or get the same thing in another form —
  `Remaining: … — from the owner` (their word in chat or a rule for the command
  in `permissions.allow` of the machine settings).
- **Right after a PR merge — I delete what was merged entirely, without
  asking** (a `github task close` step): the session's checkout off the merged
  branch —
  `git fetch --prune && git switch --detach origin/main && git branch -D <branch>`,
  the remote branch — `git push origin --delete <branch>` if the host didn't
  delete it, my own worktrees and the session's temporary resources
  (databases, containers). "Merged" — by the PR
  (`gh pr view <N> --json state` = `MERGED`) or
  `git cherry origin/main <branch>`, not `git branch --merged`: after a rebase
  merge the commits in `main` have different SHAs, git doesn't see that the
  branch is merged — the session panel and `git status` call for a second PR,
  and a push from it would resurrect the deleted remote branch. I don't touch
  others' branches or worktrees of live sessions, unmerged work — never. The
  next task — a new session.
- `gh pr merge --delete-branch` from a worktree doesn't delete the local branch
  (an old gh fails with `'main' is already used by worktree`) — this isn't a
  merge error: I check `gh pr view <N> --json state`, I don't repeat the merge.
