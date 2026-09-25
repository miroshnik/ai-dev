---
name: spec
description: Спецификация из тестов — два детерминированных скрипта. spec-doc строит документацию docs/spec из отчётов раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML от bun test) по дереву tests/capabilities/<name> и tests/standards/<name>, с прозой из JSDoc тестов; spec-diff печатает для тела PR список удалённых, изменённых и добавленных названий тестов между базовой веткой и HEAD. Когда — перед созданием PR (раздел «Спека» в тело PR, обновлённый docs/spec в коммит); в CI на PR и main (проверка, что docs/spec не отстал); когда проект подключает spec к своему CI (копия скилла в проекте, Node без Bun, шарды Vitest и Playwright); когда просят документацию по функциональности, спрашивают «что делает система», «какие требования сняты в этом PR» — даже если слова «спецификация» не прозвучало.
allowed-tools: Bash(bun *skills/spec/scripts/spec-doc.ts *) Bash(bun *skills/spec/scripts/spec-diff.ts *) Bash(bun run spec:*) Bash(node *skills/spec/scripts/spec-doc.ts *) Bash(node *skills/spec/scripts/spec-diff.ts *) Bash(pnpm spec:*) Bash(bunx vitest run *) Bash(git status *) Bash(git diff *)
---

# spec — документация из названий тестов, дифф спеки в PR

Правило «Спецификация — тесты» (`AGENTS.md`): требование существует, пока есть
тест, который его проверяет. Поэтому документация — это дерево `tests/` и
названия тестов, а дифф тестов в PR — дифф спеки. Два скрипта в `scripts/`
делают это детерминированно, без модели и без конфигурации под репозиторий:

- `spec-doc.ts` — отчёты раннеров и JSDoc тестов → `docs/spec/` (или один
  документ в stdout);
- `spec-diff.ts` — названия тестов на базовой ветке и в HEAD → три списка для
  тела PR: удалены, изменены, добавлены.

Запуск: `bun <каталог скилла>/scripts/spec-doc.ts …` — Bun запускает TypeScript
без сборки, зависимостей нет (скрипты используют только `node:`-API и идут и
под Node ≥ 22.18). Каталог скилла — тот, где лежит этот
файл (`${CLAUDE_SKILL_DIR}` у Claude Code, `~/.claude/skills/spec`,
`~/.agents/skills/spec`, `.agents/skills/spec` проекта или клон ai-dev). Корень репозитория — `git toplevel`
(или `--root DIR`); дерево — `tests/` в корне. В репозитории, подключённом по
разделу «Подключение в репозиторий», — его `spec:doc` и `spec:diff`, а не
скрипты из каталога скилла: там версия, закреплённая за CI.

## Когда что

| Момент | Действие |
|---|---|
| Перед PR | 1. прогон тестов с JSON-отчётом; 2. `spec-doc` → `docs/spec/` в коммит; 3. `spec-diff` → раздел «Спека (тесты)» в тело PR |
| В CI на PR и `main` | прогон → `spec-doc --strict` → `git status --porcelain docs/spec` пуст; на PR ещё `spec-diff` в summary |
| Просят документацию, «что делает система» | `spec-doc <отчёт> --stdout` — один документ, файлы не трогаются |
| Спрашивают, какие требования снял PR | `spec-diff` — список «Удалены» идёт первым |
| Проект переходит на тест-спек | раздел «Подключение в репозиторий»: установка флоу, скрипты под Node, workflow |

## Отчёты для spec-doc

Формат определяется по содержимому, несколько отчётов можно передать сразу
(Vitest + Playwright + bun test), одинаковые тесты сливаются.

| Раннер | Команда |
|---|---|
| Vitest (и Jest — формат тот же) | `vitest run --reporter=default --reporter=json --outputFile.json=.spec-report.json` |
| `bun test` | `bun test --reporter=junit --reporter-outfile=.spec-report.xml` — JUnit с вложенными `testsuite` по describe |
| Playwright | `PLAYWRIGHT_JSON_OUTPUT_NAME=.spec-playwright.json playwright test --reporter=json` |

Отчёты — временные файлы, в `.gitignore`. Отчёт из CI с чужими абсолютными
путями годится: путь приводится по сегменту `/tests/`. Шарды склеивает сам
раннер (blob-отчёты → один JSON, раздел «Подключение в репозиторий»); отчёты
шардов по отдельности не передавать — Playwright делит файл между шардами, и
порядок тестов в файле зависел бы от порядка отчётов.

## spec-doc

```bash
bun <каталог скилла>/scripts/spec-doc.ts .spec-report.json [ещё отчёты] [--out docs/spec | --stdout] [--strict] [--root DIR]
```

Что получается в `docs/spec/`:

- `README.md` — индекс: «Что делает система» (по capability), «Как построена»
  (по стандарту); у каждой ссылки — первый абзац JSDoc файла (описание) и,
  если есть, число пропущенных и падающих; раздел «Вне дерева» — только если
  такие тесты есть;
