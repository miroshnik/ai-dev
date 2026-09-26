<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# Спецификация

Сгенерировано из дерева `tests/`, названий тестов и их JSDoc (скилл `spec`, `spec-doc`). Руками не править: правка — в тестах.

## Что делает система

- [est](capabilities/est.md) — Скилл `est`: сколько часов работы агента займёт задача — по фактам похожих закрытых задач, и сколько заняла на самом деле — часы, токены и стоимость из транскриптов.
- [github-project](capabilities/github-project.md) — Скилл `github`, `project check` и `project fix`: проект GitHub любого репозитория устроен одинаково — по канону `AGENTS.md`, и агент приводит его к канону одной командой.
- [github-task](capabilities/github-task.md) — Скилл `github`, `task new`, `task status` и `task drop`: задачу заводят, двигают по доске и закрывают одной командой, и она всё время по канону `AGENTS.md`.
- [install](capabilities/install.md) — Установка флоу: одна команда `npx github:miroshnik/ai-dev install` даёт проекту — или, с `-g`, машине — общие правила, справочники и все скиллы ai-dev для любого агента.
- [spec-diff](capabilities/spec-diff.md) — Скрипт `spec-diff` скилла `spec`: ревьюер PR видит, какие требования PR снимает, меняет и добавляет, — раздел «Спека (тесты)» для тела PR с названиями тестов.
- [spec-doc](capabilities/spec-doc.md) — Скрипт `spec-doc` скилла `spec`: документация `docs/spec` из тестов — страница на capability и стандарт, которая читается рассказом: зачем, что умеет, чем проверено.

## Как построена

- [cloud-session](standards/cloud-session.md) — Скрипты скиллов, которые ходят в GitHub Projects, в облачной сессии выходят с объяснением, а не сбоем `gh`.
- [node-runtime](standards/node-runtime.md) — Скрипты скилла `spec` идут под Node ≥ 22.18 без Bun — CI проекта на Node запускает их из копии скилла в проекте.
