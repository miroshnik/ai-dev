#!/usr/bin/env bun
/**
 * task-env — a task's environment (the task-env skill): the task's stack is the Docker Compose project `<project>-<N>`;
 * the machine's proxy — one Traefik per machine — gives containers of task stacks the addresses
 * `http://<service>.<N>.<project>.localhost` by their labels, without ports on the host (tests/capabilities/task-env).
 *
 * `up` brings the task's stack up: the number from the branch `<type>/<N>-slug`, the Compose project `<project>-<N>`
 * (without a number — `<project>`), the project's compose files plus the task's override on Compose's stdin — the
 * proxy's labels and network for the HTTP services of `env.http` in `.agents/ai-dev.json`; it prints the addresses.
 * `e2e` brings `<project>-<N>-e2e` up anew with clean volumes and runs the command on the host with the e2e addresses
 * in `TASK_ENV_*` variables; `down` takes both stacks of a task down with their volumes — `task close` calls it; `prune`
 * takes down the stacks of the project's closed tasks left on the machine — orphans, the task's state by GitHub. A stack
 * that didn't come up — each failed service with its state and the end of its log.
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
 * Docker runs outside the Claude Code sandbox (the sandbox denies its socket): the agent runs this script as an
 * unsandboxed call — an `excludedCommands` entry for it doesn't take it out (SKILL.md, «Docker and the sandbox»).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: task-env up [--profile <p>]... | e2e [--profile <p>]... [-- <command>...] | down [<N>] | prune
       task-env proxy <up | down | status> | check [<dir>]

  task-env up             bring the task's stack up — the Compose project <project>-<N> by the branch <type>/<N>-slug,
                          <project> without a number — and print its addresses: env.http services of
                          .agents/ai-dev.json through the proxy, published ports on 127.0.0.1; --profile — Compose
                          profiles; 0 — up, 1 — a service failed (its state and log), 2 — not tried
  task-env e2e            the e2e stack <project>-<N>-e2e anew with clean volumes, then the command with its addresses
                          in TASK_ENV_PROJECT, TASK_ENV_<SERVICE>_URL, TASK_ENV_<SERVICE>_<PORT>; the exit code is the
                          command's; the stack stays until the next run
  task-env down [<N>]     take the stacks of task N (default — the branch's) down with their volumes: dev and e2e; a line
                          per stack: + down, ○ none, ! not removed (code 2); no compose file in the checkout — nothing to
                          take down, Docker isn't called; task close of the github skill calls it
  task-env prune          take down the stacks of the project's closed tasks left on the machine (orphans) with their
                          volumes: the task's state — by GitHub (gh); stacks of open tasks, of the main checkout, of
                          numbers that aren't tasks and of another repository with the same name — left

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
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(reason)) return " — Docker isn't running: start it (Docker Desktop on macOS)";
  if (/docker\.sock|not permitted|permission denied/i.test(reason)) return " — an agent's sandbox? Docker doesn't work in it: run this command outside the sandbox (SKILL.md, «Docker and the sandbox»)";
  if (/address pools/i.test(reason)) return " — Docker is out of network subnets: take down stacks nobody needs or widen default-address-pools (SKILL.md, «Network subnets»)";
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

// ----------------------------------------------------------------------------
// The task's stack — up, e2e, down
// ----------------------------------------------------------------------------

// canon task types — a copy of EST_TYPES and BRANCH_CONV_RE from skills/est/scripts/est.ts (and in skills/github/scripts/github.ts):
// there's no shared module (a skill is installed alone), the tests/standards/task-branch standard keeps the parsing identical
const TASK_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"];
const TASK_BRANCH_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + TASK_TYPES.join("|") + ")/(\\d{1,6})-", "iu");

/** A task branch by the canon — `[<area>/]<type>/<N>-<slug>`: the type (lowercased) and the number, otherwise null. */
export function taskBranch(branch: string): { type: string; issue: number } | null {
  const m = TASK_BRANCH_RE.exec(branch);
  return m ? { type: m[1]!.toLowerCase(), issue: parseInt(m[2]!, 10) } : null;
}

