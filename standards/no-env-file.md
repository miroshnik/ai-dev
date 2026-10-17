<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# no-env-file

Скрипт флоу под `bun` идёт с `--no-env-file`: env-файлы проекта — `.env`, `.env.<NODE_ENV>`, `.env.local` — в
его окружение не попадают и дальше командам не передаются.

Bun сам подгружает env-файлы рабочего каталога в окружение процесса, а скрипт флоу запускается из корня проекта. В
Node-проекте `.env.local` часто несёт прод-ключи из `vercel env pull`: с обёрткой slot они доходили до раннера тестов,
который раньше их не видел, — тесты «ключ не задан» краснели локально и были зелёными на CI, а тест с запросом во
внешний сервис ушёл бы туда с прод-ключом. То же у любого скрипта скилла: `task-env e2e` и `spec-break` передают
окружение команде, `github pr premerge` — проверкам, `gh` в `github`, `est` и `dashboard` берёт `GITHUB_TOKEN` из
`.env.local` вместо своей авторизации.

Флаг нужен на каждом вызове, а не только на внешнем: дочерний `bun` подгружает env-файлы каталога заново, а
загруженное родителем наследует — флаг вложенного вызова его уже не снимает.

## Правило

Вызов скрипта флоу через `bun` несёт `--no-env-file` сразу после `bun`:

- в документах флоу — `AGENTS.md`, `claude/CLAUDE.md`, `README.md`, `package.json`, `docs/*.md`, `*.md` скиллов —
  `bun <путь>/scripts/<скрипт>.ts`, которую агент копирует как есть;
