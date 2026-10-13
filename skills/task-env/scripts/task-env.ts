#!/usr/bin/env bun
/**
 * task-env — a task's environment (the task-env skill): the task's stack is the Docker Compose project `<project>-<N>`;
 * the machine's proxy — one Traefik per machine — gives containers of task stacks the addresses
 * `http://<service>.<N>.<project>.localhost` by their labels, without ports on the host (tests/capabilities/task-env).
 *
 * `check` holds the project's compose file to the isolation rules: Compose keeps two stacks of one project apart by the
 * project name — containers, volumes and networks get its prefix — and four entries bypass the prefix and break
 * isolation silently: `container_name`, a fixed host port, a volume or a network with `name:` or `external`, an
 * absolute path to code in `volumes` and `build`. It reads not the YAML but `docker compose config --format json`:
 * Compose has already brought the forms of writing (short and long syntax, the override file, variables, `extends`) to
 * one. Without path resolution — otherwise Compose makes relative paths absolute itself; with all profiles — otherwise
 * heavy services in `profiles` aren't shown. `config` needs no Docker daemon, it works in the sandbox too. `check` of
 * the ai-dev installer calls it for a project with a compose file.
 *
 * The proxy is the Compose project of `proxy/compose.yaml` next to this directory: the Docker provider with
 * `exposedByDefault: false` (a container without labels isn't published), its own network, the `web` entry point on
 * port 80 of 127.0.0.1, `restart: unless-stopped` (it comes back with Docker). A container leaves the routes when it
 * stops: Traefik follows Docker events. A task stack joins the proxy network as `external` — the proxy creates it, so
 * it goes up before the stack.
 *
 * The name (Compose project and network) and the port come from AI_DEV_PROXY and AI_DEV_PROXY_PORT, by default
 * `ai-dev-proxy` and 80: a test runs its own proxy next to the machine's one, a machine with port 80 busy takes
 * another. The default name is also the default of `${AI_DEV_PROXY:-…}` in the compose file and a copy in
 * bin/ai-dev.mjs (`check -g`) — tests/standards/installer-mirror holds them to `PROXY`.
 *
 * Docker runs outside the Claude Code sandbox (the sandbox denies its socket): the owner puts this script's command
 * and `docker compose` into `sandbox.excludedCommands` (SKILL.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: task-env proxy <up | down | status> | check [<dir>]

  task-env check [<dir>]  holds the compose file in <dir> (default — the current directory) to the task isolation
                          rules: no container_name, no fixed host port, volumes and networks without name and
                          external, code by paths relative to the compose file; one ❌ line per violation; 0 — the
                          rules hold or there is no compose file, 1 — violations, 2 — not checked (no docker compose,
                          the config doesn't parse)
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

/**
 * The proxy's default name. The installer under Node holds a copy (tests/standards/installer-mirror), a script under
 * Bun imports it.
 */
export const PROXY = "ai-dev-proxy";

/** The proxy's name — its Compose project and network; the same expression as in the compose file and `check -g`. */
export const proxyName = (env: NodeJS.ProcessEnv = process.env) => env.AI_DEV_PROXY || PROXY;

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

// ----------------------------------------------------------------------------
// check — the compose file isolation rules
// ----------------------------------------------------------------------------

/**
 * Compose files Docker Compose looks for, in its order. The installer holds a copy — `check` doesn't start bun in a
 * project without a compose file; tests/standards/installer-mirror holds the copy to this list.
 */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/**
 * Sources of a bind mount that are the machine's resources, not code — the Docker socket, `/etc/localtime`, devices:
 * they don't tie a stack to a checkout (#398, question 3).
 */
const MACHINE = /^\/(?:var\/run|run|etc|dev|proc|sys)(?:\/|$)/;
/** `docker compose config` reads a few files — longer than this is a hang, not work. */
const CONFIG_TIMEOUT = 20_000;

interface Port {
  target: number;
  published?: string;
  host_ip?: string;
  protocol?: string;
}
interface Mount {
  type: string;
  source?: string;
}
interface Service {
  container_name?: string;
  ports?: Port[];
  volumes?: Mount[];
  build?: { context?: string; dockerfile?: string };
  networks?: Record<string, unknown>;
}
interface Resource {
  name?: string;
  external?: boolean;
}
/** The part of the normalized `docker compose config --format json` the rules read. */
interface Config {
  name: string;
  services?: Record<string, Service>;
  volumes?: Record<string, Resource>;
  networks?: Record<string, Resource>;
}

