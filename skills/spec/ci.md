# CI проекта со скиллом spec — фрагмент workflow

Раздел «Подключение в репозиторий» в `SKILL.md`, п. 4: pnpm (в `package.json`
— `packageManager`), Vitest в 3 шарда, Playwright в 2; concurrency — по
разделу правил «CI: параллельные задачи». Шарды пишут blob-отчёты, job `spec`
склеивает их средствами раннеров и собирает `docs/spec` с `--strict`; на
`main` отдаёт его артефактом job `spec-publish` — у неё одной токен на запись
(без CI на `main` — публикация на мерж PR, раздел в конце).
`spec-diff` — своя лёгкая job после `spec`: git-история, Node и склеенные
отчёты (тесты харнесса видны только в отчёте; база для них — `tests.json`
ветки `spec`).

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
        with: { name: spec-reports, path: ".spec-*.json", retention-days: 1 }

  spec-publish:
    if: github.event_name == 'push'
    needs: spec
    runs-on: ubuntu-latest
    permissions: { contents: write } # пуш ветки spec — только здесь
    concurrency: { group: spec-publish, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v7
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
      - run: node .agents/skills/spec/scripts/spec-diff.ts --base "origin/${{ github.base_ref }}" --report .spec-report.json --report .spec-playwright.json >> "$GITHUB_STEP_SUMMARY"
```

Нет Playwright — без job `e2e`, её шагов в `spec` и второго отчёта в
`spec:doc`. Без шардов — те же шаги в одной job: прогон с JSON-отчётами,
`spec:doc`, артефакт на `main`; `spec-publish` — так же отдельно. ai-dev сам на
Bun — его `.github/workflows/ci.yml` образцом для проекта на Node не служит.

## Без CI на `main` — публикация на мерж PR

Проект, где весь CI — на PR, а тесты на `main` не гоняются, публикует из
прогона самого PR: job `spec` отдаёт `docs/spec` артефактом и на PR, лёгкий
workflow на мерж скачивает его и зовёт `spec-publish`. Есть CI на `main` —
вариант выше: он собирает то, что в `main` действительно оказалось. Нет —
этот, возвращать CI на `main` ради документации не нужно.

В workflow выше: `on` — только `pull_request`, job `spec-publish` нет, а в
job `spec` артефакт `docs-spec` — на каждом прогоне и живёт дольше, чем PR
ждёт мержа:

```yaml
      - uses: actions/upload-artifact@v7
        with: { name: docs-spec, path: docs/spec/, retention-days: 30 }
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
    concurrency: { group: spec-publish, cancel-in-progress: false }
    env:
      GH_TOKEN: ${{ github.token }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha }}
      MERGE_SHA: ${{ github.event.pull_request.merge_commit_sha }}
    steps:
      - uses: actions/checkout@v7
        with: { ref: '${{ github.event.pull_request.merge_commit_sha }}' }
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - name: docs/spec из прогона CI головы PR
        run: |
          run=$(gh run list --workflow ci.yml --commit "$HEAD_SHA" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')
          [ -n "$run" ] || { echo "нет успешного прогона ci.yml на $HEAD_SHA — публиковать нечего" >&2; exit 1; }
          gh run download "$run" --name docs-spec --dir docs/spec
      - run: node .agents/skills/spec/scripts/spec-publish.ts --source "$MERGE_SHA"
```

- `--source` — SHA мержа, а не головы PR: после squash и rebase голова в
  историю `main` не попадает, а `spec-diff` берёт базу тестов харнесса из
  публикации, чей `Source:` — предок merge-base.
- `spec` точна, когда голова PR совпадает с `main` после мержа: отставшую
  ветку GitHub не вольёт — ruleset основной ветки со strict ставит
  `github project fix` (канон, «Git, PR и мерж»). Без него (приватный
  репозиторий на Free) смёржен отставший PR — ветка `spec` откатывается: до
  следующего мержа в ней нет страниц PR, влитого раньше.
- Прогона нет или артефакт истёк — job падает с причиной, `spec` догонит
  следующий мерж.

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
