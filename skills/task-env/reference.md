# task-env — reference

The details behind `SKILL.md` of this skill: what `up` passes to Compose, how `down`, `prune` and a stack that didn't
come up report, exit codes, the proxy's container and API, the labels of a task stack's service, what the compose file
check reads and what was checked on the machine. When to run what and the rules — `SKILL.md`; each command's syntax, exit codes and
examples — `task-env <command> --help`.

## Override and compose files

| what | value |
|---|---|
| compose files | the project's (`compose.yaml` … `docker-compose.yml`, Compose's names), its override file (`compose.override.yml` … — Compose takes none of them by itself once `-f` is given) and the task's override on Compose's stdin (`-f -`) |
| up | `up --detach --wait --build --remove-orphans`: built images are the worktree's code, `--wait` returns when services are running and healthy (at most 300 s) |

**The override** is the only thing the script adds and it isn't a file: the proxy's labels and network for the
`env.http` services (below, section "Labels of a task stack's service"), nothing to the others — a database isn't published.
A `compose.override.yaml` would be the project's own, and `check` would name its external network. The proxy creates
the network, so `up` starts the proxy first if it isn't running (as `proxy up`); a running one isn't touched.

## Taking a task's stacks down

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

## Stacks of closed tasks — prune

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

## A stack that didn't come up

Code 1 and what failed: the first line is Compose's reason, then each failed service (not running, exited not with 0,
unhealthy) with its state, the last healthcheck's output and the last 20 lines of its log; nothing failed in
containers (an image isn't pulled, a build broke) — the end of Compose's output.

```
stack shop-42: not up — container shop-42-api-1 exited (3)
✗ api: exited (exit 3)
    | Error: connect ECONNREFUSED db:5432
```

## Exit codes

`up` — 0 up, 1 not up, 2 not tried (no compose file, broken settings, Docker unavailable, `docker compose config`
fails); `e2e` — the command's, otherwise as `up`; `down` and `prune` — 0, 2 if a stack isn't removed, Docker is
unavailable or (`prune`) a task's state isn't checked; `proxy status` — 0 running, 1 not running (the start command),
2 no Docker; `check` — 0 the rules hold or no compose file, 1 violations, 2 not checked.

## The proxy — container, routes, API

`proxy/compose.yaml` of the skill — the Compose project `elves-proxy`:

| what | value |
|---|---|
| image | `traefik:v3.7` |
| provider | Docker, `exposedByDefault: false` — a container without `traefik.enable=true` isn't published |
| network | `elves-proxy`: the proxy reaches a task stack's service through it — the service names it by the label `traefik.docker.network` |
| default network | `providers.docker.network` — for a container without the label: `elves-proxy`, `ai-dev-proxy` while the proxy is in it (below, section "The proxy before the rename") |
| entry point | `web` — HTTP on `127.0.0.1:80`; not on all interfaces: task apps aren't visible on the local network |
| restart | `unless-stopped` — comes back with Docker; `proxy down` removes it for good |
| health | `traefik healthcheck --ping`: `proxy up` returns when the proxy serves |
| API | Traefik's routes on the `web` entry point by the host `elves-proxy.localhost` — a router `elves-proxy-api` of the proxy's own labels to `api@internal`; no UI |

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

## The proxy before the rename

Before the rename of the flow (ai-dev → Elves) the proxy was the Compose
project `ai-dev-proxy` with the network of that name, and stacks brought up
then are in that network, their services without a network label. For one
release `proxy up` — and `up`, which starts a proxy that isn't running —
takes its place:

- **its container goes** — it holds the port; the new one is created first
  (the image pulled), so a failed pull leaves the former proxy serving:
  `proxy ai-dev-proxy: removed — the proxy before the rename; elves-proxy
  takes its port, its network ai-dev-proxy stays`;
- **its network stays and the proxy joins it** — an override on Compose's
  stdin, as for a task stack: the stacks in it keep their addresses; a
  machine without that network — the proxy is in its own only, the network
  isn't created; `proxy status` names it: `(network elves-proxy; and
  ai-dev-proxy — …)`;
- **the network a container is reached through is deterministic**: a
  container without the proxy's network among its own gets from Traefik "the
  first" of them in Go's map order — a random one per configuration, and a
  stack in its `default` and the proxy's network answers or not by chance. So
  a task stack's service names the network by the label (section "Labels of
  a task stack's service"), and the provider's default is `ai-dev-proxy`
  while the proxy is in it — the stacks before the rename carry no label;
- **the port** — `ELVES_PROXY_PORT`, unset — `AI_DEV_PROXY_PORT` of the
  profile; **the settings** — `.agents/elves.json`, before `update` moves it
  — `.agents/ai-dev.json`.

The former proxy is `ai-dev-proxy` only for the proxy of the default name;
a proxy of another name (a test's) has `<name>-former`, so a test never
touches the machine's proxy. The next release drops the transition: stacks
still in `ai-dev-proxy` alone lose their addresses — `up` again moves them.

## Labels of a task stack's service

The task stack's override (not the project's compose file) gives each HTTP
service the labels and the proxy network; `proxyLabels` of the script builds
them, `up` and `e2e` pass them to Compose on stdin:

```yaml
services:
  web:
    networks: [default, elves-proxy]
    labels:
      traefik.enable: "true"
      traefik.docker.network: elves-proxy
      traefik.http.routers.<stack>-web.rule: Host(`web.<N>.<project>.localhost`)
      traefik.http.routers.<stack>-web.entrypoints: web
      traefik.http.routers.<stack>-web.service: <stack>-web
      traefik.http.services.<stack>-web.loadbalancer.server.port: "3000"
networks:
  elves-proxy:
    external: true
```

The override is the script's, not the project's: a compose file that writes
it by hand shares the proxy's network as `external`, and `check` names it.

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
- `traefik.docker.network` — the network the proxy reaches the service
  through: the service is in its own networks too, and without the label
  Traefik's pick among them is random (section "The proxy before the
  rename").
- Networks: the service's own as Compose normalized them (one without
  `networks` is in `default`) plus the proxy's — listed networks replace the
  implicit `default`, and a key with null keeps the project's aliases.

## What the compose file check reads

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
  sandbox (`SKILL.md`, "Docker and the sandbox"); the agent's browser
  pane — it is outside the sandbox; through the sandbox proxy with an empty
  `NO_PROXY` and the host in the allowlist (`200` measured).
- **`sandbox.network.allowLocalBinding: true`** (desktop app; the edit
  applied to the running session without a restart) — sandboxed commands
  reach the loopback: a task's address `http://web.<N>.<project>.localhost:<port>`
  answers `200` to curl and to Bun `fetch`, the proxy's API gives its routes,
  a closed port is `ECONNREFUSED` instead of `EPERM`; a command also listens
  on a local port and connects to it. What it is for — `SKILL.md`, "Local
  ports and task addresses".
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
