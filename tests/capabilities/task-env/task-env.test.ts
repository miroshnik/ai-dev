import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { projectName, PROXY, proxyLabels } from "../../../skills/task-env/scripts/task-env.ts";
import { aiDev, sandbox, type Sandbox } from "../../lib/ai-dev.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

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

/**
 * Имя прокси по умолчанию записано дважды: `PROXY` скрипта (его берут скрипт и `check -g` установщика) и значение по
 * умолчанию подстановки `${AI_DEV_PROXY:-…}` в compose-файле — Compose скрипт не прочтёт. Расхождение молчит: прокси
 * поднимется под одним именем, а `check -g` будет искать другое и назовёт работающий прокси незапущенным.
 */
describe("Имя прокси по умолчанию — одно у скрипта и compose-файла скилла", () => {
  it("каждое значение по умолчанию ${AI_DEV_PROXY:-…} в compose-файле (комментарии не в счёт) — PROXY скрипта", () => {
    const text = readFileSync(COMPOSE, "utf8").replace(/(^|\s)#.*$/gm, "$1");
    const defaults = [...text.matchAll(/\$\{AI_DEV_PROXY:-([^}]*)\}/g)].map((m) => m[1]);
    expect(defaults.length).toBeGreaterThan(0);
    expect([...new Set(defaults)]).toEqual([PROXY]);
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

// ----------------------------------------------------------------------------
// task-env check — правила изоляции compose-файла
// ----------------------------------------------------------------------------

let project: { dir: string; cleanup: () => void };
/** Проект Compose — каталог `proj`: имя проекта «proj», имена томов и сетей по умолчанию — `proj_<ключ>`. */
let proj: string;
function projectPerTest() {
  beforeEach(() => {
    project = tmpDir();
    proj = path.join(project.dir, "proj");
    mkdirSync(proj);
  });
  afterEach(() => project.cleanup());
}

/**
 * `task-env check <proj>` с настоящим `docker compose`: нормализацию compose-файла проверка берёт у Compose, и тест —
 * тоже; демон Docker для `config` не нужен. env — поверх окружения прогона.
 */
function composeCheck(env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, "check", proj], { cwd: project.dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr };
}

const composeFile = (yaml: string, name = "compose.yaml") => writeTree(proj, { [name]: yaml });

/** PATH без docker: bun скрипт запускает по полному пути, docker ищется в PATH. */
function noDockerPath() {
  const bin = path.join(project.dir, "bin");
  mkdirSync(bin, { recursive: true });
  return bin;
}

describe("task-env check называет каждое нарушение правил изоляции compose-файла строкой ❌ с правилом и сервисом", () => {
  projectPerTest();

  it("container_name — нарушение: строка с сервисом и именем, код 1", () => {
    composeFile("services:\n  db:\n    image: postgres\n    container_name: pg\n  app:\n    image: app\n");
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("❌ compose.yaml: service db — container_name pg: a second task stack can't start; remove it, Compose names containers by the project\n");
  });

  it("фиксированный порт хоста — нарушение, и с IP хоста; порт, выданный Docker (127.0.0.1::5433, 5434), и сервис без ports — нет", () => {
    composeFile(
      [
        "services:",
        "  db:",
        "    image: postgres",
        '    ports: ["5432:5432", "127.0.0.1::5433", "5434", "127.0.0.1:8080:80", "53:53/udp"]',
        "  app:",
        "    image: app",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        "❌ compose.yaml: service db — fixed host port 5432:5432: two task stacks contend for it; publish 127.0.0.1::5432 or drop ports",
        "❌ compose.yaml: service db — fixed host port 127.0.0.1:8080:80: two task stacks contend for it; publish 127.0.0.1::80 or drop ports",
        "❌ compose.yaml: service db — fixed host port 53:53/udp: two task stacks contend for it; publish 127.0.0.1::53/udp or drop ports",
        "",
      ].join("\n"),
    );
  });

  it("том или сеть с name: или external — нарушение с сервисами, которые их берут; имя, которое Compose даёт сам (proj_<ключ>), — нет", () => {
    composeFile(
      [
        "services:",
        "  db:",
        "    image: postgres",
        "    volumes: [data:/var/lib/postgresql/data, cache:/cache, shared:/shared, own:/own]",
        "    networks: [default, back]",
        "  app:",
        "    image: app",
        "    volumes: [shared:/shared]",
        "    networks: [back, edge]",
        "volumes:",
        "  data: { name: pgdata }",
        "  cache: { external: true }",
        "  shared: { name: proj_shared }",
        "  own: {}",
        "networks:",
        "  default: { name: devnet }",
        "  back: { external: true, name: traefik }",
        "  edge: {}",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        "❌ compose.yaml: volume cache (service db) — external: task stacks share it, down -v of one wipes another's data; drop external",
        "❌ compose.yaml: volume data (service db) — name pgdata: task stacks share it, down -v of one wipes another's data; remove name, Compose prefixes it by the project",
        "❌ compose.yaml: network back (services app, db) — external: task stacks share it and reach each other's services; drop external",
        "❌ compose.yaml: network default (service db) — name devnet: task stacks share it and reach each other's services; remove name, Compose prefixes it by the project",
        "",
      ].join("\n"),
    );
  });

  it("абсолютный путь к коду в volumes и build — нарушение, ~ тоже; относительный путь, именованный том и ресурс машины (сокет Docker, /etc/localtime) — нет", () => {
    composeFile(
      [
        "services:",
        "  app:",
        "    build: { context: /work/app, dockerfile: /work/app/Dockerfile }",
        "    volumes:",
        "      - /work/app/src:/app/src",
        "      - ~/code/lib:/app/lib",
        "      - ./src:/app/src2",
        "      - node_modules:/app/node_modules",
        "      - /var/run/docker.sock:/var/run/docker.sock",
        "      - /etc/localtime:/etc/localtime:ro",
        "  web:",
        "    build: ./web",
        "volumes:",
        "  node_modules: {}",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        "❌ compose.yaml: service app — build context: absolute path /work/app: builds code outside the task's worktree; use a path relative to the compose file",
        "❌ compose.yaml: service app — build dockerfile: absolute path /work/app/Dockerfile: builds code outside the task's worktree; use a path relative to the compose file",
        "❌ compose.yaml: service app — volumes: absolute path /work/app/src: mounts code outside the task's worktree; use a path relative to the compose file",
        "❌ compose.yaml: service app — volumes: absolute path ~/code/lib: mounts code outside the task's worktree; use a path relative to the compose file",
        "",
      ].join("\n"),
    );
  });

  /** Сервисы в profiles `config` без профиля не показывает, override-файл Compose берёт сам — проверка видит оба. */
  it("сервис в profiles и правка из compose.override.yaml проверяются наравне с остальными", () => {
    composeFile("services:\n  app:\n    image: app\n  search:\n    image: elasticsearch\n    profiles: [heavy]\n    container_name: es\n");
    composeFile("services:\n  app:\n    ports: ['3000:3000']\n", "compose.override.yaml");
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("❌ compose.yaml: service search — container_name es:");
    expect(r.stdout).toContain("❌ compose.yaml: service app — fixed host port 3000:3000:");
  });

  it("строка называет compose-файл под тем именем, что лежит в проекте: docker-compose.yml", () => {
    composeFile("services:\n  db:\n    image: postgres\n    container_name: pg\n", "docker-compose.yml");
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toStartWith("❌ docker-compose.yml: service db — container_name pg:");
  });

  it("чистый compose-файл — код 0, ни одной строки ❌", () => {
    composeFile(
      [
        "services:",
        "  db:",
        "    image: postgres",
        '    ports: ["127.0.0.1::5432"]',
        "    volumes: [data:/var/lib/postgresql/data, ./init:/docker-entrypoint-initdb.d]",
        "  app:",
        "    build: .",
        "volumes:",
        "  data: {}",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("❌");
  });
});

describe("Проверить нечего или нечем — проверка молчит или говорит «не проверено», а не ошибку", () => {
  projectPerTest();

  it("проект без compose-файла — код 0, ни строки ❌ и ○, docker не нужен", () => {
    const r = composeCheck({ PATH: noDockerPath() });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/[❌○]/u);
    expect(r.stderr).toBe("");
  });

  it("без Docker — строка ○ «not checked» с причиной, код 2", () => {
    composeFile("services:\n  db:\n    image: postgres\n    container_name: pg\n");
    const r = composeCheck({ PATH: noDockerPath() });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("○ compose.yaml: not checked — docker not found\n");
  });

  it("docker без плагина compose — «not checked» с ответом docker, код 2", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    const bin = noDockerPath();
    writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho \"docker: unknown command: docker $1\" >&2\nexit 1\n", { mode: 0o755 });
    const r = composeCheck({ PATH: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("○ compose.yaml: not checked — docker compose config: docker: unknown command: docker compose\n");
  });

  it("config не разбирает файл (незаданная обязательная переменная) — «not checked» с ответом Compose, код 2", () => {
    composeFile("services:\n  db:\n    image: ${DB_IMAGE:?set DB_IMAGE}\n");
    const r = composeCheck();
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/^○ compose\.yaml: not checked — docker compose config: [^\n]*DB_IMAGE[^\n]*\n$/);
  });
});

// ----------------------------------------------------------------------------
// Стек задачи — up, e2e, down
// ----------------------------------------------------------------------------

/**
 * Подставной docker: пишет аргументы в журнал FAKE_DOCKER_LOG; списки контейнеров, томов и сетей — пустые, FAKE_DOCKER=down
 * — демон не отвечает.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
  'if [ "$FAKE_DOCKER" = down ]; then echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; fi',
  "",
].join("\n");

/**
 * Подставной gh: `gh api repos/<репозиторий>/issues/<N>` — состояние задачи из FAKE_GH_STATES («41=closed 42=open»),
 * другого номера нет — 404; аргументы — в журнал FAKE_GH_LOG.
 */
const FAKE_GH = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
  'n="${2##*/}"',
  "for s in $FAKE_GH_STATES; do",
  '  if [ "${s%%=*}" = "$n" ]; then echo "{\\"number\\": $n, \\"state\\": \\"${s#*=}\\"}"; exit 0; fi',
  "done",
  'echo "gh: Not Found (HTTP 404)" >&2',
  "exit 1",
  "",
].join("\n");

/** Журнал подставной команды: строки вызовов. */
const calls = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean);

describe("Снять нечего или нечем — строка ○, а не ошибка; Docker не отвечает — строка ! с причиной", () => {
  projectPerTest();
  let bin: string;
  let log: string;
  let ghLog: string;
  beforeEach(() => {
    bin = noDockerPath();
    log = path.join(project.dir, "docker.log");
    ghLog = path.join(project.dir, "gh.log");
    writeFileSync(log, "");
    writeFileSync(ghLog, "");
    writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  });
  const fakeDocker = () => writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  /** task-env в проекте proj (не репозиторий git: проект — «proj»); PATH — подставные docker и gh впереди. */
  function taskEnvIn(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: proj,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_GH_LOG: ghLog, ...env },
    });
    return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr };
  }

  it("в чекауте без compose-файла down Docker не зовёт — строка ○, код 0", () => {
    fakeDocker();
    const r = taskEnvIn(["down", "42"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`○ no compose file in ${realpathSync(proj)} — the project has no task stacks\n`);
    expect(calls(log)).toEqual([]);
  });

  it("у задачи нет стеков на машине — строка ○, Compose ничего не снимает", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    fakeDocker();
    const r = taskEnvIn(["down", "42"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("○ stacks proj-42, proj-42-e2e: none on the machine\n");
    expect(calls(log).filter((c) => c.startsWith("compose"))).toEqual([]);
  });

  it("без Docker на машине — строка ○, код 0", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    const r = taskEnvIn(["down", "42"], { PATH: bin });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("○ no Docker on the machine — no task stacks\n");
  });

  it("Docker не отвечает — строка ! с причиной, код 2", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    fakeDocker();
    const r = taskEnvIn(["down", "42"], { FAKE_DOCKER: "down" });
    expect(r.code).toBe(2);
    expect(r.stdout).toStartWith("! stacks proj-42, proj-42-e2e: not removed — Docker unavailable: Cannot connect to the Docker daemon");
  });

  it("prune: стеков задач проекта на машине нет — строка ○, GitHub не спрашивает", () => {
    fakeDocker();
    const r = taskEnvIn(["prune"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("○ no stacks of proj tasks on the machine\n");
    expect(calls(ghLog)).toEqual([]);
  });
});