/**
 * Override files Compose takes next to the compose file by itself, in its order (checked on Compose 5.6). With
 * explicit `-f` it takes none — the script passes the project's one along with the task's override.
 */
const OVERRIDE_FILES = ["compose.override.yml", "compose.override.yaml", "docker-compose.override.yml", "docker-compose.override.yaml"];
/** `docker compose up` output with an image build can be long; the default buffer would cut the run. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** How long `up --wait` waits for healthchecks: a service that isn't healthy by then failed. */
const WAIT_TIMEOUT = "300";
/** Log lines of a failed service the report shows. */
const LOG_TAIL = "20";

/** A DNS label and a Compose project name at once: lowercase letters, digits and `-`. */
const dnsLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

/**
 * `<project>` of stacks and addresses: the repository of `origin` (the last part of its URL without `.git`), without a
 * remote — the main checkout's directory. Not the directory Compose takes by default: a worktree's is random
 * (`session-379-…`), and stacks of one project would get different names (#393, question 6).
 */
export function projectName(root: string): string {
  const url = git(root, "remote", "get-url", "origin").replace(/\/+$/, "");
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const name = url ? url.split(/[/:]/).at(-1)!.replace(/\.git$/, "") : common ? path.basename(path.dirname(common)) : path.basename(root);
  return dnsLabel(name) || "project";
}

export interface Stack {
  /** The Compose project: `<project>-<N>`, `<project>-<N>-e2e`, `<project>` without a task. */
  name: string;
  /** A service's address host: `<service>.<N>.<project>.localhost`, e2e — `<service>.e2e.<N>.<project>.localhost`. */
  host: (service: string) => string;
}

/** The stack of task `task` of `project`; without a task — the main checkout's. */
export function stackOf(project: string, task: number | undefined, e2e = false): Stack {
  const n = task === undefined ? [] : [String(task)];
  const kind = e2e ? ["e2e"] : [];
  return { name: [project, ...n, ...kind].join("-"), host: (service) => [dnsLabel(service), ...kind, ...n, project, "localhost"].join(".") };
}

/** A service's address through the machine's proxy: its port is in the address when it isn't 80. */
const urlOf = (host: string, env: NodeJS.ProcessEnv) => `http://${host}${proxyPort(env) === "80" ? "" : `:${proxyPort(env)}`}`;

