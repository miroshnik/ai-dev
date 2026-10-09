# Claude Code cloud session

Reference for the cloud-session line in `AGENTS.md`. A cloud session is
Claude Code on claude.ai/code, including one started from the phone app: a
temporary container into which only the project repository is cloned.

## What it sees

Only the project repository. Skills from the user's machine
(`~/.claude/skills`) and the agent's memory aren't there. A cloud session has
the canon and skills only if the flow is installed in the project:
`npx -y github:miroshnik/ai-dev install` puts a copy into `.agents/`, and the
symlinks in `.claude/rules` and `.claude/skills` come with the clone (the
ai-dev README, "Installation"). It works in the project language, just like a
local session: `language` in `.agents/ai-dev.json`, which comes with the
clone too. The version is the committed one: a cloud session doesn't update
the flow even if `check` says it is behind — a local session updates it
(`update` and committing the copy into the task branch). There is no
`SessionStart` hook in the cloud: it is installed on the machine.

Check: in a cloud session of the project, ask the agent to quote a rule from
`AGENTS.md` and list the skills — `est`, `spec`, `ci-wait` must be there.

## What the cloud lacks (checked 2026-09-25)

- **GitHub GraphQL** is closed by the session proxy ("use the REST API").
  REST — only `repos/{owner}/{repo}/…` paths of the session's repositories;
  **Projects v2** (`users/…/projectsV2…`, `orgs/…`) — 403. Project fields
  (`Status`, `Estimate, h`, `Actual, h`, tokens, cost) can't be set from the
  cloud; `est` computes neither the estimate nor the actual.
- **Writing to the repository** (push, editing issues, comments, PRs) — only
  if the Claude GitHub App has access to the repository. No access — 403
  ("Resource not accessible by integration", "Claude doesn't have GitHub
  access"): the user installs or reconnects the app
  (claude.ai → Settings → Connectors → GitHub; github.com/apps/claude).
- **The cloud assigns the branch** (`claude/<slug>`) and forbids pushing to
  others without explicit permission. A branch by the `<type>/<N>-<slug>`
  convention — create it after asking the user at the start, together with
  the task's questions.
- **The session title** (`set_session_title`) is stored on the server and
  doesn't get into the transcript: `est` links cloud work to the task only by
  the branch, `#N` in the first prompt and commit hashes.
- **The container is temporary**: anything unpushed is lost.

## Closing a task from the cloud

`github task close` refuses in the cloud (GitHub Projects are unavailable)
and prints the same steps:

1. `est fact <N>` computes this session's part of the actual from its
   transcript in the container (linking — the branch `<type>/<N>-…` or `#N`
   in the first prompt) and prints an `Actual (cloud)` comment
   with hours, tokens, a link to the session and a part marker — post it to
   the issue with a GitHub tool. Project fields (`Actual, h`, tokens, cost)
   are set by the next local session: `est fact <N> --write` or
   `est fact --sweep --write` adds the cloud part to the local work. The
   transcript didn't link — `Actual unavailable (cloud)`, and a local session imports the session's events via the browser
   (the `est` skill, "Cloud session").
2. `Status` = Done is set by the project's built-in workflow "Item closed"
   (whether it is enabled — a local session checks with the `github` skill);
   not enabled — ask the user to set the status.
3. Epic refresh — by a subagent with a fresh context, as locally (issues,
   sub-issues, milestones are available through the repository's REST); what
   can't be done from the cloud (project fields, estimates of new tasks via
   `est`) — into a State comment for the local session.

## Push failed — a local session finishes

A cloud session that can't write hands the work over as files: the branch —
`git bundle` or `git format-patch --stdout` (a session attachment), answers
to questions — in the PR text or the final message. A local session, by the
task number:

1. Answers from the cloud — into the task's questions section (✅ and the
   answer), before code.
2. The branch — from a fresh `origin/main`:
   `git fetch <file>.bundle <branch>:<branch>` or `git am <file>.mbox`; if the
   cloud didn't start from it — rebase.
3. Review the diff and the same checks as CI **on this machine**: the cloud
   is Linux, and platform differences (symlinks via `/var` → `/private/var`
   on macOS) aren't visible there.
4. Then as usual: PR, green checks, merge, actual. The actual sees only the
   local part of the work — add the line `Reason: missed work: …`
   (reason: missed work) with a link to the cloud session.
