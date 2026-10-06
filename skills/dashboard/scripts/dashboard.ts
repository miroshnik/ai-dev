#!/usr/bin/env bun
/**
 * dashboard — страница задач в две вкладки: «Сессии» (главная) — задачи «В работе», их сессии и чего они ждут;
 * «Оценка и факт» — график оценки, факта, токенов и стоимости по времени закрытия.
 *
 *   dashboard [--repo o/r | --all-repos] [--since 90d] [--port N] [--no-open]
 *
 * Сервит страницу сам (Bun.serve, только 127.0.0.1), печатает адрес и открывает его в браузере. Данные — строки
 * проекта GitHub (поля и маркеры комментариев «Оценка» и «Факт») через скрипт est рядом, закрепления и транскрипты
 * сессий (sessions.ts); в GitHub ничего не пишет. Страница собирается на сервере: SVG строкой, без зависимостей; в
 * браузере — только подсказка при наведении.
 */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import { calib, EstError, fmtH, fmtLocal, loadRegistry, median, parseSince, Repo, resolveRepo, sharesTxt, TARIFF_NOTE, usdByModel, usdShares } from "../../est/scripts/est.ts";
import type { Registry, Row } from "../../est/scripts/est.ts";
import { findTranscripts, liveQuery, readPins, RECENT, REFRESH, refreshScript, repoTranscripts, SESSIONS_CSS, sessionsBody, sessionsView } from "./sessions.ts";
import type { Live, SessionsInput, SessionsView } from "./sessions.ts";

const DAY = 86400;
/** Окно тренда и сводки: последние 10 закрытых задач; медиана меньше чем по трём — шум, её нет. */
const WINDOW = 10;
const MIN_TREND = 3;
/** GitHub перечитывается при открытии страницы, но не чаще раза в минуту; «Обновить» — сразу. */
const TTL = 60;

// ----------------------------------------------------------------------------
// Данные
// ----------------------------------------------------------------------------

/** Задача на графике. Оценка и прогноз — только из маркера est: оценки без него — в других единицах. */
export interface Point {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Время закрытия, epoch-секунды. */
  t: number;
  type: string;
  cov: string;
  est: number | null;
  fact: number;
  tokEst: number | null;
  /** Токены факта, млн. */
  tok: number | null;
  usdEst: number | null;
  usd: number | null;
  /** $ факта по моделям; null — факт посчитан до разбивки по моделям. */
  usdModels: Record<string, number> | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isEpic = (r: Row) => r.labels.includes("epic") || ["эпик", "epic"].includes((r.issueType ?? "").toLowerCase());

/** Закрытые задачи периода без эпиков: эпик — сумма подзадач, они уже в списке. */
function taskRows(rows: Row[], since: number | null): Row[] {
  return rows.filter((r) => r.state === "CLOSED" && r.closedAt !== null && !isEpic(r) && (since === null || r.closedAt >= since));
}

/** Точки графика — закрытые задачи с фактом, по времени закрытия. */
export function points(repo: string, rows: Row[], since: number | null = null): Point[] {
  const out: Point[] = [];
  for (const r of taskRows(rows, since)) {
    if (r.fact === null) continue;
    const em = r.est_marker;
    const fm = r.fact_marker ?? {};
    const tok = num(fm.tok?.total);
    out.push({
      repo, number: r.number, title: r.title, url: `https://github.com/${repo}/issues/${r.number}`, t: r.closedAt!,
      type: fm.type || em?.type || "", cov: fm.cov || "—",
      est: em ? num(em.h) || r.est || null : null, fact: r.fact,
      tokEst: num(em?.tok), tok: tok === null ? null : tok / 1e6,
      usdEst: num(em?.usd), usd: num(fm.usd), usdModels: fm.models ? usdByModel([fm]) : null,
    });
  }
  return out.sort((a, b) => a.t - b.t || a.number - b.number);
}

/** Скользящая медиана последних `window` значений; пока значений меньше `min` — тренда нет. */
export function trend(vals: number[], window = WINDOW, min = MIN_TREND): (number | null)[] {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - window + 1), i + 1);
    return w.length < min ? null : median(w);
  });
}

/** Медиана последних задач и предыдущих: `prev` нет, пока сравнивать не с чем. */
export interface Shift {
  now: number | null;
  prev: number | null;
  n: number;
}

function shift(vals: number[]): Shift {
  const last = vals.slice(-WINDOW);
  const before = vals.slice(-2 * WINDOW, -WINDOW);
  return { now: last.length ? median(last) : null, prev: before.length >= MIN_TREND ? median(before) : null, n: last.length };
}

/** Доли $ по моделям последних задач и предыдущих: сдвиг тарифа рядом с трендом стоимости. */
export interface ModelShift {
  now: [string, number][];
  prev: [string, number][];
}

