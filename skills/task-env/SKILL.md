---
name: task-env
description: "A task's environment on the machine — the task's Docker Compose stack `<project>-<N>` (`task-env up`, the e2e stack with clean volumes and the run command — `task-env e2e -- <command>`, `task-env down <N>` — `task close` of the `github` skill calls it, `task-env prune` — stacks of closed tasks left on the machine) and the machine's proxy (Traefik in Docker) that gives containers of task stacks the addresses `http://<service>.<N>.<project>.localhost` by their labels, without host ports: different hosts — different cookies, parallel sessions don't log each other out. `task-env proxy up | down | status`; `check -g` names whether the proxy runs; `task-env check` holds the project's compose file to the task isolation rules — no `container_name`, no fixed host port, volumes and networks without `name:` and `external`, code by relative paths — and the project's `check` names each violation. When — you run the task's app, its services or e2e locally; a task needs a database, a queue or another service of the project; stacks of closed tasks hang on the machine or Docker is out of network subnets; `check -g` or the session start says the proxy isn't running; the project's `check` printed ❌ or ○ lines about the compose file; an address `*.localhost` of a task doesn't open (404, connection refused); you add Traefik labels to a container, write a task stack's override or edit a compose file; two sessions of one project fight over a port, a container or a volume; port 80 is busy; asked how task addresses work, whether Secure cookies work over http://*.localhost, how to reach them from the Claude Code sandbox, whether a project's Compose setup lets tasks run side by side — even if the words 'proxy' or 'isolation' weren't said."
allowed-tools: Bash(bun *skills/task-env/scripts/task-env.ts *)
---

# task-env — a task's environment: its own Compose stack, addresses `*.localhost` through one proxy

Parallel sessions of one project run their apps at once. On `localhost` with
different ports they share cookies — cookies don't tell ports apart — and an
agent's browser and the owner's log each other out. A host per app solves it:
`*.localhost` resolves to the loopback and is a secure context in browsers,
and a different host has its own cookies. One proxy per machine — Traefik in
Docker — routes these hosts to the containers of task stacks by their labels:
no host port per app, no port search. The scheme and the reasons — epic
"Environment" in ai-dev (`tests/capabilities/task-env/task-env.md`).

```bash
bun --no-env-file <skill dir>/scripts/task-env.ts up [--profile <p>]...                  # the task's stack by the branch, its addresses
bun --no-env-file <skill dir>/scripts/task-env.ts e2e [--profile <p>]... [-- <command>]  # the e2e stack anew, the command with its addresses
bun --no-env-file <skill dir>/scripts/task-env.ts down [<N>]                             # the task's stacks with their volumes
bun --no-env-file <skill dir>/scripts/task-env.ts prune                                  # stacks of the project's closed tasks
bun --no-env-file <skill dir>/scripts/task-env.ts proxy up       # start it (or bring it to the compose file), wait until healthy
bun --no-env-file <skill dir>/scripts/task-env.ts proxy status   # 0 — running, 1 — not running (the start command), 2 — no Docker
bun --no-env-file <skill dir>/scripts/task-env.ts proxy down     # stop and remove it with its network
bun --no-env-file <skill dir>/scripts/task-env.ts check [<dir>]  # the compose file against the isolation rules: 0 — hold, 1 — ❌ lines, 2 — not checked
```

The skill's `check -g` line: `proxy *.localhost: running (ai-dev-proxy)`,
`not running — start: …` or `Docker unavailable — <reason>`; no Docker on the
machine — no line. It doesn't change the code of `check`: the proxy isn't the
flow falling behind.

## The task's stack

The task's apps, databases, queues and mail live in the project's compose file; `up` brings a copy of it up as the
task's own Compose project, and nothing of it is shared with other tasks.

