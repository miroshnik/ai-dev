# ai-dev

Общие правила и скиллы для всех моих проектов — для любого агента (Claude
Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp) и любого аккаунта.

## Установка

```bash
npx -y github:miroshnik/ai-dev install            # в проект: корень git
npx -y github:miroshnik/ai-dev install -g         # на машину
node ~/Projects/ai-dev/bin/ai-dev.mjs install -g --link   # из клона: симлинки, правки видны сразу
```

**В проект** — всё копией в `.agents/`, коммитится вместе с проектом:
облачная сессия (claude.ai/code видит только репозиторий), коллеги и CI
получают ровно эту версию.

- `.agents/ai-dev/` — `AGENTS.md`, `claude/CLAUDE.md`, `docs/*.md`;
  `.agents/skills/<name>/` — все скиллы; `.agents/ai-dev.json` — что
  поставлено (переустановка убирает скиллы, которых в ai-dev больше нет).
- Claude Code — симлинки `.claude/rules/ai-dev.md`, `.claude/rules/ai-dev-claude.md`
  (грузятся сами, при любом `CLAUDE.md` проекта) и `.claude/skills/<name>`.
- Остальные агенты — блок в начале `AGENTS.md` проекта со ссылкой на
  `.agents/ai-dev/AGENTS.md` (целиком он не влезет в 32 КиБ Codex) и
  `.agents/skills/` — общая точка скиллов Codex, Gemini CLI, Cursor, Copilot,
  OpenCode, Amp.
- Обновление — та же команда и PR с новой копией; `.agents/` и `.claude/`
  исключить из линтеров и форматтеров проекта.

**На машину** (`-g`) — `~/.agents/ai-dev`, `~/.agents/skills` и агенты, которые
есть: Claude Code (`~/.claude/rules`, `~/.claude/skills`), Codex
(`~/.codex/AGENTS.md`), Gemini CLI (`~/.gemini/GEMINI.md`), Copilot CLI
(`~/.copilot/copilot-instructions.md`), OpenCode и Amp
(`~/.config/<агент>/AGENTS.md`) — симлинки на `~/.agents/ai-dev/AGENTS.md`;
Cursor глобального файла не имеет (вставить правила в User Rules один раз).
Чужой непустой файл не трогает; старый симлинк `~/.claude/CLAUDE.md` от
`install.sh` убирает. `AI_DEV_PRIVATE=<путь>` дополнительно линкует личную
конфигурацию в `~/.config/ai-dev`.

## Что внутри

- `AGENTS.md` — канон правил (ведение задач в GitHub Issues + Projects,
  milestones, оценка и факт, спецификация тестами, CI).
- `claude/CLAUDE.md` — то, что есть только у Claude Code.
- `docs/` — справочники к правилам (`github-projects.md`, `ci-concurrency.md`,
  `pr-checks.md`); правила ссылаются на них, агент читает по мере надобности.
- `skills/<name>/` — скиллы по стандарту [Agent Skills](https://agentskills.io):
  `SKILL.md` (frontmatter + процедура) и `scripts/` (детерминированная часть).
  Скрипты — TypeScript под Bun (`bun script.ts`, без сборки и зависимостей).
  Тесты скриптов — `bun test` в `tests/`
  (`bun install`, `bun test`, `bun run typecheck`, `bun run spec:doc` —
  документация `docs/spec/` из названий тестов).
- `bin/ai-dev.mjs` — установщик; JavaScript без зависимостей: npx запускает
  его из `node_modules`, где Node типы не стирает.

`AGENTS.md` держим компактным: у Codex общий бюджет 32 КиБ на все `AGENTS.md`
от корня проекта до текущего каталога, лишнее обрезается молча (глобальный
`~/.codex/AGENTS.md` в бюджет не входит).

Всё, что зависит от конкретных репозиториев (какие есть, где лежат, номера
проектов, способ мержа, доступы), живёт в отдельном приватном репозитории:
`install -g` с `AI_DEV_PRIVATE=<его чекаут>` делает `~/.config/ai-dev`
симлинком на него (реестр `repos.json` для `est`, заметки по репозиториям,
чек-лист доступов без секретов). В публичном репозитории этого нет.

Скиллы:

- `est` — оценка задач по истории проекта (аналоги с фактом, коэффициент k) и
  факт в активных часах из транскриптов сессий.
- `ci-wait` — ожидание чеков PR или статуса коммита с исходами
  PASS / FAIL / TIMEOUT / ERROR вместо `gh pr checks --watch`.
- `spec` — спецификация из тестов: `spec-doc` строит `docs/spec/` из отчётов
  раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML от bun test) по дереву
  `tests/capabilities` и `tests/standards`; `spec-diff` — список удалённых,
  изменённых и добавленных названий тестов для тела PR.

Задачи по этому репозиторию — в Issues и проекте `ai-dev`, по правилам из
`AGENTS.md`.
