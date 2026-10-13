#!/usr/bin/env bun
/**
 * dashboard — a task page in two tabs: "Sessions" (the main one) — "In progress" tasks, their sessions and what they
 * wait for; "Estimate and actual" — a chart of estimate, actual, tokens and cost by close time.
 *
 *   dashboard [--repo o/r | --all-repos] [--since 90d] [--port N] [--no-open]
 *
 * Serves the page itself (Bun.serve, 127.0.0.1 only), prints the address and opens it in the browser. The data — the
 * GitHub project rows (fields and the "Estimate" and "Actual" comment markers) via the est script next to it, session
 * pins and transcripts (sessions.ts); writes nothing to GitHub. The page is built on the server: SVG as a string, no
 * dependencies; in the browser — only the hover tooltip.
 */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import locale from "../../github/scripts/locale.ts";
import { calib, EstError, fmtH, fmtLocal, loadRegistry, median, parseSince, Repo, resolveRepo, sharesTxt, usdByModel, usdShares } from "../../est/scripts/est.ts";
import type { Registry, Row } from "../../est/scripts/est.ts";
import { findTranscripts, liveQuery, readPins, RECENT, REFRESH, refreshScript, repoTranscripts, SESSIONS_CSS, sessionsBody, sessionsView } from "./sessions.ts";
import type { Live, SessionsInput, SessionsView } from "./sessions.ts";

const DAY = 86400;
/** Trend and summary window: the last 10 closed tasks; a median of fewer than three is noise, there is none. */
const WINDOW = 10;
const MIN_TREND = 3;
/** GitHub is re-read when the page opens, but no more than once a minute; "Refresh" — at once. */
const TTL = 60;

// ----------------------------------------------------------------------------
// Data
// ----------------------------------------------------------------------------

/** A task on the chart. Estimate and forecast — only from the est marker: estimates without it are in other units. */
export interface Point {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Close time, epoch seconds. */
  t: number;
  type: string;
  cov: string;
  est: number | null;
  fact: number;
  tokEst: number | null;
  /** Actual tokens, millions. */
  tok: number | null;
  usdEst: number | null;
  usd: number | null;
  /** Actual $ by model; null — the actual was computed before the per-model split. */
  usdModels: Record<string, number> | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
// the dashboard is shared by all repositories: labels are in English, parsing takes names in any language of the
// github skill's locales dictionary
const EPIC_TYPES = locale.every((n) => n.issueTypes.epic).map((t) => t.toLowerCase());
const isEpic = (r: Row) => r.labels.includes("epic") || EPIC_TYPES.includes((r.issueType ?? "").toLowerCase());

/** Closed tasks of the period without epics: an epic is the sum of its subtasks, they're already in the list. */
function taskRows(rows: Row[], since: number | null): Row[] {
  return rows.filter((r) => r.state === "CLOSED" && r.closedAt !== null && !isEpic(r) && (since === null || r.closedAt >= since));
}

/** Chart points — closed tasks with an actual, by close time. */
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

/** Rolling median of the last `window` values; while there are fewer than `min` values — no trend. */
export function trend(vals: number[], window = WINDOW, min = MIN_TREND): (number | null)[] {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - window + 1), i + 1);
    return w.length < min ? null : median(w);
  });
}

/** Median of the latest tasks and of the previous ones: no `prev` while there's nothing to compare with. */
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

/** $ shares by model of the latest tasks and of the previous ones: a pricing shift next to the cost trend. */
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
  /** Estimate accuracy — k and the share within tolerance, as in `est history`. */
  calib: ReturnType<typeof calib>;
  h: Shift;
  tok: Shift;
  usd: Shift;
  models: ModelShift;
}

/**
 * Everything the page shows: points, estimate accuracy and medians of the latest tasks — from the repositories'
 * project rows.
 */
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
// Chart
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
  /** A scale step label and the value label at the trend's end. */
  tick: (v: number) => string;
  fmt: (v: number) => string;
  /** The reference line and the tolerance band — on the ratio panel. */
  ref?: { at: number; band: [number, number] };
}

const none = () => null;
const times = (v: number) => `×${fmtH(v)}`;
// scale steps are round numbers of any magnitude (0.001, 20): fmtH would round small ones to zero
const tick = (v: number) => String(v);
// Panels, not several scales on one: hours, ratio, tokens and dollars are different units
// (tests/capabilities/dashboard).
const PANELS: Panel[] = [
  { key: "h", title: "Hours per task", fact: (p) => p.fact, est: (p) => p.est, tick, fmt: (v) => fmtH(v) },
  { key: "ratio", title: "Actual to estimate — tolerance band ×0.5…×2", fact: (p) => (p.est ? p.fact / p.est : null), est: none, tick: (v) => `×${v}`, fmt: times, ref: { at: 1, band: [0.5, 2] } },
  { key: "tok", title: "Tokens per task, M", fact: (p) => p.tok, est: (p) => p.tokEst, tick, fmt: fmtTok },
  { key: "usd", title: "Cost per task, $", fact: (p) => p.usd, est: (p) => p.usdEst, tick, fmt: (v) => v.toFixed(v < 10 ? 2 : 0) },
];

