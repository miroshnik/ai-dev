# Shared rules for all projects

## This file and skills

The Elves canon for any agent (Claude Code, Codex, Gemini CLI, Cursor,
Copilot, OpenCode, Amp). It lives in **miroshnik/elves** with the skills
(`skills/*`) and references (`docs/`, next to this file), installed
onto the machine — README, "Installation". A rule or skill change from
another project's session is a task in Elves (project #6) without that
project's names, for a separate session; I don't edit an Elves clone from
someone else's session. A Claude Code **cloud session** sees only the
repository and its setup script's flow — `docs/cloud-sessions.md`.

**The repository is public:** no names, owners, paths or numbers of other
repositories, no colleagues or clients — in files, git history or issues;
examples are made up. **A skill is `SKILL.md` + `scripts/`** in TypeScript
under Bun (Agent Skills; README, "Repository layout"); repository specifics
— local configuration. **Budgets** (standard `canon-size`): this file ≤
3,000 words, a `SKILL.md` ≤ 2,500, a skill description ≤ 1,024 characters.
Here — what always applies and where to go; reference — a skill's
`reference.md` or `--help`, `docs/`.

## First step of a session — an up-to-date flow

Rules load at the session start, so first, before the task: `bunx
@miroshnik/elves check -g` (machine) and `check` (project, with its mode
and language) — in Claude Code the `SessionStart` hook runs them into the
start of the context. The machine's copy and a project's package version
follow Elves releases (tags `vYYYY.MM.DD`), a `--link` clone — `origin/main`;
a release is the owner's step (`elves release`), I cut one only when asked.

- **The machine is behind** — `update -g`. After an `update` I tell the user
  briefly what changed (it lists the skipped releases) and re-read what was
  updated: it applies, not what loaded at the start.
- **The project is behind** (or git ignores flow files) — `update` in the
  task's branch: the package version, a few lines.
- **The project keeps a copy of the flow** — the move is a task of its own,
  one per project (`check` prints its `github task new`): I recommend it and
  ask whether to queue it.
- **`update` refused or the check unavailable** — I don't fix the clone; I
  work by the current flow and say so.

## Language

