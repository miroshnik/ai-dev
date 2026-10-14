import { describe, expect, it } from "bun:test";

import { chartSvg, page, points, trend, view } from "../../../skills/dashboard/scripts/dashboard.ts";
import { calib, historyTable, median, waitsHistoryLine } from "../../../skills/est/scripts/est.ts";
import type { Row, Waits } from "../../../skills/est/scripts/est.ts";

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
      { repo: "o/r", number: 1, title: "Задача 1", url: "https://github.com/o/r/issues/1", t: T0 + DAY, type: "feat", cov: "full", est: 0.5, fact: 0.25, tokEst: 10, tok: 5, usdEst: 8, usd: 4.5, usdModels: null, waits: null },
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

  it("доля $ по моделям последних 10 задач и предыдущих 10: тренд стоимости смешивает флоу с тарифом модели", () => {
    const by = (models: Record<string, number>) => ({ cov: "full", tok: { total: 5_000_000 }, usd: 4.5, type: "feat", models: Object.fromEntries(Object.entries(models).map(([m, usd]) => [m, { mtok: 1, usd }])) });
    const rs = Array.from({ length: 20 }, (_, i) => row(i + 1, { fact_marker: i < 10 ? by({ "claude-fable-5": 3, "claude-opus-5": 1 }) : by({ "claude-opus-5-5": 1 }) }));
    expect(view({ "o/r": rs }, null).models).toEqual({ now: [["claude-opus-5-5", 1]], prev: [["claude-fable-5", 0.75], ["claude-opus-5", 0.25]] });
    const html = model(rs);
    expect(html).toContain("Cost by model");
    expect(html).toContain("claude-fable-5 75 %, claude-opus-5 25 %");
    expect(html).toContain("the $ trend mixes the flow with the model&#39;s rate");
  });
});

/**
 * Ожидания задачи — CI, после мержа и деплоя, локальные проверки с очередью slot — замеряются, чтобы их ускорять (#518):
 * история и дашборд показывают их у каждой задачи и медианы последних задач против предыдущих.
 */
describe("Ожидания задач — в est history и на дашборде", () => {
  it("est history и дашборд показывают ожидания задач и их медианы", () => {
    const fm = (ci: number) => ({ cov: "full", tok: { total: 5_000_000 }, usd: 4.5, type: "feat", waits: { ci, merged: 2, checks: 6, slot: 1, rest: 10 } });
    // 12 задач с разбивкой, CI — 1…12 мин; задача 13 — факт до разбивки: прочерки, в медианы не входит
    const rs = [...Array.from({ length: 12 }, (_, i) => row(i + 1, { fact_marker: fm(i + 1) })), row(13)];
    const lines = historyTable(rs);
    expect(lines[0]).toContain("|  CI | merge | checks | slot | ");
    expect(lines[1]).toMatch(/ \|\s+1 \|\s+2 \|\s+6 \|\s+1 \| feat/);
    expect(lines[13]).toMatch(/ \|\s+— \|\s+— \|\s+— \|\s+— \| feat/);
    // медиана последних 10 задач: CI 3…12 — 7.5
    expect(waitsHistoryLine(rs)).toBe("waits, median of the last 10 tasks: CI 8 min · after the merge 2 · checks 6 (slot queue 1) · rest 10");
    const v = view({ "o/r": rs }, null);
    expect(v.waitKinds).toEqual({ now: { ci: 7.5, merged: 2, checks: 6, slot: 1, rest: 10 }, prev: null, n: 10 });
    expect(v.waits).toEqual({ now: 15.5, prev: null, n: 10 }); // CI + после мержа + проверки
    const html = model(rs);
    expect(html).toContain("Waits per task: CI, merge, checks");
    expect(html).toContain("CI 8 min · after the merge 2 · checks 6 (slot queue 1) · rest 10");
    const table = /<table[\s\S]*<\/table>/.exec(html)?.[0] ?? "";
    expect(table).toContain("<th>Wait for CI, min</th><th>After the merge, min</th><th>Checks, min (slot)</th>");
    expect(table).toMatch(/data-task="o\/r#3"[\s\S]*?<td>3<\/td><td>2<\/td><td>6 \(1\)<\/td>/);
  });
});

