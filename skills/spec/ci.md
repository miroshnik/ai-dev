# CI проекта со скиллом spec — фрагмент workflow

Раздел «Подключение в репозиторий» в `SKILL.md`, п. 4: pnpm (в `package.json`
— `packageManager`), Vitest в 3 шарда, Playwright в 2; concurrency — по
`docs/ci-concurrency.md`. Шарды пишут blob-отчёты, job `spec`
склеивает их средствами раннеров и собирает `docs/spec` с `--strict`; на
`main` отдаёт его артефактом job `spec-publish` — у неё одной токен на запись
(без CI на `main` — публикация на мерж PR, раздел в конце).
`spec-diff` — своя лёгкая job после `spec`: git-история, Node и склеенные
отчёты (тесты харнесса видны только в отчёте; база для них — `tests.json`
ветки `spec`). Отчёт сверки `.spec-claims.xml` — туда же: его тесты есть в
`tests.json`, и без отчёта они в каждом PR выходят «удалены».

```yaml
on:
  pull_request:
  push:
    branches: [main]

concurrency: # main — своя группа у прогона: не ждёт и не вытесняется, очередь — у spec-publish
  group: ci-${{ github.event.pull_request.number || github.run_id }}
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
      - uses: actions/upload-artifact@v7 # журнал точек входа — для spec-claims
        with: { name: 'spec-journal-unit-${{ matrix.shard }}', path: .spec-journal/, retention-days: 1, include-hidden-files: true }
      - uses: actions/upload-artifact@v7 # код примеров и причины исключений — для spec-doc
        with: { name: 'spec-meta-unit-${{ matrix.shard }}', path: .spec-meta/, retention-days: 1, include-hidden-files: true }

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
      - uses: actions/upload-artifact@v7
        with: { name: 'spec-journal-e2e-${{ matrix.shard }}', path: .spec-journal/, retention-days: 1, include-hidden-files: true }

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
      - uses: actions/download-artifact@v8
        with: { pattern: spec-journal-*, path: .spec-journal, merge-multiple: true }
      - uses: actions/download-artifact@v8
        with: { pattern: spec-meta-*, path: .spec-meta, merge-multiple: true }
      - run: pnpm spec:claims # каждая точка входа вызвана тестом capability; отчёт — в spec:doc
      - run: pnpm exec vitest --merge-reports=vitest-blob --reporter=json --outputFile.json=.spec-report.json
      - run: pnpm exec playwright merge-reports --reporter=json playwright-blob
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: .spec-playwright.json }
      - run: pnpm spec:doc
      - if: github.event_name == 'push'
        uses: actions/upload-artifact@v7
        with: { name: docs-spec, path: docs/spec/, retention-days: 1 }
      - if: github.event_name == 'pull_request'
        uses: actions/upload-artifact@v7
        with:
          name: spec-reports
          path: |
            .spec-*.json
            .spec-claims.xml
          retention-days: 1
          include-hidden-files: true

  spec-publish:
    if: github.event_name == 'push'
    needs: spec
    runs-on: ubuntu-latest
    permissions: { contents: write } # пуш ветки spec — только здесь
    concurrency: { group: spec-publish, queue: max } # ожидающая публикация не вытесняется следующей
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 } # прогоны main параллельны: история — для «уже новее»
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - uses: actions/download-artifact@v8
        with: { name: docs-spec, path: docs/spec }
      - run: node .agents/skills/spec/scripts/spec-publish.ts

  spec-diff:
    if: github.event_name == 'pull_request'
    needs: spec
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 } # merge-base с базовой веткой и ветка spec
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - uses: actions/download-artifact@v8
        with: { name: spec-reports }
      - run: node .agents/skills/spec/scripts/spec-diff.ts --base "origin/${{ github.base_ref }}" --report .spec-report.json --report .spec-playwright.json --report .spec-claims.xml --full >> "$GITHUB_STEP_SUMMARY"
```

Отчёты и журналы `.spec-*` — скрытые файлы: `upload-artifact` их пропускает
без `include-hidden-files: true`, и артефакт выходит пустым.

Нет Playwright — без job `e2e`, её шагов в `spec` и второго отчёта в
`spec:doc`. Без шардов — те же шаги в одной job: прогон с JSON-отчётами,
`spec:doc`, артефакт на `main`; `spec-publish` — так же отдельно. ai-dev сам на
Bun — его `.github/workflows/ci.yml` образцом для проекта на Node не служит.