// Geometry in viewBox units: on the left — scale labels, on the right — the trend end label, at the bottom — the
// shared time axis.
const W = 1080;
const LEFT = 56;
const RIGHT = 64;
const HEAD = 28;
const PLOT = 150;
const GAP = 18;
const AXIS = 30;
const PANEL_H = HEAD + PLOT + GAP;
const HEIGHT = PANELS.length * PANEL_H + AXIS;

/** Log scale steps covering [lo, hi]: the 1–2–5 series, and if there are more than seven steps — decades only. */
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

/** Time axis marks — local midnights with a step that keeps them at eight or fewer. */
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

/**
 * A panel: the grid, "estimate — actual" segments, estimate rings, the trend line and actual points; `ys` — the actual
 * point height for each task.
 */
function panelSvg(p: Panel, i: number, pts: Point[], lay: Layout): { svg: string; ys: (number | null)[] } {
  const top = i * PANEL_H + HEAD;
  const pos = (v: number | null): v is number => v !== null && v > 0;
  const values = pts.flatMap((pt) => [p.fact(pt), p.est(pt)]).filter(pos);
  if (values.length && p.ref) values.push(...p.ref.band);
  const out = [`<g class="panel" data-panel="${p.key}">`, `<text class="panel-title" x="${LEFT}" y="${top - 10}">${esc(p.title)}</text>`];
  if (!values.length) {
    out.push(`<text class="empty" x="${LEFT}" y="${top + PLOT / 2}">no data</text>`, "</g>");
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
  /** Points for the tooltip: the abscissa and the actual heights per panel in viewBox units. */
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
    `<svg class="chart" viewBox="0 0 ${W} ${HEIGHT}" role="img" aria-label="Hours, tokens and cost of tasks by close date; the values are in the table below">`,
    ...panels.map((p) => p.svg),
    `<g class="x-axis">${axis.join("")}</g>`,
    `<line class="crosshair" x1="0" x2="0" y1="${HEAD}" y2="${axisY}" visibility="hidden"/>`,
    "</svg>",
  ].join("");
  return { svg, hover: pts.map((pt, k) => ({ x: r1(lay.x(pt.t)), y: panels.map((p) => p.ys[k] ?? null) })) };
}

/** The chart: panels with a shared time axis — hours, actual to estimate, tokens, cost; no tasks — an empty string. */
export function chartSvg(pts: Point[]): string {
  return chart(pts).svg;
}

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------

export interface Model {
  repos: string[];
  /** The page period: `30d`, `90d`…; empty or `all` — all time. */
  since: string;
  view: View;
  /** When GitHub was read, epoch seconds. */
  at: number;
  errors: string[];
}

const PRESETS: [string, string][] = [["30d", "30 days"], ["90d", "90 days"], ["all", "all time"]];

// Palette — the tested "blue / orange" pair and utility tones for the light and dark themes.
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

// Tooltip: the task nearest to the cursor (horizontally — four times stricter than vertically), the crosshair and its
// row in the table.
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

/**
 * A metric tile: the median of the latest tasks and its change vs the previous ones; less is better, the sign
 * duplicates the color.
 */
function shiftTile(label: string, s: Shift, f: (v: number) => string): string {
  if (s.now === null) return tile(label, "—", "", "no data");
  let delta = `<div class="delta">nothing to compare with yet</div>`;
  if (s.prev) {
    const pct = Math.round((s.now / s.prev - 1) * 100);
    delta = pct === 0 ? `<div class="delta">no change vs the previous ${WINDOW}</div>` : `<div class="delta ${pct < 0 ? "good" : "bad"}">${pct < 0 ? "▼" : "▲"} ${pct < 0 ? "−" : "+"}${Math.abs(pct)} % vs the previous ${WINDOW} (${esc(f(s.prev))})</div>`;
  }
  return tile(label, f(s.now), delta, `median of the last ${s.n}`);
}

/**
 * The pricing tile: the $ share of the leading model of the latest tasks, the others and the previous ones — as lines;
 * a model change moves the $ trend.
 */
