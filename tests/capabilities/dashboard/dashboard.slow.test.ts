import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const DASHBOARD = fileURLToPath(new URL("../../../skills/dashboard/scripts/dashboard.ts", import.meta.url));
const DAY = 86400;
// полдень UTC: локальная дата та же в любом часовом поясе
const T0 = Date.parse("2026-09-01T12:00:00Z") / 1000;

// `gh` — внешний край, подменяется он: проект репозитория и его элементы — из мира $FAKE_GH/world.json
// (перечитывается на каждый вызов), PR, эпики задач, задачи с вопросами и изменённые с `since` — его `live`, `fail` — ошибка
// gh; каждый вызов —
// строкой JSON в $FAKE_GH/calls.jsonl.
const FAKE_GH = `import { appendFileSync, readFileSync } from "node:fs";
const dir = process.env.FAKE_GH;
const args = process.argv.slice(2);
const stdin = args.includes("--input") ? readFileSync(0, "utf8") : "";
const world = JSON.parse(readFileSync(dir + "/world.json", "utf8"));
const print = (x) => console.log(JSON.stringify(x));
if (args[1] !== "graphql") { console.error("fake gh: " + args.join(" ")); process.exit(1); }
const { query, variables: v } = JSON.parse(stdin);
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ query: query.trim().slice(0, 60) }) + "\\n");
if (world.fail) { console.error(world.fail); process.exit(1); }
const repo = world.repos[v.o + "/" + v.r];
if (query.includes("projectsV2(first:5)")) print({ data: { repository: { projectsV2: { nodes: [{ number: repo.project, title: "p", owner: { login: v.o } }] } } } });
else if (query.includes("projectV2(number:$n)")) {
  const fields = { nodes: [{ id: "F_est", name: "Оценка, ч" }, { id: "F_fact", name: "Факт, ч" }, { id: "F_st", name: "Status", options: [] }] };
  print({ data: { [query.includes("organization(") ? "organization" : "user"]: { projectV2: { id: "P" + v.n, title: "p", number: v.n, fields } } } });
} else if (query.includes("node(id:$id)")) {
  const r = Object.values(world.repos).find((x) => "P" + x.project === v.id);
  print({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: r.items } } } });
} else if (query.includes("pullRequests(")) {
  // задачи — элементы проекта со статусом из фильтра $q, как отбирает GitHub; эпик задачи — из live.parents
  const l = repo.live ?? {};
  // значения фильтра через запятую — любое из них
  const statuses = [...(/status:((?:"[^"]+",?)+)/.exec(v.q)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const items = repo.items.filter((it) => it.fieldValues.nodes.some((f) => f.field?.name === "Status" && statuses.includes(f.name))).map((it) => ({ content: { ...it.content, parent: (l.parents ?? {})[it.content.number] ?? null } }));
  print({ data: { project: { items: { nodes: items } }, repository: { open: { nodes: l.open ?? [] }, merged: { nodes: l.merged ?? [] }, questions: { nodes: l.questions ?? [] }, recent: { nodes: (l.recent ?? []).filter((i) => i.updatedAt >= v.since) } } } });
} else { console.error("fake gh: " + query.slice(0, 80)); process.exit(1); }
`;

/** Элемент проекта, как его отдаёт GitHub: закрытая задача с полями «Оценка, ч», «Факт, ч» и маркерами в комментариях. */
function item(number: number, title: string, day: number, issueType: string | null = null) {
  const num = (name: string, value: number) => ({ __typename: "ProjectV2ItemFieldNumberValue", number: value, field: { name } });
  const comments = ['Оценка: 0.5 ч\n<!-- est {"v": 2, "h": 0.5, "tok": 10, "usd": 8, "type": "feat"} -->', 'Факт: 0.25 ч\n<!-- fact {"v": 1, "h": 0.25, "cov": "full", "tok": {"total": 5000000}, "usd": 4.5, "type": "feat"} -->'];
  return {
    id: `PI_${number}`, type: "ISSUE",
    content: { __typename: "Issue", id: `I_${number}`, number, title, state: "CLOSED", stateReason: "COMPLETED", closedAt: new Date((T0 + day * DAY) * 1000).toISOString(), createdAt: null, issueType: issueType && { name: issueType }, labels: { nodes: [] }, comments: { nodes: comments.map((body, i) => ({ databaseId: number * 10 + i, body })) } },
    fieldValues: { nodes: [num("Оценка, ч", 0.5), num("Факт, ч", 0.25)] },
  };
}

