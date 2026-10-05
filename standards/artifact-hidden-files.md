<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# artifact-hidden-files

Шаг `actions/upload-artifact`, чей путь скрытый — файл или каталог с точкой в начале имени (`.spec-*.json`,
`.spec-journal/`), — стоит с `include-hidden-files: true`. С v4.4 действие по умолчанию пропускает скрытые файлы: без
флага артефакт выходит пустым, шаг лишь предупреждает «No files were found», а падает следующая job — на
`download-artifact` — или идёт без отчёта.

Отчёты и журналы скилла `spec` (`.spec-report.json`, `.spec-playwright.json`, `.spec-journal/`, `.spec-meta/`) —
скрытые. Во фрагменте `skills/spec/ci.md` флаг стоял у журналов, но не у отчётов для `spec-diff` (#318): проект,
скопировавший фрагмент как есть, получал пустой `spec-reports`.

## Правило

Реестр — шаги `actions/upload-artifact` в `.github/workflows/*.yml` и в YAML-фрагментах (блоки кода `yaml`, `yml`)
файлов `skills/**/*.md` и `docs/*.md` — те же места, что у `ci-concurrency`: оттуда фрагменты копируют проекты. Путь
скрытый, если скрыта хоть одна его часть (`out/.cache/report.json`) в любой строке списка путей; `.` и `..` — не
скрытые, исключение `!…` ничего не загружает. Путь без скрытых частей флага не требует: что лежит внутри каталога,
по тексту не видно.

Фрагмент с `upload-artifact`, который не разбирается как YAML, — ошибка, а не пропуск: иначе его шаги выпали бы из
реестра молча.

## Каждая загрузка артефакта со скрытым путём — с include-hidden-files: true

<details><summary>✅ 12 тестов</summary>

- ✅ реестр «шаги actions/upload-artifact в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «шаги actions/upload-artifact в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml artifact «docs-spec», skills/spec/ci.md artifact «spec-journal-unit-${{ matrix.shard }}», skills/spec/ci.md artifact «spec-reports»
- ✅ нарушитель не проходит: отчёты .spec-*.json без include-hidden-files
- ✅ .github/workflows/ci.yml artifact «docs-spec» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «docs-spec-${{ steps.tree.outputs.tree }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «docs-spec» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «playwright-blob-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-journal-e2e-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-journal-unit-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-meta-unit-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-reports» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «vitest-blob-${{ matrix.shard }}» не теряет скрытые файлы

</details>

### примеры

<details><summary>✅ 4 теста</summary>

- ✅ скрытый путь без include-hidden-files — ошибка с файлом и строкой
- ✅ скрытый каталог в середине пути и строка списка путей — тоже скрытые; ./ и исключение ! — нет
- ✅ путь без скрытых частей не требует include-hidden-files
- ✅ фрагмент с upload-artifact, который не разбирается, — ошибка, а не пропуск

</details>
