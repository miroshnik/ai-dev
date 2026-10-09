# Specification — decisions

The spec canon, moved out of the `AGENTS.md` core: it applies as a rule to any
project; the core keeps a paragraph of it and a link here. Read it when you
write or migrate a test, add a check, an exception or a standard; how to wire
each mechanism — `checks.md` next to this file, the tools — `SKILL.md`.

A project's spec is **decisions with a mechanical check**, functional and
non-functional: what the system does, what it's made of, which rules the code
obeys and which qualities it holds. A check is how the system should work,
code is how it does work: whatever the code is, that's how the system works,
so code can't be the source of what should be. The source of what should be is
a decision and its trace (an issue, a commit with a reason); code only shows
which decision was made, and a test "from code" is written only when the trace
exists. There are no separate specifications: a decision exists only while a
mechanism checks it — a test, a lint rule, a check over the architecture
model. **No check — no decision; no decision — no code:** behavior without a
check may be changed without agreement, but removing what people use — only
by a decision in an issue; a standard without a check doesn't apply; code that
no decision claims is dead and is deleted.

- **A decision is the unit of the spec, a folder is its home.** One anatomy
  for all kinds:
  - `<folder>.md` — why and for whom, the reason and rejected alternatives;
    the first paragraph is the description in the table of contents; a
    `<!-- spec: … -->` marker puts a generated diagram (C4, sequence) into the
    story. Test files have no JSDoc headers;
  - the main file `<folder>.test.ts` — the statements: the page's sections
    follow the order of its `describe`s, the main one first; `<folder>.e2e.ts`
    next to it comes right after it (the units open the page), then the other
    `*.test.ts`, `*.e2e.ts`;
  - the mechanism — in the same folder: an `eslint.ts` fragment, an ast-grep
    `rule.yml`. The project's tool configs (`eslint.config.*`, `sgconfig.yml`)
    only collect them from the tree (the harness's `collectEslint`) — a rule
    has one home;
  - `exceptions/` — exceptions for elements without a file of their own, one
    file per element (below).
- **Monorepo — a package subfolder inside the decision folder:**
  `tests/<kind>/<name>/<package>/`. A package has its own runner (aliases,
  environment, plugins) — it takes `tests/*/*/<package>/`; a test right in the
  decision folder, without a subfolder, is repository-wide (the root runner).
  One decision — one page: the main file is `<folder>.test.ts` at the folder
  root or in the package subfolder (`<package>/<folder>.test.ts`); the story
  starts with the root's main file, then the packages' main files by package
  name, then the other files. `<folder>.md` and `exceptions/` — one per
  folder, at its root. Runners are launched from the repository root (Vitest
  or Jest `projects`, `-c` with the package's config): the harness counts
  element paths from cwd; it reads `exceptions/` relative to the test file,
  and the exception path in the hint is from the repository root, even with
  the runner in the package directory.
- **Three roots of `tests/` — by the reader's question;** the tool kind isn't
  encoded in the structure:
  ```
  tests/
    capabilities/<name>/   what the system does: behavior — unit, integration, e2e
    architecture/          what it's made of: model.ts — C1 external systems (adapters,
                           hosts, environment keys, headers), C2 containers (links,
                           deploy configs), C3 modules and libraries (directory,
                           purpose, API, what it depends on, packages); <name>/ —
                           checks over the model
    standards/<name>/      which rules all code obeys: form conventions,
                           cross-cutting invariants and qualities
    lib/                   factories, database, helpers — not the spec, not in the docs
  ```
  Flat, no subsystems; the folder name is the decision's identifier in
  English. **One fact — one home:** a general rule ("every mutation writes an
  audit record") goes in `standards/`, the behavior of the audit log itself —
  in its own capability; the other capabilities say nothing about it.
- **Decisions are functional and non-functional — both have a check.** A
  functional one (what the system does) is a capability. A non-functional one
  is architectural (the `architecture` model: what the system is made of) or a
  standard (`standards/`: which rules the code obeys). A quality —
  performance, security, accessibility, reliability — is the same kind of
  decision with a check, not a wish in prose: a cross-cutting one ("every
  mutation writes an audit record", "every route checks permissions", "every
  page passes axe") is a standard, "registry + invariant"; the budget of a
  single capability ("search responds in under 300 ms") — in its capability,
  next to the behavior. A quality without a check isn't a decision.
- **The mechanism — by what we pin down** (how to wire it — `checks.md` next
  to this file); each is wrapped in a runner test, so `spec-doc` and
  `spec-diff` see everything the same way:
  - behavior — a test: an algorithm — a unit test, a subsystem — an
    integration test, interaction of subsystems — e2e; the level isn't encoded
    in the name, the `.e2e.ts` suffix is only for the runner;
  - a form convention ("no `console` in the domain") — a lint rule with
    examples (the harness's `examples`): "not allowed" gives a rule error,
    "allowed" and a file outside scope — don't;
  - a behavioral convention — "registry + invariant" (`invariant`): a registry
    from the code (router, schema, files), a test per element, a "registry
    isn't empty" test and a violator on which the check fails;
  - **a registry that parallel PRs edit element by element — one file per
    element** (exceptions — `exceptions/`): deleting and adding your own file
    overlaps with nothing, while in a shared array neighboring lines conflict,
    and every next PR goes for a CI rerun; sorting doesn't save it, and
    `merge=union` brings both back when neighboring lines are deleted. **A
    record about an element with its own file — a mark in that file** (outside
    scope and exception): the element is deleted — the record goes too,
    whereas a record in a test or in `exceptions/` outlived the element, and a
    parallel PR added a record about what no longer existed;
  - boundaries and dependencies — the architecture model: `boundariesConfig`
    (ESLint, the error shows in the editor) and `architecture` (a directory is
    in a module, a package is allowed for a module and used, an external
    system only through an adapter, a module in one container, a library in
    the containers of the modules that depend on it); the whole graph (cycles,
    orphans) — dependency-cruiser, only when it's needed;
  - the order of interaction, when it is itself a decision ("reserve first,
    then charge"), — `sequence` with `order` over a `trace` at the model's
    boundaries.
- **A check can fail and doesn't flake** (the "Tests and code" section in
  `AGENTS.md`): a test is written before the code and is red first, a lint
  rule proves "not allowed" with an example, an invariant — with a violator,
  an exception — with a ratchet. `.only`, `skip` without a reason and an issue
  number, retries, mocks of your own modules (only external edges may be
  substituted) — a lint error.
- **Claimedness — code holds on to decisions at attachment points,** not line
  by line:
  - every entry point (route, page, job, command) is called by at least one
    capability test — by the call log (`journal` and `spec-claims`), not by
    coverage: coverage says "executed", not "claimed";
  - every code directory is in a model module, every package is allowed for a
    module and imported;
  - every file and export is reachable from an entry point (`deadCode`, knip);
  - every environment variable is declared and read (`envVars`).

  Existing unclaimed code — exceptions with an issue, not deletion.
- **A test is for a decision, not for every line,** inside an entry point too.
  A test is needed when all three hold: it's a decision (it could have been
  otherwise), a breakage would go unnoticed (types don't catch it, eyes don't
  see it), a mistake is costly (shared code, data, money, external systems). I
  don't test compiler and library guarantees, styles and layout, label texts —
  except a regression after a real bug. A thin spec page is no reason to test
  trifles: a test of a trifle fails on any edit, it gets fixed mechanically,
  and it stops being spec.
- **Exceptions — with a ratchet:** for an element with its own file — a mark
  in it (`// spec-exception(<decision>) #N: reason`, outside scope —
  `spec-outside`), otherwise in the decision folder's `exceptions/` directory,
  one file per exception (`<element>.json`: the element, `#issue` and the
  reason); an exception that no longer violates fails the check («убери
  отметку в <file>» — remove the mark, «убери исключение: удали <file>» —
  remove the exception: delete the file). The old `exceptions.ts` is migrated
  by `spec-exceptions`; the harness fails on it with a hint. Disabling lint in
  code — only with a rule and `-- #N reason` (`lintExceptions`); a blanket
  `eslint-disable` is forbidden, an unnecessary disable is a `lint` error.
  Exceptions are visible on the decision's page — it's debt, not a secret. A
  task to sort out a violator is a Task, not a Bug: a bug is wrong behavior
  for the user, while a violation of a standard in force is debt. A new check
  on existing code enters green right away: current violations — as
  exceptions with a task to sort them out, not a disabled check or a postponed
  rollout.
- **What can't be checked isn't called spec.** Where the look or UX is a
  decision, the check is targeted: a screenshot test, a job test;
  accessibility and budgets — like any quality (above); the rest (look, texts,
  impression) — a product document or acceptance in the issue.
- **Names are statements in the project language** (`language` in
  `.agents/ai-dev.json`). `describe` — a capability in the user's terms ("only
  someone with access to the entity itself sees its history"), `it` — a
  concrete example; not a function, component or file name (`spec-doc
  --strict` names such ones; so far it recognizes a statement by Cyrillic
  letters — English is #366). Tests of one capability from units and e2e —
  under the same `describe`. JSDoc before a `describe` or `it` — what the name
  doesn't show, one to three sentences for the spec reader; file names, issue
  numbers, how the test is set up — in `//`, that's for the code reader.
  Rewrite an unclear name rather than explain it.
- **Intent comes in through an issue:** we discuss the implementation and make
  decisions in the task (the questions section, comments). A code task gets at
  creation its decision labels (the "Task tracking" section in `AGENTS.md`)
  and the scenarios section: future `it` names (or "describe › it") as a list:
  from them the user sees the requirements before the code and can stop it.
  For a "registry + invariant" standard the harness generates the tests per
  element — the scenario is the name of the `describe` in which `invariant`
  (or `examples`) is called. The agent first writes the checks and runs them
  locally — the new ones are red (the check can fail, the behavior doesn't
  exist yet); then the code — green. Push and PR — only when green: a red CI
  run proves nothing, it's noise. The PR's spec section — `spec-diff
  --scenarios`, matching scenarios against tests.
- **The diff of checks in a PR is the diff of the spec,** the diff of code is
  the implementation. The PR body is `spec-diff` output: added, changed and
  removed test names, changes to the architecture model, exceptions and
  registries. A removed test is a withdrawn requirement; that must be visible.
- **Documentation is generated,** not written by hand: `spec-doc` builds a
  page per decision (why — `<folder>.md`, what holds — `describe`, what checks
  it — the tests, collapsed under the section; for a standard — the examples'
  code and the exceptions), the architecture page from the model (C4 diagrams
  and the module table) and sequence diagrams from scenario traces.
  `docs/spec` isn't in `main`: after a merge CI publishes it to the `spec`
  branch (`spec-publish`); review goes by `spec-diff`. Product documents
  (vision, business decisions, research) aren't spec and live separately.
- **A recurring decision is a standard:** on task close (check 5 in the
  canon's "Epic refresh on task close" section) a repetition found becomes a
  "Standard · …" issue; the result is a rule in `tests/standards/` and a
  refactoring.
- **Migrating an old spec** (OpenSpec, a technical specification) into
  decisions — the `migration.md` reference next to this file: an outcome for
  each requirement, check by breaking, removal categories, "the spec fell
  behind the code".
- **What's not here:** state markers and todos as a plan (the plan is in the
  issue), ADRs (the reason is in the decision's `<folder>.md`), capability
  registries, handwritten documentation of behavior and hand-drawn diagrams,
  Gherkin, mutation testing (noise from equivalent mutants, pressure towards
  tests of trifles), approval points other than the issue.
