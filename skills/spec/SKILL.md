---
name: spec
description: Specification from tests — the spec canon (the "Specification — decisions" rule moved out of the AGENTS.md core) in the skill's canon.md, deterministic scripts and a checks harness. spec-doc builds the docs/spec documentation from runner reports (Vitest/Jest JSON, Playwright JSON, JUnit XML from bun test) along the tree tests/capabilities/<name>, tests/architecture/<name> and tests/standards/<name>, with prose from the tests' JSDoc; spec-diff prints for the PR body the lists of removed, changed and added test names between the base branch and HEAD; spec-publish publishes docs/spec to the spec branch after a merge (main has no documentation), spec-run finds for it the green PR run that checked the merge tree; spec-claims, after a run, checks entry points against the log of calls by capability tests; spec-break proves by breaking that a check can fail (break → run → always revert); spec-exceptions moves a project's exceptions.ts into an exceptions/ directory — one file per exception; harness.ts — tests of mechanical checks ("registry + invariant" — a convention on every item of a registry taken from the code). When — before creating a PR (the spec section in the PR body); in CI on a PR (spec-doc --strict) and after a merge (publishing to the spec branch); when you need to read a project's spec (git show origin/spec:README.md); when a project wires spec into its CI (a copy of the skill in the project, Node without Bun, Vitest and Playwright shards); when a convention ("every mutation writes an audit record") must be checked on all items, not on an example; when you need to prove that an inherited or new test catches a breakage (whether it is really "covered"); when asked for documentation of functionality, "what does the system do", "which requirements does this PR remove" — even if the word "specification" wasn't said.
allowed-tools: Bash(bun *skills/spec/scripts/spec-doc.ts *) Bash(bun *skills/spec/scripts/spec-diff.ts *) Bash(bun run spec:*) Bash(node *skills/spec/scripts/spec-doc.ts *) Bash(node *skills/spec/scripts/spec-diff.ts *) Bash(bun *skills/spec/scripts/spec-claims.ts *) Bash(node *skills/spec/scripts/spec-claims.ts *) Bash(bun *skills/spec/scripts/spec-break.ts *) Bash(node *skills/spec/scripts/spec-break.ts *) Bash(bun *skills/spec/scripts/spec-exceptions.ts *) Bash(node *skills/spec/scripts/spec-exceptions.ts *) Bash(pnpm spec:*) Bash(bunx vitest run *) Bash(git status *) Bash(git diff *)
---

# spec — documentation from test names, spec diff in the PR

The "Specification — decisions" rule is `canon.md` next to this file (the spec
canon moved out of the `AGENTS.md` core; read it when you write or migrate a
test, add a check, an exception, a standard): a decision exists while a
mechanism checks it — a test, a lint rule, a check over the architecture
model; each is wrapped in a runner test. So the documentation is the `tests/`
tree and the test names, and the diff of tests in a PR is the spec diff. The
scripts in `scripts/` do this deterministically, without a model and without
per-repository configuration:

- `spec-doc.ts` — runner reports and test JSDoc → `docs/spec/` (or a single
  document to stdout);
- `spec-diff.ts` — test names on the base branch and in HEAD → three lists for
  the PR body: removed, changed, added;
