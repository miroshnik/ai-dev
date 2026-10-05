import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { chartSvg, page, points, trend, view } from "../../../skills/dashboard/scripts/dashboard.ts";
import { calib, median } from "../../../skills/est/scripts/est.ts";
import type { Row } from "../../../skills/est/scripts/est.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const DASHBOARD = fileURLToPath(new URL("../../../skills/dashboard/scripts/dashboard.ts", import.meta.url));
const DAY = 86400;
// полдень UTC: локальная дата та же в любом часовом поясе
const T0 = Date.parse("2026-09-01T12:00:00Z") / 1000;

/** Закрытая задача с оценкой и фактом: закрыта на `number`-й день после T0. */
const row = (number: number, o: Partial<Row> = {}): Row => ({
  item_id: "", issue_id: "", number, title: `Задача ${number}`, state: "CLOSED", stateReason: "COMPLETED", closedAt: T0 + number * DAY, createdAt: T0, labels: [],
  est: 0.5, fact: 0.25, status: "Готово", est_marker: { h: 0.5, tok: 10, usd: 8, type: "feat" }, fact_marker: { cov: "full", tok: { total: 5_000_000 }, usd: 4.5, type: "feat" },
  ...o,
});
const rows = (n: number, fact: (i: number) => number = (i) => i / 10): Row[] => Array.from({ length: n }, (_, i) => row(i + 1, { fact: fact(i + 1) }));
const model = (rs: Row[], extra: Partial<Parameters<typeof page>[0]> = {}) => page({ repos: ["o/r"], since: "", view: view({ "o/r": rs }, null), at: T0, errors: [], ...extra });
/** Панель графика по имени: разметка от её `<g>` до следующей панели. */
const panel = (svg: string, name: string) => svg.split('<g class="panel"').find((p) => p.startsWith(` data-panel="${name}"`)) ?? "";
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("Данные графика — закрытые задачи с фактом по времени закрытия", () => {
  it("закрытая задача с фактом — точка: дата закрытия, оценка и прогноз из маркера «Оценка», часы, токены в млн и стоимость из факта", () => {
    expect(points("o/r", [row(1)])).toEqual([
      { repo: "o/r", number: 1, title: "Задача 1", url: "https://github.com/o/r/issues/1", t: T0 + DAY, type: "feat", cov: "full", est: 0.5, fact: 0.25, tokEst: 10, tok: 5, usdEst: 8, usd: 4.5 },
    ]);
    // по времени закрытия, а не по номеру
    expect(points("o/r", [row(1, { closedAt: T0 + 9 * DAY }), row(2)]).map((p) => p.number)).toEqual([2, 1]);
  });

  it("эпик, открытая задача и задача без факта в график не входят", () => {
    const rs = [row(1), row(2, { labels: ["epic"] }), row(3, { issueType: "Эпик" }), row(4, { state: "OPEN", closedAt: null }), row(5, { fact: null, fact_marker: null })];
    expect(points("o/r", rs).map((p) => p.number)).toEqual([1]);
  });

  it("оценка без маркера est — в других единицах: у точки оценки нет", () => {
    const [p] = points("o/r", [row(1, { est: 5, est_marker: null })]);
    expect(p).toMatchObject({ est: null, tokEst: null, usdEst: null, fact: 0.25 });
  });

  it("период --since оставляет задачи, закрытые не раньше его начала", () => {
    expect(points("o/r", rows(5), T0 + 3 * DAY).map((p) => p.number)).toEqual([3, 4, 5]);
  });

  it("тренд — скользящая медиана последних 10 задач; до трёх задач тренда нет", () => {
    expect(trend([1, 5, 3])).toEqual([null, null, 3]);
    const vals = Array.from({ length: 12 }, (_, i) => i + 1);
    // 12-я задача: медиана задач 3…12, первые две из окна вышли
    expect(trend(vals)[11]).toBe(7.5);
    expect(trend(vals)[9]).toBe(5.5);
  });
});