/** Факт с разбивкой по ожиданиям, минуты (#518). */
const split = (w: Partial<Waits>) => ({ cov: "full", tok: { total: 5_000_000 }, usd: 4.5, type: "feat", waits: { ci: 0, merged: 0, checks: 0, slot: 0, rest: 0, ...w } });
/** Столбик задачи на панели разбивки: верх каждого сегмента по классу; низ первого — нулевая линия шкалы. */
const bar = (svg: string, i: number) => {
  const g = new RegExp(`<g class="bar" data-i="${i}">([\\s\\S]*?)</g>`).exec(panel(svg, "waits"))?.[1];
  if (g === undefined) return null;
  const segs = [...g.matchAll(/<rect class="seg (\w+)" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map((m) => ({ part: m[1]!, top: Number(m[2]), bottom: Number(m[2]) + Number(m[3]) }));
  return { parts: segs.map((s) => s.part), top: Object.fromEntries(segs.map((s) => [s.part, s.top])), base: segs[0]!.bottom };
};
/** Данные подсказки страницы: строки по задачам. */
const hover = (html: string) => JSON.parse(/<script id="pts" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as { pts: { rows: [string, string][] }[] };
/** Линия тренда панели (последняя: первая — образец в легенде): точки пути и подпись на её конце. */
const trendOf = (svg: string) => {
  const p = panel(svg, "waits");
  const d = [...p.matchAll(/<path class="trend" d="([^"]+)"/g)].pop()?.[1] ?? "";
  return { ys: [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1])), end: /class="end-label"[^>]*>([^<]+)</.exec(p)?.[1] };
};
/** Высота доли на правой шкале панели разбивки — по подписям «0 %» и «100 %». */
const shareY = (svg: string, share: number) => {
  const at = (label: string) => Number(new RegExp(`class="y-tick-r" x="[\\d.]+" y="([\\d.]+)">${label}<`).exec(panel(svg, "waits"))?.[1]) - 4;
  return at("0 %") + (at("100 %") - at("0 %")) * share;
};

/**
 * Из чего складывается факт задачи и как это меняется со временем (#532): столбик на задачу из частей разбивки
 * факта на линейной шкале и скользящая медиана доли ожиданий на второй шкале, в процентах.
 */
describe("Панель разбивки факта по задачам во времени", () => {
  it("панель разбивки факта показывает по каждой закрытой задаче ожидание CI на PR, после мержа, проверки и остальное", () => {
    const rs = [row(1, { fact: 1, fact_marker: split({ ci: 10, merged: 5, checks: 15, slot: 5, rest: 30 }) }), row(2, { fact: 0.5, fact_marker: split({ ci: 6, checks: 4, rest: 20 }) })];
    const svg = chartSvg(points("o/r", rs));
    expect([...svg.matchAll(/<g class="panel" data-panel="(\w+)"/g)].map((m) => m[1])).toEqual(["h", "ratio", "tok", "usd", "waits"]);
    const b1 = bar(svg, 0)!;
    // снизу вверх: ожидания — от нулевой линии, сравнимы между задачами; проверки без очереди slot — отдельно от неё
    expect(b1.parts).toEqual(["ci", "merged", "checks", "slot", "rest"]);
    // шкала линейная: высота от нуля до верха каждого сегмента пропорциональна минутам до него — 10, 15, 25, 30, 60
    const cum: Record<string, number> = { ci: 10, merged: 15, checks: 25, slot: 30, rest: 60 };
    const perMin = (b1.base - b1.top.rest!) / 60;
    for (const [part, m] of Object.entries(cum)) expect(Math.abs(b1.base - b1.top[part]! - m * perMin)).toBeLessThan(0.2);
    // части без минут не рисуются; столбик задачи 2 — вдвое ниже: 30 минут против 60
    const b2 = bar(svg, 1)!;
    expect(b2.parts).toEqual(["ci", "checks", "rest"]);
    expect(Math.abs(b2.base - b2.top.rest! - 30 * perMin)).toBeLessThan(0.2);
    expect([...panel(svg, "waits").matchAll(/class="y-tick"[^>]*>([^<]+)</g)].map((m) => m[1])[0]).toBe("0");
    // подсказка и таблица называют каждую часть
    const html = model(rs);
    expect(hover(html).pts[0]!.rows).toContainEqual(["Waits, min", "CI 10 min · after the merge 5 · checks 15 (slot queue 5) · rest 30"]);
    expect(hover(html).pts[0]!.rows).toContainEqual(["Waits share", "50 %"]);
    expect(html).toMatch(/data-task="o\/r#1"[\s\S]*?<td>10<\/td><td>5<\/td><td>15 \(5\)<\/td><td>30<\/td>/);
  });

  it("задача без разбивки в маркере на панели не выглядит нулём", () => {
    // доли ожиданий задач с разбивкой — 40, 60 и 60 %; задача 2 — факт до разбивки
    const rs = [row(1, { fact_marker: split({ ci: 4, rest: 6 }) }), row(2), row(3, { fact_marker: split({ ci: 6, rest: 4 }) }), row(4, { fact_marker: split({ checks: 6, rest: 4 }) })];
    const svg = chartSvg(points("o/r", rs));
    // на её месте — пустота, а не столбик нулевой высоты
    expect(bar(svg, 1)).toBeNull();
    expect([0, 2, 3].map((i) => bar(svg, i) !== null)).toEqual([true, true, true]);
    // в медиану доли она не входит: с нулём медиана была бы 50 %
    expect(trendOf(svg).end).toBe("60 %");
    // подсказка объясняет пустоту
    const rows2 = hover(model(rs)).pts[1]!.rows;
    expect(rows2.find(([label]) => label === "Waits")?.[1]).toContain("no split");
    expect(rows2.map(([label]) => label)).not.toContain("Waits share");
  });

  it("тренд панели — скользящая медиана по последним 10 задачам, как на остальных панелях", () => {
    // 12 задач с разбивкой, доля ожиданий задачи i — 4·i %; задача без разбивки посередине окна не сдвигает
    const rs = Array.from({ length: 12 }, (_, i) => row(i + 1, { fact_marker: split({ ci: 4 * (i + 1), rest: 100 - 4 * (i + 1) }) }));
    rs.splice(6, 0, row(50, { closedAt: T0 + 6.5 * DAY }));
    const svg = chartSvg(points("o/r", rs));
    const want = trend(Array.from({ length: 12 }, (_, i) => 0.04 * (i + 1))).filter((v): v is number => v !== null);
    const t = trendOf(svg);
    // до третьей задачи тренда нет; дальше — медиана последних 10: у 12-й — задач 3…12, 30 %
    expect(t.ys.length).toBe(10);
    t.ys.forEach((y, k) => expect(Math.abs(y - shareY(svg, want[k]!))).toBeLessThan(0.2));
    expect(want[9]).toBeCloseTo(0.3);
    expect(t.end).toBe("30 %");
  });
});

describe("Страница — один график: часы, токены и стоимость на общей оси времени", () => {
  it("пять панелей с общей осью времени, у каждой своя шкала значений", () => {
    const svg = chartSvg(points("o/r", rows(4, (i) => i / 10).map((r, i) => ({ ...r, fact_marker: { ...split({ ci: 5, rest: 10 }), tok: { total: (i + 1) * 20e6 }, usd: (i + 1) * 100 } }))));
    expect([...svg.matchAll(/<g class="panel" data-panel="(\w+)"/g)].map((m) => m[1])).toEqual(["h", "ratio", "tok", "usd", "waits"]);
    expect(count(svg, /<g class="x-axis"/g)).toBe(1);
    const ticks = (name: string) => [...panel(svg, name).matchAll(/class="y-tick"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(ticks("h")).toContain("0.1");
    expect(ticks("usd")).toContain("100");
    expect(ticks("usd")).not.toContain("0.1");
    // одна панель — одна шкала значений: подписи только слева; справа у разбивки — доля ожиданий, 0…100 %
    for (const name of ["h", "ratio", "tok", "usd", "waits"]) expect(new Set([...panel(svg, name).matchAll(/class="y-tick" x="([\d.]+)"/g)].map((m) => m[1])).size).toBe(1);
    expect([...panel(svg, "waits").matchAll(/class="y-tick-r"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["0 %", "50 %", "100 %"]);
    for (const name of ["h", "ratio", "tok", "usd"]) expect(panel(svg, name)).not.toContain("y-tick-r");
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

  it("панель «Actual to estimate» — отношение по задачам с оценкой, линия ×1 и полоса допуска ×0,5…×2", () => {
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
    expect(cells(7)).toEqual(["2026-09-08", "#7 Экспорт счетов", "feat", "0.5", "0.25", "×0.50", "10", "5", "$8.00", "$4.50", "—", "—", "—", "—", "full"]);
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
    expect(html).toContain("No closed tasks with an actual");
    expect(html).not.toContain("<svg");
  });
});