describe("Имя проекта стеков и адресов — из репозитория, а не из каталога", () => {
  let repo: { dir: string; cleanup: () => void };
  beforeEach(() => (repo = tmpDir()));
  afterEach(() => repo.cleanup());

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("имя проекта — из репозитория, а не из каталога worktree", () => {
    const main = path.join(repo.dir, "Shop.App");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(repo.dir, "session-379-499083");
    git(main, "worktree", "add", "-q", "-b", "feat/42-x", worktree);
    // без remote — каталог основного чекаута, и из worktree тоже
    expect(projectName(worktree)).toBe("shop-app");
    // с remote — имя репозитория origin, в любой записи URL
    for (const url of ["git@github.com:acme/Shop_Front.git", "https://github.com/acme/Shop_Front", "https://github.com/acme/Shop_Front.git/"]) {
      spawnSync("git", ["remote", "remove", "origin"], { cwd: main });
      git(main, "remote", "add", "origin", url);
      expect(projectName(worktree), url).toBe("shop-front");
    }
  });
});

describe.skipIf(!dockerUp && !process.env.CI)("Стек задачи — проект Compose `<проект>-<N>` по ветке; адреса HTTP-сервисов — через прокси", () => {
  /** Свой прокси и свой проект теста: стеки машины и параллельных прогонов он не задевает. */
  const PROXY = `${NAME}-stack`;
  const PROJECT = `shop-t${process.pid}`;
  const BUSYBOX = "busybox:1.37";
  let env: NodeJS.ProcessEnv;
  let port = "";
  let repo: { dir: string; cleanup: () => void };
  /** Корень проекта — каталог с именем как у worktree приложения: имя проекта берётся не из него. */
  let root = "";

  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  /** Ветка проекта; все ветки — на одном коммите. */
  const on = (branch: string) => git("switch", "-q", "-C", branch);
  const taskEnv = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8", env });
    return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
  };
  const dockerOut = (...args: string[]) => {
    const r = run("docker", args, env);
    if (r.status !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const byProject = (stack: string) => `label=com.docker.compose.project=${stack}`;
  /** Сервисы контейнеров стека, отсортированные. */
  const services = (stack: string) =>
    dockerOut("ps", "--all", "--filter", byProject(stack), "--format", '{{.Label "com.docker.compose.service"}}').split("\n").filter(Boolean).sort();
  const volumes = (stack: string) => dockerOut("volume", "ls", "--quiet", "--filter", byProject(stack)).split("\n").filter(Boolean);
  /** Стеки теста на машине — по метке проекта Compose у контейнеров, томов и сетей: от стека бывают одни тома. */
  const testStacks = () => {
    const names = new Set<string>();
    for (const list of [["ps", "--all"], ["volume", "ls"], ["network", "ls"]]) {
      const out = dockerOut(...list, "--filter", "label=com.docker.compose.project", "--format", '{{.Label "com.docker.compose.project"}}');
      for (const name of out.split("\n")) if (name === PROJECT || name.startsWith(`${PROJECT}-`)) names.add(name);
    }
    return [...names];
  };
  /** Стек, от которого остались одни тома: контейнеры удалены, `down` без `-v`. */
  const volumeOnly = (stack: string) => dockerOut("volume", "create", "--label", `com.docker.compose.project=${stack}`, "--label", "com.docker.compose.volume=data", `${stack}_data`);
  const containerId = (stack: string, service: string) => dockerOut("ps", "--quiet", "--filter", byProject(stack), "--filter", `label=com.docker.compose.service=${service}`);

  /** Запрос через прокси теста с заголовком Host — так приходит браузер по адресу `*.localhost`. */
  async function get(host: string) {
    const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: host }, signal: AbortSignal.timeout(PATIENCE) });
    return { status: r.status, body: await r.text() };
  }
  /** Прокси узнаёт о контейнере из событий Docker, а не сразу: ждём ответа status. */
  async function until(host: string, status: number) {
    const deadline = Date.now() + PATIENCE;
    let last = { status: 0, body: "" };
    while (Date.now() < deadline) {
      last = await get(host);
      if (last.status === status) return last;
      await Bun.sleep(100);
    }
    throw new Error(`${host}: за ${PATIENCE / 1000} с не дождались ${status}, последний ответ ${last.status} ${last.body.slice(0, 200)}`);
  }

  beforeAll(() => {
    // прокси на порту, который выдаёт Docker; стек получает этот порт — он в адресах
    const proxyEnv = { ...process.env, AI_DEV_PROXY: PROXY, AI_DEV_PROXY_PORT: "0" };
    const up = run("bun", [SCRIPT, "proxy", "up"], proxyEnv);
    expect(exitOf(up), up.stdout + up.stderr).toBe(0);
    port = run("docker", ["compose", "-f", COMPOSE, "port", "traefik", "80"], proxyEnv).stdout.trim().split(":").at(-1)!;
    env = { ...process.env, AI_DEV_PROXY: PROXY, AI_DEV_PROXY_PORT: port };
    for (const image of [WHOAMI, BUSYBOX]) dockerOut("pull", "--quiet", image);
    repo = tmpDir();
    root = path.join(repo.dir, "session-379-499083");
    mkdirSync(root);
    // db — «база»: порт опубликован на loopback, данные в томе; sleep не ловит SIGTERM — SIGKILL, чтобы down не ждал 10 с
    const db = `    image: ${BUSYBOX}\n    command: [sleep, "86400"]\n    stop_signal: SIGKILL\n`;
    writeTree(root, {
      "compose.yaml": [
        "services:",
        "  web:",
        `    image: ${WHOAMI}`,
        "  db:",
        db + '    ports: ["127.0.0.1::5432"]',
        "    volumes: [data:/data]",
        "  search:",
        `    image: ${WHOAMI}`,
        "    profiles: [heavy]",
        "  crash:",
        `    image: ${BUSYBOX}`,
        '    command: [sh, -c, "echo boom-before-exit; exit 3"]',
        "    profiles: [crash]",
        "  sick:",
        db + "    healthcheck: { test: [CMD, sh, -c, 'echo sick-check; exit 1'], interval: 1s, retries: 1 }",
        "    profiles: [sick]",
        "  missing:",
        "    image: ai-dev-task-env-test/no-such-image:0",
        "    profiles: [missing]",
        "volumes:",
        "  data: {}",
        "",
      ].join("\n"),
      ".agents/ai-dev.json": JSON.stringify({ env: { http: { web: 80, search: 80, ghost: 3000 } } }) + "\n",
    });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", `git@github.com:acme/Shop-T${process.pid}.git`);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  }, 300_000);

  /**
   * Стеки теста снимаются после каждого: тест поднимает то, что ему нужно, сам. И подсетей у Docker немного (около 30
   * у Docker Desktop по умолчанию, SKILL.md, «Network subnets»): стеки всех тестов разом их бы исчерпали.
   */
  afterEach(() => {
    for (const stack of testStacks()) run("docker", ["compose", "-p", stack, "down", "--volumes", "--remove-orphans"], env);
  });
  afterAll(() => {
    run("bun", [SCRIPT, "proxy", "down"], env);
    repo?.cleanup();
  });

  it("номер задачи берётся из ветки `<type>/<N>-slug`", () => {
    on("feat/42-checkout");
    const r = taskEnv("up");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`stack ${PROJECT}-42: up\n`);
    expect(services(`${PROJECT}-42`)).toEqual(["db", "web"]);
  });

  it("адрес сервиса — `<сервис>.<N>.<проект>.localhost`", async () => {
    on("feat/42-checkout");
    const r = taskEnv("up");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`  web  http://web.42.${PROJECT}.localhost:${port}\n`);
    expect(r.stdout).toMatch(/\n {2}db {3}127\.0\.0\.1:\d+ → 5432\n/);
    const answer = await until(`web.42.${PROJECT}.localhost`, 200);
    expect(answer.body).toContain(`Hostname: ${containerId(`${PROJECT}-42`, "web")}`);
  });

  it("без номера в ветке — стек и адреса основного чекаута", async () => {
    for (const branch of ["main", "claude/frosty-lovelace-5b8ba2"]) {
      on(branch);
      const r = taskEnv("up");
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toContain(`stack ${PROJECT}: up\n`);
      expect(r.stdout).toContain(`  web  http://web.${PROJECT}.localhost:${port}\n`);
    }
    expect(services(PROJECT)).toEqual(["db", "web"]);
    expect((await until(`web.${PROJECT}.localhost`, 200)).body).toContain(`Hostname: ${containerId(PROJECT, "web")}`);
  });

  /** Метки — в override на stdin Compose: в проекте файла нет, и `check` не видит внешней сети прокси. */
  it("override добавляет метки только HTTP-сервисам из настройки", async () => {
    on("feat/42-checkout");
    const r = taskEnv("up");
    expect(r.code, r.out).toBe(0);
    const field = (service: string, format: string) => JSON.parse(dockerOut("inspect", "--format", format, containerId(`${PROJECT}-42`, service))) as Record<string, unknown>;
    const inspect = (service: string) => [field(service, "{{json .Config.Labels}}"), field(service, "{{json .NetworkSettings.Networks}}")] as const;
    const [webLabels, webNets] = inspect("web");
    expect(webLabels).toMatchObject(proxyLabels({ stack: `${PROJECT}-42`, service: "web", host: `web.42.${PROJECT}.localhost`, port: 80 }));
    expect(Object.keys(webNets).sort()).toEqual([PROXY, `${PROJECT}-42_default`].sort());
    const [dbLabels, dbNets] = inspect("db");
    expect(Object.keys(dbLabels).filter((k) => k.startsWith("traefik."))).toEqual([]);
    expect(Object.keys(dbNets)).toEqual([`${PROJECT}-42_default`]);
    expect((await get(`db.42.${PROJECT}.localhost`)).status).toBe(404);
    // сервис настройки, которого нет в compose-файле, — строка, а не ошибка
    expect(r.stdout).toContain("! env.http: service ghost isn't in the compose file — no address for it\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(taskEnv("check").code).toBe(0);
  });

  it("профиль (`--profile`) поднимает сервисы профиля, без него их нет", async () => {
    on("feat/44-search");
    const plain = taskEnv("up");
    expect(plain.code, plain.out).toBe(0);
    expect(services(`${PROJECT}-44`)).toEqual(["db", "web"]);
    expect(plain.stdout).not.toContain("search");
    const heavy = taskEnv("up", "--profile", "heavy");
    expect(heavy.code, heavy.out).toBe(0);
    expect(services(`${PROJECT}-44`)).toEqual(["db", "search", "web"]);
    expect(heavy.stdout).toContain(`  search  http://search.44.${PROJECT}.localhost:${port}\n`);
    await until(`search.44.${PROJECT}.localhost`, 200);
  });

  it("у e2e свой стек с чистыми томами, отличный от dev той же задачи", async () => {
    on("feat/42-checkout");
    expect(taskEnv("up").code).toBe(0);
    dockerOut("compose", "-p", `${PROJECT}-42`, "exec", "-T", "db", "touch", "/data/dev-marker");
    const write = taskEnv("e2e", "--", "sh", "-c", 'docker compose -p "$TASK_ENV_PROJECT" exec -T db touch /data/e2e-run-marker');
    expect(write.code, write.out).toBe(0);
    expect(write.stdout).toContain(`stack ${PROJECT}-42-e2e: up, clean volumes`);
    const list = taskEnv("e2e", "--", "sh", "-c", 'echo "files:"; docker compose -p "$TASK_ENV_PROJECT" exec -T db ls -A /data');
    expect(list.code, list.out).toBe(0);
    expect(list.stdout).toMatch(/files:\n$/);
    expect(dockerOut("compose", "-p", `${PROJECT}-42`, "exec", "-T", "db", "ls", "/data")).toBe("dev-marker");
    const e2eWeb = await until(`web.e2e.42.${PROJECT}.localhost`, 200);
    expect(e2eWeb.body).toContain(`Hostname: ${containerId(`${PROJECT}-42-e2e`, "web")}`);
    expect(containerId(`${PROJECT}-42-e2e`, "web")).not.toBe(containerId(`${PROJECT}-42`, "web"));
  });

  it("команда прогона e2e получает адреса e2e в переменных, код выхода — её", async () => {
    on("feat/42-checkout");
    const r = taskEnv("e2e", "--", "sh", "-c", 'echo "url=$TASK_ENV_WEB_URL db=$TASK_ENV_DB_5432 project=$TASK_ENV_PROJECT"; exit 7');
    expect(r.code, r.out).toBe(7);
    const url = `http://web.e2e.42.${PROJECT}.localhost:${port}`;
    expect(r.stdout).toMatch(new RegExp(`\nurl=${url.replace(/\./g, "\\.")} db=127\\.0\\.0\\.1:\\d+ project=${PROJECT}-42-e2e\n`));
    expect(r.stdout).toContain(`  web  ${url}  TASK_ENV_WEB_URL\n`);
    await until(new URL(url).hostname, 200);
  });

  it("стек не поднялся (образ, сборка, контейнер упал, healthcheck не прошёл) — скрипт называет сервис, его состояние и последние строки лога, код 1", () => {
    on("feat/45-broken");
    const crash = taskEnv("up", "--profile", "crash");
    expect(crash.code, crash.out).toBe(1);
    expect(crash.stdout).toContain(`stack ${PROJECT}-45: not up — `);
    expect(crash.stdout).toContain("✗ crash: exited (exit 3)\n    | boom-before-exit\n");
    const sick = taskEnv("up", "--profile", "sick");
    expect(sick.code, sick.out).toBe(1);
    expect(sick.stdout).toContain("✗ sick: running, unhealthy\n    healthcheck: exit 1 — sick-check\n");
    const missing = taskEnv("up", "--profile", "missing");
    expect(missing.code, missing.out).toBe(1);
    expect(missing.stdout).toMatch(/stack [^\n]+: not up — [^\n]*no-such-image/);
  });

  /** `task close` снимает стеки задачи этой командой (скилл github). */
  it("снятие убирает контейнеры и тома только своей задачи — стеки другой задачи и основного чекаута остаются", () => {
    on("feat/42-checkout");
    expect(taskEnv("up").code).toBe(0);
    expect(taskEnv("e2e").code).toBe(0);
    on("feat/43-other");
    expect(taskEnv("up").code).toBe(0);
    // основной чекаут — одними томами: подсетей у Docker немного (SKILL.md, «Network subnets»), а стек без контейнеров
    // снятие находит так же
    volumeOnly(PROJECT);
    for (const stack of [`${PROJECT}-42`, `${PROJECT}-42-e2e`, `${PROJECT}-43`, PROJECT]) expect(volumes(stack), stack).toHaveLength(1);
    const r = taskEnv("down", "42");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(`+ stack ${PROJECT}-42: down, with its volumes\n+ stack ${PROJECT}-42-e2e: down, with its volumes\n`);
    for (const stack of [`${PROJECT}-42`, `${PROJECT}-42-e2e`]) {
      expect(services(stack), stack).toEqual([]);
      expect(volumes(stack), stack).toEqual([]);
    }
    expect(services(`${PROJECT}-43`)).toEqual(["db", "web"]);
    for (const stack of [`${PROJECT}-43`, PROJECT]) expect(volumes(stack), stack).toHaveLength(1);
  });

  it("снятие убирает и стек, от которого остались одни тома", () => {
    volumeOnly(`${PROJECT}-46`);
    const r = taskEnv("down", "46");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(`+ stack ${PROJECT}-46: down, with its volumes\n`);
    expect(volumes(`${PROJECT}-46`)).toEqual([]);
  });

  /** gh — подставной (FAKE_GH): состояние задач — из states, журнал вызовов — ghLog. */
  let ghLog = "";
  function prune(states: Record<number, string>) {
    const bin = path.join(repo.dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    ghLog = path.join(repo.dir, "gh.log");
    writeFileSync(ghLog, "");
    const FAKE_GH_STATES = Object.entries(states).map(([n, state]) => `${n}=${state}`).join(" ");
    const r = spawnSync(process.execPath, [SCRIPT, "prune"], { cwd: root, encoding: "utf8", env: { ...env, PATH: `${bin}:${env.PATH}`, FAKE_GH_STATES, FAKE_GH_LOG: ghLog } });
    return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
  }

  it("поиск сирот находит только стеки закрытых задач: снимает их с томами, стеки открытых задач, основного чекаута и номеров, которых нет в GitHub, не трогает", () => {
    on("feat/41-done");
    expect(taskEnv("up").code).toBe(0);
    on("feat/42-checkout");
    expect(taskEnv("up").code).toBe(0);
    // от стеков остались одни тома: e2e закрытой задачи, стек номера, которого в GitHub нет, и основной чекаут — так
    // меньше сетей (SKILL.md, «Network subnets»)
    for (const stack of [`${PROJECT}-41-e2e`, `${PROJECT}-7`, PROJECT]) volumeOnly(stack);
    const r = prune({ 41: "closed", 42: "open" });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(
      [
        `○ stack ${PROJECT}-7: no task #7 in acme/Shop-T${process.pid} — left`,
        `+ stack ${PROJECT}-41: down, with its volumes — task #41 is closed`,
        `+ stack ${PROJECT}-41-e2e: down, with its volumes — task #41 is closed`,
        `○ stack ${PROJECT}-42: task #42 is open — left`,
        "",
      ].join("\n"),
    );
    for (const stack of [`${PROJECT}-41`, `${PROJECT}-41-e2e`]) {
      expect(services(stack), stack).toEqual([]);
      expect(volumes(stack), stack).toEqual([]);
    }
    expect(services(`${PROJECT}-42`)).toEqual(["db", "web"]);
    for (const stack of [`${PROJECT}-7`, PROJECT]) expect(volumes(stack), stack).toHaveLength(1);
    // состояние каждой задачи — один запрос к её репозиторию
    expect(calls(ghLog)).toEqual([7, 41, 42].map((n) => `api repos/acme/Shop-T${process.pid}/issues/${n}`));
  });

  /** Имя проекта — из репозитория: у репозитория `shop-2` основной стек `shop-2` — как стек задачи #2 проекта `shop`. */
  it("стек другого репозитория с именем `<проект>-<N>` prune не трогает, даже если задача N закрыта", () => {
    const other = path.join(repo.dir, "other");
    mkdirSync(other, { recursive: true });
    writeTree(other, { "compose.yaml": `services:\n  db:\n    image: ${BUSYBOX}\n    command: [sleep, "86400"]\n    stop_signal: SIGKILL\n` });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
    execFileSync("git", ["remote", "add", "origin", `git@github.com:acme/Shop-T${process.pid}-9.git`], { cwd: other });
    const up = spawnSync("docker", ["compose", "-p", `${PROJECT}-9`, "up", "--detach", "--wait"], { cwd: other, encoding: "utf8", env });
    expect(exitOf(up), up.stderr).toBe(0);
    const r = prune({ 9: "closed" });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^○ stack ${PROJECT}-9: its containers are from \\S*/other — another project, left\n$`));
    expect(services(`${PROJECT}-9`)).toEqual(["db"]);
  });
});
