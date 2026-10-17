# github — canon reference: GitHub project and tasks

Principles — `AGENTS.md`, section "Task tracking". Here are the rules in force
in full: how tasks are organized (types, decision labels, epics, dependencies),
the GitHub project, milestones and the five epic-refresh checks on task close;
then the details of the skill's commands — what `project check` verifies and
`project fix` does, what each `task` and `pr` command checks, sets and prints —
and the full git, PR and merge rules; at the end — manual commands for what
the skill's commands don't cover (editing an already created task and
milestones). When to call each command — `SKILL.md`; syntax —
`github <command> --help`. Examples use made-up owners and numbers.

## Task tracking — structure

- Tasks live in the project repository's **GitHub Issues** (the `github`
  skill: `task new`, `task status`, `task drop`), not in local lists,
  TODO files or the agent's built-in task list.
- **Every issue has a type** (the organization's Issue type, not a label) —
  exactly three: **Task** (the default: a unit of work for one PR), **Bug**
  (a defect: something that already exists works wrong), **Epic** (a big task
  with subtasks). There are no other types: the default Task/Bug are
  named in the project language (`issueTypes` in `locales/<language>.json`
  of the `github` skill), Feature is disabled. The type is set on creation
  (`github task new --type`); `github project fix` configures the
  organization's types. Repositories of a personal account have no types —
  there an epic gets the `epic` label; this is the only exception.
- **Decision labels** — the decision's name (folder `tests/…/<name>` or a
  model module) without a kind prefix; the kind is shown by color: capability
  green, standard blue, architecture orange; one name across different kinds
  is one label. A code task carries the label of every decision it introduces
  or changes (`github task new --labels`, from the PR diff —
  `github pr labels <PR>`; a mechanical edit — a deletion, a rename without
  changes, the decision folder's exceptions file that spec reads as an
  exception: `exceptions/*.json`, the former `exceptions.*` — doesn't change
  the decision and gives no label); no labels — only a task without code. An epic has the
  union of its subtasks' labels. `github project check` checks the set
  against the spec tree of the main branch.
- **Project slice labels** — the team's own slice of tasks (apps `web`,
  `api`, `admin`; teams), not decisions: the marker is the description
  `Slice: <slice>[ — note]` (a decision label has `Decision: …`). The name
  may coincide with a model module: then
  `project check` prints a `○` line with the slice, `fix` doesn't touch the
  label, and the decision stays without a label (the name is taken);
  `pr labels` doesn't set such a label as a decision label, `task new
  --labels api` sets it as a regular label. A slice's color is not a decision
  kind's color: a decision's kind is visible only by color.
- **A small task** — one issue of type Task or Bug.
- **A big task** — an epic + subtasks:
  - the epic is an issue of type Epic: goal, context, the agreed design,
    questions, definition of done; **no list of subtasks, their order or
    stages** — the plan is the sub-issues themselves, the order — *blocked
    by*, the stages — milestones (the epic's `Sub-issues` and
    `Relationships` show them); a copy in text goes stale with the first
    change of a link;
  - the epic has a **short prefix** (`Billing`, `Import`, `API`): the titles
    of the epic and all its subtasks start with it (`<Prefix> · <title>`),
    and it also goes into milestone names;
  - each subtask is a separate issue attached to the epic as a **sub-issue**
    (native GitHub sub-issues; `github task new --epic N`);
  - a subtask must be a complete unit of work that can be done in one PR;
  - an epic may split its plan into stages — then a stage is a milestone
    (section "Milestones — sets of tasks" below) and each subtask belongs to
    one stage; an epic without stages has no milestones.
- **Dependencies — only GitHub's built-in links** (Relationships), not text
  in the description: the parent — sub-issue (the epic), "is blocked by" —
  *blocked by*, "blocks" — *blocking*; on creation —
  `github task new --blocked-by`.
  We don't write "Depends on" / "After #N" sections. **An external
  blocker** that is an issue of another repository (an upstream bug) — also
  *blocked by*: GitHub links issues of any owner (`gh issue edit <N>
  --add-blocked-by <issue URL>`). A blocker that isn't an issue (a release, a
  PR, another tracker, a client's answer, an external deadline) — the label
  `external blocker` in the project language (`labels.externalBlocker`; not in
  the repository yet — `gh label create`) and a comment that starts with
  `External blocker:` (`comments.externalBlocker`) and gives the reason; the
  blocker is lifted — the label is removed. *Relates to* — only in the UI and
  only if the link isn't "blocks". A task with an open *blocked by* or that
  label isn't taken into work: `task queue` shows it as `○` with the blocker.
- Before creating a new task we check that it doesn't exist yet
  (`gh issue list --search`); before starting work — that it isn't already
  going in a parallel session (`AGENTS.md`, section "Git, PRs and merging").
- **Nothing native is duplicated in text:** status — only the project's
  `Status` field (section "Project (GitHub Projects)" below), links — only
  sub-issue and blocked by, a stage — only the milestone, the decisions a
  task changes — only decision labels, estimate and actual — only the fields,
  the PR — only `Closes #N`; the issue's text holds what GitHub doesn't keep
  (goal, context, the agreed design, questions, scenarios). An epic is closed
  when all its subtasks are closed.
- No GitHub repository — say so and ask where to keep tasks, rather than
  silently filing them somewhere else.

## Project (GitHub Projects)

Every repository has **exactly one** GitHub Project linked to the repo
(`github project fix`); the project name = the repository name. It holds
**all** epics and tasks of the repository — we don't create separate projects
per epic/area (an area = an epic inside the shared project). All tasks are
added to the project right on creation (`github task new`). Required:

- **Three views**, with exactly these names: `Board` (BOARD_LAYOUT, columns
  by `Status`), `Table` (TABLE_LAYOUT), `Roadmap` (ROADMAP_LAYOUT).
- **The `Status` field** with options `Backlog` → `In progress` → `Done`.
  I change the status **myself, immediately**, without waiting to be asked
  (`github task status <N> <status>`):
  - a new task — I set Backlog on creation;
  - took a task into work — I set In progress before starting the work;
  - finished (PR merged / task closed) — `github task close <N>` sets Done
    together with the actual, the epic, the milestone and removing the merged
    branches;
  - the task was reopened (the bug came back, the PR was reverted) — I set
    In progress again (or Backlog if no one is working on it); an already
    closed milestone and epic I reopen as well;
  - **closed without being done** (won't do, duplicate, replaced by other
    tasks) — I close it as not planned and **remove it from the project**
    (`github task drop <N>`): it doesn't get into Done and doesn't count in
    the epic's estimate.
  Epic: In progress when its first subtask is taken; Done when all are done
  (those closed as not planned don't count — they are no longer in the
  project).
  Safety net — the project's built-in workflows "Item added to project" →
  Backlog, "Item closed" → Done and "Auto-add to project" (new open issues of
  the repository get into the project by themselves): the status gets set
  even if there is no one to set it (a cloud session, another agent, closing
  from the GitHub UI). The agent sets the status anyway; a task closed as not
  planned it removes from the project — otherwise the workflow puts it into
  Done.