function modelsTile(m: ModelShift): string {
  const label = "Cost by model";
  const hint = `share of $ over the last ${WINDOW}: the $ trend mixes the flow with the model's rate — compare the flow by tokens and output`;
  if (!m.now.length) return tile(label, "—", "", hint);
  const [top, share] = m.now[0]!;
  let delta = `<div class="delta">${esc(top)}${m.now.length > 1 ? `; ${esc(sharesTxt(m.now.slice(1)))}` : ""}</div>`;
  if (m.prev.length) delta += `<div class="delta">previous ${WINDOW}: ${esc(sharesTxt(m.prev))}</div>`;
  return tile(label, `${Math.round(share * 100)} %`, delta, hint);
}

function tiles(v: View): string {
  const c = v.calib;
  const accuracy = c.n
    ? tile("Estimate accuracy", `×${c.k}`, `<div class="delta">within ×0.5…×2 — ${Math.trunc(c.share! * 100)} % of tasks</div>`, `actual to estimate, median of the last ${c.n} pairs`)
    : tile("Estimate accuracy", "—", "", "no tasks with an est estimate and an actual");
  return `<section class="tiles">${accuracy}${shiftTile("Hours per task", v.h, (x) => `${fmtH(x)} h`)}${shiftTile("Tokens per task", v.tok, (x) => `${fmtH(x, 1)}M`)}${shiftTile("Cost per task", v.usd, fmtUsd)}${modelsTile(v.models)}</section>`;
}

const LEGEND = [
  `<span class="key"><svg viewBox="0 0 22 12"><circle class="est" cx="11" cy="6" r="3.5"/></svg>estimate</span>`,
  `<span class="key"><svg viewBox="0 0 22 12"><circle class="fact" cx="11" cy="6" r="4"/></svg>actual</span>`,
  `<span class="key"><svg viewBox="0 0 22 12"><path class="trend" d="M1 6L21 6"/></svg>median of the last ${WINDOW} tasks</span>`,
  `<span>log scales: an equal step is an equal ratio</span>`,
].join("");