const absolute = (p: string) => p.startsWith("/") || p === "~" || p.startsWith("~/");
const list = (names: string[]) => `${names.length === 1 ? "service" : "services"} ${names.join(", ")}`;

/** Violations of the isolation rules, one line each: services, then volumes, then networks; Compose sorts the keys. */
function violations(config: Config, file: string): string[] {
  const out: string[] = [];
  const line = (subject: string, what: string) => out.push(`❌ ${file}: ${subject} — ${what}`);
  const services = Object.entries(config.services ?? {});
  for (const [name, s] of services) {
    const subject = `service ${name}`;
    if (s.container_name) line(subject, `container_name ${s.container_name}: a second task stack can't start; remove it, Compose names containers by the project`);
    for (const p of s.ports ?? []) {
      if (!p.published) continue;
      const proto = p.protocol && p.protocol !== "tcp" ? `/${p.protocol}` : "";
      const host = p.host_ip ? `${p.host_ip}:` : "";
      line(subject, `fixed host port ${host}${p.published}:${p.target}${proto}: two task stacks contend for it; publish 127.0.0.1::${p.target}${proto} or drop ports`);
    }
    // a URL context (a git repository) isn't absolute either: it starts neither with / nor with ~
    for (const [field, p] of [["context", s.build?.context], ["dockerfile", s.build?.dockerfile]] as const) {
      if (p && absolute(p)) line(subject, `build ${field}: absolute path ${p}: builds code outside the task's worktree; use a path relative to the compose file`);
    }
    for (const v of s.volumes ?? []) {
      if (v.type === "bind" && v.source && absolute(v.source) && !MACHINE.test(v.source)) {
        line(subject, `volumes: absolute path ${v.source}: mounts code outside the task's worktree; use a path relative to the compose file`);
      }
    }
  }
  const shared = (kind: "volume" | "network", key: string, r: Resource, users: string[], why: string) => {
    const subject = `${kind} ${key} (${list(users)})`;
    if (r.external) line(subject, `external: ${why}; drop external`);
    else if (r.name && r.name !== `${config.name}_${key}`) line(subject, `name ${r.name}: ${why}; remove name, Compose prefixes it by the project`);
  };
  for (const [key, r] of Object.entries(config.volumes ?? {})) {
    const users = services.filter(([, s]) => (s.volumes ?? []).some((v) => v.type === "volume" && v.source === key)).map(([n]) => n);
    shared("volume", key, r, users, "task stacks share it, down -v of one wipes another's data");
  }
  for (const [key, r] of Object.entries(config.networks ?? {})) {
    const users = services.filter(([, s]) => Object.hasOwn(s.networks ?? {}, key)).map(([n]) => n);
    shared("network", key, r, users, "task stacks share it and reach each other's services");
  }
  return out;
}

/** `check`: the exit code; all lines go to stdout — `check` of the installer reads them from there. */
function check(dir: string): number {
  const file = COMPOSE_FILES.find((f) => existsSync(path.join(dir, f)));
  if (!file) return console.log(`no compose file in ${dir} — nothing to check`), 0;
  const notChecked = (why: string) => (console.log(`○ ${file}: not checked — ${why}`), 2);
  const r = spawnSync("docker", ["compose", "--profile", "*", "config", "--no-path-resolution", "--format", "json"], { cwd: dir, encoding: "utf8", timeout: CONFIG_TIMEOUT });
  const error = r.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") return notChecked("docker not found");
  if (error) return notChecked(`docker compose config: ${error.message}`);
  if (r.status !== 0) return notChecked(`docker compose config: ${r.stderr.trim().split("\n")[0] || `exit code ${r.status}`}`);
  let config: Config;
  try {
    config = JSON.parse(r.stdout) as Config;
  } catch {
    return notChecked("docker compose config printed no JSON");
  }
  const lines = violations(config, file);
  if (!lines.length) return console.log(`${file}: the task isolation rules hold`), 0;
  console.log(lines.join("\n"));
  return 1;
}

const COMMANDS: Record<string, (env: NodeJS.ProcessEnv) => Result> = { up, down, status };

function main(argv: string[]): number {
  const [group, cmd = "", ...rest] = argv;
  if (group === "check" && !rest.length && !cmd.startsWith("-")) return check(path.resolve(cmd || "."));
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
