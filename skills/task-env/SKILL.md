---
name: task-env
description: "A task's environment on the machine — the task's Docker Compose stack `<project>-<N>` (`task-env up`, the e2e stack with clean volumes and the run command — `task-env e2e -- <command>`, `task-env down <N>`) and the machine's proxy (Traefik in Docker) that gives containers of task stacks the addresses `http://<service>.<N>.<project>.localhost` by their labels, without host ports: different hosts — different cookies, parallel sessions don't log each other out. `task-env proxy up | down | status`; `check -g` names whether the proxy runs; `task-env check` holds the project's compose file to the task isolation rules — no `container_name`, no fixed host port, volumes and networks without `name:` and `external`, code by relative paths — and the project's `check` names each violation. When — you run the task's app, its services or e2e locally; a task needs a database, a queue or another service of the project; `check -g` or the session start says the proxy isn't running; the project's `check` printed ❌ or ○ lines about the compose file; an address `*.localhost` of a task doesn't open (404, connection refused); you add Traefik labels to a container, write a task stack's override or edit a compose file; two sessions of one project fight over a port, a container or a volume; port 80 is busy; asked how task addresses work, whether Secure cookies work over http://*.localhost, how to reach them from the Claude Code sandbox, whether a project's Compose setup lets tasks run side by side — even if the words 'proxy' or 'isolation' weren't said."
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
bun <skill dir>/scripts/task-env.ts up [--profile <p>]...                  # the task's stack by the branch, its addresses
bun <skill dir>/scripts/task-env.ts e2e [--profile <p>]... [-- <command>]  # the e2e stack anew, the command with its addresses
bun <skill dir>/scripts/task-env.ts down [<N>]                             # the task's stacks with their volumes
bun <skill dir>/scripts/task-env.ts proxy up       # start it (or bring it to the compose file), wait until healthy
bun <skill dir>/scripts/task-env.ts proxy status   # 0 — running, 1 — not running (the start command), 2 — no Docker
bun <skill dir>/scripts/task-env.ts proxy down     # stop and remove it with its network
bun <skill dir>/scripts/task-env.ts check [<dir>]  # the compose file against the isolation rules: 0 — hold, 1 — ❌ lines, 2 — not checked
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

The settings — `env.http` in the project's `.agents/ai-dev.json`, a service → its HTTP port inside the container
(`install` and `update` keep the field): in a compose file a database's port doesn't differ from an app's.

```json
{ "env": { "http": { "web": 3000, "admin": 5173 } } }
```

A service of `env.http` that isn't in the compose file — a `!` line, not an error. No `env.http` — no labels, no
proxy, only published ports.

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
stacks and the main checkout's aren't touched. `down` without a number — the branch's task.

**A stack that didn't come up** — code 1 and what failed: the first line is Compose's reason, then each failed service
(not running, exited not with 0, unhealthy) with its state, the last healthcheck's output and the last 20 lines of its
log; nothing failed in containers (an image isn't pulled, a build broke) — the end of Compose's output.

```
stack shop-42: not up — container shop-42-api-1 exited (3)
✗ api: exited (exit 3)
    | Error: connect ECONNREFUSED db:5432
```

Exit codes: `up` — 0 up, 1 not up, 2 not tried (no compose file, broken settings, Docker unavailable, `docker compose
config` fails); `e2e` — the command's, otherwise as `up`; `down` — 0, 2 if a stack isn't removed.

### Network subnets

Every stack is a network of its own, and Docker Desktop's default address pools hold about 30 networks on the
machine: stacks of other projects (worktrees named by the directory) and forgotten task stacks use them up, and `up`
fails with `all predefined address pools have been fully subnetted`. The fix — take down stacks nobody needs (`docker
compose ls`) or give Docker smaller subnets, the owner's step: Docker Desktop → Settings → Docker Engine,

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

Routes follow Docker events: a container appears in them when it starts and
leaves them when it stops — no reload. An unknown host — `404` from Traefik.
`proxy up` again after a skill update brings the container to the new compose
file.

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
  `<service>.<project>.localhost`.
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
  `http://web.42.shop.localhost:8080`. The name is the same in three places:
  `name:` of the compose file, `proxyName` of the script and `check -g`
  (`bin/ai-dev.mjs`).

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
  connection to the loopback is denied (`Operation not permitted`), and
  `*.localhost` falls under `localhost` in the sandbox's `NO_PROXY` (curl
  matches it as a suffix), so the request doesn't go through the sandbox
  proxy either. What works: the command outside the sandbox
  (`sandbox.excludedCommands`, below); the agent's browser pane — it is
  outside the sandbox; through the sandbox proxy with an empty `NO_PROXY` and
  the host in the allowlist (`200` measured). By the Claude Code docs,
  `sandbox.network.allowLocalBinding: true` lets sandboxed commands connect
  to any port on localhost — the owner's setting, not checked here.

- **HMR of an app in a container with the worktree's code** — works: Vite 8.3
  (`node:24-alpine`, the worktree bind-mounted to `/app`, `node_modules` in a
  volume) on Docker Desktop (engine 29.8) through the proxy on port 80 — a CSS
  change on the host reached the page in Chromium without a reload: file
  events of the bind mount reach the container, the HMR WebSocket passes
  Traefik, and Vite allows `*.localhost` hosts by default.

## Docker and the sandbox

Docker doesn't work inside the Claude Code sandbox: the sandbox denies its
socket. The owner takes Docker and this script out of it in
`~/.claude/settings.json` — `sandbox.excludedCommands`, entries in the
`Bash(...)` rule syntax, matched against the whole command text:

```json
{ "sandbox": { "excludedCommands": ["docker compose *", "docker ps *", "bun ~/.agents/skills/task-env/scripts/task-env.ts *"] } }
```

A command outside the sandbox goes through the regular permissions, and
access to Docker is access to the whole machine. The e2e command is a child
of the script and runs outside the sandbox with it — the addresses
`*.localhost` aren't reachable from inside. Without the exclusion —
`proxy status` exits with code 2 and names the sandbox.