/** Сводка над графиком отвечает на два вопроса флоу одной строкой каждый: сходятся ли оценки и дешевеет ли задача. */
describe("Сводка — точность оценок и цена задачи", () => {
  it("точность — k и доля задач в допуске ×0,5…×2, как в est history", () => {
    const rs = [...rows(8), row(9, { fact_marker: { cov: "partial" } }), row(10, { labels: ["epic"], fact: 40 })];
    const c = view({ "o/r": rs }, null).calib;
    expect(c).toEqual(calib(rs.slice(0, 9)));
    expect(c).toMatchObject({ k: 0.9, n: 8, share: 0.75 });
  });

  it("часы, токены и стоимость задачи — медиана последних 10 задач и её изменение к предыдущим 10", () => {
    const v = view({ "o/r": rows(25) }, null);
    expect(v.h).toEqual({ now: median([1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.4, 2.5]), prev: median([0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]), n: 10 });
    expect(v.usd).toEqual({ now: 4.5, prev: 4.5, n: 10 });
    expect(v.tok).toEqual({ now: 5, prev: 5, n: 10 });
    // предыдущих задач меньше трёх — сравнивать не с чем
    expect(view({ "o/r": rows(4) }, null).h).toEqual({ now: 0.25, prev: null, n: 4 });
  });
});