function table(pts: Point[], many: boolean): string {
  const head = ["Closed", "Task", "Type", "Estimate, h", "Actual, h", "Actual to estimate", "Tokens, M: forecast", "Tokens, M: actual", "Cost: forecast", "Cost: actual", "Coverage"];
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
// "Sessions" is the main tab: it shows what the in-progress tasks wait for; the chart is the second tab
const TABS: [Tab, string, string][] = [["sessions", "/", "Sessions"], ["est", "/est", "Estimate and actual"]];
const EST_TITLE = "Tasks: estimate, actual and cost";
const SESSIONS_TITLE = "Sessions: tasks in progress";

/**
 * The page frame: tabs, the title, the line under it (HTML), GitHub read errors — as a banner, the tab's content;
 * `tail` — after `<main>`.
 */
function shell(o: { tab: Tab; title: string; repos: string[]; sub: string; errors: string[]; body: string; tail?: string }): string {
  const tabs = TABS.map(([k, href, label]) => `<a href="${href}"${k === o.tab ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${esc(o.title)} — ${esc(o.repos.join(", "))}</title><style>${CSS}</style></head><body><main>`,
    `<nav class="tabs" aria-label="Tabs">${tabs}</nav>`,
    `<h1>${esc(o.title)}</h1>`,
    `<div class="sub">${o.sub}</div>`,
    o.errors.length ? `<div class="card errors">${o.errors.map((e) => `<div>${esc(e)}</div>`).join("")}</div>` : "",
    o.body,
    // the script is outside <main>: self-refresh replaces <main> and mustn't replace itself
    `</main>${o.tail ?? ""}</body></html>`,
  ].join("");
}

/** The "Estimate and actual" tab: summary, chart, table. */
export function page(m: Model): string {
  const pts = m.view.points;
  const many = m.repos.length > 1;
  const since = m.since || "all";
  const presets = PRESETS.some(([k]) => k === since) ? PRESETS : ([[since, since], ...PRESETS] as [string, string][]);
  const c = chart(pts);
  const hover = {
    w: W,
    pts: pts.map((p, i) => ({
      ...c.hover[i]!, task: taskId(p), head: `${many ? p.repo : ""}#${p.number} ${p.title}`, when: [fmtLocal(p.t), p.type, p.cov === "full" ? "" : `coverage ${p.cov}`].filter(Boolean).join(" · "),
      rows: [["Hours: estimate → actual", `${pair(p.est, p.fact, fmtH)}${p.est ? ` (${ratio(p)})` : ""}`], ["Tokens, M", pair(p.tokEst, p.tok, fmtTok)], ["Cost", pair(p.usdEst, p.usd, fmtUsd)]],
    })),
  };
  const body = pts.length
    ? `${tiles(m.view)}<figure class="card"><figcaption>${LEGEND}</figcaption>${c.svg}<div id="tip" hidden></div></figure>${table(pts, many)}` +
      `<script id="pts" type="application/json">${JSON.stringify(hover).replace(/</g, "\\u003c")}</script><script>${SCRIPT}</script>`
    : `<p class="card">No closed tasks with an actual${since === "all" ? "" : " in this period"} — <code>est fact --write</code> records the actual when a task is closed.</p>`;
  return shell({
    tab: "est", title: EST_TITLE, repos: m.repos, errors: m.errors,
    sub: `${esc(m.repos.join(", "))} · closed tasks with an actual by close date · GitHub read ${esc(fmtLocal(m.at))} · <a href="/est?since=${esc(since)}&amp;refresh=1">Refresh</a>`,
    body: `<nav class="filters"><span>Period:</span>${presets.map(([k, label]) => `<a${k === since ? ' class="cur"' : ""} href="/est?since=${esc(k)}">${esc(label)}</a>`).join("")}</nav>${body}`,
  });
}

interface SessionsModel {
  repos: string[];
  view: SessionsView;
  /** When GitHub was read, epoch seconds. */
  at: number;
  /** When the pins and transcripts were read: session record ages count from it. */
  now: number;
  errors: string[];
}

/** The "Sessions" tab: "Waiting for the owner" and a line per "In progress" task; refreshes itself. */
function sessionsPage(m: SessionsModel): string {
  return shell({
    tab: "sessions", title: SESSIONS_TITLE, repos: m.repos, errors: m.errors,
    sub: `${esc(m.repos.join(", "))} · tasks in progress, their sessions and what they wait for · refreshes every ${REFRESH} s · GitHub read ${esc(fmtLocal(m.at))} · <a href="/?refresh=1">Refresh</a>`,
    body: sessionsBody(m.view, m.now, m.repos.length > 1),
    tail: refreshScript(REFRESH),
  });
}

/**
 * What to show on "Sessions": in addition to GitHub — the pins of "In progress" tasks, their sessions' transcripts and
 * the repositories' recent sessions.
 */
function sessionsInput(live: Record<string, Live>, registry: Registry, now: number): SessionsInput {
  const pins = readPins();
  const ids = Object.entries(live).flatMap(([repo, l]) => l.tasks.flatMap((t) => pins[`${repo}#${t.number}`] ?? []));
  const others = Object.fromEntries(Object.keys(live).map((repo) => [repo, repoTranscripts(registry[repo]?.paths ?? [], now - RECENT)]));
  return { pins, transcripts: findTranscripts(ids), live, others };
}

// ----------------------------------------------------------------------------
// Server and CLI
// ----------------------------------------------------------------------------

const USAGE = `dashboard — a task page: «Sessions» (tasks in progress and what they wait for) and «Estimate and actual» (a chart by close time).

  dashboard [--repo o/r | --all-repos] [--since 90d] [--port N] [--no-open]

  --repo o/r    repository (by default — from the directory's git remote origin)
  --all-repos   all repositories in the personal est registry
  --since 90d   default period of the «Estimate and actual» tab (days d, weeks w, months m); without it — all time
  --port N      port (by default — a free one)
  --no-open     don't open the browser (the same — BROWSER=none; BROWSER=<command> — what to open it with)`;

// GitHub Projects are unreachable from a Claude Code cloud session, and its localhost isn't visible to the user's
// browser.
const CLOUD_ERR = "Claude Code cloud session: GitHub projects aren't reachable from here, and a page on its localhost can't be opened — the dashboard runs only in a local session (docs/cloud-sessions.md in ai-dev)";
const isCloud = () => process.env.CLAUDE_CODE_REMOTE === "true";
// An agent's sandbox (Claude Code with allowLocalBinding off) denies listen, and Bun reports that as EADDRINUSE on any
// port: picking another port won't help, running outside the sandbox will.
const LISTEN_ERR = "can't listen on 127.0.0.1: opening a local port is denied here, not busy (an agent's sandbox?) — run the dashboard outside the sandbox; in Claude Code sandbox.network.allowLocalBinding: true allows it inside";

/** Whether a free port on 127.0.0.1 can be taken: `Bun.serve` reports a denied listen the same way as a busy port. */
function canListen(): boolean {
  try {
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) }).stop(true);
    return true;
  } catch {
    return false;
  }
}
const nowTs = () => Date.now() / 1000;

interface Options {
  repos: string[];
  registry: Registry;
  since: string;
  port: number;
}

