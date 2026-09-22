@../AGENTS.md

# Claude Code

Правила выше — общие для всех агентов (`AGENTS.md`). Здесь только то, что
есть у Claude Code:

- Транскрипты сессий (`~/.claude/projects/<путь-через-дефисы>*/`) — источник
  факта для скилла `est`; в `~/.claude/settings.json` должно стоять
  `"cleanupPeriodDays": 365`, иначе история чистится раньше, чем нужна.
- Worktree из приложения Claude Code называет ветку `claude/<slug>-<hash>` —
  переименовать до первого push (`git branch -m <type>/<issue>-<slug>`).
- Сессию переименовывает инструмент `set_session_title`; скиллы лежат в
  `~/.claude/skills/<name>` (симлинки из `install.sh`), переменная
  `${CLAUDE_SKILL_DIR}` указывает на каталог скилла.