| what | value |
|---|---|
| task | the number from the branch `[<area>/]<type>/<N>-<slug>`; no number (`main`, a worktree branch before the rename) — the main checkout's stack |
| `<project>` | the repository of `origin` (the last part of its URL without `.git`), no remote — the main checkout's directory; lowercase letters, digits and `-`. Not the directory Compose takes by default — a worktree's is random |
| stack | Compose project `<project>-<N>`, e2e — `<project>-<N>-e2e`, without a task — `<project>`, `<project>-e2e` |
| compose files | the project's (`compose.yaml` … `docker-compose.yml`, Compose's names), its override file (`compose.override.yml` … — Compose takes none of them by itself once `-f` is given) and the task's override on Compose's stdin (`-f -`) |
| up | `up --detach --wait --build --remove-orphans`: built images are the worktree's code, `--wait` returns when services are running and healthy (at most 300 s) |
| profiles | `--profile <name>` (repeated) goes to Compose: a heavy service in `profiles` runs only in a task that asks for it |
| addresses | HTTP services of `env.http` — `http://<service>.<N>.<project>.localhost` (the proxy's port when it isn't 80); a published port — `127.0.0.1:<host port> → <port>` |
| interpolation | `TASK_ENV_<SERVICE>_URL` of each `env.http` service — in the environment of Compose's process, for the compose file (below) |

The settings — `env.http` in the project's `.agents/ai-dev.json`, a service → its HTTP port inside the container
(`install` and `update` keep the field): in a compose file a database's port doesn't differ from an app's.

```json
{ "env": { "http": { "web": 3000, "admin": 5173 } } }
```

A service of `env.http` that isn't in the compose file — a `!` line, not an error. No `env.http` — no labels, no
proxy, only published ports.

**The app's own address** — from the compose file: `up` and `e2e` give Compose's process the stack's addresses in
`TASK_ENV_<SERVICE>_URL` (the names the e2e command gets), and the compose file passes them to the app — a base URL,
an OAuth redirect URI, links in emails — with a default for `docker compose` without `task-env` (CI, by hand):

```yaml
services:
  web:
    environment:
      APP_URL: ${TASK_ENV_WEB_URL:-http://localhost:3000}
      NEXTAUTH_URL: ${TASK_ENV_WEB_URL:-http://localhost:3000}
  worker:
    environment:
      LINK_BASE_URL: ${TASK_ENV_WEB_URL:-http://localhost:3000}   # another service's address too
```

The e2e stack gets its own addresses (`http://web.e2e.42.shop.localhost`), not the dev ones of the task. The
variables live only in the environment of the script's Compose process — no `.env`, no file in the project:
`docker compose up` by hand gets the default. A public variable baked in at build time (`NEXT_PUBLIC_*`, `VITE_*`)
goes into `build.args` the same way: Compose interpolates them too.

**The override** is the only thing the script adds and it isn't a file: the proxy's labels and network for the
`env.http` services (below, section "Labels of a task stack's service"), nothing to the others — a database isn't published.
A `compose.override.yaml` would be the project's own, and `check` would name its external network. The proxy creates
the network, so `up` starts the proxy first if it isn't running (as `proxy up`); a running one isn't touched.

