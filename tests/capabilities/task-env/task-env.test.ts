import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { composeEnv, FORMER_PROXY, formerProxyName, hostProject, httpServices, projectName, PROXY, proxyHosts, proxyName, proxyPort, stackOf, taskAddress } from "../../../skills/task-env/scripts/task-env.ts";
import { elves, sandbox, type Sandbox } from "../../lib/elves.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";
import { calls, COMPOSE, FAKE_GH, run, SCRIPT } from "../../lib/task-env.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

/** Имя прокси по умолчанию — из скрипта скилла: compose-файл своего значения по умолчанию не держит (#396, вопрос 1). */
const DEFAULT_NAME = PROXY;

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
    expect(elves(sb, ["install", "-g"]).code).toBe(0);
  });
  afterEach(() => sb.cleanup());

  const check = (state: string, extra: Record<string, string> = {}) => elves(sb, ["check", "-g"], { env: { FAKE_DOCKER: state, FAKE_DOCKER_LOG: log, ...extra } });
  const START = "start: bun --no-env-file ~/.agents/skills/task-env/scripts/task-env.ts proxy up";

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
    expect(r.stdout).toContain("Elves on the machine: up to date");
    expect(r.stdout).not.toContain("proxy");
  });

  it("ищет тот же проект Compose, что поднимает скилл: имя — из его скрипта, ELVES_PROXY его меняет", () => {
    expect(DEFAULT_NAME).toBeTruthy();
    check("running");
    check("running", { ELVES_PROXY: "other-proxy" });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`label=com.docker.compose.project=${DEFAULT_NAME} `);
    expect(calls).toContain("label=com.docker.compose.project=other-proxy ");
  });

  it("хук SessionStart показывает строку прокси вместе с машиной", () => {
    const r = elves(sb, ["check", "--hook"], { env: { FAKE_DOCKER: "none", FAKE_DOCKER_LOG: log } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Elves on the machine: up to date[^\n]*\n {2}proxy \*\.localhost: not running/);
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

  it("сеть прокси под прежним именем ai-dev-proxy — строка ❌ называет прежнее имя с правкой: убрать сеть, `task-env up` добавляет сеть прокси сам; код 1", () => {
    // как в прежнем примере reference.md: сеть прокси в compose-файле руками
    composeFile(
      [
        "services:",
        "  web:",
        "    image: app",
        "    networks: [default, ai-dev-proxy]",
        "  admin:",
        "    image: app",
        "    networks: [proxy]",
        "networks:",
        "  ai-dev-proxy:",
        "    external: true",
        "  proxy:",
        "    external: true",
        "    name: ai-dev-proxy",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    const fix = "ai-dev-proxy is the machine's proxy before the rename, now elves-proxy: remove the network from the compose file and its services; task-env up adds the proxy's network to the HTTP services of env.http itself";
    expect(r.stdout).toBe([`❌ compose.yaml: network ai-dev-proxy (service web) — ${fix}`, `❌ compose.yaml: network proxy (service admin) — ${fix}`, ""].join("\n"));
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

describe("Адреса задачи и маршруты прокси — для дашборда, без сокета Docker", () => {
  it("адрес задачи разбирается по схеме: сервис, номер, e2e, проект; другой хост — не адрес", () => {
    expect(taskAddress("web.42.shop.localhost")).toEqual({ service: "web", task: 42, e2e: false, project: "shop" });
    expect(taskAddress("web.e2e.42.shop.localhost")).toEqual({ service: "web", task: 42, e2e: true, project: "shop" });
    // номер — метка перед проектом: в имени сервиса бывают точки и цифры
    expect(taskAddress("web.1.42.shop.localhost")).toEqual({ service: "web.1", task: 42, e2e: false, project: "shop" });
    // адрес, который строит стек задачи, разбирается обратно
    expect(taskAddress(stackOf("shop", 42).host("web"))).toEqual({ service: "web", task: 42, e2e: false, project: "shop" });
    expect(taskAddress(stackOf("shop", 42, true).host("web"))).toEqual({ service: "web", task: 42, e2e: true, project: "shop" });
    // стек основного чекаута, API прокси, не *.localhost
    for (const host of [stackOf("shop", undefined).host("web"), `${PROXY}.localhost`, "web.42.shop.example"]) expect(taskAddress(host)).toBeNull();
  });

  it("проект в адресе — имя репозитория строчными буквами, цифрами и «-»", () => {
    expect(["task-env", "My_Shop", "shop.web", "--Shop--"].map(hostProject)).toEqual(["task-env", "my-shop", "shop-web", "shop"]);
  });

  describe("API прокси", () => {
    /** Подставной Traefik: `/api/http/routers` постранично (`X-Next-Page`, последняя страница называет 1) — только по хосту `fake-proxy.localhost`. */
    let routers: unknown[] = [];
    let status = 200;
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (req.headers.get("host") !== "fake-proxy.localhost" || url.pathname !== "/api/http/routers") return new Response("404 page not found", { status: 404 });
          if (status !== 200) return new Response("internal error", { status });
          const [per, page] = [Number(url.searchParams.get("per_page") || 100), Number(url.searchParams.get("page") || 1)];
          return Response.json(routers.slice((page - 1) * per, page * per), { headers: { "X-Next-Page": String(page * per < routers.length ? page + 1 : 1) } });
        },
      });
    });
    afterAll(() => server.stop(true));
    beforeEach(() => {
      routers = [];
      status = 200;
    });
    const env = (name = "fake-proxy") => ({ ELVES_PROXY: name, ELVES_PROXY_PORT: String(server.port) });
    const router = (rule: string, o: Record<string, unknown> = {}) => ({ name: "r@docker", rule, service: "s", status: "enabled", entryPoints: ["web"], provider: "docker", ...o });

    it("API прокси отдаёт хосты включённых маршрутов точки входа web по адресу `<имя прокси>.localhost` на его порту, все страницы", async () => {
      routers = [
        ...Array.from({ length: 150 }, (_, i) => router(`Host(\`s${i}.7.shop.localhost\`)`)),
        router("Host(`off.7.shop.localhost`)", { status: "disabled" }),
        router("PathPrefix(`/ping`)", { entryPoints: ["traefik"], provider: "internal" }),
      ];
      const hosts = await proxyHosts(env());
      expect(hosts).toHaveLength(150);
      expect(hosts).toContain("s0.7.shop.localhost");
      expect(hosts).toContain("s149.7.shop.localhost");
    });

    it("прокси не запущен — хостов нет и ошибки нет; маршруты не прочитаны по другой причине — ошибка с ней", async () => {
      const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
      const port = String(closed.port);
      closed.stop(true);
      expect(await proxyHosts({ ELVES_PROXY: "fake-proxy", ELVES_PROXY_PORT: port })).toBeNull();
      // на порту прокси без API: чужой хост Traefik отдаёт 404
      await expect(proxyHosts(env("other-proxy"))).rejects.toThrow(/^proxy other-proxy: routes not read — .*HTTP 404/);
      status = 500;
      await expect(proxyHosts(env())).rejects.toThrow("HTTP 500");
    });
  });

  it("значения по умолчанию имени, порта и сети провайдера прокси — только в скрипте: compose-файл без них не собирается, `proxy up` передаёт их сам", () => {
    expect(readFileSync(COMPOSE, "utf8")).not.toMatch(/\$\{ELVES_PROXY\w*:-/);
    // docker — подставной: пишет в журнал, с какими именем, портом и сетью провайдера прокси его позвали; контейнер
    // прокси — «running», прежнего прокси и его сети нет
    const { dir, cleanup } = tmpDir();
    try {
      const log = path.join(dir, "docker.log");
      const fake = `#!/bin/sh\necho "$ELVES_PROXY $ELVES_PROXY_PORT $ELVES_PROXY_DEFAULT_NETWORK $1 $2" >> "${log}"\ncase "$*" in *"project=${PROXY} "*) echo running ;; esac\nexit 0\n`;
      writeFileSync(path.join(dir, "docker"), fake, { mode: 0o755 });
      const up = run("bun", [SCRIPT, "proxy", "up"], { ...process.env, PATH: `${dir}:${process.env.PATH}`, ELVES_PROXY: "", ELVES_PROXY_PORT: "", AI_DEV_PROXY_PORT: "" });
      expect(exitOf(up), up.stdout + up.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(`${PROXY} 80 ${PROXY} compose -f`);
    } finally {
      cleanup();
    }
    const config = (env: NodeJS.ProcessEnv) => spawnSync("docker", ["compose", "-f", COMPOSE, "config", "--format", "json"], { encoding: "utf8", env });
    const bare = { ...process.env, ELVES_PROXY: "", ELVES_PROXY_PORT: "", ELVES_PROXY_DEFAULT_NETWORK: "", AI_DEV_PROXY_PORT: "" };
    const none = config(bare);
    expect(exitOf(none)).not.toBe(0);
    expect(none.stderr).toContain("required variable ELVES_PROXY");
    const set = config(composeEnv(bare));
    expect(exitOf(set), set.stderr).toBe(0);
    const c = JSON.parse(set.stdout);
    expect([c.name, c.networks.proxy.name]).toEqual([PROXY, PROXY]);
    expect(c.services.traefik.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "80", target: 80 })]);
    // сеть провайдера по умолчанию — своя сеть прокси
    expect(c.services.traefik.command).toContain(`--providers.docker.network=${PROXY}`);
    // API — роутер с именем прокси на точке входа web
    expect(c.services.traefik.labels[`traefik.http.routers.${PROXY}-api.rule`]).toBe(`Host(\`${PROXY}.localhost\`)`);
  });
});

// ----------------------------------------------------------------------------
// Переименование ai-dev → Elves: прокси, его переменные и настройки проекта
// ----------------------------------------------------------------------------

describe("Прокси после переименования — `elves-proxy`; прежние имя, порт и настройки читаются один релиз", () => {
  it("имя прокси — `elves-proxy`, ELVES_PROXY его меняет; порт — ELVES_PROXY_PORT, без неё — прежняя AI_DEV_PROXY_PORT из профиля, без обеих — 80", () => {
    expect(proxyName({})).toBe("elves-proxy");
    expect(proxyName({ ELVES_PROXY: "other-proxy" })).toBe("other-proxy");
    expect(proxyPort({})).toBe("80");
    expect(proxyPort({ AI_DEV_PROXY_PORT: "8080" })).toBe("8080");
    expect(proxyPort({ ELVES_PROXY_PORT: "8081", AI_DEV_PROXY_PORT: "8080" })).toBe("8081");
  });

  it("прежний прокси — `ai-dev-proxy` только у прокси по умолчанию; у прокси с другим именем — `<имя>-former`: тестовый прокси не трогает прокси машины", () => {
    expect(formerProxyName({})).toBe(FORMER_PROXY);
    expect(FORMER_PROXY).toBe("ai-dev-proxy");
    expect(formerProxyName({ ELVES_PROXY: "elves-proxy-test-1" })).toBe("elves-proxy-test-1-former");
  });

  /** docker — подставной: прежний прокси и его сеть есть, новый не создаётся (образ не скачан); журнал — его вызовы. */
  it("новый прокси не создался — прежний остаётся на месте: его контейнер не удалён, код 2", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const log = path.join(dir, "docker.log");
      const fake = [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${log}"`,
        'case "$*" in',
        `  "ps --all --filter label=com.docker.compose.project=${FORMER_PROXY} "*) echo f0rmer1d ;;`,
        `  "network ls "*) echo ${FORMER_PROXY} ;;`,
        '  *"up --no-start"*) echo "Error response from daemon: pull access denied for traefik" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n");
      writeFileSync(path.join(dir, "docker"), fake, { mode: 0o755 });
      const up = run("bun", [SCRIPT, "proxy", "up"], { ...process.env, PATH: `${dir}:${process.env.PATH}`, ELVES_PROXY: "", ELVES_PROXY_PORT: "", AI_DEV_PROXY_PORT: "" });
      expect(exitOf(up), up.stdout + up.stderr).toBe(2);
      expect(up.stderr).toContain(`proxy ${PROXY}: not started — Error response from daemon: pull access denied for traefik`);
      const made = calls(log);
      expect(made.some((c) => c.includes("up --no-start"))).toBe(true);
      expect(made.filter((c) => c.startsWith("rm "))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("Настройки проекта — `.agents/elves.json`; установка до `update` — `.agents/ai-dev.json`", () => {
  let dir: { dir: string; cleanup: () => void };
  beforeEach(() => (dir = tmpDir()));
  afterEach(() => dir.cleanup());
  const settings = (files: Record<string, unknown>) =>
    writeTree(dir.dir, Object.fromEntries(Object.entries(files).map(([f, v]) => [f, typeof v === "string" ? v : JSON.stringify(v) + "\n"])));

  it("`env.http` — из `.agents/elves.json`; пока его нет — из `.agents/ai-dev.json`; сообщение об ошибке называет прочитанный файл", () => {
    expect(httpServices(dir.dir)).toEqual({});
    settings({ ".agents/ai-dev.json": { env: { http: { web: 3000 } } } });
    expect(httpServices(dir.dir)).toEqual({ web: 3000 });
    settings({ ".agents/elves.json": { env: { http: { api: 8080 } } } });
    expect(httpServices(dir.dir)).toEqual({ api: 8080 });
    settings({ ".agents/elves.json": { env: { http: { api: "8080" } } } });
    expect(httpServices(dir.dir)).toStartWith("env.http of .agents/elves.json: ");
    spawnSync("rm", [path.join(dir.dir, ".agents/elves.json")]);
    settings({ ".agents/ai-dev.json": "{" });
    expect(httpServices(dir.dir)).toStartWith(".agents/ai-dev.json: ");
  });
});