The flow is written in English; the agent works in the **project language**
(`language` in `.agents/elves.json`, printed by `check`): talking with the
user, issues, prompts to subagents, documents, commit and PR
descriptions, `describe`/`it` names, decision docs — briefly. Always English:
code, identifiers, terms, conventional-commit type and scope. Names that
scripts write to GitHub and parse back are exact — `locales/<language>.json`
of the `github` skill; in `en`: sections `## Questions`, `## Scenarios`;
`Status` `Backlog` → `In progress` → `Done`; the comment `State`; `Task #N`,
`epic #M` in a subagent's prompt; the last line `All
done. The session can be closed.` · `All done, but there are questions: …` ·
`Remaining: …`.

## What I do without asking and what needs a yes

- **Without asking:** reading and search, tests, lint, typecheck, build, local
  edits in my checkout, local infrastructure (Docker, dev database), logs and
  read-only requests to external systems; task tracking; re-running my own CI
  run, closing my own duplicate PR, deleting my own merged branch; updating
  the flow and committing it.
- **Only on an explicit "yes"** — anything irreversible or external: `git
  commit`, `git push`, merge, deploy, tag, migrations and writes to live
  databases, external service settings, deleting others' or unmerged remote
  branches and data, outgoing messages (auto mode — below).
- **Permission is for this action, this time:** "commit" ≠ "and push", "fix
  whatever is needed" ≠ a merge, a past "yes" doesn't carry over; one
  "commit" covers all current work in logical steps. A repository may set
  another mode in its `AGENTS.md`. "Do it all yourself" lifts intermediate
  confirmations for the named task, except on a discrepancy that changes
  scope or approach. An autonomous routine does exactly what
  its assignment names; merge, deploy, external settings — only if named.
- **`"auto": true` in `.agents/elves.json` — the whole task without asking**:
  commit, push, fixing CI, merging my own PR on green checks; work outside the
  task — a Backlog task and the question «queue it?». The task's open
  questions — I answer by a recommendation with ✅ auto (`task answer
  --auto`); my own question goes into the questions section the same way,
  before code, not into chat. I ask only
  without a clear recommendation, when the decision is critical or a human's,
  or on a discrepancy that changes scope or approach — not when the answer
  would be "yes" or "as you recommend". Anything else irreversible or
  external still needs a "yes".
- **Secrets and bypassing protections — only with permission** (tokens, keys,
  bypass secrets, disabling checks at the host, CI or cloud): first — what
  will appear and where; a secret from chat — never stored, rotation reminded.

## Task tracking

- Tasks live in the repository's **GitHub Issues**, not in local lists, TODO
  files or the agent's task list; no repository — ask where. The `github`
  skill runs them (`task new`, `show`, `answer`, `status`, `close`, `drop`,
  `pr labels`), not `gh issue view`/`edit`; how tasks, the project and
  milestones are organized — its `reference.md`.
- **Types:** Task (one PR), Bug, Epic (a personal account — the `epic`
  label). **Decision labels** — the decision's name, kind by color: a task
  carries those of the decisions it introduces or changes, an epic — their
  union.
- **A big task is an epic** (prefix `<Prefix> · …`) **+ subtasks**
  (sub-issues); **dependencies only as GitHub links** (sub-issue, blocked
  by — on another repository's issue too; a blocker that isn't an issue — the
  `external blocker` label, the reason in a comment): a task with an open
  *blocked by* or that label isn't taken. Before creating — check it doesn't
  exist (`gh issue list --search`).
- **What GitHub keeps natively isn't repeated in an issue's text** —
  sub-issues, blocked by, `Status`, milestone, labels, fields, the PR: a copy
  goes stale; an epic's description has no list of subtasks or stages.
- **One GitHub Project per repository**, named after it, with all tasks;
  `project check` once per session, ❌ — `project fix`. `Status` I set
  **myself, immediately**: `task status`, `task close`, `task drop` (won't
  do, duplicate). `Priority` (`Urgent` → `Low`, `Medium` by default) is
  required on an open task. A milestone (an epic stage, a release) I close
  with its last task.

### Session and branch — one task

- **Session = task:** `task status` won't take a second one. Another task —
  Backlog and the question «queue #263?», "yes" — its executor at once;
  "do it here" — a one-sentence refusal and the question again. My own
  regression and a fix for a green PR are the same task. A new epic — the
  question «run the dispatcher on epic #M?», without In progress.
- **A dispatcher** — "do all tasks of epic #M", "fix all High bugs", a "yes"
  — any session, its task stays; one started for it — in the project folder,
  not a worktree: executors start from `main`. `github task queue` — ready
  ones with executors' prompts; an executor — a background subagent in its
  worktree, at most 3; its question — to the owner, the answer into the
  issue and back; failed — a task comment, no restart.
- **The session is named `#<number> <task title>`** (without a task — by
  meaning, no number) as soon as the task is clear (no tool — ask the user):
  `est` links the session to the task by it.
- **Branch = `<type>/<issue>-<slug>`** (`feat/42-invoice-export`): `type` —
  conventional-commit types (`feat fix docs refactor perf test chore ci
  build`) plus `research` (a spike without code); slug — Latin kebab-case,
  2–5 words; a repository's area prefix goes first (`backend/fix/263-…`). A
  branch named by a worktree tool is renamed before the first push by `github
  task status <N> "In progress" --branch <type>/<N>-<slug>`.
- **PR:** the title is a conventional commit, the body has `Closes #263`.
  **Merge — rebase only** (`gh pr merge <N> --rebase`): commits land in
  `main`, each a conventional commit with `Refs #263` (`Closes` would close
  the task). Without PRs — `Closes #N` in the last commit.

### Open questions — at the start of work

A task's questions are a numbered list in its description's questions
section. Taking a task, **first of all** — before the plan, code and
subagents — I read the questions of the task and its epic (`github task show
<N>`) and **ask the user all open ones (without ✅)** in one message, each
with options and a recommendation. What already has an answer (comments,
code) gets ✅; my own questions join the message and the section. While
waiting I do what doesn't depend on the answer — what does, I neither start
nor replace with an assumption. The answer goes straight into the issue:
`github task answer <N> <k> "<answer>"`. An autonomous routine doesn't take a
task with open questions.