**e2e** — `<project>-<N>-e2e`, apart from the dev stack of the task: `down --volumes` and `up` again on every run, so
the run starts on clean volumes; then the command runs on the host (the current directory, the script's environment)
with the addresses of the e2e stack:

| variable | value |
|---|---|
| `TASK_ENV_PROJECT` | the e2e stack's Compose project: `docker compose -p "$TASK_ENV_PROJECT" exec db …` |
| `TASK_ENV_<SERVICE>_URL` | the HTTP service's address: `http://web.e2e.42.shop.localhost` |
| `TASK_ENV_<SERVICE>_<PORT>` | a published port: `TASK_ENV_DB_5432=127.0.0.1:55012`; not tcp — `_<PORT>_UDP` |

`<SERVICE>` — the service in capitals, other characters `_`. The exit code is the command's; without a command
`e2e` only brings the stack up. The stack stays until the next run: a failed run is examined on it
(`docker compose -p <project>-<N>-e2e logs`).

**down** — `down --volumes --remove-orphans` of `<project>-<N>` and `<project>-<N>-e2e` by the Compose project, from
`/` without the compose file: the worktree may be gone already, and other profiles' services go too. Other tasks'
stacks and the main checkout's aren't touched. `down` without a number — the branch's task. `task close` of the
`github` skill calls it in the task's checkout. A line per stack:

```
+ stack shop-42: down, with its volumes
○ stacks shop-42, shop-42-e2e: none on the machine
! stack shop-42: not removed — <Docker's reason>
```

Only the stacks that are on the machine are taken down — found by the label of containers, volumes and networks
(`com.docker.compose.project`), not by `docker compose ls`: a stack left with volumes only (`down` without `-v`,
containers removed by hand) isn't in its list. No compose file in the checkout — `○ no compose file … — the project
has no task stacks`, Docker isn't called: `task close` of a project without Compose doesn't depend on Docker running.
No docker on the machine — an `○` line; Docker doesn't answer — a `!` line with the reason.

**prune** — the stacks of the project's closed tasks left on the machine (orphans: a task closed without `task
close`, a close that couldn't reach Docker, a task that removed the compose file): every stack `<project>-<N>` and
`<project>-<N>-e2e` on the machine, the task's state by GitHub (`gh api repos/<owner>/<repo>/issues/<N>`, the
repository — the checkout's `origin`). Closed — the stacks go with their volumes right away, without a question: a
closed task's stack is nobody's.

```
○ stack shop-7: no task #7 in acme/shop — left
+ stack shop-41: down, with its volumes — task #41 is closed
○ stack shop-42: task #42 is open — left
○ stack shop-9: its containers are from /work/shop-9 — another project, left
```

Left: an open task's stack, the main checkout's (`<project>`, `<project>-e2e`), a number that isn't an issue (a PR
or none), a state that couldn't be checked (a `!` line), and a stack whose containers ran in an existing directory of
another project — the repository `shop-9` has the main stack `shop-9`, the same name as task #9's stack of `shop`.

**A stack that didn't come up** — code 1 and what failed: the first line is Compose's reason, then each failed service
(not running, exited not with 0, unhealthy) with its state, the last healthcheck's output and the last 20 lines of its
log; nothing failed in containers (an image isn't pulled, a build broke) — the end of Compose's output.

```
stack shop-42: not up — container shop-42-api-1 exited (3)
✗ api: exited (exit 3)
    | Error: connect ECONNREFUSED db:5432
```

Exit codes: `up` — 0 up, 1 not up, 2 not tried (no compose file, broken settings, Docker unavailable, `docker compose
config` fails); `e2e` — the command's, otherwise as `up`; `down` and `prune` — 0, 2 if a stack isn't removed, Docker
is unavailable or (`prune`) a task's state isn't checked.

### Network subnets

Every stack is a network of its own, and Docker Desktop's default address pools hold about 30 networks on the
machine: stacks of other projects (worktrees named by the directory) and forgotten task stacks use them up, and `up`
fails with `all predefined address pools have been fully subnetted`. The fix — take down stacks nobody needs
(`task-env prune` — the project's closed tasks, other stacks — `docker compose ls`) or give Docker smaller subnets, the
owner's step: Docker Desktop → Settings → Docker Engine,

```json
{ "default-address-pools": [{ "base": "172.16.0.0/12", "size": 24 }] }
```

— 4096 networks of 254 addresses.

## The proxy

`proxy/compose.yaml` next to this file — the Compose project `ai-dev-proxy`:

| what | value |
|---|---|
| image | `traefik:v3.7` |
| provider | Docker, `exposedByDefault: false` — a container without `traefik.enable=true` isn't published |
| network | `ai-dev-proxy` (`providers.docker.network`): the proxy reaches containers through it |
| entry point | `web` — HTTP on `127.0.0.1:80`; not on all interfaces: task apps aren't visible on the local network |
| restart | `unless-stopped` — comes back with Docker; `proxy down` removes it for good |
| health | `traefik healthcheck --ping`: `proxy up` returns when the proxy serves |
| API | Traefik's routes on the `web` entry point by the host `ai-dev-proxy.localhost` — a router `ai-dev-proxy-api` of the proxy's own labels to `api@internal`; no UI |

Routes follow Docker events: a container appears in them when it starts and
leaves them when it stops — no reload. An unknown host — `404` from Traefik.
`proxy up` again after a skill update brings the container to the new compose
file.

The API is how the dashboard sees a task's addresses: `proxyHosts` of the
script reads `GET /api/http/routers` (page by page) on the proxy's port with
the host `<name>.localhost` and returns the hosts of the enabled routers of
`web`; the proxy isn't running — none. Not the Docker socket: access to
Docker is access to the whole machine, while the routes over HTTP need only
the loopback and answer the same in the sandbox and outside it. Not
a published `:8080`: a second host port is one more setting and one more
conflict, while `web` is on `127.0.0.1` already; a site that pointed its name
at `127.0.0.1` (DNS rebinding) comes with its own host and gets `404`. The
router is named after the proxy: a test proxy sees the labels of the
machine's one, and routers of one name with different rules Traefik would
drop.

## Labels of a task stack's service

The task stack's override (not the project's compose file) gives each HTTP
service the labels and the proxy network; `proxyLabels` of the script builds
them, `up` and `e2e` pass them to Compose on stdin:

```yaml
services:
  web:
    networks: [default, ai-dev-proxy]
    labels:
      traefik.enable: "true"
      traefik.http.routers.<stack>-web.rule: Host(`web.<N>.<project>.localhost`)
      traefik.http.routers.<stack>-web.entrypoints: web
      traefik.http.routers.<stack>-web.service: <stack>-web
      traefik.http.services.<stack>-web.loadbalancer.server.port: "3000"
networks:
  ai-dev-proxy:
    external: true
```

- `<stack>` — the stack's Compose project: `<project>-<N>`, `<project>-<N>-e2e`,
  `<project>` without a task. The router and the service are named
  `<stack>-<service>` — unique on the machine; replicas (`--scale`) share the
  labels, Traefik balances between them.
- The address: `<service>.<N>.<project>.localhost`, e2e —
  `<service>.e2e.<N>.<project>.localhost`, without a task —
  `<service>.<project>.localhost`. `<project>` — the repository name in
  lowercase letters, digits and `-` (`hostProject` of the script); a task's
  host is parsed by `taskAddress`, its URL with the proxy's port — `addressUrl`.
- The port — the service's HTTP port inside the container; nothing is
  published on the host.
- The network is `external`: the proxy creates it, so `proxy up` goes before
  the task stack — `up` and `e2e` start it themselves.
- Networks: the service's own as Compose normalized them (one without
  `networks` is in `default`) plus the proxy's — listed networks replace the
  implicit `default`, and a key with null keeps the project's aliases.

## Compose file isolation rules

The task's stack is the Docker Compose project `<project>-<N>`, and Compose
keeps stacks apart by the project name — containers, volumes and the network
get its prefix. Four entries in a compose file bypass the prefix and break
isolation silently; the project's `check` (and the session start hook) names
each with `task-env check`, a violation is code 1 of `check`.

| Rule | Breaks | Instead |
|---|---|---|
| no `container_name` | a second stack can't start: one container name per machine | nothing — Compose names containers by the project |
| no fixed host port (`5432:5432`, `127.0.0.1:5432:5432`) | a second stack can't start: the port is taken | `127.0.0.1::5432` (Docker picks the port) or no `ports`; from outside — Traefik or `docker compose port` |
| volumes and networks without `name:` and `external` | stacks share them: `down -v` of one task wipes another's data, services of different tasks see each other | nothing — Compose names them `<project>_<key>` |
| code by relative paths in `volumes` and `build` | the stack mounts and builds someone else's checkout, not its own worktree | a path relative to the compose file (`./src`) |

A bind mount of a machine resource — the Docker socket, `/etc/localtime`, a
device (a source in `/var/run`, `/run`, `/etc`, `/dev`, `/proc`, `/sys`) — is
not code and is fine; `~/…` is an absolute path.

### What the agent does

| Moment | Action |
|---|---|
| The project's `check` (the session start hook) printed `❌ <file>: …` | each line names the subject (a service, or a volume or network with the services using it), the rule and the fix; fixing it is a task of its own in the project, not the current one |
| `○ <file>: not checked — …` | the check couldn't run (no bun, no `docker` or its `compose` plugin, the config doesn't parse — the line has the reason): nothing is known about violations, it isn't an error |
| You edit a compose file | `task-env check` before the commit |

### What is checked

Not the YAML itself but `docker compose config --format json` in the
project directory: Compose has already brought the short and long syntax, the
override file, variables and `extends` to one form. With
`--no-path-resolution` (otherwise relative paths come out absolute) and
`--profile '*'` (otherwise services in `profiles` aren't shown). Volumes and
networks Compose names `<project>_<key>` by itself — only another name or
`external` is a violation. The Docker daemon isn't needed, the command works
in an agent's sandbox. The compose file is looked for under Compose's names in
its order: `compose.yaml`, `compose.yml`, `docker-compose.yaml`,
`docker-compose.yml`.

## Settings

- `AI_DEV_PROXY` — the proxy's name: its Compose project and network
  (default `ai-dev-proxy`); `AI_DEV_PROXY_PORT` — its port on `127.0.0.1`
  (default 80). Tests run their own proxy with them next to the machine's
  one. Port 80 busy — another port, and the addresses carry it:
  `http://web.42.shop.localhost:8080`. The defaults live only in the script
  (`proxyName`, `proxyPort`): it passes both to the compose file explicitly,
  the file has `${…:?}` — `docker compose -f proxy/compose.yaml` by hand needs
  both set; `check -g` of the installer imports `proxyName`.

## Checked on the machine (2026-10-13)

- **Port 80 on macOS without sudo** — yes: Docker Desktop (engine 29.8) publishes
  `127.0.0.1:80` for a user process; `proxy up` to healthy in ~5 s.
- **`Secure` cookies over `http://*.localhost` in Chromium** (Playwright 1.63,
  Chromium 153) — work: `isSecureContext` is true, the browser keeps and sends
  back `Secure`, `Secure; HttpOnly` and `__Host-` cookies set by the server and
  by `document.cookie`, through the proxy on port 80 too. Chromium resolves
  `*.localhost` itself; `[::1]` gets no answer (the port is IPv4 only) and it
  goes to `127.0.0.1`.
- **The Claude Code sandbox** doesn't reach the addresses by default: a direct
  connection to the loopback is denied (`Operation not permitted`, `EPERM`
  in Bun), and `*.localhost` falls under `localhost` in the sandbox's
  `NO_PROXY` (curl matches it as a suffix), so the request doesn't go
  through the sandbox proxy either. What works: the command outside the
  sandbox (below, section "Docker and the sandbox"); the agent's browser
  pane — it is outside the sandbox; through the sandbox proxy with an empty
  `NO_PROXY` and the host in the allowlist (`200` measured).
- **`sandbox.network.allowLocalBinding: true`** (desktop app; the edit
  applied to the running session without a restart) — sandboxed commands
  reach the loopback: a task's address `http://web.<N>.<project>.localhost:<port>`
  answers `200` to curl and to Bun `fetch`, the proxy's API gives its routes,
  a closed port is `ECONNREFUSED` instead of `EPERM`; a command also listens
  on a local port and connects to it. What it is for — below, section
  "Local ports and task addresses".
- **`sandbox.excludedCommands`** (Claude Code in the desktop app): an edit
  of `~/.claude/settings.json` applies to the running session without a
  restart; an entry takes a Bash call out of the sandbox only when it covers
  every command in it — `docker ps | head`, `…; echo` or a redirection to a
  file keep the call sandboxed (the Claude Code docs say the same).
  `docker compose *`, `docker ps *` and `gh *` work. No entry takes out a
  script run by `bun`: `bun …/task-env.ts proxy status` stayed sandboxed
  with the entry written with `~` and with the absolute path, `bun …/github.ts project check` — with the absolute
  path through the `~/.agents/skills` symlink, the call's text matching the
  entry exactly. The cause is Claude Code's matcher, not the path (2.1.295;
  the docs list the call shapes that stay sandboxed only "among others"):
  `bun` leaves the sandbox only when its first argument that isn't a flag is
  a subcommand of its own — `install`, `add`, `test` and the like, and `bun
  run` not even then; a file to run is code it doesn't exempt. A script
  under `bash` is taken out: `bash ~/.agents/skills/ci-wait/scripts/wait-ci.sh
  *` works with the absolute path through the symlink. Checking an entry: in
  auto mode Claude Code refuses `allowed_domains` on a call that would run
  outside the sandbox, before running it.
