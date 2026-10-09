# How to test: runs, environment, e2e, UI in a browser — for "Tests and code"

The rule — which test is needed and how it can fail — is "Specification —
decisions" (`skills/spec/canon.md`) and "Tests and code" in `AGENTS.md`; own
port and own database — `docs/parallel-checkouts.md`.
Here — how to run tests, read the result, write e2e tests that don't flake,
and check UI in the agent's browser. The rules hold for any stack, the
examples are Playwright. Three things depend on the framework: which env files
each command reads, what is baked into the build, and how to serve a
production build locally — they are in "Framework: three questions". Checked
against the Playwright, Next.js, Vite, SvelteKit and Nuxt documentation.

## Run and result

- **A heavy run goes through the machine queue.** The flow install wraps the
  project's checks (`lint`, `typecheck`, `test`, `test:*`) in `slot`: two runs
  go at once, together on half the cores; the rest wait in order of arrival
  and print whom they wait for (the `slot` skill). Without the queue,
  neighboring sessions, the linter and another worktree's e2e share the cores —
  timeouts and flakes that aren't about the code. Runner workers come from
  `AI_DEV_SLOT_CPUS` (a quarter of the cores); CI has its own:

  ```ts
  maxWorkers: Number(process.env.AI_DEV_SLOT_CPUS) || undefined,                      // vitest.config.ts
  workers: Number(process.env.AI_DEV_SLOT_CPUS) || (process.env.CI ? 2 : undefined), // playwright.config.ts
  ```

  A monorepo on turbo 2 — `"globalPassThroughEnv": ["AI_DEV_SLOT",
  "AI_DEV_SLOT_CPUS"]` in `turbo.json`: otherwise strict env mode won't pass
  them to tasks, and `env`/`globalEnv` would add them to the cache hash.

  Compare time by CI or by CPU (`user` from `time`), not by wall clock: that
  includes the queue wait. Check a flake by repeating it (`--repeat-each`) —
  via a project script, in a slot, otherwise the repeat measures the
  neighbors.
- **A long run — under watch.** A full run, all the more with a queue, does
  not go right up against the agent tool's timeout: on timeout the process is
  killed mid-tests (`Killed: 9`), and the wrapper (`| tail`, `&& echo ok`, a
  script without `set -o pipefail`) may return 0. Run it as a background
  command with a generous timeout (in Claude Code — up to 2 h, completion
  wakes the session) or in a terminal; wait for the process to finish, not
  for a deadline.
- **The result — by the runner's summary, not the exit code.** Playwright's
  summary: `passed`, `failed`, `flaky`, `skipped`, `did not run`,
  `interrupted`; Vitest — the `Test Files` and `Tests` lines; `bun test` —
  `pass` and `fail`. A run is good when the summary is there, there are no
  failed, not-run or interrupted tests, and flakes are investigated (section
  "Tests and code": a flake is a defect). No summary — the run didn't finish,
  whatever the exit code. Filtering the output by `Error:` lies: the app
  server writes harmless errors (an expected 404, a cancelled request) to the
  same stream.
- **A failed test's artifacts — set aside at once.** The runner clears the
  results folder at the start of a run (Playwright — `outputDir`, by default
  `test-results/`): copy the trace, screenshots and video before rerunning.

  ```bash
  cp -R test-results "$TMPDIR/e2e-<task>-$(date +%H%M%S)"
  npx playwright show-trace "$TMPDIR"/e2e-<task>-*/<test>/trace.zip
  ```
- **A build and a run against it — not in parallel.** The build directory
  (section "Framework: three questions") is shared: rebuilding under a running
  server swaps the chunks, and open pages fail loading them. Build first, then
  run; don't build in another terminal of the same checkout.

## Environment

- **Each command reads its own env files, and the production server
  sometimes none.** The dev server, the build and the production server of
  one app take their environment from different places (table below). An env
  pulled from the host (`vercel env pull`, `netlify env:import` and the like)
  may carry production secrets and production addresses: a local production
  build will take it and go to the production database.
- **Exports win over files.** `.env*` doesn't override a variable already set
  in the environment (Next.js, Vite and everything built on it, dotenv
  without `override`), and a production server that reads no files sees only
  the exports. Local build, production server and e2e — only with an
  explicitly exported local environment:

  ```bash
  set -a; . ./.env.e2e; set +a        # own file, local addresses only
  npm run build && npm run test:e2e
  ```