describe("Страница — один график: часы, токены и стоимость на общей оси времени", () => {
  it("четыре панели с общей осью времени, у каждой своя шкала значений", () => {
    const svg = chartSvg(points("o/r", rows(4, (i) => i / 10).map((r, i) => ({ ...r, fact_marker: { cov: "full", tok: { total: (i + 1) * 20e6 }, usd: (i + 1) * 100 } }))));
    expect([...svg.matchAll(/<g class="panel" data-panel="(\w+)"/g)].map((m) => m[1])).toEqual(["h", "ratio", "tok", "usd"]);
    expect(count(svg, /<g class="x-axis"/g)).toBe(1);
    const ticks = (name: string) => [...panel(svg, name).matchAll(/class="y-tick"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(ticks("h")).toContain("0.1");
    expect(ticks("usd")).toContain("100");
    expect(ticks("usd")).not.toContain("0.1");
    // одна панель — одна шкала: подписи значений только слева
    for (const name of ["h", "ratio", "tok", "usd"]) expect(new Set([...panel(svg, name).matchAll(/class="y-tick" x="([\d.]+)"/g)].map((m) => m[1])).size).toBe(1);
  });

  it("шкала на несколько порядков — только декады: подписи ступеней не налезают друг на друга", () => {
    const wide = [0.02, 0.3, 4, 13].map((fact, i) => row(i + 1, { fact, est_marker: null }));
    const ticks = [...panel(chartSvg(points("o/r", wide)), "h").matchAll(/class="y-tick"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(ticks).toEqual(["0.01", "0.1", "1", "10", "100"]);
  });

  it("задача — точка факта в каждой панели, оценка — вторая точка, связанная с фактом отрезком", () => {
    const svg = chartSvg(points("o/r", [row(1), row(2, { est_marker: null }), row(3, { est_marker: { h: 1 } })]));
    expect(count(panel(svg, "h"), /class="fact"/g)).toBe(3);
    expect(count(panel(svg, "h"), /class="est"/g)).toBe(2);
    expect(count(panel(svg, "h"), /class="link"/g)).toBe(2);
    for (const name of ["tok", "usd"]) {
      expect(count(panel(svg, name), /class="fact"/g)).toBe(3);
      // прогноз токенов и стоимости есть только у оценки задачи 1
      expect(count(panel(svg, name), /class="est"/g)).toBe(1);
    }
  });

  it("панель «факт к оценке» — отношение по задачам с оценкой, линия ×1 и полоса допуска ×0,5…×2", () => {
    const ratio = panel(chartSvg(points("o/r", [row(1, { fact: 0.5 }), row(2, { est_marker: null }), row(3, { fact: 0.6 })])), "ratio");
    // задача 2 без оценки est в панель не входит
    expect(count(ratio, /class="fact"/g)).toBe(2);
    expect(count(ratio, /<line class="ref"/g)).toBe(1);
    expect(count(ratio, /<rect class="band"/g)).toBe(1);
    const ticks = [...ratio.matchAll(/class="y-tick"[^>]*>([^<]+)</g)].map((m) => m[1]);
    // шкала вмещает полосу допуска целиком, хотя обе задачи — у ×1
    expect(ticks).toEqual(["×0.5", "×1", "×2"]);
    const yOf = (label: string) => Number(new RegExp(`class="y-tick" x="[\\d.]+" y="([\\d.]+)">${label}<`).exec(ratio)?.[1]);
    const ref = Number(/<line class="ref"[^>]*y1="([\d.]+)"/.exec(ratio)?.[1]);
    expect(Math.abs(ref + 4 - yOf("×1"))).toBeLessThan(0.2);
  });

  it("линия тренда — в каждой панели, где задач хватает", () => {
    const full = chartSvg(points("o/r", rows(5)));
    for (const name of ["h", "ratio", "tok", "usd"]) expect(count(panel(full, name), /<path class="trend"/g)).toBe(1);
    expect(chartSvg(points("o/r", rows(2)))).not.toContain('class="trend"');
  });

  it("таблица под графиком повторяет значения каждой точки", () => {
    const html = model([row(7, { title: "Экспорт счетов" }), row(8, { est_marker: null })]);
    const table = /<table[\s\S]*<\/table>/.exec(html)?.[0] ?? "";
    const cells = (n: number) => [...(new RegExp(`<tr[^>]*data-task="o/r#${n}"[\\s\\S]*?</tr>`).exec(table)?.[0] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    expect(cells(7)).toEqual(["2026-09-08", "#7 Экспорт счетов", "feat", "0.5", "0.25", "×0.50", "10", "5", "$8.00", "$4.50", "full"]);
    expect(cells(8).slice(3, 6)).toEqual(["—", "0.25", "—"]);
    expect(table).toContain('<a href="https://github.com/o/r/issues/7">');
  });

  it("название задачи — текст: разметка в нём экранируется", () => {
    const html = model([row(1, { title: "<script>alert(1)</script> & <b>жирный</b>" })]);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<b>жирный</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;жирный&lt;/b&gt;");
  });

  it("задач с фактом нет — страница говорит об этом, а не рисует пустой график", () => {
    const html = model([row(1, { fact: null, fact_marker: null })]);
    expect(html).toContain("Закрытых задач с фактом нет");
    expect(html).not.toContain("<svg");
  });
});

// `gh` — внешний край, подменяется он: проект репозитория и его элементы — из мира $FAKE_GH/world.json
// (перечитывается на каждый вызов), PR, эпики задач и задачи с вопросами — его `live`, `fail` — ошибка gh; каждый вызов —
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
  const status = /status:"([^"]+)"/.exec(v.q)?.[1];
  const items = repo.items.filter((it) => it.fieldValues.nodes.some((f) => f.field?.name === "Status" && f.name === status)).map((it) => ({ content: { ...it.content, parent: (l.parents ?? {})[it.content.number] ?? null } }));
  print({ data: { project: { items: { nodes: items } }, repository: { open: { nodes: l.open ?? [] }, merged: { nodes: l.merged ?? [] }, questions: { nodes: l.questions ?? [] } } } });
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

describe("Команда dashboard сервит страницу сама и открывает её в браузере", () => {
  let dir: string;
  let cleanup: () => void;
  let bin: string;
  let running: ChildProcess[];
  const world = (w: { repos: Record<string, { project: number; items: unknown[]; live?: unknown }>; fail?: string }) => writeFileSync(path.join(bin, "world.json"), JSON.stringify(w));
  const ONE = { repos: { "o/a": { project: 1, items: [item(1, "Экспорт счетов", 1), item(2, "Импорт выписок", 2), item(3, "Сверка платежей", 3), item(9, "Биллинг · эпик", 3, "Эпик")] } } };

  beforeEach(() => {
    ({ dir, cleanup } = tmpDir());
    bin = path.join(dir, "bin");
    running = [];
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(dir, "ai-dev"), { recursive: true });
    writeFileSync(path.join(bin, "fake-gh.mjs"), FAKE_GH);
    writeFileSync(path.join(bin, "calls.jsonl"), "");
    // «браузер» — и заданный в BROWSER, и системные open / xdg-open: адрес, с которым его позвали, — в opened
    for (const name of ["gh", "browser", "open", "xdg-open"]) {
      writeFileSync(path.join(bin, name), name === "gh" ? `#!/usr/bin/env bash\nexec bun "$FAKE_GH/fake-gh.mjs" "$@"\n` : `#!/usr/bin/env bash\necho "$@" >> "$FAKE_GH/opened"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    world(ONE);
  });
  afterEach(() => {
    for (const p of running) p.kill("SIGKILL");
    cleanup();
  });

  const env = (extra: Record<string, string> = {}) => ({ ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev"), CLAUDE_CODE_REMOTE: "", PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin, BROWSER: path.join(bin, "browser"), ...extra });
  const itemsReads = () => readFileSync(path.join(bin, "calls.jsonl"), "utf8").split("\n").filter((l) => l.includes("node(id:$id)")).length;
  const opened = () => (existsSync(path.join(bin, "opened")) ? readFileSync(path.join(bin, "opened"), "utf8").trim() : null);
  const sync = (args: string[], extra: Record<string, string> = {}) => spawnSync("bun", [DASHBOARD, ...args], { encoding: "utf8", env: env(extra) });

  /** Запускает дашборд и ждёт строку готовности: страница отдана первому, кто её откроет, решение о браузере принято. */
  function start(args: string[], extra: Record<string, string> = {}): Promise<{ url: string; stdout: () => string }> {
    const p = spawn("bun", [DASHBOARD, ...args], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
    running.push(p);
    let out = "";
    let err = "";
    return new Promise((resolve, reject) => {
      p.stderr!.on("data", (d) => (err += d));
      p.stdout!.on("data", (d) => {
        out += d;
        const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
        if (url && /^браузер: .*$/m.test(out)) resolve({ url, stdout: () => out });
      });
      p.on("exit", (code, signal) => reject(new Error(`dashboard вышел (${code ?? signal}): ${out}${err}`)));
    });
  }
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  }

  it("поднимает сервер на localhost, печатает адрес и открывает его в браузере", async () => {
    const d = await start(["--repo", "o/a"]);
    await until(() => opened() !== null);
    expect(opened()).toBe(d.url);
    const r = await fetch(d.url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("Сессии: задачи в работе");
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
      expect(d.stdout()).toContain("браузер: не открываю");
      expect((await fetch(d.url)).status).toBe(200);
      expect(opened()).toBeNull();
    }
  });

  it("страница отдаёт задачи проекта; повторное открытие в течение минуты GitHub не перечитывает, «Обновить» — перечитывает", async () => {
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
    // после «Обновить» адрес — без refresh: перезагрузка вкладки не перечитывает GitHub заново
    expect(fresh.url).not.toContain("refresh");
  });

  it("--all-repos — задачи всех репозиториев реестра, у задачи назван репозиторий", async () => {
    world({ repos: { "o/a": { project: 1, items: [item(1, "Экспорт счетов", 1)] }, "o/b": { project: 2, items: [item(1, "Поиск по каталогу", 2)] } } });
    writeFileSync(path.join(dir, "ai-dev", "repos.json"), JSON.stringify({ "o/a": {}, "o/b": {} }));
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

  it("вкладка «Сессии» открыта по умолчанию, «Оценка и факт» — второй вкладкой", async () => {
    const d = await start(["--repo", "o/a", "--no-open"]);
    const main = await (await fetch(d.url)).text();
    expect(main).toContain('<nav class="tabs" aria-label="Вкладки"><a href="/" aria-current="page">Сессии</a><a href="/est">Оценка и факт</a></nav>');
    expect(main).toContain("Ждут владельца");
    expect(main).not.toContain("<svg");
    const est = await (await fetch(new URL("/est", d.url))).text();
    expect(est).toContain('<a href="/">Сессии</a>');
    expect(est).toContain('<a href="/est" aria-current="page">Оценка и факт</a>');
    expect(est).toContain("<svg");
    expect((await fetch(new URL("/other", d.url))).status).toBe(404);
  });

  it("«Сессии» — задачи «В работе» проекта с закреплёнными сессиями из транскриптов и PR из GitHub; страница обновляется сама", async () => {
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
    mkdirSync(path.join(dir, "ai-dev", "sessions"), { recursive: true });
    writeFileSync(path.join(dir, "ai-dev", "sessions", "s5"), "o/a#5\n");
    writeFileSync(path.join(dir, "ai-dev", "repos.json"), JSON.stringify({ "o/a": { paths: ["/work/a"] } }));
    const commit = (state: string) => ({ nodes: [{ commit: { messageBody: "", statusCheckRollup: { state } } }] });
    world({
      repos: {
        "o/a": {
          project: 1,
          items: [...ONE.repos["o/a"].items, openItem(5, "Импорт банков", "В работе"), openItem(6, "Отчёт по ROI", "В работе"), openItem(10, "Банки · эпик", "В работе", "Эпик"), openItem(11, "Поиск", "Бэклог")],
          live: {
            open: [{ number: 50, url: "https://github.com/o/a/pull/50", headRefName: "feat/5-bank-import", mergeable: "MERGEABLE", closingIssuesReferences: { nodes: [{ number: 5 }] }, commits: commit("SUCCESS") }],
            parents: { 5: { number: 10, title: "Банки · эпик" } },
            questions: [{ number: 6, title: "Отчёт по ROI", body: "## Вопросы\n1. Валюта отчёта?\n" }],
          },
        },
      },
    });
    const d = await start(["--repo", "o/a", "--no-open"]);
    const html = await (await fetch(d.url)).text();
    const row = (n: number) => (new RegExp(`<tr[^>]*data-task="o/a#${n}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(row(5)).toContain("эпик #10 Банки · эпик");
    expect(row(5)).toContain("2 мин назад");
    expect(row(5)).toContain("мерж");
    expect(row(5)).toContain("#50 чеки зелёные");
    expect(row(6)).toContain("сессии нет");
    // эпик и задача не «В работе» — не строки
    expect(html).not.toContain('data-task="o/a#10"');
    expect(html).not.toContain('data-task="o/a#11"');
    const asks = /<section class="asks[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    for (const q of ["Осталось: мерж — от владельца.", "1. Делить импорт?", "1. Валюта отчёта?"]) expect(asks).toContain(q);
    // обновляется сама: раз в 30 с страница заново, подменой <main> — раскрытое остаётся раскрытым
    expect(html).toMatch(/<\/main><script>[\s\S]*replaceWith[\s\S]*setInterval\([^\n]*, 30000\);[\s\S]*<\/script>/);
  });

  it("в облачной сессии — ошибка с объяснением, а не сбой gh", () => {
    const r = sync(["--repo", "o/a", "--no-open"], { CLAUDE_CODE_REMOTE: "true" });
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain("docs/cloud-sessions.md");
    expect(readFileSync(path.join(bin, "calls.jsonl"), "utf8")).toBe("");
  });

  it("неизвестный параметр — код 2, --help — справка", () => {
    expect(exitOf(sync(["--bogus"]))).toBe(2);
    expect(sync(["--since", "вчера", "--no-open"]).stderr).toContain("неверный период «вчера»");
    const help = sync(["--help"]);
    expect(exitOf(help)).toBe(0);
    expect(help.stdout).toContain("dashboard [--repo o/r | --all-repos]");
    expect(sync(["--repo", "o/a", "--all-repos"]).stderr).toContain("--repo и --all-repos несовместимы");
  });

  it("занятый порт — ошибка с подсказкой, а не трасса", async () => {
    const d = await start(["--repo", "o/a", "--no-open"]);
    const r = sync(["--repo", "o/a", "--no-open", "--port", new URL(d.url).port]);
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain(`ошибка: порт ${new URL(d.url).port} занят`);
  });
});
