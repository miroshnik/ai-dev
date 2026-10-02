<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# readme

README — витрина флоу для того, кто видит репозиторий впервые, и он не отстаёт от флоу: называет каждый скилл, каждую
команду установщика и скиллов с её подкомандами, каждый справочник `docs/`, а его ссылки и якоря ведут на существующее.

README читают первым, а правят последним: новый скилл или справочник появлялся в `skills/` и `docs/`, а README о нём
молчал (так было со `spec-break` и `parallel-checkouts.md`; пока подкоманды не сверялись — с `github task close` и
`est cloud-import`). Поэтому то, что можно перечислить из кода, README обязан назвать — иначе красный `bun test`.
Проза (мотивация, принципы, сравнение с OpenSpec) механически не проверяется, но принципы ссылаются на разделы
`AGENTS.md`: переименовал раздел — проверка ссылок покажет README, и его абзац сверяется заодно. Поменял смысл раздела,
на который ссылается принцип, — поправь и принцип.

## README называет всё, что ставит флоу, и не ссылается на то, чего нет

<details><summary>✅ 44 теста</summary>

- ✅ реестр «скиллы, команды установщика и скиллов, справочники docs/» не пуст
- ✅ реестр «скиллы, команды установщика и скиллов, справочники docs/» находит skills/spec, ai-dev install, ai-dev release, skills/spec/scripts/spec-break, skills/ci-wait/scripts/wait-ci, docs/pr-checks.md
- ✅ нарушитель не проходит: скилл, которого README не называет
- ✅ README: команда установщика check названа
- ✅ README: команда установщика install названа
- ✅ README: команда установщика release названа
- ✅ README: команда установщика update названа
- ✅ README: скилл ci-wait — со ссылкой на skills/ci-wait/SKILL.md
- ✅ README: скилл dashboard — со ссылкой на skills/dashboard/SKILL.md
- ✅ README: скилл est — со ссылкой на skills/est/SKILL.md
- ✅ README: скилл github — со ссылкой на skills/github/SKILL.md
- ✅ README: скилл spec — со ссылкой на skills/spec/SKILL.md
- ✅ README: скрипт dashboard скилла dashboard назван
- ✅ README: скрипт est скилла est назван
- ✅ README: скрипт github скилла github назван
- ✅ README: скрипт spec-break скилла spec назван
- ✅ README: скрипт spec-claims скилла spec назван
- ✅ README: скрипт spec-diff скилла spec назван
- ✅ README: скрипт spec-doc скилла spec назван
- ✅ README: скрипт spec-exceptions скилла spec назван
- ✅ README: скрипт spec-publish скилла spec назван
- ✅ README: скрипт spec-run скилла spec назван
- ✅ README: скрипт wait-ci скилла ci-wait назван
- ✅ README: справочник docs/ci-concurrency.md — со ссылкой
- ✅ README: справочник docs/cloud-sessions.md — со ссылкой
- ✅ README: справочник docs/parallel-checkouts.md — со ссылкой
- ✅ README: справочник docs/pr-checks.md — со ссылкой
- ✅ README: справочник docs/testing.md — со ссылкой
- ✅ реестр «подкоманды скриптов скиллов» не пуст
- ✅ реестр «подкоманды скриптов скиллов» находит github task close, est cloud-import
- ✅ нарушитель не проходит: подкоманда, которой README не называет
- ✅ README: подкоманда est cloud-import названа
- ✅ README: подкоманда est estimate названа
- ✅ README: подкоманда est fact названа
- ✅ README: подкоманда est history названа
- ✅ README: подкоманда github pr labels названа
- ✅ README: подкоманда github pr premerge названа
- ✅ README: подкоманда github project check названа
- ✅ README: подкоманда github project fix названа
- ✅ README: подкоманда github task close названа
- ✅ README: подкоманда github task drop названа
- ✅ README: подкоманда github task new названа
- ✅ README: подкоманда github task status названа
- ✅ относительные ссылки и якоря README ведут на существующие файлы и разделы

</details>

### примеры

<details><summary>✅ 6 тестов</summary>

- ✅ ссылка на удалённый скилл — нарушение
- ✅ якорь на переименованный раздел AGENTS.md — нарушение
- ✅ якоря — как у GitHub: тире и пунктуация выпадают, пробел — дефис, повтор — с номером
- ✅ подкоманды — слова справки после имени скрипта до первого аргумента, без повторов
- ✅ подкоманда названа отдельно или в перечне через «|»; перечень без неё и слово вне кода — нарушение
- ✅ внешняя ссылка и ссылка в блоке кода — вне правила

</details>
