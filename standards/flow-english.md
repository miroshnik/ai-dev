<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# flow-english

Флоу — канон, справочники, скиллы и README — пишется по-английски: репозиторий публичный, а агент работает с
человеком на языке проекта (`language` в `.agents/ai-dev.json`, capability `install`). Поэтому в документах флоу нет
кириллицы — ни в прозе, ни в цитатах вывода скриптов, ни в путях и плейсхолдерах. Под правило попадает и
`package.json`: его описание показывают npm и npx.

Названия, которые скрипты пишут в GitHub, в документы и тесты проекта и разбирают оттуда, — разделы issue, статусы,
типы, метки, поля, комментарии, последняя строка сессии, документация и тесты `spec` — живут на языке проекта, и у них
один дом: `skills/github/locales/<язык>.json`, одни ключи у каждого языка. Канон называет английские, скрипты читают
словарь модулем `skills/github/scripts/locale.cjs` по языку проекта: пишут на нём, а разбирают названия любого языка —
проект, сменивший язык, и задачи чужих репозиториев читаются без знания их языка. Поэтому стандарт проверяет, что
каждое название словаря скрипты читают по полному пути ключа (`N.status.backlog`): название строкой в коде мимо словаря
или мёртвый ключ — красный тест, а не тихая подмена названия, которое агент пишет руками.

Правило языка проекта — `language` манифеста, без поля — `ru`, без манифеста — `en` — в том же модуле, и установщик
берёт язык им же: CommonJS без типов npx запускает и из node_modules, где Node типы не стирает. Своё правило у
установщика разошлось бы с правилом скриптов молча — стандарт держит, что его нет.

Отвергнуто: русские названия таблицей в каноне или цитатами в справочниках — кириллица в документах флоу, и та же
таблица копией в каждом месте, где её цитируют.

## Флоу написан по-английски: в его документах нет кириллицы

<details><summary>✅ 25 тестов</summary>

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

<details><summary>✅ 279 тестов</summary>

- ✅ у каждого языка те же ключи, что у en, и ни одного пустого названия
- ✅ в en.json нет кириллицы
- ✅ словарь en соответствует типам модуля locale (Names в locale.d.cts)
- ✅ реестр «названия словаря skills/github/locales/en.json» не пуст
- ✅ реестр «названия словаря skills/github/locales/en.json» находит status.backlog, sections.questions, subagentPrompt.task, lastLine.done
- ✅ нарушитель не проходит: название, которого скрипты не читают
- ✅ название actualize.answer скрипты читают из словаря
- ✅ название actualize.checks скрипты читают из словаря
- ✅ название actualize.comment скрипты читают из словаря
- ✅ название actualize.epic скрипты читают из словаря
- ✅ название actualize.lead скрипты читают из словаря
- ✅ название actualize.noPr скрипты читают из словаря
- ✅ название actualize.openTask скрипты читают из словаря
- ✅ название actualize.prs скрипты читают из словаря
- ✅ название actualize.scope скрипты читают из словаря
- ✅ название actualize.shipped скрипты читают из словаря
- ✅ название comments.actual скрипты читают из словаря
- ✅ название comments.closedByPr скрипты читают из словаря
- ✅ название est.answer скрипты читают из словаря
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
- ✅ название est.hours скрипты читают из словаря
- ✅ название est.manual скрипты читают из словаря
- ✅ название est.reason скрипты читают из словаря
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
- ✅ название labels.questions скрипты читают из словаря
- ✅ название lastLine.done скрипты читают из словаря
- ✅ название lastLine.questions скрипты читают из словаря
- ✅ название lastLine.remaining скрипты читают из словаря
- ✅ название mainRed.check скрипты читают из словаря
- ✅ название mainRed.checks скрипты читают из словаря
- ✅ название mainRed.title скрипты читают из словаря
- ✅ название prSpecSection скрипты читают из словаря
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
- ✅ название spec.diff.nameException скрипты читают из словаря
- ✅ название spec.diff.noScenarios скрипты читают из словаря
- ✅ название spec.diff.noSpecBase скрипты читают из словаря
- ✅ название spec.diff.noTest скрипты читают из словаря
- ✅ название spec.diff.outsideFiles скрипты читают из словаря
- ✅ название spec.diff.outsideMark скрипты читают из словаря
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
- ✅ название spec.doc.nameDebt скрипты читают из словаря
- ✅ название spec.doc.nameReason скрипты читают из словаря
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
- ✅ название views.board скрипты читают из словаря
- ✅ название views.roadmap скрипты читают из словаря
- ✅ название views.table скрипты читают из словаря
- ✅ вне охвата: autoAnswer
  > пометку ответа в разделе вопросов ставит агент, скрипты её не читают
- ✅ вне охвата: comments.state
  > комментарий «State» перед паузой пишет агент, скрипты его не пишут и не разбирают
- ✅ вне охвата: standardIssue
  > соглашение агента: issue «Standard · …» заводит он сам, скрипты название не разбирают

</details>

## Язык проекта у скриптов скиллов и у установщика — один модуль

Язык проекта — `language` в `.agents/ai-dev.json`, без поля — `ru`, без манифеста — `en`: скрипты скиллов и
установщик берут его одним модулем `skills/github/scripts/locale.cjs` — правило в одном месте.

<details><summary>✅ 2 теста</summary>

- ✅ установщик берёт язык и код языка модулем locale скилла github, своего правила у него нет
- ✅ манифест с языком — его язык, без поля — ru, битый — ru, без манифеста — en

</details>