Прогон `main` — в своей группе (`github.run_id`): тестам общий ресурс не
нужен, а `queue: max` с отменой прогонов PR в одном workflow не сочетается.
Очередь — только у `spec-publish`; публикации идут не по порядку мержей, и
старую поверх новой не пускает «уже новее» — поэтому checkout с историей.
Деплою в этом же workflow так нельзя — ему нужен порядок мержей: отдельный
workflow (`docs/ci-concurrency.md`).

## Без CI на `main` — публикация на мерж PR

Проект, где весь CI — на PR, а тесты на `main` не гоняются, публикует из
прогона самого PR: job `spec` отдаёт `docs/spec` артефактом и на PR, лёгкий
workflow на мерж скачивает его и зовёт `spec-publish`. Есть CI на `main` —
вариант выше: он собирает то, что в `main` действительно оказалось. Нет —
этот, возвращать CI на `main` ради документации не нужно.

В workflow выше: `on` — только `pull_request`, job `spec-publish` нет, а в
job `spec` артефакт — на каждом прогоне, назван по дереву, которое прогон
проверил, и живёт дольше, чем PR ждёт мержа:

```yaml
      - id: tree # дерево, которое проверил прогон: merge-ref PR
        run: echo "tree=$(git rev-parse 'HEAD^{tree}')" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@v7
        with: { name: 'docs-spec-${{ steps.tree.outputs.tree }}', path: docs/spec/, retention-days: 30 }
```

Публикация — свой workflow, `.github/workflows/spec-publish.yml`:

```yaml
on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  spec-publish:
    if: github.event.pull_request.merged == true # закрытый без мержа PR не публикует
    runs-on: ubuntu-latest
    permissions: { contents: write, actions: read } # пуш ветки spec, артефакт прогона PR
    concurrency: { group: spec-publish, queue: max } # ожидающая публикация не вытесняется следующей
    env:
      GH_TOKEN: ${{ github.token }}
      MERGE_SHA: ${{ github.event.pull_request.merge_commit_sha }}
    steps:
      - uses: actions/checkout@v7
        with: { ref: '${{ github.event.pull_request.merge_commit_sha }}', fetch-depth: 0 } # история — для «уже новее»
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - name: docs/spec из прогона, проверившего дерево мержа
        run: |
          tree=$(git rev-parse 'HEAD^{tree}')
          run=$(node .agents/skills/spec/scripts/spec-run.ts --tree "$tree")
          [ -n "$run" ] || exit 0 # пропуск: причина — строкой spec-run выше
          gh run download "$run" --name "docs-spec-$tree" --dir docs/spec
          node .agents/skills/spec/scripts/spec-publish.ts --source "$MERGE_SHA"
```

- Публикуется только дерево, проверенное целиком: артефакт назван по дереву
  merge-ref, которое гонял прогон PR, публикация ищет его по дереву коммита
  мержа. В `main` между стартом прогона и мержем ничего не влили — деревья
  равны при merge, squash и rebase. Влит отставший PR — такого артефакта
  нет: `spec-run` пишет «дерево main не проверено целиком — публикация
  пропущена», job зелёный, ветка `spec` отстаёт до следующего мержа с
  совпавшим деревом, но не откатывается. Актуальности ветки от PR это не
  требует.
- Артефакт — ещё не зелёный прогон: `spec-run` берёт прогон только этого
  репозитория (не форка) с исходом `success`; идущий ждёт (потолок
  `--timeout`, 30 мин), к потолку не завершился — job падает с причиной.
- `--source` — SHA мержа, а не головы PR: после squash и rebase голова в
  историю `main` не попадает, а `spec-diff` берёт базу тестов харнесса из
  публикации, чей `Source:` — предок merge-base.
- `spec-publish` не публикует поверх более нового: `Source:` опубликованного
  — потомок нового исходника → «уже новее», код 0; для этого checkout — с
  историей.
- После пропуска публикация старше merge-base следующих PR — `spec-diff`
  говорит это строкой под «База».

## Хостинг собирает каждую ветку

Vercel (и любой хостинг с git-интеграцией на все ветки) собирает и ветку
`spec` — по конфигу из её дерева, где нет ни кода, ни `package.json`: на
каждой публикации — упавшая сборка и письмо о ней. Конфиг без деплоя
кладётся в `docs/spec` перед `spec-publish` (в обоих вариантах выше):

```yaml
      - name: Ветка spec — без деплоя Vercel
        run: |
          echo '{ "git": { "deploymentEnabled": false } }' > docs/spec/vercel.json
```

`vercel.json` основной ветки на `spec` не действует: у неё своё дерево.