function modelShares(pts: Point[]): [string, number][] {
  const sum: Record<string, number> = {};
  for (const p of pts) for (const [m, v] of Object.entries(p.usdModels ?? {})) sum[m] = (sum[m] ?? 0) + v;
  return usdShares(sum);
}

export interface View {
  points: Point[];
  /** Точность оценок — k и доля в допуске, как в `est history`. */
  calib: ReturnType<typeof calib>;
  h: Shift;
  tok: Shift;
  usd: Shift;
  models: ModelShift;
}

/** Всё, что показывает страница: точки, точность оценок и медианы последних задач — по строкам проектов репозиториев. */
export function view(rowsByRepo: Record<string, Row[]>, since: number | null): View {
  const pts = Object.entries(rowsByRepo).flatMap(([repo, rows]) => points(repo, rows, since)).sort((a, b) => a.t - b.t);
  const vals = (f: (p: Point) => number | null) => pts.map(f).filter((v): v is number => v !== null);
  return {
    points: pts,
    calib: calib(Object.values(rowsByRepo).flatMap((rows) => taskRows(rows, since))),
    h: shift(vals((p) => p.fact)),
    tok: shift(vals((p) => p.tok)),
    usd: shift(vals((p) => p.usd)),
    models: { now: modelShares(pts.slice(-WINDOW)), prev: pts.length - WINDOW >= MIN_TREND ? modelShares(pts.slice(-2 * WINDOW, -WINDOW)) : [] },
  };
}

// ----------------------------------------------------------------------------
// График
// ----------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r1 = (x: number) => Math.round(x * 10) / 10;
const two = (n: number) => String(n).padStart(2, "0");
const fmtUsd = (v: number) => `$${v.toFixed(2)}`;
const fmtTok = (v: number) => fmtH(v, 2);

interface Panel {
  key: "h" | "ratio" | "tok" | "usd";
  title: string;
  fact: (p: Point) => number | null;
  est: (p: Point) => number | null;
  /** Подпись ступени шкалы и подпись значения в конце тренда. */
  tick: (v: number) => string;
  fmt: (v: number) => string;
  /** Опорная линия и полоса допуска — у панели отношения. */
  ref?: { at: number; band: [number, number] };
}

const none = () => null;
const times = (v: number) => `×${fmtH(v)}`;
// ступени шкалы — круглые числа любой величины (0.001, 20): fmtH округлил бы малые до нуля
const tick = (v: number) => String(v);
// Панели, а не несколько шкал на одной: часы, отношение, токены и доллары — разные единицы (tests/capabilities/dashboard).
const PANELS: Panel[] = [
  { key: "h", title: "Часы на задачу", fact: (p) => p.fact, est: (p) => p.est, tick, fmt: (v) => fmtH(v) },
  { key: "ratio", title: "Факт к оценке — полоса допуска ×0.5…×2", fact: (p) => (p.est ? p.fact / p.est : null), est: none, tick: (v) => `×${v}`, fmt: times, ref: { at: 1, band: [0.5, 2] } },
  { key: "tok", title: "Токены на задачу, млн", fact: (p) => p.tok, est: (p) => p.tokEst, tick, fmt: fmtTok },
  { key: "usd", title: "Стоимость задачи, $", fact: (p) => p.usd, est: (p) => p.usdEst, tick, fmt: (v) => v.toFixed(v < 10 ? 2 : 0) },
];

// Геометрия в единицах viewBox: слева — подписи шкалы, справа — подпись конца тренда, снизу — общая ось времени.
const W = 1080;
const LEFT = 56;
const RIGHT = 64;
const HEAD = 28;
const PLOT = 150;
const GAP = 18;
const AXIS = 30;
const PANEL_H = HEAD + PLOT + GAP;
const HEIGHT = PANELS.length * PANEL_H + AXIS;

/** Ступени логарифмической шкалы, покрывающие [lo, hi]: ряд 1–2–5, а если ступеней больше семи — только декады. */
function logTicks(lo: number, hi: number): number[] {
  const cover = (mantissas: number[]) => {
    const all: number[] = [];
    for (let k = Math.floor(Math.log10(lo)) - 1; k <= Math.ceil(Math.log10(hi)) + 1; k++) for (const m of mantissas) all.push(Number((m * 10 ** k).toPrecision(12)));
    const from = all.filter((t) => t <= lo).pop()!;
    const to = all.find((t) => t >= hi && t > from)!;
    return all.filter((t) => t >= from && t <= to);
  };
  const fine = cover([1, 2, 5]);
  return fine.length > 7 ? cover([1]) : fine;
}

/** Отметки оси времени — местные полуночи с шагом, при котором их не больше восьми. */
function timeTicks(t0: number, t1: number): number[] {
  const step = [1, 2, 7, 14, 30, 60, 90, 180].find((s) => (t1 - t0) / DAY / s <= 8) ?? 365;
  const d = new Date(t0 * 1000);
  const out: number[] = [];
  for (let i = 1; ; i += step) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime() / 1000;
    if (t > t1) break;
    out.push(t);
  }
  return out.length ? out : [(t0 + t1) / 2];
}