/** The variable of a service for the e2e command: `TASK_ENV_<SERVICE>_<suffix>` (#393, question 7). */
const varOf = (service: string, suffix: string | number) => `TASK_ENV_${service.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;

/**
 * HTTP services of the project's stack and their ports inside the container — `env.http` of `.agents/ai-dev.json`
 * (#393, question 4): in a compose file a database's port doesn't differ from an app's. No file or no field — none;
 * a broken one — the reason.
 */
function httpServices(root: string): Record<string, number> | string {
  const file = path.join(root, ".agents/ai-dev.json");
  if (!existsSync(file)) return {};
  let http: unknown;
  try {
    http = (JSON.parse(readFileSync(file, "utf8")) as { env?: { http?: unknown } }).env?.http ?? {};
  } catch (e) {
    return `.agents/ai-dev.json: ${(e as Error).message}`;
  }
  const bad = `env.http of .agents/ai-dev.json: a service → its HTTP port in the container expected, like {"web": 3000}`;
  if (typeof http !== "object" || !http || Array.isArray(http)) return bad;
  const ports = http as Record<string, unknown>;
  return Object.values(ports).every((p) => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536) ? (ports as Record<string, number>) : bad;
}

/** Where the task's stack lives: the worktree's root, its compose files, the project's name, the task and HTTP services. */
interface Project {
  root: string;
  /** `-f` of the compose file and of the project's override file, if there is one. */
  files: string[];
  name: string;
  task: number | undefined;
  http: Record<string, number>;
}

function projectOf(cwd: string): Project | string {
  const root = git(cwd, "rev-parse", "--show-toplevel") || cwd;
  const file = COMPOSE_FILES.find((f) => existsSync(path.join(root, f)));
  if (!file) return `no compose file in ${root} (${COMPOSE_FILES.join(", ")}) — the task's stack is the project's Compose`;
  const extra = OVERRIDE_FILES.find((f) => existsSync(path.join(root, f)));
  const http = httpServices(root);
  if (typeof http === "string") return http;
  const files = [file, ...(extra ? [extra] : [])].flatMap((f) => ["-f", f]);
  return { root, files, name: projectName(root), task: taskBranch(git(root, "branch", "--show-current"))?.issue, http };
}

const dc = (args: string[], cwd: string, input?: string) => spawnSync("docker", ["compose", ...args], { cwd, input, encoding: "utf8", maxBuffer: MAX_BUFFER });

/**
 * The task stack's override — the only thing the script adds to the project's Compose: the proxy's labels and network
 * for HTTP services of the settings, nothing to the others (a database isn't published). A service's networks are its
 * own as Compose normalized them (one without `networks` is in `default`) plus the proxy's: listed networks replace
 * the implicit `default`, and a key with null merges with the project's keeping its aliases. The override goes to
 * Compose's stdin (`-f -`), not into a file: a `compose.override.yaml` would be the project's, and `check` would name
 * its external network. No HTTP service in the compose file — no override.
 */
function overrideOf(config: Config, http: Record<string, number>, stack: Stack, proxy: string): object | undefined {
  const services: Record<string, object> = {};
  for (const [service, port] of Object.entries(http)) {
    const s = config.services?.[service];
    if (!s) continue;
    const networks = Object.fromEntries([...Object.keys(s.networks ?? { default: null }), proxy].map((n) => [n, null]));
    services[service] = { networks, labels: proxyLabels({ stack: stack.name, service: dnsLabel(service), host: stack.host(service), port }) };
  }
  if (!Object.keys(services).length) return undefined;
  return { services, networks: { [proxy]: { external: true } } };
}

/** A container of `docker compose ps --format json`. */
interface Container {
  Name: string;
  Service: string;
  State: string;
  Health?: string;
  ExitCode?: number;
  Publishers?: { URL?: string; TargetPort: number; PublishedPort: number; Protocol?: string }[] | null;
}

/** Containers of a stack by its Compose project, from any directory — Compose finds them by labels; all — stopped too. */
function containers(stack: string, all = false): Container[] {
  const r = dc(["-p", stack, "ps", ...(all ? ["--all"] : []), "--format", "json"], "/");
  const out = r.status === 0 ? r.stdout.trim() : "";
  if (!out) return [];
  // Compose prints a container per line; before 2.21 — one JSON array
  return out.startsWith("[") ? (JSON.parse(out) as Container[]) : out.split("\n").map((l) => JSON.parse(l) as Container);
}

/** Did a container fail: not running, not healthy; a one-shot that exited with 0 did its job. */
const failed = (c: Container) => (c.State !== "running" && !(c.State === "exited" && c.ExitCode === 0)) || c.Health === "unhealthy" || c.Health === "starting";

/** The last healthcheck's output of a container: why it isn't healthy. */
function healthOf(container: string): string {
  const r = spawnSync("docker", ["inspect", "--format", "{{json .State.Health}}", container], { encoding: "utf8" });
  try {
    const last = (JSON.parse(r.stdout) as { Log?: { ExitCode: number; Output: string }[] }).Log?.at(-1);
    return last ? `exit ${last.ExitCode}${last.Output.trim() ? ` — ${last.Output.trim().split("\n").slice(-3).join(" ")}` : ""}` : "no result yet";
  } catch {
    return why(r);
  }
}

/**
 * A stack that didn't come up: each failed service — its state and the last lines of its log (#393, question 5); no
 * container failed (an image isn't pulled, a build broke) — Compose's own answer.
 */
function report(stack: string, r: ReturnType<typeof spawnSync>, env: NodeJS.ProcessEnv): string[] {
  const out = [`stack ${stack}: not up — ${why(r)}${hint(why(r), env)}`];
  for (const c of containers(stack, true).filter(failed)) {
    const state = [c.State === "exited" ? `exited (exit ${c.ExitCode})` : c.State, c.Health].filter(Boolean).join(", ");
    out.push(`✗ ${c.Service}: ${state}`);
    if (c.Health === "unhealthy") out.push(`    healthcheck: ${healthOf(c.Name)}`);
    const logs = dc(["-p", stack, "logs", "--no-color", "--no-log-prefix", "--tail", LOG_TAIL, c.Service], "/");
    for (const l of `${logs.stdout}${logs.stderr}`.trimEnd().split("\n").filter(Boolean)) out.push(`    | ${l}`);
  }
  // Compose's progress lines (a resource and its step) say nothing about the failure
  const progress = /^\s*(?:Network|Volume|Container|Image)\s+\S+\s+(?:Creat|Start|Wait|Pull|Build|Healthy|Running|Recreat)\w*\s*$/;
  if (out.length === 1) for (const l of `${r.stderr ?? ""}`.trimEnd().split("\n").filter((l) => l.trim() && !progress.test(l)).slice(-15)) out.push(`    | ${l}`);
  return out;
}

/** An address of a stack's service: a URL through the proxy or a published port on the loopback, with its variable. */
interface Address {
  service: string;
  value: string;
  name: string;
  note?: string;
}

/** Addresses of the running services: HTTP ones of the settings through the proxy, every published port on 127.0.0.1. */
function addressesOf(project: Project, stack: Stack, env: NodeJS.ProcessEnv): Address[] {
  const out: Address[] = [];
  const running = containers(stack.name).filter((c) => c.State === "running");
  for (const service of [...new Set(running.map((c) => c.Service))].sort()) {
    if (project.http[service]) out.push({ service, value: urlOf(stack.host(service), env), name: varOf(service, "URL") });
    const seen = new Set<string>();
    for (const p of running.find((c) => c.Service === service)!.Publishers ?? []) {
      const proto = p.Protocol && p.Protocol !== "tcp" ? `/${p.Protocol}` : "";
      if (!p.PublishedPort || seen.has(`${p.TargetPort}${proto}`)) continue;
      seen.add(`${p.TargetPort}${proto}`);
      const ip = !p.URL || p.URL === "0.0.0.0" || p.URL === "::" ? "127.0.0.1" : p.URL;
      out.push({ service, value: `${ip}:${p.PublishedPort}`, name: varOf(service, `${p.TargetPort}${proto ? `_${p.Protocol!.toUpperCase()}` : ""}`), note: `→ ${p.TargetPort}${proto}` });
    }
  }
  return out;
}

/**
 * Brings the stack up: the project's compose files plus the override, `up --wait` with a build — the stack runs the
 * worktree's code, not an image from another task's run. The proxy goes up first when the override joins its network
 * and it isn't running (#393, question 8); a running one isn't touched.
 */
function upStack(project: Project, stack: Stack, profiles: string[], env: NodeJS.ProcessEnv): { code: number; lines: string[] } {
  const config = dc([...project.files, "--profile", "*", "config", "--format", "json"], project.root);
  if (config.error || config.status !== 0) return { code: 2, lines: [`stack ${stack.name}: not started — docker compose config: ${why(config)}${hint(why(config), env)}`] };
  const parsed = JSON.parse(config.stdout) as Config;
  const lines = Object.keys(project.http)
    .filter((s) => !parsed.services?.[s])
    .map((s) => `! env.http: service ${s} isn't in the compose file — no address for it`);
  const override = overrideOf(parsed, project.http, stack, proxyName(env));
  if (override) {
    const running = proxyRunning(env);
    if (typeof running === "string") return { code: 2, lines: [...lines, `stack ${stack.name}: not started — Docker unavailable: ${running}${hint(running, env)}`] };
    if (!running) {
      const p = up(env);
      if (p.code) return { code: 2, lines: [...lines, p.out] };
    }
  }
  const args = ["-p", stack.name, ...project.files, ...(override ? ["-f", "-"] : []), ...profiles.flatMap((p) => ["--profile", p])];
  const r = dc([...args, "--progress", "plain", "up", "--detach", "--wait", "--wait-timeout", WAIT_TIMEOUT, "--build", "--remove-orphans", "--quiet-pull"], project.root, override ? JSON.stringify(override) : undefined);
  if (r.error || r.status !== 0) return { code: r.error ? 2 : 1, lines: [...lines, ...report(stack.name, r, env)] };
  return { code: 0, lines };
}

