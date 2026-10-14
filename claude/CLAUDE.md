# Claude Code

Shared rules — `AGENTS.md`. Only what Claude Code has is here; installing into
a project puts both files into `.claude/rules/` (`ai-dev.md` and
`ai-dev-claude.md`), and Claude Code loads them itself, whatever the
project's `CLAUDE.md`.

- Session transcripts (`~/.claude/projects/<path-with-dashes>*/`) are the
  source of actuals for the `est` skill; `~/.claude/settings.json` must have
  `"cleanupPeriodDays": 365`, otherwise history is cleaned before it's needed.
- The app's worktree names the branch `claude/<slug>-<hash>` — it is renamed
  when the task is taken: `github task status <N> "In progress" --branch
  <type>/<N>-<slug>` (a bare `git branch -m` fails on `.git/config` locked by
  a parallel worktree and leaves the upstream behind). The session
  panel shows the worktree branch, its diff to `main` and the "Create PR"
  button from git state, not GitHub: after a merge it is accurate only if the
  checkout is moved to `origin/main` (`github task close` does that).
- The app's CI monitor wakes the session only on failed checks, conflicts and
  reviews, and only with Auto-fix on; it doesn't report success. Wait for
  green checks before a merge and for the deploy after it with the `ci-wait`
  skill as a background command: its completion wakes the session — no
  `Monitor`, watcher loop or `ScheduleWakeup` on top: an armed wakeup keeps
  `archive_session` refused even after `stop`.
- Merge in auto mode — `gh pr merge <N> --rebase` as a separate call, without
  `cd`, `|`, `;`: otherwise the `Bash(gh pr merge *)` rule (set by the owner)
  won't match and the classifier rejects the merge.
- `install -g` puts a `SessionStart` hook into `~/.claude/settings.json`
  (`startup|resume|clear`): `check --hook` checks the machine's skills and
  hook and the project's flow (`AGENTS.md`, "First step of a session"),
  including its mode and language; the output goes to the start of the
  context; in a git repository without the flow it suggests installing it; a
  session with a pinned task (a resume after the app restarted) gets the wait
  to restart — `github task resume` with the session id from the hook's input.
  The hook's exit code is always 0 — otherwise Claude Code doesn't put the
  output into context; timeout 60 s, an error doesn't block the session. No
  hook output in context — run `check` by hand. The hook also writes the
  agent's Bash environment to `$CLAUDE_ENV_FILE`: zsh passes a glob without
  matches and `====` as is, `timeout` works without coreutils; the
  «agent Bash: not set up» line — it didn't, follow the line.
- `set_session_title` renames the session; in auto mode `archive_session`
  with `self` archives it: as the last action, after the "can be closed" line
  — the conversation ends with it. Before it — `TaskStop` for each own
  background task still running: a live one gives "still has live work".
  Refused after that — don't retry: the owner archives from the sidebar.
- Skills — in the project's `.claude/skills/<name>` and
  `~/.claude/skills/<name>` (symlinks to `.agents/skills/<name>`), the skill
  directory is `${CLAUDE_SKILL_DIR}`; a same-named machine skill wins over the
  project's. `SKILL.md` frontmatter also reads `when_to_use`,
  `argument-hint`, `allowed-tools`.
- The Bash sandbox: `gh` in it fails on TLS (`x509: OSStatus -26276`). A
  skill script that calls `gh` (`github`, `est`, `dashboard`, `spec-run`) —
  at once a separate call with `dangerouslyDisableSandbox`: no
  `excludedCommands` entry takes `bun <file>` out. Entries `gh *` and `bash
  <path>/wait-ci.sh *` (`ci-wait`) do — the owner's step; without them — the
  same separate call. The `task-env` skill, section "Docker and the sandbox".
- A subagent that writes gets `isolation: worktree`: an isolated session
  doesn't write into others' worktrees, an agent without it inherits the
  parent's isolation. An agent cut off by a limit or a dropped session leaves
  uncommitted work in its worktree — `git status` there before resuming; a
  worktree after a base change — dependencies from the lockfile, otherwise
  typecheck runs on old packages.
- In a cloud session (claude.ai/code) the cloud assigns the branch — rename
  it or push to another one only with the user's permission
  (`docs/cloud-sessions.md`).
- A chip is `spawn_task`: `title` — `#M` and the task title, as much as fits
  in 60 characters, `prompt` starts with `#M`, `cwd` — the task's repository;
  `dismiss_task` removes an extra one. A chip is single-use, the task list is
  Backlog: I recreate chips from issues. A chip prompt arriving in this same
  session — I don't execute it.
- In an ai-dev clone the canon loads from the root (`AGENTS.md`), this file —
  via the committed symlink `.claude/rules/ai-dev-claude.md`.