- `spec-publish.ts` — the built `docs/spec` → the `spec` branch (CI after a
  merge: a run on `main` or the PR run's artifact); `main` has no
  documentation;
- `spec-run.ts` — for publishing on a PR merge: the green run that checked
  exactly the tree of the merge commit; none — publishing is skipped;
- `spec-claims.ts` — after a run: every entry point is called by a capability
  test (the harness's `journal`, `resetJournal` at the start of the run),
  registry ids don't repeat, journal ids come from the registry; the JUnit
  report goes to `spec-doc`;
- `spec-break.ts` — check by breaking: edit the code, run the test, always
  revert (even after an interruption); ✅ failed / ❌ didn't fail for each
  breakage;
- `spec-exceptions.ts` — moves the decision folders' `exceptions.ts` into an
  `exceptions/` directory, one file per exception (section "spec-exceptions");
- `harness.ts` — a library for the project's tests: a mechanical check
  registers ordinary runner tests and gets into the spec (section "Checks").

Running: `bun <skill dir>/scripts/spec-doc.ts …` — Bun runs TypeScript without
a build, there are no dependencies (the scripts use only the `node:` API and a
TypeScript parser kept as a file in the skill — `scripts/vendor/` — and also
run under Node ≥ 22.18). The skill directory is the one holding this file
(`${CLAUDE_SKILL_DIR}` in Claude Code, `~/.claude/skills/spec`,
`~/.agents/skills/spec`, the project's `.agents/skills/spec` or an ai-dev
clone). The repository root is `git toplevel` (or `--root DIR`); the tree is
`tests/` at the root. In a repository wired up per the "Wiring into a
repository" section — its `spec:doc` and `spec:diff`, not the scripts from the
skill directory: that is the version pinned for CI.

## What to run when

| Moment | Action |
|---|---|
| Before a PR | 1. a test run with a JSON report (don't run e2e: for the names `playwright test --list --reporter=json > .spec-playwright.json` is enough); 2. `spec-doc --strict` with both reports — the tree and the main files are in order (`docs/spec` is in `.gitignore`, not committed); 3. `spec-diff --scenarios <task body>` → the `## Спека (тесты)` section ("Spec (tests)") with the scenario check, into the PR body |
| In CI on a PR | run → `spec-doc --strict` (tests outside the tree, no main file or `<folder>.md`, a header on a test file, `rule.test.ts`, a name that isn't a statement — for now: without Cyrillic, #366 — exit code 1); `spec-diff` into the summary |
| In CI after a merge | a run on `main` → `spec-doc` → `spec-publish`; without CI on `main` — `docs/spec` from the PR run's artifact and `spec-publish --source <merge SHA>` (`ci.md`). The `spec` branch = the built `docs/spec`, the script verifies it after the push |
| Read a project's spec | `git fetch origin spec && git show origin/spec:README.md` (pages — `capabilities/<name>.md`…) or the tests themselves |
| Asked for documentation, "what does the system do" | `spec-doc <report> --stdout` — one document, files aren't touched |
| Asked which requirements a PR removed | `spec-diff` — the «Удалены» (removed) list comes first |
| A project moves to a test spec | section "Wiring into a repository": installing the flow, scripts under Node, workflow; migrating the old spec's requirements — `migration.md` (outcomes, removal categories, "the spec fell behind the code") |
| A convention for all items (mutations, routes, files) | `invariant` in `tests/standards/<name>/<name>.test.ts` — section "Checks" |
| Prove that a check can fail (migrating an old spec, a "covered" review) | `spec-break` — a breakage aimed at the check, one per run |
| After running all tests and shards | `spec-claims` — every entry point is called by a capability test; its report goes to `spec-doc` together with the runner reports |
| The harness failed «исключения — файлом на элемент в exceptions/, а не в exceptions.ts» (exceptions — a file per item); spec-doc says «исключения названий — файл на название в names.exceptions/» (name exceptions — a file per name) | `spec-exceptions` — section "spec-exceptions" |

## Reports for spec-doc

The format is detected from the content; several reports can be passed at
once (Vitest + Playwright + bun test), identical tests are merged.

| Runner | Command |
|---|---|
| Vitest (and Jest — same format) | `vitest run --reporter=default --reporter=json --outputFile.json=.spec-report.json` |
| `bun test` | `bun test --reporter=junit --reporter-outfile=.spec-report.xml` — JUnit with nested `testsuite` per describe |
| Playwright | `PLAYWRIGHT_JSON_OUTPUT_NAME=.spec-playwright.json playwright test --reporter=json` |
| Playwright without a run (before a PR) | `playwright test --list --reporter=json > .spec-playwright.json` — the tree and names without browsers, tests show as skipped: for `spec-doc --strict` and `spec-diff`, not for publishing |

Reports are temporary files, in `.gitignore`. A report from CI with someone
else's absolute paths works: the path is normalized by the `/tests/` segment.
The runner itself merges shards (blob reports → one JSON, section "Wiring into
a repository"); don't pass shard reports separately — Playwright splits a file
between shards, and the order of tests in a file would depend on the order of
the reports.

## spec-doc

```bash
bun <skill dir>/scripts/spec-doc.ts .spec-report.json [more reports] [--out docs/spec | --stdout] [--strict] [--root DIR] [--names-baseline N]
```

What ends up in `docs/spec/` (the generated text is in Russian for now):

- `README.md` — the index: «Что делает система» ("what the system does", per
  capability), «Из чего состоит» ("what it's made of": the architecture page
  as the first line, then per architecture rule; neither a model nor rules —
  no section), «Каким правилам подчиняется код» ("which rules the code obeys",
  per standard); each link has the first paragraph of `<folder>.md` (the
  description) and, if any, the number of skipped and failing tests; the
  «Вне дерева» section ("outside the tree") — only if there are such tests;
- `architecture.md` — from the model `tests/architecture/model.ts`: Mermaid
  diagrams C1 (`C4Context`, the system and external systems), C2
  (`C4Container`, containers and links), C3 (`C4Component`, modules per
  container) and a table of modules, below them — the architecture rules; a
  level without data in the model isn't drawn, no model — no page. A marker
  `<!-- spec: c4-context -->` (`c4-container`, `c4-component`, `c4-modules`)
  on a line of its own in any `<folder>.md` is replaced with the same diagram
  or table; a marker without a model or an unknown one — a warning,
  `--strict` — exit code 1. The model doesn't load — exit code 2;
- `capabilities/<name>.md`, `architecture/<name>.md`, `standards/<name>.md` —
  one file per folder, a story
  in three layers: the heading is the folder name, under it the `<folder>.md`
  description (**why**); `describe` → a section with prose from its own JSDoc
  (**what it can do**; a nested one — a level deeper); the section's tests — a
  collapsed block `<details><summary>✅ 12 тестов</summary>` (**what checks
  it**), with lines `- ✅ name` inside. A skipped one —
  `⏭️ … — пропущен: <reason>` (the reason comes from the Playwright
  annotation; Vitest and `bun test` don't put the reason into the report), a
  failing one —
  `❌ … — падает`, `📝 … — todo`; if there are such, the counter is in the
  block's line (`❌ 12 тестов, 1 пропущен, 1 падает` — 12 tests, 1 skipped,
  1 failing), and the block is expanded. A test in several Playwright projects
  — one line. There is no "section · path · N tests" line: the section and
  path follow from the convention. Names are text: `<` outside a code span is
  escaped, otherwise GitHub would eat `<type>` or `<!-- … -->` as HTML (same
  in `spec-diff`);
- the first line of every file is the marker `<!-- spec-doc: … -->`: by it the
  script deletes its own stale files (a capability disappeared) and doesn't
  touch others'.

`tests/lib` is skipped. Tests outside `tests/capabilities/<name>`,
`tests/architecture/<name>` and `tests/standards/<name>` (in `src/`, in
`tests/unit/`, a file directly in `tests/capabilities/`) go to «Вне дерева» —
that's a signal to move them; `--strict` then returns exit code 1 (for CI).
The order is deterministic: folders by name; inside a folder the main file
first — the order of its `describe` is the order of the story, — in a monorepo
the packages' main files next, the remaining files by path; tests in
declaration order.
Identical `describe` from several files of a folder (unit and e2e of one
capability) merge into one section.

**The main file of a folder** — `tests/<kind>/<name>/<name>.*`
(`<name>.test.ts`, `<name>.e2e.ts`…) for a capability, an architecture rule
and a standard, in a monorepo also `tests/<kind>/<name>/<package>/<name>.*`
(a package subfolder, no deeper): its `describe` go first — the main file of
the folder root, then the packages' main files by package name, then the
remaining files by path; no main file either at the root or in subfolders —
stderr, `--strict` — exit code 1. With both `<name>.test.*` and
`<name>.e2e.ts` side by side, the main one is `.test.*`: the page opens with
the unit statements, e2e follows, before the folder's other files. **Names**
of `describe` and `it` are statements in the project language (`language` in
`.agents/ai-dev.json`); for now `spec-doc --strict` recognizes a statement by
Cyrillic letters (`isStatement`), English is #366: a name without Russian
words (an identifier, a function or file name, an English phrase) — stderr
with the name and file, `--strict` — exit code 1; code in backticks inside a
statement is fine.
Old names on an existing spec — as exceptions, one file per name in the
`names.exceptions/` directory of their test's decision folder
(`<test name>.json`: `{ file, name, issue, reason }`): parallel PRs each
remove their own file and don't conflict. A file in the directory that isn't
such an exception (not JSON, missing fields) and the directory in a subfolder
of the decision folder — exit code 2 with the path. `--strict` skips
exceptions; an unneeded one (already a statement or the test is gone —
`удали <file>` — delete the file) and one lying outside its test's folder —
exit code 1; the debt — the table-of-contents section «Названия — не
утверждения (исключения)» ("names that aren't statements (exceptions)"). All
current violations as one rewrite task — `spec-doc … --names-baseline <N>`: a
file per new name into its test's folder, deletes the files of unneeded ones
(an emptied directory too). The former array (the folder's
`names.exceptions.ts`, the shared `tests/standards/spec-names/exceptions.ts`,
the `--names-exceptions` flag) isn't read: stderr with a hint to run
`spec-exceptions`, `--strict` — exit code 1, `--names-baseline` and the flag —
exit code 2.
**Description** — `tests/<kind>/<name>/<name>.md`: missing — `spec-doc` names
the file in stderr, `--strict` — exit code 1. A JSDoc header on a test file
doesn't go into the documentation — into stderr with a hint to move it to md,
`--strict` — exit code 1. A standard's former main file `rule.*` — also into
stderr with a hint to rename it to `<name>.*`, `--strict` — exit code 1.

### Prose — `<folder>.md` and JSDoc

A capability page is a story (the "Specification — decisions" rule,
`canon.md`): why it exists, what it can do, what checks it. Names give only
"what it can do" and "what checks it"; "why", the reason and the rejected
options are the `<folder>.md` description next to the tests, and what isn't
visible from the name is JSDoc `/** … */` on `describe` and `it` (runner
reports carry no comments — `spec-doc` reads the sources with the same scanner
as `spec-diff`):

| Where the prose is | Where it goes in `docs/spec` |
|---|---|
| `<folder>.md` | the intro under the folder heading (md headings go under it); the first paragraph is the description in the index |
| JSDoc right before `describe` | a paragraph under its heading |
| JSDoc right before `it` / `test` | a `>` quote under the test line |

```md
<!-- tests/capabilities/billing/billing.md -->
Billing: a customer receives a monthly invoice and pays it by card or bank transfer.

The accountant doesn't issue invoices by hand: they arrive by themselves on the
first day of the month; a manual invoice is an exception for one-off services.
```

```ts
// tests/capabilities/billing/billing.test.ts — the main file of the billing folder
import { describe, it } from "vitest";

/** A partial month is charged in proportion to its days. */
describe("An invoice is issued by itself on the first day of the month", () => { … });
describe("A paid invoice is closed without the accountant", () => { … });
```

- `<folder>.md` — who the capability is for and which problem it solves, the
  reason for the decision and the rejected alternatives; the first paragraph
  is the description in the table of contents. Diagrams of behavior and
  structure — only generated ones, never drawn by hand.
- A top-level `describe` is a capability as a statement in the user's terms,
  not the name of a function, component or file: the headings alone show what
  the capability can do. The most important goes first in the main file.
- Prose before `describe` and `it` — where the name isn't enough: one to three
  sentences, not a retelling of the test. An unclear `it` name — rewrite it,
  don't explain it.
- `//` and `/* … */` don't go into the documentation: file names, issue
  numbers and the test's internals are for the code reader. Block tags
  (`@see`, `@param`) and everything after the first of them — neither.
- A JSDoc belongs to the nearest code: between it and `describe`/`it` — only
  whitespace and comments. The file's first JSDoc followed by something other
  than a call (imports) is the file header; in a file without imports a JSDoc
  right before the first `describe` is that `describe`'s prose.
- A test file's header doesn't go into the documentation (section "spec-doc"
  above): its text belongs in `<folder>.md` or in `//`.
- The source is read by the path from the report, from the root (`--root`); no
  file (a report from another machine) — documentation without prose, the list
  of such files in stderr.

## spec-diff

```bash
bun <skill dir>/scripts/spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--no-merge-base] [--json] [--root DIR] [--scenarios issue.md | -] [--report report … [--spec-branch origin/spec]] [--limit 100 | --full]
```

Decisions outside test names — as separate sections, only if they changed:
«Модель архитектуры — снято / добавлено» ("architecture model — removed /
added": modules, dependencies, packages from `tests/architecture/model.ts`),
«Исключения» ("exceptions": the files of the decision folders' `exceptions/`
and `names.exceptions/` — not in a subfolder and `.json`, as the harness and
spec-doc read them, — entries of the former `exceptions.ts` and
`names.exceptions.ts` — the item and the harness `rule` or the file and the
test name — and lint disables `eslint-disable … -- #N` in changed files,
except the flow copy `.agents/` and `.claude/`; each entry
is its own line, identical ones aren't collapsed), «Проверки
харнесса» ("harness checks": `invariant` registries and `examples` rules — the
`registry` / `rule` options of the object in the call's arguments, by parsing
the source, with a string known without a run; `deadCode` runs — «код без
потребителя» ("code without a consumer"), with `rule` or `production: true` in
parentheses; `architecture` — «модель архитектуры» ("architecture model");
their tests appear only in a run). The model and
exceptions are read by importing the revision's data file: a module with
imports outside its own boundaries isn't read, its decisions aren't shown.

`--scenarios` — the task body (`gh issue view N --json body --jq .body | … --scenarios -`):
the `## Сценарии` section (scenarios; the script reads only the `ru` name so
far) is checked against the added and changed tests — «### Сценарии задачи»
("task scenarios"); each name on one line, once. A scenario that became a test
is named the same as the test: while the tests are in the lists above, it is
only in the «Стали тестами» ("became tests") count, and a test beyond the
scenarios gets the «сверх сценариев» ("beyond scenarios") mark in the list; in
the per-folder summary (no lists) — ✅ and the test's line.
❌ — a scenario without a test, in its own wording. Tests with the scenario's
name in several folders (server and UI) — all tests of this scenario; in
`--json` the scenario has `tests`. A match — with the `it` name or the chain
"describe › it", case-insensitive, ignoring outer quotes (`«…»`, `"…"`,
`` `…` ``) and a trailing mark (`.`, `;`, `,` — before and after the quotes).
No test — with the name or chain of a `describe` in which `invariant`,
`examples`, `deadCode` or `architecture` is called (a scenario of a "registry
+ invariant" standard): from the sources, without a report or the `spec`
branch; only a describe where the check is new (the describe is new, renamed,
or the registry, the rule or the `rule` of a `deadCode` run changed), — the
line names the registry, the rule, «код без потребителя» or «модель
архитектуры». No call in the sources (the `spec-claims` report is written by a
script after the run) — the describes of new tests from the report
(`--report`), the line says «по отчёту» ("from the report"). Tests from the
report that this check generated are tests of its scenario, not beyond the
scenarios. No section — the check says so.

Compares test names **statically** — parses the `tests/` files at two
revisions via `git show`, no need to run tests or switch branches.
The base is the merge-base of the base branch and HEAD, like a PR diff on
GitHub (a test added to `main` after branching isn't counted as removed);
`--no-merge-base` — comparison with the branch as is. `--worktree` — the
working tree instead of HEAD, to look before a commit. Before running —
`git fetch origin`, otherwise `origin/main` is stale.

Tests that the harness generates (per registry item, «не пуст» ("not empty"),
violator, exceptions, examples) aren't in the sources — only the report sees
them. `--report <report>` (repeatable) adds them to the parsed ones: the head
— from the PR run's report, the base — `tests.json` of the `spec` branch
(written by `spec-doc`, published by `spec-publish`) from the commit whose
`Source:` is the merge-base or its ancestor (`--spec-branch`, default
`origin/spec`). No such commit — a diff by sources, and the line under «База»
("base") says so. `Source:` older than the diff base (publishing on a PR merge
was skipped, `spec-run`) — the line names both commits: the lists may contain
tests of PRs merged between them. A merge that didn't change the spec doesn't
create a gap: `spec-publish` confirms the publication with a new `Source:`.

A test's identity is the folder path + the `describe` chain + `it`: a move
between files of one folder isn't a change, a move to another folder is
removed and added (the requirement changed home). The output is a ready
section for the PR body:

```markdown
## Спека (тесты)

_База: `origin/main (merge-base)`._

**Удалены (1):**

- `tests/capabilities/billing` · Invoices › a draft is deleted without an invoice

**Изменены (1):**

- `tests/capabilities/billing` · Invoices › ~~an invoice is issued~~ → a monthly invoice is issued

**Добавлены (1):**

- `tests/capabilities/billing` · Invoices › an invoice for a partial month is proportional to its days

**Вне дерева `tests/`** изменены файлы тестов: `src/utils/sum.test.ts`.
```

The removed come first: a removed test is a removed requirement, it must be
visible. «Изменены» ("changed") are renames: a test with the same body in the
same file, even if both the `describe` and the name changed (translating names
into statements; the body is the only one in the file among the removed and
new ones, an empty one isn't a sign; compared without whitespace and trailing
commas — prettier re-wrapping a call doesn't change the body), a test with a
similar name in the same file and the same `describe` (similarity ≥ 0.6) or a
test with the same name under another `describe` of the same folder,
including from another file (that's what moving unit and e2e tests into the
main file's capability section looks like); a dissimilar name with a
different body is honestly removed and added. An empty list prints as «нет»
("none"), so it's visible that the check ran. Tests inside `tests/` but
outside capabilities/standards are marked `⚠️ вне дерева` ("outside the
tree"); changed test files outside `tests/` are listed by name. The flow copy
(`.agents/`, `.claude/` from the root) is not project code: `install` puts it
there, the project's linters don't see it — neither its tests nor its lint
disables are in the spec diff. `--json` — the same, machine-readable.

**A big PR.** More tests in the lists (removed, changed, added) than the
`--limit` threshold (default 100) — a per-folder summary instead of the lists:
a table «Удалены | Изменены | Добавлены», with `--report` also «Из них
харнесса» ("of them, from the harness"). The removed ones go above the table
as a list (a removed requirement is visible by name) as long as there are no
more of them than the threshold; the decision
sections and «Тесты сверх сценариев» ("tests beyond scenarios") above the
threshold — a number per folder or file. The full list — `--full`; CI writes
it to the job summary, the summary goes to the PR body.

**A move into the tree** (a project moves to a test spec): a test that on the
base was in a file outside `tests/`, disappeared there and appeared in the
tree with the same `describe` chain and name is not "added" but moved. Such
tests go in one section, «Перенесены в дерево» ("moved into the tree"), — a
per-folder summary without a line-by-line list (otherwise a PR with thousands
of moved tests wouldn't fit into the PR body):

```markdown
**Перенесены в дерево (3):** названия те же, что вне `tests/` на базе; из 2 файлов.

- `tests/capabilities/auth` — 1 тест из 1 файла
- `tests/capabilities/math` — 2 теста из 1 файла
```

A file moved entirely (deleted, all its tests found a pair) doesn't go into
the "outside the tree" list; one that stayed or has some tests without a pair
— by name: something was renamed or lost in the move. A test renamed during
the move is "added", a test that also stayed outside the tree is a copy, also
"added". In `--json` — `moved` with the original (`from`) and the new path of
each test.

The section is inserted into the PR body as a whole (after `Closes #N`); on
new commits with tests — regenerate it and replace it.

## spec-publish

```bash
bun <skill dir>/scripts/spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--attempts 3] [--interval 5] [--check]
```

The root of the `spec` branch is the contents of `docs/spec`; the commit
message has `Source: <SHA>` it was built from (default `HEAD`; publishing on a
PR merge without CI on `main` — the merge SHA, `ci.md`: `spec-diff` searches
its ancestors). The working copy and `HEAD` aren't touched: the tree is
assembled in a temporary index, the commit goes on top of the published one,
the publication history is kept. The same source — no new commit («без
изменений», "no changes"); the same content from a new source — a commit with
the same tree and a new `Source:` («без изменений — … подтверждена для …»,
"no changes — … confirmed for …"): the branch names the last checked `main`,
and a gap with the diff base in `spec-diff` is only a skipped publication. The
published `Source:` is a descendant of the new source — «уже новее» ("already
newer"), exit code 0, the branch isn't touched: publications arrive out of
merge order (`main` runs are parallel, `ci.md`); comparing is possible only
with history (in a shallow clone the previous source is unknown — it
publishes), the checkout in CI has it. A rejected push (another publication
moved the branch between `fetch` and `push`, a hosting failure) is not a
failure: the log gets the reason from `git push` stderr, a pause of
`--interval` × the attempt number (5 s, 10 s…), the branch is re-read, and the
decision is made again — built from a descendant gives «уже новее», otherwise
a commit on top of the new head; up to `--attempts` attempts. After the push
the branch is read from the remote and compared with the directory: exactly
what was built is published, not "the push went through". `--check` —
comparison only (exit code 1 if the branch is behind or missing).
Exit codes: 0 — published, matches or already newer, 1 — mismatch or the push
rejected on all attempts, 2 — no directory or not git. Without a configured
`git user` the commit is from the GitHub Actions bot.

## spec-run

```bash
bun <skill dir>/scripts/spec-run.ts --tree <hash> [--timeout 1800] [--interval 15]
```

Publishing on a PR merge without CI on `main` (`ci.md`): the id of the green
run that checked the merge commit's tree (`git rev-parse 'HEAD^{tree}'`) — to
stdout, for `gh run download`. A PR run names its artifact after the tree it
checked (merge-ref): `docs-spec-<hash>`. The script takes the unexpired
artifacts with this name from runs of this repository (not a fork) and asks
for the outcome of each run: an artifact is uploaded mid-run and doesn't
prove a green outcome. There is a run with `success` — that one; there is one
in progress — polling until the outcome (only state changes go to the log),
not finished by the ceiling — exit code 1. Otherwise — no artifact (a PR that
fell behind was merged: no run checked such a `main`), expired, from a fork,
the run isn't green — exit code 0, stdout empty, in stderr «дерево main … не
проверено целиком — публикация пропущена» ("main tree … not fully checked —
publishing skipped") with the reason: the `spec` branch lags until the next
merge with a matching tree, but isn't rolled back. Exit codes: 0 — found or
publishing skipped, 1 — the run didn't finish by the ceiling, 2 — a call
error or `gh`.

## spec-break

```bash
bun <skill dir>/scripts/spec-break.ts --file <file> --find <fragment> --replace <replacement> [--name <name>] [--no-baseline] -- <test command…>
bun <skill dir>/scripts/spec-break.ts --plan breaks.json [--no-baseline] [-- <test command…>]
bun <skill dir>/scripts/spec-break.ts --restore
```

A decision's check must be able to fail: a breakage is a code edit that
should turn it red. The agent picks the breakage for one check (this is not
mutation testing): the `--find` fragment occurs in the file exactly once,
otherwise exit code 2 before the run. A plan is JSON
`[{ name, file, find, replace, cmd? }]` (`cmd` — a string for `sh -c`,
without it — the command after `--`); each breakage is a separate run: the
first red test in a serial group hides the rest.
Before the breakages — a baseline run of each command: red even without a
breakage — exit code 2, breakages aren't applied (`--no-baseline` — skip it).

Output — `✅ упал: <name> (<file>)` ("failed") / `❌ не упал: …` ("didn't
fail") and a total; exit codes: 0 — every breakage made it fail, 1 — there is
a ❌, 2 — an error. Revert — always: after the run; on SIGINT/SIGTERM/SIGHUP
(the test command is killed with all its processes); after an interruption
without a revert (kill -9, a closed session) — from the journal
`.git/spec-break.json`, written before the edit: the next run or `--restore`
restores the file; the file was edited after the interruption — the journal
isn't applied, exit code 2 — compare by hand.

## spec-exceptions

```bash
bun <skill dir>/scripts/spec-exceptions.ts [--root DIR]
```

A decision's exceptions are the folder's `exceptions/` directory, one file per
exception (`<item>.json`: `{ item, rule?, issue, reason }`), not an array in
`exceptions.ts`: the subtasks paying down the debt delete their own files in
parallel and don't conflict (with an array each next one got a conflict on
neighboring lines and a repeated CI run). The command moves each
`exceptions.ts` (`.mts`, `.js`, `.mjs`, `.json`) of a decision folder
`tests/<kind>/<name>` or its subfolder into the decision folder's
`exceptions/` directory (read by `exceptionsIn()` of a test in any
subfolder): one file per exception (the name is the item in Latin letters,
`rule--` in front), the old file is deleted; the import in the files of the
folder and subfolders (`import exceptions from "./exceptions.ts"`) — to
`const exceptions = exceptionsIn()` with an import from the harness; the path
to the old file in `package.json` and `.github/workflows/*.yml` (`spec-claims
--exceptions`) — to the directory. spec-doc name exceptions
(`{ file, name, issue, reason }`) — the folder's `names.exceptions.ts`, the
shared `tests/standards/spec-names/exceptions.ts` and the file of the
`--names-exceptions` flag from `package.json` and the workflow — are laid out
as a file per name in `names.exceptions/` of their test's decision folder (a
test outside the tree — to the decision folder of the former file: spec-doc
will call the exception unneeded), the flag is removed. Which file belongs to
whom — one rule, `exceptionFile` (`speclib.ts`), for the harness, spec-doc,
spec-diff and spec-exceptions (the ai-dev standard `exception-files`); the
command doesn't touch files outside decision folders. Output
— lines `-` (file moved), `+` (new file), `~` (import or path rewritten, flag
removed), `!` (fix by hand: a reference from another folder, no harness
import). Exit codes: 0 — moved or nothing to move, 1 — there is a `!`, 2 — an
exceptions file doesn't load or isn't an array of `{ item, … }`
(`{ file, name, … }` for names). A repeated run changes nothing.

## Checks — `harness.ts`, `architecture.ts`, `spec-claims.ts`

A mechanical check is runner tests (or a report in the runner's format): they
are in the report, and so in `docs/spec` and in `spec-diff`. Import — from the
skill's copy in the project (`.agents/skills/spec/scripts/…`), the runner
doesn't matter — `it` passes the test in. How to wire each one — `checks.md`
next to this file.

| What to check | With what | Where in `tests/` |
|---|---|---|
| A convention on every item of a registry from the code ("every mutation writes an audit record") | `invariant` | `standards/<name>/` |
| A lint rule: «нельзя» (forbidden), «можно» (allowed), «вне охвата» (out of scope) | `examples`, `eslintLinter` | `standards/<name>/` + an `eslint.ts` fragment |
| An ESLint rule in a standard's folder | `collectEslint` in `eslint.config.*` | the tree's `eslint.ts` fragments |
| Out of scope and an item's exception with its own file | `fileOf` in `invariant`; a mark `spec-outside(<decision>)` / `spec-exception(<decision>) #N` in the file (`marksIn`), in JSON — the value of the `"//"` key | the item's file (a route, a script, a migration, a workspace package's `package.json`) |
| Exceptions with a ratchet | `exceptionsIn()` → `exceptions` in `invariant`; a disable `-- #N reason` + `lintExceptions` | the decision folder's `exceptions/<item>.json`; migration — `spec-exceptions` |
| Architecture model: module boundaries, directories, packages | `boundariesConfig`, `architecture` | `architecture/model.ts`, `architecture/<name>/` |
| External systems (C1): hosts, packages, keys and headers — only in adapters, a perimeter without an adapter, network in tests, CSP | `externals` in the model, `architecture`, `networkGuard`, `cspConnectSrc` | `architecture/model.ts`, test setup |
| Containers (C2): modules and libraries, links, deploy configs (compose, Supabase, Vercel, Terraform), storage clients | `containers` in the model, `architecture`, `deployUnits` | `architecture/model.ts` |
| Monorepo workspace packages — in the model's roots; dev tools outside the model — out of scope with a reason | `architecture` (`outside`), `workspacePackages` | `architecture/model.ts`, a mark in the package's `package.json` |
| Interaction order in a scenario, a sequence diagram | `trace` in boundary wrappers, `sequence` | a capability test |
| Every entry point is called by a capability test | `journal` + `spec-claims` after the run | `standards/entry-points/` |
| No code without a consumer (files, exports, dependencies, knip config; production mode) | `deadCode` from the knip report, the `knip-hints.cjs` reporter | `standards/dead-code/` |
| Environment variables are declared and read (monorepo — per app) | `envVars`, `dotenvNames`, `configGet` in `readers` | `standards/env/` |

## Wiring into a repository

How to sort out an old spec's requirements (OpenSpec, a requirements
document) when switching — an outcome for each, check by breaking, what is
removed without a test — `migration.md` next to this file.

The scripts are taken from the skill's copy in the project itself and run
under Node — a Node project doesn't need Bun. The ai-dev flow install puts the
copy there, and it is committed: the agent before a PR and CI call the same
project `spec:doc` / `spec:diff` over the same files, so what the agent sees
locally matches CI. Why a copy and not a submodule, a checkout in the workflow or a package —
`reference.md`.

1. **Install** at the project root, the result (`.agents/`, `.claude/`, the
   block in `AGENTS.md`) goes into a commit:
   ```bash
   npx -y github:miroshnik/ai-dev install
   ```
   - Exclude `.agents/` and `.claude/` from the project's linters and
     formatters (`ignores` in ESLint, `.prettierignore`, `include` in
     tsconfig): they hold ai-dev code and Markdown.
   - Update — the same command in a separate PR, then the reports and
     `spec:doc --strict`; if the format changed — CI publishes the new one
     after the merge.
2. **Scripts** in `package.json` — via `node`: Node ≥ 22.18 strips types
   itself, the skill's `scripts/package.json` sets ESM for any project `type`.
   Reports — those the project has:
   ```json
   "spec:doc": "node .agents/skills/spec/scripts/spec-doc.ts .spec-report.json .spec-playwright.json .spec-claims.xml --strict",
   "spec:diff": "node .agents/skills/spec/scripts/spec-diff.ts",
   "spec:publish": "node .agents/skills/spec/scripts/spec-publish.ts",
   "spec:claims": "node .agents/skills/spec/scripts/spec-claims.ts --entries tests/standards/entry-points/entries.ts"
   ```
   Fast checks — the `test:spec` script of the project's runner, standards and
   architecture (`"test:spec": "vitest run tests/standards tests/architecture"`):
   `github pr premerge` runs it before a merge on the merge with a fresh
   `main` (after `typecheck`, if there is one).
   Before `spec:doc` locally — a full run with reports (section "Reports for
   spec-doc"). In `.gitignore`: `docs/spec/`, `.spec-*.json`, `.spec-*.xml`,
   `.spec-meta/`, `.spec-journal/`, `vitest-blob/`, `blob-report/`,
   `playwright-blob/`.
3. **`docs/spec/` isn't committed to `main` — CI publishes it to the `spec`
   branch:** it is a derived copy of the tests, and in `main` parallel PRs
   would conflict in its pages and table of contents. The reviewer sees the
   requirements delta in `spec-diff` (the PR body), a prose edit — in the
   test's JSDoc diff. Switching a project where `docs/spec` is already in
   `main`: `git rm -r --cached docs/spec`, a line in `.gitignore`, CI steps —
   item 4 and `ci.md`.
4. **CI.** Shards write blob reports, a separate `spec` job after all shards
   merges them with the runners' own tools (`vitest --merge-reports`,
   `playwright merge-reports` — all Playwright projects in one report) and
   builds `docs/spec` with `--strict`; on `main` it hands it as an artifact to
   the `spec-publish` job — only that job has a write token
   (`contents: write`), and it doesn't install the project's dependencies. A
   test failed — `spec` doesn't run: there is no point building documentation
   from a red run. `spec-diff` is its own light job: it needs git history and
   Node, not tests, so the section is in the summary even with red tests. A
   fragment for pnpm (in `package.json` — `packageManager`), Vitest in 3
   shards, Playwright in 2; concurrency per `docs/ci-concurrency.md` — the
   workflow fragment is in `ci.md` next to this file.
   All CI on the PR, no tests on `main` — publishing on a PR merge from its
   run's artifact, the second variant in `ci.md`.
5. **Monorepo** — a decision's tests in package subfolders
   `tests/<kind>/<name>/<package>/` (`canon.md`, "A decision is the unit of
   the spec, a folder is its home"): a package has its own runner project with
   its aliases, environment and plugins, which takes `tests/*/*/<package>/`;
   tests directly in the decision folder are cross-cutting, the root runner
   takes them. Run from the repository root: the harness (`exceptionsIn`,
   `.spec-meta/`, the `spec-claims` journal) counts paths from cwd. The
   packages' reports go into `spec:doc` as one list: there is one decision
   page, the main file is at the folder root or in a package subfolder.

## Limitations to know about

- The TS/JS scanner takes tests from the parser's AST; the name is a string
  known without a run (a literal, a template without substitutions, their
  concatenation), the first argument of `describe` / `it` / `test` (and the
  `x…`/`f…` variants, `suite`, `context`, `test.describe`), for `.each`,
  `.for`, `.runIf`, `.skipIf` — of the second call: `it.each(...)('name %s')`
  — a name with a placeholder; a type argument (`it.each<T>(…)`,
  `test<Ctx>(…)`) doesn't get in the way. A name that can't be computed (a
  template with a substitution, a variable) — a line in stderr with the
  location: such a test isn't in the `spec-diff` lists, `spec-doc` names it if
  it has a JSDoc. Modifiers — only known ones (`skip`, `only`, `todo`, `each`,
  `for`, `concurrent`, `serial`, `fixme`, `fails`…): `test.step`, `test.use`,
  `beforeEach` are not tests. A file the parser couldn't parse — a line in
  stderr with the error location.
- Vitest and `bun test` reports don't contain the skip reason — keep it in the
  test name or in a comment next to it (rule: `skip` without a reason and an
  issue number is a lint error).
- The scanner knows the prose of `it.each` and `describe.each` under the name
  with a placeholder (`sum %i + %i`), and the report — under the substituted
  one; such JSDoc doesn't get into the documentation.
- The scripts don't judge tests — what fails, the runner will tell. `spec-doc`
  only shows the status; on `main` everything must be ✅ or ⏭️ with a reason.
- The rationale for the choice of formats and static parsing — `reference.md`.
