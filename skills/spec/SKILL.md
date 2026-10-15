---
name: spec
description: Specification from tests — the spec canon (canon.md), deterministic scripts and a checks harness. spec-doc builds docs/spec from runner reports (Vitest/Jest, Playwright, bun JUnit) along tests/capabilities, tests/architecture and tests/standards, with prose from JSDoc; spec-diff prints removed, changed and added test names for the PR body; spec-publish publishes docs/spec to the spec branch after a merge, spec-run finds the green run for it; spec-shard splits CI shards by the last green run's durations; spec-claims checks entry points against the call log; spec-break proves a check can fail; spec-exceptions moves exceptions.ts into exceptions/; harness.ts — mechanical checks (registry + invariant). When — before creating a PR; in CI on a PR and after a merge; reading a project's spec; wiring spec into a project's CI; a convention must hold for every item, not an example; proving a test catches a breakage; asked what the system does or which requirements a PR removes — even if "specification" wasn't said.
allowed-tools: Bash(bun *skills/spec/scripts/spec-doc.ts *) Bash(bun *skills/spec/scripts/spec-diff.ts *) Bash(bun run spec:*) Bash(bun *skills/spec/scripts/spec-claims.ts *) Bash(bun *skills/spec/scripts/spec-break.ts *) Bash(bun *skills/spec/scripts/spec-exceptions.ts *) Bash(pnpm spec:*) Bash(bunx vitest run *) Bash(git status *) Bash(git diff *)
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
  `--artifact` — the last green run's reports for `spec-shard`;
- `spec-shard.ts` — a CI shard's test files by the last green run's
  durations, not by the count of tests: greedily, the longest into the
  lightest shard; the runner gets them as filters instead of `--shard`
  (`ci.md`, "Shards by durations");
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

Running: `bun --no-env-file <skill dir>/scripts/spec-doc.ts …` — TypeScript
without a build and without dependencies. Syntax, flags and exit codes — each
script's `--help`; what a script does in detail and why — `reference.md` next
to this file. The skill directory is the one holding this file
(`${CLAUDE_SKILL_DIR}` in Claude Code, `~/.claude/skills/spec`,
`~/.agents/skills/spec`, the project's `.agents/skills/spec` or an Elves
clone). The repository root is `git toplevel` (or `--root DIR`); the tree is
`tests/` at the root. In a repository wired up per the "Wiring into a
repository" section — its `spec:doc` and `spec:diff`, not the scripts from the
skill directory: that is the version pinned for CI.

## What to run when

| Moment | Action |
|---|---|
| Before a PR | 1. a test run with a JSON report (don't run e2e: for the names `playwright test --list --reporter=json > .spec-playwright.json` is enough); 2. `spec-doc --strict` with both reports — the tree and the main files are in order (`docs/spec` is in `.gitignore`, not committed); 3. `spec-diff --scenarios <task body>` → the `## Spec (tests)` section (in the project language) with the scenario check, into the PR body |
| In CI on a PR | shards — `spec-shard` (`ci.md`); run → `spec-doc --strict` (section "spec-doc"); `spec-diff` into the summary |
| In CI after a merge | a run on `main` → `spec-doc` → `spec-publish`; without CI on `main` — `docs/spec` from the PR run's artifact and `spec-publish --source <merge SHA>` (`ci.md`). The `spec` branch = the built `docs/spec`, the script verifies it after the push |
| Read a project's spec | `git fetch origin spec && git show origin/spec:README.md` (pages — `capabilities/<name>.md`…) or the tests themselves |
| Asked for documentation, "what does the system do" | `spec-doc <report> --stdout` — one document, files aren't touched |
| Asked which requirements a PR removed | `spec-diff` — the «Removed» list comes first |
| A project moves to a test spec | section "Wiring into a repository": installing the flow, scripts under Bun, workflow; migrating the old spec's requirements — `migration.md` (outcomes, removal categories, "the spec fell behind the code") |
| A convention for all items (mutations, routes, files) | `invariant` in `tests/standards/<name>/<name>.test.ts` — section "Checks" |
| Prove that a check can fail (migrating an old spec, a "covered" review) | `spec-break` — a breakage aimed at the check, one per run |
| After running all tests and shards | `spec-claims` — every entry point is called by a capability test; its report goes to `spec-doc` together with the runner reports |
| The harness failed «exceptions are one file per element in exceptions/, not exceptions.ts» | `spec-exceptions` — section "spec-exceptions" |
| spec-doc warns that `names.exceptions` «isn't read — names aren't exceptions any more, delete it» | delete that directory or file (#447) |

## Reports for spec-doc

The format is detected from the content; several reports can be passed at
once (Vitest + Playwright + bun test), identical tests are merged.

| Runner | Command |
|---|---|
| Vitest (and Jest — same format) | `vitest run --reporter=default --reporter=json --outputFile.json=.spec-report.json` |
| `bun test` | `bun test --reporter=junit --reporter-outfile=.spec-report.xml` — JUnit with nested `testsuite` per describe |
| Playwright | `PLAYWRIGHT_JSON_OUTPUT_NAME=.spec-playwright.json playwright test --reporter=json` |
| Playwright without a run (before a PR) | `playwright test --list --reporter=json > .spec-playwright.json` — the tree and names without browsers, tests show as skipped: for `spec-doc --strict` and `spec-diff`, not for publishing |

Reports are temporary files, in `.gitignore`; a report from CI with someone
else's absolute paths works. The runner itself merges shards (blob reports →
one JSON, section "Wiring into a repository"); don't pass shard reports
separately (`reference.md`, "Report formats").

## spec-doc

A page per decision folder is a story in three layers: the `<folder>.md`
description (**why**), `describe` sections with prose from their JSDoc
(**what it can do**), the section's tests in a collapsed block (**what checks
it**); plus the `README.md` index and `architecture.md` from the model
`tests/architecture/model.ts`. `--strict` — exit code 1 when:

