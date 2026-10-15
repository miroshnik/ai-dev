import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import { composeEnv, formerProxyName, proxyHosts, proxyLabels } from "../../../skills/task-env/scripts/task-env.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";
import { calls, COMPOSE, FAKE_GH, run, SCRIPT } from "../../lib/task-env.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

/** Приложение в контейнере: отвечает своим Hostname — id контейнера, — по нему видно, кто ответил. */
const WHOAMI = "traefik/whoami:v1.12.0";
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;

/** Docker отвечает — сценарии с настоящим прокси идут; в CI без Docker они падают, а не пропускаются. */
const dockerUp = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 }).status === 0;

/**
 * Свой прокси теста рядом с рабочим: своё имя (проект Compose и сеть) и порт, который выдаёт Docker, — рабочий прокси
 * машины на 80 тест не трогает; прежний прокси у прокси теста — свой, `<имя>-former` (`formerProxyName`), а не прокси
 * машины до переименования. Окружение — с переменными compose-файла прокси: тест зовёт `docker compose -f` и сам.
 */
const NAME = `elves-proxy-test-${process.pid}`;
const proxyEnv = composeEnv({ ...process.env, ELVES_PROXY: NAME, ELVES_PROXY_PORT: "0" });

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

  const labels = (stack: string, service: string, host: string) => proxyLabels({ stack, service, host, port: 80, network: NAME });

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

  it("API прокси называет хосты маршрутов по адресу `<имя прокси>.localhost` на его порту: контейнер стартовал — его хост есть, остановился — нет", async () => {
    const env = { ...proxyEnv, ELVES_PROXY_PORT: port };
    const id = app("listed", labels("demo-45", "web", "web.45.demo.localhost"));
    await until("web.45.demo.localhost", 200);
    expect(await proxyHosts(env)).toEqual(expect.arrayContaining(["web.45.demo.localhost", `${NAME}.localhost`]));
    docker("stop", "--time", "0", id);
    await until("web.45.demo.localhost", 404);
    expect(await proxyHosts(env)).not.toContain("web.45.demo.localhost");
    // API — только по своему хосту: сайт, навёдший своё имя на 127.0.0.1, приходит со своим Host
    expect((await get("evil.example")).status).toBe(404);
  });

  it("остановленный контейнер пропадает из маршрутов", async () => {
    const id = app("stopped", labels("demo-44", "web", "web.44.demo.localhost"));
    await until("web.44.demo.localhost", 200);
    docker("stop", "--time", "0", id);
    await until("web.44.demo.localhost", 404);
  });

  it("сети прежнего прокси на машине нет — прокси только в своей сети, сеть прежнего не создаётся", () => {
    const id = docker("compose", "-f", COMPOSE, "ps", "--quiet", "traefik");
    expect(Object.keys(JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", id)))).toEqual([NAME]);
    expect(docker("network", "ls", "--quiet", "--filter", `name=^${formerProxyName(proxyEnv)}$`)).toBe("");
  });

  it("proxy status: работает — код 0; после proxy down — не запущен, код 1, с командой запуска; сети прокси нет", () => {
    const running = proxy("status");
    expect(exitOf(running), running.stderr).toBe(0);
    expect(running.stdout).toContain(`proxy ${NAME}: running`);
    if (containers.length) run("docker", ["rm", "-f", ...containers.splice(0)]);
    expect(exitOf(proxy("down"))).toBe(0);
    const stopped = proxy("status");
    expect(exitOf(stopped)).toBe(1);
    expect(stopped.stdout).toContain(`proxy ${NAME}: not running — start: bun --no-env-file ${SCRIPT} proxy up`);
    expect(docker("network", "ls", "--quiet", "--filter", `name=^${NAME}$`)).toBe("");
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
  /** `APP_URL` контейнера web стека — что приложение получило из compose-файла. */
  const appUrl = (stack: string) =>
    (JSON.parse(dockerOut("inspect", "--format", "{{json .Config.Env}}", containerId(stack, "web"))) as string[]).find((v) => v.startsWith("APP_URL="))?.slice("APP_URL=".length);

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
    const proxyEnv = composeEnv({ ...process.env, ELVES_PROXY: PROXY, ELVES_PROXY_PORT: "0" });
    const up = run("bun", [SCRIPT, "proxy", "up"], proxyEnv);
    expect(exitOf(up), up.stdout + up.stderr).toBe(0);
    port = run("docker", ["compose", "-f", COMPOSE, "port", "traefik", "80"], proxyEnv).stdout.trim().split(":").at(-1)!;
    // без TASK_ENV_* прогона (тесты под `task-env e2e`): адрес в compose-файл должен дать скрипт, а не окружение теста
    const own = Object.entries(process.env).filter(([k]) => !k.startsWith("TASK_ENV_"));
    env = { ...Object.fromEntries(own), ELVES_PROXY: PROXY, ELVES_PROXY_PORT: port };
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
        // свой адрес приложения — из интерполяции; без task-env (CI) — значение по умолчанию
        "    environment: { APP_URL: '${TASK_ENV_WEB_URL:-http://localhost:3000}' }",
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
        "    image: elves-task-env-test/no-such-image:0",
        "    profiles: [missing]",
        "volumes:",
        "  data: {}",
        "",
      ].join("\n"),
      ".agents/elves.json": JSON.stringify({ env: { http: { web: 80, search: 80, ghost: 3000 } } }) + "\n",
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
    expect(webLabels).toMatchObject(proxyLabels({ stack: `${PROJECT}-42`, service: "web", host: `web.42.${PROJECT}.localhost`, port: 80, network: PROXY }));
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

  it("compose-файл получает адрес HTTP-сервиса стека задачи в `TASK_ENV_<СЕРВИС>_URL`", () => {
    on("feat/42-checkout");
    const r = taskEnv("up");
    expect(r.code, r.out).toBe(0);
    expect(appUrl(`${PROJECT}-42`)).toBe(`http://web.42.${PROJECT}.localhost:${port}`);
  });

  /** Без dev-стека рядом: подсетей у Docker немного (SKILL.md, «Network subnets»), а адрес dev от e2e отличает хост. */
  it("у стека e2e в интерполяции — адреса e2e, не dev той же задачи", () => {
    on("feat/42-checkout");
    const r = taskEnv("e2e");
    expect(r.code, r.out).toBe(0);
    expect(appUrl(`${PROJECT}-42-e2e`)).toBe(`http://web.e2e.42.${PROJECT}.localhost:${port}`);
  });

  /**
   * Страж от перекоррекции: адрес уходит только процессу Compose скрипта — ни файлом `.env`, ни override в проекте он не
   * остаётся (запись в `.env` проекта этот тест валит).
   */
  it("без `task-env` переменных нет — работает значение по умолчанию compose-файла", () => {
    on("feat/42-checkout");
    expect(taskEnv("up").code).toBe(0);
    // `docker compose` руками (CI) в том же чекауте
    const config = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: root, encoding: "utf8", env });
    expect(exitOf(config), config.stderr).toBe(0);
    const web = (JSON.parse(config.stdout) as { services: Record<string, { environment?: Record<string, string> }> }).services.web;
    expect(web?.environment?.APP_URL).toBe("http://localhost:3000");
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

describe.skipIf(!dockerUp && !process.env.CI)("Переход с прокси до переименования: `proxy up` занимает его место, стеки до переименования и новые открываются через новый прокси", () => {
  /** Свой прокси теста; его прежний — `<имя>-former` (`formerProxyName`): прокси машины до переименования тест не трогает. */
  const NEW = `${NAME}-move`;
  const env = { ...process.env, ELVES_PROXY: NEW };
  const FORMER = formerProxyName(env);
  /**
   * Стеки: до переименования — сервисы без метки сети, в своей сети и сети прежнего прокси (как поднимал прежний
   * скрипт); новый — с меткой сети, в своей сети и сети прокси. Имена стеков — раньше по алфавиту, чем сети прокси: из
   * сетей контейнера без нужной Traefik берёт «первую» в порядке обхода map Go — случайном, но неравномерном, чаще
   * первую по алфавиту, — так без выбора сети по метке или по умолчанию стек по чужой сети почти всегда не открывается.
   */
  const OLD_STACK = `${NAME}-a-old`;
  const NEW_STACK = `${NAME}-a-new`;
  const SERVICES = ["a", "b", "c"];
  /** Пересборок маршрутов: при каждой Traefik выбирает сеть каждого контейнера заново. */
  const ROUNDS = 4;
  const oldHost = (s: string) => `${s}.1.${NEW}.localhost`;
  const newHost = (s: string) => `${s}.2.${NEW}.localhost`;
  let port = "";
  let up: { code: number | string; out: string } = { code: 0, out: "" };
  const ticks: string[] = [];

  const dockerOut = (...args: string[]) => {
    const r = run("docker", args, env);
    if (r.status !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  /** Проект Compose из файла на stdin: так тест поднимает прежний прокси и стеки, не трогая compose-файл скилла. */
  function composeUp(project: string, file: object) {
    const r = spawnSync("docker", ["compose", "-p", project, "-f", "-", "up", "--detach", "--wait", "--quiet-pull"], { input: JSON.stringify(file), encoding: "utf8", env });
    if (exitOf(r) !== 0) throw new Error(`docker compose -p ${project} up: ${r.stderr.trim()}`);
  }
  /** Контейнер сервиса проекта Compose — его короткий id: whoami отвечает им в `Hostname`. */
  const container = (project: string, service: string) =>
    dockerOut("ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`);
  const networksOf = (id: string) => Object.keys(JSON.parse(dockerOut("inspect", "--format", "{{json .NetworkSettings.Networks}}", id)) as object).sort();
  /**
   * Кто ответил через прокси по Host — `Hostname` из ответа whoami; не ответил за 3 с — пусто: к контейнеру по чужой
   * сети Traefik стучится до своего таймаута.
   */
  async function answered(host: string) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: host }, signal: AbortSignal.timeout(3_000) });
      return /^Hostname: (\S+)$/m.exec(await r.text())?.[1] ?? `HTTP ${r.status}`;
    } catch (e) {
      if ((e as Error).name !== "TimeoutError") throw e;
      return "";
    }
  }
  async function until(host: string, id: string) {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      if ((await answered(host)) === id.slice(0, 12)) return;
      await Bun.sleep(100);
    }
    throw new Error(`${host}: за ${PATIENCE / 1000} с не ответил контейнер ${id.slice(0, 12)}`);
  }

  beforeAll(() => {
    dockerOut("pull", "--quiet", WHOAMI);
    // порт, свободный на машине, — прежний прокси занимает его явно, как ai-dev-proxy порт 80: порт, который Docker выдал
    // сам, Docker 29 второму контейнеру отдаёт молча — тот запускается без публикации
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    port = String(free.port);
    free.stop(true);
    // прежний прокси: проект Compose с сервисом traefik и сетью с его именем
    composeUp(FORMER, { services: { traefik: { image: WHOAMI, ports: [`127.0.0.1:${port}:80`], networks: ["proxy"] } }, networks: { proxy: { name: FORMER } } });
    // стек до переименования — метки без сети, как ставил прежний скрипт
    const old = (s: string) =>
      Object.fromEntries(Object.entries(proxyLabels({ stack: OLD_STACK, service: s, host: oldHost(s), port: 80, network: NEW })).filter(([k]) => k !== "traefik.docker.network"));
    composeUp(OLD_STACK, { services: Object.fromEntries(SERVICES.map((s) => [s, { image: WHOAMI, labels: old(s), networks: ["default", "former"] }])), networks: { former: { name: FORMER, external: true } } });
    const r = run("bun", [SCRIPT, "proxy", "up"], { ...env, ELVES_PROXY_PORT: port });
    up = { code: exitOf(r), out: r.stdout + r.stderr };
    if (up.code !== 0) return;
    const labelled = (s: string) => proxyLabels({ stack: NEW_STACK, service: s, host: newHost(s), port: 80, network: NEW });
    composeUp(NEW_STACK, { services: Object.fromEntries(SERVICES.map((s) => [s, { image: WHOAMI, labels: labelled(s), networks: ["default", "proxy"] }])), networks: { proxy: { name: NEW, external: true } } });
  }, 300_000);
  afterAll(() => {
    if (ticks.length) run("docker", ["rm", "-f", ...ticks], env);
    for (const project of [OLD_STACK, NEW_STACK]) run("docker", ["compose", "-p", project, "down", "--remove-orphans"], env);
    run("bun", [SCRIPT, "proxy", "down"], env);
    run("docker", ["compose", "-p", FORMER, "down", "--remove-orphans"], env);
    run("docker", ["network", "rm", FORMER], env);
  });

  it("`proxy up` убирает прежний прокси, который держит порт, а его сеть оставляет: новый прокси на том же порту, в своей сети и в сети прежнего", () => {
    expect(up.code, up.out).toBe(0);
    expect(up.out).toContain(`proxy ${FORMER}: removed — the proxy before the rename; ${NEW} takes its port, its network ${FORMER} stays\n`);
    expect(container(FORMER, "traefik")).toBe("");
    const id = container(NEW, "traefik");
    expect(dockerOut("port", id, "80/tcp")).toBe(`127.0.0.1:${port}`);
    expect(networksOf(id)).toEqual([FORMER, NEW].sort());
    expect(up.out).toContain(`(network ${NEW}; and ${FORMER} — of the proxy before the rename, with the stacks brought up before it)`);
  });

  it("стек до переименования (без метки сети) и новый (с меткой) открываются через новый прокси — каждый раз, при каждой пересборке маршрутов", async () => {
    expect(up.code, up.out).toBe(0);
    const expected = [...SERVICES.map((s) => [oldHost(s), container(OLD_STACK, s)]), ...SERVICES.map((s) => [newHost(s), container(NEW_STACK, s)])];
    for (let round = 1; round <= ROUNDS; round++) {
      // такт: маршрут нового контейнера появился — прокси пересобрал маршруты всех контейнеров и выбрал сеть каждого заново
      const tick = `tick${round}.${NEW}.localhost`;
      const flags = Object.entries(proxyLabels({ stack: `${NEW}-tick${round}`, service: "web", host: tick, port: 80, network: NEW })).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
      const id = dockerOut("run", "-d", "--network", NEW, ...flags, WHOAMI);
      ticks.push(id);
      await until(tick, id);
      for (const [host, id] of expected) expect(await answered(host!), `${host}, пересборка ${round}`).toBe(id!.slice(0, 12));
    }
  });
});
