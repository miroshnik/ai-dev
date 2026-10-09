<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# flow-english

Флоу — канон, справочники, скиллы и README — пишется по-английски: репозиторий публичный, а агент работает с
человеком на языке проекта (`language` в `.agents/ai-dev.json`, capability `install`). Поэтому в документах флоу нет
кириллицы — ни в прозе, ни в цитатах вывода скриптов, ни в путях и плейсхолдерах.

Названия, которые скрипты пишут в GitHub и разбирают оттуда, — разделы issue, статусы, типы, метки, поля, последняя
строка сессии — живут на языке проекта, и у них один дом: `skills/github/locales/<язык>.json`, одни ключи у каждого
языка. Канон называет английские, а агент проекта на другом языке берёт названия из файла своего языка. Скрипты пока
держат русские названия в коде (#366), поэтому стандарт сверяет `ru.json` с исходниками скриптов: разошлись —
красный тест, а не тихая подмена названия, которое агент пишет руками.

Отвергнуто: русские названия таблицей в каноне или цитатами в справочниках — кириллица в документах флоу, и та же
таблица копией в каждом месте, где её цитируют.

## Флоу написан по-английски: в его документах нет кириллицы

<details><summary>✅ 24 теста</summary>

- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, docs/*.md, *.md скиллов» не пуст
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, docs/*.md, *.md скиллов» находит AGENTS.md, claude/CLAUDE.md, README.md, docs/testing.md, skills/spec/SKILL.md, skills/github/reference.md
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
- ✅ в skills/ci-wait/SKILL.md нет кириллицы
- ✅ в skills/dashboard/SKILL.md нет кириллицы
- ✅ в skills/est/SKILL.md нет кириллицы
- ✅ в skills/github/SKILL.md нет кириллицы
- ✅ в skills/github/reference.md нет кириллицы
- ✅ в skills/slot/SKILL.md нет кириллицы
- ✅ в skills/spec/SKILL.md нет кириллицы
- ✅ в skills/spec/canon.md нет кириллицы
- ✅ в skills/spec/checks.md нет кириллицы
- ✅ в skills/spec/ci.md нет кириллицы
- ✅ в skills/spec/migration.md нет кириллицы
- ✅ в skills/spec/reference.md нет кириллицы

</details>

## Названия, которые пишут и разбирают скрипты, — в locales скилла github, у каждого языка одни ключи

<details><summary>✅ 33 теста</summary>

- ✅ у каждого языка те же ключи, что у en, и ни одного пустого названия
- ✅ в en.json нет кириллицы
- ✅ реестр «русские названия skills/github/locales/ru.json» не пуст
- ✅ реестр «русские названия skills/github/locales/ru.json» находит status.backlog, sections.questions, subagentPrompt.task, lastLine.done
- ✅ нарушитель не проходит: название, которого скрипты не пишут
- ✅ название comments.actual из ru.json есть в скриптах скиллов
- ✅ название comments.state из ru.json есть в скриптах скиллов
- ✅ название fields.actual из ru.json есть в скриптах скиллов
- ✅ название fields.cost из ru.json есть в скриптах скиллов
- ✅ название fields.estimate из ru.json есть в скриптах скиллов
- ✅ название fields.tokens из ru.json есть в скриптах скиллов
- ✅ название issueTypes.bug из ru.json есть в скриптах скиллов
- ✅ название issueTypes.epic из ru.json есть в скриптах скиллов
- ✅ название issueTypes.task из ru.json есть в скриптах скиллов
- ✅ название labelMarkers.decision из ru.json есть в скриптах скиллов
- ✅ название labelMarkers.slice из ru.json есть в скриптах скиллов
- ✅ название labels.questions из ru.json есть в скриптах скиллов
- ✅ название lastLine.done из ru.json есть в скриптах скиллов
- ✅ название lastLine.questions из ru.json есть в скриптах скиллов
- ✅ название lastLine.remaining из ru.json есть в скриптах скиллов
- ✅ название prSpecSection из ru.json есть в скриптах скиллов
- ✅ название sections.questions из ru.json есть в скриптах скиллов
- ✅ название sections.scenarios из ru.json есть в скриптах скиллов
- ✅ название status.backlog из ru.json есть в скриптах скиллов
- ✅ название status.done из ru.json есть в скриптах скиллов
- ✅ название status.inProgress из ru.json есть в скриптах скиллов
- ✅ название subagentPrompt.epic из ru.json есть в скриптах скиллов
- ✅ название subagentPrompt.task из ru.json есть в скриптах скиллов
- ✅ название views.board из ru.json есть в скриптах скиллов
- ✅ название views.roadmap из ru.json есть в скриптах скиллов
- ✅ название views.table из ru.json есть в скриптах скиллов
- ✅ вне охвата: autoAnswer
  > пометку ответа в разделе вопросов ставит агент, скрипты её не читают
- ✅ вне охвата: standardIssue
  > соглашение агента: issue «Стандарт · …» заводит он сам, скрипты название не разбирают

</details>