- a test is outside `tests/capabilities/<name>`, `tests/architecture/<name>`
  and `tests/standards/<name>` (in `src/`, in `tests/unit/`, a file directly in
  `tests/capabilities/`) — «Outside the tree», a signal to move it;
- a folder has no main file `tests/<kind>/<name>/<name>.*` (in a monorepo also
  `tests/<kind>/<name>/<package>/<name>.*`): its `describe` order is the order
  of the story;
- a folder has no description `tests/<kind>/<name>/<name>.md`;
- a test file has a JSDoc header (its text belongs in `<folder>.md` or in
  `//`), or a standard's main file is still `rule.*` (rename it to `<name>.*`);
- a `<!-- spec: c4-context -->` marker (`c4-container`, `c4-component`,
  `c4-modules`) is unknown or has no model; the model doesn't load — exit
  code 2.

Names of `describe` and `it` are statements in the project language
(`language` in `.agents/ai-dev.json`): an identifier, a function or file name,
a path — a warning line, no exit code.

**Prose:** `<folder>.md` — why, the reason and the rejected alternatives (its
first paragraph is the index description); JSDoc `/** … */` before `describe`
or `it` — one to three sentences where the name isn't enough; `//` doesn't go
into the documentation. Each file, the order, names, an example —
`reference.md`, "spec-doc output" and `reference.md`, "Writing prose".

## spec-diff

The ready `## Spec (tests)` section for the PR body: test names compared
**statically** — the `tests/` files at two revisions via `git show`, without a
run. The removed come first: a removed test is a removed requirement. Then
«Changed» (renames), «Added» and, only if they changed, «Architecture model»,
«Exceptions», «Harness checks».

- The base is the merge-base of `--base` (default `origin/main`) and HEAD;
  before running — `git fetch origin`, otherwise `origin/main` is stale.
  `--worktree` — the working tree instead of HEAD, to look before a commit.
- `--scenarios` — the task body (`gh issue view N --json body --jq .body | …
  --scenarios -`): its `## Scenarios` section against the added and changed
  tests — «### Task scenarios»; a scenario that became a test is named the
  same as the test, ❌ — a scenario without a test.
- Tests that the harness generates are only in the report: `--report <report>`
  (repeatable) — the head from the PR run's report, the base from `tests.json`
  of the `spec` branch.
- More tests than `--limit` (100) — a per-folder summary; `--full` — the full
  list.
- The section is inserted into the PR body as a whole (after `Closes #N`); on
  new commits with tests — regenerate it and replace it.

Matching, renames, a move into the tree, an example — `reference.md`,
"spec-diff output".

## spec-publish, spec-run — after a merge

