import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { proxyLabels } from "../../../skills/task-env/scripts/task-env.ts";
import { aiDev, sandbox, type Sandbox } from "../../lib/ai-dev.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SCRIPT = fileURLToPath(new URL("../../../skills/task-env/scripts/task-env.ts", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../../../skills/task-env/proxy/compose.yaml", import.meta.url));
/** Приложение в контейнере: отвечает своим Hostname — id контейнера, — по нему видно, кто ответил. */
const WHOAMI = "traefik/whoami:v1.12.0";
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;

/** Имя прокси по умолчанию — из compose-файла скилла: `name: ${AI_DEV_PROXY:-<имя>}`. */
const DEFAULT_NAME = /^name: \$\{AI_DEV_PROXY:-([a-z0-9_-]+)\}$/m.exec(readFileSync(COMPOSE, "utf8"))?.[1];

/** Docker отвечает — сценарии с настоящим прокси идут; в CI без Docker они падают, а не пропускаются. */
const dockerUp = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 }).status === 0;

/**
 * Свой прокси теста рядом с рабочим: своё имя (проект Compose и сеть) и порт, который выдаёт Docker, — рабочий прокси
 * машины на 80 тест не трогает.
 */
const NAME = `ai-dev-proxy-test-${process.pid}`;
const proxyEnv = { ...process.env, AI_DEV_PROXY: NAME, AI_DEV_PROXY_PORT: "0" };

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  if (r.error) throw r.error;
  return r;
}

/** `docker …`, ошибка — с её stderr. */
function docker(...args: string[]) {
  const r = run("docker", args, proxyEnv);
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const proxy = (...args: string[]) => run("bun", [SCRIPT, "proxy", ...args], proxyEnv);

describe.skipIf(!dockerUp && !process.env.CI)("Прокси на машине раздаёт адреса *.localhost контейнерам по их меткам", () => {
  let port = "";
  const containers: string[] = [];

  beforeAll(() => {
    const up = proxy("up");
    expect(exitOf(up), up.stdout + up.stderr).toBe(0);
    port = docker("compose", "-f", COMPOSE, "port", "traefik", "80").split(":").at(-1)!;
    docker("pull", "--quiet", WHOAMI);
  }, 300_000);
  afterAll(() => {
    if (containers.length) run("docker", ["rm", "-f", ...containers]);
    proxy("down");
  });

  /** Приложение в сети прокси; labels — метки Traefik, без них — контейнер без меток. Возвращает id. */
  function app(name: string, labels: Record<string, string> = {}) {
    const flags = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    const id = docker("run", "-d", "--name", `${NAME}-${name}`, "--network", NAME, ...flags, WHOAMI);
    containers.push(id);
    return id;
  }

  /** Запрос через прокси с заголовком Host — так браузер приходит по адресу `*.localhost`. */
  async function get(host: string, timeout = PATIENCE) {
    const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: host }, signal: AbortSignal.timeout(timeout) });
    return { status: r.status, body: await r.text() };
  }

  /**
   * Ждёт ответа status по host: прокси узнаёт о контейнерах из событий Docker, а не сразу. Запрос, пока событие не
   * дошло, идёт на адрес остановленного контейнера и висит до таймаута Traefik (504 через 30 с) — у каждого запроса
   * свой короткий таймаут, неответ — «ещё нет».
   */
  async function until(host: string, status: number) {
    const deadline = Date.now() + PATIENCE;
    let last = { status: 0, body: "" };
    while (Date.now() < deadline) {
      try {
        last = await get(host, 1_000);
      } catch (e) {
        if ((e as Error).name !== "TimeoutError") throw e;
        last = { status: 0, body: "no answer in 1 s" };
      }
      if (last.status === status) return last;
      await Bun.sleep(100);
    }
    throw new Error(`${host}: за ${PATIENCE / 1000} с не дождались ${status}, последний ответ ${last.status} ${last.body.slice(0, 200)}`);
  }

  const labels = (stack: string, service: string, host: string) => proxyLabels({ stack, service, host, port: 80 });

  it("контейнер с метками сервиса открывается по `<сервис>.<N>.<проект>.localhost`", async () => {
    const id = app("web", labels("demo-42", "web", "web.42.demo.localhost"));
    const r = await until("web.42.demo.localhost", 200);
    expect(r.body).toContain(`Hostname: ${id.slice(0, 12)}`);
  });

  it("контейнер без меток прокси не публикуется", async () => {
    // без меток — первым: когда виден соседний с метками, прокси учёл и его
    app("bare");
    app("api", labels("demo-43", "api", "api.43.demo.localhost"));
    await until("api.43.demo.localhost", 200);
    // правило Traefik по умолчанию для открытого контейнера — Host(<имя контейнера>)
    expect((await get(`${NAME}-bare`)).status).toBe(404);
    expect((await get("bare.43.demo.localhost")).status).toBe(404);
  });

  it("остановленный контейнер пропадает из маршрутов", async () => {
    const id = app("stopped", labels("demo-44", "web", "web.44.demo.localhost"));
    await until("web.44.demo.localhost", 200);
    docker("stop", "--time", "0", id);
    await until("web.44.demo.localhost", 404);
  });

  it("proxy status: работает — код 0; после proxy down — не запущен, код 1, с командой запуска; сети прокси нет", () => {
    const running = proxy("status");
    expect(exitOf(running), running.stderr).toBe(0);
    expect(running.stdout).toContain(`proxy ${NAME}: running`);
    if (containers.length) run("docker", ["rm", "-f", ...containers.splice(0)]);
    expect(exitOf(proxy("down"))).toBe(0);
    const stopped = proxy("status");
    expect(exitOf(stopped)).toBe(1);
    expect(stopped.stdout).toContain(`proxy ${NAME}: not running — start: bun ${SCRIPT} proxy up`);
    expect(docker("network", "ls", "--quiet", "--filter", `name=^${NAME}$`)).toBe("");
  });
});