/**
 * Takes a stack down with its volumes — by the Compose project from `/`, without the compose file: it may be gone
 * already (`task close` after the worktree), and a compose file found by Compose would hide services of other profiles.
 * Compose finds the stack's containers, networks and volumes by their labels — a stack left with volumes only too.
 */
function downStack(stack: string, env: NodeJS.ProcessEnv): { ok: boolean; line: string } {
  const r = dc(["-p", stack, "down", "--volumes", "--remove-orphans"], "/");
  const ok = !r.error && r.status === 0;
  return { ok, line: ok ? `+ stack ${stack}: down, with its volumes` : `! stack ${stack}: not removed — ${why(r)}${hint(why(r), env)}` };
}

/** The label Compose marks a stack's containers, volumes and networks with: the Compose project. */
const PROJECT_LABEL = "com.docker.compose.project";
/** Compose projects on the machine → the directories of their containers; no docker — missing, Docker unavailable — the reason. */
type Machine = Map<string, Set<string>> | { missing: true } | string;

/**
 * Stacks on the machine — by the label of containers, volumes and networks, not `docker compose ls`: a stack whose
 * containers are gone but volumes stay (`down` without `-v`, containers removed by hand) isn't in its list (#395,
 * question 2). A container's directory (`working_dir` — where Compose ran) tells a stack of another repository with the
 * same name (`prune`).
 */
