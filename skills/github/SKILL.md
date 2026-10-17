---
name: github
description: "GitHub project and tasks by the AGENTS.md canon in one command — `project check` and `project fix` (the project, the default-branch rule, rebase-only merge); `task new` (a task with all its fields and the estimate); `task show` (not `gh issue view`) and `task answer` (not `gh issue edit`); `task status`, `task drop`; `task actualize` and `task close` after a merge; `task queue` for a dispatcher session; `pr labels`, `pr premerge` (a red PR or a red base). When — once per session before task work; creating a task or subtask; a PR opened, green or merged; taking, reading, finishing, reopening or cancelling a task; an answer to a task's question; 'do all tasks of epic #M', 'fix all High bugs'; asked whether the project is set up, why a task isn't in Done or on the board, why GitHub won't merge a PR — even if 'project' and 'task' weren't said."
allowed-tools: Bash(bun *skills/github/scripts/github.ts *) Bash(git remote get-url *)
---

# github — project and tasks by the canon, not from memory

Principles — `AGENTS.md`, section "Task tracking"; the full rules (types,
decision labels, epics, dependencies, the project, milestones, the five
epic-refresh checks) and what each command below checks, sets and prints —
`reference.md` next to this file. Done by hand from the reference, projects
drift apart and a task gets created without a status, priority or epic link.
The script `scripts/github.ts` next to this file checks the project
against the canon, fixes what the API can, and does each task step in one
command; the agent goes through the UI steps and asks for confirmation on
anything destructive. Syntax and a summary of a command —
`github <command> --help`. Editing an existing task (Priority, links) and
milestones — `reference.md`, section "Manual commands".

**In Claude Code — at once a separate unsandboxed call**
(`dangerouslyDisableSandbox`): `gh` fails on TLS in the sandbox, `task close`
also calls Docker for the task's stacks — the sandbox denies its socket, and
no `excludedCommands` entry takes a script run by `bun` out — checked with
`bun <path>/github.ts project check` too (`claude/CLAUDE.md`; `SKILL.md` of the
task-env skill, "Checked on the machine").

## Project — check and fix

```bash
bun --no-env-file <skill dir>/scripts/github.ts project check [--repo owner/repo]
bun --no-env-file <skill dir>/scripts/github.ts project fix [--repo owner/repo] [--confirm] [--template owner/N | none]
```

The repository — from `git remote get-url origin` or `--repo`, under its
current name: a renamed repository's former name resolves to it. Needs `gh` with
the `project` scope (`gh auth refresh -s project`); the organization's issue
types — `admin:org`.

| Moment | Action |
|---|---|
| Session start, before working with tasks | `project check` — once per session |
| `check` gave ❌ | `project fix` → UI steps → confirmations → `check` again |
| Repository without a project | `project fix`: links the owner's project of the same name, otherwise copies the template, otherwise creates one |
| Cloud session | `task show`, `task answer`, `task new` — REST, no project (`docs/cloud-sessions.md`); others — code 2 |

Codes: `0` — everything per the canon (for `fix` — and no steps left), `1` —
there are ❌, steps or errors, `2` — a call or access error, or a cloud session.

`fix` prints `+` lines — done via the API; **UI steps** — calling `fix` is
permission to configure this repository's project: the agent goes through the
steps itself, in a browser where the user is signed in to GitHub, without
asking separately; no browser or sign-in — a list of steps with links for the
user; the agent doesn't enter a password; after the steps — `check` again;
**Confirmation needed** — show the list to the user, after a "yes" —
`fix --confirm`; `!` — an error with the reason, most often `gh` lacks a
scope. The eleven items checked, who does what, how to go through the UI steps
and the API's gaps — `reference.md`, "Project check and fix".

## Tasks and PRs

```bash
bun --no-env-file <skill dir>/scripts/github.ts task new --title "…" --branch-type <type> [--body-file F | --body "…"] [--type Task|Bug|Epic] \
    [--epic N] [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low] \
    [--labels <decision>,<kind>:<new decision>,<label>] [--repo owner/repo]
bun --no-env-file <skill dir>/scripts/github.ts task show <N>
bun --no-env-file <skill dir>/scripts/github.ts task answer <N> <k> "<answer>" [--auto]
bun --no-env-file <skill dir>/scripts/github.ts task status <N> "In progress" [--branch <type>/<N>-<slug>]   # Backlog | In progress | Done
bun --no-env-file <skill dir>/scripts/github.ts task drop <N> [--duplicate-of M]
bun --no-env-file <skill dir>/scripts/github.ts task actualize <N>
bun --no-env-file <skill dir>/scripts/github.ts task close <N> [--no-git]
bun --no-env-file <skill dir>/scripts/github.ts task resume
bun --no-env-file <skill dir>/scripts/github.ts task queue [--epic N] [--type Task|Bug] [--priority Urgent,High]
bun --no-env-file <skill dir>/scripts/github.ts task queue --assignment <N>
bun --no-env-file <skill dir>/scripts/github.ts pr labels <PR>
bun --no-env-file <skill dir>/scripts/github.ts pr premerge <PR>
```

