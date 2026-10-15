<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# flow-english

Флоу — канон, справочники, скиллы и README — пишется по-английски: репозиторий публичный, а агент работает с
человеком на языке проекта (`language` в `.agents/ai-dev.json`, capability `install`). Поэтому в документах флоу нет
кириллицы — ни в прозе, ни в цитатах вывода скриптов, ни в путях и плейсхолдерах. Под правило попадает и
`package.json`: его описание показывают npm и npx.

Названия, которые скрипты пишут в GitHub, в документы и тесты проекта и разбирают оттуда, — разделы issue, статусы,
типы, метки, поля, комментарии, последняя строка сессии, документация и тесты `spec` — живут на языке проекта, и у них
один дом: `skills/github/locales/<язык>.json`, одни ключи у каждого языка. Канон называет английские, скрипты читают
словарь модулем `skills/github/scripts/locale.ts` по языку проекта: пишут на нём, а разбирают названия любого языка —
проект, сменивший язык, и задачи чужих репозиториев читаются без знания их языка. Словари модуль берёт статическим
импортом в карту, типизированную `Names`, а не чтением каталога: typecheck сверяет каждый словарь с типом, а модуль
грузится любым раннером проекта (`harness-load`). Файл языка вне карты скрипты молча не видели бы — стандарт держит, что
каждый файл `locales/` — язык модуля. И проверяет, что каждое название словаря скрипты читают по полному пути ключа
(`N.status.backlog`): название строкой в коде мимо словаря или мёртвый ключ — красный тест, а не тихая подмена
названия, которое агент пишет руками.

Сообщения установщика и скриптов скиллов — справка, подсказки, ошибки, вывод `check` и хука — часть флоу, а не
артефакт проекта: их читает агент любого проекта, поэтому они по-английски при любом языке проекта. Названия на языке
проекта скрипты берут из словаря, а комментарии в коде флоу — по-английски, как его документы: их читает тот, кто правит
скилл, а язык самого ai-dev — `ru`, и без проверки новый код снова получал бы русские комментарии. Значит, кириллицы в
коде скриптов нет вовсе — стандарт проверяет каждый файл кода скиллов и установщика целиком, с комментариями (словари
`skills/github/locales` — не код), а справку — запуском `--help`. Доки флоу цитируют вывод в «ёлочках»: по
цитате агент узнаёт исход и ищет строку. Цитата, которой скрипт не печатает, — тихий дрейф, поэтому каждая сверяется с
кодом: литеральные куски между подстановками (`<имя>`, `…`, `N`, `#`) есть в коде скриптов или в `en.json`. Цитату
из нескольких документов тест называет по первому в порядке путей, а не в порядке файловой системы: имя теста —
утверждение спеки, на macOS и в CI оно одно.

Правило языка проекта — `language` манифеста, без поля — `ru`, без манифеста — `en` — в том же модуле, и установщик
берёт язык им же. Своё правило у установщика разошлось бы с правилом скриптов молча — стандарт держит, что его нет.

Отвергнуто: русские названия таблицей в каноне или цитатами в справочниках — кириллица в документах флоу, и та же
таблица копией в каждом месте, где её цитируют. Сообщения скриптов на языке проекта — сотни строк словаря на каждый язык
ради читателя-агента, который понимает английский; на язык проекта переводит он сам, когда пишет человеку.

## Флоу написан по-английски: в его документах нет кириллицы

<details><summary>✅ 28 тестов</summary>

- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» не пуст
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» находит AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/testing.md, skills/spec/SKILL.md, skills/github/reference.md
- ✅ нарушитель не проходит: справочник с русской цитатой вывода скрипта
- ✅ в AGENTS.md нет кириллицы
- ✅ в README.md нет кириллицы
- ✅ в claude/CLAUDE.md нет кириллицы
- ✅ в docs/ci-concurrency.md нет кириллицы
- ✅ в docs/cloud-sessions.md нет кириллицы
- ✅ в docs/judgment.md нет кириллицы
- ✅ в docs/parallel-checkouts.md нет кириллицы
- ✅ в docs/pr-checks.md нет кириллицы
- ✅ в docs/testing.md нет кириллицы
- ✅ в package.json нет кириллицы
- ✅ в skills/ci-wait/SKILL.md нет кириллицы
- ✅ в skills/dashboard/SKILL.md нет кириллицы
- ✅ в skills/est/SKILL.md нет кириллицы
- ✅ в skills/est/reference.md нет кириллицы
- ✅ в skills/github/SKILL.md нет кириллицы
- ✅ в skills/github/reference.md нет кириллицы
- ✅ в skills/slot/SKILL.md нет кириллицы
- ✅ в skills/spec/SKILL.md нет кириллицы
- ✅ в skills/spec/canon.md нет кириллицы
- ✅ в skills/spec/checks.md нет кириллицы
- ✅ в skills/spec/ci.md нет кириллицы
- ✅ в skills/spec/migration.md нет кириллицы
- ✅ в skills/spec/reference.md нет кириллицы
- ✅ в skills/task-env/SKILL.md нет кириллицы
- ✅ в skills/task-env/reference.md нет кириллицы