### Estimate and actual — the `est` skill

The unit is the agent's hours on the task except waits for the user's input;
CI and check waits count, split out.
The estimate is set by `github task new`, the actual by `github task close`;
neither is written by hand, the estimate isn't rewritten after
work starts, no actual — "actual unavailable", not a number by eye. Work is
linked to the task by the pinned session, the session name, the branch,
`Closes #N` and the task number in every subagent's assignment ("Subagents
and worktrees") — otherwise there is no actual.

### Epic refresh on task close

Once a task is merged, **a subagent with a fresh context** brings the open
tasks of its epic in line with what shipped — not the session at peak
context: `github task actualize <N>` does the mechanics and prints its prompt,
in the same turn as `ci-wait merged <PR>` in the background; after both —
`github task close`. The last line of the answer ("Language"): merged,
deployed, branch removed, epic refreshed, no questions — "all done, can be
closed"; the owner has something to decide — "all done, but there are
questions" with them; otherwise — "remaining" with what the session waits for
and from whom. In auto mode after "can be closed" the session archives itself
where the agent has the tool; information without a decision doesn't prevent
it.

## Git, PRs and merging

- **Taking a task** — check it isn't going in a parallel session (an open PR,
  a branch `*/<N>-*` after `git fetch --prune`): continue that work or wait
  for the merge; two PRs for one thing — close the second.
- **Branch only from a fresh `origin/main`** (`git fetch origin && git switch
  -c feat/263-slug origin/main --no-track`). Into `main` only via a PR; a
  direct push and `gh pr merge --admin` — only on the owner's direct
  instruction. **Before a push** — is it my branch.
- **Commits in logical steps**, tests in the same commit as the code.
  **Before a commit — `lint`, `typecheck`, `test:spec`; `test` — what the
  change affects** (`--changed=origin/main`; the full run — CI,
  `docs/testing.md`); before merging — a full build; `set -o pipefail` in
  `script | tail`.
- **I merge as soon as all checks are green** (the preview deploy too; an
  empty list is "not registered yet") and GitHub merges without a conflict;
  rebase and `--force-with-lease` — only on a textual conflict or my own
  changes. **Before merging — `github pr premerge`:** `main` moved after the
  PR's CI — fast checks on the merge with it; red — I fix the root cause;
  `main` red by itself (exit code 3) — no merge and no fix in the PR: one bug
  for it, I wait for it to close.
- A merge that deploys — I wait for the deploy on the merge SHA (`ci-wait`),
  the epic refresh in parallel; **then `github task close`**. Others'
  branches, stacks and unmerged work I don't touch.
- Mechanics — the `github` skill, "Git, PRs and merging — mechanics";
  waiting for checks and deploys — `docs/pr-checks.md`.

## Specification — decisions

A project's spec is **decisions with a mechanical check**, functional and
non-functional (a test, a lint rule, an architecture check).
**No check — no decision; no decision — no code:** behavior without a check
may change without agreement; code no decision claims is dead. A check is
written before the code and is red first (acceptance), then holds the
decision (regression); a decision changes through its check — first the
check, red, then the code. Three roots of `tests/` by the reader's question:
`capabilities/<name>` (what the system does), `architecture` (what it's made
of — a model with checks), `standards/<name>` (code rules, cross-cutting
qualities); a decision is a folder (`<folder>.md` — why, `<folder>.test.ts` —
the statements). Exceptions — a mark in the element's file or a file in the
folder's `exceptions/`, with an `#issue`, a reason and a ratchet. Test names
are statements in the project language; a code task gets the scenarios
section (future `it` names) before code. The PR body is `spec-diff` output;
docs are generated (`spec-doc`) and published by CI to the `spec` branch. A
recurring decision — a "Standard · …" issue and a rule in `tests/standards/`.
The full canon and wiring — the `spec` skill (`canon.md`, `checks.md`).

## Tests and code

