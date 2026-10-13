#!/usr/bin/env bun
/**
 * task-env — a task's environment (the task-env skill). Here — the machine's proxy: one Traefik per machine gives
 * containers of task stacks the addresses `http://<service>.<N>.<project>.localhost` by their labels, without ports on
 * the host (tests/capabilities/task-env).
 *
 * The proxy is the Compose project of `proxy/compose.yaml` next to this directory: the Docker provider with
 * `exposedByDefault: false` (a container without labels isn't published), its own network, the `web` entry point on
 * port 80 of 127.0.0.1, `restart: unless-stopped` (it comes back with Docker). A container leaves the routes when it
 * stops: Traefik follows Docker events. A task stack joins the proxy network as `external` — the proxy creates it, so
 * it goes up before the stack.
 *
 * The name (Compose project and network) and the port come from AI_DEV_PROXY and AI_DEV_PROXY_PORT, by default
 * `ai-dev-proxy` and 80: a test runs its own proxy next to the machine's one, a machine with port 80 busy takes
 * another. The same name is in `name:` of the compose file and in `proxyLines` of bin/ai-dev.mjs (`check -g`): a
 * change goes into all three.
 *
 * Docker runs outside the Claude Code sandbox (the sandbox denies its socket): the owner puts this script's command
 * and `docker compose` into `sandbox.excludedCommands` (SKILL.md).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: task-env proxy <up | down | status>

  task-env proxy up       start the machine's proxy (Traefik) or bring it to the skill's compose file and wait
                          until it is healthy; port 80 busy — AI_DEV_PROXY_PORT
  task-env proxy down     stop and remove the proxy and its network
  task-env proxy status   running — code 0, not running — 1 with the start command, Docker unavailable — 2
`;

/** The proxy's compose file: the skill directory's `proxy/compose.yaml`. */
export const PROXY_FILE = fileURLToPath(new URL("../proxy/compose.yaml", import.meta.url));
/** The proxy's Compose service — the Traefik container. */
const SERVICE = "traefik";
/** The entry point routers of task stacks attach to: HTTP on the proxy's port. */
export const ENTRY_POINT = "web";

/** The proxy's name — its Compose project and network; the same expression as in the compose file and `check -g`. */
export const proxyName = (env: NodeJS.ProcessEnv = process.env) => env.AI_DEV_PROXY || "ai-dev-proxy";

/** The proxy's port on 127.0.0.1. */
export const proxyPort = (env: NodeJS.ProcessEnv = process.env) => env.AI_DEV_PROXY_PORT || "80";

/** The command that starts the proxy — as the output names it. */
const START = `bun ${fileURLToPath(import.meta.url)} proxy up`;

export interface ProxyRoute {
  /** The Compose project of the stack: `<project>-<N>`, `<project>-<N>-e2e`, `<project>` without a task. */
  stack: string;
  /** The Compose service. */
  service: string;
  /** The address host: `<service>.<N>.<project>.localhost`. */
  host: string;
  /** The service's HTTP port inside the container. */
  port: number;
}

/**
 * Traefik labels for an HTTP service of a task stack: a router by host on the `web` entry point and a service to the
 * container's port. The router and the service are named `<stack>-<service>`: unique on the machine, and replicas of
 * one service (`--scale`) carry the same labels — Traefik balances between them. The network for reaching the
 * container is set by the proxy itself (`providers.docker.network`), not by a label.
 */
export function proxyLabels(r: ProxyRoute): Record<string, string> {
  const id = `${r.stack}-${r.service}`;
  return {
    "traefik.enable": "true",
    [`traefik.http.routers.${id}.rule`]: `Host(\`${r.host}\`)`,
    [`traefik.http.routers.${id}.entrypoints`]: ENTRY_POINT,
    [`traefik.http.routers.${id}.service`]: id,
    [`traefik.http.services.${id}.loadbalancer.server.port`]: String(r.port),
  };
}