</details>

## Код установщика и скриптов скиллов — сообщения и комментарии — по-английски

Сообщения установщика и скриптов скиллов — справка, подсказки, ошибки, вывод `check` и хука — часть флоу, а не
артефакт проекта: они по-английски при любом языке проекта. Названия на языке проекта скрипты берут из словаря
(`skills/github/locales`), а комментарии — по-английски, как документы флоу, поэтому кириллицы в коде скриптов нет
вовсе: файл сверяется целиком, с комментариями.

<details><summary>✅ 29 тестов</summary>

- ✅ реестр «код скриптов скиллов и установщика — skills/*/scripts и bin» не пуст
- ✅ реестр «код скриптов скиллов и установщика — skills/*/scripts и bin» находит bin/ai-dev.ts, skills/github/scripts/github.ts, skills/est/scripts/est.ts, skills/spec/scripts/harness.ts
- ✅ нарушитель не проходит: комментарий по-русски
- ✅ в bin/ai-dev.ts нет кириллицы
- ✅ в skills/dashboard/scripts/dashboard.ts нет кириллицы
- ✅ в skills/dashboard/scripts/sessions.ts нет кириллицы
- ✅ в skills/est/scripts/est.ts нет кириллицы
- ✅ в skills/github/scripts/github.ts нет кириллицы
- ✅ в skills/github/scripts/locale.ts нет кириллицы
- ✅ в skills/slot/scripts/slot.ts нет кириллицы
- ✅ в skills/spec/scripts/architecture.ts нет кириллицы
- ✅ в skills/spec/scripts/c4.ts нет кириллицы
- ✅ в skills/spec/scripts/eslint-config.ts нет кириллицы
- ✅ в skills/spec/scripts/harness.ts нет кириллицы
- ✅ в skills/spec/scripts/knip-hints.cjs нет кириллицы
- ✅ в skills/spec/scripts/knip-hints.d.cts нет кириллицы
- ✅ в skills/spec/scripts/spec-break.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-claims.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-diff.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-doc.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-exceptions.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-publish.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-run.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-shard.ts нет кириллицы
- ✅ в skills/spec/scripts/speclib.ts нет кириллицы
- ✅ в skills/spec/scripts/vendor/babel-parser.cjs нет кириллицы
- ✅ в skills/spec/scripts/vendor/babel-parser.d.cts нет кириллицы
- ✅ в skills/task-env/scripts/task-env.ts нет кириллицы
- ✅ справка установщика и скриптов скиллов и их команд — на английском

</details>

## Строки вывода, которые цитируют доки флоу, скрипты печатают дословно

Доки флоу цитируют вывод скриптов — строки, по которым агент узнаёт исход, — и названия, которые скрипты пишут в
GitHub. Цитата, которой нет в коде, — дрейф: скрипт печатает иначе, и агент ищет строку, которой не будет. Цитата
сверяется по литеральным кускам между подстановками: каждый кусок со словом — в коде скриптов или в `en.json`.

<details><summary>✅ 174 теста</summary>

