# github — canon reference: GitHub project and tasks

Principles — `AGENTS.md`, section "Task tracking". Here are the rules in force
in full: how tasks are organized (types, decision labels, epics, dependencies),
the GitHub project, milestones and the five epic-refresh checks on task close;
at the end — manual commands for what the skill's commands don't cover
(editing an already created task and milestones). Creating a task, status,
closing — `task new`, `task status`, `task actualize`, `task close`,
`task drop` (`SKILL.md`). Examples use made-up owners and numbers.

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
  exception: `exceptions/*.json`, `names.exceptions/*.json`, the former
  `exceptions.*` and `names.exceptions.*` — doesn't change the decision and
  gives no label); no labels — only a task without code. An epic has the
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
  - the epic is an issue of type Epic: goal, context, plan (by stages, if
    there are any), definition of done;
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
  We don't write "Depends on" / "After #N" sections; a dependency that isn't
  an issue (a client's answer, an external deadline) — we file a task for it
  or write it in "Context". *Relates to* — only in the UI and only if the
  link isn't "blocks". A task with a non-empty *blocked by* isn't taken into
  work until its blockers are closed.
- Before creating a new task we check that it doesn't exist yet
  (`gh issue list --search`); before starting work — that it isn't already
  going in a parallel session (`AGENTS.md`, section "Git, PRs and merging").
- Status is kept only in the project's `Status` field (section "Project
  (GitHub Projects)" below), nothing is duplicated in the issue itself; a PR
  is linked to its task (`Closes #N`); an epic is closed when all its
  subtasks are closed.
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
    branch;
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
  via the `est` skill** — from analogs with actuals, not off the top of my
  head: for every subtask and small task on creation; for an epic — the sum
  of its subtasks' estimates, recalculated when a subtask is added or its
  estimate changes. After work starts I don't rewrite the estimate — the
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
item — `SKILL.md`, section "What is checked".

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
  the whole stage; an exception to the "one PR" rule). Decomposition: issues
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
`github task close` — after both. The whole assignment for the subagent — the
task and its PR, the epic, its open tasks, the five checks below — is printed
by `github task actualize <N>`; no epic or no open tasks in it — the line
`○ refresh not needed`, no subagent. Five checks:

1. **Done is closed.** No open tasks that are already part of what shipped
   (done — I close it; lost its point — not planned and out of the project).
   Statuses and milestones match: the set's last task is closed — I close the
   milestone.
2. **Answered questions are marked.** Every already answered question in
   `## Questions` (comments, another task, code) is marked ✅ with the answer;
   the numbering doesn't change — it is referenced. None open — I remove the
   `questions` label.
3. **Descriptions don't lie.** The wording of open tasks is checked against
   the code and specs: what doesn't exist after the rollout (fields, tables,
   routes, permissions) is removed. After **a reversal of an accepted
   decision** I edit every task where it is quoted.
4. **Dependencies are real.** GitHub links (sub-issue, blocked by) reflect
   the actual state: blocked by on closed tasks is removed, a new task is
   attached to the epic, "⛔" marks in the text match the links.
5. **Repetition is a standard.** A decision that, in what shipped, repeats an
   existing one in two or more places — a `Standard · …` issue
   (a rule in `tests/standards/` and a refactoring). First a search among the
   open `Standard · …`: one exists — don't file another; an extension of a
   neighboring one — a comment in it. A standard's priority — by the cost of
   the mistake it prevents; standards of one area — as an epic: otherwise
   they are born faster than they are worked off. Something deferred as "not
   in this PR" — an issue or dropped explicitly, not forgotten.

What was fixed — one line in a comment on the epic: the history of decisions
in one place.

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
`"auto": true` in `.agents/ai-dev.json` runs the task entirely without asking,
and closing the session is the last step left to a human: after the line
`All done. The session can be closed.` the session archives itself — as its
last action, after which the conversation ends. After the other two lines and
outside auto mode — no: an archived session leaves the list, and the owner
will no longer read the questions in its last answer. How to archive — in the
agent's file (`claude/CLAUDE.md`); an agent without such a tool (Codex, a
cloud session) keeps the line. Archiving isn't deletion: the session can be
restored.

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
`est` skill. By hand — only an epic's `Estimate, h`, the sum of its subtasks'
estimates:

```bash
gh project item-edit --id <item-id> --project-id <project-id> --field-id <estimate-field-id> --number 4.5
```

Project, field and option IDs — `gh project view` / `gh project field-list`
(in the JSON of `gh project item-list` the keys of Cyrillic-named fields are
garbled — don't rely on them; `est` finds fields by exact name via GraphQL).
