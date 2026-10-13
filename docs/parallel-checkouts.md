# Parallel checkouts: the task's Compose stack, addresses through the proxy, shared `.git/config` — for "Subagents and worktrees"

Reference for the "Subagents and worktrees" section of `AGENTS.md`: the full
rule, what the project's compose file holds, what moves with the address,
callbacks of external services, the runner config and the sandbox. The stack
itself — its names, the e2e stack and its variables, profiles, taking it
down — is the `task-env` skill; here are links to it, not a copy. Shared git
config — the "Shared `.git/config`" section at the end.

## Rule

**Parallel checkouts share ports, databases and cookies.** Two sessions of
one project on ports of the host fight over a port, migrate one database to
different branches and share Redis, queues and mail; on `localhost` they share
cookies too — cookies don't tell ports apart, and the agent's browser and the
owner's log each other out. So the task's apps, databases, queues, mail and
e2e run in its own Docker Compose stack — a copy of the project's compose
file, the `task-env` skill:

```bash
bun --no-env-file <skill dir>/scripts/task-env.ts up                           # the task's stack by the branch, its addresses
bun --no-env-file <skill dir>/scripts/task-env.ts e2e -- npx playwright test   # the e2e stack anew, the run with its addresses
```

- **The stack** — Compose project `<project>-<N>` by the number from the
  branch, e2e — `<project>-<N>-e2e` on clean volumes, the main checkout —
  `<project>`; the e2e variables `TASK_ENV_*`, heavy services in `profiles`,
  `env.http` in `.agents/ai-dev.json`, taking it down (`task-env down`;
  stacks of closed tasks left on the machine — `task-env prune`) and the
  limit of Docker's subnets — the `task-env` skill,
  section "The task's stack".
- **The addresses** — `http://<service>.<N>.<project>.localhost`, e2e —
  `http://<service>.e2e.<N>.<project>.localhost`: one proxy per machine
  (Traefik) routes them to containers by their labels, nothing is published
  on the host, a different host has its own cookies — the `task-env` skill,
  section "The proxy". The addresses of the tasks in progress are on the
  dashboard's Sessions tab (the `dashboard` skill). A database or a queue has
  no address: inside the stack it is reached by the service name
  (`db:5432`), from the host — by a published `127.0.0.1::5432` (`docker
  compose -p <stack> port db 5432`, in e2e — `TASK_ENV_DB_5432`).
- **Other stacks aren't mine.** A stack is taken down only by `task-env down`
  of my own task (`task close` of the `github` skill calls it); `docker
  compose down`, `stop` or `rm` of another stack — never: the stack's name
  carries the task number (`docker compose ls`). A bare `docker compose down
  -v` without `-p` goes to the project Compose picks by itself — the
  directory or the file's `name:` — and may wipe the main checkout's stack.
- **A busy port of the host** (the proxy's 80, an app outside the stack) —
  first its owner: `lsof -nP -iTCP:<port> -sTCP:LISTEN` and the process's cwd
  (`lsof -a -p <PID> -d cwd -Fn`). Someone else's — I don't kill it: `kill`
  by port breaks someone else's run; the proxy takes another port
  (`AI_DEV_PROXY_PORT`, the `task-env` skill, section "Settings").

## Everything in the compose file

The task's environment is the project's compose file and nothing else: what
runs outside it — an app started on the host, a shared database container,
the machine's Redis — is shared by all tasks again, with its port and data.

- **Every app and everything it reaches** — databases, queues, cache, mail,
  storage, emulators of external services — is a service of the compose
  file. Apps reach them by the service name, as in the project
  (`postgres://db:5432/app`): no host variables, no names per task.
- **HTTP services** and their ports in the container — `env.http` in
  `.agents/ai-dev.json` (`{"env": {"http": {"web": 3000}}}`): only they get an
  address; in a compose file a database's port doesn't differ from an app's.
- **The code** — the worktree's: a build (`build: .`) or a bind mount by a
  relative path (`./src:/app/src`); the dev server's HMR in a container works
  (the `task-env` skill, section "Checked on the machine").
- **A heavy service** (ClickHouse, Elasticsearch, Kafka) — in `profiles`:
  every task gets its own copy, hundreds of MB, so only the tasks that need it
  start it (`up --profile <name>`).
- **The isolation rules** — no `container_name`, no fixed host port, volumes
  and networks without `name:` and `external`, code by relative paths: each
  of the four breaks isolation silently. The project's `check` (and the
  session start hook) names each violation; after editing the compose file —
  `task-env check` before the commit. The table with the fixes — the
  `task-env` skill, section "Compose file isolation rules".

## What moves with the address

The task's app lives at `http://web.<N>.<project>.localhost`, not at
`localhost:3000`: everything that builds absolute links follows the address.