- **What is baked into the build can't be changed by an export.** Public
  variables (and in some frameworks private ones — see the table) are
  substituted into the code at build time: the build for e2e uses the same
  local environment as the run; changed an address or a port — rebuild.
- **Where the env points — check with a command, don't rely on memory:**

  ```bash
  grep -H -E '^[A-Z_]*_URL=' .env* | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'
  ```

  A guard "a laptop doesn't connect to a remote database without an explicit
  flag" is a project standard (`tests/standards/<name>`), not attentiveness.
- **A fresh database per run.** CI starts from an empty database and catches
  fixture races; a populated local database hides them — or the other way
  round, its old rows show up in others' lists. Run on your own fresh database
  (`docs/parallel-checkouts.md`). A test that is green on CI's empty database
  and red on a populated local one is a defect of the test (it depends on
  others' data), not of the database.

## e2e

- **Against a production build, not the dev server.** `webServer.command` is
  the build and the production server (table below), not `dev`. The dev
  server changes code under a run: Next.js compiles a route on its first
  request, Vite (and SvelteKit, Nuxt, React Router built on it) re-bundles
  dependencies and reloads the page when it meets a new dependency mid-run —
  timeouts and warnings that production doesn't have.
- **External services — stubs or emulators** via environment flags of the
  e2e server (`webServer.env`): email, payments, storage, LLM. A side effect
  ("email sent", "payment created") — by polling your own database or the
  emulator, not via a UI that itself depends on the external service.
- **Shared data — a setup project, once per run.** What all parallel files
  see (reference data, catalogs, users to log in with) is created by the
  runner's setup project, not by a file's `beforeAll`: otherwise two files at
  once see "missing — creating" (TOCTOU) and fail on a unique key or share one
  row.

  ```ts
  // playwright.config.ts
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    { name: 'e2e', dependencies: ['setup'], use: { storageState: 'tests/.auth/user.json' } },
  ],
  ```
- **Your own data — under a unique prefix.** Test data gets a prefix from the
  worker, the time and a random suffix
  (`` `e2e-${testInfo.workerIndex}-${Date.now()}-${rnd}` ``); creating and
  cleaning up — directly in the database (factories in `tests/lib`), not via
  the UI: UI setup steps are slow and fail in the wrong place.
- **A fixture doesn't surface in others' lists.** Its creation date is in the
  past (lists sort by it, a new row would push the expected one out of first
  place); a test looks for a known entity by name, not for the table's first
  row.
- **Wait for the response — before the action and by its own URL.**

  ```ts
  const saved = page.waitForResponse((r) => r.url().includes(`/api/orders/${id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await saved).ok()).toBe(true);
  ```

  A wait registered after the click misses a fast response; without a URL
  filter it catches someone else's request (analytics, prefetch).
- **The first action after an SSR navigation may be lost** before hydration
  (Next.js, Nuxt, SvelteKit, React Router, Astro islands): the button is
  already in the HTML, the handler isn't there yet. Put the action together
  with the check of its result into a retried block, not a pause:

  ```ts
  await expect(async () => {
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  ```

  `toPass` has a default timeout of 0 — it retries until the test timeout:
  your own `timeout` is required. Only an idempotent action (open, select)
  may be retried, not "create". A SPA without SSR doesn't have this race: the
  button doesn't exist before render, and the runner waits for it. Navigate
  straight to the canonical URL: a path redirect means an extra hydration and
  a race. Assertions are web-first (`toHaveText`, `toBeVisible`), not
  `textContent()` and a snapshot comparison.
- **Log in with a saved session.** The setup project logs in once and writes
  `storageState`; tests start with it instead of filling in the login form. A
  visual check by the agent (the session's browser) uses the same
  `storageState`, without typing a password; page state — from the DOM
  (section "UI in the agent's browser"). The login form is checked by one test
  of the login itself.
- **A guard for a framework's dev warning** (React, Vue: hydration, list
  keys) — a unit test in dev mode (jsdom, happy-dom): the production build
  strips the warnings, so in e2e against it the guard can't fail (section
  "Tests and code").

## UI in the agent's browser

The browser of the agent's session (Claude Code's built-in browser, Chrome
with the extension) is for looking at a page through a human's eyes: layout,
look, the path through screens.

- **State — from the DOM, a screenshot — only for the look.** Whether a popup
  (popover, menu, calendar, dialog) is open and what a click did — read it
  from the page: the accessibility tree (`read_page`, `find`) — is there an
  element with role `dialog`, `menu`, `listbox`; JS on the page
  (`javascript_tool`) — the state attribute and the animations, before the
  action and after it:

  ```js
  ((el) => el && {
    state: el.dataset.state ?? (el.hasAttribute('data-closed') ? 'closed' : 'open'),
    anims: el.getAnimations({ subtree: true }).map((a) => a.playState),
  })(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]'));
  ```

  The attribute depends on the library: `data-state="open|closed"` (Radix,
  shadcn/ui), `data-open`/`data-closed` (Base UI, Headless UI); on the trigger
  button — `aria-expanded`. No element — the popup is closed and unmounted.
- **A screenshot lags behind the state.** A hidden browser pane or a
  background tab is throttled: CSS animations and `requestAnimationFrame`
  almost stand still. A popup that is closed by state (`closed`, exit
  animation `running`) stays mounted until the animation ends and looks open
  in a screenshot for seconds more; a screenshot may also show a frame from
  before the last click.
- **A "doesn't close", "doesn't open", "the click didn't work" bug — only
  after checking the DOM.** `closed` with an exit animation running is not a
  bug but throttling. A bug is when the state didn't change after the action,
  or the animations have ended and the closed element is still visible. A
  screenshot of the result — with the pane visible and after the animations
  end, not after a pause.

## Unit tests

- **A mock goes at the external edge and behaves like the real thing.** A
  mock of your own module hides its behavior (the framework's request queue,
  form parsing, a transaction) and is forbidden by lint ("Specification —
  decisions", `skills/spec/canon.md`). What is replaced is the boundary with
  the outside world — a third-party API's HTTP, email, the clock — and the
  way it really responds (codes, delays, error format per its docs).
- **An entry point — through the same input as in production.** A form
  handler gets a `Request` or `FormData` (a Next.js server action, a React
  Router `action`, a SvelteKit form action), a route gets an HTTP request,
  not a ready-made object passed straight into the validation schema:
  otherwise the test doesn't see form parsing, type coercion and missing
  fields.

## Framework: three questions

Before a project's first e2e run — answer from its framework's documentation
and write the answer into the project's `docs/` (an environment recipe):

1. Which env files the dev server, the build and the production server read,
   and whether an already exported environment wins over them.
2. What is baked into the build and doesn't change without a rebuild.
3. How to serve a production build locally and where its directory is.

| Framework | Who reads `.env*` | Baked in at build | Production build locally | Directory |
|---|---|---|---|---|
| Next.js | `dev` — `.env.development*`, `build` and `start` — `.env.production*`, `.env.local` and `.env` — both; under `NODE_ENV=test` `.env.local` isn't read | `NEXT_PUBLIC_*` | `next build && next start` | `.next` |
| Vite (SPA) | `dev` — `.env.development*`, `build` — `.env.production*` (`--mode` changes it), `.env[.local]` — both; production is static files, no environment | `VITE_*` (`import.meta.env`) | `vite build && vite preview` — for checking only, not a production server | `dist` |
| SvelteKit (adapter-node) | `dev` and build — as in Vite; `node build` doesn't read `.env` — `node --env-file=<file> build` | all of `$env/static/*`, private too; `$env/dynamic/*` — at runtime | `vite build && node --env-file=.env.e2e build` | `.svelte-kit`, `build` |
| Nuxt | `dev`, `build`, `generate`, `preview` — `.env` (another file — `--dotenv`); `node .output/server/index.mjs` — reads none | `runtimeConfig` set via `process.env.<another name>`; at runtime only `NUXT_*` overrides it | `nuxt build && nuxt preview` (reads `.env`) | `.nuxt`, `.output` |

A framework not in the table (React Router, Astro, a backend without a
frontend) — the same three questions to its documentation; the answer goes
into the project's `docs/`, not into memory.

## Test knowledge in the project

- The project's `docs/` — only recipes for its own environment: which env
  files, containers, emulators, hosting, how to bring them up, the answers to
  the three questions above.
- A checkable rule about tests ("e2e tests don't mock their own API",
  "fixtures get a prefix") is a standard `tests/standards/<name>`, not a
  paragraph in a document.
- Knowledge about a helper (what a factory creates, what it cleans up, what
  permissions a user has) — in its JSDoc in `tests/lib`: the editor's hint
  shows it, a document doesn't.
- A lesson repeated in two projects is a task in ai-dev for this reference
  (section "This file and skills"), not the agent's memory.
