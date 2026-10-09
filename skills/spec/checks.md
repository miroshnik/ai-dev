# spec skill checks — the harness, the architecture model, the entry-point log

Reference for the "Checks" section in `SKILL.md`: how to wire each mechanical check into the project's tests.


A mechanical check is runner tests: they are in the report, and so in
`docs/spec` and in `spec-diff`. The harness doesn't depend on the runner — you
pass it the runner's `it` (Vitest, Jest, bun test, `node:test`). Import it from
the skill's copy in the project: `.agents/skills/spec/scripts/harness.ts` (from
`tests/standards/<name>/` — `../../../.agents/skills/spec/scripts/harness.ts`).

- Importing with the `.ts` extension (the harness imports `speclib.ts` and
  `architecture.ts` the same way) needs `allowImportingTsExtensions` (together
  with `noEmit`) in *every* tsconfig that checks the importing file: the root
  one, `tsconfig.spec.json`, the e2e package's config; otherwise `tsc` gives
  TS5097. A build config with emit (`tsconfig.build.json` for `nest build`)
  doesn't accept the flag: tests are excluded from it, and when it extends the
  checking config, it turns off both the flag and `noEmit`.
- A project on `module: commonjs` under TypeScript 5.x without
  `esModuleInterop` can't import the harness: `import path from "node:path"` is
  TS1259, and with a runner that transpiles to CommonJS (ts-jest), `path` is
  `undefined`. Tests with the harness go under a tsconfig with
  `esModuleInterop` or `module: nodenext`; TypeScript 6+ always enables
  `esModuleInterop`.

