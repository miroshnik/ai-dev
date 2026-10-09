# Claude Code

Shared rules — `AGENTS.md`. Only what Claude Code has is here; installing into
a project puts both files into `.claude/rules/` (`ai-dev.md` and
`ai-dev-claude.md`), and Claude Code loads them itself, whatever the
project's `CLAUDE.md`.

- Session transcripts (`~/.claude/projects/<path-with-dashes>*/`) are the
  source of actuals for the `est` skill; `~/.claude/settings.json` must have
  `"cleanupPeriodDays": 365`, otherwise history is cleaned before it's needed.
- The app's worktree names the branch `claude/<slug>-<hash>` — rename it
  before the first push (`git branch -m <type>/<issue>-<slug>`). The session
  panel shows the worktree branch, its diff to `main` and the "Create PR"
  button from git state, not GitHub: after a merge it is accurate only if the
  checkout is moved to `origin/main` (`github task close` does that).
- The app's CI monitor wakes the session only on failed checks, conflicts and
  reviews, and only with Auto-fix on; it doesn't report success. Wait for
  green checks before a merge and for the deploy after it with the `ci-wait`
  skill as a background command: its completion wakes the session.
- Merge in auto mode — `gh pr merge <N> --rebase` as a separate call, without
  `cd`, `|`, `;`: otherwise the `Bash(gh pr merge *)` rule (set by the owner)
  won't match and the classifier rejects the merge.
- `install -g` puts a `SessionStart` hook into `~/.claude/settings.json`
  (`startup|resume|clear`): `check --hook` checks the machine's skills and
  hook and the project's flow (`AGENTS.md`, "First step of a session"),
  including its mode and language; the output goes to the start of the
  context; in a git repository without the flow it suggests installing it.
  The hook's exit code is always 0 — otherwise Claude Code doesn't put the
  output into context; timeout 60 s, an error doesn't block the session. No
  hook output in context — run `check` by hand.
- `set_session_title` renames the session; in auto mode `archive_session`
  with `self` archives it: as the last action, after the "can be closed" line
  — the conversation ends with it.
- Skills — in the project's `.claude/skills/<name>` and
  `~/.claude/skills/<name>` (symlinks to `.agents/skills/<name>`), the skill
  directory is `${CLAUDE_SKILL_DIR}`; a same-named machine skill wins over the
  project's. `SKILL.md` frontmatter also reads `when_to_use`,
  `argument-hint`, `allowed-tools`.
- Bash on macOS is zsh: a variable isn't split into words (`G="bun x.ts";
  $G task new` — "command not found", and `| grep` hides the error) — use
  `G=x.ts; bun $G …` or `${=G}`, a comma-joined list — `${(j:,:)arr}`;
  `echo ====` and a glob without matches (`--include=*.ts`) are errors: quote
  them.
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
