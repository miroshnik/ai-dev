# ai-dev

Общие правила и скиллы для всех моих проектов — для любого агента (Claude
Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp) и любого аккаунта.

- `AGENTS.md` — канон правил (ведение задач в GitHub Issues + Projects,
  milestones, оценка и факт, CI). Агенты читают его напрямую или через
  импорт из своего файла.
- `claude/CLAUDE.md` — файл Claude Code: импорт `@../AGENTS.md` плюс то, что
  есть только у него. В `~/.claude/CLAUDE.md` — симлинк сюда.
- `docs/` — справочники к правилам (`github-projects.md`, `ci-concurrency.md`,
  `pr-checks.md`); правила ссылаются на них, агент читает по мере надобности.
- `skills/<name>/` — скиллы по стандарту [Agent Skills](https://agentskills.io):
  `SKILL.md` (frontmatter + процедура) и `scripts/` (детерминированная часть).
  Симлинки — в `~/.claude/skills/` (Claude Code) и `~/.agents/skills/`
  (Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp); без клона —
  `npx skills add miroshnik/ai-dev -g --all`.
- `install.sh` — подключает правила и скиллы всем агентам, которые нашёл:
  Claude Code (`~/.claude/CLAUDE.md`, `~/.claude/skills/*`), Codex
  (`~/.codex/AGENTS.md`), Gemini CLI (`~/.gemini/GEMINI.md`), Copilot CLI
  (`~/.copilot/copilot-instructions.md`), OpenCode и Amp (`~/.config/<агент>/AGENTS.md`),
  скиллы для всех — `~/.agents/skills/*`; Cursor глобального файла не имеет
  (вставить правила в User Rules один раз). Идемпотентен; чужой непустой файл
  не трогает. `AI_DEV_PRIVATE=<путь>` дополнительно линкует личную
  конфигурацию в `~/.config/ai-dev`.

Два способа установки: клон + `./install.sh` (живые симлинки, правки видны
сразу) или без клона `npx skills add miroshnik/ai-dev -g --all` (копия
скиллов во все агенты; правила тогда подключаются вручную).

`AGENTS.md` держим компактным: у Codex общий бюджет 32 КиБ на все `AGENTS.md`
от корня проекта до текущего каталога, лишнее обрезается молча (глобальный
`~/.codex/AGENTS.md` в бюджет не входит).

Всё, что зависит от конкретных репозиториев (какие есть, где лежат, номера
проектов, способ мержа, доступы), живёт в отдельном приватном репозитории:
`install.sh` с `AI_DEV_PRIVATE=<его чекаут>` делает `~/.config/ai-dev`
симлинком на него (реестр `repos.json` для `est`, заметки по репозиториям,
чек-лист доступов без секретов). В публичном репозитории этого нет.

Скиллы:

- `est` — оценка задач по истории проекта (аналоги с фактом, коэффициент k) и
  факт в активных часах из транскриптов сессий.
- `ci-wait` — ожидание чеков PR или статуса коммита с исходами
  PASS / FAIL / TIMEOUT / ERROR вместо `gh pr checks --watch`.
- `openspec` — работа по OpenSpec: поэтапный флоу с утверждениями, дельты
  спек, когда архивировать; `reference.md` — ловушки парсера и валидатора.

Задачи по этому репозиторию — в Issues и проекте `ai-dev`, по правилам из
`AGENTS.md`.
