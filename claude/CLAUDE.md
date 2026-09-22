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
  `${CLAUDE_SKILL_DIR}` указывает на каталог скилла. В frontmatter `SKILL.md`
  Claude Code читает также `when_to_use`, `argument-hint`, `allowed-tools`.
- Личная конфигурация (реестр репозиториев `~/.claude/est/repos.json`, цены
  `~/.claude/est/prices.json`) — в `~/.claude`, не в репозитории.
- В worktree репозитория ai-dev канон может загрузиться дважды: из `main`
  через `~/.claude/CLAUDE.md` и из ветки нативно (`AGENTS.md` в корне, Claude
  Code ≥ 2.1.277). При противоречии верить ветке.
