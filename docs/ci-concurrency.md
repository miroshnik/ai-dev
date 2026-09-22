# CI: фрагменты workflow к разделу «CI: параллельные задачи»

Правило — в `AGENTS.md`. Здесь готовые фрагменты для копирования.
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