- **HMR of an app in a container with the worktree's code** — works: Vite 8.3
  (`node:24-alpine`, the worktree bind-mounted to `/app`, `node_modules` in a
  volume) on Docker Desktop (engine 29.8) through the proxy on port 80 — a CSS
  change on the host reached the page in Chromium without a reload: file
  events of the bind mount reach the container, the HMR WebSocket passes
  Traefik, and Vite allows `*.localhost` hosts by default.

## Docker and the sandbox

Docker doesn't work inside the Claude Code sandbox: the sandbox denies its
socket (`permission denied while trying to connect to the docker API`).

- **This script**, like any skill script run by `bun`, — an unsandboxed
  Bash call (`dangerouslyDisableSandbox`): an `excludedCommands` entry
  doesn't take it out (above, section "Checked on the machine"). In the sandbox the script exits with code 2
  and names it — the cue to run the command again outside.
- **Docker itself**, which the agent calls directly (`docker compose -p
  <stack> logs`, `exec`, `ps`), — the owner takes it out in
  `~/.claude/settings.json`: `sandbox.excludedCommands`, entries in the
  `Bash(...)` rule syntax; each command of the call must be covered, so a
  call without pipes and redirections.

```json
{ "sandbox": { "excludedCommands": ["docker compose *", "docker ps *"] } }
```

A command outside the sandbox goes through the regular permissions (in auto
mode — the classifier), and access to Docker is access to the whole machine.
The e2e command is a child of the script and runs outside the sandbox with
it.

### Local ports and task addresses

Without the setting the sandbox denies every connection to `127.0.0.1` and
every listen on it. The owner turns it on in `~/.claude/settings.json`:

```json
{ "sandbox": { "network": { "allowLocalBinding": true } } }
```

- **A task's apps from sandboxed commands** — curl, a test runner, a script
  reach `http://<service>.<N>.<project>.localhost` through the proxy without
  leaving the sandbox; without the setting only an unsandboxed command or the
  agent's browser pane does.
- **Tests that open a local port** — the dashboard's (its server, a fake proxy
  API) and this skill's (a fake Traefik API) — run in the sandbox.
- **The dashboard's server** listens in the sandbox and reads the proxy's
  routes, but the dashboard itself still runs outside it: the `gh` it starts
  fails TLS there (the `dashboard` skill, section "Pitfalls").

It opens the loopback only: Docker stays outside the sandbox (above), other
hosts — by the sandbox's allowlist.
