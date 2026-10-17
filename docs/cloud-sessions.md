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
from the project's **`SessionStart` hook** — `.claude/settings.json`, which
`install` and `update` put into a thin project (#610). The cloud runs a
project's hooks — not `~/.claude/settings.json` — after Claude Code starts,
on every start and resume. With `CLAUDE_CODE_REMOTE=true` the hook does what
an environment's setup script did (#555), without the owner's step: `npm i -g
bun@latest @miroshnik/elves && elves install -g`, then `check --hook` into the
context; outside the cloud it exits at once. The canon already on the machine
— nothing to install; a failed step — a line with its command, code 0. An
Elves clone carries the hook in its commit: Bun, zsh for its tests
(`tests/capabilities/agent-shell`) and the flow from the clone itself —
`install -g --link`, the branch's canon, no npm. A fresh start of the clone's
hook with zsh in place took 4.4 s (2026-10-17: npm about 3 s, `check --hook`
about 1 s); without zsh `apt-get update` and its install add about 6 s.

- `bun@latest` — the image's Bun lags behind a project's `packageManager`
  (1.4.2 on 2026-10-16, without the `bun check` of 1.4.3): npm's global
  directory comes before `~/.bun/bin` in the image's `PATH`, while `bun
  upgrade` in the session gets 403 from GitHub.
- **No apt lists in the image** (2026-10-17): `apt-get install zsh` alone —
  "Unable to locate package"; `apt-get update` first. `--force-confold` — the
  image has its own `/etc/zsh/zshrc`: without it dpkg asks whether to replace
  it and fails without a terminal (#598).
- **npm has no release yet** (2026-10-17): `@miroshnik/elves` there is the
  `0.0.0` stub without the `elves` command, so a thin project's hook prints
  "the flow isn't installed (exit 127)" until CI publishes a release (README,
  "Installation" — the owner's step). The clone's hook doesn't need npm.
- **The setup script** is optional, a faster start: the environment caches
  its result for about 7 days, and the hook then installs nothing. Network
  access — Trusted (the default), about 7 s:

  ```bash
  npm i -g bun@latest @miroshnik/elves && elves install -g
  # an Elves clone's environment: zsh for its tests (tests/capabilities/agent-shell), CI installs it too
  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold zsh
  ```

- **The project's version** — `@miroshnik/elves` in its `devDependencies`,
  only from npm: bun installs it through the session's proxy, `github:` in
  the session is 403. It works in the project language, just like a local
  session: `language` in `.agents/elves.json`, which comes with the clone.
- **A thin project behind** — updated in the session's task, as locally:
  `bunx @miroshnik/elves update` raises the package version, a few lines into
  the task's branch; a project without the hook yet gets it the same way, and
  until then — `check` by hand.
- **No machine hook:** the cloud doesn't read `~/.claude/settings.json`; the
  project's hook runs `check --hook` instead, without `github task resume`
  (Projects are closed there). An environment without Bun or zsh all the same
  — `check` names it with a `cloud environment:` line and the command, which
  the session runs itself.
- **A project with a copy of the flow** loads the canon twice in the cloud —
  the copy's `.claude/rules` and the setup script's — until its move to the
  thin project; a copy gets no project hook, nothing names it.

**What is visible at the start** — checked from inside a cloud session
(2026-10-17, Claude Code 2.1.302, #610), which itself started without the
hook:

- Skills `install -g --link` put into `~/.claude/skills` mid-session —
  Claude Code picked them up at once (the skills list in the context
  changed).
- Rules `~/.claude/rules/elves*.md` written mid-session didn't reach the
  context of that turn. By the diagnostics log (`$CLAUDE_CODE_DIAGNOSTICS_FILE`)
  Claude Code reads memory files at the start of a user turn
  (`cli_turn_started`, then `memory_files_completed` with `file_count`), so
  the rules the hook writes before the first turn should load.
- The clone hook's command, run as Claude Code runs it (`sh -c`, a fresh
  `HOME`): code 0, the output is `check --hook`'s; outside the cloud — no
  output.

Still to check — in the first cloud session of the clone after the merge:
the hook's output in the context; `memory_files_completed` at the first
`cli_turn_started` has `file_count` 3 (the clone's `.claude/CLAUDE.md` and
both rules); ask the agent to quote a rule from `AGENTS.md` and list the
skills — `est`, `spec`, `ci-wait` must be there. The rules didn't load — the
hook prints the canon (#610, question 2).

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
whose assignment `est` reads by the word "Task"; a cloud executor's brief is
`github task queue --assignment <N> --cloud` — whole (`task queue` refuses
in the cloud), the epic and numbers in the title without `#`. Two `#N` —
`est fact <N>` in the cloud prints `Actual unavailable (cloud)` though the
transcript is in the container.

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

**A local dispatcher learns of it by the task's closing** (#609): a cloud
session can't message the local one that started it. `send_message` to a
local session is refused — `elevated_session_untrusted_device`, then "target
session could not be verified" on every retry (checked 2026-10-17);
`create_trigger` (`persistent_session_id`) and `get_session` don't take a
local session's id (`local_…`); `ListAgents` in the cloud sees no sessions of
the owner's machine; the owner's approval on a trusted device
(`confirm_repository_trust` with the `content_digest` of such a refusal —
these carried none) is, by the tool's description, for one cloud session,
i.e. per executor. So the brief tells the executor not to message the
dispatcher and not to archive its session, and the dispatcher waits for the
merge's `Closes #N`: `ci-wait issue <N>` as its own background command; PASS
— `github task close <N>` locally (the actual with `--write`, `Status`, the
merged `claude/<slug>` branch), then archiving the executor's session where
it has the tool (till then its transcript may be needed for `est`); TIMEOUT —
the task's questions section and State comment, the executor's session, the
wait again. After the app restarts the queue's `=` line names the wait.

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
