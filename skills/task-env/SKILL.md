---
name: task-env
description: "A task's environment on the machine — its own Docker Compose stack `<project>-<N>`, the e2e stack on clean volumes, and the machine's proxy (Traefik in Docker) that gives task containers the addresses `http://<service>.<N>.<project>.localhost` without host ports — different hosts, different cookies: parallel sessions don't log each other out; `task-env check` holds the compose file to the task isolation rules. When — you run the task's app, its services or e2e locally; a task needs a database, a queue or another service; Docker is out of network subnets or closed tasks' stacks hang on the machine; `check -g` or the session start says the proxy isn't running; `check` printed ❌ or ○ lines about the compose file; a task's `*.localhost` address doesn't open; you add Traefik labels or edit a compose file; two sessions fight over a port, a container or a volume; port 80 is busy; asked how task addresses work, about Secure cookies or the sandbox — even if 'proxy' or 'isolation' wasn't said."
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

Each command's details and examples — `--help` after it; the details behind this file — `reference.md` next to it.
Run the script outside the sandbox — section "Docker and the sandbox".

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
| profiles | `--profile <name>` (repeated) goes to Compose: a heavy service in `profiles` runs only in a task that asks for it |
| addresses | HTTP services of `env.http` — `http://<service>.<N>.<project>.localhost` (the proxy's port when it isn't 80); a published port — `127.0.0.1:<host port> → <port>` |

The settings — `env.http` in the project's `.agents/ai-dev.json`, a service → its HTTP port inside the container
(`install` and `update` keep the field): in a compose file a database's port doesn't differ from an app's.

```json
{ "env": { "http": { "web": 3000, "admin": 5173 } } }
```

A service of `env.http` that isn't in the compose file — a `!` line, not an error. No `env.http` — no labels, no
proxy, only published ports.

**The app's own address** — from the compose file: `up` and `e2e` give Compose's process the address of each
`env.http` service in `TASK_ENV_<SERVICE>_URL` (the names the e2e command gets), and the compose file passes them to the app — a base URL,
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

**The override** — the proxy's labels and network for the `env.http` services (a database isn't published), on
Compose's stdin, not a file; `up` starts the proxy first if it isn't running — reference.md, "Override and compose
files"; the labels — reference.md, "Labels of a task stack's service".

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

**down** — both stacks of the task with their volumes; without a number — the branch's task; other tasks' stacks and
the main checkout's aren't touched; `task close` of the `github` skill calls it — reference.md, "Taking a task's
stacks down". **prune** — the stacks of the project's closed tasks left on the machine go with their volumes, without
a question: a closed task's stack is nobody's; what is left — reference.md, "Stacks of closed tasks". **A stack that
didn't come up** — code 1, each failed service with its state and log — reference.md, "A stack that didn't come up".
Exit codes — reference.md, "Exit codes".

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

`proxy/compose.yaml` next to this file — the Compose project `ai-dev-proxy`: Traefik publishes only containers with
`traefik.enable=true` on `127.0.0.1:80` — not on the local network — and comes back with Docker (`proxy down`
removes it for good). Routes follow Docker events — no reload; an unknown host — `404`. `proxy up` again after a
skill update brings the container to the new compose file. Its network, health and the API the dashboard reads
addresses from — reference.md, "The proxy".

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

`task-env check` reads `docker compose config`, not the YAML, so every form of writing is covered, and needs no Docker
daemon — reference.md, "What the compose file check reads".

### What the agent does

| Moment | Action |
|---|---|
| The project's `check` (the session start hook) printed `❌ <file>: …` | each line names the subject (a service, or a volume or network with the services using it), the rule and the fix; fixing it is a task of its own in the project, not the current one |
| `○ <file>: not checked — …` | the check couldn't run (no bun, no `docker` or its `compose` plugin, the config doesn't parse — the line has the reason): nothing is known about violations, it isn't an error |
| You edit a compose file | `task-env check` before the commit |

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

In short; versions, measurements and how — reference.md, "Checked on the machine".

- Port 80 on macOS without sudo — Docker Desktop publishes `127.0.0.1:80`.
- `Secure` and `__Host-` cookies over `http://*.localhost` work in Chromium, through the proxy too.
- The Claude Code sandbox doesn't reach the addresses by default — section "Local ports and task addresses".
- An `excludedCommands` entry takes a Bash call out only when it covers every command in it; none takes out a script
  run by `bun` (Claude Code's matcher), a script under `bash` — yes.
- HMR of an app in a container with the worktree's code works through the proxy.

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