function machineStacks(env: NodeJS.ProcessEnv): Machine {
  const stacks = new Map<string, Set<string>>();
  for (const list of [["ps", "--all"], ["volume", "ls"], ["network", "ls"]]) {
    const format = list[0] === "ps" ? `{{.Label "${PROJECT_LABEL}"}}\t{{.Label "${PROJECT_LABEL}.working_dir"}}` : `{{.Label "${PROJECT_LABEL}"}}`;
    const r = spawnSync("docker", [...list, "--filter", `label=${PROJECT_LABEL}`, "--format", format], { encoding: "utf8", env, timeout: CONFIG_TIMEOUT });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { missing: true };
    if (r.error || r.status !== 0) return why(r);
    for (const line of r.stdout.split("\n")) {
      const [name, dir] = line.split("\t");
      if (!name?.trim()) continue;
      const dirs = stacks.get(name.trim()) ?? new Set<string>();
      if (dir?.trim()) dirs.add(dir.trim());
      stacks.set(name.trim(), dirs);
    }
  }
  return stacks;
}

/** Address lines: the service column aligned; withVar — the variable the e2e command gets it in. */
function shown(addresses: Address[], withVar: boolean): string[] {
  const width = Math.max(0, ...addresses.map((a) => a.service.length));
  return addresses.map((a) => `  ${a.service.padEnd(width)}  ${a.value}${a.note ? ` ${a.note}` : ""}${withVar ? `  ${a.name}` : ""}`);
}

/** `up`: the dev stack of the branch's task (without one — the main checkout's) and its addresses. */
function stackUp(project: Project, profiles: string[], env: NodeJS.ProcessEnv): number {
  const stack = stackOf(project.name, project.task);
  const r = upStack(project, stack, profiles, env);
  if (r.code) return console.log(r.lines.join("\n")), r.code;
  const addresses = addressesOf(project, stack, env);
  console.log([...r.lines, `stack ${stack.name}: up${addresses.length ? "" : " — no HTTP service in env.http and no published port"}`, ...shown(addresses, false)].join("\n"));
  console.log(`logs: docker compose -p ${stack.name} logs <service>; down: bun ${fileURLToPath(import.meta.url)} down${project.task === undefined ? "" : ` ${project.task}`}`);
  return 0;
}

/**
 * `e2e`: the task's e2e stack anew — with clean volumes, apart from the dev stack — then the run command on the host
 * with the e2e addresses in variables; the exit code is the command's. The stack stays until the next run: a failed
 * run is examined on it.
 */