| Moment | Action |
|---|---|
| New task, an epic's subtask, an epic | first — whether one already exists (`gh issue list --search`); `task new --branch-type <type>` — it sets the estimate itself (an epic isn't estimated: its estimate is the sum of its subtasks, `reference.md`) |
| Took into work · reopened | `task show N` — the task, its epic's open questions and tasks, the PR, in one call; a task without an estimate (created in the GitHub UI) — first `est estimate N --type <branch type> --write`; `task status N "In progress" --branch <type>/N-<slug>` — a separate call, no pipeline (`tail` hides the refusal code): it renames the worktree tool's branch into the task branch |
| An answer to a question (chat, a comment, the code; in auto mode — the recommendation) | `task answer N k "<answer>"` (auto — `--auto`), before the code it changes |
| PR merged | in one turn — `task actualize N` and in the background `wait-ci.sh merged <PR>` (it takes the merge SHA itself); a refresh is needed — next turn, in the background, a subagent with the printed two-line prompt; after both — `task close N` (exit code 0 from the wait — right away, don't read the output) |
| Task closed without a PR | `task actualize N`, the subagent; then `task close N` |
| Session resumed after the app restarted | the `SessionStart` hook runs `task resume` itself — its line is in the context: run the named command, a background wait died with the process |
| "Do all tasks of epic #M", "fix all High bugs", a new epic — the owner's "yes" | the session is a dispatcher, its own task stays: `task queue --epic M` (or `--type`, `--priority`), executors — background subagents; below, "Dispatcher" |
| Another task: work outside the task, a red-main bug, a flow copy's move | `task new`, then the question to the owner «queue #N?»; "yes" — its executor at once, the same as a dispatcher's (`task new` and `task status` in a session with a task print its prompt) |
| Won't do, duplicate, replaced by others | `task drop N [--duplicate-of M]` |
| PR ready (and after new commits) | `pr labels <PR>` — decision labels for the task and the epic |
| PR's CI green (`ci-wait` PASS), before `gh pr merge` | `pr premerge <PR>` — a separate call; code `0` — merge, `3` — `main` is red: don't merge, wait for the bug |

What the agent gets wrong without the details (all of them — `reference.md`,
"Task and PR commands"):

- **`task new`** — `--branch-type` (`feat fix docs refactor perf test chore
  ci build research`) is required for a task, a bug without it is `fix`, an
  epic gets none. The estimate — `task new` itself: the agent has no step and
  doesn't open the `est` skill.
  `--labels`: a decision from the default branch — by name (`billing`), a new
  decision — `kind:name` (`capability:export`), a regular or slice label — by
  name, it must exist. The `questions` label — `task new` itself, when the
  description has a question without ✅. Everything is checked before
  creating: an error (code 2) leaves no half-made task.
- **`task answer`** — not a rewrite of the description by hand
  (`gh issue edit --body-file`); a question that already has ✅ is refused — a
  changed answer is edited by hand.
- **`task status`** — In progress pins the task to the session: another task
  In progress in the same session is refused (code 2) with the question
  «queue #M?» and its executor's prompt; a task handed out to an executor of
  this session isn't pinned; a mistaken pin — a human deletes its
  file. `--branch` — only
  with In progress, not for an epic; it renames the branch together with its
  `.git/config` section — not a bare `git branch -m`; the lock still held —
  a `!` line with the command that finishes the rename, code 1.
- **`pr premerge`** — from a repository checkout. Codes: `0` — merge; `1` —
  don't merge: fix the root cause in the PR (rebase onto `origin/<base>`, edit,
  `push --force-with-lease`, `ci-wait` again); `2` — couldn't check: don't
  merge either, investigate; `3` — **`main` is red, not this PR**: don't merge
  and don't fix it in the PR — one bug for everyone: the printed wait
  `wait-ci.sh issue <N>` (the `ci-wait` skill, as a background command), or
  the printed `task new --type Bug` command and «queue it?», then `premerge` again
  (`reference.md`, "Red main").
- **`task actualize`** — right after the merge, in parallel with the deploy:
  the mechanics itself, then the subagent's prompt — the two lines after
  `Next:`, pass them as is; its assignment the subagent prints itself
  (`task actualize N --assignment`, outside the sandbox). `○ refresh not
  needed` — no subagent. In Claude Code in the same turn — also `ToolSearch`
  for the `archive_session` schema if it isn't loaded yet.
