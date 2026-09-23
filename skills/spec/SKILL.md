---
name: spec
description: Спецификация из тестов — два детерминированных скрипта. spec-doc строит документацию docs/spec из отчётов раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML от bun test) по дереву tests/capabilities/<name> и tests/standards/<name>; spec-diff печатает для тела PR список удалённых, изменённых и добавленных названий тестов между базовой веткой и HEAD. Когда — перед созданием PR (раздел «Спека» в тело PR, обновлённый docs/spec в коммит); в CI на PR и main (проверка, что docs/spec не отстал); когда просят документацию по функциональности, спрашивают «что делает система», «какие требования сняты в этом PR» — даже если слова «спецификация» не прозвучало.
allowed-tools: Bash(bun *skills/spec/scripts/spec-doc.ts *) Bash(bun *skills/spec/scripts/spec-diff.ts *) Bash(bun run spec:*) Bash(bunx vitest run *) Bash(git status *) Bash(git diff *)
---

# spec — документация из названий тестов, дифф спеки в PR

Правило «Спецификация — тесты» (`AGENTS.md`): требование существует, пока есть
тест, который его проверяет. Поэтому документация — это дерево `tests/` и
названия тестов, а дифф тестов в PR — дифф спеки. Два скрипта в `scripts/`
делают это детерминированно, без модели и без конфигурации под репозиторий:

- `spec-doc.ts` — отчёты раннеров → `docs/spec/` (или один документ в stdout);
- `spec-diff.ts` — названия тестов на базовой ветке и в HEAD → три списка для
  тела PR: удалены, изменены, добавлены.

Запуск: `bun <каталог скилла>/scripts/spec-doc.ts …` — Bun запускает TypeScript
без сборки, зависимостей нет (скрипты используют только `node:`-API и идут и
под Node ≥ 22.18). Каталог скилла — тот, где лежит этот
файл (`${CLAUDE_SKILL_DIR}` у Claude Code, `~/.claude/skills/spec`,
`~/.agents/skills/spec` или клон ai-dev). Корень репозитория — `git toplevel`
(или `--root DIR`); дерево — `tests/` в корне.

## Когда что

| Момент | Действие |
|---|---|
| Перед PR | 1. прогон тестов с JSON-отчётом; 2. `spec-doc` → `docs/spec/` в коммит; 3. `spec-diff` → раздел «Спека (тесты)» в тело PR |
| В CI на PR и `main` | прогон → `spec-doc --strict` → `git status --porcelain docs/spec` пуст; на PR ещё `spec-diff` в summary |
| Просят документацию, «что делает система» | `spec-doc <отчёт> --stdout` — один документ, файлы не трогаются |
| Спрашивают, какие требования снял PR | `spec-diff` — список «Удалены» идёт первым |

## Отчёты для spec-doc

Формат определяется по содержимому, несколько отчётов можно передать сразу
(Vitest + Playwright + bun test), одинаковые тесты сливаются.

| Раннер | Команда |
|---|---|
| Vitest (и Jest — формат тот же) | `vitest run --reporter=default --reporter=json --outputFile.json=.spec-report.json` |
| `bun test` | `bun test --reporter=junit --reporter-outfile=.spec-report.xml` — JUnit с вложенными `testsuite` по describe |
| Playwright | `PLAYWRIGHT_JSON_OUTPUT_NAME=.spec-playwright.json playwright test --reporter=json` |

Отчёты — временные файлы, в `.gitignore`. Отчёт из CI с чужими абсолютными
путями годится: путь приводится по сегменту `/tests/`.

## spec-doc

```bash
bun <каталог скилла>/scripts/spec-doc.ts .spec-report.json [ещё отчёты] [--out docs/spec | --stdout] [--strict] [--root DIR]
```

Что получается в `docs/spec/`:

- `README.md` — индекс: «Что делает система» (по capability), «Как построена»
  (по стандарту), счётчики тестов, пропущенных и падающих; раздел «Вне дерева»
  — только если такие тесты есть;
- `capabilities/<name>.md`, `standards/<name>.md` — по файлу на папку:
  `describe` → подзаголовок (вложенность — уровнем глубже), тест — строка
  `- ✅ название`; пропущенный — `⏭️ … — пропущен: <причина>` (причина из
  аннотации Playwright; Vitest и `bun test` причину в отчёт не кладут),
  падающий — `❌ … — падает`, `📝 … — todo`; тест в нескольких проектах
  Playwright — одна строка;
- первая строка каждого файла — маркер `<!-- spec-doc: … -->`: по нему скрипт
  удаляет свои устаревшие файлы (capability исчезла) и не трогает чужие.

`tests/lib` пропускается. Тесты вне `tests/capabilities/<name>` и
`tests/standards/<name>` (в `src/`, в `tests/unit/`, файлом прямо в
`tests/capabilities/`) попадают в «Вне дерева» — это сигнал перенести;
`--strict` при этом возвращает код 1 (для CI). Порядок детерминирован: папки
по имени, файлы по пути, тесты в порядке объявления; описания из нескольких
файлов одной папки сливаются в одно дерево.

