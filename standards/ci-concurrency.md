<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# ci-concurrency

Блок `concurrency` с общей группой — не своей у PR или прогона — стоит с `queue: max`: иначе GitHub держит в группе
один ожидающий прогон и вытесняет его следующим, и прогон `main` получает статус cancelled.

Правило записано в `docs/ci-concurrency.md`, но без проверки каждый новый фрагмент повторял ошибку: правило (#6), job
деплоя без `queue: max` (#296), `spec-publish` и группа прогона `main` (#307) — трижды одно и то же. Проверка идёт по
тем местам, откуда ошибка расходится: workflow ai-dev и YAML-фрагменты справочников и скиллов, которые проекты
копируют.

## Правило

Реестр — блоки `concurrency` workflow и job в `.github/workflows/*.yml` и в YAML-фрагментах (блоки кода `yaml`,
`yml`) файлов `skills/**/*.md` и `docs/*.md`. Блок соблюдает правило, если у него `queue: max` или группа своя на
каждом событии `on:` его workflow:

- `github.run_id` — своя у прогона на любом событии;
- номер PR (`github.event.pull_request.number`, `github.event.number`) и `github.head_ref` — своя на `pull_request` и
  `pull_request_target`, вне PR пусто — работает запасное после `||`;
- `github.ref` — своя только на `pull_request` (`refs/pull/<N>/merge`); на `pull_request_target` это ветка базы, на
  push — ветка: общая;
- литерал и остальное — общая.

Группа своя, если своё хоть одно её выражение `${{ … }}`. Фрагмент без `on:` идёт под любым событием — проверяется и
на PR, и на push. Поэтому `ci-${{ github.event.pull_request.number || github.ref }}` своя в workflow только на
`pull_request` и общая, как только в `on:` есть push в `main`.

## «CI и деплой в одном workflow» — вне охвата

Вариант из `docs/ci-concurrency.md` для workflow, где CI и деплой ещё не разнесены, вытесняет ожидающий прогон
намеренно: `queue: max` несовместим с `cancel-in-progress` прогонов PR, а своя группа у прогона пустила бы деплои
`main` параллельно. Цена записана там же, рядом — совет разнести. Исключением с задачей он не стал: долга, который
задача сняла бы, нет — это описанный компромисс, а не нарушение.

## Каждый блок concurrency с общей группой — queue: max

<details><summary>✅ 13 тестов</summary>

- ✅ реестр «блоки concurrency в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «блоки concurrency в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml jobs.spec-publish.concurrency «spec-publish», docs/ci-concurrency.md concurrency «cd-${{ github.ref }}», docs/ci-concurrency.md jobs.deploy-dev.concurrency «deploy-dev», skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish»
- ✅ нарушитель не проходит: прогон main в группе по PR с запасным github.ref
- ✅ нарушитель не проходит: job с общей группой без queue: max
- ✅ .github/workflows/ci.yml concurrency «ci-${{ github.event.pull_request.number || github.run_id }}» не вытесняет ожидающий прогон
- ✅ .github/workflows/ci.yml jobs.spec-publish.concurrency «spec-publish» не вытесняет ожидающий прогон
- ✅ docs/ci-concurrency.md concurrency «cd-${{ github.ref }}» не вытесняет ожидающий прогон
- ✅ docs/ci-concurrency.md concurrency «ci-${{ github.event.pull_request.number || github.ref }}» не вытесняет ожидающий прогон
- ✅ docs/ci-concurrency.md jobs.deploy-dev.concurrency «deploy-dev» не вытесняет ожидающий прогон
- ✅ skills/spec/ci.md concurrency «ci-${{ github.event.pull_request.number || github.run_id }}» не вытесняет ожидающий прогон
- ✅ skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish» (2) не вытесняет ожидающий прогон
- ✅ skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish» не вытесняет ожидающий прогон
- ✅ вне охвата: docs/ci-concurrency.md concurrency «${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}»
  > вариант «CI и деплой в одном workflow» docs/ci-concurrency.md: queue: max несовместим с cancel-in-progress прогонов PR, а своя группа у прогона пустила бы деплои main параллельно; вытеснение ожидающего прогона — записанная цена варианта, там же сказано, что CI и деплой разносят

</details>

### примеры

<details><summary>✅ 8 тестов</summary>

- ✅ общая группа без queue: max — ошибка с файлом и строкой
- ✅ общая группа с queue: max — блоком и строкой job — не вытесняет
- ✅ группа по PR с запасным github.ref в workflow только на pull_request — своя
- ✅ запасное run_id — своя группа у прогона main
- ✅ github.ref своя только у pull_request: у pull_request_target это ветка базы
- ✅ фрагмент без on: идёт под любым событием — группа по PR без запасного run_id общая
- ✅ concurrency в тексте скрипта и в прозе — не блок
- ✅ одинаковые блоки одного файла различает номер

</details>