- там же — скрипт пакета под `bun`: `bun --no-env-file node_modules/.bin/elves <скрипт>`, в `package.json` и CI
  одинаково (#596). `bun` читает bin сам, мимо его шебанга, и без флага подгрузит env-файлы каталога;
- шебанг bin пакета — через `sh`: `#!/bin/sh` и вторая строка `':' //; exec bun --no-env-file "$0" "$@"` — для `sh`
  запуск Bun с флагом, для TypeScript строка-выражение и комментарий. Голый `elves`, `node_modules/.bin/elves`, скрипт
  `package.json`, `bunx` и обёртка Yarn 2+ `elves slot '<команда>'` идут через него — без env-файлов (#592). Не
  `#!/usr/bin/env bun` — Bun подгрузил бы их, и `elves slot '<команда>'` отдал бы ключи команде; не
  `#!/usr/bin/env -S bun --no-env-file` — `env -S` есть не везде (busybox), bin там не запустился бы вовсе;
- в коде скриптов скиллов и установщика — команда, которую скрипт печатает (`bun ${…}`, `bun .agents/skills/…`), и
  дочерний процесс `bun` (`spawn("bun", […])`, `process.execPath`);
- там же — скрипт пакета под `bun` в строках кода: подсказка (`migrate with spec-exceptions: …` харнесса), справка
  скрипта под именем `elves` и обзор `elves --help` (#602). Строка запуска — одна константа `PACKAGE_RUN`
  (`skills/spec/scripts/package-run.ts`) у установщика, харнесса и справки: `bun --no-env-file node_modules/.bin/elves
  <скрипт>`. Справку агент копирует как есть: форма та же, что в `package.json` и CI, и версия — пакета проекта, а голый
  `elves` в shell агента — глобальный пакет машины, если он вообще в PATH. Строки — литералы и шаблоны с `${…}`;
  комментарий и регулярное выражение — не вывод.

Маска разрешения (`Bash(bun *skills/…)`) — не вызов: `*` покрывает и флаг.

## Почему не `bunfig.toml`

`env = false` в `bunfig.toml` корня проекта отключает env-файлы любому `bun` в нём: Bun-проект перестал бы
подгружать `.env.test` в собственном `bun test` и `.env` в `bun run dev`. Флаг снимает только то, что добавлял сам
вызов скрипта флоу. `bun run <скрипт>` и `npm run` env-файлы скрипту `package.json` не передают (Bun 1.4.3).

## Вне охвата

`bunx` (`bunx @miroshnik/elves …`, запасной путь `bunx github:miroshnik/elves …`, хук `SessionStart`, джобы CI без
зависимостей проекта — `bunx @miroshnik/elves@<версия> spec-…`, `ci.md` скилла spec, #559) флаг не принимает — ни
`bunx --no-env-file`, ни `bun --no-env-file x` (Bun 1.4.3), — но запускает bin его шебангом: env-файлы снимает шебанг
(#592).

`elves slot --for $$` шима очереди `.agents/slot.sh`: `elves` только печатает переменные очереди, а команда идёт в
shell скрипта, без env-файлов Bun.

## Скрипты флоу под bun не подгружают env-файлы проекта: вызов несёт --no-env-file

<details><summary>✅ 121 тест</summary>

- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» не пуст (документы)
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» находит skills/slot/SKILL.md, skills/github/SKILL.md, skills/task-env/SKILL.md, skills/spec/SKILL.md, docs/parallel-checkouts.md, package.json (документы)
- ✅ нарушитель не проходит (документы): команда скилла без флага
- ✅ нарушитель не проходит (документы): скрипт package.json без флага
- ✅ в AGENTS.md скрипты скиллов вызываются с --no-env-file
- ✅ в README.md скрипты скиллов вызываются с --no-env-file
- ✅ в claude/CLAUDE.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/ci-concurrency.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/cloud-sessions.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/judgment.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/parallel-checkouts.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/pr-checks.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/testing.md скрипты скиллов вызываются с --no-env-file
- ✅ в package.json скрипты скиллов вызываются с --no-env-file
- ✅ в skills/ci-wait/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/dashboard/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/est/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/est/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/github/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/github/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/slot/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/canon.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/checks.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/ci.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/migration.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/task-env/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/task-env/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ вызов скрипта пакета в документах флоу и package.json, который подгрузит env-файлы проекта, — нарушение no-env-file
  > bin пакета Bun без флага читает сам, мимо шебанга, — с env-файлами рабочего каталога, и `elves <скрипт>` отдавал
  > их ключи `gh`, `git` и проверяемой команде (#596). Голый bin идёт через шебанг — без них (#592).
- ✅ команда скрипта пакета, которую печатает код скриптов и установщика и которая подгрузит env-файлы проекта, — нарушение no-env-file
  > Команду, которую печатает код — подсказка харнесса, справка скрипта под именем `elves`, — агент копирует как есть:
  > `bun node_modules/.bin/elves …` без флага в ней Bun читает мимо шебанга bin и отдаёт ключи env-файлов проекта
  > проверяемой команде, как в package.json до #596.
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов — и строки кода скриптов скиллов и установщика» не пуст (скрипт пакета)
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов — и строки кода скриптов скиллов и установщика» находит README.md, skills/spec/SKILL.md, skills/spec/reference.md, skills/spec/ci.md, skills/spec/scripts/harness.ts, bin/elves.ts (скрипт пакета)
- ✅ нарушитель не проходит (скрипт пакета): скрипт package.json — bin под bun без флага
- ✅ нарушитель не проходит (скрипт пакета): команда скилла — bin под bun без флага
- ✅ нарушитель не проходит (скрипт пакета): подсказка кода — bin под bun без флага
- ✅ в AGENTS.md bin пакета под bun вызывается с --no-env-file
- ✅ в README.md bin пакета под bun вызывается с --no-env-file
- ✅ в bin/ai-dev.ts bin пакета под bun вызывается с --no-env-file
- ✅ в bin/elves.ts bin пакета под bun вызывается с --no-env-file
- ✅ в claude/CLAUDE.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/ci-concurrency.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/cloud-sessions.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/judgment.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/parallel-checkouts.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/pr-checks.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/testing.md bin пакета под bun вызывается с --no-env-file
- ✅ в package.json bin пакета под bun вызывается с --no-env-file
- ✅ в skills/ci-wait/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/dashboard/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/dashboard/scripts/dashboard.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/dashboard/scripts/sessions.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/est/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/est/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/est/scripts/est.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/scripts/github.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/scripts/locale.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/slot/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/slot/scripts/slot.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/canon.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/checks.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/ci.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/migration.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/architecture.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/c4.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/eslint-config.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/harness.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/knip-hints.cjs bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/knip-hints.d.cts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/package-run.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-break.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-claims.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-diff.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-doc.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-exceptions.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-publish.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-run.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-shard.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/speclib.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/task-env/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/task-env/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/task-env/scripts/task-env.ts bin пакета под bun вызывается с --no-env-file
- ✅ справка скрипта пакета под именем elves называет вызов без env-файлов проекта
  > Справка скрипта под именем `elves` — первое, что агент копирует: синтаксис и примеры — со строкой запуска пакета.
- ✅ реестр «bin из package.json» не пуст (bin пакета)
- ✅ реестр «bin из package.json» находит bin/elves.ts (bin пакета)
- ✅ нарушитель не проходит (bin пакета): шебанг env bun
- ✅ bin/elves.ts запускает Bun с --no-env-file сам — шебанг через sh
- ✅ реестр «код скриптов скиллов и установщика без комментариев» не пуст (код)
- ✅ реестр «код скриптов скиллов и установщика без комментариев» находит skills/github/scripts/github.ts, skills/task-env/scripts/task-env.ts, skills/spec/scripts/harness.ts, bin/elves.ts (код)
- ✅ нарушитель не проходит (код): подсказка с командой без флага
- ✅ нарушитель не проходит (код): дочерний bun без флага
- ✅ нарушитель не проходит (код): дочерний процесс того же bun без флага
- ✅ bin/ai-dev.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ bin/elves.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/dashboard/scripts/dashboard.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/dashboard/scripts/sessions.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/est/scripts/est.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/github/scripts/github.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/github/scripts/locale.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/slot/scripts/slot.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/architecture.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/c4.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/eslint-config.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/harness.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/knip-hints.cjs печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/knip-hints.d.cts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/package-run.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-break.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-claims.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-diff.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-doc.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-exceptions.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-publish.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-run.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-shard.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/speclib.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/task-env/scripts/task-env.ts печатает и запускает скрипты флоу с --no-env-file

</details>