- **The `Estimate, h` field** (Number) — the agent's active hours
  (`AGENTS.md`, section "Estimate and actual — the `est` skill"). Set **only
  by `github task new`** (the `est` script inside) — from analogs with
  actuals picked by the script, not off the top of my head: for every subtask
  and small task on creation; fewer than two analogs in the repository — no
  estimate; for an epic — the sum of its subtasks' estimates, recalculated
  when a subtask is added or its estimate changes. After work starts I don't rewrite the estimate — the
  discrepancy is explained in the actual comment.
- **The `Actual, h`, `Tokens, M`, `Cost, $` fields** (Number) — the actual:
  active hours, all tokens
  of the linked model responses (input, output, cache write and read,
  including subagents) and their price at public API rates — an **API
  equivalent**: not charged on a subscription, but comparable across tasks
  and models. Filled only by `est fact --write` when the task is closed,
  never touched by hand; for an epic — the sum of its subtasks.
- **Priority — the issue's built-in `Priority` field** (an organization Issue
  field it has by default: `Urgent` → `High` → `Medium` → `Low`), **not** a
  project field of our own.
  Required on every open task: a new one gets `Medium` unless the user said
  otherwise; an epic — no lower than its most urgent open subtask. The field
  is added to the project, `Table` and `Board` are **sorted by it**; within
  a priority the order is manual. We take into work the most urgent of the
  unblocked. A personal account has no issue fields — no priority is kept.
  `github task new` sets it (`--priority`, `Medium` by default).

Nothing extra: there are no other fields (Iteration, Readiness…) or views
until they are added here. Readiness — the status and *blocked by*; stages —
milestones (the `Milestone` field).

The project — the `github` skill: `project check` once per session before
working with tasks, ❌ — `project fix`. No project — `fix` links one, copies
the template or creates one; what the API lacks (workflows, sorting) — UI
steps: the agent goes through them with the session's browser without asking
separately, without a browser — links to the user. Deleting or renaming in a
project that has already been used and changing organization settings — only
after confirmation (`fix --confirm`). What exactly `check` verifies, item by
item — section "What is checked" below.

## Milestones — sets of tasks

A milestone (a built-in repository entity) is **just a named set of tasks**
with a common goal and, if there is one, a due date; we use nothing else for
grouping (sprints, our own "Stage"/"Phase"/"Release" field). Meaning decides
the contents: plain tasks (`Release 2026-10`), whole epics (the milestone is
on the epics themselves), **an epic's stage** (a set of its subtasks).

- **Optional** for both a task and an epic: created only when a group has to
  be tracked as a whole. An epic without a stage plan has no milestones.
- **Name** of a stage: `<Epic> · <N> · <Stage name>`
  (`Billing · 1 · Data model`), `N` — the stage number in the plan (from 0 or
  from 1); a set without an epic — a meaningful name without a prefix; names
  must not be confusable. **Description** of a stage: `Epic: #<number>`; of
  another set — the goal in one or two lines.
- **An issue has only one milestone**, so we don't mix levels: subtasks go
  into their epic's stages; into a cross-cutting set (a release, a demo) we
  put the epic itself or plain tasks.
- **I set it on creation** of a task if the task belongs to a set; stage
  milestones I create together with the epic, as soon as the plan is agreed
  (later stages may be refined).