describe("check -g называет прокси на машине: работает или не запущен — с командой запуска; код check прокси не меняет", () => {
  let sb: Sandbox;
  let log: string;

  /**
   * docker песочницы — подставной: отвечает по FAKE_DOCKER как `docker ps` (running — контейнер прокси работает,
   * exited — остановлен, none — его нет, down — демон не отвечает) и пишет свои аргументы в журнал.
   */
  beforeEach(() => {
    sb = sandbox();
    log = path.join(sb.tmp, "docker.log");
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$FAKE_DOCKER" in',
      "  running) echo running ;;",
      "  exited) echo exited ;;",
      "  down) echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2; exit 1 ;;",
      "esac",
    ].join("\n");
    writeFileSync(path.join(sb.bin, "docker"), script + "\n", { mode: 0o755 });
    expect(aiDev(sb, ["install", "-g"]).code).toBe(0);
  });
  afterEach(() => sb.cleanup());

  const check = (state: string, extra: Record<string, string> = {}) => aiDev(sb, ["check", "-g"], { env: { FAKE_DOCKER: state, FAKE_DOCKER_LOG: log, ...extra } });
  const START = "start: bun ~/.agents/skills/task-env/scripts/task-env.ts proxy up";

  it("`check -g` называет незапущенный прокси и команду его запуска", () => {
    for (const state of ["none", "exited"]) {
      const r = check(state);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`  proxy *.localhost: not running — ${START}`);
    }
  });

  it("прокси работает — строка «running» с его именем", () => {
    const r = check("running");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`  proxy *.localhost: running (${DEFAULT_NAME})`);
  });

  it("Docker не отвечает — строка «Docker unavailable» с причиной", () => {
    const r = check("down");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  proxy *.localhost: Docker unavailable — Cannot connect to the Docker daemon");
  });

  it("на машине нет docker — строки о прокси нет", () => {
    spawnSync("rm", [path.join(sb.bin, "docker")]);
    const r = check("running");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-dev on the machine: up to date");
    expect(r.stdout).not.toContain("proxy");
  });

  it("ищет тот же проект Compose, что поднимает скилл: имя — из его compose-файла, AI_DEV_PROXY его меняет", () => {
    expect(DEFAULT_NAME).toBeTruthy();
    check("running");
    check("running", { AI_DEV_PROXY: "other-proxy" });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`label=com.docker.compose.project=${DEFAULT_NAME} `);
    expect(calls).toContain("label=com.docker.compose.project=other-proxy ");
  });

  it("хук SessionStart показывает строку прокси вместе с машиной", () => {
    const r = aiDev(sb, ["check", "--hook"], { env: { FAKE_DOCKER: "none", FAKE_DOCKER_LOG: log } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ai-dev on the machine: up to date[^\n]*\n {2}proxy \*\.localhost: not running/);
  });
});
