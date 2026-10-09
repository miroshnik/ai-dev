# Parallel checkouts: own port, own database, shared `.git/config` — for "Subagents and worktrees"

Reference for the "Subagents and worktrees" section of `AGENTS.md`: the full
rule, fragments and checks. Shared git config — the "Shared `.git/config`"
section at the end.

## Rule

**Parallel checkouts share ports and databases.** The server and e2e of each
worktree run on their own port and their own database; the port and the
database connection come from environment variables, not hard-coded in the
runner config: a fixed port with `reuseExistingServer` silently picks up the
neighbor's server, and the tests run against someone else's code and
database. Everything that builds absolute links moves with the port: the
app's base URL, callbacks of external services and emulators. I don't kill a
busy port: first its owner — `lsof -ti tcp:<port> -sTCP:LISTEN` and the
process's cwd; someone else's — I take another port. The config fragment,
the "what moves" checklist and a database of your own — below.

The behavior of `webServer` is checked against the Playwright docs ("Web
server", `TestConfig.webServer`): `reuseExistingServer: false` fails if
something is already listening on `url`; `env` is layered over `process.env`.

## Runner config: port from the environment

```ts
// playwright.config.ts — without PORT (CI) everything stays on 3000
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  use: { baseURL },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,   // a busy port is an error, not someone else's server
    env: {
      APP_URL: baseURL,           // everything that builds absolute links —
      NEXTAUTH_URL: baseURL,      // on the same port (checklist below)
    },
  },
});
```

`reuseExistingServer: !process.env.CI` from the Playwright template, outside
CI, silently picks up the neighbor's server on the same port: the tests run
against someone else's code and database. My own server, started by hand, is
already on the port — the runner fails: kill it, and the runner starts its
own.

## A free port

```bash
for p in $(seq 3000 3099); do lsof -ti tcp:$p -sTCP:LISTEN >/dev/null || { echo $p; break; }; done
```

Two checkouts took the same port at once — the second runner fails on
`reuseExistingServer: false` instead of going to someone else's server.

## What moves with the port

- `use.baseURL`, `webServer.url` and the port in the server start command.
- The app's base URL: `APP_URL`, `NEXTAUTH_URL` / `AUTH_URL`, `ORIGIN`
  (SvelteKit), public `NEXT_PUBLIC_*_URL`, `VITE_*_URL`, `NUXT_PUBLIC_*`.
  Public variables are baked in at build time: a run against a built app —
  rebuild with the new port (what each framework bakes in — `docs/testing.md`,
  "Framework: three questions").
- Callbacks and redirects: OAuth redirect URI, webhooks, links in emails.
- Emulators and helper services the run starts (mail, payments, storage):
  each on its own port, with its address in the app's variables.
- Check: the old port is left nowhere —
  `grep -rn "localhost:3000" .env* playwright.config.*`.

## Whose server is on the port

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN                    # PID and command
lsof -a -p <PID> -d cwd -Fn | sed -n 's/^n//p'      # cwd — whose checkout it is
```

cwd is my own worktree — it can be killed. Someone else's — don't touch it
(`kill` by port breaks someone else's run), take another port.

## A database per run

The shared dev database sits at the migration of whoever applied last, and
neighbors restart its container. A run gets its own container on a random
port:

```bash
docker run -d --name e2e-db-<task> -e POSTGRES_PASSWORD=postgres -p 127.0.0.1::5432 postgres:17-alpine
docker port e2e-db-<task> 5432                      # → 127.0.0.1:55261
until docker exec e2e-db-<task> pg_isready -h 127.0.0.1 -U postgres -q; do sleep 1; done
```

`pg_isready` — over TCP (`-h 127.0.0.1`): over the socket it answers "ready"
while initdb is still running, and the migration fails when the server
restarts.

- The address goes into **all** connection variables: `DATABASE_URL`,
  `DIRECT_URL`, `SHADOW_DATABASE_URL`, `PG*` — whichever the project reads.
  One forgotten variable sends migrations or seeds into the shared database.
- Migrations and seeds — from your own branch, onto this database, before the
  server starts.
- After the run or the merge — `docker rm -fv e2e-db-<task>` (the `github`
  skill, "Git, PRs and merging — mechanics": the session's temporary
  resources). `-v` also removes the
  anonymous volume with the database's data: without it the volume is left
  dangling.
- **Don't run `docker compose down -v`.** Compose volumes are shared by all
  checkouts if the project name isn't set by the directory (`name:` in the
  compose file, `COMPOSE_PROJECT_NAME` in a copied `.env`) or the volume has
  an explicit `name:` / `external`: `down -v` in your own worktree wipes the
  database of the main checkout and of the neighbors. A clean database — your
  own container, as above.

## Shared `.git/config`

All worktrees of a repository — and the main checkout — read one
`.git/config`: each copy has its own `HEAD`, index and working files, but the
config, hooks and branches are shared. `git config user.name` or `user.email`
in any copy changes the commit author for all sessions of the repository, not
just its own. The host may not deploy a commit whose author has no access to
the project: the deploy doesn't run, and the site quietly falls behind
`main`.

- **No `git config` in copies or in subagent assignments:** not `--local`,
  not `--global` (that one changes every repository on the machine), not
  `--worktree`: without `extensions.worktreeConfig` it writes to the same
  place, and the extension itself is turned on in the shared config.
- **A test commit with a different author** — a setting for one command:
  `git -c user.name=… -c user.email=… commit`.
- **Git experiments** (hooks, settings, history) — `git clone` into a temp
  folder, not in the shared repository.
- **After a commit** — `git log -1 --format=%ae`: the author is who it should
  be. Someone else — first `git config --show-origin user.email`: where it
  came from, rather than a fix by feel.
