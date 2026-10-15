<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# spec-publish-job

Публикацию спеки среди чеков `github` и `ci-wait` узнают одинаково: на вопрос «check-run `<имя>` — публикация спеки?»
оба скрипта отвечают по одной таблице, а job публикации во фрагментах CI скилла `spec` и в CI Elves назван так, что
правило его узнаёт.

Job публикации выкладывает документацию в ветку `spec` и ничего не проверяет (#443): `github pr premerge` не считает
его красный красным `main`, `wait-ci.sh` его не ждёт и не даёт по нему FAIL. Правило живёт в двух копиях —
`SPEC_PUBLISH` в `skills/github/scripts/github.ts` (регулярка JS) и `SPEC_PUBLISH` в `skills/ci-wait/scripts/wait-ci.sh`
(строка для `test()` jq), а имя job задают фрагменты `skills/spec/ci.md` и `.github/workflows/ci.yml`. Общего модуля
нет: `github` и `ci-wait` других скиллов не импортируют (стандарт `skill-imports`), а `wait-ci.sh` — bash и jq, импорта
TypeScript у него нет. Без проверки
копии связаны только комментариями: поправленная одна копия или переименованный во фрагменте job — тесты каждого
скрипта зелёные, а ложный «`main` красный» (код 3 и ложный баг) или FAIL ожидания после мержа возвращаются.

## Правило

- `spec-publish` — публикация: job так называется во фрагментах `ci.md`;
- `<job> / spec-publish` — публикация: тот же job в реюзабельном workflow, `<job>` — job вызывающего, вложенный
  вызов — несколько сегментов;
- другое имя — чек: `spec`, `test:spec`, `test-spec`, хвост за именем (`spec-publish-x`), другое начало
  (`x-spec-publish`), публикация не последним сегментом (`a / spec-publish / b`), job с матрицей
  (`spec-publish (1)` — GitHub дописывает значения матрицы к имени).

Реестр копий — скрипты скиллов с `SPEC_PUBLISH`: `export const SPEC_PUBLISH` в `.ts` и `SPEC_PUBLISH='…'` в `.sh`.
Каждая отвечает по таблице своим движком: регулярка — `RegExp.test` JS, строка `.sh` — `test()` jq, как в
`wait-ci.sh`: одна запись регулярки в двух движках может значить разное.

Реестр job — job в `.github/workflows/*.yml` и в YAML-фрагментах `skills/**/*.md` и `docs/*.md` (`tests/lib/yaml-fragments`),
шаг которых запускает `spec-publish.ts` или скрипт `spec:publish`. Имя его check-run — `name` job, без него — ключ job,
с матрицей — с дописанными значениями; его узнаёт публикацией каждая копия.

## github и ci-wait одинаково узнают публикацию спеки по имени check-run: `spec-publish` и `<job> / spec-publish` — публикация, другое имя — чек

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты скиллов с правилом SPEC_PUBLISH» не пуст
- ✅ реестр «скрипты скиллов с правилом SPEC_PUBLISH» находит ci-wait, github
- ✅ нарушитель не проходит: копия правила в одном из скриптов расходится с таблицей
- ✅ нарушитель не проходит: правило без якорей узнаёт публикацией хвост и середину имени
- ✅ ci-wait (skills/ci-wait/scripts/wait-ci.sh) узнаёт публикацию спеки по таблице
- ✅ github (skills/github/scripts/github.ts) узнаёт публикацию спеки по таблице
- ✅ таблица ловит расхождения копий без якорей и без реюзабельного workflow

</details>

## job публикации во фрагментах CI скилла spec и в CI Elves назван так, что оба скрипта узнают его публикацией

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «job публикации спеки в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «job публикации спеки в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml jobs.spec-publish, skills/spec/ci.md jobs.spec-publish, skills/spec/ci.md jobs.spec-publish (2)
- ✅ нарушитель не проходит: job публикации переименован во фрагменте
- ✅ .github/workflows/ci.yml jobs.spec-publish: check-run «spec-publish» — публикация для github и ci-wait
- ✅ skills/spec/ci.md jobs.spec-publish (2): check-run «spec-publish» — публикация для github и ci-wait
- ✅ skills/spec/ci.md jobs.spec-publish: check-run «spec-publish» — публикация для github и ci-wait

</details>

### примеры

<details><summary>✅ 3 теста</summary>

- ✅ переименованный job — ошибка с файлом, строкой и копиями, которые его не узнают
- ✅ имя check-run — name job, без него — ключ, с матрицей — с её значениями
- ✅ публикация в тексте и job без шага публикации — не элементы; неразборный фрагмент с публикацией — ошибка

</details>