/** The page period → its start, epoch seconds; empty and `all` — all time. */
function sinceTs(s: string): number | null {
  return s && s !== "all" ? nowTs() - parseSince(s) : null;
}

function serve(o: Options) {
  let cache: { at: number; rows: Record<string, Row[]>; errors: string[] } | null = null;
  /** Project rows: cached for TTL; a repository with an error — a line on the page, all with errors — an exception. */
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
   * GitHub for "Sessions" — a request per repository, in parallel and without blocking the server; a repository's
   * error — a line on the page. Doesn't throw: it also runs in the background.
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
    html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Dashboard: error</title><style>${CSS}</style><main><h1>${tab === "est" ? EST_TITLE : SESSIONS_TITLE}</h1><p class="card errors">${esc(msg)}</p><p><a href="${tab === "est" ? "/est" : "/"}?refresh=1">Refresh</a></p></main></html>`, status);
  /** The "Estimate and actual" tab: the period — from the address, otherwise from --since. */
  const estTab = (url: URL) => {
    const since = url.searchParams.get("since") ?? o.since;
    let from: number | null;
    try {
      from = sinceTs(since);
    } catch (e) {
      if (e instanceof EstError) return failure(e.message, 400, "est");
      throw e;
    }
    const data = load();
    return html(page({ repos: o.repos, since, view: view(data.rows, from), at: data.at, errors: data.errors }));
  };
  /**
   * The "Sessions" tab: pins and transcripts — afresh on every open, GitHub — from the cache; if it's stale, the page
   * comes from it, and a fresh one is gathered in the background for the next refresh: the tab refreshes itself and
   * doesn't wait for GitHub.
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
      // the page names tasks of private repositories: a foreign Host is a site that pointed its name at 127.0.0.1
      // (DNS rebinding)
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("foreign Host", { status: 403 });
      const tab = TABS.find(([, href]) => href === url.pathname)?.[0];
      if (!tab) return new Response("no such page", { status: 404 });
      if (url.searchParams.has("refresh")) {
        cache = live = null;
        // an address without refresh: reloading the tab doesn't re-read GitHub
        const since = url.searchParams.get("since");
        return new Response(null, { status: 303, headers: { location: tab === "est" && since ? `/est?since=${encodeURIComponent(since)}` : url.pathname } });
      }
      try {
        return tab === "est" ? estTab(url) : await sessionsTab();
      } catch (e) {
        if (e instanceof EstError) return failure(e.message, 502, tab);
        return failure(String((e as Error)?.stack ?? e), 500, tab);
      }
    },
  });
  return { server, refreshLive };
}

/** Opens the address in the browser: the command from BROWSER, otherwise the system one; returns a line for output. */
function openBrowser(url: string, open: boolean): string {
  if (!open) return "not opening (--no-open)";
  const browser = process.env.BROWSER;
  if (browser === "none") return "not opening (BROWSER=none)";
  const cmd = browser ? [browser, url] : process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  const p = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
  p.on("error", (e) => console.error(`browser didn't open (${e.message}) — open the address yourself`));
  p.unref();
  return `opening ${url}`;
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
    if (values.repo && values["all-repos"]) throw new EstError("--repo and --all-repos are mutually exclusive");
    sinceTs(values.since);
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port > 65535) throw new EstError(`--port: expected a port 0…65535, got «${values.port}»`);
    const registry = loadRegistry();
    const repos = values["all-repos"] ? Object.keys(registry) : [resolveRepo(values.repo)];
    if (!repos.length) throw new EstError("the est repository registry is empty — pass --repo owner/repo");
    let started: ReturnType<typeof serve>;
    try {
      started = serve({ repos, registry, since: values.since, port });
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== "EADDRINUSE") throw e;
      // port 0 can't be busy; a port is busy only if a free one can still be taken
      if (port === 0 || !canListen()) throw new EstError(LISTEN_ERR);
      throw new EstError(`port ${port} is busy — pass another --port or drop it: a free one will be taken`);
    }
    const { server, refreshLive } = started;
    const url = `http://127.0.0.1:${server.port}/`;
    console.log(`dashboard: ${url} — ${repos.join(", ")}; stop with Ctrl+C`);
    // the main tab opens without waiting for GitHub: it's read while the browser opens; the project rows for
    // "Estimate and actual" — when that tab opens: across all repositories it takes tens of seconds, "Sessions"
    // doesn't wait for them
    void refreshLive();
    console.log(`browser: ${openBrowser(url, !values["no-open"])}`);
    return null; // the server lives until stopped
  } catch (e) {
    if (e instanceof EstError) {
      console.error(`error: ${e.message}`);
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
