<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# section-refs

Ссылка на раздел документа флоу по названию — `AGENTS.md, «First step of a session»` в выводе установщика,
`SKILL.md, «Cloud session»` в предупреждении `est`, `` `AGENTS.md`, "Task tracking" `` в справочнике — ведёт на
существующий заголовок.

Якорь-ссылку `[…](AGENTS.md#…)` в README сверяет стандарт `readme`, указатели ядра на скиллы и `docs/` — `canon-size`;
ссылку текстом не сверяло ничего. Переименовал раздел — и ссылки на него в коде и документах молча ведут в никуда:
перевод заголовков на английский (#365) правил их руками в пяти скриптах, и следующий перевод правил бы снова.
Агент, которому вывод скрипта велит читать раздел, которого нет, ищет его по смыслу или идёт по памяти.

## Правило

Реестр — ссылки в документах флоу (`AGENTS.md`, `claude/CLAUDE.md`, `README.md`, `docs/*.md`, `*.md` скиллов), в
описаниях решений спеки (`tests/<вид>/<имя>/<имя>.md`) и в коде — установщике и скриптах скиллов: комментарии, JSDoc,
строки вывода. Перенос строки комментария (`*` JSDoc, `//`) ссылку не рвёт. Распознаются формы:

- `ФАЙЛ, "Раздел"`, `ФАЙЛ, section "Раздел"`, `ФАЙЛ (section "Раздел")`, кавычки `"…"` или `«…»`;
- `the "Раздел" section of ФАЙЛ` и `… section in ФАЙЛ`;
- ``the `github` skill, section "Раздел"`` — раздел `SKILL.md` этого скилла;
- в документе без файла — `section "Раздел"`, `the "Раздел" section`: раздел того же документа. Только в прямых
  кавычках: в `«…»` документы цитируют вывод скриптов и разделы сгенерированной спеки, а не свои заголовки.

Файл: `SKILL.md`, `reference.md` и прочие файлы скилла без его имени — файл того же скилла, что и ссылка
(`SKILL.md, «Cloud session»` в `est.ts` — `skills/est/SKILL.md`); с именем — `SKILL.md est`,
`reference.md of the github skill`; `README` — `README.md`, `CLAUDE.md` — `claude/CLAUDE.md`.

Инвариант — в файле есть раздел, который называется так: заголовок `#…` или жирное начало пункта списка
(`- **A decision is the unit of the spec…**` — так разбит `canon.md` спеки). Название — начало заголовка до конца или
знака препинания: `"Task tracking"` находит `## Task tracking — structure`, `"Task"` — нет.

Ссылка в другой форме проверкой не видна — пиши в одной из перечисленных. Отвергнуто: разбирать любую кавычку рядом с
именем файла — это строки путей в коде (`["AGENTS.md", "claude/CLAUDE.md"]`) и цитаты вывода; и ссылаться якорем
`AGENTS.md#…` в коде — якорь меняется вместе с заголовком так же, а читать его человеку труднее.

## Ссылка на раздел документа флоу по названию ведёт на существующий заголовок

<details><summary>✅ 141 тест</summary>

- ✅ реестр «ссылки «файл + название раздела» в документах флоу и решений спеки, установщике и скриптах скиллов» не пуст
- ✅ реестр «ссылки «файл + название раздела» в документах флоу и решений спеки, установщике и скриптах скиллов» находит bin/elves.ts → AGENTS.md, «First step of a session», claude/CLAUDE.md → AGENTS.md, «First step of a session», skills/est/scripts/est.ts → skills/est/SKILL.md, «Cloud session», skills/github/scripts/github.ts → skills/github/SKILL.md, «Git, PRs and merging — mechanics», skills/github/reference.md → AGENTS.md, «Estimate and actual — the `est` skill», docs/ci-concurrency.md → AGENTS.md, «CI: parallel tasks», skills/spec/SKILL.md → skills/spec/SKILL.md, «Checks»
- ✅ нарушитель не проходит: ссылка на переименованный раздел AGENTS.md
- ✅ AGENTS.md: README.md, «Installation» — есть такой раздел
- ✅ AGENTS.md: README.md, «Repository layout» — есть такой раздел
- ✅ AGENTS.md: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ bin/elves.ts: AGENTS.md, «First step of a session» — есть такой раздел
- ✅ bin/elves.ts: AGENTS.md, «Language» — есть такой раздел
- ✅ bin/elves.ts: AGENTS.md, «What I do without asking and what needs a yes» — есть такой раздел
- ✅ claude/CLAUDE.md: AGENTS.md, «First step of a session» — есть такой раздел
- ✅ claude/CLAUDE.md: docs/pr-checks.md, «Auto-fix» — есть такой раздел
- ✅ claude/CLAUDE.md: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ docs/ci-concurrency.md: AGENTS.md, «CI: parallel tasks» — есть такой раздел
- ✅ docs/ci-concurrency.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ docs/cloud-sessions.md: README.md, «Installation» — есть такой раздел
- ✅ docs/cloud-sessions.md: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ docs/judgment.md: AGENTS.md, «Production and debugging» — есть такой раздел
- ✅ docs/judgment.md: AGENTS.md, «Tests and code» — есть такой раздел
- ✅ docs/parallel-checkouts.md: AGENTS.md, «Subagents and worktrees» — есть такой раздел
- ✅ docs/parallel-checkouts.md: docs/parallel-checkouts.md, «Shared `.git/config`» — есть такой раздел
- ✅ docs/parallel-checkouts.md: docs/testing.md, «e2e» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Checked on the machine» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Compose file isolation rules» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Settings» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «The proxy» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «The task's stack» — есть такой раздел
- ✅ docs/pr-checks.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ docs/pr-checks.md: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ docs/testing.md: AGENTS.md, «Specification — decisions» — есть такой раздел
- ✅ docs/testing.md: AGENTS.md, «Tests and code» — есть такой раздел
- ✅ docs/testing.md: AGENTS.md, «This file and skills» — есть такой раздел
- ✅ docs/testing.md: docs/testing.md, «Framework: three questions» — есть такой раздел
- ✅ docs/testing.md: docs/testing.md, «UI in the agent's browser» — есть такой раздел
- ✅ skills/dashboard/SKILL.md: skills/dashboard/SKILL.md, «Pitfalls» — есть такой раздел
- ✅ skills/dashboard/SKILL.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ skills/dashboard/scripts/sessions.ts: AGENTS.md, «Epic refresh on task close» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/SKILL.md, «Period summary» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/SKILL.md, «The estimate of a new task» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Actual — how sessions are found» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Actual — the comment» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Backtest» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Cloud session import» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Codex sessions» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Double counting and shared commits» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Estimate — the mechanics» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Linking — details» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Manual re-estimate» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Period summary» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Repository registry» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Tokens and cost» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Unit and comment language» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Waits» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Writing and reruns» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/reference.md, «Actual — the comment» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/reference.md, «Waits» — есть такой раздел
- ✅ skills/est/scripts/est.ts: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ skills/est/scripts/est.ts: skills/est/reference.md, «Cloud session import» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Language» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Session and branch — one task» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Dependencies» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Git, PRs and merging — full rules» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Manual commands» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Project check and fix» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Red main» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Task and PR commands» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «task queue» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/task-env/SKILL.md, «Checked on the machine» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Estimate and actual — the `est` skill» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Language» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Session and branch — one task» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Epic refresh on task close» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Git, PRs and merging — full rules» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Manual commands» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Milestones — sets of tasks» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Project (GitHub Projects)» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «What is checked» — есть такой раздел
- ✅ skills/github/scripts/github.ts: AGENTS.md, «Session and branch» — есть такой раздел
- ✅ skills/github/scripts/github.ts: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/github/scripts/github.ts: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «Checks» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «spec-doc» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «spec-exceptions» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/ci.md, «Shards by durations» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Limitations to know about» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Report formats» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Writing prose» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-break» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-diff output» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-doc output» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-exceptions» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-publish» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-run» — есть такой раздел
- ✅ skills/spec/canon.md: AGENTS.md, «Epic refresh on task close» — есть такой раздел
- ✅ skills/spec/canon.md: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/spec/canon.md: AGENTS.md, «Tests and code» — есть такой раздел
- ✅ skills/spec/checks.md: skills/spec/SKILL.md, «Checks» — есть такой раздел
- ✅ skills/spec/checks.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/ci.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/ci.md: skills/spec/ci.md, «Shards by durations» — есть такой раздел
- ✅ skills/spec/migration.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/SKILL.md, «Reports for spec-doc» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/canon.md, «A decision is the unit of the spec, a folder is its home» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/ci.md, «Shards by durations» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «Report formats» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «Wiring into the project's CI» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «spec-diff: static parsing, not two reports» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «spec-doc output» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «spec-shard — CI shards by durations» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/dashboard/SKILL.md, «Pitfalls» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/SKILL.md, «Checked on the machine» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «A stack that didn't come up» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Checked on the machine» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Exit codes» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Labels of a task stack's service» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Override and compose files» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Stacks of closed tasks» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Taking a task's stacks down» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «The proxy before the rename» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «The proxy» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «What the compose file check reads» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/reference.md, «Labels of a task stack's service» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/reference.md, «The proxy before the rename» — есть такой раздел
- ✅ skills/task-env/scripts/task-env.ts: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ skills/task-env/scripts/task-env.ts: skills/task-env/SKILL.md, «Network subnets» — есть такой раздел
- ✅ tests/capabilities/task-env/task-env.md: skills/task-env/SKILL.md, «Network subnets» — есть такой раздел
- ✅ tests/standards/skill-imports/skill-imports.md: AGENTS.md, «Language» — есть такой раздел
- ✅ tests/standards/task-branch/task-branch.md: AGENTS.md, «Session and branch» — есть такой раздел

</details>

### примеры

<details><summary>✅ 9 тестов</summary>

- ✅ ссылка скрипта на раздел AGENTS.md по названию ведёт на существующий заголовок
- ✅ ссылка на переименованный раздел роняет проверку
- ✅ ссылка на SKILL.md без имени скилла ищет раздел в SKILL.md того же скилла
- ✅ формы ссылки: файл и раздел через запятую, «section» в скобках, раздел перед файлом; перенос строки комментария — не помеха
- ✅ раздел того же документа — `section "…"` в документе; в коде и в «…» — не ссылка
- ✅ пример формы в `…` документа — не ссылка; имя файла в `…` перед названием — ссылка
- ✅ строки путей в коде и заголовок в блоке кода — не ссылка и не раздел
- ✅ заголовок — название, за ним конец или знак препинания: «Task» не находит `## Task tracking`
- ✅ раздел — и жирное начало пункта списка; ссылка на скилл по имени ведёт в его SKILL.md

</details>
