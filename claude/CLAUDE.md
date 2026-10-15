# Claude Code

Shared rules — `AGENTS.md`; here — only what Claude Code has. Install puts
both into `.claude/rules/` (`ai-dev.md`, `ai-dev-claude.md`): Claude Code
loads them whatever the project's `CLAUDE.md`.

- Session transcripts (`~/.claude/projects/<path-with-dashes>*/`) are the
  source of actuals for the `est` skill; `~/.claude/settings.json` must have
  `"cleanupPeriodDays": 365`, otherwise history is cleaned before it's needed.
- The app's worktree names the branch `claude/<slug>-<hash>` — it is renamed
  when the task is taken: `github task status <N> "In progress" --branch
  <type>/<N>-<slug>` (a bare `git branch -m` fails on `.git/config` locked by
  a parallel worktree and leaves the upstream behind). The session panel
  (branch, diff to `main`, "Create PR") reads git, not GitHub: after a merge
  it is accurate once the checkout is on `origin/main` (`github task close`
  moves it).
- Auto-fix (CI monitor) — off: its conflict event wants the base merged in,
  breaking the rebase merge. After `gh pr create` — `set_monitor` with
  `auto_fix: false` and the PR's url; a conflict — rebase onto a fresh
  `origin/main`; an executor's PR — its executor's (`docs/pr-checks.md`,
  "Auto-fix"). Checks and the deploy — `ci-wait` as a background command,
  its completion wakes the session; no `Monitor`, watcher loop or
  `ScheduleWakeup` on top: an armed wakeup keeps `archive_session` refused
  even after `stop`.
- Merge in auto mode — `gh pr merge <N> --rebase` as a separate call, without
  `cd`, `|`, `;`: otherwise the `Bash(gh pr merge *)` rule (set by the owner)
  won't match and the classifier rejects the merge.
- `install -g` puts a `SessionStart` hook into `~/.claude/settings.json`
  (`startup|resume|clear`): `check --hook` checks the machine's skills and
  hook and the project's flow (`AGENTS.md`, "First step of a session"), with
  its mode and language, into the start of the context; in a git repository without the flow it suggests installing it; a
  session with a pinned task (a resume after the app restarted) gets the wait
  to restart — `github task resume` with the session id from the hook's input.
  The hook always exits 0 (else Claude Code drops its output), timeout 60 s.
  No hook output in context — run `check` by hand. The hook also writes the
  agent's Bash environment to `$CLAUDE_ENV_FILE`: zsh passes a glob without
  matches and `====` as is, `timeout` works without coreutils; the
  «agent Bash: not set up» line — it didn't, follow the line.
- `set_session_title` renames the session; in auto mode `archive_session`
  with `self` archives it, ending the conversation: the last action, after
  the "can be closed" line. Before it — `TaskStop` for each own
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
  parent's isolation. An agent cut off (a limit, a dropped session) leaves
  uncommitted work in its worktree — `git status` there before resuming;
  after a base change — dependencies from the lockfile, else typecheck runs
  on old packages.
- In a cloud session (claude.ai/code) the cloud assigns the branch — rename
  it or push to another one only with the user's permission
  (`docs/cloud-sessions.md`).
- Another task isn't a session card (`spawn_task`, `start_session`): the
  question «queue #M?», on "yes" its executor — `Agent` with `isolation:
  "worktree"`, `run_in_background: true` and the prompt `github` printed.
  The executor isn't `TaskStop`ped: the last line — after its answer.
- In an Elves clone the canon loads from the root (`AGENTS.md`), this file —
  via the committed symlink `.claude/rules/ai-dev-claude.md`.