/** Открытая задача проекта со статусом: «В работе» — строка вкладки «Сессии». */
function openItem(number: number, title: string, status: string, issueType: string | null = null) {
  const it = item(number, title, 0, issueType);
  return {
    ...it, content: { ...it.content, state: "OPEN", stateReason: null, closedAt: null, comments: { nodes: [] } },
    fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: status, field: { name: "Status" } }] },
  };
}

/**
 * Прокси task-env подменяется своим API: подставной Traefik отдаёт маршруты `routers` по хосту `fake-proxy.localhost`,
 * `status` не 200 — сбой; рабочий прокси машины на 80 тест не читает.
 */
const fakeProxy = { routers: [] as unknown[], status: 200 };
const PROXY_NAME = "fake-proxy";

describe("Команда dashboard сервит страницу сама и открывает её в браузере", () => {
  let dir: string;
  let cleanup: () => void;
  let bin: string;
  let running: ChildProcess[];
  let proxyApi: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    proxyApi = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        req.headers.get("host") !== `${PROXY_NAME}.localhost` ? new Response("404 page not found", { status: 404 }) : fakeProxy.status !== 200 ? new Response("internal error", { status: fakeProxy.status }) : Response.json(fakeProxy.routers, { headers: { "X-Next-Page": "1" } }),
    });
  });
  afterAll(() => proxyApi.stop(true));
  const world = (w: { repos: Record<string, { project: number; items: unknown[]; live?: unknown }>; fail?: string }) => writeFileSync(path.join(bin, "world.json"), JSON.stringify(w));
  const ONE = { repos: { "o/a": { project: 1, items: [item(1, "Экспорт счетов", 1), item(2, "Импорт выписок", 2), item(3, "Сверка платежей", 3), item(9, "Биллинг · эпик", 3, "Эпик")] } } };

  beforeEach(() => {
    ({ dir, cleanup } = tmpDir());
    bin = path.join(dir, "bin");
    running = [];
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(dir, "elves"), { recursive: true });
    writeFileSync(path.join(bin, "fake-gh.mjs"), FAKE_GH);
    writeFileSync(path.join(bin, "calls.jsonl"), "");
    // «браузер» — и заданный в BROWSER, и системные open / xdg-open: адрес, с которым его позвали, — в opened
    for (const name of ["gh", "browser", "open", "xdg-open"]) {
      writeFileSync(path.join(bin, name), name === "gh" ? `#!/usr/bin/env bash\nexec bun "$FAKE_GH/fake-gh.mjs" "$@"\n` : `#!/usr/bin/env bash\necho "$@" >> "$FAKE_GH/opened"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    world(ONE);
    fakeProxy.routers = [];
    fakeProxy.status = 200;
  });
  afterEach(() => {
    for (const p of running) p.kill("SIGKILL");
    cleanup();
  });

  const env = (extra: Record<string, string> = {}) => ({ ...process.env, HOME: dir, ELVES_CONFIG_DIR: path.join(dir, "elves"), CLAUDE_CODE_REMOTE: "", PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin, BROWSER: path.join(bin, "browser"), ELVES_PROXY: PROXY_NAME, ELVES_PROXY_PORT: String(proxyApi.port), ...extra });
  const itemsReads = () => readFileSync(path.join(bin, "calls.jsonl"), "utf8").split("\n").filter((l) => l.includes("node(id:$id)")).length;
  const opened = () => (existsSync(path.join(bin, "opened")) ? readFileSync(path.join(bin, "opened"), "utf8").trim() : null);
  const sync = (args: string[], extra: Record<string, string> = {}) => spawnSync("bun", [DASHBOARD, ...args], { encoding: "utf8", env: env(extra) });

  /** Запускает дашборд и ждёт строку готовности: страница отдана первому, кто её откроет, решение о браузере принято. */
  function start(args: string[], extra: Record<string, string> = {}): Promise<{ url: string; stdout: () => string; stderr: () => string }> {
    const p = spawn("bun", [DASHBOARD, ...args], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
    running.push(p);
    let out = "";
    let err = "";
    return new Promise((resolve, reject) => {
      p.stderr!.on("data", (d) => (err += d));
      p.stdout!.on("data", (d) => {
        out += d;
        const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
        if (url && /^browser: .*$/m.test(out)) resolve({ url, stdout: () => out, stderr: () => err });
      });
      p.on("exit", (code, signal) => reject(new Error(`dashboard вышел (${code ?? signal}): ${out}${err}`)));
    });
  }
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  }

  it("поднимает сервер на localhost, печатает адрес и открывает его в браузере", async () => {
    const d = await start(["--repo", "o/a"]);
    // ждём адрес, а не файл: `>>` создаёт opened раньше, чем браузер пишет в него
    await until(() => !!opened());
    expect(opened()).toBe(d.url);
    const r = await fetch(d.url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("Sessions: tasks in progress");
  });

  it("запрос с чужим Host — отказ: сайт, навёдший своё имя на 127.0.0.1, страницу не прочтёт", async () => {
    const d = await start(["--repo", "o/a", "--no-open"]);
    const r = await fetch(new URL("/est", d.url), { headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain("Экспорт счетов");
    expect((await fetch(d.url.replace("127.0.0.1", "localhost"))).status).toBe(200);
  });

  it("--no-open и BROWSER=none браузер не открывают", async () => {
    for (const [args, extra] of [[["--no-open"], {}], [[], { BROWSER: "none" }]] as [string[], Record<string, string>][]) {
      const d = await start(["--repo", "o/a", ...args], extra);
      expect(d.stdout()).toContain("browser: not opening");
      expect((await fetch(d.url)).status).toBe(200);
      expect(opened()).toBeNull();
    }
  });

  it("страница отдаёт задачи проекта; повторное открытие в течение минуты GitHub не перечитывает, «Refresh» — перечитывает", async () => {
    const d = await start(["--repo", "o/a", "--no-open"]);
    const est = new URL("/est", d.url);
    const html = await (await fetch(est)).text();
    for (const title of ["#1 Экспорт счетов", "#2 Импорт выписок", "#3 Сверка платежей"]) expect(html).toContain(title);
    // эпик по типу issue в график не входит
    expect(html).not.toContain("Биллинг · эпик");
    expect(itemsReads()).toBe(1);
    world({ repos: { "o/a": { project: 1, items: [...ONE.repos["o/a"].items, item(4, "Возврат платежа", 4)] } } });
    expect(await (await fetch(est)).text()).not.toContain("Возврат платежа");
    expect(itemsReads()).toBe(1);
    const refresh = /href="([^"]*refresh=1[^"]*)"/.exec(html)?.[1];
    expect(refresh).toBeDefined();
    const fresh = await fetch(new URL(refresh!.replace(/&amp;/g, "&"), d.url));
    expect(await fresh.text()).toContain("#4 Возврат платежа");
    expect(itemsReads()).toBe(2);
    // после «Refresh» адрес — без refresh: перезагрузка вкладки не перечитывает GitHub заново
    expect(fresh.url).not.toContain("refresh");
  });

  it("--all-repos — задачи всех репозиториев реестра, у задачи назван репозиторий", async () => {
    world({ repos: { "o/a": { project: 1, items: [item(1, "Экспорт счетов", 1)] }, "o/b": { project: 2, items: [item(1, "Поиск по каталогу", 2)] } } });
    writeFileSync(path.join(dir, "elves", "repos.json"), JSON.stringify({ "o/a": {}, "o/b": {} }));
    const d = await start(["--all-repos", "--no-open"]);
    const html = await (await fetch(new URL("/est", d.url))).text();
    expect(html).toContain('data-task="o/a#1"');
    expect(html).toContain('data-task="o/b#1"');
    expect(html).toContain("o/b#1 Поиск по каталогу");
  });

  it("ошибка GitHub — на странице, сервер живёт дальше", async () => {
    world({ ...ONE, fail: "HTTP 502: Bad Gateway" });
    const d = await start(["--repo", "o/a", "--no-open"]);
    const bad = await fetch(new URL("/est", d.url));
    expect(bad.status).toBe(502);
    expect(await bad.text()).toContain("HTTP 502: Bad Gateway");
    // сбой сети повторяется без настоящих пауз: прогон задаёт ELVES_GH_RETRY_MS (tests/standards/fast-tests)
    expect(d.stderr()).toContain("network failure, retry in 0 s");
    // неверный период в адресе — ошибка запроса, а не GitHub
    const period = await fetch(new URL("/est?since=вчера", d.url));
    expect(period.status).toBe(400);
    expect(await period.text()).toContain("«вчера»");
    // «Сессии» — страница с ошибкой репозитория плашкой
    const sessions = await fetch(d.url);
    expect(sessions.status).toBe(200);
    expect(await sessions.text()).toContain("HTTP 502: Bad Gateway");
    world(ONE);
    const ok = await fetch(new URL("/est", d.url));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("#1 Экспорт счетов");
    expect(await (await fetch(new URL("/?refresh=1", d.url))).text()).not.toContain("HTTP 502");
  });

  it("вкладка «Sessions» открыта по умолчанию, «Estimate and actual» — второй вкладкой", async () => {
    const d = await start(["--repo", "o/a", "--no-open"]);
    const main = await (await fetch(d.url)).text();
    expect(main).toContain('<nav class="tabs" aria-label="Tabs"><a href="/" aria-current="page">Sessions</a><a href="/est">Estimate and actual</a></nav>');
    expect(main).toContain("Waiting for the owner");
    expect(main).not.toContain("<svg");
    const est = await (await fetch(new URL("/est", d.url))).text();
    expect(est).toContain('<a href="/">Sessions</a>');
    expect(est).toContain('<a href="/est" aria-current="page">Estimate and actual</a>');
    expect(est).toContain("<svg");
    expect((await fetch(new URL("/other", d.url))).status).toBe(404);
  });

  it("«Sessions» — задачи «В работе» проекта с закреплёнными сессиями из транскриптов и PR из GitHub; страница обновляется сама", async () => {
    const now = Date.now() / 1000;
    const rec = (ago: number, text: string) => JSON.stringify({ type: "assistant", timestamp: new Date((now - ago) * 1000).toISOString(), message: { id: `m${ago}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
    const projects = path.join(dir, ".claude", "projects");
    const write = (sub: string, id: string, title: string, ...lines: string[]) => {
      mkdirSync(path.join(projects, sub), { recursive: true });
      writeFileSync(path.join(projects, sub, `${id}.jsonl`), [JSON.stringify({ type: "custom-title", customTitle: title }), ...lines].join("\n") + "\n");
    };
    // сессия задачи #5 работает из чужого каталога; сессия эпика — из каталога репозитория, без закрепления
    write("-tmp-scratch", "s5", "#5 Импорт банков", rec(120, "CI зелёный.\n\nОсталось: мерж — от владельца."));
    write("-work-a--claude-worktrees-x", "e1", "Биллинг · планирование", rec(600, "Всё сделано, но есть вопросы:\n1. Делить импорт?"));
    mkdirSync(path.join(dir, "elves", "sessions"), { recursive: true });
    writeFileSync(path.join(dir, "elves", "sessions", "s5"), "o/a#5\n");
    writeFileSync(path.join(dir, "elves", "repos.json"), JSON.stringify({ "o/a": { paths: ["/work/a"] } }));
    const commit = (state: string) => ({ nodes: [{ commit: { messageBody: "", statusCheckRollup: { state } } }] });
    world({
      repos: {
        "o/a": {
          project: 1,
          items: [...ONE.repos["o/a"].items, openItem(5, "Импорт банков", "В работе"), openItem(6, "Отчёт по ROI", "В работе"), openItem(10, "Банки · эпик", "В работе", "Эпик"), openItem(11, "Поиск", "Бэклог"), openItem(12, "Export", "In progress"), openItem(13, "Banks", "In progress", "Epic")],
          live: {
            open: [{ number: 50, url: "https://github.com/o/a/pull/50", headRefName: "feat/5-bank-import", mergeable: "MERGEABLE", closingIssuesReferences: { nodes: [{ number: 5 }] }, commits: commit("SUCCESS") }],
            parents: { 5: { number: 10, title: "Банки · эпик" } },
            questions: [{ number: 6, title: "Отчёт по ROI", body: "## Вопросы\n1. Валюта отчёта?\n" }],
            // задачи, изменённые с `since`: ответ авто в #5 — за сутки, #11 обновлена давно — GitHub её не отдаёт
            recent: [
              { number: 5, title: "Импорт банков", body: "## Вопросы\n1. ✅ авто Формат выписки? **Ответ:** MT940.\n", createdAt: new Date((now - 7200) * 1000).toISOString(), lastEditedAt: new Date((now - 600) * 1000).toISOString(), updatedAt: new Date((now - 60) * 1000).toISOString() },
              { number: 11, title: "Поиск", body: "## Вопросы\n1. ✅ авто Движок? **Ответ:** встроенный.\n", createdAt: "2026-01-01T00:00:00Z", lastEditedAt: null, updatedAt: "2026-01-02T00:00:00Z" },
            ],
          },
        },
      },
    });
    const d = await start(["--repo", "o/a", "--no-open"]);
    const html = await (await fetch(d.url)).text();
    const row = (n: number) => (new RegExp(`<tr[^>]*data-task="o/a#${n}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(row(5)).toContain("epic #10 Банки · эпик");
    expect(row(5)).toContain("2 min ago");
    expect(row(5)).toContain("merge");
    expect(row(5)).toContain("#50 checks green");
    expect(row(6)).toContain("no session");
    // эпик и задача не «В работе» — не строки
    expect(html).not.toContain('data-task="o/a#10"');
    expect(html).not.toContain('data-task="o/a#11"');
    // статус и тип — на любом языке словаря: доска проекта на en — тоже строки, эпик на en — не строка
    expect(row(12)).toContain("#12 Export");
    expect(html).not.toContain('data-task="o/a#13"');
    const asks = /<section class="asks[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    for (const q of ["Осталось: мерж — от владельца.", "1. Делить импорт?", "1. Валюта отчёта?"]) expect(asks).toContain(q);
    // «Decided auto» — ответы авто задач, изменённых за сутки, под таблицей задач
    const autos = (/<section class="autos[\s\S]*?<\/section>/.exec(html)?.[0] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(autos).toContain("#5 Импорт банков edited 10 min ago Формат выписки? MT940.");
    expect(autos).not.toContain("Движок?");
    // обновляется сама: раз в 30 с страница заново, подменой <main> — раскрытое остаётся раскрытым
    expect(html).toMatch(/<\/main><script>[\s\S]*replaceWith[\s\S]*setInterval\([^\n]*, 30000\);[\s\S]*<\/script>/);
  });

  it("«Sessions» — у задачи «В работе» ссылки на адреса её сервисов из маршрутов прокси; маршруты не прочитаны — причина плашкой, страница отдаётся", async () => {
    world({ repos: { "o/a": { project: 1, items: [openItem(5, "Импорт банков", "В работе"), openItem(6, "Отчёт по ROI", "В работе")] } } });
    const route = (host: string) => ({ name: "r@docker", rule: `Host(\`${host}\`)`, status: "enabled", entryPoints: ["web"], provider: "docker" });
    fakeProxy.routers = [route("web.5.a.localhost"), route("api.5.a.localhost"), route("web.6.b.localhost")];
    const d = await start(["--repo", "o/a", "--no-open"]);
    const html = await (await fetch(d.url)).text();
    const row = (n: number) => new RegExp(`<tr[^>]*data-task="o/a#${n}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? "";
    // ссылка — с портом прокси: он не 80
    expect(row(5)).toContain(`<a href="http://web.5.a.localhost:${proxyApi.port}"`);
    expect(row(5)).toContain(`<a href="http://api.5.a.localhost:${proxyApi.port}"`);
    // у #6 стека нет: web.6.b — задача другого проекта
    expect(row(6)).not.toContain("services:");
    fakeProxy.status = 500;
    const failed = await fetch(d.url);
    expect(failed.status).toBe(200);
    const page = await failed.text();
    expect(page).toContain(`proxy ${PROXY_NAME}: routes not read`);
    expect(page).toContain('data-task="o/a#5"');
  });

  it("в облачной сессии — ошибка с объяснением, а не сбой gh", () => {
    const r = sync(["--repo", "o/a", "--no-open"], { CLAUDE_CODE_REMOTE: "true" });
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain("docs/cloud-sessions.md");
    expect(readFileSync(path.join(bin, "calls.jsonl"), "utf8")).toBe("");
  });

  it("неизвестный параметр — код 2, --help — справка", () => {
    expect(exitOf(sync(["--bogus"]))).toBe(2);
    expect(sync(["--since", "вчера", "--no-open"]).stderr).toContain("invalid period «вчера»");
    const help = sync(["--help"]);
    expect(exitOf(help)).toBe(0);
    expect(help.stdout).toContain("dashboard [--repo o/r | --all-repos]");
    expect(sync(["--repo", "o/a", "--all-repos"]).stderr).toContain("--repo and --all-repos are mutually exclusive");
  });

  it("занятый порт — ошибка с подсказкой, а не трасса", async () => {
    const d = await start(["--repo", "o/a", "--no-open"]);
    const r = sync(["--repo", "o/a", "--no-open", "--port", new URL(d.url).port]);
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain(`error: port ${new URL(d.url).port} is busy`);
  });

  // песочница агента (Claude Code с выключенным allowLocalBinding): Bun отдаёт запрещённый listen как EADDRINUSE на любом
  // порте, и на 0 тоже
  const DENY_LISTEN = `Bun.serve = (o) => { throw Object.assign(new Error("Failed to start server. Is port " + o.port + " in use?"), { code: "EADDRINUSE", syscall: "listen", errno: 0 }); };\n`;
  const denied = (args: string[]) => {
    writeFileSync(path.join(bin, "deny-listen.mjs"), DENY_LISTEN);
    return spawnSync("bun", ["--preload", path.join(bin, "deny-listen.mjs"), DASHBOARD, ...args], { encoding: "utf8", env: env() });
  };

  it("локальный порт не открыть (песочница агента) — ошибка, что слушать порт на 127.0.0.1 здесь запрещено, с подсказкой запустить вне песочницы, а не «port 0 is busy»", () => {
    const r = denied(["--repo", "o/a", "--no-open"]);
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain("error: can't listen on 127.0.0.1");
    expect(r.stderr).toContain("outside the sandbox");
    expect(r.stderr).not.toContain("is busy");
  });

  it("--port N, когда и свободный порт не взять, — тот же запрет, а не «port N is busy»", () => {
    const r = denied(["--repo", "o/a", "--no-open", "--port", "8123"]);
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain("error: can't listen on 127.0.0.1");
    expect(r.stderr).not.toContain("is busy");
  });
});