function stackE2e(project: Project, profiles: string[], command: string[], env: NodeJS.ProcessEnv): number {
  const stack = stackOf(project.name, project.task, true);
  const clean = downStack(stack.name, env);
  if (!clean.ok) return console.log(clean.line), 2;
  const r = upStack(project, stack, profiles, env);
  if (r.code) return console.log(r.lines.join("\n")), r.code;
  const addresses = addressesOf(project, stack, env);
  console.log([...r.lines, `stack ${stack.name}: up, clean volumes — TASK_ENV_PROJECT=${stack.name}`, ...shown(addresses, true)].join("\n"));
  if (!command.length) return 0;
  const vars = Object.fromEntries([["TASK_ENV_PROJECT", stack.name], ...addresses.map((a) => [a.name, a.value])]);
  const run = spawnSync(command[0]!, command.slice(1), { stdio: "inherit", env: { ...env, ...vars } });
  if (run.error) return console.log(`e2e: ${command[0]} not started — ${run.error.message}`), 2;
  return run.status ?? 1;
}

/**
 * `down`: the task's stacks — dev and e2e — with their volumes, those that are on the machine; stacks of other tasks
 * aren't touched. A checkout without a compose file has no task stacks: Docker isn't called — `task close` of every
 * project calls `down`, and with Docker stopped a project without Compose would get a `!` line (#395, question 4).
 */
function stackDown(root: string, task: number | undefined, env: NodeJS.ProcessEnv): number {
  if (!COMPOSE_FILES.some((f) => existsSync(path.join(root, f)))) return console.log(`○ no compose file in ${root} — the project has no task stacks`), 0;
  const name = projectName(root);
  const stacks = [stackOf(name, task), stackOf(name, task, true)].map((s) => s.name);
  const machine = machineStacks(env);
  if (typeof machine === "string") return console.log(`! stacks ${stacks.join(", ")}: not removed — Docker unavailable: ${machine}${hint(machine, env)}`), 2;
  if (!(machine instanceof Map)) return console.log("○ no Docker on the machine — no task stacks"), 0;
  const present = stacks.filter((s) => machine.has(s));
  if (!present.length) return console.log(`○ stacks ${stacks.join(", ")}: none on the machine`), 0;
  const done = present.map((s) => downStack(s, env));
  console.log(done.map((d) => d.line).join("\n"));
  return done.every((d) => d.ok) ? 0 : 2;
}

