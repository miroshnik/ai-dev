# Claude Code cloud session

Reference for the cloud-session line in `AGENTS.md`. A cloud session is
Claude Code on claude.ai/code, including one started from the phone app: a
temporary container into which only the project repository is cloned.
A dispatcher's executor can be one (`AGENTS.md`, "Session and branch — one
task"): at most 3 subagents and 5 cloud sessions at once, the owner's number
replaces either — a cloud session's container doesn't load the machine.

## What it sees

Only the project repository. The canon, the skills and the agent's memory of
the user's machine (`~/.agents`, `~/.claude`) aren't there: the flow comes
from the **setup script** of the claude.ai environment, before Claude Code
starts (checked in #555):

```bash
npm i -g bun@latest @miroshnik/elves && elves install -g
# an Elves clone's environment: zsh for its tests (tests/capabilities/agent-shell), CI installs it too
DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold zsh
```

`bun@latest` — the image's Bun lags behind a project's `packageManager` (1.4.2
on 2026-10-16, without the `bun check` of 1.4.3): npm's global directory comes
before `~/.bun/bin` in the image's `PATH`, while `bun upgrade` in the session
gets 403 from GitHub. Network access — Trusted; about 7 s, the environment's
cache keeps the result for about 7 days. `install -g` with
`CLAUDE_CODE_REMOTE=true` puts the canon (`~/.agents/elves`, rules
`~/.claude/rules/elves*.md`) and the skills (`~/.claude/skills`) without the
hook. The canon and skills are visible from the first turn, but only in
sessions of an environment with this script: the owner sets the environment up
on their account. `--force-confold` — the image has its own `/etc/zsh/zshrc`:
without it dpkg asks whether to replace it and fails without a terminal
(checked in #598). An environment without Bun or zsh — `check` of a cloud
session names it with a `cloud environment:` line and the command, which the
session meanwhile runs itself.

- **The project's version** — `@miroshnik/elves` in its `devDependencies`,
  only from npm: bun installs it through the session's proxy, `github:` in
  the session is 403. It works in the project language, just like a local
  session: `language` in `.agents/elves.json`, which comes with the clone.
- **A thin project behind** — updated in the session's task, as locally:
  `bunx @miroshnik/elves update` raises the package version, a few lines into
  the task's branch.
- **No hook:** the machine's hook isn't there (the cloud doesn't read
  `~/.claude/settings.json`), and a project hook isn't needed — the setup
  script replaces it; `check` — by hand.
- **A project with a copy of the flow** loads the canon twice in the cloud —
  the copy's `.claude/rules` and the setup script's — until its move to the
  thin project; without a hook nothing names it.

Check: in a cloud session of the project, ask the agent to quote a rule from
`AGENTS.md` and list the skills — `est`, `spec`, `ci-wait` must be there.

## What the cloud lacks (checked 2026-09-25, 2026-10-17)

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
  the branch, the only `#N` in the first prompt (section "The brief") and
  commit hashes.
- **The container is temporary**: anything unpushed is lost.
- **Root:** the session runs as uid 0 — `chmod` doesn't deny writes. The
  flow's write-denial tests (`install`, `slot`) run the checked process as
  `nobody` (`setpriv`); a test relying on permissions without that is green
  or red for the wrong reason.
- **GitHub Actions job logs** over REST (`actions/jobs/<id>/logs`) — 403: the
  answer redirects to blob storage the proxy doesn't let through;
  `get_job_logs` of the GitHub MCP works.
- **GitHub search** (`search/issues`) — 403 ("sessions are bound to their
  configured repositories"): the duplicate check before a new task — by
  listing `repos/{owner}/{repo}/issues`.
- **The `github` skill's scripts** — `task show`, `task answer`, `task new`
  over the repository's REST (#603): without the project — `task new` names
  Status and the estimate in a line for a local session; the rest refuse
  (`CLAUDE_CODE_REMOTE`). The scenarios section — by hand over REST (`PATCH
  repos/…/issues/N`). The proxy ends a description it writes with its
  "Generated by Claude Code" signature after `---` (doesn't add a second one):
  the questions section ends at `---`, the signature isn't its last question's.

## The brief — `#` only for its task

The cloud names the branch itself (`claude/<slug>`), so `est` links a session
to its task by the first prompt: it takes every `#N` of the whole prompt —
with the "Background (from the session that started this one)" block the
harness puts before the task — and links only by exactly one (#594). Whoever
writes a cloud session's first prompt — the owner or a dispatcher session —
names only its task with `#`, in the background too; the epic, other tasks and
PRs — a number without `#` ("epic 40", "tasks 41 and 43") or a title. The
executor prompt of `github task queue` has `(epic #M)`: fine for a subagent,
whose assignment `est` reads by the word "Task", but in a cloud session's
brief the epic goes without `#`. Two `#N` — `est fact <N>` in the cloud prints
`Actual unavailable (cloud)` though the transcript is in the container.

## Closing a task from the cloud

`github task close` refuses in the cloud (GitHub Projects are unavailable)
and prints the same steps:

1. `est fact <N>` computes this session's part of the actual from its
   transcript in the container (linking — the branch `<type>/<N>-…` or the
   only `#N` in the first prompt, section "The brief") and prints an
   `Actual (cloud)` comment
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

1. Answers from the cloud — into the task's questions section
   (`github task answer`), before code.
2. The branch — from a fresh `origin/main`:
   `git fetch <file>.bundle <branch>:<branch>` or `git am <file>.mbox`; if the
   cloud didn't start from it — rebase.
3. Review the diff and the same checks as CI **on this machine**: the cloud
   is Linux, and platform differences (symlinks via `/var` → `/private/var`
   on macOS) aren't visible there.
4. Then as usual: PR, green checks, merge, actual. The actual sees only the
   local part of the work — add the line `Reason: missed work: …`
   (reason: missed work) with a link to the cloud session.
