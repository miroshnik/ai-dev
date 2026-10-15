# spec — script details and why it is so

A reference for `SKILL.md`: what each script does in detail (syntax, flags and
exit codes — its `--help`), then the reasoning behind decisions and parsing
details.

## spec-doc output — what ends up in docs/spec

What ends up in `docs/spec/` (the generated text is in the project language):

- `README.md` — the index: «What the system does» (per
  capability), «What it's made of» (the architecture page
  as the first line, then per architecture rule; neither a model nor rules —
  no section), «Which rules the code obeys»
  (per standard); each link has the first paragraph of `<folder>.md` (the
  description) and, if any, the number of skipped and failing tests; the
  «Outside the tree» section — only if there are such tests;
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
  collapsed block `<details><summary>✅ 12 tests</summary>` (**what checks
  it**), with lines `- ✅ name` inside. A skipped one —
  `⏭️ … — skipped: <reason>` (the reason comes from the Playwright
  annotation; Vitest and `bun test` don't put the reason into the report), a
  failing one —
  `❌ … — failing`, `📝 … — todo`; if there are such, the counter is in the
  block's line (`❌ 12 tests, 1 skipped, 1 failing`), and the block is
  expanded. A test in several Playwright projects
  — one line. There is no "section · path · N tests" line: the section and
  path follow from the convention. Names are text: `<` outside a code span is
  escaped, otherwise GitHub would eat `<type>` or `<!-- … -->` as HTML (same
  in `spec-diff`);
- the first line of every file is the marker `<!-- spec-doc: … -->`: by it the
  script deletes its own stale files (a capability disappeared) and doesn't
  touch others'.

`tests/lib` is skipped. Tests outside `tests/capabilities/<name>`,
`tests/architecture/<name>` and `tests/standards/<name>` (in `src/`, in
`tests/unit/`, a file directly in `tests/capabilities/`) go to «Outside the tree» —
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
`.agents/ai-dev.json` of the `--root` directory; `isStatement`): `ru` — a name
with Russian words, another language — a phrase of words (two or more, or one
whole word); an identifier (`parseScenarios`, `foo_bar`, `fooBar`), a function
or file name, a path, a word with a number — not a statement: a stderr line
`warning: the name isn't a statement …` with the name and file, without an
exit code — `--strict` doesn't fail on it, the PR section of `spec-diff`
counts the PR's new ones; code in backticks inside a statement is fine. A
measurement (#441): `--strict` failed on names 9 times in three weeks, all 9
paperwork — thousands of renames for the check or names put into exceptions;
the rule stays a rule, without an exit code (#447). Name exceptions are gone:
a leftover `names.exceptions/` directory or `names.exceptions.*` file of a
decision folder isn't read — a warning line asking to delete it; the
`--names-baseline` and `--names-exceptions` flags are gone too (exit code 2,
like any unknown flag). The generated `docs/spec`, the PR section of
`spec-diff` and the names of the harness's tests are in the project language
too (the `spec` keys of `locales/<language>.json` of the `github` skill).
**Description** — `tests/<kind>/<name>/<name>.md`: missing — `spec-doc` names
the file in stderr, `--strict` — exit code 1. A JSDoc header on a test file
doesn't go into the documentation — into stderr with a hint to move it to md,
`--strict` — exit code 1. A standard's former main file `rule.*` — also into
stderr with a hint to rename it to `<name>.*`, `--strict` — exit code 1.

## Writing prose — `<folder>.md` and JSDoc

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
- A test file's header doesn't go into the documentation (section "spec-doc
  output" above): its text belongs in `<folder>.md` or in `//`.
- The source is read by the path from the report, from the root (`--root`); no
  file (a report from another machine) — documentation without prose, the list
  of such files in stderr.

## spec-diff output — decision sections, scenarios, renames, a big PR

Decisions outside test names — as separate sections «<title> — removed» and
«<title> — added», only if they changed: «Architecture model» (modules,
dependencies, packages from `tests/architecture/model.ts`),
«Exceptions» (the files of the decision folders' `exceptions/` — not in a
subfolder and `.json`, as the harness reads them, — entries of the former
`exceptions.ts` — the item and the harness `rule` — and lint disables
`eslint-disable … -- #N` in changed files,
except the flow copy `.agents/` and `.claude/`; each entry
is its own line, identical ones aren't collapsed), «Harness checks»
(`invariant` registries and `examples` rules — the
`registry` / `rule` options of the object in the call's arguments, by parsing
the source, with a string known without a run; `deadCode` runs —
«code without a consumer», with `rule` or `production: true` in
parentheses; `architecture` — «architecture model»;
their tests appear only in a run). The model and
exceptions are read by importing the revision's data file: a module with
imports outside its own boundaries isn't read, its decisions aren't shown.

`--scenarios` — the task body (`gh issue view N --json body --jq .body | … --scenarios -`):
the `## Scenarios` section (the script reads only the `ru` name so
far) is checked against the added and changed tests — «### Task scenarios»;
each name on one line, once. A scenario that became a test
is named the same as the test: while the tests are in the lists above, it is
only in the «Became tests» count, and a test beyond the
scenarios gets the «beyond scenarios» mark in the list; in
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
line names the registry, the rule, «code without a consumer» or
«architecture model». No call in the sources (the `spec-claims` report is written by a
script after the run) — the describes of new tests from the report
(`--report`), the line says «from the report». Tests from the
report that this check generated are tests of its scenario, not beyond the
scenarios. No section — the check says so.

Compares test names **statically** — parses the `tests/` files at two
revisions via `git show`, no need to run tests or switch branches.
The base is the merge-base of the base branch and HEAD, like a PR diff on
GitHub (a test added to `main` after branching isn't counted as removed);
`--no-merge-base` — comparison with the branch as is. `--worktree` — the
working tree instead of HEAD, to look before a commit. Before running —
`git fetch origin`, otherwise `origin/main` is stale.

Tests that the harness generates (per registry item, «not empty»,
violator, exceptions, examples) aren't in the sources — only the report sees
them. `--report <report>` (repeatable) adds them to the parsed ones: the head
— from the PR run's report, the base — `tests.json` of the `spec` branch
(written by `spec-doc`, published by `spec-publish`) from the commit whose
`Source:` is the merge-base or its ancestor (`--spec-branch`, default
`origin/spec`). No such commit — a diff by sources, and the line under «Base»
says so. `Source:` older than the diff base (publishing on a PR merge
was skipped, `spec-run`) — the line names both commits: the lists may contain
tests of PRs merged between them. A merge that didn't change the spec doesn't
create a gap: `spec-publish` confirms the publication with a new `Source:`.
A partial run's report (`bun test <one folder>`): a head file whose tests only
a run names — an `invariant`, `examples`, `deadCode` or `architecture` call,
or a test name that can't be computed statically (a template with a
substitution in a loop) — but no test in the report wasn't run: its tests
from `tests.json` aren't compared and aren't «Removed»; a line under «Base»
names the folders and asks for a full run's report, `--json` lists the tests
in `unreported`. A file without such a call or test in the head — its tests
are removed.

A test's identity is the folder path + the `describe` chain + `it`: a move
between files of one folder isn't a change, a move to another folder is
removed and added (the requirement changed home). The output is a ready
section for the PR body:

```markdown
## Spec (tests)

_Base: `origin/main (merge-base)`._

**Removed (1):**

- `tests/capabilities/billing` · Invoices › a draft is deleted without an invoice

**Changed (1):**

- `tests/capabilities/billing` · Invoices › ~~an invoice is issued~~ → a monthly invoice is issued

**Added (1):**

- `tests/capabilities/billing` · Invoices › an invoice for a partial month is proportional to its days

**Outside the `tests/` tree** changed test files: `src/utils/sum.test.ts`.
```

The removed come first: a removed test is a removed requirement, it must be
visible. «Changed» are renames: a test with the same body in the
same file, even if both the `describe` and the name changed (translating names
into statements; the body is the only one in the file among the removed and
new ones, an empty one isn't a sign; compared without whitespace and trailing
commas — prettier re-wrapping a call doesn't change the body), a test with a
similar name in the same file and the same `describe` (similarity ≥ 0.6) or a
test with the same name under another `describe` of the same folder,
including from another file (that's what moving unit and e2e tests into the
main file's capability section looks like); a dissimilar name with a
different body is honestly removed and added. An empty list prints as «none»,
so it's visible that the check ran. Tests inside `tests/` but
outside capabilities/standards are marked `⚠️ outside the tree`;
changed test files outside `tests/` are listed by name. The flow copy
(`.agents/`, `.claude/` from the root) is not project code: `install` puts it
there, the project's linters don't see it — neither its tests nor its lint
disables are in the spec diff. After the lists — the number of the PR's new
names that aren't statements in the project language: `it` and `describe`
names of added and changed tests that the same file didn't have at the base
(`⚠️ **Names that aren't statements: N** — new in this PR…`); none — no line;
`spec-doc` names each one in a warning. `--json` — the same, machine-readable
(the number — `not_statements`).

**A big PR.** More tests in the lists (removed, changed, added) than the
`--limit` threshold (default 100) — a per-folder summary instead of the lists:
a table with the columns «Folder», «Removed», «Changed», «Added», with
`--report` also «Of them, from the harness». The removed ones go above the table
as a list (a removed requirement is visible by name) as long as there are no
more of them than the threshold; the decision
sections and «Tests beyond scenarios» above the
threshold — a number per folder or file. The full list — `--full`; CI writes
it to the job summary, the summary goes to the PR body.

**A move into the tree** (a project moves to a test spec): a test that on the
base was in a file outside `tests/`, disappeared there and appeared in the
tree with the same `describe` chain and name is not "added" but moved. Such
tests go in one section, «Moved into the tree», — a
per-folder summary without a line-by-line list (otherwise a PR with thousands
of moved tests wouldn't fit into the PR body):

```markdown
**Moved into the tree (3):** the same names as outside `tests/` on the base; from 2 files.

- `tests/capabilities/auth` — 1 test from 1 file
- `tests/capabilities/math` — 2 tests from 1 file
```

A file moved entirely (deleted, all its tests found a pair) doesn't go into
the "outside the tree" list; one that stayed or has some tests without a pair
— by name: something was renamed or lost in the move. A test renamed during
the move is "added", a test that also stayed outside the tree is a copy, also
"added". In `--json` — `moved` with the original (`from`) and the new path of
each test.

The section is inserted into the PR body as a whole (after `Closes #N`); on
new commits with tests — regenerate it and replace it.

## spec-publish — the branch, retries, exit codes

The root of the `spec` branch is the contents of `docs/spec`; the commit
message has `Source: <SHA>` it was built from (default `HEAD`; publishing on a
PR merge without CI on `main` — the merge SHA, `ci.md`: `spec-diff` searches
its ancestors). The working copy and `HEAD` aren't touched: the tree is
assembled in a temporary index, the commit goes on top of the published one,
the publication history is kept. The same source — no new commit
(«no changes»); the same content from a new source — a commit with
the same tree and a new `Source:` («no changes — … confirmed for …»):
the branch names the last checked `main`,
and a gap with the diff base in `spec-diff` is only a skipped publication. The
published `Source:` is a descendant of the new source — «already newer»,
exit code 0, the branch isn't touched: publications arrive out of
merge order (`main` runs are parallel, `ci.md`); comparing is possible only
with history (in a shallow clone the previous source is unknown — it
publishes), the checkout in CI has it. A rejected push (another publication
moved the branch between `fetch` and `push`, a hosting failure) is not a
failure: the log gets the reason from `git push` stderr, a pause of
`--interval` × the attempt number (5 s, 10 s…), the branch is re-read, and the
decision is made again — built from a descendant gives «already newer», otherwise
a commit on top of the new head; up to `--attempts` attempts. After the push
the branch is read from the remote and compared with the directory: exactly
what was built is published, not "the push went through"; the next publication
already on top of ours (our commit in the branch's history) isn't a mismatch —
a log line names the new head (#443). `--check` —
comparison only (exit code 1 if the branch is behind or missing).
Exit codes: 0 — published, matches or already newer, 1 — mismatch or the push
rejected on all attempts, 2 — no directory or not git. Without a configured
`git user` the commit is from the GitHub Actions bot.

## spec-run — the green run for the merge tree

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
the run isn't green — exit code 0, stdout empty, in stderr «main tree … not
fully checked — publishing skipped» with the reason: the `spec` branch lags
until the next
merge with a matching tree, but isn't rolled back. Exit codes: 0 — found or
publishing skipped, 1 — the run didn't finish by the ceiling, 2 — a call
error or `gh`.

`--artifact <name>` — for `spec-shard`: the newest green run of this
repository with an unexpired artifact of that name (`spec-reports` — the
merged reports of the `spec` job). Runs are asked newest first, up to the
first `success`; one in progress isn't waited for — its outcome is unknown,
the previous green one does. None — code 0, stdout empty, in stderr «no green
run» with the runs asked: the shards split by count.

## spec-shard — CI shards by durations

A runner's `--shard` doesn't look at time: Playwright cuts the suite in a row
by the count of tests in path order, Vitest — files by the hash of the path.
The heavy tests of one folder land in one shard, the PR waits for it, the
others stand idle. `spec-shard --shard k/n --runner vitest|playwright --list
<file> --report <file>…` prints shard k's filters, one per line; the CI step
(`ci.md`, "Shards by durations") passes them to the runner instead of
`--shard`.

- **The list** — the runner's own: `vitest list --filesOnly --json=<file>`
  (`[{ file }]`, absolute paths), `playwright test --list --reporter=json`
  (file suites relative to `config.rootDir`) or one path per line. Absolute
  paths become relative to the root (`--root`, default — the current
  directory: the runner reads the filters from it).
- **Durations** — the reports `spec-doc` reads: Vitest/Jest — the file's
  `endTime - startTime` (hooks between tests count), without them — the sum
  of its tests; Playwright — the sum of all results of the file's tests (each
  project and retry takes a worker's time); `bun test` JUnit — the file
  suite's `time`. A report's path goes to the listed file it ends with: a
  report from another machine (the CI artifact) works without a common
  root. A file in several reports — the longest. A missing report file isn't
  an error (the artifact may be gone); no durations — every file weighs the
  same, the split is by count; a file without a measurement gets the mean of
  the measured ones.
- **Layout** — greedy (LPT): groups from the heaviest into the lightest
  shard; ties — by path (the sort is stable, the list is sorted). The same
  inputs give the same shards in every job of the matrix: each job computes
  its own shard, and the shards must agree.
- **Filters.** Vitest takes a file whose path relative to its project's root
  contains the filter (or the filter's path relative to that root),
  case-insensitively (`filterFiles` in `vitest/node`) — the filter is the
  path. Playwright tests a regular expression against the absolute path —
  the filter is `/(^|\/)<escaped path>$/`: a dot stays a dot, and the path
  ends where the file does. A filter that still takes another file
  (`tests/a.test.ts` in `packages/web/tests/a.test.ts`; for Vitest — inside
  any directory common to both paths: the project root isn't known) — both
  go into one shard, a stderr line names them: the shard's filters take
  exactly its files. The guard — a real Playwright run over the shards'
  filters: every file once, in its shard.
- **Playwright dependencies** (a login project before the tests) aren't cut
  by filters: the runner adds dependency projects without them — the login
  runs in every shard. Its file in the list adds its time to one shard only.
- **An empty shard** (more shards than files) — stdout is empty, code 0: the
  step doesn't start the runner, without filters it would run everything.
- **The unit is a file:** a file longer than a shard's share stays the bound —
  split the file. With `--shard` Playwright splits a file between shards
  (`fullyParallel`); with filters the file's tests spread over the shard's
  workers.
- Rejected: a durations file in the repository — it goes stale and needs
  commits; Vitest's `sequencer.shard` hook — a module in the project's
  config, and Playwright has no such hook; Playwright's `--test-list` (an
  exact list) — one mechanism for both runners instead of two.
- Codes: 0 — the shard is printed, 2 — a call error (arguments, the list or
  a report unreadable).

## spec-break — breakages and the revert

A decision's check must be able to fail: a breakage is a code edit that
should turn it red. The agent picks the breakage for one check (this is not
mutation testing): the `--find` fragment occurs in the file exactly once,
otherwise exit code 2 before the run. A plan is JSON
`[{ name, file, find, replace, cmd? }]` (`cmd` — a string for `sh -c`,
without it — the command after `--`); each breakage is a separate run: the
first red test in a serial group hides the rest.
Before the breakages — a baseline run of each command: red even without a
breakage — exit code 2, breakages aren't applied (`--no-baseline` — skip it).

Output — `✅ failed: <name> (<file>)` / `❌ didn't fail: …` and a total;
exit codes: 0 — every breakage made it fail, 1 — there is
a ❌, 2 — an error. Revert — always: after the run; on SIGINT/SIGTERM/SIGHUP
(the test command is killed with all its processes); after an interruption
without a revert (kill -9, a closed session) — from the journal
`.git/spec-break.json`, written before the edit: the next run or `--restore`
restores the file; the file was edited after the interruption — the journal
isn't applied, exit code 2 — compare by hand.

## spec-exceptions — what it moves and rewrites

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
--exceptions`) — to the directory. Which file belongs to whom — one rule,
`exceptionFile` (`speclib.ts`), for the harness, spec-diff and
spec-exceptions (the Elves standard `exception-files`); the
command doesn't touch files outside decision folders. Output
— lines `-` (file moved), `+` (new file), `~` (import or path rewritten), `!`
(fix by hand: a reference from another folder, no harness import). Exit codes:
0 — moved or nothing to move, 1 — there is a `!`, 2 — an exceptions file
doesn't load or isn't an array of `{ item, … }`. A repeated run changes
nothing.

## Wiring into a repository — step by step

How to sort out an old spec's requirements (OpenSpec, a requirements
document) when switching — an outcome for each, check by breaking, what is
removed without a test — `migration.md` next to this file.

The scripts are taken from the skill's copy in the project itself and run
under Bun — the flow's only runtime, a Node project included (in CI — the
`oven-sh/setup-bun@v2` step, `ci.md`). The modules the project's tests and
config import — `harness.ts`, `architecture.ts`, `eslint-config.ts` — load
under the project's own runner (Vitest, Jest, Playwright, ESLint on Node), not
Bun: only `node:` APIs and erasable TypeScript, no `import.meta` and no
top-level `await` (Playwright and Jest load them as CommonJS). The Elves flow
install puts the copy there, and it is committed: the agent before a PR and CI call the same
project `spec:doc` / `spec:diff` over the same files, so what the agent sees
locally matches CI. Why a copy and not a submodule, a checkout in the workflow or a package —
section "Wiring into the project's CI" below.

1. **Install** at the project root, the result (`.agents/`, `.claude/`, the
   block in `AGENTS.md`) goes into a commit:
   ```bash
   bunx github:miroshnik/elves install
   ```
   - Exclude `.agents/` and `.claude/` from the project's linters and
     formatters (`ignores` in ESLint, `.prettierignore`, `include` in
     tsconfig): they hold Elves code and Markdown.
   - Update — the same command in a separate PR, then the reports and
     `spec:doc --strict`; if the format changed — CI publishes the new one
     after the merge.
2. **Scripts** in `package.json` — via `bun`: Bun runs TypeScript itself,
   for any project `type`. Reports — those the project has:
   ```json
   "spec:doc": "bun --no-env-file .agents/skills/spec/scripts/spec-doc.ts .spec-report.json .spec-playwright.json .spec-claims.xml --strict",
   "spec:diff": "bun --no-env-file .agents/skills/spec/scripts/spec-diff.ts",
   "spec:publish": "bun --no-env-file .agents/skills/spec/scripts/spec-publish.ts",
   "spec:claims": "bun --no-env-file .agents/skills/spec/scripts/spec-claims.ts --entries tests/standards/entry-points/entries.ts"
   ```
   Standards and architecture run once — the `test:spec` script, a fast CI job
   of its own; `test` excludes them, e2e doesn't run them (`checks.md`):
   ```json
   "test": "vitest run --exclude 'tests/standards/**' --exclude 'tests/architecture/**'",
   "test:spec": "vitest run tests/standards tests/architecture"
   ```
   `github pr premerge` runs `test:spec` before a merge on the merge with a
   fresh `main` (after `typecheck`, if there is one); the flow's `check`
   requires it once `tests/standards` or `tests/architecture` exists and names
   both lines — `test:spec` and `test` without the same roots; with
   `test:spec` in place, a `test` that still runs them — an `○` line with
   that `test`.
   Before `spec:doc` locally — a full run with reports (`SKILL.md`, "Reports for
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
   shard's files — from `spec-shard` by the last green run's durations
   (section "spec-shard — CI shards by durations"). A
   test failed — `spec` doesn't run: there is no point building documentation
   from a red run. `spec-diff` is its own light job: it needs git history and
   Bun, not tests, so the section is in the summary even with red tests. A
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
   `.spec-meta/`, the `spec-claims` journal) counts paths from cwd; `fileOf` —
   a path from the project root, without a correction for cwd. The
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
- The rationale for the choice of formats and static parsing — the "Report formats"
  section and the "spec-diff: static parsing, not two reports" section below.

## Report formats

- Vitest and Jest JSON are one format (`testResults[].assertionResults[]`);
  Playwright JSON has its own tree `suites → specs → tests` with projects and
  annotations (the `skip` reason exists only there). The format is detected by
  the file's content, not its extension; several reports are merged by test
  key.
- `bun test` has no JSON report but produces JUnit XML (`--reporter=junit`):
  a file is a `testsuite` with `name = file`, a describe is a nested
  `testsuite` with a `file` attribute, a test is a `testcase`; `<skipped/>` —
  skipped, `<skipped message="TODO"/>` — todo. A hook (`beforeAll`,
  `afterAll`) of a skipped describe bun writes as a skipped `testcase`
  `(unnamed)` without `line` — not a test, it is dropped; a failed hook stays
  a failing test. The XML is parsed with regular
  expressions and a suite stack: Bun and Node have no XML parser without
  dependencies, and the format is simple. The entities `&amp;`, `&lt;`, `&#…;`
  are expanded.
- pytest and Python are deliberately not supported: the stack is TypeScript
  and Bun (issue #27, question 1).
- Reports are temporary files, in `.gitignore`. A report from CI with someone
  else's absolute paths works: the path is normalized by the `/tests/`
  segment. The runner itself merges shards (blob reports → one JSON); don't
  pass shard reports separately — Playwright splits a file between shards, and
  the order of tests in a file would depend on the order of the reports (the
  "Wiring into the project's CI" section below).

## spec-diff: static parsing, not two reports

- A report needs a run on two revisions: checking out the base (or a second
  worktree), installing dependencies, a full run — minutes and side effects,
  while only the names are needed. Static parsing takes files via `git show
  <rev>:<path>` in seconds and works in CI on a PR without a second run.
- The price is a parser instead of the runner: a name that can't be computed
  without a run (a template with substitution, a variable) doesn't go into the
  lists — it wouldn't match the name from a report — but is written as a line
  to stderr with its location; `it.each` is shown with its placeholder. Under
  the rule that `it` names are statements in the project language this is
  rare, and `describe`/`it` with string literals are parsed reliably.
- The source is parsed by a parser — `@babel/parser` as a file in the skill
  (`scripts/vendor/babel-parser.cjs` — the package's `lib/index.js`: one file
  without `require`, the MIT license next to it, types —
  `babel-parser.d.cts`). `speclib.ts` takes it with a static `import`, without
  `import.meta`: Playwright and Jest in a project without `"type": "module"`
  load the harness as CommonJS (#303). The home-grown lexer guessed where a
  regex was and where a division, where a template, a comment and a type
  argument, and on a mistake silently lost the file's tests (#267, #269, #271,
  #275): TypeScript syntax is wider than any guess (#277). Rejected: the
  project's TypeScript — 7.x (the Go port) has no in-process
  `createSourceFile`, only an unstable API via the tsgo process, and the
  synchronous variant doesn't work under Bun; `oxc-parser` — a native platform
  binary; the parser as a project devDependency — the `spec-diff` job in the
  project's CI would install dependencies, and its whole point is being light.
  To update — `npm pack @babel/parser`: `lib/index.js` without the last
  `//# sourceMappingURL` line (there is no map next to it — Vitest looks for it
  and prints an error) → `vendor/babel-parser.cjs`, `LICENSE` →
  `vendor/babel-parser.LICENSE`, the version — in a comment in `speclib.ts`.
- Plugins — by extension: `.ts` without JSX (`<T>x` is a type cast), `.tsx`
  and JS — with JSX, an unknown file (`codeOnly(text)`) — TypeScript, then
  TSX; decorators — both after `export` and on parameters. All arguments of a
  `describe` after the name count as its body; for `.each`, `.for`, `.runIf`,
  `.skipIf` the name is on the second call. A file that can't be parsed is an
  error with its location, not an empty test list.
- There is one parse — `parseCode` in `speclib.ts`: it serves the name
  scanner, the harness (ESLint comments, `codeOnly`, lines of neighboring
  files) and the «Harness checks» section of `spec-diff` —
  the `registry` option of `invariant` and `rule` of `examples` in the call
  arguments (`callOptions`); regexes over the text took a fixture in a string
  and an invariant's `rule` for a check (#289). Copies of the hand-written
  traversal diverged: an NBSP before a regex was code to the scanner and
  whitespace to the harness (#271); now JSX text `// …` is code for both, and a
  comment inside a template's `${…}` is a comment.

## A page is a story (#63)

- The first version put the headers of all the folder's files under the
  capability heading, sections in alphabetical path order, all tests as an
  expanded list. On a project that moved to a test spec from another format,
  the page became a patchwork quilt: notes to the developer from every file
  ("here is a pure function…"), sections by function names, a detail first,
  a hundred and fifty lines of tests hiding what the capability can do. The
  page must answer three questions: why, what it can do, what checks it.
- **The story is in the main file, named after the folder** (`<name>.test.ts`
  for a capability, an architecture rule and a standard). A standard used to
  have `rule.test.ts` — "the file by rule"; two rules instead of one, and the
  standard's folder has a name anyway — now there is one (elves#72). The
  place is known in advance: a code reader and an agent find the story without
  searching, and the page has a definite beginning — the `describe` order of
  the main file. Rejected: "any single file, `--strict` catches a second one" —
  the story's beginning would depend on where it was written.
- **The decision's description is `<folder>.md`, not a JSDoc header of the
  main file (elves#91).** A README next to the tests used to be rejected as a
  second source of meaning. The "what it can do" meaning is still only in the
  test names; the md holds what a test doesn't express — why, the reason for
  the decision, rejected alternatives (formerly `//`, invisible in the spec) —
  and GitHub renders it as is, with headings and diagrams. It is checked
  mechanically: no md — a `--strict` error; a header on a test file — one too
  (a second source of the introduction).
- **A test file's header is dropped, not glued in:** gluing is what made the
  quilt (#63). `--strict` makes it a CI error; the text moves into
  `<folder>.md` or into `//`.
- **Order — the main file first:** alphabetical path order put a random
  detail first (`billing-vat` before `billing`). The other files follow by
  path, identical `describe`s merge: unit and e2e tests of one capability are
  one section.
- **Monorepo — the main file in a package subfolder too (elves#301).** A
  decision's tests sit in packages (`export/api/`, `export/web/`): each package
  has its own runner — aliases, environment, plugins — while the decision and
  the page are one. Only a file directly in the folder counted as main, and
  such a folder "had no" main file. Now the main file is `<name>.*` at the
  folder root or in a package subfolder, one level deep; order — the root, then
  packages by name: the decision's cross-cutting statement opens the page.
  Rejected: a main file at the root run by a shared runner without the
  package's aliases and environment — for tests of package code it is a dummy
  just to pass the check.
- **Tests are collapsed into `<details>`:** the story reads through headings
  and prose, the proof opens on click. Failing and skipped tests aren't
  hidden — a counter in the block's line, the block expanded. Rejected: an open
  list — with a hundred tests the evidence hides the story; a counter alone
  without the lines — test names are the requirements, they must be in the
  documentation and in its diff in the PR. GitHub renders markdown inside
  `<details>` if there is a blank line after `<summary>` and before
  `</details>`.

## Prose from JSDoc

- A test name is a requirement, but the folder name (`est`) and a `describe`
  ("Calibration of k") don't say what it is and why. Prose is needed, and it
  lives next to the test: a separate hand-written document about behavior
  drifts from the tests, and the "Specification — decisions" rule (`canon.md`)
  doesn't allow such a document.
- JSDoc, not `//`: the split is already established in TypeScript — `/** */`
  describes for the consumer (editor hints, generated docs), `//` is a note for
  the code reader. Reasons for decisions and rejected alternatives stay in `//`
  and don't leak into the documentation.
- Runner reports carry no comments, so `spec-doc` reads the sources with the
  same scanner as `spec-diff` and links prose to a test by the chain of names.
  A separate description file in the capability folder (a README next to the
  tests) was rejected: a second source of the same meaning that nobody checks
  against the tests.
- `spec-diff` doesn't compare prose: the requirement is the test name; a prose
  edit shows in the diff of the test's JSDoc.
- A test's prose is a quote inside the list item: a paragraph after a blank
  line would make the list "loose" (spacing between all items), and a line
  without markup would merge with the name into one paragraph.
- There is no "section · path · N tests" line under the heading: the section
  and path follow from the convention, the test count and problems are in the
  collapsed block's line; the index keeps only skipped and failing — what needs
  looking at.

## Running — Bun

- `bun script.ts`: TypeScript without a build and without a `package.json`
  next to it — the skill lives in `~/.claude/skills` or `~/.agents/skills`,
  where nothing can be built. There are no dependencies: a TypeScript parser
  is kept as a file in the skill — `scripts/vendor/` (the "spec-diff: static
  parsing, not two reports" section above).
- Bun is the scripts' only runtime, a Node project included: its
  `package.json` calls them via `bun`, its CI adds the `oven-sh/setup-bun@v2`
  step. Rejected (#405): the scripts also under Node, so that a Node project's
  CI calls them without Bun — two runtimes for every script, only their common
  subset of APIs and a byte-for-byte comparison of the output in the tests,
  while the flow needs Bun anyway (the installer, the other skills' scripts).
- The modules a project's tests and config import — `harness.ts`,
  `architecture.ts`, `eslint-config.ts` and `speclib.ts` behind them — load
  under the project's own runner on Node (Vitest, Jest, Playwright, ESLint), not
  under Bun: only `node:` APIs, erasable syntax (no `enum`, `namespace` or
  parameter properties, imports with `.ts`), no `import.meta` and no top-level
  `await` — Playwright and Jest in a project without `"type": "module"` load
  them as CommonJS. The guard is `tests/standards/harness-load`: a real
  Playwright in a temporary project, CommonJS and ESM.
- The skill's tests — `bun test` (imports from `bun:test`; it also understands
  imports from `vitest`): runner overhead of 0.01 s versus 0.3 s for Vitest per
  file. Scripts in the tests are run via `bun` — what the user runs. Node in
  the CI of Elves is the runner image's own: `harness-load` runs Playwright on it.

## Wiring into the project's CI

- **The scripts' source is the skill's copy in the project.** The agent
  before a PR and CI need one version: the `docs/spec` format changes (as it
  did in #32), and documentation built by the skill from a fresh Elves
  wouldn't match CI on another version. Installing the flow
  (`bunx github:miroshnik/elves install`) puts the skill into
  `.agents/skills/spec`, and it is committed with the project: the project's
  `spec:doc` / `spec:diff` call these files for the agent, in CI and in a
  cloud session; an update is an ordinary PR. The same mechanism installs the
  rules and the other skills — there is no separate path for CI.
- Rejected:
  - an Elves submodule: an extra step in every clone and worktree
    (`git submodule update --init`), and its tests and code arrive in the
    project, where the project's Vitest and ESLint pick them up;
  - an Elves checkout in the workflow (`repository` + `ref: <SHA>`) pins only
    CI: the agent locally calls the skill of another version;
  - a package (`github:miroshnik/elves#<SHA>` in devDependencies): the
    project's runner imports the harness from it, and Node doesn't strip types
    in `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — a build
    would be needed.
- The copy sits under the project's `package.json`, which may lack
  `"type": "module"` (Node loads an ESM `.ts` file with a warning) or have
  `"type": "commonjs"` (doesn't load it at all). So the skill has its own
  `scripts/package.json` with `"type": "module"`: Node's own loader (the
  project's `eslint.config.*`, `node --test`) takes `eslint-config.ts` and the
  harness as ESM whatever the project's `type`.
- **The runner merges shards.** `spec-doc` merges several reports but takes
  the order of tests in a file by first appearance. Playwright with
  `fullyParallel` splits a file between shards, and the line order would
  depend on the order of reports on the command line (`shard-10` before
  `shard-2` in a glob) — the published `docs/spec` would change without a test
  edit. Blob reports → `merge-reports` → one JSON in declaration order; Vitest
  shards by file, but the recipe is the same — one for both runners. The result
  is verified: 3 Vitest shards and 3 Playwright shards with two projects give
  `docs/spec` byte for byte the same as a run without shards.
- **`spec` after the tests, `spec-diff` separately.** Building and publishing
  `docs/spec` from a red run is pointless (❌ in the documentation), hence
  `needs`. `spec-diff` reads only git — a separate job without installing
  dependencies posts its section to the summary even when tests failed.

## Publishing — the `spec` branch, not `main`

- **`docs/spec` is a derived copy of the tests.** In `main`, every branch
  regenerated the same pages and the table of contents: parallel PRs
  conflicted on every rebase, CI guarded "not behind", the agent regenerated
  and committed before every PR. The delta for review is already given by
  `spec-diff` in the PR body, a prose edit — by the diff of the test's JSDoc.
- **The `spec` branch, written only by CI after the merge.** It is readable
  on GitHub and by the agent (`git show origin/spec:README.md`), there are no
  conflicts, every publication has `Source: <SHA main>`. The "reached the
  reader" check isn't "the push went through", but the branch tree on the
  remote equals the built directory.
- **A merge that didn't change `docs/spec` is a commit too:** the same tree,
  a new `Source:`. The branch names the last checked `main`, and a `Source:`
  older than the diff base in `spec-diff` means a skipped publication. Without
  a commit, the gap line would come after every such merge and would stop
  being read; the price is a commit in the `spec` branch per merge. A repeat
  from the same source makes no commit.
- Rejected: GitHub Pages — not on every plan for a private repository; a CI
  artifact — lives for days and the agent can't read it from git; a bot commit
  to `main` — the same conflicts with open PRs and extra commits in history.
- The write token is only in the publishing job: it doesn't install the
  project's dependencies and doesn't run on PR runs.
- **No CI on `main` — the artifact of the PR run that checked the merge
  tree.** A project whose whole CI runs on PRs publishes, on PR merge, what
  was built by the run whose tree (merge-ref) equals the merge commit's tree:
  nothing was merged into `main` between the run's start and the merge — this
  `main` is checked in full. A PR that fell behind is merged — the trees
  differ, the publication is skipped: `spec` lags until the next merge with a
  matching tree but doesn't roll back, and `spec-diff` names the gap under
  "Base". `Source:` is the merge SHA: with squash and rebase the head
  doesn't land in `main`'s history, and `spec-diff` looks for the publication
  among merge-base's ancestors. Rejected: tests on merge — that is CI on
  `main`; publishing from every PR run — unmerged work would land in `spec`;
  publishing from the run of the behind PR's head — `spec` would lose the
  pages of a PR merged earlier.

## Identity and renames

- A test key is the folder path + the `describe` chain + the name. The file
  isn't part of the key: the rule treats the folder as the spec's unit, and
  moving tests between files of one capability doesn't change requirements.
- A rename is searched for in two steps: (1) the same file and `describe`, a
  similar name, similarity ≥ 0.6 by Ratcliff/Obershelp (like
  `difflib.SequenceMatcher.ratio`), greedily by descending similarity; (2) the
  same folder and the same name, a different `describe` — the `describe` was
  renamed or the test was moved to another section, including from another
  file. The threshold is deliberately high: hiding a removed requirement as a
  rename is worse than showing a rename as a deletion and an addition. Step 2
  isn't limited to one file since #63: the requirement text is the same, and
  regrouping into the main file's capability sections (unit and e2e of one
  capability under one `describe`, files renamed to `<name>.test.ts`) would
  otherwise give hundreds of "deleted".
- Merge-base by default — so the diff matches what the PR shows on GitHub, and
  tests added to `main` in parallel don't look deleted.

## Determinism

- No timestamps, durations or absolute paths in the output; order — folders
  by name, files by path, tests in declaration order (the report gives them in
  that order within a file; Vitest in concurrent mode doesn't — then the order
  is taken from the report as is).
- Identical tests from several reports (two Playwright projects, two runs) are
  merged; the status is the worst (`failed` > `passed` > `todo` > `skipped`,
  "all skipped" — skipped).
- A marker on the file's first line is the only sign of "this is my file": the
  script deletes only such files and doesn't touch hand-written ones in the
  same directories.

## What is not done

- No per-repository configuration: the `tests/` tree from the rule, the output
  directory `docs/spec`, report formats — all default; they can be changed
  only with flags (`--root`, `--out`, `--base`).
- No judging of tests: failing/skipped is what the runner said, the script only
  shows it.
- No generation of reference documentation (schema, routes, environment) —
  those are other generators, from code, not from tests.