- ✅ реестр «цитаты «…» в документах флоу» не пуст
- ✅ реестр «цитаты «…» в документах флоу» находит already newer, Actual (cloud), closed in 90 days without an actual: N
- ✅ нарушитель не проходит: цитата вывода, которого нет
- ✅ цитату «## Questions» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «### Task scenarios» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «$ per 1M tokens» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «+ manually: N h» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «30 days» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «90 days» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «\<VAR> is declared» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<VAR> is read in the code» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<entry> is called by a capability test» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<module> imports \<package>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<module> uses allowed package \<package>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<title> — added» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «\<title> — removed» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Actual (cloud): …» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual (cloud)» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual unavailable (cloud)» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual, h» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Added» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «All done, but there are questions…» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «All done. The session can be closed.» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Architecture model» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Base» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Became tests» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Bug» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «CI red» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «CI running» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Changed» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Closed by PR #M: GitHub didn't link the PR to the task» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Closes #N» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Cloud session … not imported — est cloud-import» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Cost by model» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Cost, $» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Decided auto» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Epic» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Estimate and actual» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Estimate, h» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Estimate» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Exceptions» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Folder» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Harness checks» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Item closed» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Moved into the tree» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Next:» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «No estimate: …» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «No estimate» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Not counted again: N h already in the actual of #M» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Of them, from the harness» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Outside the tree» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Overlap with the actual of #M … — recompute #M» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Refresh» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Remaining: …» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Removed» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Sessions» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Task #N (epic #M)» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Task #N …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Task #N» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «Task» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Tests beyond scenarios» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Tokens, M» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Waiting for the owner» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «What it's made of» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «What the system does» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Which rules the code obeys» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «`<base>` is red: \<check | typecheck | test:spec>» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «`<base>` is red…» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «`main` is red…» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «a mark belongs in one element's file» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «a proxy without the API?» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «actual unavailable» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «after / before» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «agent Bash: not set up» из claude/CLAUDE.md печатает или пишет скрипт
- ✅ цитату «all knip findings are of known kinds» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «all time» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «allowed: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «allowed» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «already newer» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «analogs» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «architecture model» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «beyond scenarios» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «can be closed» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «can't listen on 127.0.0.1 …» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «client \<pkg> of storage \<s> is in container \<c>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «closed in 90 days without an actual: N» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «cloud, state not visible» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «code without a consumer» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «declare the external system» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «dependency \<a> → \<b> is within a container» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «deployable unit \<id> is container \<c>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «deploy» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «directory \<dir> is in module \<module>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «element files from fileOf exist» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «entry points» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «entry-point ids do not repeat in the registry» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «epic» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «estimate» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «exception: \<entry> (#N)» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exception: \<key> (#N)» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exceptions are \<element>.json files in the decision folder's exceptions/» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exceptions are one file per element in exceptions/, not exceptions.ts» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «exceptions in \<file>: \<rules> (#N)» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exceptions with a rule belong to the folder's invariant rules» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «forms» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «from project …» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «from the report» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «header \<H> … is read only by adapter \<a>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «human reply» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «ids from the log are in the registry» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «is declared» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «is denied here (an agent's sandbox?)» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «is read» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «isn't read — names aren't exceptions any more, delete it» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «kept» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «key \<K> of external system \<x> is read only by adapter \<a>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «library \<m> is in containers \<c1, c2>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «main tree … not fully checked — publishing skipped» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «marks with a rule belong to the folder's invariant rules» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «merge» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «module \<m> is in container \<c>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «move it to outside» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «mutations» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «new decision» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «no calls to unlisted binaries» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no changes — … confirmed for …» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «no changes» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «no dependencies without an import» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no duplicate exports» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no enum members without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no exports without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no files without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no green run» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «no imports of unlisted packages» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no knip configuration hints» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no namespace members without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no price» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «no references to missing catalog entries» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no session» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «no types without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no unresolved imports» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no unused catalog entries» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «none» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «not allowed: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «not allowed» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «not empty» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «not imported» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «not written: …» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «one record per element» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: \<VAR>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: \<element>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: \<key>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «perimeter» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «proxy …: routes not read» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «questions» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «remove from scope» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «remove the exception: delete \<file>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «remove the exception» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «remove the mark in \<file>:\<line>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «repo» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «silence» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «unsplit: N h» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «violator does not pass: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «working» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «workspace package \<path> is in the code roots» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «…» из skills/github/reference.md печатает или пишет скрипт
- ✅ вне охвата: api/DATABASE_URL is declared
  > пример названия с подставленным элементом: шаблон «{name} is declared» — в en.json
- ✅ вне охвата: host \<h> is only in adapter \<a>
  > название собрано из двух ключей en.json: hostName и inAdapter
- ✅ вне охвата: package \<p> of external system \<x> is only with adapter \<a>
  > название собрано из двух ключей en.json: packageName и withAdapter
- ✅ вне охвата: shared commit … (share 1/k)
  > строка собрана из двух ключей en.json: est.fact.shared и est.fact.commitUnit
- ✅ имя теста цитаты не зависит от порядка, в котором файловая система отдаёт документы

</details>

## Названия, которые пишут и разбирают скрипты, — в locales скилла github, у каждого языка одни ключи

<details><summary>✅ 317 тестов</summary>

- ✅ у каждого языка те же ключи, что у en, и ни одного пустого названия
- ✅ в en.json нет кириллицы
- ✅ каждый файл skills/github/locales/*.json — язык модуля locale с этим словарём, en первым
  > Модуль `locale` берёт словари статическим импортом в карту, типизированную `Names`, — каталог `locales/` он не
  > читает: так tsc сверяет каждый словарь с типом, а модуль грузится любым раннером проекта
  > (tests/standards/harness-load). Файл языка, которого нет в карте, молча не подхватился бы ни скриптами, ни typecheck.
- ✅ реестр «названия словаря skills/github/locales/en.json» не пуст
- ✅ реестр «названия словаря skills/github/locales/en.json» находит status.backlog, sections.questions, subagentPrompt.task, lastLine.done
- ✅ нарушитель не проходит: название, которого скрипты не читают
- ✅ название actualize.answer скрипты читают из словаря
- ✅ название actualize.answers скрипты читают из словаря
- ✅ название actualize.checks скрипты читают из словаря
- ✅ название actualize.comment скрипты читают из словаря
- ✅ название actualize.commentAnswer скрипты читают из словаря
- ✅ название actualize.copies скрипты читают из словаря
- ✅ название actualize.copy скрипты читают из словаря
- ✅ название actualize.epic скрипты читают из словаря
- ✅ название actualize.fetch скрипты читают из словаря
- ✅ название actualize.files скрипты читают из словаря
- ✅ название actualize.lead скрипты читают из словаря
- ✅ название actualize.linkWords скрипты читают из словаря
- ✅ название actualize.mechanics скрипты читают из словаря
- ✅ название actualize.milestone скрипты читают из словаря
- ✅ название actualize.noBody скрипты читают из словаря
- ✅ название actualize.noPr скрипты читают из словаря
- ✅ название actualize.openTask скрипты читают из словаря
- ✅ название actualize.openTasks скрипты читают из словаря
- ✅ название actualize.prs скрипты читают из словаря
- ✅ название actualize.scope скрипты читают из словаря
- ✅ название actualize.shipped скрипты читают из словаря
- ✅ название actualize.unblocked скрипты читают из словаря
- ✅ название actualize.unlabeled скрипты читают из словаря
- ✅ название autoAnswer скрипты читают из словаря
- ✅ название comments.actual скрипты читают из словаря
- ✅ название comments.closedByPr скрипты читают из словаря
- ✅ название comments.externalBlocker скрипты читают из словаря
- ✅ название est.answer скрипты читают из словаря
- ✅ название est.closingWords скрипты читают из словаря
- ✅ название est.cloud.actual скрипты читают из словаря
- ✅ название est.cloud.body скрипты читают из словаря
- ✅ название est.cloud.cost скрипты читают из словаря
- ✅ название est.cloud.fields скрипты читают из словаря
- ✅ название est.cloud.session скрипты читают из словаря
- ✅ название est.cloud.tokens скрипты читают из словаря
- ✅ название est.cloud.unavailable скрипты читают из словаря
- ✅ название est.estimate.analog скрипты читают из словаря
- ✅ название est.estimate.auto скрипты читают из словаря
- ✅ название est.estimate.body скрипты читают из словаря
- ✅ название est.estimate.correction скрипты читают из словаря
- ✅ название est.estimate.expert скрипты читают из словаря
- ✅ название est.estimate.expertOver скрипты читают из словаря
- ✅ название est.estimate.forecast скрипты читают из словаря
- ✅ название est.estimate.headline скрипты читают из словаря
- ✅ название est.estimate.k скрипты читают из словаря
- ✅ название est.estimate.labels скрипты читают из словаря
- ✅ название est.estimate.levelAll скрипты читают из словаря
- ✅ название est.estimate.levelRepo скрипты читают из словаря
- ✅ название est.estimate.noK скрипты читают из словаря
- ✅ название est.estimate.none скрипты читают из словаря
- ✅ название est.estimate.notInProject скрипты читают из словаря
- ✅ название est.estimate.otherProject скрипты читают из словаря
- ✅ название est.estimate.partial скрипты читают из словаря
- ✅ название est.estimate.partialCoverage скрипты читают из словаря
- ✅ название est.estimate.size скрипты читают из словаря
- ✅ название est.estimate.spread скрипты читают из словаря
- ✅ название est.estimate.tokCorrection скрипты читают из словаря
- ✅ название est.estimate.tokens скрипты читают из словаря
- ✅ название est.estimate.type скрипты читают из словаря
- ✅ название est.estimate.unknown скрипты читают из словаря
- ✅ название est.estimate.words скрипты читают из словаря
- ✅ название est.fact.and скрипты читают из словаря
- ✅ название est.fact.body скрипты читают из словаря
- ✅ название est.fact.cloudAgent скрипты читают из словаря
- ✅ название est.fact.cloudMissing скрипты читают из словаря
- ✅ название est.fact.commitUnit скрипты читают из словаря
- ✅ название est.fact.commits скрипты читают из словаря
- ✅ название est.fact.cost скрипты читают из словаря
- ✅ название est.fact.diff скрипты читают из словаря
- ✅ название est.fact.diffLines скрипты читают из словаря
- ✅ название est.fact.diffNa скрипты читают из словаря
- ✅ название est.fact.estimate скрипты читают из словаря
- ✅ название est.fact.noEstimate скрипты читают из словаря
- ✅ название est.fact.noPr скрипты читают из словаря
- ✅ название est.fact.overlap скрипты читают из словаря
- ✅ название est.fact.prompts скрипты читают из словаря
- ✅ название est.fact.prs скрипты читают из словаря
- ✅ название est.fact.sessions скрипты читают из словаря
- ✅ название est.fact.shared скрипты читают из словаря
- ✅ название est.fact.steps скрипты читают из словаря
- ✅ название est.fact.subagents скрипты читают из словаря
- ✅ название est.fact.taken скрипты читают из словаря
- ✅ название est.fact.tokens скрипты читают из словаря
- ✅ название est.fact.tokensSplit скрипты читают из словаря
- ✅ название est.fact.unavailable скрипты читают из словаря
- ✅ название est.fact.unpriced скрипты читают из словаря
- ✅ название est.fact.waits скрипты читают из словаря
- ✅ название est.fact.waitsSlot скрипты читают из словаря
- ✅ название est.hours скрипты читают из словаря
- ✅ название est.manual скрипты читают из словаря
- ✅ название est.reason скрипты читают из словаря
- ✅ название est.stopWords скрипты читают из словаря
- ✅ название fields.actual скрипты читают из словаря
- ✅ название fields.cost скрипты читают из словаря
- ✅ название fields.estimate скрипты читают из словаря
- ✅ название fields.tokens скрипты читают из словаря
- ✅ название issueTypes.bug скрипты читают из словаря
- ✅ название issueTypes.epic скрипты читают из словаря
- ✅ название issueTypes.task скрипты читают из словаря
- ✅ название labelMarkers.architecturePath скрипты читают из словаря
- ✅ название labelMarkers.decision скрипты читают из словаря
- ✅ название labelMarkers.slice скрипты читают из словаря
- ✅ название labels.epicDescription скрипты читают из словаря
- ✅ название labels.externalBlocker скрипты читают из словаря
- ✅ название labels.questions скрипты читают из словаря
- ✅ название labels.questionsDescription скрипты читают из словаря
- ✅ название lastLine.done скрипты читают из словаря
- ✅ название lastLine.questions скрипты читают из словаря
- ✅ название lastLine.remaining скрипты читают из словаря
- ✅ название mainRed.check скрипты читают из словаря
- ✅ название mainRed.checks скрипты читают из словаря
- ✅ название mainRed.title скрипты читают из словаря
- ✅ название prSpecSection скрипты читают из словаря
- ✅ название queue.answer скрипты читают из словаря
- ✅ название queue.epic скрипты читают из словаря
- ✅ название queue.found скрипты читают из словаря
- ✅ название queue.git скрипты читают из словаря
- ✅ название queue.lead скрипты читают из словаря
- ✅ название queue.prompt скрипты читают из словаря
- ✅ название queue.question скрипты читают из словаря
- ✅ название queue.resume скрипты читают из словаря
- ✅ название queue.session скрипты читают из словаря
- ✅ название queue.subagent скрипты читают из словаря
- ✅ название queue.subagents скрипты читают из словаря
- ✅ название queue.wait скрипты читают из словаря
- ✅ название sections.questions скрипты читают из словаря
- ✅ название sections.scenarios скрипты читают из словаря
- ✅ название spec.architecture.allowedName скрипты читают из словаря
- ✅ название spec.architecture.allowedRegistry скрипты читают из словаря
- ✅ название spec.architecture.allowedViolator скрипты читают из словаря
- ✅ название spec.architecture.clientName скрипты читают из словаря
- ✅ название spec.architecture.clientViolator скрипты читают из словаря
- ✅ название spec.architecture.clientsRegistry скрипты читают из словаря
- ✅ название spec.architecture.containersRegistry скрипты читают из словаря
- ✅ название spec.architecture.containersViolator скрипты читают из словаря
- ✅ название spec.architecture.dirName скрипты читают из словаря
- ✅ название spec.architecture.dirViolator скрипты читают из словаря
- ✅ название spec.architecture.dirsRegistry скрипты читают из словаря
- ✅ название spec.architecture.edgeName скрипты читают из словаря
- ✅ название spec.architecture.edgeViolator скрипты читают из словаря
- ✅ название spec.architecture.edgesRegistry скрипты читают из словаря
- ✅ название spec.architecture.envNoun скрипты читают из словаря
- ✅ название spec.architecture.envRegistry скрипты читают из словаря
- ✅ название spec.architecture.headerNoun скрипты читают из словаря
- ✅ название spec.architecture.headersRegistry скрипты читают из словаря
- ✅ название spec.architecture.hostName скрипты читают из словаря
- ✅ название spec.architecture.hostPerimeter скрипты читают из словаря
- ✅ название spec.architecture.hostViolator скрипты читают из словаря
- ✅ название spec.architecture.hostsRegistry скрипты читают из словаря
- ✅ название spec.architecture.importsName скрипты читают из словаря
- ✅ название spec.architecture.importsRegistry скрипты читают из словаря
- ✅ название spec.architecture.importsViolator скрипты читают из словаря
- ✅ название spec.architecture.inAdapter скрипты читают из словаря
- ✅ название spec.architecture.inAdapters скрипты читают из словаря
- ✅ название spec.architecture.libraryName скрипты читают из словаря
- ✅ название spec.architecture.moduleName скрипты читают из словаря
- ✅ название spec.architecture.packageName скрипты читают из словаря
- ✅ название spec.architecture.packagePerimeter скрипты читают из словаря
- ✅ название spec.architecture.packageViolator скрипты читают из словаря
- ✅ название spec.architecture.packagesRegistry скрипты читают из словаря
- ✅ название spec.architecture.readName скрипты читают из словаря
- ✅ название spec.architecture.readNameMany скрипты читают из словаря
- ✅ название spec.architecture.readPerimeter скрипты читают из словаря
- ✅ название spec.architecture.readViolator скрипты читают из словаря
- ✅ название spec.architecture.unitName скрипты читают из словаря
- ✅ название spec.architecture.unitViolator скрипты читают из словаря
- ✅ название spec.architecture.unitsRegistry скрипты читают из словаря
- ✅ название spec.architecture.withAdapter скрипты читают из словаря
- ✅ название spec.architecture.withAdapters скрипты читают из словаря
- ✅ название spec.architecture.workspaceName скрипты читают из словаря
- ✅ название spec.architecture.workspaceRegistry скрипты читают из словаря
- ✅ название spec.architecture.workspaceViolator скрипты читают из словаря
- ✅ название spec.c4.calls скрипты читают из словаря
- ✅ название spec.c4.components скрипты читают из словаря
- ✅ название spec.c4.containerCount скрипты читают из словаря
- ✅ название spec.c4.containers скрипты читают из словаря
- ✅ название spec.c4.context скрипты читают из словаря
- ✅ название spec.c4.dependsOn скрипты читают из словаря
- ✅ название spec.c4.externalCount скрипты читают из словаря
- ✅ название spec.c4.intro скрипты читают из словаря
- ✅ название spec.c4.library скрипты читают из словаря
- ✅ название spec.c4.moduleCount скрипты читают из словаря
- ✅ название spec.c4.perimeter скрипты читают из словаря
- ✅ название spec.c4.summary скрипты читают из словаря
- ✅ название spec.c4.system скрипты читают из словаря
- ✅ название spec.c4.table скрипты читают из словаря
- ✅ название spec.c4.title скрипты читают из словаря
- ✅ название spec.c4.uses скрипты читают из словаря
- ✅ название spec.c4.viaModule скрипты читают из словаря
- ✅ название spec.c4.viaModules скрипты читают из словаря
- ✅ название spec.claims.called скрипты читают из словаря
- ✅ название spec.claims.describe скрипты читают из словаря
- ✅ название spec.claims.known скрипты читают из словаря
- ✅ название spec.claims.registry скрипты читают из словаря
- ✅ название spec.claims.unique скрипты читают из словаря
- ✅ название spec.diff.added скрипты читают из словаря
- ✅ название spec.diff.addedKind скрипты читают из словаря
- ✅ название spec.diff.architecture скрипты читают из словаря
- ✅ название spec.diff.base скрипты читают из словаря
- ✅ название spec.diff.becameTests скрипты читают из словаря
- ✅ название spec.diff.changed скрипты читают из словаря
- ✅ название spec.diff.checksTitle скрипты читают из словаря
- ✅ название spec.diff.deadCode скрипты читают из словаря
- ✅ название spec.diff.deadCodeNamed скрипты читают из словаря
- ✅ название spec.diff.empty скрипты читают из словаря
- ✅ название spec.diff.exceptionsTitle скрипты читают из словаря
- ✅ название spec.diff.extraFull скрипты читают из словаря
- ✅ название spec.diff.extraListed скрипты читают из словаря
- ✅ название spec.diff.extraMark скрипты читают из словаря
- ✅ название spec.diff.extraTitle скрипты читают из словаря
- ✅ название spec.diff.files скрипты читают из словаря
- ✅ название spec.diff.folder скрипты читают из словаря
- ✅ название spec.diff.fromReport скрипты читают из словаря
- ✅ название spec.diff.harnessCheck скрипты читают из словаря
- ✅ название spec.diff.harnessColumn скрипты читают из словаря
- ✅ название spec.diff.harnessGap скрипты читают из словаря
- ✅ название spec.diff.harnessNote скрипты читают из словаря
- ✅ название spec.diff.modelDependency скрипты читают из словаря
- ✅ название spec.diff.modelModule скрипты читают из словаря
- ✅ название spec.diff.modelPackage скрипты читают из словаря
- ✅ название spec.diff.modelTitle скрипты читают из словаря
- ✅ название spec.diff.moved скрипты читают из словаря
- ✅ название spec.diff.movedFolder скрипты читают из словаря
- ✅ название spec.diff.noScenarios скрипты читают из словаря
- ✅ название spec.diff.noSpecBase скрипты читают из словаря
- ✅ название spec.diff.noTest скрипты читают из словаря
- ✅ название spec.diff.notStatements скрипты читают из словаря
- ✅ название spec.diff.outsideFiles скрипты читают из словаря
- ✅ название spec.diff.outsideMark скрипты читают из словаря
- ✅ название spec.diff.partialReport скрипты читают из словаря
- ✅ название spec.diff.registry скрипты читают из словаря
- ✅ название spec.diff.registryNamed скрипты читают из словаря
- ✅ название spec.diff.removed скрипты читают из словаря
- ✅ название spec.diff.removedKind скрипты читают из словаря
- ✅ название spec.diff.rule скрипты читают из словаря
- ✅ название spec.diff.ruleNamed скрипты читают из словаря
- ✅ название spec.diff.scenarios скрипты читают из словаря
- ✅ название spec.diff.summarized скрипты читают из словаря
- ✅ название spec.diff.summary скрипты читают из словаря
- ✅ название spec.diff.total скрипты читают из словаря
- ✅ название spec.diff.unchanged скрипты читают из словаря
- ✅ название spec.doc.architecture скрипты читают из словаря
- ✅ название spec.doc.capabilities скрипты читают из словаря
- ✅ название spec.doc.failing скрипты читают из словаря
- ✅ название spec.doc.failingCount скрипты читают из словаря
- ✅ название spec.doc.intro скрипты читают из словаря
- ✅ название spec.doc.mark скрипты читают из словаря
- ✅ название spec.doc.none скрипты читают из словаря
- ✅ название spec.doc.outside скрипты читают из словаря
- ✅ название spec.doc.outsideIntro скрипты читают из словаря
- ✅ название spec.doc.rules скрипты читают из словаря
- ✅ название spec.doc.skipped скрипты читают из словаря
- ✅ название spec.doc.skippedCount скрипты читают из словаря
- ✅ название spec.doc.standards скрипты читают из словаря
- ✅ название spec.doc.title скрипты читают из словаря
- ✅ название spec.doc.todo скрипты читают из словаря
- ✅ название spec.doc.variants скрипты читают из словаря
- ✅ название spec.harness.bad скрипты читают из словаря
- ✅ название spec.harness.badExample скрипты читают из словаря
- ✅ название spec.harness.codeFiles скрипты читают из словаря
- ✅ название spec.harness.elementFiles скрипты читают из словаря
- ✅ название spec.harness.env.declared скрипты читают из словаря
- ✅ название spec.harness.env.declaredName скрипты читают из словаря
- ✅ название spec.harness.env.inCode скрипты читают из словаря
- ✅ название spec.harness.env.readName скрипты читают из словаря
- ✅ название spec.harness.env.undeclared скрипты читают из словаря
- ✅ название spec.harness.env.unread скрипты читают из словаря
- ✅ название spec.harness.exception скрипты читают из словаря
- ✅ название spec.harness.exceptionFiles скрипты читают из словаря
- ✅ название spec.harness.exceptionJson скрипты читают из словаря
- ✅ название spec.harness.exceptionRules скрипты читают из словаря
- ✅ название spec.harness.good скрипты читают из словаря
- ✅ название spec.harness.ignoreNoReason скрипты читают из словаря
- ✅ название spec.harness.knip.binaries скрипты читают из словаря
- ✅ название spec.harness.knip.catalog скрипты читают из словаря
- ✅ название spec.harness.knip.catalogReferences скрипты читают из словаря
- ✅ название spec.harness.knip.dependencies скрипты читают из словаря
- ✅ название spec.harness.knip.duplicates скрипты читают из словаря
- ✅ название spec.harness.knip.enumMembers скрипты читают из словаря
- ✅ название spec.harness.knip.exports скрипты читают из словаря
- ✅ название spec.harness.knip.files скрипты читают из словаря
- ✅ название spec.harness.knip.hints скрипты читают из словаря
- ✅ название spec.harness.knip.known скрипты читают из словаря
- ✅ название spec.harness.knip.nsMembers скрипты читают из словаря
- ✅ название spec.harness.knip.types скрипты читают из словаря
- ✅ название spec.harness.knip.unlisted скрипты читают из словаря
- ✅ название spec.harness.knip.unresolved скрипты читают из словаря
- ✅ название spec.harness.lintExceptions скрипты читают из словаря
- ✅ название spec.harness.markOneElement скрипты читают из словаря
- ✅ название spec.harness.markRules скрипты читают из словаря
- ✅ название spec.harness.oneRecord скрипты читают из словаря
- ✅ название spec.harness.outside скрипты читают из словаря
- ✅ название spec.harness.outsideExample скрипты читают из словаря
- ✅ название spec.harness.registryFinds скрипты читают из словаря
- ✅ название spec.harness.registryNotEmpty скрипты читают из словаря
- ✅ название spec.harness.violator скрипты читают из словаря
- ✅ название spec.lint.allRules скрипты читают из словаря
- ✅ название spec.lint.noReason скрипты читают из словаря
- ✅ название spec.tests скрипты читают из словаря
- ✅ название status.backlog скрипты читают из словаря
- ✅ название status.done скрипты читают из словаря
- ✅ название status.inProgress скрипты читают из словаря
- ✅ название subagentPrompt.epic скрипты читают из словаря
- ✅ название subagentPrompt.task скрипты читают из словаря
- ✅ название updateCommit скрипты читают из словаря
- ✅ название updateTask скрипты читают из словаря
- ✅ название views.board скрипты читают из словаря
- ✅ название views.roadmap скрипты читают из словаря
- ✅ название views.table скрипты читают из словаря
- ✅ вне охвата: comments.state
  > комментарий «State» перед паузой пишет агент, скрипты его не пишут и не разбирают
- ✅ вне охвата: standardIssue
  > соглашение агента: issue «Standard · …» заводит он сам, скрипты название не разбирают

</details>

## Язык проекта у скриптов скиллов и у установщика — один модуль

Язык проекта — `language` в `.agents/ai-dev.json`, без поля — `ru`, без манифеста — `en`: скрипты скиллов и
установщик берут его одним модулем `skills/github/scripts/locale.ts` — правило в одном месте.

<details><summary>✅ 2 теста</summary>

- ✅ установщик берёт язык и код языка модулем locale скилла github, своего правила у него нет
- ✅ манифест с языком — его язык, без поля — ru, битый — ru, без манифеста — en

</details>