- `capabilities/<name>.md`, `standards/<name>.md` — по файлу на папку:
  заголовок — имя папки, под ним проза; `describe` → подзаголовок
  (вложенность — уровнем глубже), тест — строка `- ✅ название`; пропущенный
  — `⏭️ … — пропущен: <причина>` (причина из аннотации Playwright; Vitest и
  `bun test` причину в отчёт не кладут), падающий — `❌ … — падает`,
  `📝 … — todo`; тест в нескольких проектах Playwright — одна строка. Строки
  «раздел · путь · N тестов» нет: раздел и путь следуют из конвенции.
  Названия — текст: `<` вне code span экранируется, иначе GitHub съест
  `<type>` или `<!-- … -->` как HTML (так же в `spec-diff`);
- первая строка каждого файла — маркер `<!-- spec-doc: … -->`: по нему скрипт
  удаляет свои устаревшие файлы (capability исчезла) и не трогает чужие.

`tests/lib` пропускается. Тесты вне `tests/capabilities/<name>` и
`tests/standards/<name>` (в `src/`, в `tests/unit/`, файлом прямо в
`tests/capabilities/`) попадают в «Вне дерева» — это сигнал перенести;
`--strict` при этом возвращает код 1 (для CI). Порядок детерминирован: папки
по имени, файлы по пути, тесты в порядке объявления; описания из нескольких
файлов одной папки сливаются в одно дерево.

### Проза — JSDoc

Имя папки и `describe` часто не объясняют, что это и зачем, — короткая проза
пишется JSDoc-комментарием `/** … */` в самом тесте, `spec-doc` переносит её
в документацию (отчёты раннеров комментариев не несут — он читает исходники
тем же сканером, что `spec-diff`):

| Где JSDoc | Куда в `docs/spec` |
|---|---|
| в начале файла, до импортов | абзацы под заголовком capability / стандарта; первый — описание в индексе |
| вплотную перед `describe` | абзац под его подзаголовком |
| вплотную перед `it` / `test` | цитата `>` под строкой теста |

```ts
/**
 * Биллинг: счета клиентам за месяц и их оплата.
 *
 * Счёт выставляется автоматически в первый день месяца; ручной — исключение.
 */
import { describe, it } from "vitest";

/** Неполный месяц считается пропорционально дням. */
describe("Счета", () => { … });
```

- Проза — там, где имени мало: одна-три фразы, не пересказ теста. Первый
  абзац у файла — одна фраза: он идёт в оглавление. Непонятное имя `it` —
  переписать, а не объяснять.
- `//` и `/* … */` в документацию не идут: причины решений и отвергнутые
  альтернативы — для читателя кода. Блочные теги (`@see`, `@param`) и всё
  после первого из них — тоже.
- JSDoc относится к ближайшему коду: между ним и `describe`/`it` — только
  пробелы и комментарии. Первый JSDoc файла, за которым идёт не вызов
  (импорты), — проза capability; в файле без импортов JSDoc вплотную к
  первому `describe` — проза этого `describe`.
- Описание capability пишется в одном файле папки; если в нескольких — абзацы
  идут по порядку путей, в индексе — первый.
- Исходник читается по пути из отчёта от корня (`--root`); нет файла (отчёт с
  другой машины) — документация без прозы, в stderr список таких файлов.

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

Скрипты берутся из копии скилла в самом проекте и идут под Node — Bun проекту
на Node не нужен. Копию ставит установка флоу ai-dev, и она коммитится: агент
перед PR и CI зовут одни и те же `spec:doc` / `spec:diff` проекта над одними и
теми же файлами, поэтому `docs/spec`, собранный локально, совпадает с
проверкой в CI. Почему копия, а не подмодуль, чекаут в workflow или пакет —
`reference.md`.

1. **Установка** в корне проекта, результат (`.agents/`, `.claude/`, блок в
   `AGENTS.md`) — в коммит:
   ```bash
   npx -y github:miroshnik/ai-dev install
   ```
   - `.agents/` и `.claude/` исключить из линтеров и форматтеров проекта
     (`ignores` в ESLint, `.prettierignore`, `include` в tsconfig): там код и
     Markdown ai-dev.
   - Обновление — та же команда отдельным PR, потом отчёты и `spec:doc`;
     поменялся формат — новый `docs/spec` едет в том же PR.
2. **Скрипты** в `package.json` — через `node`: Node ≥ 22.18 стирает типы сам,
   `scripts/package.json` скилла задаёт ESM при любом `type` проекта. Отчёты —
   те, что есть в проекте:
   ```json
   "spec:doc": "node .agents/skills/spec/scripts/spec-doc.ts .spec-report.json .spec-playwright.json --strict",
   "spec:diff": "node .agents/skills/spec/scripts/spec-diff.ts"
   ```
   Перед `spec:doc` локально — полный прогон с отчётами (раздел «Отчёты для
   spec-doc»). В `.gitignore`: `.spec-*.json`, `vitest-blob/`, `blob-report/`,
   `playwright-blob/`.
