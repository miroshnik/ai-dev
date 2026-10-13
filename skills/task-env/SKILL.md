---
name: task-env
description: "A task's environment on the machine — the machine's proxy (Traefik in Docker) gives containers of task stacks the addresses `http://<service>.<N>.<project>.localhost` by their labels, without host ports: different hosts — different cookies, parallel sessions don't log each other out. `task-env proxy up | down | status`; `check -g` names whether the proxy runs. When — `check -g` or the session start says the proxy isn't running; an address `*.localhost` of a task doesn't open (404, connection refused); you add Traefik labels to a container or write a task stack's override; port 80 is busy; asked how task addresses work, whether Secure cookies work over http://*.localhost, how to reach them from the Claude Code sandbox — even if the word 'proxy' wasn't said."
allowed-tools: Bash(bun *skills/task-env/scripts/task-env.ts *)
---

# task-env — a task's environment: addresses `*.localhost` through one proxy

Parallel sessions of one project run their apps at once. On `localhost` with
different ports they share cookies — cookies don't tell ports apart — and an
agent's browser and the owner's log each other out. A host per app solves it:
`*.localhost` resolves to the loopback and is a secure context in browsers,
and a different host has its own cookies. One proxy per machine — Traefik in
Docker — routes these hosts to the containers of task stacks by their labels:
no host port per app, no port search. The scheme and the reasons — epic
"Environment" in ai-dev (`tests/capabilities/task-env/task-env.md`).

```bash
bun <skill dir>/scripts/task-env.ts proxy up       # start it (or bring it to the compose file), wait until healthy
bun <skill dir>/scripts/task-env.ts proxy status   # 0 — running, 1 — not running (the start command), 2 — no Docker
bun <skill dir>/scripts/task-env.ts proxy down     # stop and remove it with its network
```

The skill's `check -g` line: `proxy *.localhost: running (ai-dev-proxy)`,
`not running — start: …` or `Docker unavailable — <reason>`; no Docker on the
machine — no line. It doesn't change the code of `check`: the proxy isn't the
flow falling behind.

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
them:

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
  the task stack.

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

## Docker and the sandbox

Docker doesn't work inside the Claude Code sandbox: the sandbox denies its
socket. The owner takes Docker and this script out of it in
`~/.claude/settings.json` — `sandbox.excludedCommands`, entries in the
`Bash(...)` rule syntax, matched against the whole command text:

```json
{ "sandbox": { "excludedCommands": ["docker compose *", "docker ps *", "bun ~/.agents/skills/task-env/scripts/task-env.ts *"] } }
```

A command outside the sandbox goes through the regular permissions, and
access to Docker is access to the whole machine. Without the exclusion —
`proxy status` exits with code 2 and names the sandbox.
