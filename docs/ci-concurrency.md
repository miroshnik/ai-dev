# CI: параллельные задачи — правило и фрагменты workflow

Справочник к разделу «CI: параллельные задачи» `AGENTS.md`: здесь правило
целиком и готовые фрагменты для копирования.

## Правило

Каждая ветка и каждый PR прогоняются независимо; отменяется только свой
устаревший прогон той же ветки. Серийность — лишь там, где есть общий ресурс
(окружение деплоя, общая база, внешний сервис с лимитами). Одна очередь на
весь CI — не решение: тормозит все задачи, а без `queue: max` ещё и отменяет
ожидающие. Фрагменты workflow — ниже.

- **Ветки и PR — параллельно:** группа `concurrency` по номеру PR или ветке,
  `cancel-in-progress: true`.
- **`main`, теги, ручной запуск — никогда не отменяются:** их прогоны
  деплоят, прерванный деплой хуже лишнего прогона. Вместо отмены —
  `queue: max` (по умолчанию GitHub держит один ожидающий прогон и вытесняет
  его следующим: третий мерж подряд отменил бы второй).
- **Деплой — очередь на окружение:** у job деплоя группа `deploy-<env>`,
  общая для всех workflow репозитория.
- **CI и деплой — в разных workflow:** `queue: max` несовместим с
  `cancel-in-progress: true`. В одном workflow —
  `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` без
  `queue: max`: деплой не прервётся, но ожидающий прогон может быть вытеснен.
- **Агент чужие прогоны не отменяет и не перезапускает** (`gh run cancel` и
  `gh run rerun` — только свой прогон на своей ветке). Ожидание своих чеков и
  мерж — раздел «Git, PR и мерж» `AGENTS.md`.

## Фрагменты workflow

Проверено по документации GitHub Actions («Control the concurrency of
workflows and jobs»): `queue: max` допускает до 100 ожидающих прогонов и
несовместим с `cancel-in-progress: true`; `cancel-in-progress` принимает
выражения; группа job деплоя общая на репозиторий, поэтому одно имя в разных
workflow даёт одну очередь.

```yaml
# ci.yml — ветки и PR: параллельно, устаревший прогон той же ветки отменяется
on:
  pull_request:
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

```yaml
# cd.yml — main, теги, ручной запуск: ничего не отменяется, прогоны по очереди
on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:
concurrency:
  group: cd-${{ github.ref }}
  queue: max
jobs:
  deploy-dev:
    concurrency:
      group: deploy-dev          # окружение = очередь, общая для всех workflow
      cancel-in-progress: false
```

Если CI и деплой в одном workflow (разнести нельзя прямо сейчас):

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Работающий деплой на `main` так не прервётся, но из трёх мержей подряд
ожидающий второй прогон вытеснит третий — он задеплоит всё вместе, а второй
коммит останется без статуса CI на `main`.