3. **`docs/spec/` коммитится вместе с PR:** дифф документации виден ревьюеру
   как дифф требований, коммитов от бота нет.
4. **CI.** Шарды пишут blob-отчёты, отдельная job `spec` после всех шардов
   склеивает их средствами раннеров (`vitest --merge-reports`,
   `playwright merge-reports` — все проекты Playwright в одном отчёте) и
   проверяет, что `docs/spec` не отстал. Упал тест — `spec` не запускается:
   сверять документацию с красным прогоном незачем. `spec-diff` — своя лёгкая
   job: ей нужны git-история и Node, не тесты, поэтому раздел в summary есть и
   при красных тестах. Фрагмент для pnpm (в `package.json` —
   `packageManager`), Vitest в 3 шарда, Playwright в 2; concurrency — по
   разделу правил «CI: параллельные задачи»:
   ```yaml
   on:
     pull_request:
     push:
       branches: [main]

   concurrency:
     group: ci-${{ github.event.pull_request.number || github.ref }}
     cancel-in-progress: ${{ github.event_name == 'pull_request' }}

   jobs:
     unit:
       runs-on: ubuntu-latest
       strategy:
         fail-fast: false
         matrix: { shard: [1, 2, 3] }
       steps:
         - uses: actions/checkout@v7
         - uses: pnpm/action-setup@v6
         - uses: actions/setup-node@v7
           with: { node-version: 24, cache: pnpm }
         - run: pnpm install --frozen-lockfile
         - run: >-
             pnpm exec vitest run --shard=${{ matrix.shard }}/${{ strategy.job-total }}
             --reporter=default --reporter=blob --outputFile.blob=vitest-blob/${{ matrix.shard }}.json
         - uses: actions/upload-artifact@v7
           with: { name: 'vitest-blob-${{ matrix.shard }}', path: vitest-blob/, retention-days: 1 }

     e2e:
       runs-on: ubuntu-latest
       strategy:
         fail-fast: false
         matrix: { shard: [1, 2] }
       steps:
         - uses: actions/checkout@v7
         - uses: pnpm/action-setup@v6
         - uses: actions/setup-node@v7
           with: { node-version: 24, cache: pnpm }
         - run: pnpm install --frozen-lockfile
         - run: pnpm exec playwright install --with-deps
         - run: pnpm exec playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }} --reporter=dot,blob
         - uses: actions/upload-artifact@v7
           with: { name: 'playwright-blob-${{ matrix.shard }}', path: blob-report/, retention-days: 1 }

     spec:
       needs: [unit, e2e]
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
         - uses: pnpm/action-setup@v6
         - uses: actions/setup-node@v7
           with: { node-version: 24, cache: pnpm }
         - run: pnpm install --frozen-lockfile
         - uses: actions/download-artifact@v8
           with: { pattern: vitest-blob-*, path: vitest-blob, merge-multiple: true }
         - uses: actions/download-artifact@v8
           with: { pattern: playwright-blob-*, path: playwright-blob, merge-multiple: true }
         - run: pnpm exec vitest --merge-reports=vitest-blob --reporter=json --outputFile.json=.spec-report.json
         - run: pnpm exec playwright merge-reports --reporter=json playwright-blob
           env: { PLAYWRIGHT_JSON_OUTPUT_NAME: .spec-playwright.json }
         - run: pnpm spec:doc
         - name: docs/spec не отстал от тестов
           run: |
             if [ -n "$(git status --porcelain docs/spec)" ]; then
               git status --short docs/spec; git diff docs/spec
               echo "::error::docs/spec отстал от тестов — прогон с отчётами, pnpm spec:doc и закоммить"; exit 1
             fi

     spec-diff:
       if: github.event_name == 'pull_request'
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
           with: { fetch-depth: 0 } # merge-base с базовой веткой
         - uses: actions/setup-node@v7
           with: { node-version: 24, package-manager-cache: false }
         - run: node .agents/skills/spec/scripts/spec-diff.ts --base "origin/${{ github.base_ref }}" >> "$GITHUB_STEP_SUMMARY"
   ```
   Нет Playwright — без job `e2e`, её шагов в `spec` и второго отчёта в
   `spec:doc`. Без шардов — те же шаги в одной job: прогон с JSON-отчётами из
   таблицы выше, `spec:doc`, проверка. ai-dev сам на Bun — его
   `.github/workflows/ci.yml` образцом для проекта на Node не служит.

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
- Прозу `it.each` и `describe.each` сканер знает под именем с плейсхолдером
  (`сумма %i + %i`), а отчёт — под подставленным; такие JSDoc в документацию
  не попадают.
- Скрипты не оценивают тесты — что падает, скажет раннер. `spec-doc` лишь
  показывает статус; на `main` всё должно быть ✅ или ⏭️ с причиной.
- Обоснование выбора форматов и статического разбора — `reference.md`.