In CI (`ci.md`). `spec-publish` puts the built `docs/spec` at the root of the
`spec` branch, `Source: <SHA>` in the commit, without touching the working
copy, and verifies the remote branch after the push; `--check` — comparison
only. `spec-run --tree <hash>` — without CI on `main`: the green run that
checked the merge commit's tree; stdout empty — publishing is skipped. Details
— `reference.md`, "spec-publish" and `reference.md`, "spec-run".

## spec-break

A decision's check must be able to fail. The agent picks the breakage for one
check (this is not mutation testing): `--find` occurs in the file exactly
once; a plan of several — each a separate run. A baseline run goes first: red
even without a breakage — exit code 2. After an interruption without a revert
— the next run or `--restore`. Details — `reference.md`, "spec-break".

## spec-exceptions

A decision's exceptions are the folder's `exceptions/` directory, one file per
exception (`<item>.json`: `{ item, rule?, issue, reason }`), not an array in
`exceptions.ts`. `spec-exceptions` moves each `exceptions.ts` of a decision
folder there and rewrites the imports (`exceptionsIn()`) and the paths in
`package.json` and workflows; a `!` line — fix by hand. A repeated run changes
nothing. Details — `reference.md`, "spec-exceptions".

## Checks — `harness.ts`, `architecture.ts`, `spec-claims.ts`

A mechanical check is runner tests (or a report in the runner's format): they
are in the report, and so in `docs/spec` and in `spec-diff`. Import — from the
skill's copy in the project (`.agents/skills/spec/scripts/…`), the runner
doesn't matter — `it` passes the test in. Which check for what and how to wire
each one — `checks.md` next to this file:

- a convention on every item of a registry from the code — `invariant`
  (`standards/<name>/`);
- a lint rule — `examples`, `eslintLinter`, the folder's `eslint.ts` fragment
  collected by `collectEslint`;
- out of scope and exceptions — `fileOf`, marks `spec-outside(<decision>)` /
  `spec-exception(<decision>) #N`, `exceptionsIn()`, `lintExceptions`;
- the architecture model (modules, external systems, containers, workspace
  packages) — `architecture/model.ts`, `architecture`, `boundariesConfig`,
  `networkGuard`, `cspConnectSrc`, `deployUnits`, `workspacePackages`;
- interaction order in a scenario — `trace`, `sequence`;
- every entry point is called by a capability test — `journal` +
  `spec-claims` (`standards/entry-points/`);
- no code without a consumer — `deadCode` (knip);
- environment variables — `envVars`, `dotenvNames`, `configGet`.

## Wiring into a repository

The scripts are taken from the skill's copy in the project itself
(`.agents/skills/spec`, committed) and run under Bun, a Node project included
(in CI — `oven-sh/setup-bun@v2`); the modules the project's tests and config
import (`harness.ts`, `architecture.ts`, `eslint-config.ts`) load under the
project's own runner on Node. Each step with its details — `reference.md`,
"Wiring into a repository"; an old spec's requirements — `migration.md`.

1. **Install** at the project root, the result into a commit:
   `bunx github:miroshnik/elves install`; exclude `.agents/` and `.claude/`
   from the project's linters and formatters; update — the same command in a
   separate PR.
2. **Scripts** in `package.json` — via `bun`, reports — those the project has:
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
   In `.gitignore`: `docs/spec/`, `.spec-*.json`, `.spec-*.xml`,
   `.spec-meta/`, `.spec-journal/`, `vitest-blob/`, `blob-report/`,
   `playwright-blob/`.
3. **`docs/spec/` isn't committed to `main`** — CI publishes it to the `spec`
   branch.
4. **CI** — a shard's files from `spec-shard` by the last green run's
   durations, shards write blob reports, a `spec` job merges them and builds
   `docs/spec` with `--strict`, only `spec-publish` has a write token,
   `spec-diff` is a light job of its own: the workflow fragment — `ci.md`.
5. **Monorepo** — a decision's tests in package subfolders
   `tests/<kind>/<name>/<package>/`, each package with its own runner project;
   run from the repository root.

## Limitations to know about

A test's name is a string known without a run (a literal, a template without
substitutions): otherwise it isn't in the `spec-diff` lists — a line in
stderr. Vitest and `bun test` reports don't contain the skip reason — keep it
in the test name or in a comment next to it. On `main` everything must be ✅
or ⏭️ with a reason. The rest — `reference.md`, "Limitations to know about".
