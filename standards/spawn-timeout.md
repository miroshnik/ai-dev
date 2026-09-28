<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# spawn-timeout

Тест, который запускает процессы (git, node, bun), держит таймаут `SPAWN_TIMEOUT`, а не 5 с bun по умолчанию, — чтобы
нагрузка машины не роняла зелёные тесты.

Время такого теста — время его процессов, а оно растёт с нагрузкой: параллельные сессии агентов замедляют запуск node
и git в разы, и тест на секунду идёт 5–15 с, а установка через npm — до 45 с. Падение по таймауту тогда ложное —
гонки и ожидания событий нет, тест детерминирован; таймаут 2 мин ловит только зависание.

## Почему таймаут в каждом файле

Не один на прогон: ключа `timeout` у `bun test` в `bunfig.toml` нет (документация bun), `setDefaultTimeout` в
preload действует только на первый файл прогона (проверено на bun 1.4.2), а `--timeout` в скриптах `package.json`
не видит голый `bun test`. 2 мин — запас ×2,5 к установке через npm под нагрузкой ~70 на 16 ядрах (44–48 с; при
обычной нагрузке — 4,5 с).

## Тест, который запускает процессы, не падает от нагрузки машины: таймаут SPAWN_TIMEOUT

<details><summary>✅ 23 теста</summary>

- ✅ реестр «тесты ai-dev, которые запускают процессы» не пуст
- ✅ нарушитель не проходит: файл с node:child_process без таймаута
- ✅ tests/capabilities/ci-wait/ci-wait.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/est/est.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/install/install.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/release/release.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-claims/spec-claims.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-diff/spec-diff.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-doc/architecture.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-doc/names.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-doc/sequence.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-doc/spec-doc.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/architecture.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/claimed-code.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/exceptions.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/lint.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/meta.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/sequence.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-harness/spec-harness.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec-publish/spec-publish.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/update/update.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/node-runtime/node-runtime.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ в реестр попадают установщик, скрипты spec и est

</details>

### примеры

<details><summary>✅ 4 теста</summary>

- ✅ файл с node:child_process без таймаута — нарушение
- ✅ хелпер из модуля tests/lib, который запускает процессы сам или через другой модуль, — тоже нарушение
- ✅ с setDefaultTimeout(SPAWN_TIMEOUT) — чисто
- ✅ без процессов — вне правила: свой модуль без процессов, import type, пример кода в строке

</details>