- **A test failed — I fix the root cause** (the test or the logic), even if
  unrelated to my changes or a rerun is green — no "pre-existing flake",
  timeouts or retries; a race goes by its cause (the real event, not a
  pause). A flake suspicion — the same run on the base branch: red there too
  — I compare the delta.
- **A run's result — by the runner's summary**, not the wrapper's exit code.
  Project checks go through the machine queue (the `slot` skill), a full run
  — in the background; e2e and UI in a browser — `docs/testing.md`.
- **A regression test and a "no defect" guard must be able to fail**: I
  revert the fix, see red, restore it; it didn't fail — it guards against
  overcorrection (named so) or is deleted.
- **An external API contract — by its schema or docs**, not intuition; on a
  mismatch I fix the test, not the code.
- **Intentionally different behavior in two places** — mirrored comments
  with the reason.
- **I check what reached the human** (the delivered email, the page at the
  recipient), not my output; a component on several surfaces — in each.
- **Judgment:** before a run — which of our mistakes would give the same
  outcome; labels — after checking what the numbers mean; I edit exactly
  what was named; "doesn't reproduce" — with what I measured.
  `docs/judgment.md`.

## Production and debugging

- **The production database is read-only.** Data and schema change via a
  migration in a PR; DDL on production — only on
  the owner's direct instruction, as a migration file; the environment
  refuses — I explain, no workaround. Data the application manages (roles,
  permissions, audited settings) never changes by direct DML: the audit is
  lost, guards bypassed; what the UI lacks is a code change.
- **Production numbers — first, is it the right database:** the first query
  checks it against the repository (migrations, columns, orders of
  magnitude); no match — stop.
- **"Didn't help" → production facts, not a third reproduction:** the logs
  of the real request and production data (the row, `updated_at`, audit),
  then a new hypothesis.

## Subagents and worktrees

- **Subagents don't share a dirty worktree.** An agent that may install
  packages or touch files "to try" gets an isolated worktree or "read-only
  plus a temp folder" without `git checkout/restore/stash/clean`: its cleanup
  reverts everything uncommitted, others' work too. Several agents in one
  worktree — non-overlapping files, no git, a shared file has one owner. After
  a fan-out — `git status` and `git diff --stat`. Temp files shared with
  subagents get a unique prefix (task, role).
- **A fresh worktree lacks untracked files** (dependencies, `.env*.local`) —
  I install and copy them. Paths in commands and assignments lead into the
  worktree (a path "from memory" edits `main`); `git -C <worktree> status`
  before and after an edit.
- **Parallel checkouts share ports, databases and `.git/config`:** the task's
  apps, databases and e2e run in its own Compose stack (the `task-env`
  skill) at `<service>.<N>.<project>.localhost`, not on a host port; others'
  stacks and busy ports I don't touch — `docs/parallel-checkouts.md`.
- **A subagent gets a unit of ~50 turns** (one decision's folder, one file,
  one spec), not a 200-turn zone: it carries the same preamble (≈ 100k
  tokens), and its price is quadratic in turns. The assignment has the task
  number after the word for "task" or at the start, the epic after the word
  for "epic" ("Language") — so `est` links its work. **Fewer turns:** a file
  in one full read, independent tool calls in one turn.

## Project knowledge and handoff

- **Shared — in Elves, project-specific — in the project's spec**
  ("Specification — decisions"), the reason in the decision's `<folder>.md`;
  neither shared nor checkable (operations, product documents) — the
  project's `docs/`. The project's `AGENTS.md` — the install block and how
  its mode differs. An agreement from chat goes there too, not into the
  agent's memory: memory is a cache, not a source.
- **I don't revisit the stack** or drag in dependencies; something in the way
  — a question to the user, not a silent replacement. Versions — latest
  stable; a tool question — its official documentation first.
- **Before a pause or an agent change — a State comment in the issue:** done,
  the branch, next, blockers.

## CI: parallel tasks

Branches and PRs run in parallel, only my own stale run of a branch is
cancelled; `main`, tags and manual runs never (`queue: max`); deploy — a
queue per environment, apart from CI; others' runs I don't cancel or re-run.
Workflow fragments — `docs/ci-concurrency.md`.