interface Layout {
  x: (t: number) => number;
  ticks: number[];
}

function layout(pts: Point[]): Layout {
  const min = pts[0]!.t;
  const max = pts[pts.length - 1]!.t;
  const pad = Math.max((max - min) * 0.03, DAY / 4);
  const [t0, t1] = [min - pad, max + pad];
  return { x: (t) => LEFT + ((t - t0) / (t1 - t0)) * (W - LEFT - RIGHT), ticks: timeTicks(t0, t1) };
}

/** Панель: сетка, отрезки «оценка — факт», кольца оценок, линия тренда и точки факта; `ys` — высота точки факта по задачам. */
function panelSvg(p: Panel, i: number, pts: Point[], lay: Layout): { svg: string; ys: (number | null)[] } {
  const top = i * PANEL_H + HEAD;
  const pos = (v: number | null): v is number => v !== null && v > 0;
  const values = pts.flatMap((pt) => [p.fact(pt), p.est(pt)]).filter(pos);
  if (values.length && p.ref) values.push(...p.ref.band);
  const out = [`<g class="panel" data-panel="${p.key}">`, `<text class="panel-title" x="${LEFT}" y="${top - 10}">${esc(p.title)}</text>`];
  if (!values.length) {
    out.push(`<text class="empty" x="${LEFT}" y="${top + PLOT / 2}">нет данных</text>`, "</g>");
    return { svg: out.join(""), ys: pts.map(() => null) };
  }
  const ticks = logTicks(Math.min(...values), Math.max(...values));
  const [lo, hi] = [Math.log10(ticks[0]!), Math.log10(ticks[ticks.length - 1]!)];
  const y = (v: number) => r1(top + PLOT - ((Math.log10(v) - lo) / (hi - lo)) * PLOT);
  if (p.ref) out.push(`<rect class="band" x="${LEFT}" y="${y(p.ref.band[1])}" width="${W - LEFT - RIGHT}" height="${r1(y(p.ref.band[0]) - y(p.ref.band[1]))}"/>`);
  for (const t of lay.ticks) out.push(`<line class="grid" x1="${r1(lay.x(t))}" x2="${r1(lay.x(t))}" y1="${top}" y2="${top + PLOT}"/>`);
  for (const t of ticks) out.push(`<line class="grid" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(t)}" y2="${y(t)}"/>`, `<text class="y-tick" x="${LEFT - 8}" y="${y(t) + 4}">${p.tick(t)}</text>`);
  if (p.ref) out.push(`<line class="ref" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(p.ref.at)}" y2="${y(p.ref.at)}"/>`);
  const facts = pts.map((pt) => ({ x: r1(lay.x(pt.t)), fact: p.fact(pt), est: p.est(pt) }));
  for (const f of facts) {
    if (!pos(f.fact) || !pos(f.est)) continue;
    out.push(`<line class="link" x1="${f.x}" x2="${f.x}" y1="${y(f.est)}" y2="${y(f.fact)}"/>`, `<circle class="est" cx="${f.x}" cy="${y(f.est)}" r="3.5"/>`);
  }
  const drawn = facts.filter((f) => pos(f.fact));
  const line = trend(drawn.map((f) => f.fact as number)).map((v, k) => (v === null ? null : { x: drawn[k]!.x, y: y(v), v })).filter((v) => v !== null);
  const end = line[line.length - 1];
  if (end) out.push(`<path class="trend" d="${line.map((q, k) => `${k ? "L" : "M"}${q.x} ${q.y}`).join("")}"/>`, `<text class="end-label" x="${end.x + 10}" y="${end.y + 4}">${p.fmt(end.v)}</text>`);
  const ys = facts.map((f) => (pos(f.fact) ? y(f.fact) : null));
  facts.forEach((f, k) => ys[k] !== null && out.push(`<circle class="fact" data-i="${k}" cx="${f.x}" cy="${ys[k]}" r="4"/>`));
  out.push("</g>");
  return { svg: out.join(""), ys };
}

interface Chart {
  svg: string;
  /** Точки для подсказки: абсцисса и высоты факта по панелям в единицах viewBox. */
  hover: { x: number; y: (number | null)[] }[];
}

function chart(pts: Point[]): Chart {
  if (!pts.length) return { svg: "", hover: [] };
  const lay = layout(pts);
  const panels = PANELS.map((p, i) => panelSvg(p, i, pts, lay));
  const axisY = PANELS.length * PANEL_H - GAP;
  const axis = lay.ticks.map((t) => {
    const d = new Date(t * 1000);
    return `<text class="x-tick" x="${r1(lay.x(t))}" y="${axisY + 20}">${two(d.getDate())}.${two(d.getMonth() + 1)}</text>`;
  });
  const svg = [
    `<svg class="chart" viewBox="0 0 ${W} ${HEIGHT}" role="img" aria-label="Часы, токены и стоимость задач по дате закрытия; значения — в таблице ниже">`,
    ...panels.map((p) => p.svg),
    `<g class="x-axis">${axis.join("")}</g>`,
    `<line class="crosshair" x1="0" x2="0" y1="${HEAD}" y2="${axisY}" visibility="hidden"/>`,
    "</svg>",
  ].join("");
  return { svg, hover: pts.map((pt, k) => ({ x: r1(lay.x(pt.t)), y: panels.map((p) => p.ys[k] ?? null) })) };
}