- **`task close`** — only after the PR is merged (or a close without a PR):
  an open PR is refused before any changes, a merged PR GitHub didn't link is
  found by itself — no manual `gh issue close`. Refused until the refresh
  subagent reports on the epic. A wait with a code other than
  0 — the `RESULT:` line in its output file. It doesn't delete the session's worktree; `--no-git`
  — without the git step. Its last output line — the end-of-session steps;
  then the last line of the answer, one of three (wording in the project
  language — `AGENTS.md`, "Language"): `All done. The session can be closed.`;
  the owner has something to decide — `All done, but there are questions: …`
  with the questions themselves; something remains — `Remaining: …`. In auto
  mode after the first — archiving the session where the agent has the tool,
  after the other two — no; information without a decision isn't a question.
  A cloud session — a refusal (`docs/cloud-sessions.md`).

### Dispatcher

"Do all tasks of epic #M", "fix all High bugs", a "yes" to «run the
dispatcher on epic #M?» (`AGENTS.md`, "Session and branch — one task"): any
session, its own task stays pinned; one started for it — in the project
folder, not a worktree: executors (subagents, cloud sessions) start from
`main`. `task queue` prints ready
tasks, each with an indented line — its executor's prompt. In Claude Code: an executor — `Agent` with
`isolation: "worktree"` and `run_in_background: true`, the prompt — the
indented line as is; at most 3 subagents and 5 cloud sessions at once, the
owner's number replaces either;
`=` — a task in work (In progress, an open PR, handed out to an executor of
this session), not launched again. Before each launch — `get_usage`: the 5-hour limit at 85% and more —
no new executors, the running ones finish, then `Remaining: N tasks, the
limit`. After each executor's answer — `task queue` again: it also removes
finished executors' worktrees (`+`), not by hand. A question — to the
owner in text; the answer — ✅ in the task's questions section and to the same
executor with `SendMessage`. After the app restarts — each stopped executor
is continued with `SendMessage` by its id, not a new one (`task resume`). Waits for subagents — it answers again. Failed — a
task comment with what stopped, no restart (the owner's restart:
`--assignment` refuses while the previous executor lives); on an external
blocker — *blocked by* on its issue or
the `external blocker` label with the reason (`reference.md`,
"Dependencies"). Queue empty and nothing running — the summary, the last
line (a session with its own task — after it) and, in auto mode, archiving. The executor's side (`--assignment`,
a cloud one's: `--cloud`) — `reference.md`, "task queue".

## Git, PRs and merging — mechanics

Principles — `AGENTS.md`, section "Git, PRs and merging"; the full rules —
`reference.md`, "Git, PRs and merging — full rules". Waiting for checks, the
full SHA and a merge that deploys — `docs/pr-checks.md`.

- **Merge — rebase only:** `gh pr merge <N> --rebase`; each commit of the
  branch lands in `main` — a conventional commit with `Refs #N`.
- **Merge without a queue:** as soon as the PR's own CI is green and GitHub
  merges it without a conflict, a branch that fell behind too. Rebase onto
  `origin/main` and `git push --force-with-lease` (not `--force`) — only on a
  textual conflict or my own changes; someone else's branch rule with strict —
  rebase, not `gh pr merge --admin`. **Before merging — `github pr premerge
  <N>`** (after `ci-wait` PASS).
- **Before a push** — `git branch --show-current`: my own branch, not the
  local `main`.
- **Merge in auto mode in Claude Code — as a separate call:**
  `gh pr merge <N> --rebase` — the whole command, without `cd`, a pipeline,
  `;` or `&&`: the owner's rule `Bash(gh pr merge *)` must match each part.
  Exit code `0` — merged. Refused even as a separate call — I don't retry the
  merge or push it through in another form; `Remaining: merge — from the
  owner`. The agent doesn't widen its own permission settings.
- **After such a merge `gh pr view` isn't needed:** the merge SHA is taken by
  `wait-ci.sh merged <N>`, `task close <N>` reads the PR itself; a read still
  needed — a narrow `gh pr view <N> --json state` as a separate call; after a
  refusal I don't repeat the command or get the same thing in another form.
- **Right after a PR merge — I delete what was merged entirely, without
  asking** (a `github task close` step): the checkout moves off the merged
  branch to `origin/main` detached, the local and remote branches, the task's
  Compose stacks with their volumes, my own worktrees. "Merged" — by the PR or
  `git cherry origin/main <branch>`, not `git branch --merged`. Others'
  branches, worktrees of live sessions, unmerged work — never. The next task —
  not in this session.
- `gh pr merge --delete-branch` from a worktree doesn't delete the local branch
  — this isn't a merge error: I check `gh pr view <N> --json state`, I don't
  repeat the merge.