- **A stage not yet broken down** → the milestone has one stage task with a
  checklist (`<Epic> · Stage N. …`, a sub-issue of the epic, an estimate for
  the whole stage; an exception to the "one PR" rule; its items aren't issues
  yet, so the checklist isn't a copy). Decomposition: issues
  from the checklist items (the same milestone, sub-issues, with estimates),
  then the stage task — not planned and out of the project.
- **Due date** — only a real deadline (then the set shows on the roadmap).
- **I close it myself** when the set's last task is closed; I reopen it if a
  task is reopened. On task creation — `github task new --milestone`, the
  other commands — section "Manual commands" below.

## Epic refresh on task close

The task's PR is merged — right after the merge **a subagent with a fresh
context** goes through all open tasks of the same epic and brings them in line
with what shipped; the session at peak context doesn't do it itself — each of
its turns costs several times more. This is part of closing the task, not a
separate request. The refresh doesn't depend on the deploy: the subagent and
the deploy wait (`ci-wait`) run in the background in parallel,
`github task close` — after both. What needs no judgment `github task
actualize <N>` does itself: blocked by on done tasks is removed (check 4), the
`questions` label without open questions in the section (check 2), a milestone
of the epic's tasks without open tasks is closed (check 1; the task's and the
epic's own — by `task close`); its fixes — one line in a comment on the epic.
Then it prints the subagent's two-line prompt; the whole assignment — the
texts of the epic and its open tasks, the PR files, the copies of links in
text and the answers to open questions in comments the script found (named,
not edited: a line may carry meaning, a comment's numbering may be its own),
the checks by meaning 1, 3 and 5 — is printed by `task actualize <N>
--assignment`, the subagent's first call. No epic or no open tasks in it — the
line `○ refresh not needed`, no subagent. Five checks:

1. **Done is closed.** No open tasks that are already part of what shipped
   (done — I close it; lost its point — not planned and out of the project).
   Statuses and milestones match: the set's last task is closed — I close the
   milestone.
2. **Answered questions are marked.** Every already answered question in
   `## Questions` (comments, another task, code) is marked ✅ with the answer
   (`github task answer <N> <k> "<answer>"`); the numbering doesn't change —
   it is referenced. None open — the `questions` label goes (`task answer`
   and `task actualize` remove it).
3. **Descriptions don't lie.** The wording of open tasks is checked against
   the code and specs: what doesn't exist after the rollout (fields, tables,
   routes, permissions) is removed. After **a reversal of an accepted
   decision** I edit every task where it is quoted.
4. **Dependencies are real and only links.** GitHub links (sub-issue,
   blocked by) reflect the actual state: blocked by on closed tasks is
   removed, a new task is attached to the epic. Their copy in text — a list
   of subtasks in the epic, an order, "⛔" or "after #N" marks — is removed.
5. **Repetition is a standard.** A decision that, in what shipped, repeats an
   existing one in two or more places — a `Standard · …` issue
   (a rule in `tests/standards/` and a refactoring). First a search among the
   open `Standard · …`: one exists — don't file another; an extension of a
   neighboring one — a comment in it. A standard's priority — by the cost of
   the mistake it prevents; standards of one area — as an epic: otherwise
   they are born faster than they are worked off. Something deferred as "not
   in this PR" — an issue or dropped explicitly, not forgotten.

What was fixed — one comment on the epic, the history of decisions in one
place; it is the subagent's last step, always: nothing to fix — «the block is
current». The comment starts with «Refresh after #N, result:» in the project
language (`report` of the dictionary) — it is the end of the refresh for
`task close`: until it, close refuses (#571: an executor closed its task while
its refresh still ran in its worktree, the dispatcher's queue removed the
worktree, and the subagent was left without a directory).

**End of session — one line, one of three.** A missing line can't be told
from a forgotten one, so the answer always has the last line:

- **`All done. The session can be closed.`** — everything is done: the PR is
  merged; the post-merge deploy was
  awaited (where the merge deploys); `task close` passed without `!` lines;
  the epic refresh is done; there are no open questions to the user or in
  issues; proposed tasks are filed in Backlog.
- **`All done, but there are questions: …`** — the same is done, but the
  owner has something to decide beyond the
  task: whether to file a task for an observation ("your call"), whether to
  revert a setting, whether to cut a release. The questions themselves — in
  this same line, briefly, one per decision; `The session can be closed` is
  not written: with it the questions read as
  "nothing to decide".
- **`Remaining: …`** — not everything is done: what the session
  waits for and from whom (a merge from the owner, an answer to the task's
  question, a red check).

Information without a decision — a period to wait out, a warning ("didn't
make it into the release"), an observation with nothing to decide — is not a
question: it goes into the report above, and the line is
`All done. The session can be closed.`. A report of what was done (what was
merged, links to PRs and tasks) is not a question either. A session without a
task (epic planning, an investigation) ends the same way — by what it was
assigned.

**In auto mode the session archives itself at the end.** A project with
`"auto": true` in `.agents/elves.json` runs the task entirely without asking,
and closing the session is the last step left to a human: after the line
`All done. The session can be closed.` the session archives itself — as its
last action, after which the conversation ends. After the other two lines and
outside auto mode — no: an archived session leaves the list, and the owner
will no longer read the questions in its last answer. Before archiving the
session stops its own background tasks still running (a wait, a watcher over
its output, a subagent): by this line everything needed has finished, and a
live leftover blocks archiving (#437). How to archive — in the
agent's file (`claude/CLAUDE.md`); an agent without such a tool (Codex, a
cloud session) keeps the line. Archiving isn't deletion: the session can be
restored.

## Project check and fix

When to run `project check` and `project fix`, their codes — `SKILL.md`. Here —
what is checked item by item, who does what in `fix`, how to go through the UI
steps and the API's gaps the script exists for. Done by hand, projects drift
apart: somewhere "Item closed" is off, somewhere a filter hides tasks from the
board.

### What is checked

Names of views, `Status` options, fields, issue types and label markers here
and below are the `en` ones (in the project language — `locales/<language>.json`
of the `github` skill). The project language — `language` in
`.agents/elves.json` of the checkout the script runs from (until `update` moves
it — the former `.agents/ai-dev.json`; module `scripts/locale.ts`). Views,
`Status` options, fields and issue types named in another language of the
dictionary — ❌, `fix` renames them keeping the ids
(task values and the «Item closed» target survive; with tasks in the project —
after `--confirm`); a decision label with a marker in another language — its
description is rewritten.

1. The project is linked to the repository, it is the only one, its title =
   the repository name.
2. Views `Board` (BOARD, columns by `Status`), `Table` (TABLE), `Roadmap`
   (ROADMAP), filters empty, no others.
3. `Status`: `Backlog` → `In progress` → `Done`.
4. Fields «Estimate, h», «Actual, h», «Tokens, M», «Cost, $» (Number), no
   custom fields beyond the canon.
5. Organization only: `Priority` — the organization's issue field, connected,
   `Table` and `Board` are sorted by it; issue types — exactly «Task»,
   «Bug», «Epic». A personal account has none — a `➖` line.
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
   description. A decision label is recognized by the description
   `Decision: …`. A decision without a label — the label is created. A label
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
   `Slice: <slice>[ — note]`: with a decision's name — an `○` line
   with the slice, item ✅, `fix` doesn't touch it, the decision stays without a
   label. The model (`tests/architecture/model.ts`) is read by a separate
   process — if it didn't load, module labels are left alone, ❌ with the
   reason.
10. Merging into the default branch — only with green required checks: an
    active branch rule (`Ref.rules` — a repository or organization ruleset —
    or classic protection) with a non-empty list of required checks. None —
    `fix` sets the `elves` ruleset: `~DEFAULT_BRANCH`, without strict (the
    rule doesn't require an up-to-date branch), required — the checks green on
    each of the last 10 merged PRs (by the latest run; skipped or neutral
    isn't green here), bypass — the admin role (the owner's direct
    push). Its own ruleset keeps being checked: disabled, with strict or
    without bypass — fixed; under the flow's former name `ai-dev` (set by a
    `fix` before the rename to Elves) — its own too, `fix` renames it to
    `elves` with the same edit; a required check that the fresh head lacks (the
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

### fix: who does what

- **API — the script itself:** linking, a template copy or a new project,
  missing views and fields, view layout, removing a filter, `Status` options,
  the `Priority` issue field, task statuses, adding open tasks, removing tasks
  closed without being done from the project, decision labels (creation,
  color), the default-branch ruleset (creation, editing its own), merge
  methods — rebase only (REST). `+` lines.
- **UI steps** (`UI steps …`) — what the API lacks. Calling
  `fix` is permission to configure this repository's project: the agent goes
  through the steps itself, in a browser where the user is signed in to GitHub
  (Claude in Chrome or the built-in browser after they sign in), without asking
  separately. No browser or sign-in — a list of steps with links for the user.
  The agent doesn't enter a password. After the steps — `check` again.
- **Confirmation** (`Confirmation needed …`) —
  deleting and renaming in a project that already has tasks, unlinking extra
  projects, the organization's issue types (shared by all its repositories),
  deleting and renaming decision labels (they are on tasks). Show the list to
  the user, after a "yes" — `fix --confirm`. In a new project without tasks,
  deleting and renaming go without confirmation.
- **Error** — a `!` line with the reason (and a link to the UI if the step is
  done there): most often `gh` lacks a scope.

### UI steps — how to go through them

- **Workflow:** the link leads to a configured workflow
  (`<project>/workflows/<fullDatabaseId>`) or to the list `<project>/workflows`,
  where an unconfigured one is picked in the left menu. Edit → configure →
  **Save and turn on workflow**; `On` appears at the top right. In Set value
  `A value is required` — the `Status` option the workflow pointed at was
  deleted (options were replaced without ids): pick it again.
  - "Item added to project": trigger `issue, pull request` (default), Set
    value → `Status: Backlog`.
  - "Item closed": Set value → `Status: Done`.
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

### Details the script exists for

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
- **The template** — the elves project (`miroshnik/6`): everything the API
  lacks is configured there once. A copy (`copyProjectV2`) carries over views
  with their settings, fields and configured workflows, except auto-add; it
  doesn't carry over tasks, collaborators or the repository link. The template
  is unavailable (someone else's account) or `--template none` — the project is
  created from scratch (`createProjectV2`) and brought up via the API:
  `Todo / In Progress / Done` → the canon with the same ids, `View 1` →
  `Table`, the rest is created.
- **The view filter is empty:** `iteration:@current` without an Iteration field
  silently hides tasks from the board.
- **`Priority` is the organization's issue field** (`isIssueField`), not a
  project field of the same name. The API reads the sorting (`sortByFields`)
  but doesn't set it; the board grouping too (`verticalGroupByFields`).
- **A project that has been used** — it has tasks.

## Task and PR commands — details

When to call each command — `SKILL.md`; syntax — `github <command> --help`.
Here — what each one checks, sets and prints.

### task new

Without `--body` the description is a skeleton in the project
language: the scenarios and questions sections (an epic — only questions);
`--type` and `task status` take a name in any language of the dictionary. A
board in another language of the dictionary (the script runs outside the
project's checkout, the language changed without `fix`) — the task is kept in
the board's language. One `createIssue` mutation: the organization's issue type (in
a personal account an Epic gets the `epic` label, created if missing; Task and
Bug get no label there), the project, the epic (sub-issue), the milestone by
title among open ones, `Priority` in an organization (`Medium` by default).
Then `Status: Backlog` — by itself, without waiting for the workflow — and
blocked by. A subtask's title gets the epic's prefix (`<Prefix> · …`) if it
lacks it; the epic's `Priority` is raised to the subtask's if the subtask is
more urgent. Everything is checked before creating — an error (code 2) doesn't
leave a half-made task: `--epic` is an open epic, the milestone exists, the
blockers exist (closed ones are skipped), there is no open task with the same
title, the type is enabled, `Priority` is one of the options; in a personal
account `--priority` is an error. `--labels` — the task's labels in the same
mutation: a decision from the default branch — by name (`billing`), a new
decision — `kind:name` (`capability:export`, the label is `export`, the line
«new decision»: it will appear in the task's PR); no decision
label — created with the kind's color; a regular label must exist, otherwise an
error before creating. With `--epic` the decision labels are added to the epic
too (the union of its subtasks; GitHub's limit of 100 — "pr labels"). A slice label by name (`api`) is a regular task label,
not passed to the epic; `kind:name` with a slice label's name is an error
before creating: a decision with that name isn't marked by a label. A question
without ✅ in the description's questions section — the `questions` label in
the same mutation (created if missing), a `+` line names the open questions;
none open — no label. Prints `Created #N …`, `+` lines and the next step.

### The estimate — by task new itself

Like the actual in `task close`:
after creating a task or a bug it runs `est estimate <N> --type <branch type>
--write` by the est script next to it (`../est/scripts/est.ts`) and prints its
output — the script picks the analogs, the agent has no step and doesn't open the
`est` skill. `--branch-type` — the type of the task's branch (`feat fix docs
refactor perf test chore ci build research`) and of its estimate: required for
a task, a bug without it is `fix`, an epic gets none (error before creating —
an epic has no branch and no estimate of its own). Fewer than two analogs with
an actual in the repository — est prints «No estimate», the task stays without
one; est is missing — the line `○ no estimate`, failed — its error as a `!`
line; the task is created anyway (code 0). In a session with a
pinned task (`task status` below) — a second line «Next:»: the session runs
`owner/repo#N`, `#M` isn't taken here — the question to the owner «queue #M?»,
"yes" — a background subagent in its own worktree with the printed prompt (the
executor's, as in `task queue`): the session launches it at once and goes on
with its own task (#546; a session card waited for the owner's click). An
epic — instead, after the line about its estimate: once its subtasks are created,
the question «run the dispatcher on epic #M?», "yes" — `task queue
--epic M` in this session.

### task show

The task in one output instead of `gh issue view` per piece
(the description, then the epic, its subtasks, the PR and its checks): the
title and link; the type, the state if closed, `Status`, the estimate and the
actual, `Priority`, milestone and labels in one line; the epic with its open
questions and other open tasks (`- question k. …`, `- task #M «…»`); an
epic's open subtasks; open blockers; each PR with its state and its head's
checks (`checks: 2 ✅, 1 ⏳ (e2e), 1 ❌ (lint)`; skipped and neutral — ✅,
cancelled — ❌, of a check's reruns — the latest, as `ci-wait` reads it:
standard `check-run-state`; GitHub hasn't linked the PR yet
— found by the branch or «Closes #N», as `task close` does; an epic has no PR
line); the questions — open and answered numbers with the `task answer`
command; then the description as is. Read-only, one GraphQL query (plus the
recent PRs when none is linked).

### task answer

The answer at question `k` of the questions section, not
a rewrite of the description by hand (`gh issue edit --body-file`): ✅ (with
`--auto` — the auto mark, `✅ auto` in `en`) after the item's number and
`**Answer:** …` at its end — on the same line for a one-line item, otherwise
on a line of its own; est strips the answer from the description size. The
numbering and the rest of the description don't change; the answer's line
breaks become spaces. Open questions left — an `○` line with their numbers;
none — the questions label is removed. Refused before any change (code 2): no
questions section, no question `k`, the question already has ✅ (a changed
answer is edited by hand), an empty answer.

### task status

Sets `Status` (a task outside the project is added). A
subtask going In progress moves its epic from Backlog to In progress too.
Hints: the epic is closed but a subtask is in work again — reopen the epic and
its milestone; all subtasks are closed — close the epic and set it to Done.
In progress pins the task to the session: the file
`~/.config/elves/sessions/<CLAUDE_CODE_SESSION_ID>` (or in
`$ELVES_CONFIG_DIR`) with the line `owner/repo#N`. Another task In progress in
the same session — a refusal (code 2) before any changes, in one line: the
pinned task, the question to the owner «queue #M?» with its executor's prompt
(as `task new` above) and the file path. The same task again, an epic, Backlog
and Done — no refusal; a task handed out to an executor of this session (`task
queue --assignment`, below) — neither a pin nor a refusal, an `○` line: the
executor is a subagent with the session's id. No command removes the pin:
a mistaken one is removed by a human, by deleting the file. A line not of the
form `owner/repo#N` isn't a pin — for `est` and the dashboard either
(`tests/standards/session-pin`): In progress replaces it with the task, an `○`
line. `est` counts the actual by the pin: the whole session goes to this task.
No variable (not Claude Code) — the line `○ session not recognized …`, the
status is set, no guard. A dispatcher session (`task queue` below) — no pin:
the line `○ dispatcher session: #N isn't pinned …`.

### task status --branch

`task status --branch <type>/<N>-<slug>` — only with In progress, not for
an epic: the current branch of a worktree tool (`claude/<slug>-<hash>`)
becomes the task branch together with its section in `.git/config`
(upstream) — `+ branch <old> → <new>`. The name is checked by the canon before
any changes (`[<area>/]<type>/<N>-<slug>`, the slug — Latin kebab-case),
otherwise code 2. `.git/config` is shared by all worktrees of the repository,
and another checkout's git holds its lock: a bare `git branch -m` renames the
ref, not the section, with code 128, and its repeat no longer finds the old
name (#438). The script repeats the step that failed on the lock (~10 s);
still locked — a `!` line with the lock file, its age and the command that
finishes the rename, code 1; the lock isn't removed — another process holds
it. Already on the task branch — `=`; a branch already on origin (`main`, a
pushed one), a detached HEAD, a directory that isn't a checkout of the
repository — an `○` line, the branch is left alone.

### pr labels

Decision labels from the PR's changed files (API):
`tests/capabilities|standards|architecture/<name>/…` — a decision label, a code
file — the label of the model module from the PR head (the longest matching
directory), `tests/lib` and files outside modules aren't decisions. A
mechanical edit doesn't change a decision and gives no label: a deleted file,
a rename without content changes, an exceptions file of a decision folder that
spec reads as an exception (`exceptions/*.json`, the former `exceptions.*`; a
copy of the spec rule `exceptionFile`) — a decision touched only that way
comes out as an `○` line (a label is needed — set it by hand). A decision whose
name belongs to a slice label (module `web` and the app label `web`) — also an
`○` line: a slice label isn't set as a decision label. It labels the tasks from
"Closes #N" (the PR–task link; right after the PR is created GitHub hasn't set
it yet — the tasks from the PR body's keywords as GitHub understands them; none
at all — an error), creates a missing label with the kind's color; it doesn't
remove an earlier label of a decision missing from the diff — an `=` line. The
task's epic gets the same labels — the union of its subtasks; same with
`task new --epic --labels`. GitHub puts at most 100 labels on an issue, and a
mutation past that fails as a whole (#569): the room is 100 minus the labels
the task (the epic) already has. Everything fits — everything is set; it
doesn't — only the decisions whose statements the PR changes: the folder's
`<name>.md` edited in content or the folder named in the spec section of the PR
body (spec-diff output — the lists, the summary, the move, harness checks;
exceptions don't count), alphabetically, as many as fit. A codemod over every
test changes no statement: test bodies and code only — an `○` line without a
label, what didn't fit — an `○` line too; code 0. `task new --epic --labels`
has no PR yet to choose by (#574): the epic gets the task's decisions
alphabetically, as many as fit, the rest — `○` lines, code 0 — the task is
already created by then.

### pr premerge

Before merging a green PR, from a repository checkout: CI
checked the merge with the default branch as it was at the time of the run,
and without a merge queue the branch moves ahead. Didn't move — `✅ merge`,
nothing is built. Moved — the PR head (fetched by its SHA, not by
`refs/pull/<N>/head`: GitHub creates that ref up to minutes late, #505) merged
with a fresh `origin/<base>` in a temporary worktree (`git merge`, like
GitHub's merge-ref; the worktree is always removed), dependencies by the
merge's lockfile (the manager — `packageManager`, otherwise the lockfile,
otherwise `.yarnrc.yml` — Yarn, otherwise npm,
`tests/standards/package-manager`; the install —
`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`,
`yarn install --frozen-lockfile`, `npm ci`; no lockfile — no install) and the
project's fast checks — the `package.json` scripts that exist, in CI order
until the first red: `typecheck` (a semantic conflict of two PRs: one removed a
function, the other calls it — seconds, #292), then `test:spec` — standards and
architecture, where two green PRs break ("registry + invariant"), not the
whole `test`. None of them — an `○` line, merge. The merge has `tests/standards`
or `tests/architecture` but no `test:spec` — an `○` line that they aren't
checked on the merge, with a pointer to the project's `check` (it requires the
script and names the line, #442); the merge isn't stopped. GitHub doesn't store what CI
checked, so "moved" is judged by time (REST): the earliest check suite of the
PR head against the branch's last event (Activity API); an event within a
minute before the check suite also counts as moved (the merge-ref is built
earlier); no checks or the event wasn't read — it is checked. Codes: `0` —
merge; `1` — don't merge: red `typecheck` (compiler errors), `test:spec`
(lines of failed tests) or a conflict (files) — fix the root cause in the PR:
rebase onto `origin/<base>`, edit, `push --force-with-lease`, `ci-wait` again;
`2` — couldn't check (not a checkout, PR not open, the PR head not on origin,
dependency install failed) —
don't merge either, investigate; `3` — **`main` is red, not this PR**.

### Red main — code 3

The merge is red (#282) — the failed check is also run on bare
`origin/<base>` in its own temporary worktree: red with the same — code `3`;
the PR breaks beyond it (failed tests and compiler errors of the merge that
aren't on `main`, ignoring run time and position in the file) — code `1` with
them. A red check on the default branch's last commit — a check-run (the last
run of each name: `failure`, `timed_out`, `startup_failure`; a cancelled one
isn't red) or a host status (`failure`, `error`) — the same code `3` before
checking the merge; checks not read — an `○` line, the check goes on. The spec
publish job (`spec-publish`, `<job> / spec-publish`) isn't a check of `main`:
red, it is an `○` line and not counted (#443). With
code `3` the session doesn't merge and doesn't fix it in its PR: one bug for
everyone — an open issue titled «`<base>` is red…» (REST
search) that names the failed check (or script) — the whole name: `test` isn't
in "test:spec" (#338); open ones about another check — the line
`○ … about another check: don't wait`. Found — a
line with the number and the wait command `wait-ci.sh issue <N>` (the `ci-wait`
skill, as a background command: its completion wakes the session), then
`premerge` again; for a failed check that none of them names — a hint to find
an open bug on the failed test (under another title) or the command
`task new --type Bug` with the title
«`<base>` is red: <check | typecheck | test:spec>» (`--priority Urgent` in an
organization; add the failed test's decision label), the question to the owner
whether to queue the bug and the same wait. A PR that closes any open «`<base>` is red…» bug (`Closes #N`
in the body) is a fix, without matching the check: the same breakage is named
by a script one time and by a CI check another; a red `main` doesn't stop it
(an `○` line), its red merge is code `1`, as usual.

### task resume

A background wait (`ci-wait`) dies with the app's process,
and a session resumed after a restart doesn't know it (#433). The command reads
the task pinned to the session (`task status` above; the repository is in the
pin, not the checkout) and its PRs — linked, otherwise by the task branch, as in
`task close`: an open PR — `wait-ci.sh pr <PR>` as a background command; only a
merged one and the task is open — `wait-ci.sh merged <PR>` where the merge
deploys, then `task close N`; no PR or the task is closed — an `○` line; no pin
— nothing, without a request to GitHub; a line not of the form `owner/repo#N` —
an `○` line with the file path, code 0. Read-only. The Claude Code
`SessionStart` hook runs it with the session id from its input (`check
--hook`, `claude/CLAUDE.md`) — the machine's skill, otherwise the project's. In a
dispatcher session — or one with its own task and executors (#546) — it first
says to continue the stopped executors (#528):
they stopped with the app's process, their transcripts are intact, and the
app names them in its notification — each is continued with `SendMessage` by
its id, with its context in its own worktree (the task branch, uncommitted
work), then the queue command, if the session ran one; the hand-outs
(`dispatchers/<id>.tasks`, "task queue") stay; then its own task's wait. A new executor — only for one that can't be continued, with the
same prompt: a task In progress it continues in the worktree of its branch
(the assignment's restart line), not in a new one — git won't give the branch
to a second worktree.

### task queue

A dispatcher: "do all tasks of epic #M", "fix all
High bugs", the owner's "yes" to «run the dispatcher on epic #M?» (`AGENTS.md`,
"Session and branch — one task") — any session: one with its own task keeps it
pinned, its task is `=` in the queue (#546). The script prints the queue — ready tasks (open, not an epic, not in
work, no open blockers — another repository's named `owner/repo#N` —, no
`external blocker` label — its line has the reason from the latest
`External blocker: …` comment) by `Priority`, then number, each with an indented
line — its executor's prompt, «Task #N …» in the project language (`est` links
the subagent's work by it); then `=` lines — in work: In progress, an open PR
(linked, or by the task branch and "Closes #N" among recent PRs) with its link,
handed out to an executor of this session; `○` lines — not ready
with the reason, and `Next:`. Before the queue, in the repository's checkout,
it removes what finished executors left (#515): an agent's worktree
(`.claude/worktrees/agent-*`) detached or on a `worktree-agent-*` branch, not
locked by a live process (Claude Code locks a running agent's worktree; a lock
whose pid is gone doesn't hold), clean and without commits outside
`origin/<base>` by `git cherry` — removed with its branch, a `+` line;
uncommitted changes or unmerged commits — left, an `○` line with the reason; a
`worktree-agent-*` branch without a worktree — the same by its commits. A
session's worktree, an agent's on a task branch and an executor's whose
handed-out task is open — untouched, no line (#533): Claude Code unlocks the
worktree when the agent ends its answer, a question too, and doesn't lock it
again for an executor continued with `SendMessage` after a restart. An agent's
worktree a subagent of it works in without a worktree of its own — left, an
`○` line naming the subagent (#571: the executor closed its task and answered,
its epic refresh still ran in its directory, and the queue removed it): such a
subagent — `parentAgentId` without its own `worktreePath` in Claude Code's
subagent metadata of this session and of the sessions with hand-outs
(`dispatchers/*.tasks`), at any depth; at work — its transcript
(`agent-<id>.jsonl`) written in the last 15 minutes.
A session started to dispatch works in the project folder, not a worktree
(#588): the app starts a cloud session from the branch in the starting
session's record (`get_session` → `branch`), not from git — a session from
the app's worktree has its `claude/<slug>-<hash>` there, never pushed, and the
clone fails with «The requested branch or commit was not found», a detached
checkout too; a session in the project folder has none — `main`. In the app's
worktree (`.claude/worktrees/<name>`, not `agent-*`) the queue prints a `!`
line with the project folder and still goes, code 0: subagent executors
branch from origin/main in their own worktrees.
`--epic N` — the epic's open sub-issues,
otherwise the repository's open tasks (the first 100 of the search);
`--type`, `--priority` — only in an organization. It marks the session as a
dispatcher — `dispatchers/<CLAUDE_CODE_SESSION_ID>` in the configuration
directory with the queue command: the executors are subagents with the
session's id, a pin would refuse the second and give `est` the whole session as
one task. `--assignment N` —
read-only on GitHub, the executor's first call; in any session (not one pinned
to `N`: that task is its own) it records the task as handed out — a line
`owner/repo#N <worktree>` (the checkout the assignment is called in) in
`dispatchers/<id>.tasks`: a session with its own task, or none yet, launches an
executor on the owner's "yes" too (#546), and unrecorded, the executor's In
progress would be refused by the session's pin or would pin the session to its
task. `task status` doesn't pin a handed-out task; `est` gives a subagent with
«Task #N» in its assignment to task N, not to the session's pin. A hand-out is
`=` in the queue for the whole session (an
executor's answer leaves the task not ready either: merged closes it, a question
waits for the owner, waits for subagents — the same executor answers again,
failed isn't restarted; after the app restarts the executor
is continued, "task resume"). The assignment: the task by the canon in auto mode, a
restart line only for an In progress task with a branch `*/N-*` in the
checkout or on its origin (it names the branch; the branch checked out in
another worktree — work there, in Claude Code `EnterWorktree` with its path,
not in a new one), and what a subagent does
otherwise — doesn't rename or archive the session and writes no last line,
waits for CI and the deploy with regular calls
(`wait-ci.sh … --timeout 540`: a background command doesn't wake a subagent, a
Bash call lives 10 minutes), git in separate calls, writing subagents — as
needed, without a limit (the limit of 3 is on executors), each in its own
worktree with «Task #N» at the start of its prompt, their worktrees and
branches removed by the executor after the merge, no answer while any of its
subagents works (#565: an answer with live subagents reads as a failure — the
executor of #545 answered failed, its subagents' answers woke it, and it merged
the task while a second executor, launched on the owner's restart, worked on the
same branch), found work — `task new`,
named in the answer (whether to queue it is the owner's call); the answer — one
line: merged, a question, waits for subagents (it can't wait — not a failure) or
failed.

A restart is a new executor on a task handed out before or on a task branch:
its `--assignment` refuses (code 1, no hand-out) while the previous executor or
its subagent is alive — `!` lines with each live worktree, and the answer
«waits for the previous executor». The previous executor's worktrees — its
hand-outs of the task in any session's `dispatchers/*.tasks` and a worktree on
the task branch, the caller's own aside; its subagents' (`agent-<id>`) — by
`parentAgentId` of Claude Code's subagent metadata
(`projects/<directory>/<session id>/subagents/agent-<id>.meta.json` in its
configuration directory), at any depth. Alive — locked by a live process, a
subagent without a worktree of its own at work in it (above), or HEAD moved (a commit, a switch) in
the last 15 minutes: Claude Code doesn't lock the worktree of an agent continued
after its answer, and the woken executor of #545 worked unlocked; the wait for CI
is a Bash call of up to 9 minutes without commits.

In Claude Code: an executor — `Agent` with `isolation: "worktree"` and
`run_in_background: true`, the prompt — the indented line as is; at most 3
subagents and 5 cloud sessions at once, the owner's number replaces either
(subagents share the machine, `slot` runs two heavy checks; a cloud session
has its own container); a task in work (`=`) isn't launched again.
Before each launch — `get_usage`: the 5-hour limit at 85% and more — no new
executors, the running ones finish, then `Remaining: N tasks, the limit`. An
answer arrives as the subagent's notification; after each — `task queue`
again. A question — to the owner in text; the answer — ✅ in the task's
questions section and to the same executor with `SendMessage` (its context is
intact). Waits for subagents — no restart: its subagents' answers wake it, and it
answers again. Failed — a comment in the task with what stopped, no restart; the
owner's restart — the refused assignment's «waits for the previous executor» —
wait for the previous executor's answer, not a third executor; failed
on an external blocker — it's recorded ("Dependencies" above), and the queue
stops giving the task out until it's lifted. Queue
empty and nothing running — the summary (merged, questions, not ready, new
tasks outside the queue), the last line and, in auto mode, archiving; a session
with its own task — after it. A running executor isn't stopped (`TaskStop`) to
archive the session: its answer comes first. The app's
child sessions (`start_session`) aren't given out yet (a server flag); when
they are, an executor becomes a session.

### task drop

Closes as not planned (with `--duplicate-of` — as a
duplicate with a link) and removes it from the project: otherwise "Item closed"
would put it in Done and into the epic's estimate. It doesn't touch a completed
one. A subtask — a hint to recalculate the epic's estimate.

### task actualize

The epic refresh, right after the merge: it doesn't
depend on the deploy and runs in parallel with it, while the session at peak
context neither assembles the assignment nor reads `reference.md`. The
mechanics — itself, `+` lines (#435: the subagent collected it with ~35 calls
a run): blocked by on done tasks (closed, or this one with its PR merged) is
removed, the `questions` label without open questions in the section, a
milestone of the epic's tasks without open tasks is closed (the task's and the
epic's — by `task close`); the fixes — one line in a comment on the epic. Then
the subagent's prompt — the two lines after `Next:`, pass them as is: «Task #N
(epic #M)» (`subagentPrompt` of the dictionary; `est` links the subagent's
work to the task by it in any language) and the command of its whole
assignment, `task actualize N --assignment` — read-only, the subagent's first
call, outside the sandbox: the texts of the epic and its open tasks (its
sub-issues, not a list in its description) and the PR files run to tens of KB,
and the session would copy them into the subagent call as output tokens. In
the assignment, in the project language: the task and its merged PR (the link,
otherwise the branch or "Closes #N" among recent PRs) with its files, the epic
and its open tasks with their texts, the copies of links in text and the
answers to open questions in comments (`k. ✅ …`) the script found — named, not
edited, the checks by meaning 1, 3 and 5 from section "Epic refresh on task
close", what may be changed (only GitHub tasks; the task, the epic and their
milestone are closed by `task close`), the result — always a comment on the
epic «Refresh after #N, result: …», «the block is current» too (`task close`
waits for it) — and the answer form. No epic, or no open tasks in the epic other than
this one — the line `○ refresh not needed`, no subagent. The order after the
merge — fewer turns (measurement #285: the extra
turns were `gh pr view` for the SHA and reading the wait result): in one turn,
as separate calls, — `task actualize N` and a background
`wait-ci.sh merged <PR>` (where the merge deploys or runs CI on `main`; the
script takes the merge SHA from the PR itself), in Claude Code — also
`ToolSearch` for the `archive_session` schema if it isn't loaded yet; next — in
the background the subagent with the assignment, if a refresh is needed; a wait
notification with code 0 — `task close N` right away, don't read the output
file (not 0 — the `RESULT:` line in it); the subagent hasn't reported yet —
close refuses before any change: close again after its answer; then the last
line of the answer and archiving — in one turn.

### task close

The closing ritual in one call, not a step per turn at the
session's largest context. Only after the task's PR is merged (or a close
without a PR): a PR that is open or closed without a merge — an error before
any changes. GitHub sometimes doesn't link a merged PR to the task for hours —
then the task's PR is searched among the default branch's recent PRs by the
branch `<type>/<N>-<slug>` and "Closes #N" in the body: merged — the task is
closed with the comment «Closed by PR #M: GitHub didn't link the PR to the
task», none — a refusal
listing what was checked (no manual `gh issue close` needed). The epic has
open tasks besides this one and no report of the refresh on it — a comment
with «Refresh after #N, result:» in any language of the dictionary, case and
markup aside; the script's own «Refresh after #N, script: …» comes before the
subagent and isn't it — a refusal before any changes, with what to do: the
subagent is at work — wait for its answer, it wasn't launched — `task
actualize N`, it answered without the comment — post it (#571). Order:
close the task if the merged PR didn't; a task of the scripts' own repository
(Elves) — the scripts' clone (the checkout the est script is in) catches up
with the merged `main`: `git pull --ff-only origin main`, the line
`+ clone <dir> <a> → <b>` (already there — `=`); a dispatcher's executors call
the clone's scripts, and nothing else updates it during a session; on another
branch or with uncommitted changes to tracked files — an `○` line, not touched
(untracked files don't count), a failed pull — a `!` line, the actual is by
the clone's code; another project's task, or the est script not in a git
checkout — no step; the actual — `est fact <N> --write` by
the est script next to it (`../est/scripts/est.ts`; missing — the line
`○ actual unavailable`, failed — its error as a `!` line, the
rest is done); `Status` Done; the last sub-issue closed — the epic is closed
and gets Done; no open tasks left in the task's (and the epic's) milestone —
the milestone is closed (REST); the task's stacks (the `task-env` skill) —
`task-env down <N>` by the script next to it (`../task-env/scripts/task-env.ts`;
missing — the line `○ task stacks: task-env is not installed`) in the
checkout: the dev and e2e stacks `<project>-<N>` and `<project>-<N>-e2e` go
with their volumes, its lines (`+`, `○`, `!`) are printed as is; no compose
file in the checkout — an `○` line, Docker isn't called; a failure — a `!`
line, the rest is done, and `task-env prune` finds the stack later; the merged
branches — per the "Right after a PR merge" item of section "Git, PRs and
merging — full rules" below: the branch of every merged PR of the task —
linked or found by the branch and "Closes #N", as above: a follow-up fix to a
merged PR is the same task, and GitHub doesn't link it — and the checkout's
task branch; the checkout moves off a removed branch to `origin/<base>`
detached, the local and remote branches are deleted; a branch without a
merged PR is merged only by `git cherry`; not merged or someone else's — an
`○` line, nothing is touched. The directory
isn't a checkout of the repository — neither stacks nor branches are touched
(an `○` line: both are named by the checkout's `origin`); a checkout — the
`owner/repo` of its `origin` equals the task's repository, case aside, not a
URL substring: `elves-tools` isn't a checkout of `elves` (standard
`origin-repo`, the same for `pr premerge`). The command doesn't delete the
session's worktree — the `Next` hint; an agent's (`.claude/worktrees/agent-*`,
a dispatcher's executor) — an `○` line: the dispatcher's next `task queue`
removes it. `--no-git` — without the git step, the
stacks still go. The last output line — the end-of-session steps: the last
line of the answer, one of three
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

## Git, PRs and merging — full rules

Principles — `AGENTS.md`, section "Git, PRs and merging"; here — the full
rules (the short form — `SKILL.md`, "Git, PRs and merging — mechanics").
Waiting for checks, the full SHA and a merge that deploys —
`docs/pr-checks.md`.

- **Merge — rebase only:** `gh pr merge <N> --rebase`; other methods in the
  repository are turned off by `project fix` (item 11 of section "What is
  checked"). The branch's commits themselves land in `main` — each a
  conventional commit with `Refs #N`.
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
  «`main` is red…» bug, wait for it to close
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
  delete it, the task's Compose stacks with their volumes (`task-env down
  <N>`), my own worktrees and the session's other temporary resources.
  "Merged" — by the PR (`gh pr view <N> --json state` = `MERGED`) or
  `git cherry origin/main <branch>`, not `git branch --merged`: after a rebase
  merge the commits in `main` have different SHAs, git doesn't see that the
  branch is merged — the session panel and `git status` call for a second PR,
  and a push from it would resurrect the deleted remote branch. I don't touch
  others' branches or worktrees of live sessions, unmerged work — never. The
  next task — not in this session.
- `gh pr merge --delete-branch` from a worktree doesn't delete the local branch
  (an old gh fails with `'main' is already used by worktree`) — this isn't a
  merge error: I check `gh pr view <N> --json state`, I don't repeat the merge.

## Manual commands

What the skill's commands don't cover: editing an already created task and
milestones.

### Issue types

In an organization `project fix --confirm` checks and configures the types
(Task, Bug and Epic named in the project language, Feature disabled; needs the
`admin:org` scope). A personal account has no types — an epic is marked with
the `epic` label.

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/<N> -f type=Bug     # change the type
gh issue list --json number,issueType --jq '.[]|select(.issueType.name=="Epic")'
```

### Priority on an existing task (organization)

```bash
# ids of the field and its options
gh api graphql -f query='{organization(login:"<org>"){issueFields(first:10){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}'
# set it; issueId — the issue's node_id
gh api graphql -f query='mutation{setIssueFieldValue(input:{issueId:"<node_id>",issueFields:[{fieldId:"<field id>",singleSelectOptionId:"<option id>"}]}){issue{number}}}'
# read: issue.issueFieldValues{nodes{... on IssueFieldSingleSelectValue{field{... on IssueFieldSingleSelect{name}} name}}}
```

### Subtasks and dependencies on an existing task

```bash
SUB_ID=$(gh api repos/{owner}/{repo}/issues/<subtask> --jq .id)     # id, not the number!
gh api repos/{owner}/{repo}/issues/<epic>/sub_issues -X POST -F sub_issue_id=$SUB_ID
gh api repos/{owner}/{repo}/issues/<epic>/sub_issues                # list of subtasks
BY_ID=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)      # id, not the number!
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by -X POST -F issue_id=$BY_ID
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by      # who blocks N
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocking        # whom N blocks
gh api -X DELETE repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by/$BY_ID
```

### Milestones

```bash
gh api -X GET repos/{owner}/{repo}/milestones -f state=all           # list
gh api repos/{owner}/{repo}/milestones -f title="Billing · 1 · Design" -f description="Epic: #42"
gh issue edit <N> --milestone "Billing · 1 · Design"
gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed
```

### Numeric project fields

`Estimate, h`, `Actual, h`, `Tokens, M`, `Cost, $` are set only by the
`est` script (`github task new` and `task close` run it). By hand — only an epic's `Estimate, h`, the sum of its subtasks'
estimates:

```bash
gh project item-edit --id <item-id> --project-id <project-id> --field-id <estimate-field-id> --number 4.5
```

Project, field and option IDs — `gh project view` / `gh project field-list`
(in the JSON of `gh project item-list` the keys of Cyrillic-named fields are
garbled — don't rely on them; `est` finds fields by exact name via GraphQL).