## spec-diff

```bash
bun <каталог скилла>/scripts/spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--no-merge-base] [--json] [--root DIR]
```

Сравнивает названия тестов **статически** — разбирает файлы `tests/` на двух
ревизиях через `git show`, прогонять тесты и переключать ветки не нужно.
База — merge-base базовой ветки и HEAD, как дифф PR на GitHub (тест,
добавленный в `main` после ветвления, не считается удалённым);
`--no-merge-base` — сравнение с веткой как есть. `--worktree` — рабочее дерево
вместо HEAD, чтобы посмотреть до коммита. Перед запуском — `git fetch origin`,
иначе `origin/main` устарел.

Идентичность теста — путь папки + цепочка `describe` + `it`: перенос между
файлами одной папки не изменение, перенос в другую папку — удалён и добавлен
(требование сменило дом). Вывод — готовый раздел для тела PR:

```markdown
## Спека (тесты)

_База: `origin/main (merge-base)`._

**Удалены (1):**

- `tests/capabilities/billing` · Счета › черновик удаляется без счёта

**Изменены (1):**

- `tests/capabilities/billing` · Счета › ~~выставляется счёт~~ → выставляется счёт за месяц

**Добавлены (1):**

- `tests/capabilities/billing` · Счета › счёт за неполный месяц пропорционален дням

**Вне дерева `tests/`** изменены файлы тестов: `src/utils/sum.test.ts`.
```

Удалённые — первыми: удалённый тест — снятое требование, это должно быть видно.
«Изменены» — переименования в том же файле: тест с похожим именем в том же
`describe` (похожесть ≥ 0,6) или тот же тест под переименованным `describe`;
непохожее имя — честно удалён и добавлен. Пустой список печатается как
«нет», чтобы было видно, что проверка была. Тесты внутри `tests/`, но вне
capabilities/standards помечены `⚠️ вне дерева`; изменённые файлы тестов вне
`tests/` перечислены по именам. `--json` — то же машинно.

Раздел вставляется в тело PR целиком (после `Closes #N`); при новых коммитах
с тестами — перегенерировать и заменить.

## Подключение в репозиторий

1. Скрипты раннера в `package.json`:
   ```json
   "spec:doc": "vitest run --reporter=default --reporter=json --outputFile.json=.spec-report.json && bun <путь к скиллу>/scripts/spec-doc.ts .spec-report.json --strict",
   "spec:diff": "bun <путь к скиллу>/scripts/spec-diff.ts"
   ```
   В CI скилла на машине нет — чекаут ai-dev рядом (репозиторий публичный):
   `actions/checkout` с `repository: miroshnik/ai-dev` и `path: .ai-dev`, путь
   `.ai-dev/skills/spec/scripts/…`. Локально — `${CLAUDE_SKILL_DIR}` или
   `~/.agents/skills/spec`.
2. `docs/spec/` коммитится вместе с PR: дифф документации виден ревьюеру как
   дифф требований, коммитов от бота нет. `.spec-report.json` — в `.gitignore`.
3. CI (на PR и на `main`; `fetch-depth: 0` — merge-base нужна история):
   ```yaml
   - run: bun run spec:doc
   - name: docs/spec не отстал
     run: |
       if [ -n "$(git status --porcelain docs/spec)" ]; then
         git status --short docs/spec; git diff docs/spec
         echo "::error::docs/spec отстал от тестов — bun run spec:doc и закоммить"; exit 1
       fi
   - name: Дифф спеки в summary
     if: github.event_name == 'pull_request'
     run: bun run spec:diff --base origin/${{ github.base_ref }} >> "$GITHUB_STEP_SUMMARY"
   ```
   Рабочий пример — `.github/workflows/ci.yml` в ai-dev.

## Ограничения, о которых надо знать

- Статический сканер TS/JS берёт имя только из строкового литерала первым
  аргументом `describe` / `it` / `test` (и `x…`/`f…` варианты, `suite`,
  `context`, `test.describe`); `it.each(...)('имя %s')` — имя с плейсхолдером;
  шаблонная строка — как есть, `${…}` не вычисляется; `it(name, …)` с
  переменной пропускается. Модификаторы — только известные (`skip`, `only`,
  `todo`, `each`, `for`, `concurrent`, `serial`, `fixme`, `fails`…):
  `test.step`, `test.use`, `beforeEach` — не тесты. Регулярные выражения с
  `/*` внутри могут сбить сканер — в тестах их не бывает.
- Отчёты Vitest и `bun test` не содержат причины пропуска — держи её в названии
  теста или в комментарии рядом (правило: `skip` без причины и номера issue — ошибка линта).
- Скрипты не оценивают тесты — что падает, скажет раннер. `spec-doc` лишь
  показывает статус; на `main` всё должно быть ✅ или ⏭️ с причиной.
- Обоснование выбора форматов и статического разбора — `reference.md`.