- **The app's base URL** (`APP_URL`, `NEXTAUTH_URL` / `AUTH_URL`, `ORIGIN`) —
  from a variable, not only from the request: `task-env up` and `e2e` give
  Compose the stack's addresses in `TASK_ENV_<SERVICE>_URL`, and the compose
  file passes them on with a default for CI —
  `APP_URL: ${TASK_ENV_WEB_URL:-http://localhost:3000}` (the `task-env`
  skill, section "The task's stack"); a public variable baked in at build
  (`NEXT_PUBLIC_*_URL`, `VITE_*_URL`) — into `build.args` the same way. A
  framework with the address in its settings doesn't read the request; one
  that does may take it from there: the proxy passes the client's `Host` on
  (Traefik's `passHostHeader` is on by default) — Auth.js behind a proxy with
  `AUTH_TRUST_HOST=true` and without `AUTH_URL`. A value written in the
  compose file as is — the same for every task.
- **Links in emails** — the stack's own mail catcher (Mailpit as a service of
  the compose file) shows them with the task's address.
- **Callbacks of external services** — the next section.
- **Check:** no host port of the app is left —
  `grep -rn "localhost:3000" *compose*.y*ml .env* playwright.config.*`.

## Callbacks of external services

- **OAuth redirect URI** — the task's address:
  `http://web.<N>.<project>.localhost/api/auth/callback/<provider>`. The
  redirect goes through the user's browser, and the browser resolves
  `*.localhost` itself. Providers match the URI exactly: Google doesn't take
  wildcards, takes plain `http` only for localhost and wants a host on the
  public suffix list — whether it takes a `*.localhost` subdomain, its docs
  don't say: check in the console; GitHub matches exactly, with wildcard
  matching on — by the host without subdomains and the port, so the callback
  `http://<project>.localhost/…` covers every task's address. A dev OAuth app
  of its own, not the production one; what a provider doesn't take — a stub in
  e2e (`docs/testing.md`, "e2e").
- **Webhooks** come from the internet and don't reach `*.localhost`: the
  forwarder is a service of the task's stack and delivers by the service
  name. Stripe — its CLI:

  ```yaml
  services:
    stripe:
      image: stripe/stripe-cli
      profiles: [stripe]
      command: listen --api-key ${STRIPE_SECRET_KEY:-} --forward-to http://web:3000/api/webhooks/stripe
  ```

  The signing secret doesn't change between runs of `listen` (the Stripe CLI
  docs): `stripe listen --print-secret` once — and it goes into the app's
  `STRIPE_WEBHOOK_SECRET`. The key is a test-mode one, from the environment or
  the project's `.env`, not from the compose file. Every running `listen`
  receives every event of the account: one task's app also gets the other
  tasks' events and answers `2xx` to an object it doesn't have rather than
  failing. A tunnel (ngrok, cloudflared) is the same — one per stack, its
  address in the provider's settings.

## Runner config: the e2e stack's address

```ts
// playwright.config.ts — `task-env e2e -- npx playwright test` gives the e2e stack's address;
// without it (CI, a run not through task-env) everything stays as before
import { defineConfig } from '@playwright/test';

const stack = process.env.TASK_ENV_WEB_URL;      // http://web.e2e.42.shop.localhost
const baseURL = stack ?? 'http://localhost:3000';

export default defineConfig({
  use: { baseURL },
  webServer: stack ? undefined : {              // the stack serves the app: the runner starts no server
    command: 'npm run build && npm run start',
    url: baseURL,
    reuseExistingServer: false,                 // a busy port is an error, not someone else's server
  },
});
```

- The address is `TASK_ENV_<SERVICE>_URL` of the HTTP service: `web` →
  `TASK_ENV_WEB_URL`. The stack's database for factories and seeds —
  `TASK_ENV_DB_5432` (`127.0.0.1:<port>`) when its `db` publishes
  `127.0.0.1::5432`: the run builds **all** its connection variables from it
  (`DATABASE_URL`, `DIRECT_URL`, `PG*`) — one forgotten variable sends seeds
  into another database.
- The e2e stack is created anew with clean volumes on every run and stays
  until the next one: a failed run is examined on it (`docker compose -p
  <project>-<N>-e2e logs`).
- Without the variable — the runner's own server on its port, as in CI.
  `reuseExistingServer: !process.env.CI` from the Playwright template, outside
  CI, silently picks up the neighbor's server on the same port: the tests run
  against someone else's code and database. The behavior of `webServer` is
  checked against the Playwright docs ("Web server", `TestConfig.webServer`):
  `reuseExistingServer: false` fails if something is already listening on
  `url`.

## The sandbox

Docker doesn't work inside the Claude Code sandbox, and the addresses
`*.localhost` aren't reachable from it by default — the `task-env` skill,
sections "Docker and the sandbox" and "Checked on the machine".

- **The `task-env` script** — a separate Bash call outside the sandbox: no
  `excludedCommands` entry takes out a script run by `bun`; inside the sandbox
  it exits with code 2 and says so.
- **The e2e run** is the script's child and runs outside the sandbox with it.
- **Docker itself** (`docker compose -p <stack> logs`, `exec`, `ps`) — the
  owner's step: `sandbox.excludedCommands` in `~/.claude/settings.json`
  (`docker compose *`, `docker ps *`), a call without pipes and redirections.
  Access to Docker is access to the whole machine.
- **The task's addresses from sandboxed commands** (curl, a test runner) —
  with `sandbox.network.allowLocalBinding: true`, the owner's setting: it
  opens the loopback only, Docker stays outside — the `task-env` skill,
  section "Local ports and task addresses". Without it — only an unsandboxed
  command.
- **The agent's browser pane** is outside the sandbox and opens the task's
  addresses itself.

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