interface Result {
  code: number;
  out: string;
}

/** The first line of a failed docker's output, or the launch error. */
function why(r: ReturnType<typeof spawnSync>) {
  if (r.error) return (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "docker not found — task-env needs Docker (Docker Desktop on macOS)" : r.error.message;
  const text = `${r.stderr ?? ""}`.trim() || `${r.stdout ?? ""}`.trim();
  const lines = text.split("\n").filter((l) => /error|cannot|denied|failed|not permitted/i.test(l));
  return (lines.at(-1) ?? text.split("\n").at(-1) ?? `docker: code ${r.status}`).trim();
}

/** A hint for a docker failure: what to do about it. */
function hint(reason: string, env: NodeJS.ProcessEnv) {
  if (/already allocated|address already in use|bind/i.test(reason)) return ` — port 127.0.0.1:${proxyPort(env)} is busy: free it or set AI_DEV_PROXY_PORT (the addresses then carry the port)`;
  if (/docker\.sock|not permitted|permission denied/i.test(reason)) return " — an agent's sandbox? Docker runs outside it: sandbox.excludedCommands (SKILL.md)";
  return "";
}

const compose = (args: string[], env: NodeJS.ProcessEnv) => spawnSync("docker", ["compose", "-f", PROXY_FILE, ...args], { encoding: "utf8", env });

/** Whether the proxy container runs: true / false; Docker unavailable — the reason. */
export function proxyRunning(env: NodeJS.ProcessEnv = process.env): boolean | string {
  const filters = ["--filter", `label=com.docker.compose.project=${proxyName(env)}`, "--filter", `label=com.docker.compose.service=${SERVICE}`];
  const r = spawnSync("docker", ["ps", "--all", ...filters, "--format", "{{.State}}"], { encoding: "utf8", env, timeout: 10_000 });
  if (r.error || r.status !== 0) return why(r);
  return r.stdout.split("\n").includes("running");
}

function status(env: NodeJS.ProcessEnv): Result {
  const running = proxyRunning(env);
  const name = proxyName(env);
  if (typeof running === "string") return { code: 2, out: `proxy ${name}: Docker unavailable — ${running}${hint(running, env)}` };
  if (!running) return { code: 1, out: `proxy ${name}: not running — start: ${START}` };
  return { code: 0, out: `proxy ${name}: running — http://<service>.<N>.<project>.localhost${proxyPort(env) === "80" ? "" : `:${proxyPort(env)}`} on 127.0.0.1, routes by container labels (network ${name})` };
}

function up(env: NodeJS.ProcessEnv): Result {
  const r = compose(["up", "--detach", "--wait", "--quiet-pull"], env);
  if (r.error || r.status !== 0) {
    const reason = why(r);
    return { code: 2, out: `proxy ${proxyName(env)}: not started — ${reason}${hint(reason, env)}` };
  }
  return status(env);
}

function down(env: NodeJS.ProcessEnv): Result {
  const r = compose(["down"], env);
  if (r.error || r.status !== 0) {
    const reason = why(r);
    const attached = /active endpoints/i.test(reason) ? " — task stacks are still in its network: take them down first" : hint(reason, env);
    return { code: 2, out: `proxy ${proxyName(env)}: not removed — ${reason}${attached}` };
  }
  return { code: 0, out: `proxy ${proxyName(env)}: removed` };
}

const COMMANDS: Record<string, (env: NodeJS.ProcessEnv) => Result> = { up, down, status };

function main(argv: string[]): number {
  const [group, cmd = "", ...rest] = argv;
  const fn = group === "proxy" && !rest.length ? COMMANDS[cmd] : undefined;
  if (!fn) {
    process.stderr.write(USAGE);
    return group === "help" || group === "--help" || group === "-h" ? 0 : 2;
  }
  const r = fn(process.env);
  (r.code === 2 ? process.stderr : process.stdout).write(r.out + "\n");
  return r.code;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
