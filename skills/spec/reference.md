# spec — why it is so

A reference for `SKILL.md`: the reasoning behind decisions and parsing details.

## Report formats

- Vitest and Jest JSON are one format (`testResults[].assertionResults[]`);
  Playwright JSON has its own tree `suites → specs → tests` with projects and
  annotations (the `skip` reason exists only there). The format is detected by
  the file's content, not its extension; several reports are merged by test
  key.
- `bun test` has no JSON report but produces JUnit XML (`--reporter=junit`):
  a file is a `testsuite` with `name = file`, a describe is a nested
  `testsuite` with a `file` attribute, a test is a `testcase`; `<skipped/>` —
  skipped, `<skipped message="TODO"/>` — todo. The XML is parsed with regular
  expressions and a suite stack: Bun and Node have no XML parser without
  dependencies, and the format is simple. The entities `&amp;`, `&lt;`, `&#…;`
  are expanded.
- pytest and Python are deliberately not supported: the stack is TypeScript
  and Bun (issue #27, question 1).

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
  files) and the "Harness checks" section of `spec-diff` —
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
  standard's folder has a name anyway — now there is one (ai-dev#72). The
  place is known in advance: a code reader and an agent find the story without
  searching, and the page has a definite beginning — the `describe` order of
  the main file. Rejected: "any single file, `--strict` catches a second one" —
  the story's beginning would depend on where it was written.
- **The decision's description is `<folder>.md`, not a JSDoc header of the
  main file (ai-dev#91).** A README next to the tests used to be rejected as a
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
- **Monorepo — the main file in a package subfolder too (ai-dev#301).** A
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
  where nothing can be built.
- The scripts use only `node:` APIs (`fs`, `path`, `child_process`,
  `util.parseArgs`) — no `Bun.*`, so they also run under Node ≥ 22.18
  (erasable syntax: no `enum`, `namespace` or parameter properties, imports
  with `.ts`). A project's CI on Node calls them via `node` — Bun there would
  be a second runtime for two scripts. The guard is
  `tests/standards/node-runtime`: output under Node and under Bun matches byte
  for byte; ai-dev's CI installs Node 22.18.0 — the lower bound.
- The skill's tests — `bun test` (imports from `bun:test`; it also understands
  imports from `vitest`): runner overhead of 0.01 s versus 0.3 s for Vitest per
  file. Scripts in the tests are run via `bun` — what the user runs; the
  `node-runtime` guard also via `node`, which is why ai-dev's CI has Node.

## Wiring into the project's CI

- **The scripts' source is the skill's copy in the project.** The agent
  before a PR and CI need one version: the `docs/spec` format changes (as it
  did in #32), and documentation built by the skill from a fresh ai-dev
  wouldn't match CI on another version. Installing the flow
  (`npx github:miroshnik/ai-dev install`) puts the skill into
  `.agents/skills/spec`, and it is committed with the project: the project's
  `spec:doc` / `spec:diff` call these files for the agent, in CI and in a
  cloud session; an update is an ordinary PR. The same mechanism installs the
  rules and the other skills — there is no separate path for CI.
- Rejected:
  - an ai-dev submodule: an extra step in every clone and worktree
    (`git submodule update --init`), and ai-dev's tests and code arrive in the
    project, where the project's Vitest and ESLint pick them up;
  - an ai-dev checkout in the workflow (`repository` + `ref: <SHA>`) pins only
    CI: the agent locally calls the skill of another version;
  - a package (`github:miroshnik/ai-dev#<SHA>` in devDependencies): Node
    doesn't strip types in `node_modules`
    (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — a build would be needed.
- The copy sits under the project's `package.json`, which may lack
  `"type": "module"` (Node loads an ESM `.ts` file with a warning) or have
  `"type": "commonjs"` (doesn't load it at all). So the scripts have their own
  `scripts/package.json` with `"type": "module"`; the guard is the same
  `tests/standards/node-runtime`.
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