**`invariant` — registry + invariant.** A behavior convention ("every mutation
writes an audit record", "every route checks a permission") is checked on every
element of a registry taken from the code, not on a single example:

```ts
import { describe, expect, it } from "vitest";
import { invariant } from "../../../.agents/skills/spec/scripts/harness.ts";

const mutations = await listMutations(); // from the code: router, schema, files — not a handwritten list

describe("every mutation writes an audit record", () => {
  invariant(it, {
    registry: "mutations",
    items: mutations,
    name: (m) => `${m.name} writes an audit record`,
    check: async (m) => expect(await auditRowsAfter(m)).toHaveLength(1),
    violator: { name: "mutation without an audit record", item: fakeMutationWithoutAudit },
  });
});
```

Tests: «реестр «mutations» не пуст» (the registry isn't empty) — a typo in a
path or a query gives an empty registry and a green check that checks nothing;
«нарушитель не проходит: …» (the violator doesn't pass) — the check must fail
on a known violator; one test per element, named with a statement; element
tests are ordered by name, not by registry order — the order of files and
queries depends on the machine, and `docs/spec` mustn't. No counters in names:
as the registry grows, `spec-diff` shows only the new elements. The registry is
computed before the tests are registered: an async one — with a top-level
`await` in the file.

On real code:

- *several conventions over one registry in a folder* — each has a `rule`
  ("audit", "cancel"): the service tests name it
  («реестр «forms» не пуст (audit)»), an exception in the folder's shared
  `exceptions/` carries the same `rule` (without `rule` — it applies to all of
  the folder's conventions; a `rule` the folder doesn't have is red, below);
- *outside scope* — `outside: [{ item, reason }]` (by `key`): the login form, a
  section that differs on purpose — its own test «вне охвата: <key>» (outside
  scope) with the reason on the page, not a filter in the test code; the element
  dropped out of the registry — «убери из охвата» (remove from scope); an element
  with its own file — a mark in it (below, "Mark on the element");
- *required elements* — `includes: ["invoice", …]`: the not-empty test won't
  notice that the query lost half the registry;
- *a check made of several halves* (client and server) — `violator` as a list:
  a violator for each half;
- *a registry over source files* — `sources(root, ["src"])`: the file list is
  cheap, the text is read in the element's check, not while collecting tests;
  the violator is `source("src/fake.ts", "…text…")`.

**`examples` — examples for a lint rule.** A rule is checked on code where it
must fire («нельзя», not allowed), stay silent («можно», allowed) and not apply
(«вне охвата», outside scope — a file the rule doesn't cover). The linter goes
through an adapter: `eslintLinter()` takes the project's ESLint and
`eslint.config.*`, and an example is checked the same way `lint` would check a
file at that path.

```ts
import { describe, it } from "vitest";
import { eslintLinter, examples } from "../../../.agents/skills/spec/scripts/harness.ts";

describe("the domain doesn't write to the console", () => {
  examples(it, {
    linter: eslintLinter(),
    rule: "no-console",
    bad: [{ name: "console.log in the domain", path: "src/domain/invoice.ts", code: "console.log(1);" }],
    good: [{ name: "logger in the domain", path: "src/domain/invoice.ts", code: "log.info(1);" }],
    outside: [{ name: "console.log in a build script", path: "scripts/build.ts", code: "console.log(1);" }],
  });
});
```

Tests — «нельзя: …», «можно: …», «вне охвата: …»; for «нельзя», `count` is how
many times the rule must fire (by default — at least once). A config with heavy
plugins takes seconds to load — `const linter = eslintLinter();
await linter.ready();` at the top level of the file: loading happens while
collecting tests, not under the first example's timeout. Another rule firing
counts neither for nor against; an example that doesn't parse is a failed test;
no «нельзя» — a failed test «у правила … есть пример «нельзя»» (the rule has a
not-allowed example). There is only one adapter so far — ESLint: ast-grep and
Biome will be added when a project needs them (the core doesn't depend on the
linter, `Linter` is an interface with one required method, `lint`).

**A rule lives in its standard's folder.** A flat config fragment is
`eslint.ts` next to the test (`export default [{ files: ["src/domain/**"],
rules: {…} }]`, paths from the project root); the project's `eslint.config.*`
only collects the tree's fragments — `lint` and the editor see the rule as
usual:

```js
import { collectEslint } from "./.agents/skills/spec/scripts/eslint-config.ts";
export default [...base, ...(await collectEslint(import.meta.dirname))];
```

ESLint caches the config in-process: the editor sees a new or deleted fragment
after the ESLint server restarts; `lint` in the CLI — right away.

Flat config doesn't merge rule options: two fragments with the same core rule
(`no-restricted-syntax`, `no-restricted-imports`) on the same files — the last
one wins, and the first one's restrictions silently disappear. A standard's
restriction is `restrict`: its own rule `spec/<id>` in the shared `spec`
plugin, so the restrictions of different standards on the same files all apply:

```ts
import { restrict } from "../../../.agents/skills/spec/scripts/eslint-config.ts";
export default restrict({ id: "no-alert", selectors: ["CallExpression[callee.name='alert']"], message: "alert — use notifications instead", files: ["src/**"] });
```

A fragment is `eslint.ts`, `eslint.mts` (ESM even in a project without
`"type": "module"`, without the `MODULE_TYPELESS_PACKAGE_JSON` warning),
`eslint.mjs` or `eslint.js`; `tests/lib` holds helpers, not fragments.

**Exceptions are explicit, have a task, and go away when no longer needed.**

- *Registry + invariant:* an element without its own file — the `exceptions/`
  directory in the decision folder (with its own file — a mark, below), one file
  per exception — `exceptions/importLegacy.json`:
  `{ "item": "importLegacy", "issue": 12, "reason": "…" }` (`rule` is
  optional); in the test, the harness's `const exceptions = exceptionsIn();`
  (the directory of the calling test's folder — from where its file is, not
  from the runner's cwd — or `exceptionsIn("<folder>")`), in `invariant` —
  `exceptions` and `key` (a stable element identifier: a name, a path). A file
  per element rather than an array: debt-paydown subtasks each delete their own
  file in parallel and don't conflict. The file name is the element in Latin
  letters (the check doesn't require it); the same element in two files, a
  non-JSON file or one without `item` is an error with the path. An excepted
  element gets «исключение: <key> (#N)» (exception) instead of the regular test:
  green while it violates the convention; once it complies — red
  «убери исключение: удали <file>» (remove the exception: delete <file>) (a
  ratchet: debt only goes down; the path is from the repository root, even when
  a package's runner runs from the package's directory). An exception without a
  task, without a reason, or for an element outside the registry is red. An
  exception with a `rule` that no invariant in the folder has (a typo, the rule
  was renamed or deleted) is picked up by no invariant — a red test
  «исключения с rule — к правилам инвариантов папки» (exceptions with a rule
  belong to the folder's invariant rules) with the file path; the rules of the
  folder's other files (subfolders sharing `exceptions/`) are looked up as a
  string in their code. The form of `rule` isn't checked: the file name is
  normalized. One directory per decision folder: `exceptions/` in a subfolder or
  a non-`.json` file in the directory — a red test
  «исключения — файлы <элемент>.json в exceptions/ папки решения» (exceptions
  are <element>.json files in the decision folder's exceptions/) with the paths
  (an exception from a subfolder isn't read). A leftover `exceptions.ts` in the
  decision folder or its subfolder — a red test
  «исключения — файлом на элемент в exceptions/, а не в exceptions.ts» (one file
  per element in exceptions/, not exceptions.ts) with a migration hint:
  `node .agents/skills/spec/scripts/spec-exceptions.ts` spreads each file into
  the decision folder's directory, changes the import in the folder's tests to
  `exceptionsIn()`, and the path in `package.json` and the CI workflow to the
  directory; whatever it didn't rewrite — as a `!` line, exit code 1.
- *Mark on the element* — outside scope and an exception for an element with its
  own file (a route, a script, a migration): in `invariant` — `fileOf: (item) =>
  path from the root`, the record is a comment in that file, like
  `eslint-disable` for lint:

  ```ts
  // spec-outside(audit): login — there is no user yet, nothing for the audit to record
  // spec-exception(audit) #12: legacy data import — audit in #12
  ```

  The element is deleted — the mark goes too; two PRs don't edit a shared file.
  A record in `outside` or `exceptions/` outlived the element: one PR deleted a
  route, another added it as outside scope — after both merges `main` is red
  (measurement #211, three of five breakages). `audit` is the decision folder's
  name: a file may be an element of registries in different folders, and the
  mark names its own; `audit/cancel` is the folder invariant with that `rule`,
  without it — all of the folder's invariants. A mark starts the comment text
  (`//`, `/*`, a block's `*`, `#`, `--`, `<!--`): in JS/TS — only in comments,
  not in strings; the format in the middle of prose isn't a mark (`marksIn`).
  JSON has no comments — there the mark is the value of the top-level key `"//"`
  (an npm convention), a string or a list of strings:
  `"//": "spec-outside(modules): shared ESLint config — a development
  tool"`; another key or a nested `"//"` isn't a mark, JSONC
  (`tsconfig.json`) takes a regular comment. The tests are the same:
  «вне охвата: <key>» with the reason on the page, «исключение: <key> (#N)» with
  the ratchet «убери отметку в <file>:<line>» (remove the mark in
  <file>:<line>); without a task or a reason — red with the mark's location; a
  `rule` that no folder invariant has — red
  «отметки с rule — к правилам инвариантов папки» (marks with a rule belong to
  the folder's invariant rules). `fileOf` returns `null` — the element has no
  file of its own (a schema line, a router entry): `outside` and `exceptions/`.
  A mark in a file of two elements — red «отметка — в файле одного элемента» (a
  mark belongs in one element's file; to which one is unknown); a mark plus a
  record in `outside` or `exceptions/` for the same element — red
  «у элемента одна запись» (one record per element). Existing registries aren't
  converted all at once — only new ones and the one you are editing.
- *Lint rule:* an exception is a disable in the code, right where the violation
  is: `// eslint-disable-next-line no-console -- #12 reason`. `collectEslint`
  turns on `reportUnusedDisableDirectives: "error"` — a disable that no longer
  silences anything is a `lint` error. The format is checked by the project's
  standard:

  ```ts
  import { it } from "vitest";
  import { lintExceptions } from "../../../.agents/skills/spec/scripts/harness.ts";

  lintExceptions(it, { root: process.cwd(), dirs: ["src"] });
  ```

  One test per file with disables («исключения в <file>: <rules> (#N)» —
  exceptions in the file; the disables' tasks are in the name, the spec shows
  them): each disable names its rule and has `-- #N reason`; a blanket
  `eslint-disable` without rules is forbidden — it silences both the rules and
  the check inside the linter, so the format is checked by a test, not by an
  ESLint rule. The file tests are the list of exceptions in the spec.

**Architecture model — `architecture.ts`.** One per project,
`tests/architecture/model.ts`: modules (path, purpose), which modules and
external packages each one depends on.

```ts
import type { Model } from "../../.agents/skills/spec/scripts/architecture.ts";

export default {
  name: "Invoices", // the system on the documentation diagrams
  roots: ["src"],
  aliases: { "@/": "src/" }, // an import by alias is local, not a package; in a monorepo — a list of paths
  modules: {
    domain: { path: "src/domain", purpose: "invoice rules, no I/O" },
    infra: { path: "src/infra", purpose: "database and services", dependsOn: ["domain"], packages: ["pg"] },
  },
} satisfies Model;
```

- *Module boundaries* — `tests/architecture/boundaries/eslint.ts`:
  `export default boundariesConfig(model, boundaries)` (the project's
  `eslint-plugin-boundaries` plugin; for TypeScript aliases — a resolver via
  `settings`). Importing a module not in `dependsOn` is a
  `boundaries/dependencies` error in `lint` and the editor; in
  `boundaries.test.ts` — `examples` for that rule.
- *Model against code* — `architecture(it, { root, model })` in
  `tests/architecture/modules/modules.test.ts`:
  «каталог <dir> — в модуле <module>» (the directory is in the module) for every
  code directory (outside modules — red; module paths nest — `src` and
  `src/lib`: a directory belongs to the module with the longest path, which comes
  first in the ESLint rules), «<module> импортирует <package>» (imports; a
  package not allowed for the module — red),
  «<module> использует разрешённый пакет <package>» (uses an allowed package;
  not imported — red: the model diverged from the code). In a monorepo —
  «пакет workspace <path> — в корнях кода» (the workspace package is in the code
  roots) for every package from `workspaces` (`package.json`) and
  `pnpm-workspace.yaml` that has code: `roots` are written by hand, and a new
  package outside them would escape the check entirely (a root inside a package
  — `apps/web/src` — covers the package). An alias specific to each app is a
  list of paths: `"@/": ["apps/web/src/", "apps/admin/src/"]`; the prefix
  decides whether an import is local. Exceptions from `exceptions/` go to the
  registry that has their element (a host — to the hosts registry, not the
  directories one); `rule` is the registry name when the element is in several.
  Intentionally outside the model — development tools (the shared ESLint config
  and tsconfig, a local HTTPS bridge, test helpers, the scripts directory) —
  `outside: [{ item, reason }]`, routed the same way: it's a decision, not debt,
  and an exception with a task would outlive the task's closing. On the page —
  «вне охвата: <element>» with the reason; the element is gone — red
  «убери из охвата». A workspace package is an element with its own file: the
  mark `"//": "spec-outside(<decision>): reason"` in its `package.json`
  (`<decision>` is the test's folder: `modules` for
  `tests/architecture/modules/`). Imports are parsed statically: relative ones,
  aliases, Node built-in modules and `import type` aren't packages. Packages are
  checked by parsing, not by the plugin: `eslint-plugin-boundaries` 7.2 doesn't
  catch external packages even with an explicit ban.
- *Documentation* — from the same model: `spec-doc` writes `architecture.md`
  (C4 diagrams of levels C1–C3 and a module table), the marker
  `<!-- spec: c4-component -->` in `<folder>.md` embeds the diagram into the
  story of a capability or a rule. There is no handwritten diagram — it has
  nothing to fall behind.

**Entry points — `journal` and `spec-claims`.** Every entry point (a route, a
page, a job, a command) is called by at least one capability test — by the call
log, not by coverage (coverage says "it executed", not "it was called by
claimed behavior").

- *Log:* the test build wraps the router or the handlers —
  `journal("POST /invoices")` from `harness.ts`. The test file is determined from
  the stack (including the `at async <path>` frame after `await`); where there is
  no test on the stack (e2e: the request arrives at the server) — explicitly:
  `journal(id, { test: test.info().file })` in Playwright. Records go to
  `.spec-journal/<process>.jsonl` (`SPEC_JOURNAL` sets another directory; it's
  in `.gitignore`).
- *A call counts if the test made it:* the test is on the call's stack or is
  passed along the causal chain (an e2e fixture that sends the request; a
  request header — the NestJS recipe below). Vitest's
  `expect.getState().testPath` in a wrapper is no substitute for the stack: it's
  the test running *now*, and it also gets credited with calls from a timer, a
  background job, cron or a queue that fired during the test — the entry point
  comes out "called" without claimed behavior. `testPath` works where the test
  itself takes it — in a request helper.
- *A directory per runner, reset at the start of a run:* logs pile up from run
  to run, and a deleted test keeps "calling" the entry point. A runner writes to
  its own directory and wipes it before the tests — the harness's
  `resetJournal()` in globalSetup (bun test — in `preload`): it wipes the
  `*.jsonl` files of the `SPEC_JOURNAL` directory and leaves subdirectories —
  other runners' logs — alone; `spec-claims` reads the directory with its
  subdirectories.

  ```ts
  // vitest.config.ts; Playwright — the same in playwright.config.ts with ".spec-journal/e2e"
  process.env.SPEC_JOURNAL ??= ".spec-journal/unit"; // before the workers: they inherit the environment
  export default defineConfig({ test: { globalSetup: ["tests/setup/journal.ts"] } });

  // tests/setup/journal.ts — once per run, before the tests
  import { resetJournal } from "../../.agents/skills/spec/scripts/harness.ts";
  export default () => resetJournal();
  ```
- *Log in Next.js:* the entry points are `page.tsx` exports, `route.ts` methods
  and the exports of `"use server"` modules.
  - Vitest — a Vite plugin in the test build wraps them with a `journal` call (a
    page — by file path, a route — `<method> <path>`, an action —
    `<file>#<export>`).
  - e2e — a Playwright fixture records the browser's requests: navigating to a
    page and an RSC request (`RSC: 1`) — a page, a prefetch
    (`Next-Router-Prefetch`) — not, `/api/…` — a route by method, a POST with the
    `Next-Action` header — an action via
    `.next/server/server-reference-manifest.json` (`filename` +
    `exportedName`); e2e tests import `test` only from this fixture — a
    `no-restricted-imports` rule on `@playwright/test`, otherwise the call won't
    get into the log.
- *Log in NestJS:* the entry points are methods with Nest metadata: controller
  handlers (`@Get()`…), GraphQL resolvers (`@Query()`, `@Mutation()`),
  `@nestjs/schedule` jobs (`@Cron()`, `@Interval()`).
  - The wrapper is on the method itself, not an interceptor: tests call a
    resolver both directly and over HTTP, and an interceptor sees only the
    latter. The test build's setup (`setupFiles`, before the modules are
    imported) replaces `Reflect.decorate`: after the decorators, a method with
    entry-point metadata is replaced with a wrapper that calls `journal`.
    `Reflect.decorate` is called by an SWC or tsc build (`unplugin-swc` for
    Vitest — Nest requires it anyway for `emitDecoratorMetadata`); esbuild
    doesn't call it.

    ```ts
    const decorate = Reflect.decorate.bind(Reflect) as (...a: unknown[]) => PropertyDescriptor | undefined;
    (Reflect as any).decorate = (decorators: unknown, target: any, key?: string | symbol, desc?: PropertyDescriptor) => {
      const result = decorate(decorators, target, key, desc);
      const original = result?.value;
      if (key === undefined || typeof original !== "function" || !entryId(target.constructor, key, original)) return result;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        // id at call time: the controller path is class metadata, and the class decorator runs after the methods'
        journal(entryId(target.constructor, key, original)!, { test: requestTest.getStore() }); // no request — the stack
        return original.apply(this, args);
      };
      // Nest metadata lives on the method function: without copying it the route and the resolver are lost
      for (const k of Reflect.getOwnMetadataKeys(original)) Reflect.defineMetadata(k, Reflect.getOwnMetadata(k, original), wrapped);
      return { ...result, value: wrapped };
    };
    ```

  - `entryId(class, method, function)` — an id from the metadata: the HTTP path
    and method (`PATH_METADATA`, `METHOD_METADATA` from
    `@nestjs/common/constants`), the resolver's type and name
    (`@nestjs/graphql`), the job name (`@nestjs/schedule`); not an entry point —
    `null`.
  - Over HTTP there is no test on the stack: the request helper in the tests sets
    a header with `expect.getState().testPath` (the helper is called from the
    test), and the test app's middleware puts it into `AsyncLocalStorage`
    (`requestTest`) for the duration of the request. A timer and cron that a
    request didn't start get no context and, without a test on the stack, don't
    count.
  - The registry uses the same metadata through the same `entryId`, otherwise the
    format diverges: the test build (SWC), after importing the app module, walks
    the wrapped methods and writes JSON, which `spec-claims --entries` reads —
    Node without a build won't load Nest decorators.
- *Log of an SPA with a client-side router* (TanStack Router, React Router on
  Vite): the server doesn't see link navigation — the entry point is the
  router's route in the page, not a request.
  - An e2e fixture listens to the router in the page and records the route
    template (`/invoices/$id`), not the URL (`/invoices/42`): the registry comes
    from the route tree, with the same id.
  - TanStack Router: the router is `self.__TSR_ROUTER__` (it appears after the
    app loads — the init script waits for it), subscribe with
    `router.subscribe("onResolved", …)` and `"onRendered"` (the first navigation
    may finish before subscribing), the id is the `routeId` of the last of
    `router.state.matches`. React Router: the test build puts the
    `createBrowserRouter` router on `window`, subscribe with
    `router.subscribe(state => …)`, the template is the paths of
    `state.matches` joined in order.
  - Bind to the context, not the page: `context.exposeBinding` (a call from the
    page → `journal(id, { test: testInfo.file })`) and `context.addInitScript` —
    otherwise a popup and a new tab (`target="_blank"`, `window.open`) go
    unlogged.
- *The reconciliation report for `spec-doc`:* reconciliation isn't always run
  locally — with no report file (`.spec-claims.xml`), `spec-doc` warns and
  builds the spec without it; in CI (`CI` is set) a missing report is exit code
  2: the run's tests would silently drop out.
- *Registry:* entry points from the code — a JSON array or a project module
  (`export default async () => [...]`: routes from the router files, jobs from a
  registry). A handwritten list won't do: a new entry point would slip through.
- *Reconciliation — after all tests and shards have run* (shard logs go into one
  directory as artifacts):

  ```bash
  node .agents/skills/spec/scripts/spec-claims.ts --entries tests/standards/entry-points/entries.ts [--exceptions tests/standards/entry-points/exceptions]
  ```

  Tests «<entry> вызывается тестом capability» (is called by a capability test)
  — a call from `tests/capabilities/` (one from a standard or a helper doesn't
  count); «реестр «точки входа» не пуст» (the entry-points registry isn't
  empty); «id точек входа в реестре не повторяются» (entry-point ids don't
  repeat in the registry; a repeat would hide an uncovered entry point behind a
  covered one); «id из журнала есть в реестре» (ids from the log are in the
  registry; otherwise the log's id format diverged from the registry, the
  registry is incomplete, or the log is left over from a previous run);
  «исключение: <entry> (#N)» — green while there is no test, once there is one —
  «убери исключение» (remove the exception). `--exceptions` is a directory, one
  file per exception (no directory — no exceptions; a file instead of a
  directory — exit code 2 with a migration hint). Exit code 1 on unclaimed
  entry points. The report is `.spec-claims.xml` (JUnit) in the standard's
  folder `tests/standards/entry-points` (`--standard`): pass it to `spec-doc`
  together with the runners' reports — the reconciliation gets into the spec
  with the standard's `entry-points.md` description.

**Scenarios — `sequence` and `trace`.** How the parts of the system interact in
a scenario is a sequence diagram from a capability test's trace, not a drawing.

- *Trace:* the test build wraps the model's boundaries — the entry point (next to
  `journal`), an external system's adapter, a storage client, a call to another
  container — and calls `trace(from, to, message)` with the names of model
  elements. Outside a scenario and inside a participant (`from === to`) the call
  isn't recorded: rearranging things inside a module doesn't change the
  diagram.
- *Scenario:* `sequence(it, "the order gets paid", async () => { … }, { id:
  "payment", order: ["app → db: reserve", "app → stripe: charge"], model })`
  — a test whose trace goes into the run metadata (`.spec-meta`). `order` — when
  the order is itself a decision: the steps must come in this sequence (anything
  in between), otherwise the test is red; `model` — participants only from the
  model. Without `order` the diagram is documentation. A file's scenarios run
  one at a time (`test.concurrent` would mix the traces).
- *Diagram:* `spec-doc` draws a `sequenceDiagram` under the scenario's test; the
  marker `<!-- spec: sequence-payment -->` in `<folder>.md` puts it into the
  story (then it isn't under the test); a marker without a scenario among the
  folder's tests — `--strict` exit code 1.

**Code without a consumer — `deadCode` (knip).** A file, export or dependency
that no entry point reaches is dead code: knip finds it by the import graph
(knip's entry points come from its config in the project).

```ts
import { describe, it } from "vitest";
import { deadCode, exceptionsIn } from "../../../.agents/skills/spec/scripts/harness.ts";

const exceptions = exceptionsIn(); // the folder's exceptions/<finding>.json: { "item": "export:src/math.ts#factorial", … }
describe("no code without a consumer", () => deadCode(it, { root: process.cwd(), exceptions }));
// code that only tests reach: knip --production, tests tagged " (production)"
describe("product code is needed by the product", () => deadCode(it, { root: process.cwd(), exceptions, production: true }));
// knip arguments: deadCode(it, { root, args: ["--tsConfig", "tsconfig.test.json"] }) — tests outside the main tsconfig
```

Tests by kind — «нет файлов без потребителя», «нет экспортов без потребителя»,
«нет типов без потребителя», «нет зависимостей без импорта»,
«нет импортов неустановленных пакетов», «нет нерезолвящихся импортов» (no
unused files, exports, types; no dependencies without an import; no imports of
unlisted packages; no unresolved imports) and the knip 6 kinds —
«нет членов перечислений без потребителя»,
«нет членов пространств имён без потребителя», «нет экспортов-дублей»,
«нет вызовов неустановленных бинарников»,
«нет лишних записей каталога пакетов»,
«нет ссылок на отсутствующие записи каталога пакетов» (no unused enum members,
namespace members, duplicate exports, calls to unlisted binaries, unused
catalog entries, references to missing catalog entries) — failing with the
list of findings. «все находки knip — известных видов» (all knip findings are
of known kinds) fails on a kind the harness doesn't know (new in knip, `cycles`
with `--cycles`): a finding doesn't disappear silently.

**Finding key** — `<kind>:<file>#<name>`, the file comes from knip's report:
`export:src/math.ts#factorial`, `enumMember:src/color.ts#Color.Blue`; for a
dependency and a binary from scripts — the workspace's `package.json`
(`dependency:packages/a/package.json#lodash`), for an unlisted package — the
file with the import (`unlisted:packages/a/src/x.ts#zod`), for a catalog — its
file and the catalog name (`catalog:pnpm-workspace.yaml#default.vue`,
`catalogReference:packages/a/package.json#react18.react`); for a file —
`file:src/legacy.ts`. An exception in one workspace doesn't hide the same
package in another. An exception is a key with a task: green while knip finds
it; once it stops — «убери исключение»; an old key without a file
(`dependency:lodash`) — a failed test listing the keys to replace.

**Configuration hints** — the test «нет подсказок конфигурации knip» (no knip
configuration hints): a redundant `ignore*`, an `entry` or `project` with no
matches, a redundant workspace — as a string `<workspace>#<type>:<what>`
(`packages/a#ignoreDependencies:lodash`, `.#entry-empty:src/main.ts`), an
exception is `hint:<string>`. knip doesn't put them into the JSON report — the
skill's reporter `knip-hints.cjs` prints them as the second line of output;
`hints: false` — no check.

**Running knip** — when the tests are registered, not in the first test: on a
monorepo knip takes longer than a test timeout (5 s in Vitest). Without
`report`, the project's
`node_modules/.bin/knip --reporter json --reporter <skill>/knip-hints.cjs` is
run (plus `args`); `report` is ready output of the same command (`knip --reporter
json --reporter .agents/skills/spec/scripts/knip-hints.cjs > .knip.json`);
without the hints line — a failed test with that command. An exit code other
than 0/1 or output that isn't JSON — all the kind tests fail with the reason: a
knip crash isn't "no dead code".

**Several runs** in a folder (production mode, workspaces via `args`) — each has
a `rule` (with `production: true` — `production`): the ` (<rule>)` tag in the
test names. An exception with a `rule` belongs only to its own run; without
`rule` it silences the finding in all runs, and the ratchet belongs to the run
without `rule`: in production knip doesn't look at devDependencies and tests,
and "remove it" there would be false. A `rule` that no run has — a failed
reconciliation test, as with `invariant`.

**Environment variables — `envVars`.** A variable the code reads
(`process.env.X`, `import.meta.env.X`, `?.X`, `["X"]`, `?.["X"]`,
destructuring — `const { X, Y = "d", Z: z } = process.env` and from
`import.meta.env`, reading through an alias — `(env: Env = process.env) =>
env.X`, `const e = process.env; e["X"]`, the result of Vite's `loadEnv` —
`const env = loadEnv(mode, root); env.VITE_X`) is declared in the environment
schema; a declared one is read. Comments aren't read. `declared` comes from the
project's schema (zod schema keys, t3-env) or `.env.example` —
`dotenvNames(text)`: `X=`, `export X=` and a commented-out `# X=` — an optional
variable with a default in the code; prose in a comment isn't a declaration:

```ts
envVars(it, { root: process.cwd(), dirs: ["src"], declared: Object.keys(envSchema.shape) });
envVars(it, { root: process.cwd(), dirs: ["src", "vite.config.ts"], declared: dotenvNames(readFileSync(".env.example", "utf8")) });
```

`dirs` — code directories and individual files (a config at the package root);
`codeFiles` and `sources` take them the same way.

Custom ways of reading — `readers`: a regexp (the name is the `name` group or
the first one, no `g` flag needed) or a function `(code, file) => names` over
the code without comments. A config accessor (NestJS `ConfigService`:
`config.get('X')`, `getOrThrow<string>('X')` on an object under any name) is the
ready-made `configGet`; it isn't built in — `.get('X')` also exists on a Map and
a cache:

```ts
envVars(it, { root: process.cwd(), declared, readers: [configGet, /\bsecret\(\s*"(?<name>[A-Z_]+)"/] });
```

**Monorepo — `apps` instead of `declared`.** A workspace package reads the
environment of the app whose build it ends up in: its reads belong to every app
that has it in `dependencies`, transitively (`devDependencies` don't get into
the build). Packages — `workspaces` of the root `package.json` and
`pnpm-workspace.yaml` (`!` — exclude); `dirs` — from each package's directory,
an app has its own `dirs`. An element is `<app>/<VAR>`: tests
«api/DATABASE_URL объявлена» (is declared), exception keys and `outside` are
the same:

```ts
envVars(it, {
  root: process.cwd(),
  dirs: ["src", "vite.config.ts"],
  readers: [configGet],
  apps: {
    api: { dir: "apps/api", declared: dotenvNames(readFileSync("apps/api/.env.example", "utf8")) },
    web: { dir: "apps/web", declared: Object.keys(webEnv.shape) },
  },
});
```

Tests «<VAR> объявлена» (is declared) and «<VAR> читается в коде» (is read in
the code); service ones (`NODE_ENV`, `CI`, `PORT`… — `ENV_SERVICE`) are outside
the check. A project with its own registries on `invariant` takes the same
parts: `envNamesInCode(codeOnly(text, file), { file, readers })`, `codeFiles`,
`ENV_SERVICE`. Intentionally outside the check — `outside: [{ item, reason }]`:
the test «вне охвата: <VAR>» with the reason on the page; the variable is in
neither the code nor the schema — «убери из охвата»; `ignore` (without a
reason) — a failed test «перенеси в outside» (move it to outside). An exception
and outside scope belong to the check whose registry has the variable: read
without being declared — to «объявлена», declared without being read — to
«читается».

**Example code and exception reasons — in the spec.** While registering the
tests, the harness writes run metadata — `.spec-meta/<process>.jsonl`
(`SPEC_META` sets another directory): for an `examples` example — the path and
the code, for an exception (`invariant`, `deadCode`, `lintExceptions`) — the
task and the reason. `spec-doc` takes them from `.spec-meta` at the root (or
`--meta`) and shows them under the test's line: the convention is visible as
code, the debt as tasks. CI collects the shards' metadata into one directory,
like the entry-point log (`ci.md`).

**External systems (C1) — `externals` in the model.** The model names every
external system and its adapter module:

```ts
externals: {
  payments: { purpose: "card payments", adapter: "stripe", hosts: ["api.stripe.com"], packages: ["stripe"], env: ["STRIPE_KEY"] },
  telegram: { purpose: "messenger", adapter: ["bot", "notify"], hosts: ["api.telegram.org"] },
  cloudflare: { purpose: "CDN in front of the site", adapter: "geo", headers: ["CF-IPCountry"] },
  waf: { purpose: "WAF in front of the site" }, // perimeter: no adapter
},
```

`architecture` then adds: «хост <h> — только в адаптере <a>» (the host is only
in the adapter; a URL literal outside the adapter or a host outside the model —
red; not hosts: comments, `xmlns` and W3C namespace URIs, the example domains
`example.com` and `.example`, `.invalid` per RFC 2606, navigation links — the
`href` value of a link and of an object, except `<link href>`: a link is opened
by the visitor's browser, while `location.href =` is navigation by code, a
host), «пакет <p> внешней системы <x> — только у адаптера <a>» (the external
system's package is only with the adapter; the model has no contradictions),
«ключ <K> внешней системы <x> читает только адаптер <a>» (only the adapter reads
the external system's key; reading — as in `envVars`, custom ways — the same
`readers`: `architecture(it, { root, model, readers: [configGet] })`),
«заголовок <H> … читает только адаптер <a>» (only the adapter reads the header;
a string with the header name, case-insensitive — integration through perimeter
headers). An IP in a URL literal is a host of an external system too; not
hosts — only loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) and
`0.0.0.0`. Several adapters — `adapter` as a list: the host, package, key and
header may be in any of them. No adapter — a perimeter (CDN, WAF in front of the
system): no module talks to it, so its host, key or header in the code and its
package in a module are red; on C1 it's a «периметр» (perimeter) in front of the
system.

Network in tests — `networkGuard`, in the test setup **before the mocks**:

```ts
const guard = networkGuard(model, globalThis.fetch);
globalThis.fetch = guard;
afterEach(() => guard.check());
```

The guard is the network under the mocks (`vi.spyOn`, `vi.stubGlobal`, MSW
`server.listen()` are installed on top and answer first): only what isn't mocked
reaches it. It lets out to the network only loopback and the `allow` hosts
(`networkGuard(model, fetch, { allow: ["db"] })` — a CI service, an integration
test's sandbox); a request to a declared external system fails with the host and
system name — a forgotten mock doesn't go out to the network; to a host outside
the model (and to `.test`, a public IP) — «объяви внешнюю систему» (declare the
external system). The code under test may catch the `fetch` exception —
`check()` after the test fails on every rejected request. The browser's CSP
header is `cspConnectSrc(model)`: the project's test compares its `connect-src`
with it, and a new host not in the model won't get into the browser.

**Containers (C2) — `containers` in the model.** Deployable units and the links
between them:

```ts
containers: {
  app: { purpose: "web application", modules: ["web", "domain", "repo"], deploy: ["compose:app"], uses: ["db"] },
  mail: { purpose: "sending email", modules: ["mailer"], deploy: ["supabase-function:send-email"] },
  db: { purpose: "database", deploy: ["compose:db"], clients: ["pg"] },
},
```

`architecture` then adds: «модуль <m> — в контейнере <c>» (the module is in the
container; in none or in several — red),
«зависимость <a> → <b> — внутри контейнера» (the dependency is within a
container; the target is in every container of the source; between containers —
only a `uses` link), «развёртываемая единица <id> — контейнер <c>» (the
deployable unit is a container; a unit from the configs without the model and a
model container without a config are red),
«клиент <pkg> хранилища <s> — в контейнере <c>» (the storage client is in the
container; without `uses` to the storage — red).

A monorepo's shared package, bundled into several apps, is a module with
`library: true`: its containers are the containers of the modules that depend on
it (transitively) and those where it's named in `modules`; there's no need to
list it in every container. The test is
«библиотека <m> — в контейнерах <c1, c2>» (the library is in the containers; in
none — red: no module of the containers depends on it); its dependency is within
each of its containers, its storage client — with a `uses` link from each. On
C3 a library is outside the container boundaries.

Deployable units (`deployUnits`) — services in `docker-compose.yml` /
`compose.yml`, `supabase/functions/<name>`, crons in `vercel.json`, Terraform
compute resources in `*.tf` — `terraform:<type>.<name>` (`aws_ecs_service`,
`aws_lambda_function`, `aws_apprunner_service`, Cloud Run and Cloud Functions,
`azurerm_container_app`, `kubernetes_deployment`…; hidden directories,
including `.terraform`, aren't read); a resource in a Terraform module counts
once per module, however many instances of the module create it. Other formats
will be added when a project needs them. These checks don't catch production
drift from the configs.