/** `owner/name` of the checkout's GitHub origin; another host or no remote — undefined. */
function githubRepo(root: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(git(root, "remote", "get-url", "origin"));
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** A task's state on GitHub (`gh api`): open, closed, missing — no such issue (a PR isn't a task); otherwise why not known. */
function taskState(repo: string, n: number, env: NodeJS.ProcessEnv): "open" | "closed" | "missing" | { error: string } {
  const r = spawnSync("gh", ["api", `repos/${repo}/issues/${n}`], { encoding: "utf8", env, timeout: 30_000 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { error: "gh not found — prune checks tasks on GitHub with the gh CLI" };
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return /HTTP 404|Not Found/i.test(r.stderr) ? "missing" : { error: r.stderr.trim().split("\n").at(-1) || `gh: code ${r.status}` };
  try {
    const issue = JSON.parse(r.stdout) as { state?: string; pull_request?: unknown };
    if (issue.pull_request) return "missing";
    return issue.state === "closed" ? "closed" : issue.state === "open" ? "open" : { error: `gh: state ${issue.state}` };
  } catch {
    return { error: "gh printed no JSON" };
  }
}

/**
 * `prune`: stacks of the project's closed tasks left on the machine — orphans: a task closed without `task close`, a
 * close that couldn't reach Docker, a task that removed the compose file. The stacks `<project>-<N>` and
 * `<project>-<N>-e2e` of the machine (containers, volumes and networks, #395, question 2); the task's state — by GitHub:
 * closed — the stacks go with their volumes; open, not an issue, not checked — left. A stack whose containers ran in an
 * existing directory of another project — another repository with the same name (`shop-2` at the project `shop`) —
 * left (#395, question 3). Without confirmation: a closed task's stack is nobody's (#395, question 1).
 */
function prune(root: string, env: NodeJS.ProcessEnv): number {
  const name = projectName(root);
  const machine = machineStacks(env);
  if (typeof machine === "string") return console.log(`! prune: Docker unavailable — ${machine}${hint(machine, env)}`), 2;
  if (!(machine instanceof Map)) return console.log("○ no Docker on the machine — no task stacks"), 0;
  const re = new RegExp(`^${name}-(\\d+)(-e2e)?$`);
  const found = [...machine.keys()]
    .map((stack) => ({ stack, m: re.exec(stack) }))
    .filter((x) => x.m)
    .map(({ stack, m }) => ({ stack, task: Number(m![1]), e2e: !!m![2] }))
    .sort((a, b) => a.task - b.task || Number(a.e2e) - Number(b.e2e));
  if (!found.length) return console.log(`○ no stacks of ${name} tasks on the machine`), 0;
  const repo = githubRepo(root);
  if (!repo) return console.log(`! prune: the origin of ${root} isn't a GitHub repository — task states can't be checked; left: ${found.map((f) => f.stack).join(", ")}`), 2;
  const states = new Map<number, ReturnType<typeof taskState>>();
  let ok = true;
  for (const { stack, task } of found) {
    const other = [...machine.get(stack)!].find((dir) => existsSync(dir) && projectName(dir) !== name);
    if (other) {
      console.log(`○ stack ${stack}: its containers are from ${other} — another project, left`);
      continue;
    }
    if (!states.has(task)) states.set(task, taskState(repo, task, env));
    const state = states.get(task)!;
    if (state === "closed") {
      const d = downStack(stack, env);
      console.log(d.ok ? `${d.line} — task #${task} is closed` : d.line);
      ok &&= d.ok;
    } else if (state === "open") console.log(`○ stack ${stack}: task #${task} is open — left`);
    else if (state === "missing") console.log(`○ stack ${stack}: no task #${task} in ${repo} — left`);
    else {
      console.log(`! stack ${stack}: task #${task} not checked — ${state.error}; left`);
      ok = false;
    }
  }
  return ok ? 0 : 2;
}

/** `--profile <name>` options of `up` and `e2e` before the command: the profiles and what follows them. */
function profilesOf(args: string[]): { profiles: string[]; rest: string[] } | undefined {
  const profiles: string[] = [];
  let i = 0;
  for (; i < args.length && args[i] !== "--"; i++) {
    if (args[i] !== "--profile" || !args[i + 1]) return undefined;
    profiles.push(args[++i]!);
  }
  return { profiles, rest: args.slice(i + 1) };
}

/** The stack commands: undefined — not one of them or wrong arguments. */
function stackCommand(group: string, args: string[], env: NodeJS.ProcessEnv): number | undefined {
  if (group !== "up" && group !== "e2e" && group !== "down" && group !== "prune") return undefined;
  if (group === "down" || group === "prune") {
    if (group === "prune" ? args.length : args.length > 1 || (args[0] && !/^\d+$/.test(args[0]))) return undefined;
    // the stacks are found by the Compose project: the task's worktree may be gone already
    const root = git(process.cwd(), "rev-parse", "--show-toplevel") || process.cwd();
    if (group === "prune") return prune(root, env);
    return stackDown(root, args[0] ? Number(args[0]) : taskBranch(git(root, "branch", "--show-current"))?.issue, env);
  }
  const opts = profilesOf(args);
  if (!opts || (group === "up" && opts.rest.length)) return undefined;
  const project = projectOf(process.cwd());
  if (typeof project === "string") return console.log(`task-env ${group}: ${project}`), 2;
  return group === "up" ? stackUp(project, opts.profiles, env) : stackE2e(project, opts.profiles, opts.rest, env);
}

const COMMANDS: Record<string, (env: NodeJS.ProcessEnv) => Result> = { up, down, status };

function main(argv: string[]): number {
  const [group, cmd = "", ...rest] = argv;
  if (group === "check" && !rest.length && !cmd.startsWith("-")) return check(path.resolve(cmd || "."));
  const stack = group ? stackCommand(group, argv.slice(1), process.env) : undefined;
  if (stack !== undefined) return stack;
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
