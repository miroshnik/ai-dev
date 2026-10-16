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
- в коде скриптов скиллов и установщика — команда, которую скрипт печатает (`bun ${…}`, `bun .agents/skills/…`), и
  дочерний процесс `bun` (`spawn("bun", […])`, `process.execPath`).

Маска разрешения (`Bash(bun *skills/…)`) — не вызов: `*` покрывает и флаг.

## Почему не `bunfig.toml`

`env = false` в `bunfig.toml` корня проекта отключает env-файлы любому `bun` в нём: Bun-проект перестал бы
подгружать `.env.test` в собственном `bun test` и `.env` в `bun run dev`. Флаг снимает только то, что добавлял сам
вызов скрипта флоу. `bun run <скрипт>` и `npm run` env-файлы скрипту `package.json` не передают (Bun 1.4.3).

## Вне охвата

Установщик под `bunx` (`bunx @miroshnik/elves …`, запасной путь `bunx github:miroshnik/elves …`, хук
`SessionStart`): `bunx` подгружает env-файлы и флаг не принимает — ни `bunx --no-env-file`, ни
`bun --no-env-file x` (Bun 1.4.3). Помог бы только shebang `#!/usr/bin/env -S bun --no-env-file`, а `env -S` есть
не везде (busybox) — установщик там не запустился бы вовсе. Сам он проверок проекта не запускает. Так же —
`bunx @miroshnik/elves@<версия> spec-…` в джобах CI без зависимостей проекта (`ci.md` скилла spec, #559): в чекауте
CI env-файлов с ключами нет — `.env.local` не коммитят.

## Скрипты флоу под bun не подгружают env-файлы проекта: вызов несёт --no-env-file

<details><summary>✅ 58 тестов</summary>

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