/** График: панели с общей осью времени — часы, факт к оценке, токены, стоимость; задач нет — пустая строка. */
export function chartSvg(pts: Point[]): string {
  return chart(pts).svg;
}

// ----------------------------------------------------------------------------
// Страница
// ----------------------------------------------------------------------------

export interface Model {
  repos: string[];
  /** Период страницы: `30d`, `90d`…; пусто или `all` — всё время. */
  since: string;
  view: View;
  /** Когда прочитан GitHub, epoch-секунды. */
  at: number;
  errors: string[];
}

const PRESETS: [string, string][] = [["30d", "30 дней"], ["90d", "90 дней"], ["all", "всё время"]];

// Палитра — проверенная пара «синий / оранжевый» и служебные тона для светлой и тёмной темы.
const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--fact:#2a78d6;--trend:#eb6834;--good:#006300;--bad:#b42c2c;--warn:#f2b53a}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--fact:#3987e5;--trend:#d95926;--good:#0ca30c;--bad:#e66767;--warn:#e0a52c}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 4px}
.tabs{display:flex;gap:4px;margin:0 0 16px;border-bottom:1px solid var(--border)}
.tabs a{padding:6px 12px;margin-bottom:-1px;text-decoration:none;color:var(--ink2);border-bottom:2px solid transparent}
.tabs a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
a{color:inherit}
.sub,.filters,figcaption,.note{color:var(--ink2)}
.filters{margin:16px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.filters a{padding:3px 10px;border-radius:999px;border:1px solid var(--border);text-decoration:none}
.filters a.cur{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin:0 0 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:0 0 16px}
.tile{margin:0}
.tile .label{color:var(--ink2)}
.tile .value{font-size:28px;font-weight:600;line-height:1.2;margin:2px 0}
.tile .delta,.tile .hint{font-size:13px;color:var(--ink2)}
.delta.good{color:var(--good)}.delta.bad{color:var(--bad)}
.errors{border-color:var(--bad)}
figure{position:relative}
figcaption{display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin:0 0 8px;font-size:13px}
.key{display:inline-flex;align-items:center;gap:6px}
.key svg{width:22px;height:12px}
svg.chart{display:block;width:100%;height:auto;touch-action:pan-y}
.chart text{font-size:12px;fill:var(--muted);font-variant-numeric:tabular-nums}
.chart .panel-title{font-size:13px;font-weight:600;fill:var(--ink)}
.chart .y-tick{text-anchor:end}.chart .x-tick{text-anchor:middle}
.chart .end-label{fill:var(--ink);font-weight:600}
.grid{stroke:var(--grid);stroke-width:1}
.band{fill:var(--ink);opacity:.05}
.ref{stroke:var(--muted);stroke-width:1}
.link{stroke:var(--axis);stroke-width:1}
.est{fill:var(--surface);stroke:var(--fact);stroke-width:1.5}
.fact{fill:var(--fact);stroke:var(--surface);stroke-width:2}
.fact.hl{r:6}
.trend{fill:none;stroke:var(--trend);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.crosshair{stroke:var(--axis);stroke-width:1}
#tip{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:13px;max-width:320px;z-index:1}
#tip .head{font-weight:600}#tip .when{color:var(--ink2);margin-bottom:4px}
#tip .row{display:flex;justify-content:space-between;gap:16px}#tip .row span{color:var(--ink2)}#tip .row b{font-weight:600}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--grid);white-space:nowrap}
th{color:var(--ink2);font-weight:500;font-size:13px;white-space:normal;vertical-align:bottom}
th:nth-child(-n+3),td:nth-child(-n+3){text-align:left}
td:nth-child(2){white-space:normal;min-width:220px}
tr.hl td{background:var(--page)}
${SESSIONS_CSS}`;

// Подсказка: ближайшая к курсору задача (по горизонтали — вчетверо строже, чем по вертикали), перекрестие и её строка в таблице.
const SCRIPT = `
(() => {
  const svg = document.querySelector("svg.chart"); if (!svg) return;
  const data = JSON.parse(document.getElementById("pts").textContent);
  const tip = document.getElementById("tip"), cross = svg.querySelector(".crosshair"), fig = svg.parentElement;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  let cur = -1;
  const mark = (i, on) => {
    svg.querySelectorAll('.fact[data-i="' + i + '"]').forEach((c) => c.classList.toggle("hl", on));
    const row = document.querySelector('tr[data-task="' + CSS.escape(data.pts[i].task) + '"]'); if (row) row.classList.toggle("hl", on);
  };
  const hide = () => { if (cur >= 0) mark(cur, false); cur = -1; tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect(), k = data.w / box.width;
    const x = (ev.clientX - box.left) * k, y = (ev.clientY - box.top) * k;
    let best = -1, dist = Infinity;
    data.pts.forEach((p, i) => p.y.forEach((py) => { if (py === null) return; const d = (p.x - x) ** 2 + (py - y) ** 2 / 16; if (d < dist) { dist = d; best = i; } }));
    if (best < 0) return hide();
    if (best !== cur) {
      if (cur >= 0) mark(cur, false);
      cur = best; mark(cur, true);
      const p = data.pts[cur];
      tip.replaceChildren(el("div", "head", p.head), el("div", "when", p.when), ...p.rows.map(([label, value]) => { const r = el("div", "row"); r.append(el("span", "", label), el("b", "", value)); return r; }));
      cross.setAttribute("x1", p.x); cross.setAttribute("x2", p.x); cross.setAttribute("visibility", "visible");
    }
    tip.hidden = false;
    const f = fig.getBoundingClientRect(), left = ev.clientX - f.left + 14;
    tip.style.left = Math.max(0, left + tip.offsetWidth > f.width ? left - tip.offsetWidth - 28 : left) + "px";
    const top = ev.clientY - f.top + 14;
    tip.style.top = (ev.clientY + 14 + tip.offsetHeight > innerHeight ? top - tip.offsetHeight - 28 : top) + "px";
  });
  svg.addEventListener("pointerleave", hide);
})();
`;

const taskId = (p: Point) => `${p.repo}#${p.number}`;
const dash = (v: number | null, f: (v: number) => string) => (v === null ? "—" : f(v));
const ratio = (p: Point) => (p.est ? `×${(p.fact / p.est).toFixed(2)}` : "—");
const pair = (est: number | null, fact: number | null, f: (v: number) => string) => (est === null ? dash(fact, f) : `${f(est)} → ${dash(fact, f)}`);

function tile(label: string, value: string, delta: string, hint: string): string {
  return `<figure class="tile card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${delta}<div class="hint">${esc(hint)}</div></figure>`;
}

/** Плитка величины: медиана последних задач и её изменение к предыдущим; меньше — лучше, знак дублирует цвет. */
function shiftTile(label: string, s: Shift, f: (v: number) => string): string {
  if (s.now === null) return tile(label, "—", "", "нет данных");
  let delta = `<div class="delta">сравнивать пока не с чем</div>`;
  if (s.prev) {
    const pct = Math.round((s.now / s.prev - 1) * 100);
    delta = pct === 0 ? `<div class="delta">без изменений к предыдущим ${WINDOW}</div>` : `<div class="delta ${pct < 0 ? "good" : "bad"}">${pct < 0 ? "▼" : "▲"} ${pct < 0 ? "−" : "+"}${Math.abs(pct)} % к предыдущим ${WINDOW} (${esc(f(s.prev))})</div>`;
  }
  return tile(label, f(s.now), delta, `медиана последних ${s.n}`);
}

/** Плитка тарифа: доля $ ведущей модели последних задач, остальные и предыдущие — строками; смена модели двигает тренд $. */
function modelsTile(m: ModelShift): string {
  const label = "Стоимость по моделям";
  const hint = `доля $ последних ${WINDOW}: ${TARIFF_NOTE}`;
  if (!m.now.length) return tile(label, "—", "", hint);
  const [top, share] = m.now[0]!;
  let delta = `<div class="delta">${esc(top)}${m.now.length > 1 ? `; ${esc(sharesTxt(m.now.slice(1)))}` : ""}</div>`;
  if (m.prev.length) delta += `<div class="delta">предыдущие ${WINDOW}: ${esc(sharesTxt(m.prev))}</div>`;
  return tile(label, `${Math.round(share * 100)} %`, delta, hint);
}

function tiles(v: View): string {
  const c = v.calib;
  const accuracy = c.n
    ? tile("Точность оценок", `×${c.k}`, `<div class="delta">в допуске ×0.5…×2 — ${Math.trunc(c.share! * 100)} % задач</div>`, `факт к оценке, медиана ${c.n} последних пар`)
    : tile("Точность оценок", "—", "", "нет задач с оценкой est и фактом");
  return `<section class="tiles">${accuracy}${shiftTile("Часы на задачу", v.h, (x) => `${fmtH(x)} ч`)}${shiftTile("Токены на задачу", v.tok, (x) => `${fmtH(x, 1)} млн`)}${shiftTile("Стоимость задачи", v.usd, fmtUsd)}${modelsTile(v.models)}</section>`;
}

const LEGEND = [
  `<span class="key"><svg viewBox="0 0 22 12"><circle class="est" cx="11" cy="6" r="3.5"/></svg>оценка</span>`,
  `<span class="key"><svg viewBox="0 0 22 12"><circle class="fact" cx="11" cy="6" r="4"/></svg>факт</span>`,
  `<span class="key"><svg viewBox="0 0 22 12"><path class="trend" d="M1 6L21 6"/></svg>медиана последних ${WINDOW} задач</span>`,
  `<span>шкалы логарифмические: равный шаг — равное отношение</span>`,
].join("");

function table(pts: Point[], many: boolean): string {
  const head = ["Закрыта", "Задача", "Тип", "Оценка, ч", "Факт, ч", "Факт к оценке", "Токены, млн: прогноз", "Токены, млн: факт", "Стоимость: прогноз", "Стоимость: факт", "Покрытие"];
  const body = [...pts].reverse().map((p) => {
    const cells = [
      fmtLocal(p.t).slice(0, 10),
      `<a href="${esc(p.url)}">${esc(`${many ? p.repo : ""}#${p.number}`)}</a> ${esc(p.title)}`,
      esc(p.type), dash(p.est, fmtH), fmtH(p.fact), ratio(p), dash(p.tokEst, fmtTok), dash(p.tok, fmtTok), dash(p.usdEst, fmtUsd), dash(p.usd, fmtUsd), esc(p.cov),
    ];
    return `<tr data-task="${esc(taskId(p))}">${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  });
  return `<section class="card scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body.join("")}</tbody></table></section>`;
}

type Tab = "sessions" | "est";
// «Сессии» — главная: на ней видно, чего ждут задачи в работе; график — вторая вкладка
const TABS: [Tab, string, string][] = [["sessions", "/", "Сессии"], ["est", "/est", "Оценка и факт"]];
const EST_TITLE = "Задачи: оценка, факт и цена";
const SESSIONS_TITLE = "Сессии: задачи в работе";

/** Каркас страницы: вкладки, заголовок, строка под ним (HTML), ошибки чтения GitHub — плашкой, содержимое вкладки; `tail` — после `<main>`. */
function shell(o: { tab: Tab; title: string; repos: string[]; sub: string; errors: string[]; body: string; tail?: string }): string {
  const tabs = TABS.map(([k, href, label]) => `<a href="${href}"${k === o.tab ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return [
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${esc(o.title)} — ${esc(o.repos.join(", "))}</title><style>${CSS}</style></head><body><main>`,
    `<nav class="tabs" aria-label="Вкладки">${tabs}</nav>`,
    `<h1>${esc(o.title)}</h1>`,
    `<div class="sub">${o.sub}</div>`,
    o.errors.length ? `<div class="card errors">${o.errors.map((e) => `<div>${esc(e)}</div>`).join("")}</div>` : "",
    o.body,
    // скрипт — вне <main>: самообновление подменяет <main> и не должно подменять себя
    `</main>${o.tail ?? ""}</body></html>`,
  ].join("");
}

/** Вкладка «Оценка и факт»: сводка, график, таблица. */
export function page(m: Model): string {
  const pts = m.view.points;
  const many = m.repos.length > 1;
  const since = m.since || "all";
  const presets = PRESETS.some(([k]) => k === since) ? PRESETS : ([[since, since], ...PRESETS] as [string, string][]);
  const c = chart(pts);
  const hover = {
    w: W,
    pts: pts.map((p, i) => ({
      ...c.hover[i]!, task: taskId(p), head: `${many ? p.repo : ""}#${p.number} ${p.title}`, when: [fmtLocal(p.t), p.type, p.cov === "full" ? "" : `покрытие ${p.cov}`].filter(Boolean).join(" · "),
      rows: [["Часы: оценка → факт", `${pair(p.est, p.fact, fmtH)}${p.est ? ` (${ratio(p)})` : ""}`], ["Токены, млн", pair(p.tokEst, p.tok, fmtTok)], ["Стоимость", pair(p.usdEst, p.usd, fmtUsd)]],
    })),
  };
  const body = pts.length
    ? `${tiles(m.view)}<figure class="card"><figcaption>${LEGEND}</figcaption>${c.svg}<div id="tip" hidden></div></figure>${table(pts, many)}` +
      `<script id="pts" type="application/json">${JSON.stringify(hover).replace(/</g, "\\u003c")}</script><script>${SCRIPT}</script>`
    : `<p class="card">Закрытых задач с фактом нет${since === "all" ? "" : " за этот период"} — факт пишет <code>est fact --write</code> при закрытии задачи.</p>`;
  return shell({
    tab: "est", title: EST_TITLE, repos: m.repos, errors: m.errors,
    sub: `${esc(m.repos.join(", "))} · закрытые задачи с фактом по дате закрытия · GitHub прочитан ${esc(fmtLocal(m.at))} · <a href="/est?since=${esc(since)}&amp;refresh=1">Обновить</a>`,
    body: `<nav class="filters"><span>Период:</span>${presets.map(([k, label]) => `<a${k === since ? ' class="cur"' : ""} href="/est?since=${esc(k)}">${esc(label)}</a>`).join("")}</nav>${body}`,
  });
}

interface SessionsModel {
  repos: string[];
  view: SessionsView;
  /** Когда прочитан GitHub, epoch-секунды. */
  at: number;
  /** Когда прочитаны закрепления и транскрипты: от него — возраст записей сессий. */
  now: number;
  errors: string[];
}

/** Вкладка «Сессии»: «Ждут владельца» и строка на задачу «В работе»; обновляется сама. */
function sessionsPage(m: SessionsModel): string {
  return shell({
    tab: "sessions", title: SESSIONS_TITLE, repos: m.repos, errors: m.errors,
    sub: `${esc(m.repos.join(", "))} · задачи «В работе», их сессии и чего они ждут · обновляется каждые ${REFRESH} с · GitHub прочитан ${esc(fmtLocal(m.at))} · <a href="/?refresh=1">Обновить</a>`,
    body: sessionsBody(m.view, m.now, m.repos.length > 1),
    tail: refreshScript(REFRESH),
  });
}

/** Что показать на «Сессиях»: к GitHub — закрепления задач «В работе», транскрипты их сессий и недавние сессии репозиториев. */
function sessionsInput(live: Record<string, Live>, registry: Registry, now: number): SessionsInput {
  const pins = readPins();
  const ids = Object.entries(live).flatMap(([repo, l]) => l.tasks.flatMap((t) => pins[`${repo}#${t.number}`] ?? []));
  const others = Object.fromEntries(Object.keys(live).map((repo) => [repo, repoTranscripts(registry[repo]?.paths ?? [], now - RECENT)]));
  return { pins, transcripts: findTranscripts(ids), live, others };
}

// ----------------------------------------------------------------------------
// Сервер и CLI
// ----------------------------------------------------------------------------

const USAGE = `dashboard — страница задач: «Сессии» (задачи в работе и чего они ждут) и «Оценка и факт» (график по времени закрытия).

  dashboard [--repo o/r | --all-repos] [--since 90d] [--port N] [--no-open]

  --repo o/r    репозиторий (по умолчанию — из git remote origin каталога)
  --all-repos   все репозитории личного реестра est
  --since 90d   период вкладки «Оценка и факт» по умолчанию (дни d, недели w, месяцы m); без него — всё время
  --port N      порт (по умолчанию — свободный)
  --no-open     не открывать браузер (то же — BROWSER=none; BROWSER=<команда> — чем открыть)`;

// Облачной сессии Claude Code GitHub Projects закрыты, а её localhost не виден браузеру пользователя.
const CLOUD_ERR = "облачная сессия Claude Code: проекты GitHub отсюда недоступны, а страницу с её localhost не открыть — дашборд только в локальной сессии (docs/cloud-sessions.md в ai-dev)";
const isCloud = () => process.env.CLAUDE_CODE_REMOTE === "true";
const nowTs = () => Date.now() / 1000;

interface Options {
  repos: string[];
  registry: Registry;
  since: string;
  port: number;
}

/** Период страницы → начало, epoch-секунды; пусто и `all` — всё время. */
function sinceTs(s: string): number | null {
  return s && s !== "all" ? nowTs() - parseSince(s) : null;
}

function serve(o: Options) {
  let cache: { at: number; rows: Record<string, Row[]>; errors: string[] } | null = null;
  /** Строки проектов: кэш на TTL; репозиторий с ошибкой — строкой на странице, все с ошибкой — исключение. */
  const load = () => {
    if (cache && nowTs() - cache.at < TTL) return cache;
    const rows: Record<string, Row[]> = {};
    const errors: string[] = [];
    for (const full of o.repos) {
      try {
        rows[full] = new Repo(full, o.registry).projectRows();
      } catch (e) {
        if (!(e instanceof EstError)) throw e;
        errors.push(`${full}: ${e.message}`);
      }
    }
    if (!Object.keys(rows).length) throw new EstError(errors.join("; "));
    return (cache = { at: nowTs(), rows, errors });
  };
  let live: { at: number; live: Record<string, Live>; errors: string[] } | null = null;
  let pending: Promise<void> | null = null;
  /**
   * GitHub для «Сессий» — запросом на репозиторий, параллельно и без блокировки сервера; ошибка репозитория — строкой на
   * странице. Не бросает: запускается и в фоне.
   */
  const refreshLive = () =>
    (pending ??= (async () => {
      const got = await Promise.all(
        o.repos.map(async (full): Promise<[string, Live | null, string | null]> => {
          try {
            return [full, await liveQuery(full, new Repo(full, o.registry).projectMeta().id), null];
          } catch (e) {
            return [full, null, `${full}: ${e instanceof EstError ? e.message : String((e as Error)?.stack ?? e)}`];
          }
        }),
      );
      live = { at: nowTs(), live: Object.fromEntries(got.filter(([, l]) => l).map(([full, l]) => [full, l!])), errors: got.flatMap(([, , err]) => (err ? [err] : [])) };
    })().finally(() => (pending = null)));
  const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const failure = (msg: string, status: number, tab: Tab) =>
    html(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Дашборд: ошибка</title><style>${CSS}</style><main><h1>${tab === "est" ? EST_TITLE : SESSIONS_TITLE}</h1><p class="card errors">${esc(msg)}</p><p><a href="${tab === "est" ? "/est" : "/"}?refresh=1">Обновить</a></p></main></html>`, status);
  /** Вкладка «Оценка и факт»: период — из адреса, иначе из --since. */
  const estTab = (url: URL) => {
    const since = url.searchParams.get("since") ?? o.since;
    const from = sinceTs(since);
    const data = load();
    return html(page({ repos: o.repos, since, view: view(data.rows, from), at: data.at, errors: data.errors }));
  };
  /**
   * Вкладка «Сессии»: закрепления и транскрипты — заново на каждое открытие, GitHub — из кэша; устарел — страница из
   * него, а свежий собирается в фоне к следующему обновлению: вкладка обновляется сама и GitHub не ждёт.
   */
  const sessionsTab = async () => {
    if (!live) await refreshLive();
    else if (nowTs() - live.at >= TTL) void refreshLive();
    const l = live!;
    const now = nowTs();
    const v = sessionsView(sessionsInput(l.live, o.registry, now), now);
    return html(sessionsPage({ repos: o.repos, view: v, at: l.at, now, errors: l.errors }));
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    async fetch(req) {
      const url = new URL(req.url);
      // страница называет задачи непубличных репозиториев: чужой Host — сайт, навёдший своё имя на 127.0.0.1 (DNS rebinding)
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("чужой Host", { status: 403 });
      const tab = TABS.find(([, href]) => href === url.pathname)?.[0];
      if (!tab) return new Response("нет такой страницы", { status: 404 });
      if (url.searchParams.has("refresh")) {
        cache = live = null;
        // адрес без refresh: перезагрузка вкладки не перечитывает GitHub заново
        const since = url.searchParams.get("since");
        return new Response(null, { status: 303, headers: { location: tab === "est" && since ? `/est?since=${encodeURIComponent(since)}` : url.pathname } });
      }
      try {
        return tab === "est" ? estTab(url) : await sessionsTab();
      } catch (e) {
        if (e instanceof EstError) return failure(e.message, /^неверный период/.test(e.message) ? 400 : 502, tab);
        return failure(String((e as Error)?.stack ?? e), 500, tab);
      }
    },
  });
  return { server, refreshLive };
}

/** Открывает адрес в браузере: команда из BROWSER, иначе системная; возвращает строку для вывода. */
function openBrowser(url: string, open: boolean): string {
  if (!open) return "не открываю (--no-open)";
  const browser = process.env.BROWSER;
  if (browser === "none") return "не открываю (BROWSER=none)";
  const cmd = browser ? [browser, url] : process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  const p = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
  p.on("error", (e) => console.error(`браузер не открылся (${e.message}) — откройте адрес сами`));
  p.unref();
  return `открываю ${url}`;
}

export function main(argv: string[]): number | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { repo: { type: "string" }, "all-repos": { type: "boolean", default: false }, since: { type: "string", default: "" }, port: { type: "string", default: "0" }, "no-open": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
    });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    if (isCloud()) throw new EstError(CLOUD_ERR);
    if (values.repo && values["all-repos"]) throw new EstError("--repo и --all-repos несовместимы");
    sinceTs(values.since);
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port > 65535) throw new EstError(`--port: ожидается порт 0…65535, получено «${values.port}»`);
    const registry = loadRegistry();
    const repos = values["all-repos"] ? Object.keys(registry) : [resolveRepo(values.repo)];
    if (!repos.length) throw new EstError("реестр репозиториев est пуст — укажите --repo owner/repo");
    let started: ReturnType<typeof serve>;
    try {
      started = serve({ repos, registry, since: values.since, port });
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== "EADDRINUSE") throw e;
      throw new EstError(`порт ${port} занят — укажите другой --port или уберите его: возьмётся свободный`);
    }
    const { server, refreshLive } = started;
    const url = `http://127.0.0.1:${server.port}/`;
    console.log(`дашборд: ${url} — ${repos.join(", ")}; остановить — Ctrl+C`);
    // главная вкладка открывается без ожидания GitHub: он читается, пока браузер открывается; строки проекта для
    // «Оценки и факта» — при её открытии: по всем репозиториям это десятки секунд, «Сессии» их не ждут
    void refreshLive();
    console.log(`браузер: ${openBrowser(url, !values["no-open"])}`);
    return null; // сервер живёт до остановки
  } catch (e) {
    if (e instanceof EstError) {
      console.error(`ошибка: ${e.message}`);
      return 1;
    }
    if (e && typeof e === "object" && String((e as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS")) {
      console.error(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
}
