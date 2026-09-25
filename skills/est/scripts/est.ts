#!/usr/bin/env bun
/**
 * est — оценка задач по истории проекта и факт из транскриптов Claude Code и Codex.
 *
 * Подкоманды:
 *   est history  — таблица закрытых задач с фактом, калибровочный коэффициент k
 *   est fact     — факт (активные часы агента) по транскриптам Claude Code и Codex для issue
 *   est estimate — записать оценку с аналогами и маркером
 *
 * Запуск — Bun (`bun est.ts …`), только `node:`-API + CLI `gh`. Источник истины — GitHub (поля
 * проекта «Оценка, ч», «Факт, ч» и комментарии с HTML-маркерами <!-- est {...} --> /
 * <!-- fact {...} -->). Без --write ничего в GitHub не пишется. Форматы кэшей в
 * ~/.config/ai-dev/cache совместимы с прежним est.py.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const HOME = os.homedir();
// Личное состояние скилла (реестр репозиториев, цены, кэш) — нейтральный к агенту каталог:
// $AI_DEV_CONFIG_DIR, иначе ~/.config/ai-dev. Старый ~/.claude/est переезжает автоматически
// (см. ensureConfigDir), на его месте остаётся симлинк.
export const EST_DIR = process.env.AI_DEV_CONFIG_DIR || path.join(HOME, ".config", "ai-dev");
const LEGACY_EST_DIR = path.join(HOME, ".claude", "est");
export const REGISTRY_PATH = path.join(EST_DIR, "repos.json");
const CACHE_DIR = path.join(EST_DIR, "cache");
// Источники факта: транскрипты Claude Code (~/.claude/projects), сессии Codex (~/.codex/sessions) и выгрузки
// событий облачных сессий Claude Code (<каталог состояния>/cloud/<owner>/<repo>/<session>.json, est cloud-import).
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const CODEX_DIRS = [path.join(HOME, ".codex", "sessions"), path.join(HOME, ".codex", "archived_sessions")];
export const CLOUD_DIR = path.join(EST_DIR, "cloud");

function ensureConfigDir(): void {
  let legacyDir = false;
  try {
    legacyDir = !lstatSync(LEGACY_EST_DIR).isSymbolicLink() && statSync(LEGACY_EST_DIR).isDirectory();
  } catch {
    legacyDir = false;
  }
  if (legacyDir && !existsSync(EST_DIR)) {
    mkdirSync(path.dirname(EST_DIR), { recursive: true });
    renameSync(LEGACY_EST_DIR, EST_DIR);
    symlinkSync(EST_DIR, LEGACY_EST_DIR);
    console.error(`состояние est перенесено: ${LEGACY_EST_DIR} → ${EST_DIR} (симлинк оставлен)`);
  }
  mkdirSync(EST_DIR, { recursive: true });
}

export const FIELD_EST = "Оценка, ч";
export const FIELD_FACT = "Факт, ч";
export const FIELD_STATUS = "Status";
export const FIELD_TOK = "Токены, млн"; // необязательные поля: есть в проекте — заполняем, нет — пропускаем
export const FIELD_USD = "Стоимость, $";

// Публичные API-тарифы Anthropic, $ за 1 млн токенов: (вход, выход, чтение кэша).
// Запись кэша = вход × 1.25 (TTL 5 мин) или × 2 (TTL 1 ч). Ключ — префикс id модели,
// берётся самый длинный совпавший. Это API-эквивалент: на подписке эти деньги не списываются,
// но величина сравнима между задачами. Переопределение/дополнение — <каталог состояния>/prices.json
// в том же формате: {"<префикс модели>": [вход, выход, чтение_кэша]}.
export const PRICES_DATE = "2026-06-24";
type Price = [number, number, number];
export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": [10.0, 50.0, 0.25],
  "claude-mythos-5-1": [10.0, 50.0, 0.25],
  "claude-fable-5": [10.0, 50.0, 1.0],
  "claude-mythos-5": [10.0, 50.0, 1.0],
  "claude-opus-5": [5.0, 25.0, 0.5],
  "claude-opus-4-8": [5.0, 25.0, 0.5],
  "claude-opus-4-7": [5.0, 25.0, 0.5],
  "claude-opus-4-6": [5.0, 25.0, 0.5],
  "claude-sonnet-5": [2.0, 10.0, 0.2],
  "claude-sonnet-4-6": [3.0, 15.0, 0.3],
  "claude-haiku-4-5": [1.0, 5.0, 0.1],
};
const FAST_PRICES: Record<string, Price> = { "claude-opus-5": [10.0, 50.0, 1.0] }; // speed=fast; для прочих моделей тариф fast не опубликован
const PRICES_PATH = path.join(EST_DIR, "prices.json");
let pricesCache: Record<string, Price> | null = null;

const byLenDesc = (a: string, b: string) => b.length - a.length;

/** (вход, выход, чтение кэша) $/млн для модели или null, если модели нет в прайсе. */
export function priceFor(model: string, fast = false, table?: Record<string, Price>): Price | null {
  if (!table) {
    if (pricesCache === null) {
      const t: Record<string, Price> = { ...PRICES };
      const extra = loadJson<Record<string, unknown>>(PRICES_PATH, {});
      for (const [k, v] of Object.entries(extra)) {
        if (Array.isArray(v) && v.length === 3) t[k] = [Number(v[0]), Number(v[1]), Number(v[2])];
      }
      pricesCache = t;
    }
    table = pricesCache;
  }
  if (fast) {
    for (const k of Object.keys(FAST_PRICES).sort(byLenDesc)) if (model.startsWith(k)) return FAST_PRICES[k]!;
  }
  for (const k of Object.keys(table).sort(byLenDesc)) if (model.startsWith(k)) return table[k]!;
  return null;
}

/** Стоимость одного ответа модели в $; vals = (вход, выход, запись кэша 5м, запись кэша 1ч, чтение кэша). */
export function usageCost(model: string, vals: [number, number, number, number, number], fast = false, table?: Record<string, Price>): number | null {
  const p = priceFor(model, fast, table);
  if (!p) return null;
  const [pin, pout, pcr] = p;
  const [i, o, cw5, cw1, cr] = vals;
  return (i * pin + o * pout + cw5 * pin * 1.25 + cw1 * pin * 2.0 + cr * pcr) / 1e6;
}

// Типы задач = типы conventional commits + research (спайк без кода). Те же слова —
// префиксы веток: <type>/<issue>-<slug> (допускается префикс области: <area>/<type>/<issue>-<slug>).
export const EST_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"] as const;
const BRANCH_CONV_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + EST_TYPES.join("|") + ")/(\\d{1,6})-", "iu");
const PR_PAGE = 50;
const PR_MAX = 500;
const ISSUES_MAX = 500; // сколько закрытых issue держим в индексе коммитов-закрывателей
const SESSION_CACHE_V = 11; // версия формата кэша транскриптов (сменилась — переразбор); 11 = история названий сессии (title_hist)
const PROJECT_META_TTL = 86400; // сутки: кэш id проекта/полей перечитываем
const OPEN_PRS_TTL = 3600; // час: список открытых PR (их ветки — чужие)
// Долгоживущие ветки: «нейтральные» — сами по себе задачу не привязывают, но внутри окна якоря считаются.
const BASE_BRANCHES = new Set(["main", "master", "develop", "dev", "staging", "production", "release"]);

// Реестр репозиториев — личный файл <каталог состояния>/repos.json (в репо скилла не входит).
// Формат: {"owner/repo": {"paths": ["/abs/path/to/checkout", ...],
//                         "project": {"owner": "<owner>", "number": <N>}}}
// Без записи репо определяется из git remote origin текущего каталога, проект — по
// привязке к репозиторию; paths нужны, чтобы найти транскрипты (~/.claude/projects).
type Registry = Record<string, { paths?: string[]; project?: { owner: string; number: number | string } }>;

// Файлы, которые не считаем в диффе: lock-файлы, снапшоты, минифицированное, сборка.
const DIFF_EXCLUDE = new RegExp(
  "(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?|Cargo\\.lock|" +
    "poetry\\.lock|composer\\.lock|Gemfile\\.lock|go\\.sum|Podfile\\.lock)$" +
    "|(^|/)__snapshots__/|\\.snap$|\\.min\\.(js|css)$|(^|/)(dist|build)/|\\.generated\\.",
  "i",
);

export class EstError extends Error {}

/** Номер существует не как issue (обычно это PR). */
export class NotAnIssue extends EstError {}

const errIs = (e: unknown, text: string) => String((e as Error).message ?? e).toLowerCase().includes(text.toLowerCase());

function die(msg: string, code = 1): never {
  console.error(`ошибка: ${msg}`);
  process.exit(code);
}

// ----------------------------------------------------------------------------
// Утилиты
// ----------------------------------------------------------------------------

/** ISO-строка (UTC, с Z или смещением) → epoch-секунды. */
export function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

const two = (n: number) => String(n).padStart(2, "0");

export function fmtLocal(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function fmtH(h: number | null | undefined, digits = 2): string {
  if (h === null || h === undefined) return "—";
  const s = h.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return s || "0";
}

export function plural(n: number, one: string, few: string, many: string): string {
  n = Math.abs(Math.trunc(n));
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return few;
  return many;
}

export function parseSince(s: string): number {
  const m = /^(\d+)([dhwm])$/.exec(s.trim());
  if (!m) throw new EstError(`неверный период «${s}», ожидается вида 90d / 12w / 6m / 48h`);
  const secs: Record<string, number> = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400 };
  return parseInt(m[1]!, 10) * secs[m[2]!]!;
}

export function quantile(sortedVals: number[], q: number): number | null {
  if (!sortedVals.length) return null;
  if (sortedVals.length === 1) return sortedVals[0]!;
  const pos = (sortedVals.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sortedVals.length - 1);
  return sortedVals[lo]! + (sortedVals[hi]! - sortedVals[lo]!) * (pos - lo);
}

export function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (!n) throw new EstError("медиана пустого списка");
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * round(x, nd) как в Python: к ближайшему, а точная половина (0.125 → 0.12) — к чётному.
 * Так факты и k совпадают с посчитанными прежним est.py; toFixed один даёт половину вверх.
 */
export function pyRound(x: number, nd: number): number {
  const long = x.toFixed(nd + 30); // точное десятичное разложение двоичного значения
  const dot = long.indexOf(".");
  const tail = long.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {
    const kept = Number(long.slice(0, dot + 1 + nd));
    const lastDigit = Number(nd > 0 ? long[dot + nd] : long[dot - 1]);
    if (lastDigit % 2 === 0) return kept;
    return Number((kept + Math.sign(x) * 10 ** -nd).toFixed(nd));
  }
  return Number(x.toFixed(nd));
}
const round2 = (x: number) => pyRound(x, 2);
const round1 = (x: number) => pyRound(x, 1);

/** Как json.dumps(ensure_ascii=False): разделители ", " и ": " — маркеры остаются читаемыми и совместимыми. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => JSON.stringify(k) + ": " + pyDumps(x)).join(", ") + "}";
}

export function loadJson<T>(file: string, dflt: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return dflt;
  }
}

export function saveJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function mtimeOf(file: string): number {
  return statSync(file).mtimeMs / 1000;
}

const sameMtime = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-3;

/** *.jsonl рекурсивно (как glob **\/*.jsonl), отсортировано. */
function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const fn of names.sort()) {
      const full = path.join(d, fn);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (fn.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const uniqSortedNums = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
const uniqSortedStrs = (xs: string[]) => [...new Set(xs)].sort();
const pad = (s: string, n: number, right = false) => (right ? s.padStart(n) : s.padEnd(n));

// ----------------------------------------------------------------------------
// gh
// ----------------------------------------------------------------------------

function run(cmd: string[], stdin?: string): string {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input: stdin, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new EstError(`не найдена команда '${cmd[0]}'; нужен установленный gh CLI`);
    throw new EstError(`команда ${cmd.slice(0, 3).join(" ")}…: ${r.error.message}`);
  }
  if (r.status !== 0) throw new EstError(`команда ${cmd.slice(0, 3).join(" ")}… завершилась с кодом ${r.status}: ${(r.stderr || "").trim().slice(0, 500)}`);
  return r.stdout;
}

function ghGraphql(query: string, variables: Record<string, unknown>): Any {
  const out = run(["gh", "api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  const data = JSON.parse(out);
  if (data.errors && data.errors.length) {
    const msgs = data.errors.map((e: Any) => e.message ?? "").join("; ");
    if (!data.data) throw new EstError(`GraphQL: ${msgs}`);
    console.error(`предупреждение GraphQL: ${msgs}`);
  }
  return data.data;
}

function ghRest(p: string, method = "GET", body?: unknown): Any {
  const cmd = ["gh", "api", "-X", method, p];
  let stdin: string | undefined;
  if (body !== undefined) {
    cmd.push("--input", "-");
    stdin = JSON.stringify(body);
  }
  const out = run(cmd, stdin);
  return out.trim() ? JSON.parse(out) : null;
}

// ----------------------------------------------------------------------------
// Реестр репозиториев и проекты
// ----------------------------------------------------------------------------

function loadRegistry(): Registry {
  ensureConfigDir();
  if (!existsSync(REGISTRY_PATH)) {
    saveJson(REGISTRY_PATH, {});
    console.error(`создан реестр ${REGISTRY_PATH}`);
  }
  const reg = loadJson<unknown>(REGISTRY_PATH, null);
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw new EstError(`реестр ${REGISTRY_PATH} повреждён`);
  return reg as Registry;
}

function detectRepo(): string {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (r.error) throw new EstError("git не найден; укажите --repo owner/repo");
  if (r.status !== 0) throw new EstError("не удалось определить репозиторий из git remote origin; укажите --repo owner/repo");
  const url = r.stdout.trim();
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new EstError(`не разобран remote «${url}»; укажите --repo owner/repo`);
  return `${m[1]}/${m[2]}`;
}

function resolveRepo(arg?: string): string {
  const repo = arg || detectRepo();
  if (!/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(repo)) throw new EstError(`неверный формат --repo «${repo}», ожидается owner/repo`);
  return repo;
}

// ----------------------------------------------------------------------------
// Типы данных кэшей (совместимы с est.py)
// ----------------------------------------------------------------------------

export interface PR {
  number: number;
  title: string | null;
  state: string | null;
  headRefName: string;
  baseRefName: string;
  body: string;
  mergedAt: number | null;
  updatedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeCommit: string | null;
  closing: number[];
  commits: { oid: string; at: number | null }[];
  commits_total: number;
  files: { path: string; a: number; d: number }[];
  /** Облачные сессии из трейлера `Claude-Session` коммитов PR — их транскрипт в облаке (est cloud-import). */
  cloud?: string[];
  why?: string;
}

export interface Row {
  item_id: string;
  issue_id: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  closedAt: number | null;
  createdAt: number | null;
  labels: string[];
  est: number | null;
  fact: number | null;
  status: string | null;
  est_marker: Any | null;
  fact_marker: Any | null;
}

interface Meta {
  id: string;
  owner: string;
  number: number;
  title: string;
  fields: Record<string, { id: string; options: Record<string, string> }>;
  fetched_at: number;
}

export interface OpenPrs {
  at: number;
  items: Record<string, { headRefName: string; closing: number[] }>;
}

export interface Closers {
  oid: Record<string, { issues: number[]; at: number | null }>;
  pr: Record<string, number[]>;
}

/** Сводка сессии (Claude Code или Codex), как в кэше sessions.json. */
export interface Session {
  sid: string;
  cwd: string | null;
  n_human: number;
  ev: Any[][]; // [ts, ветка, human, hint?, uidx?]
  prlinks: [number, number][];
  commits: [number, string][];
  first_refs: number[];
  first_urls: string[];
  usage: Any[][]; // [mid, model_idx, in, out, cw5, cw1, cr, fast]
  models: string[];
  title: string; // последнее название
  title_refs: number[];
  title_urls: string[];
  title_hist?: [number, string][]; // (время переименования, название) — по порядку в транскрипте
  n_subagents: number;
  source: string;
  routine: boolean;
  mtime?: number;
  v?: number;
}

/** Подмножество Repo, нужное расчёту факта (в тестах — стаб без GitHub). */
export interface FactRepo {
  full: string;
  prs(): Map<number, PR>;
  openPrs(): OpenPrs;
  closers(): Closers;
  sessions(): Session[];
  neutralBranches(): Set<string>;
  commitDiff(oid: string): number | null;
  /** Интервалы уже записанных фактов: issue → sid (8 знаков) → [(начало, конец)]; из маркеров «Факт». */
  recorded?(): Recorded;
}

export type Recorded = Map<number, Record<string, [number, number][]>>;

const PR_FIELDS = `number title state headRefName baseRefName body mergedAt updatedAt additions deletions changedFiles
        mergeCommit{oid} closingIssuesReferences(first:20){nodes{number}}
        commits(first:100){totalCount nodes{commit{oid authoredDate messageBody}}}
        files(first:100){nodes{path additions deletions}}`;

/** Облачные сессии из трейлеров `Claude-Session: https://claude.ai/code/session_…` в тексте коммита. */
export function cloudSessionsIn(message: string): string[] {
  return uniqSortedStrs([...String(message ?? "").matchAll(/^Claude-Session:\s*https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/gm)].map((m) => m[1]!));
}

export function packPr(p: Any): PR {
  const commitNodes: Any[] = p.commits?.nodes ?? [];
  return {
    number: p.number,
    title: p.title ?? null,
    state: p.state ?? null,
    headRefName: p.headRefName || "",
    baseRefName: p.baseRefName || "",
    body: p.body || "",
    mergedAt: parseTs(p.mergedAt),
    updatedAt: parseTs(p.updatedAt),
    additions: p.additions || 0,
    deletions: p.deletions || 0,
    changedFiles: p.changedFiles || 0,
    mergeCommit: p.mergeCommit?.oid ?? null,
    closing: (p.closingIssuesReferences?.nodes ?? []).map((n: Any) => n.number),
    commits: (p.commits?.nodes ?? []).map((c: Any) => ({ oid: c.commit.oid, at: parseTs(c.commit.authoredDate) })),
    commits_total: p.commits?.totalCount ?? 0,
    files: (p.files?.nodes ?? []).map((f: Any) => ({ path: f.path, a: f.additions, d: f.deletions })),
    cloud: uniqSortedStrs(commitNodes.flatMap((c: Any) => cloudSessionsIn(c.commit?.messageBody ?? ""))),
  };
}

const nowTs = () => Date.now() / 1000;

/** Репозиторий + его проект GitHub + кэши. */
export class Repo implements FactRepo {
  full: string;
  owner: string;
  name: string;
  paths: string[];
  projectRef: { owner: string; number: number | string } | undefined;
  cacheDir: string;
  defaultBranch: string | null = null;
  optRefreshed = false;
  private meta_: Meta | null = null;
  private prs_: Map<number, PR> | null = null;
  private open_: OpenPrs | null = null;
  private closers_: Closers | null = null;
  private sessions_: Session[] | null = null;
  private rows_: Row[] | null = null;
  private recorded_: Recorded | null = null;

  constructor(full: string, registry: Registry) {
    this.full = full;
    const [owner, name] = full.split("/") as [string, string];
    this.owner = owner;
    this.name = name;
    const cfg = registry[full] ?? {};
    this.paths = cfg.paths ?? [];
    this.projectRef = cfg.project;
    this.cacheDir = path.join(CACHE_DIR, full.replace("/", "__"));
  }

  // --- проект -----------------------------------------------------------
  /** id проекта, id полей и вариантов Status. Кэшируется на диске (сутки, с проверкой реестра). */
  projectMeta(force = false): Meta {
    if (this.meta_ && !force) return this.meta_;
    const file = path.join(this.cacheDir, "project.json");
    const cached = force ? null : loadJson<Meta | null>(file, null);
    if (cached && cached.fields?.[FIELD_FACT]) {
      const fresh = nowTs() - (cached.fetched_at || 0) < PROJECT_META_TTL;
      const same = !this.projectRef || (cached.owner === this.projectRef.owner && cached.number === Number(this.projectRef.number));
      if (fresh && same) {
        this.meta_ = cached;
        return cached;
      }
    }
    const [owner, number] = this.findProject();
    const q = `
        query($o:String!,$n:Int!){
          organization(login:$o){ projectV2(number:$n){ ...F } }
        }
        fragment F on ProjectV2 { id title number
          fields(first:50){ nodes{ __typename
            ... on ProjectV2Field{ id name dataType }
            ... on ProjectV2SingleSelectField{ id name dataType options{ id name } } } } }
        `;
    let pv: Any = null;
    try {
      pv = ghGraphql(q, { o: owner, n: number })?.organization?.projectV2 ?? null;
    } catch (e) {
      if (!(e instanceof EstError)) throw e;
      pv = null;
    }
    if (!pv) {
      const data = ghGraphql(q.replace("organization(login:$o)", "user(login:$o)"), { o: owner, n: number });
      pv = data?.user?.projectV2 ?? null;
    }
    if (!pv) throw new EstError(`проект ${owner} #${number} не найден`);
    const fields: Meta["fields"] = {};
    for (const f of pv.fields.nodes) {
      if ([FIELD_EST, FIELD_FACT, FIELD_STATUS, FIELD_TOK, FIELD_USD].includes(f.name)) {
        const options: Record<string, string> = {};
        for (const o of f.options ?? []) options[o.name] = o.id;
        fields[f.name] = { id: f.id, options };
      }
    }
    const missing = [FIELD_EST, FIELD_FACT, FIELD_STATUS].filter((n) => !fields[n]);
    if (missing.length) throw new EstError(`в проекте ${owner} #${number} нет полей: ${missing.join(", ")}`);
    const meta: Meta = { id: pv.id, owner, number, title: pv.title, fields, fetched_at: nowTs() };
    saveJson(file, meta);
    this.meta_ = meta;
    return meta;
  }

  /** Элементы проекта, один раз за запуск. */
  projectRows(): Row[] {
    if (this.rows_ === null) this.rows_ = this.projectItems();
    return this.rows_;
  }

  /** Интервалы записанных фактов (маркер «Факт», поле iv); запись в этом запуске их дополняет. */
  recorded(): Recorded {
    if (this.recorded_ === null) {
      this.recorded_ = new Map();
      for (const r of this.projectRows()) {
        const iv = r.fact_marker?.iv;
        if (iv && typeof iv === "object" && !Array.isArray(iv)) this.recorded_.set(r.number, iv);
      }
    }
    return this.recorded_;
  }

  private findProject(): [string, number] {
    if (this.projectRef) return [this.projectRef.owner, Number(this.projectRef.number)];
    const q = `query($o:String!,$r:String!){ repository(owner:$o,name:$r){
            projectsV2(first:5){ nodes{ number title owner{ ... on Organization{login} ... on User{login} } } } } }`;
    const nodes = ghGraphql(q, { o: this.owner, r: this.name }).repository.projectsV2.nodes;
    if (!nodes.length) throw new EstError(`у репозитория ${this.full} нет привязанного проекта и нет записи в ${REGISTRY_PATH}`);
    return [nodes[0].owner.login, nodes[0].number];
  }

  /** Все элементы проекта с полями и последними комментариями issue. */
  private projectItems(): Row[] {
    const meta = this.projectMeta();
    const q = `
        query($id:ID!,$c:String){ node(id:$id){ ... on ProjectV2{
          items(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ id type
            content{ __typename ... on Issue{ id number title state stateReason closedAt createdAt
              labels(first:15){nodes{name}} comments(last:25){nodes{databaseId body}} } }
            fieldValues(first:20){ nodes{ __typename
              ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2Field{name} } }
              ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2SingleSelectField{name} } } } } } } } } }
        `;
    const rows: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      const items: Any = ghGraphql(q, { id: meta.id, c: cursor }).node.items;
      for (const it of items.nodes) {
        const c = it.content ?? {};
        if (c.__typename !== "Issue") continue;
        const row: Row = {
          item_id: it.id,
          issue_id: c.id,
          number: c.number,
          title: c.title,
          state: c.state,
          stateReason: c.stateReason ?? null,
          closedAt: parseTs(c.closedAt),
          createdAt: parseTs(c.createdAt),
          labels: c.labels.nodes.map((l: Any) => l.name),
          est: null,
          fact: null,
          status: null,
          est_marker: null,
          fact_marker: null,
        };
        for (const fv of it.fieldValues.nodes) {
          const fname = fv.field?.name;
          if (fname === FIELD_EST) row.est = fv.number ?? null;
          else if (fname === FIELD_FACT) row.fact = fv.number ?? null;
          else if (fname === FIELD_STATUS) row.status = fv.name ?? null;
        }
        for (const cm of c.comments.nodes) {
          const em = parseMarker(cm.body, "est");
          const fm = parseMarker(cm.body, "fact");
          if (em) row.est_marker = em;
          if (fm) row.fact_marker = fm;
        }
        rows.push(row);
      }
      if (!items.pageInfo.hasNextPage) break;
      cursor = items.pageInfo.endCursor;
    }
    return rows;
  }

  // --- PR ---------------------------------------------------------------
  /** Кэш смёрженных PR (инкрементально по updatedAt). */
  prs(): Map<number, PR> {
    if (this.prs_ !== null) return this.prs_;
    const file = path.join(this.cacheDir, "prs.json");
    const cache = loadJson<Any>(file, { prs: {} });
    let prs = new Map<number, PR>();
    for (const [k, v] of Object.entries(cache.prs ?? {})) prs.set(Number(k), v as PR);
    if ([...prs.values()].some((v) => !("baseRefName" in v) || !("cloud" in v))) prs = new Map(); // старый формат кэша — перечитать
    this.defaultBranch = cache.default_branch ?? null;
    const knownMax = prs.size ? Math.max(...[...prs.values()].map((v) => v.updatedAt || 0)) : 0;
    const q = `query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){ defaultBranchRef{name} pullRequests(first:${PR_PAGE},after:$c,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){ pageInfo{hasNextPage endCursor} nodes{ ${PR_FIELDS} } } } }`;
    let cursor: string | null = null;
    let fetched = 0;
    let stop = false;
    while (!stop && fetched < PR_MAX) {
      const data = ghGraphql(q, { o: this.owner, r: this.name, c: cursor });
      this.defaultBranch = data.repository.defaultBranchRef?.name || this.defaultBranch;
      const conn = data.repository.pullRequests;
      for (const p of conn.nodes) {
        const packed = packPr(p);
        fetched++;
        if (prs.size && (packed.updatedAt || 0) <= knownMax && prs.has(packed.number)) {
          stop = true;
          break;
        }
        prs.set(packed.number, packed);
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    this.prs_ = prs;
    this.savePrs(cache);
    return prs;
  }

  private savePrs(cache?: Any): void {
    const file = path.join(this.cacheDir, "prs.json");
    const c = { ...(cache ?? loadJson<Any>(file, {})) };
    const obj: Record<string, PR> = {};
    for (const [k, v] of this.prs_!) obj[String(k)] = v;
    c.prs = obj;
    c.default_branch = this.defaultBranch;
    if (this.open_ !== null) c.open = this.open_;
    saveJson(file, c);
  }

  /** Один PR (в т.ч. не смёрженный) — из кэша или запросом. null — только если такого PR нет. */
  pr(number: number): PR | null {
    const prs = this.prs();
    const cached = prs.get(number);
    if (cached) return cached;
    const q = `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ ${PR_FIELDS} } } }`;
    let data: Any;
    try {
      data = ghGraphql(q, { o: this.owner, r: this.name, n: number });
    } catch (e) {
      if (e instanceof EstError && errIs(e, "Could not resolve to a PullRequest")) return null;
      throw e;
    }
    const p = data.repository.pullRequest;
    if (!p) return null;
    const packed = packPr(p);
    if (packed.state === "MERGED") {
      prs.set(number, packed);
      this.savePrs();
    }
    return packed;
  }

  /** Открытые PR: {номер: {headRefName, closing}} — их ветки чужие для остальных задач (кэш на час). */
  openPrs(): OpenPrs {
    if (this.open_ !== null) return this.open_;
    this.prs();
    const cache = loadJson<Any>(path.join(this.cacheDir, "prs.json"), {});
    const now = nowTs();
    const cached = cache.open as OpenPrs | undefined;
    if (cached && now - (cached.at || 0) < OPEN_PRS_TTL) {
      this.open_ = cached;
      return cached;
    }
    const q = `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ pullRequests(states:[OPEN],first:100){
            nodes{ number headRefName closingIssuesReferences(first:20){nodes{number}} } } } }`;
    const data = ghGraphql(q, { o: this.owner, r: this.name });
    const items: OpenPrs["items"] = {};
    for (const p of data.repository.pullRequests.nodes) {
      items[String(p.number)] = { headRefName: p.headRefName || "", closing: p.closingIssuesReferences.nodes.map((n: Any) => n.number) };
    }
    this.open_ = { at: now, items };
    this.savePrs(cache);
    return this.open_;
  }

  neutralBranches(): Set<string> {
    this.prs();
    const s = new Set(BASE_BRANCHES);
    if (this.defaultBranch) s.add(this.defaultBranch);
    return s;
  }

  /**
   * Индекс закрывателей всех закрытых issue репо (инкрементально по updatedAt):
   * {"oid": {oid: {"issues": [...], "at": ts}}, "pr": {"N": [issues]}}.
   */
  closers(): Closers {
    if (this.closers_ !== null) return this.closers_;
    const file = path.join(this.cacheDir, "closers.json");
    const cache = loadJson<Any>(file, { issues: {} });
    const issues: Record<string, { updatedAt: number; closers: Any[] }> = { ...(cache.issues ?? {}) };
    const vals = Object.values(issues);
    const knownMax = vals.length ? Math.max(...vals.map((v) => v.updatedAt || 0)) : 0;
    const q = `query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){
          issues(states:[CLOSED],first:100,after:$c,orderBy:{field:UPDATED_AT,direction:DESC}){
            pageInfo{hasNextPage endCursor} nodes{ number updatedAt
              timelineItems(last:3,itemTypes:[CLOSED_EVENT]){ nodes{ ... on ClosedEvent{ closer{ __typename
                ... on Commit{ oid authoredDate } ... on PullRequest{ number repository{nameWithOwner} } } } } } } } } }`;
    let cursor: string | null = null;
    let fetched = 0;
    let stop = false;
    while (!stop && fetched < ISSUES_MAX) {
      const conn: Any = ghGraphql(q, { o: this.owner, r: this.name, c: cursor }).repository.issues;
      for (const n of conn.nodes) {
        fetched++;
        const upd = parseTs(n.updatedAt) || 0;
        const key = String(n.number);
        if (vals.length && upd <= knownMax && key in issues) {
          stop = true;
          break;
        }
        const closers: Any[] = [];
        for (const t of n.timelineItems.nodes) {
          const c = t?.closer ?? {};
          if (c.__typename === "Commit") closers.push({ type: "commit", oid: c.oid, at: parseTs(c.authoredDate) });
          else if (c.__typename === "PullRequest" && (c.repository?.nameWithOwner ?? this.full) === this.full) closers.push({ type: "pr", number: c.number });
        }
        issues[key] = { updatedAt: upd, closers };
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    saveJson(file, { issues });
    const oid: Closers["oid"] = {};
    const pr: Closers["pr"] = {};
    for (const [key, v] of Object.entries(issues)) {
      const num = Number(key);
      for (const c of v.closers) {
        if (c.type === "commit") {
          const d = (oid[c.oid] ??= { issues: [], at: c.at ?? null });
          if (!d.issues.includes(num)) d.issues.push(num);
        } else {
          const lst = (pr[String(c.number)] ??= []);
          if (!lst.includes(num)) lst.push(num);
        }
      }
    }
    this.closers_ = { oid, pr };
    return this.closers_;
  }

  /** Дифф одиночного коммита (для issue без PR): строки без lock/снапшотов/минифицированного. Кэш. */
  commitDiff(oid: string): number | null {
    const file = path.join(this.cacheDir, "commits.json");
    const cache = loadJson<Record<string, number>>(file, {});
    if (oid in cache) return cache[oid]!;
    let data: Any;
    try {
      data = ghRest(`repos/${this.full}/commits/${oid}`);
    } catch (e) {
      if (!(e instanceof EstError)) throw e;
      console.error(`предупреждение: дифф коммита ${oid.slice(0, 7)} не получен: ${e.message}`);
      return null;
    }
    let n = 0;
    for (const f of data.files ?? []) if (!DIFF_EXCLUDE.test(f.filename || "")) n += (f.additions || 0) + (f.deletions || 0);
    cache[oid] = n;
    saveJson(file, cache);
    return n;
  }

  // --- транскрипты -------------------------------------------------------
  sessions(): Session[] {
    if (this.sessions_ === null) this.sessions_ = loadSessions(this);
    return this.sessions_;
  }
}

// ----------------------------------------------------------------------------
// Маркеры в комментариях
// ----------------------------------------------------------------------------

export function parseMarker(body: string | null | undefined, kind: string): Any | null {
  if (!body) return null;
  const m = new RegExp("<!--\\s*" + kind + "\\s+(\\{[\\s\\S]*?\\})\\s*-->").exec(body);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Транскрипты Claude Code
// ----------------------------------------------------------------------------

const encodePath = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

const HASH_RE = /(?<![0-9a-zA-Z])[0-9a-f]{7,40}(?![0-9a-zA-Z])/g;
// «#N» — границы как у \w в Python (буквы и цифры любого алфавита)
const ISSUE_REF_RE = /(?<![\p{L}\p{N}_/])#(\d{1,6})(?![\p{L}\p{N}_])/gu;
const ISSUE_URL_RE = /github\.com\/([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)\/issues\/(\d{1,6})(?!\d)/gu; // URL issue c репо
// Не человеческие промпты: уведомления, служебные вставки, автоматические рутины (scheduled-task).
const SKIP_PROMPT_PREFIXES = ["<task-notification", "<\\task-notification", "<local-command", "<command-", "<system-reminder", "<\\system-reminder", "<bash-", "<scheduled-task", "<\\scheduled-task"];

const refsIn = (txt: string) => uniqSortedNums([...txt.matchAll(ISSUE_REF_RE)].map((m) => parseInt(m[1]!, 10)));
const urlsIn = (txt: string) => uniqSortedStrs([...txt.matchAll(ISSUE_URL_RE)].map((m) => `${m[1]}#${parseInt(m[2]!, 10)}`));

function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (b && typeof b === "object") {
        const o = b as Any;
        if (o.type === "text") parts.push(o.text || "");
        else if (typeof o.content === "string" || Array.isArray(o.content)) parts.push(textOfContent(o.content));
      } else if (typeof b === "string") parts.push(b);
    }
    return parts.join("\n");
  }
  return "";
}

// Вставка приложения в текст промпта: Claude Code desktop (Code tab) ставит её перед текстом
// человека. Незакрытая — до конца текста.
const REMINDER_RE = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** Текст промпта без вставок <system-reminder>: по нему решается, человек ли это, и ищется номер задачи. */
function promptText(c: unknown): string {
  return textOfContent(c).replace(REMINDER_RE, "");
}

function isHumanPrompt(r: Any): boolean {
  if (r.type !== "user" || r.isSidechain || r.isMeta) return false;
  const origin = r.origin;
  if (origin && typeof origin === "object" && origin.kind && origin.kind !== "human") return false;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b: Any) => b && typeof b === "object" && b.type === "tool_result")) return false;
  const txt = promptText(c).replace(/^\s+/, "");
  if (!txt) return false;
  return !SKIP_PROMPT_PREFIXES.some((p) => txt.startsWith(p));
}

interface Acc {
  cwd: string | null;
  n_human: number;
  ev: Any[][];
  prlinks: [number, number][];
  commits: [number, string][];
  first_refs: number[] | null;
  first_urls: string[];
  usage: Any[][];
  models: string[];
  mids: Set<string>;
  title: string;
  titles: [number, string][];
}

const newAcc = (): Acc => ({ cwd: null, n_human: 0, ev: [], prlinks: [], commits: [], first_refs: null, first_urls: [], usage: [], models: [], mids: new Set(), title: "", titles: [] });

function* jsonlRecords(file: string): Generator<Any> {
  const text = readFileSync(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

/** Хеши коммитов из вывода инструмента (не больше 60 на вывод, 5000 на сессию). */
function collectHashes(acc: Acc, ts: number, txt: string): void {
  const seen = new Set<string>();
  for (const m of txt.matchAll(HASH_RE)) {
    const h = m[0];
    if (!seen.has(h) && seen.size < 60 && acc.commits.length < 5000) {
      seen.add(h);
      acc.commits.push([ts, h]);
    }
  }
}

/**
 * Разобрать один jsonl (сессия или её субагент) в общий аккумулятор acc.
 *
 * Субагенты (<sid>/subagents/**\/*.jsonl — Agent/Workflow) — часть той же сессии: их записи идут в
 * таймлайн и дают якоря по коммитам, но «человеческие» промпты в них — это задания от оркестратора,
 * а не от человека, поэтому n_human и первый промпт берём только с верхнего уровня. Зато задание
 * субагенту часто называет задачу («#N» или URL issue): если в нём ровно один номер, все записи
 * этого субагента получают подсказку hint=N — так работа параллельных субагентов в workflow
 * привязывается к своим задачам, а не делится по порядку коммитов.
 */
function scanJsonl(file: string, acc: Acc, subagent: boolean): void {
  scanRecords(jsonlRecords(file), acc, subagent);
}

/** То же по готовым записям: у облачной сессии они собираются из её событий (parseCloudFile). */
function scanRecords(records: Iterable<Any>, acc: Acc, subagent: boolean): void {
  const commitToolIds = new Set<string>();
  let hint = ""; // подсказка задачи для записей субагента: "N" или "owner/repo#N"
  let hintDone = !subagent;
  let pending: string[] = []; // переименования без времени: время — у следующей записи
  let lastTs: number | null = null;
  for (const r of records) {
    const t = r.type;
    const ts = r.timestamp ? parseTs(r.timestamp) : null;
    if (acc.cwd === null && r.cwd) acc.cwd = r.cwd;
    if (t === "custom-title" && !subagent) {
      // название сессии по конвенции «#<номер> <название задачи>» привязывает к задаче записи с момента
      // переименования (первое — с начала сессии); Claude Code пишет его без времени
      // Claude Code повторяет запись по ходу сессии — период открывает только смена названия
      const title = String(r.customTitle || "");
      const prev = pending.length ? pending[pending.length - 1] : acc.titles.length ? acc.titles[acc.titles.length - 1]![1] : null;
      acc.title = title;
      if (title === prev) continue;
      if (ts !== null) acc.titles.push([ts, title]);
      else pending.push(title);
      continue;
    }
    if (ts !== null) {
      for (const title of pending) acc.titles.push([ts, title]);
      pending = [];
      lastTs = ts;
    }
    if (t === "pr-link") {
      const pr = r.prNumber;
      if (ts && Number.isInteger(pr)) acc.prlinks.push([ts, pr]);
      continue;
    }
    if (t !== "user" && t !== "assistant") continue;
    if (ts === null) continue;
    const human = !subagent && isHumanPrompt(r);
    if (human) acc.n_human++;
    const msg = r.message ?? {};
    const content = msg.content;
    if (!hintDone && t === "user") {
      // первый промпт субагента — задание от оркестратора
      const txt = textOfContent(content);
      if (txt.trim()) {
        hintDone = true;
        const nums = refsIn(txt);
        const urls = urlsIn(txt);
        if (urls.length === 1 && (!nums.length || (nums.length === 1 && nums[0] === parseInt(urls[0]!.split("#")[1]!, 10)))) hint = urls[0]!;
        else if (nums.length === 1 && !urls.length) hint = String(nums[0]);
      }
    }
    // Токены: usage дублируется на каждой записи одного ответа (по блоку контента) —
    // считаем один раз на message.id.
    let uidx = -1;
    if (t === "assistant") {
      const u = msg.usage;
      const mid = msg.id;
      const model = msg.model;
      if (u && typeof u === "object" && mid && model && model !== "<synthetic>" && !acc.mids.has(mid)) {
        acc.mids.add(mid);
        const cc = u.cache_creation ?? {};
        const cw = Math.trunc(u.cache_creation_input_tokens || 0);
        const cw1 = Math.trunc(cc.ephemeral_1h_input_tokens || 0);
        let cw5 = Math.trunc(cc.ephemeral_5m_input_tokens || 0);
        if (cw1 + cw5 === 0) cw5 = cw;
        if (!acc.models.includes(model)) acc.models.push(model);
        uidx = acc.usage.length;
        acc.usage.push([mid.slice(-12), acc.models.indexOf(model), Math.trunc(u.input_tokens || 0), Math.trunc(u.output_tokens || 0), cw5, cw1, Math.trunc(u.cache_read_input_tokens || 0), u.speed === "fast" ? 1 : 0]);
      }
    }
    acc.ev.push([ts, r.gitBranch || "", human ? 1 : 0, hint, uidx]);
    if (human && acc.first_refs === null) {
      const txt = promptText(content);
      acc.first_refs = refsIn(txt);
      acc.first_urls = urlsIn(txt);
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (t === "assistant" && b.type === "tool_use") {
        const cmd = b.input && typeof b.input === "object" ? b.input.command : null;
        if (typeof cmd === "string" && cmd.includes("git commit")) commitToolIds.add(b.id);
      } else if (t === "user" && b.type === "tool_result") {
        // Хеши берём из ЛЮБОГО tool_result, не только после `git commit`: коммит часто делает
        // скрипт (проверки + commit + push), и хеш всплывает в его выводе. Ложные якоря (старые
        // хеши из git log) отсекает ANCHOR_TOLERANCE — хеш должен появиться рядом по времени с
        // authoredDate коммита.
        let txt = textOfContent(b.content);
        const tur = r.toolUseResult;
        if (tur && typeof tur === "object") txt += "\n" + String(tur.stdout ?? "") + "\n" + String(tur.stderr ?? "");
        if (!commitToolIds.has(b.tool_use_id) && !txt.includes("git") && txt.length > 20000) continue; // огромный вывод без git — не тратим время
        collectHashes(acc, ts, txt);
      }
    }
  }
  // переименование в самом конце: записей после него нет
  for (const title of pending) acc.titles.push([lastTs === null ? 0 : lastTs + 1, title]);
}

/** Транскрипты субагентов сессии: <dir>/<sid>/subagents/**\/*.jsonl. */
function subagentFiles(file: string): string[] {
  const sdir = path.join(file.slice(0, -6), "subagents");
  let isDir = false;
  try {
    isDir = statSync(sdir).isDirectory();
  } catch {
    isDir = false;
  }
  return isDir ? walkJsonl(sdir) : [];
}

const byTs = (a: Any[], b: Any[]) => (a[0] as number) - (b[0] as number);

/** Компактная сводка одной сессии: jsonl верхнего уровня + её субагенты. */
export function parseSessionFile(file: string): Session {
  const acc = newAcc();
  scanJsonl(file, acc, false);
  const subs = subagentFiles(file);
  for (const sf of subs) {
    try {
      scanJsonl(sf, acc, true);
    } catch {
      continue;
    }
  }
  acc.ev.sort(byTs);
  acc.prlinks.sort(byTs);
  acc.commits.sort(byTs);
  return {
    sid: path.basename(file).slice(0, -6),
    cwd: acc.cwd,
    n_human: acc.n_human,
    ev: acc.ev,
    prlinks: acc.prlinks,
    commits: acc.commits,
    first_refs: acc.first_refs ?? [],
    first_urls: acc.first_urls,
    usage: acc.usage,
    models: acc.models,
    title: acc.title,
    title_refs: refsIn(acc.title),
    title_urls: urlsIn(acc.title),
    title_hist: acc.titles,
    n_subagents: subs.length,
    source: "claude",
    routine: acc.n_human < 3 && !acc.prlinks.length && !acc.commits.length,
  };
}

function codexText(out: unknown): string {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return out.map((b) => (b && typeof b === "object" ? String((b as Any).text || "") : "")).join(" ");
  return String(out ?? "");
}

/**
 * Сводка сессии Codex (~/.codex/sessions/**\/rollout-*.jsonl) в том же формате, что у Claude Code.
 *
 * Записи: session_meta (cwd, id), event_msg/item_completed с item.type=UserMessage — человеческий
 * промпт, response_item/{message,custom_tool_call,function_call,*_output} — работа агента (хеши
 * коммитов ищем в выводах инструментов), token_usage_record — токены ответа (раз на response_id),
 * turn_context / thread_settings_applied — модель. Ветки у записей нет — считается нейтральной.
 */
export function parseCodexFile(file: string): Session {
  const acc = newAcc();
  let sid: string | null = null;
  let model: string | null = null;
  const commitCalls = new Set<string>();
  for (const r of jsonlRecords(file)) {
    const t = r.type;
    const p: Any = r.payload && typeof r.payload === "object" ? r.payload : {};
    const ts = r.timestamp ? parseTs(r.timestamp) : null;
    if (t === "session_meta") {
      acc.cwd = p.cwd || acc.cwd;
      sid = p.session_id || p.id || sid;
      continue;
    }
    if (t === "turn_context") {
      model = p.model || model;
      continue;
    }
    if (ts === null) continue;
    if (t === "event_msg") {
      const pt = p.type;
      if (pt === "thread_settings_applied") model = p.thread_settings?.model || model;
      else if (pt === "item_completed") {
        const item = p.item ?? {};
        if (item.type === "UserMessage") {
          const txt = codexText(item.content);
          acc.n_human++;
          acc.ev.push([ts, "", 1, "", -1]);
          if (acc.first_refs === null) {
            acc.first_refs = refsIn(txt);
            acc.first_urls = urlsIn(txt);
          }
        }
      }
      continue;
    }
    if (t === "token_usage_record") {
      const u = p.usage ?? {};
      const rid: string | undefined = p.response_id || p.turn_id;
      if (rid && !acc.mids.has(rid)) {
        acc.mids.add(rid);
        const m = model || "codex";
        if (!acc.models.includes(m)) acc.models.push(m);
        const cached = Math.trunc(u.cached_input_tokens || 0);
        const uidx = acc.usage.length;
        acc.usage.push([rid.slice(-12), acc.models.indexOf(m), Math.max(0, Math.trunc(u.input_tokens || 0) - cached), Math.trunc(u.output_tokens || 0), Math.trunc(u.cache_write_input_tokens || 0), 0, cached, 0]);
        acc.ev.push([ts, "", 0, "", uidx]);
      }
      continue;
    }
    if (t !== "response_item") continue;
    const pt = p.type;
    if (pt === "message" && p.role === "assistant") acc.ev.push([ts, "", 0, "", -1]);
    else if (pt === "custom_tool_call" || pt === "function_call") {
      const inp = pt === "custom_tool_call" ? p.input : p.arguments;
      if (typeof inp === "string" && inp.includes("git commit")) commitCalls.add(p.call_id);
      acc.ev.push([ts, "", 0, "", -1]);
    } else if (pt === "custom_tool_call_output" || pt === "function_call_output") {
      const txt = codexText(p.output);
      acc.ev.push([ts, "", 0, "", -1]);
      if (!commitCalls.has(p.call_id) && !txt.includes("git") && txt.length > 20000) continue;
      collectHashes(acc, ts, txt);
    }
  }
  acc.ev.sort(byTs);
  acc.commits.sort(byTs);
  return {
    sid: sid || path.basename(file).slice(0, -6),
    cwd: acc.cwd,
    n_human: acc.n_human,
    ev: acc.ev,
    prlinks: [],
    commits: acc.commits,
    first_refs: acc.first_refs ?? [],
    first_urls: acc.first_urls,
    usage: acc.usage,
    models: acc.models,
    title: "",
    title_refs: [],
    title_urls: [],
    n_subagents: 0,
    source: "codex",
    routine: acc.n_human < 3 && !acc.commits.length,
  };
}


/** Выгрузка облачной сессии: то, что сохраняет браузерный сниппет из SKILL.md (раздел «Облачная сессия»). */
export interface CloudExport {
  v: number;
  session: string;
  repo: string;
  title?: string;
  events: Any[];
}

export function isCloudExport(x: Any): x is CloudExport {
  return !!x && typeof x === "object" && typeof x.session === "string" && /^session_[A-Za-z0-9]+$/.test(x.session) && typeof x.repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(x.repo) && Array.isArray(x.events);
}

/**
 * Сводка облачной сессии Claude Code из её событий (claude.ai/v1/code/sessions/<id>/events) в том же формате, что у
 * локальной: события assistant/user — это те же записи транскрипта. Ветки у записи нет — её приносит событие
 * `vcs_state_changed` (при коммите и push), до первого такого события ветка нейтральная; человек — `source: client`;
 * ответы субагентов (`parent_tool_use_id`) — отдельный поток, как файл субагента у локальной сессии. Название
 * сессии — из выгрузки: «#N …» привязывает, как у локальной.
 */
export function parseCloudFile(file: string): Session {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!isCloudExport(data)) throw new EstError(`${file}: не выгрузка облачной сессии (нужны session, repo, events)`);
  const events = [...data.events].sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num));
  let branch = "";
  let cwd: string | null = null;
  const top: Any[] = data.title ? [{ type: "custom-title", customTitle: data.title }] : [];
  const subs = new Map<string, Any[]>();
  for (const e of events) {
    const p = e?.payload ?? {};
    if (e?.event_type === "system") {
      if (p.subtype === "init" && p.cwd) cwd = p.cwd;
      if (p.subtype === "vcs_state_changed" && p.branch) branch = p.branch;
      continue;
    }
    if (e?.event_type !== "user" && e?.event_type !== "assistant") continue;
    const parent: string | null = p.parent_tool_use_id ?? null;
    const rec = {
      type: e.event_type,
      timestamp: p.timestamp || e.created_at,
      gitBranch: branch,
      cwd,
      message: p.message,
      toolUseResult: p.tool_use_result,
      origin: { kind: e.source === "client" && !parent ? "human" : "agent" },
    };
    if (!parent) top.push(rec);
    else {
      if (!subs.has(parent)) subs.set(parent, []);
      subs.get(parent)!.push(rec);
    }
  }
  const acc = newAcc();
  scanRecords(top, acc, false);
  for (const recs of subs.values()) scanRecords(recs, acc, true);
  acc.ev.sort(byTs);
  acc.commits.sort(byTs);
  return {
    sid: data.session,
    cwd: acc.cwd,
    n_human: acc.n_human,
    ev: acc.ev,
    prlinks: [],
    commits: acc.commits,
    first_refs: acc.first_refs ?? [],
    first_urls: acc.first_urls,
    usage: acc.usage,
    models: acc.models,
    title: acc.title,
    title_refs: refsIn(acc.title),
    title_urls: urlsIn(acc.title),
    title_hist: acc.titles,
    n_subagents: subs.size,
    source: "cloud",
    routine: acc.n_human < 3 && !acc.commits.length,
  };
}

/** Путь выгрузки облачной сессии в каталоге состояния: по репозиторию, файл — id сессии. */
export const cloudPath = (repoFull: string, session: string) => path.join(CLOUD_DIR, ...repoFull.split("/"), `${session}.json`);

function cloudFiles(repo: Repo): string[] {
  const d = path.join(CLOUD_DIR, ...repo.full.split("/"));
  try {
    return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => path.join(d, f)).sort();
  } catch {
    return [];
  }
}

const isCloudFile = (file: string) => file.startsWith(CLOUD_DIR.replace(/\/+$/, "") + "/");

/** cwd из первой записи session_meta. */
function codexCwd(file: string): string | null {
  try {
    for (const r of jsonlRecords(file)) {
      if (r.type === "session_meta") return r.payload?.cwd ?? null;
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function cwdMatches(cwd: string | null | undefined, paths: string[]): boolean {
  if (!cwd) return true; // не знаем — не отбрасываем
  return paths.some((p) => cwd === p || cwd.startsWith(p.replace(/\/+$/, "") + "/"));
}

/** Сессии Codex, чей cwd — путь репозитория; индекс cwd кэшируется по mtime файла. */
function codexFiles(repo: Repo): string[] {
  let files: string[] = [];
  for (const d of CODEX_DIRS) files = files.concat(walkJsonl(d));
  if (!files.length) return [];
  const idxPath = path.join(CACHE_DIR, "codex-index.json");
  const idx = loadJson<Record<string, { mtime: number; cwd: string | null }>>(idxPath, {});
  let changed = false;
  const out: string[] = [];
  for (const f of uniqSortedStrs(files)) {
    let m: number;
    try {
      m = mtimeOf(f);
    } catch {
      continue;
    }
    let c = idx[f];
    if (!c || !sameMtime(c.mtime, m)) {
      c = { mtime: m, cwd: codexCwd(f) };
      idx[f] = c;
      changed = true;
    }
    if (c.cwd && cwdMatches(c.cwd, repo.paths)) out.push(f);
  }
  if (changed) saveJson(idxPath, idx);
  return out;
}

const isCodexFile = (file: string) => CODEX_DIRS.some((d) => file.startsWith(d.replace(/\/+$/, "") + "/"));

/** mtime сессии с учётом субагентов (их файлы дописываются позже верхнего уровня). */
function sessionMtime(file: string): number {
  let m = mtimeOf(file);
  for (const sf of subagentFiles(file)) {
    try {
      m = Math.max(m, mtimeOf(sf));
    } catch {
      /* файл исчез — не важно */
    }
  }
  return m;
}

function transcriptFiles(repo: Repo): string[] {
  const files: string[] = [];
  for (const p of repo.paths) {
    const enc = encodePath(p);
    let dirs: string[];
    try {
      dirs = readdirSync(PROJECTS_DIR).filter((d) => d.startsWith(enc));
    } catch {
      continue;
    }
    for (const d of dirs) {
      let names: string[];
      try {
        names = readdirSync(path.join(PROJECTS_DIR, d));
      } catch {
        continue;
      }
      for (const fn of names) if (fn.endsWith(".jsonl")) files.push(path.join(PROJECTS_DIR, d, fn));
    }
  }
  return uniqSortedStrs(files);
}

/** Разбор транскриптов с кэшем по mtime (инкрементально). */
function loadSessions(repo: Repo): Session[] {
  if (!repo.paths.length) throw new EstError(`для ${repo.full} не заданы локальные пути в ${REGISTRY_PATH} — транскрипты искать негде`);
  const file = path.join(repo.cacheDir, "sessions.json");
  const cache = loadJson<Record<string, Session>>(file, {});
  const out: Record<string, Session> = {};
  let changed = false;
  const files = transcriptFiles(repo).concat(codexFiles(repo), cloudFiles(repo));
  for (const f of files) {
    let mtime: number;
    try {
      mtime = isCodexFile(f) || isCloudFile(f) ? mtimeOf(f) : sessionMtime(f);
    } catch {
      continue;
    }
    const c = cache[f];
    if (c && sameMtime(c.mtime, mtime) && c.v === SESSION_CACHE_V) {
      out[f] = c;
      continue;
    }
    let s: Session;
    try {
      s = isCodexFile(f) ? parseCodexFile(f) : isCloudFile(f) ? parseCloudFile(f) : parseSessionFile(f);
    } catch (e) {
      console.error(`пропущен ${f}: ${(e as Error).message}`);
      continue;
    }
    s.mtime = mtime;
    s.v = SESSION_CACHE_V;
    out[f] = s;
    changed = true;
  }
  const same = Object.keys(cache).length === Object.keys(out).length && Object.keys(cache).every((k) => k in out);
  if (changed || !same) saveJson(file, out);
  const sessions: Session[] = [];
  for (const s of Object.values(out)) {
    if (!s.ev.length || s.routine) continue;
    // облачная сессия работает в своём контейнере (cwd /home/user/…) — к репозиторию её относит каталог выгрузки
    if (s.source !== "cloud" && !cwdMatches(s.cwd, repo.paths)) continue;
    sessions.push(s);
  }
  return sessions;
}

// ----------------------------------------------------------------------------
// Привязка задачи к PR/коммитам
// ----------------------------------------------------------------------------

const branchTokens = (branch: string | null | undefined) => (branch || "").split(/[/_\-.]+/).filter(Boolean);
const isDigits = (s: string) => /^\d+$/.test(s);

/**
 * Ветка содержит номер задачи как отдельный токен (issue-N-…, /N-…, -N-…),
 * соседние токены не чисто числовые (чтобы даты вида 2026-09-16 не ловились).
 */
export function branchHasIssue(branch: string | null | undefined, n: number): boolean {
  const toks = branchTokens(branch);
  const sn = String(n);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const prev = i > 0 ? toks[i - 1]! : "";
    const nxt = i + 1 < toks.length ? toks[i + 1]! : "";
    if ([`issue${sn}`, `issues${sn}`, `gh${sn}`].includes(t.toLowerCase())) return true;
    if (t === sn) {
      if (isDigits(prev) || isDigits(nxt)) continue;
      if (n < 10 && !["issue", "issues", "gh"].includes(prev.toLowerCase())) continue; // однозначные номера — только с явным issue-N
      return true;
    }
  }
  return false;
}

/**
 * Номер задачи из ветки: <type>/N-slug (конвенция) или issue-N / issues/N.
 * Голые числа в других местах (release/2026-09) номером не считаются.
 */
export function branchIssueNumber(branch: string | null | undefined): number | null {
  const m = BRANCH_CONV_RE.exec(branch || "");
  if (m) return parseInt(m[2]!, 10);
  const m2 = /(?:^|[/_-])issues?[/_-]?(\d{1,6})(?:$|[/_-])/i.exec(branch || "");
  return m2 ? parseInt(m2[1]!, 10) : null;
}

/** Тип задачи из ветки <type>/N-slug, если ветка по конвенции. */
export function branchType(branch: string | null | undefined): string | null {
  const m = BRANCH_CONV_RE.exec(branch || "");
  return m ? m[1]!.toLowerCase() : null;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function closingRe(repo: Pick<Repo, "owner" | "name">, n: number): RegExp {
  return new RegExp(
    "(?<![\\p{L}\\p{N}_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|закрывает|закрыт[аоы]?|закрыть|исправляет|решает|устраняет)" +
      `[\\s:]*(?:#|https://github\\.com/${reEscape(repo.owner)}/${reEscape(repo.name)}/issues/)${n}(?!\\d)`,
    "iu",
  );
}

function fetchIssue(repo: Repo, number: number): Any {
  const q = `
    query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){
      id number title state stateReason closedAt createdAt url
      issueType{name}
      labels(first:20){nodes{name}}
      closedByPullRequestsReferences(first:20){nodes{number repository{nameWithOwner}}}
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){ nodes{ __typename
        ... on CrossReferencedEvent{ source{ __typename ... on PullRequest{ number repository{nameWithOwner} } } }
        ... on ConnectedEvent{ subject{ __typename ... on PullRequest{ number repository{nameWithOwner} } } } } }
      closedEvents: timelineItems(last:10,itemTypes:[CLOSED_EVENT]){ nodes{ __typename
        ... on ClosedEvent{ closer{ __typename ... on PullRequest{ number repository{nameWithOwner} } ... on Commit{ oid authoredDate } } } } }
      projectItems(first:10){ nodes{ id project{ id } fieldValues(first:20){ nodes{ __typename
        ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2Field{name} } }
        ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2SingleSelectField{name} } } } } } }
      comments(last:100){ nodes{ databaseId body author{login} } }
    } } }`;
  let data: Any;
  try {
    data = ghGraphql(q, { o: repo.owner, r: repo.name, n: number });
  } catch (e) {
    if (e instanceof EstError && errIs(e, "Could not resolve to an Issue")) throw new NotAnIssue(`#${number} — не issue в ${repo.full}`);
    throw e;
  }
  const issue = data.repository.issue;
  if (!issue) throw new EstError(`issue #${number} не найден в ${repo.full}`);
  // события закрытия — в общий список timeline (маркеры fact/est ищем в последних 100 комментариях)
  issue.timelineItems.nodes.push(...(issue.closedEvents?.nodes ?? []));
  return issue;
}

interface IssueFields {
  item_id: string | null;
  est: number | null;
  fact: number | null;
  status: string | null;
}

/** Значения полей проекта для issue (item_id, est, fact, status). */
function issueProjectFields(issue: Any, meta: Meta): IssueFields {
  for (const it of issue.projectItems?.nodes ?? []) {
    if (it.project.id !== meta.id) continue;
    const vals: IssueFields = { item_id: it.id, est: null, fact: null, status: null };
    for (const fv of it.fieldValues.nodes) {
      const fname = fv.field?.name;
      if (fname === FIELD_EST) vals.est = fv.number ?? null;
      else if (fname === FIELD_FACT) vals.fact = fv.number ?? null;
      else if (fname === FIELD_STATUS) vals.status = fv.name ?? null;
    }
    return vals;
  }
  return { item_id: null, est: null, fact: null, status: null };
}

type Closer = { oid: string; at: number | null };

/** Что нужно привязке PR от репозитория: имя, кэш PR и PR по номеру. */
type LinkRepo = Pick<Repo, "full" | "owner" | "name" | "prs" | "pr">;

/** Issue → PR (сильные и слабые связи) и коммиты-закрыватели. */
export function resolveLinks(repo: LinkRepo, issue: Any): [PR[], Closer[], boolean] {
  const n: number = issue.number;
  const same = (o: Any) => (o?.repository?.nameWithOwner ?? repo.full) === repo.full;
  const strong = new Map<number, string>();
  const weak = new Map<number, string>();
  let closers: Closer[] = [];
  const add = (d: Map<number, string>, num: number | undefined, why: string) => {
    if (num && num !== n && !d.has(num)) d.set(num, why);
  };

  for (const p of issue.closedByPullRequestsReferences.nodes) if (same(p)) add(strong, p.number, "закрыл issue");
  for (const t of issue.timelineItems.nodes) {
    const tn = t.__typename;
    if (tn === "CrossReferencedEvent") {
      const s = t.source ?? {};
      if (s.__typename === "PullRequest" && same(s)) add(weak, s.number, "упоминание");
    } else if (tn === "ConnectedEvent") {
      const s = t.subject ?? {};
      if (s.__typename === "PullRequest" && same(s)) add(strong, s.number, "связан вручную");
    } else if (tn === "ClosedEvent") {
      const c = t.closer ?? {};
      if (c.__typename === "PullRequest" && same(c)) add(strong, c.number, "закрыл issue");
      else if (c.__typename === "Commit") closers.push({ oid: c.oid, at: parseTs(c.authoredDate) });
    }
  }

  const prs = repo.prs();
  const crx = closingRe(repo, n);
  const mention = new RegExp(`(?<![\\p{L}\\p{N}_/])#${n}(?!\\d)`, "u");
  const closerOids = new Set(closers.map((c) => c.oid));
  for (const [num, p] of prs) {
    if (p.closing.includes(n)) add(strong, num, "closingIssuesReferences");
    else if (p.mergeCommit && closerOids.has(p.mergeCommit)) add(strong, num, "merge-коммит закрыл issue");
    else if (p.commits.some((c) => closerOids.has(c.oid))) add(strong, num, "коммит PR закрыл issue");
    else if (crx.test(p.body)) add(strong, num, `Closes #${n} в теле PR`);
    else if (branchHasIssue(p.headRefName, n)) add(strong, num, "номер в ветке");
    else if (mention.test(p.body)) add(weak, num, "упоминание в теле PR");
  }
  for (const num of strong.keys()) weak.delete(num);
  // Упоминание в PR, который закрывает другие задачи, — чужая работа: иначе задача без своего PR получает его
  // время (с делением, хотя факт той задачи уже записан) и тип по его ветке.
  for (const num of [...weak.keys()]) {
    const p = repo.pr(num);
    if (p && p.closing.length && !p.closing.includes(n)) weak.delete(num);
  }
  // Слабые связи используем только если сильных нет
  const [use, weakUsed] = strong.size ? [strong, false] : [weak, weak.size > 0];
  const prObjs: PR[] = [];
  for (const [num, why] of [...use.entries()].sort((a, b) => a[0] - b[0])) {
    const p = repo.pr(num);
    if (p) prObjs.push({ ...p, why });
  }
  // коммиты-закрыватели, не принадлежащие ни одному найденному PR
  const prOids = new Set<string>();
  for (const p of prObjs) {
    for (const c of p.commits) prOids.add(c.oid);
    if (p.mergeCommit) prOids.add(p.mergeCommit);
  }
  closers = closers.filter((c) => !prOids.has(c.oid));
  return [prObjs, closers, weakUsed];
}

// ----------------------------------------------------------------------------
// Расчёт факта по транскриптам
// ----------------------------------------------------------------------------

function diffSize(pr: PR): number {
  if (pr.files.length && pr.files.length >= Math.min(pr.changedFiles, 100)) {
    return pr.files.filter((f) => !DIFF_EXCLUDE.test(f.path)).reduce((s, f) => s + f.a + f.d, 0);
  }
  return pr.additions + pr.deletions;
}

const ANCHOR_TOLERANCE = 30 * 60; // хеш в выводе инструмента должен быть рядом по времени с authoredDate коммита

/** Индекс: первые 7 символов oid → [(oid, pr_number, authoredDate)] для проверки префиксов. */
function oidIndex(prs: Map<number, PR>): Map<string, [string, number, number | null][]> {
  const idx = new Map<string, [string, number, number | null][]>();
  for (const [num, p] of prs) {
    for (const c of p.commits) {
      const k = c.oid.slice(0, 7);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k)!.push([c.oid, num, c.at]);
    }
  }
  return idx;
}

const near = (ts: number, at: number | null) => at === null || at === undefined || Math.abs(ts - at) <= ANCHOR_TOLERANCE;

/** Короткий хеш h является префиксом одного из oids (или наоборот). */
export function hashMatches(h: string, oids: Iterable<string>): boolean {
  for (const o of oids) if (o.startsWith(h) || h.startsWith(o)) return true;
  return false;
}

export interface Shared {
  unit: string;
  with: number[];
  k: number;
}

export interface Detail {
  sid: string;
  src: string;
  start: number;
  hours: number;
  prompts: number;
  rules: Record<string, number>;
  branches: Record<string, number>;
}

export interface Fact {
  issue: number;
  h: number | null;
  h_raw?: number | null;
  wall: number | null;
  cov: "full" | "partial" | "none";
  sessions: number;
  prompts: number;
  prs: number[];
  commits: number;
  diff: number;
  diff_na?: boolean;
  shared: Shared[];
  first?: number | null;
  last?: number | null;
  intervals: [number, number][];
  details: Detail[];
  tok: Any;
  usd: number | null;
  usd_partial?: string[];
  models?: Record<string, { mtok: number; usd: number | null }>;
  title?: string;
  weak_links?: boolean;
  links?: { pr: number; branch: string; why: string }[];
  type?: string | null;
  closers?: string[];
  epic?: boolean;
  is_pr?: boolean;
  subtasks?: Any[];
  sub_missing?: number;
  iv?: Record<string, [number, number][]>; // интервалы по сессиям (sid, 8 знаков) — в маркер «Факт»
  taken?: { issue: number; h: number }[]; // не засчитано: уже в записанном факте другой задачи
  overlap?: { issue: number; h: number }[]; // засчитано (ветка, субагент, коммит), но есть и в чужом факте
  cloud_missing?: string[]; // облачные сессии из трейлера коммитов PR, выгрузки которых нет (est cloud-import)
}

type Anchor = [number, string, string, number]; // (ts, own|foreign, pr|commit, доля)

/**
 * Окно привязки по времени: [a, z] (z не включительно, если zOpen), только ветка br (null — любая не чужая)
 * или нейтральная; rule — «якорь» (свой PR/коммит) или «название» / «промпт» (задача названа в названии
 * сессии или в первом промпте — слабая привязка: уступает уже записанному факту другой задачи).
 */
interface Win {
  a: number;
  z: number;
  zOpen: boolean;
  br: string | null;
  w: number;
  rule: string;
}

export function computeFact(repo: FactRepo, number: number, prObjs: PR[], closers: Closer[], gapMin = 30): Fact {
  const prsAll = repo.prs();
  const openPrs = repo.openPrs().items;
  const cidx = repo.closers();
  const sessions = repo.sessions();
  const neutral = repo.neutralBranches();
  const gap = gapMin * 60.0;

  const ourPrs = new Set(prObjs.map((p) => p.number));

  // --- «единицы» задачи (PR, коммит-закрыватель) и их доля: один PR/коммит на k задач → 1/k ----------
  const issuesOfPr = (num: number) => {
    const s = new Set<number>([...(prsAll.get(num)?.closing ?? []), ...(cidx.pr[String(num)] ?? [])]);
    s.add(number);
    return s;
  };
  const issuesOfOid = (oid: string) => {
    const s = new Set<number>(cidx.oid[oid]?.issues ?? []);
    s.add(number);
    return s;
  };
  const others = (s: Set<number>) => [...s].filter((x) => x !== number).sort((a, b) => a - b);

  const shared: Shared[] = [];
  const prW = new Map<number, number>();
  for (const p of prObjs) {
    const iss = issuesOfPr(p.number);
    prW.set(p.number, 1.0 / iss.size);
    if (iss.size > 1) shared.push({ unit: `PR #${p.number}`, with: others(iss), k: iss.size });
  }
  const ourBranches = new Map<string, number>(); // ветка → доля
  for (const p of prObjs) {
    if (p.headRefName) ourBranches.set(p.headRefName, Math.max(ourBranches.get(p.headRefName) ?? 0, prW.get(p.number)!));
  }
  for (const p of Object.values(openPrs)) {
    if (p.closing.includes(number) && p.headRefName && !ourBranches.has(p.headRefName)) ourBranches.set(p.headRefName, 1.0);
  }
  const ourOid = new Map<string, [number | null, number]>(); // oid → (authoredDate, доля)
  for (const p of prObjs) for (const c of p.commits) ourOid.set(c.oid, [c.at, prW.get(p.number)!]);
  for (const c of closers) {
    const iss = issuesOfOid(c.oid);
    ourOid.set(c.oid, [c.at, 1.0 / iss.size]);
    if (iss.size > 1) shared.push({ unit: `коммит ${c.oid.slice(0, 7)}`, with: others(iss), k: iss.size });
  }

  const idx = oidIndex(prsAll); // коммиты смёрженных PR (чужие якоря)
  const foreignClosers = new Map<string, [string, number | null][]>(); // коммиты-закрыватели других issue: префикс → [(oid, at)]
  for (const [oid, info] of Object.entries(cidx.oid)) {
    if (!(info.issues ?? []).includes(number) && !ourOid.has(oid)) {
      const k = oid.slice(0, 7);
      if (!foreignClosers.has(k)) foreignClosers.set(k, []);
      foreignClosers.get(k)!.push([oid, info.at ?? null]);
    }
  }
  const branch2prs = new Map<string, Set<number>>();
  for (const [num, p] of prsAll) {
    if (p.headRefName) {
      if (!branch2prs.has(p.headRefName)) branch2prs.set(p.headRefName, new Set());
      branch2prs.get(p.headRefName)!.add(num);
    }
  }
  for (const [num, p] of Object.entries(openPrs)) {
    if (p.headRefName && !p.closing.includes(number)) {
      if (!branch2prs.has(p.headRefName)) branch2prs.set(p.headRefName, new Set());
      branch2prs.get(p.headRefName)!.add(-Number(num)); // открытый PR: точно не наш
    }
  }

  const isNeutral = (b: string) => b === "" || b === "HEAD" || neutral.has(b);
  const isOurBranch = (b: string) => !!b && !isNeutral(b) && (ourBranches.has(b) || branchHasIssue(b, number));
  const branchW = (b: string) => ourBranches.get(b) ?? 1.0;
  const isForeignBranch = (b: string) => {
    if (!b || isNeutral(b) || isOurBranch(b)) return false;
    const nums = branch2prs.get(b);
    if (nums && nums.size && ![...nums].some((x) => ourPrs.has(x))) return true;
    const bi = branchIssueNumber(b);
    return bi !== null && bi !== number;
  };

  /**
   * (свой/чужой/нейтральный, доля); хеш — якорь только рядом по времени с датой коммита
   * (в выводе git commit бывают и чужие хеши — из git log, rebase и т.п.).
   */
  const hashClass = (h: string, ts: number): [string, number] => {
    for (const [oid, [at, w]] of ourOid) if ((oid.startsWith(h) || h.startsWith(oid)) && near(ts, at)) return ["own", w];
    for (const [oid, num, at] of idx.get(h.slice(0, 7)) ?? []) if ((oid.startsWith(h) || h.startsWith(oid)) && !ourPrs.has(num) && near(ts, at)) return ["foreign", 0.0];
    for (const [oid, at] of foreignClosers.get(h.slice(0, 7)) ?? []) if ((oid.startsWith(h) || h.startsWith(oid)) && near(ts, at)) return ["foreign", 0.0];
    return ["neutral", 0.0];
  };

  const intervals: [number, number][] = []; // (a, b) без веса — для объединения между сессиями
  const tok = { in: 0.0, out: 0.0, cw: 0.0, cr: 0.0 }; // токены привязанных ответов (с долей)
  const byModel = new Map<string, { tok: number; usd: number; priced: boolean }>();
  const seenMids = new Set<string>();
  let rawTotal = 0.0;
  let weightedTotal = 0.0;
  const seenPrs = new Set<number>();
  const seenBranches = new Set<string>();
  const seenHashes = new Set<string>();
  let nSessions = 0;
  let nPrompts = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const details: Detail[] = [];
  const iv: Record<string, [number, number][]> = {};
  const takenS = new Map<number, number>(); // задача → секунды, отданные её записанному факту
  const overlapS = new Map<number, number>();
  const recorded = repo.recorded?.() ?? new Map();
  const sharedWith = new Set(shared.flatMap((x) => x.with)); // общий PR/коммит: пересечение — это доля, не ошибка
  const ourKey = `${repo.full}#${number}`;
  const cmpAnchor = (a: Anchor, b: Anchor) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) || a[3] - b[3];

  for (const s of sessions) {
    const ev = s.ev;
    if (!ev.length) continue;
    for (const [, pr] of s.prlinks) seenPrs.add(pr);
    for (const e of ev) if (e[1]) seenBranches.add(e[1]);
    const anchors: Anchor[] = [];
    for (const [ts, pr] of s.prlinks) {
      const own = ourPrs.has(pr);
      // Claude Code повторяет pr-link привязанного к сессии PR и после мержа — это статус приложения, а не работа:
      // после мержа он не якорь ни для своей задачи (иначе она заберёт время следующих), ни для чужой (иначе
      // оборвёт окно следующей задачи, под которую переименовали сессию)
      const mergedAt = prsAll.get(pr)?.mergedAt ?? null;
      if (mergedAt !== null && ts > mergedAt) continue;
      anchors.push([ts, own ? "own" : "foreign", "pr", prW.get(pr) ?? 0.0]);
    }
    for (const [ts, h] of s.commits) {
      const [cls, w] = hashClass(h, ts);
      if (cls === "own") seenHashes.add(h);
      if (cls !== "neutral") anchors.push([ts, cls, "commit", w]);
    }
    anchors.sort(cmpAnchor);
    const foreignTs = anchors.filter((a) => a[1] === "foreign").map((a) => a[0]);

    // окна по якорям: от предыдущего чужого якоря до своего; внутри окна считаются только
    // записи на ветке якоря или на нейтральной ветке (HEAD/пусто/main…) — чужие ветки нет.
    // Переименование сессии — тоже граница: до него сессия работала над задачей из прежнего названия.
    const renames = [...(s.title_hist ?? [])].map((t) => t[0]).sort((x, y) => x - y).slice(1); // первое — с начала сессии
    const windows: Win[] = [];
    let prevForeign = -1e18;
    for (const [ts, cls, kind, w] of anchors) {
      if (cls === "foreign") {
        prevForeign = ts;
        continue;
      }
      const start = Math.max(prevForeign, ...renames.filter((t) => t <= ts));
      let end = ts;
      let brAt = "";
      for (const e of ev) {
        if (e[0] > ts) break;
        if (!isNeutral(e[1])) brAt = e[1];
      }
      if (kind === "pr") {
        // хвост после pr-link: пока ветка та же и нет чужого якоря (правки после ревью)
        const later = [...foreignTs, ...renames].filter((t) => t > ts);
        const nxtForeign = later.length ? Math.min(...later) : 1e18;
        for (const e of ev) {
          if (e[0] <= ts) continue;
          if (e[0] >= nxtForeign || e[1] !== brAt) break;
          end = e[0];
        }
      }
      windows.push({ a: start, z: end, zOpen: false, br: brAt, w, rule: "якорь" });
    }
    // Задача названа в названии сессии или в первом промпте. Название действует с момента переименования
    // (первое — с начала сессии): сессия, которую переименовывали под каждую следующую задачу, отдаёт
    // записи безномерной ветки той задаче, под чьим названием они сделаны, а не последней. Название без
    // номера — решает первый промпт; названия нет — первый промпт на всю сессию.
    const urlRefs = (urls: string[]) => urls.filter((u) => u.startsWith(repo.full + "#")).map((u) => parseInt(u.split("#")[1]!, 10));
    const promptRefs = new Set<number>([...s.first_refs, ...urlRefs(s.first_urls ?? [])]);
    const titleRefs = (title: string) => new Set<number>([...refsIn(title), ...urlRefs(urlsIn(title))]);
    let hist: [number, Set<number>][] = [...(s.title_hist ?? [])].sort((x, y) => x[0] - y[0]).map(([t, title]) => [t, titleRefs(title)]);
    if (!hist.length && s.title) hist = [[-1e18, titleRefs(s.title)]];
    const segs: { a: number; z: number; refs: Set<number>; rule: string }[] = hist.length
      ? hist.map(([t, refs], k) => ({ a: k ? t : -1e18, z: k + 1 < hist.length ? hist[k + 1]![0] : 1e18, refs: refs.size ? refs : promptRefs, rule: refs.size ? "название" : "промпт" }))
      : [{ a: -1e18, z: 1e18, refs: promptRefs, rule: "промпт" }];
    for (const seg of segs) {
      if (!(seg.refs.size === 1 && seg.refs.has(number))) continue;
      // до конца периода, первого чужого якоря в нём или первого перехода на ветку, которая не наша и
      // не нейтральная (стартовая ветка периода допускается, если она не чужая — на ней и делалась задача)
      const later = foreignTs.filter((t) => t >= seg.a);
      let end = Math.min(seg.z, later.length ? Math.min(...later) : 1e18);
      let zOpen = end === seg.z && seg.z < 1e18; // запись в момент переименования — уже следующей задачи
      let startBranch: string | null = null;
      for (const e of ev) {
        if (e[0] < seg.a) continue;
        if (e[0] >= end) break;
        const b: string = e[1];
        if (isNeutral(b) || isOurBranch(b)) continue;
        if (isForeignBranch(b) || (startBranch !== null && b !== startBranch)) {
          end = e[0];
          zOpen = false;
          break;
        }
        startBranch = b;
      }
      windows.push({ a: seg.a, z: end, zOpen, br: null, w: 1.0, rule: seg.rule });
    }

    const attributed: number[] = []; // доля (0 — не наша запись)
    const weak: string[] = []; // правило слабой привязки («название» / «промпт») или ""
    const rules: Record<string, number> = {};
    for (const e of ev) {
      const [ts, b] = [e[0] as number, e[1] as string];
      const hint: string = e.length > 3 ? e[3] : "";
      let w = 0.0;
      let weakRule = "";
      if (hint) {
        // запись субагента, задание которого называет задачу: своя — целиком,
        // чужая — не наша, какие бы ветки/окна ни были
        if (hint === String(number) || hint === ourKey) {
          w = 1.0;
          rules["субагент"] = (rules["субагент"] ?? 0) + 1;
        }
        attributed.push(w);
        weak.push("");
        continue;
      }
      if (isOurBranch(b)) {
        w = branchW(b);
        rules["ветка"] = (rules["ветка"] ?? 0) + 1;
      } else if (windows.length && !isForeignBranch(b)) {
        const ws = windows.filter((x) => x.a <= ts && (x.zOpen ? ts < x.z : ts <= x.z) && (x.br === null || b === x.br || isNeutral(b)));
        if (ws.length) {
          w = Math.max(...ws.map((x) => x.w));
          const anchored = ws.some((x) => x.rule === "якорь");
          const rule = anchored ? "якорь" : ws[0]!.rule;
          rules[rule] = (rules[rule] ?? 0) + 1;
          if (!anchored) weakRule = rule;
        }
      }
      attributed.push(w);
      weak.push(weakRule);
    }
    // Запись, уже засчитанная в записанном факте другой задачи этой сессии (маркер хранит интервалы):
    // привязанная только названием или первым промптом — не засчитывается повторно; привязанная веткой,
    // субагентом или своим коммитом — остаётся, но пересечение выводится (чужой факт, вероятно, неверен).
    const sid8 = s.sid.slice(0, 8);
    const others: [number, [number, number][]][] = [];
    for (const [n, bySid] of recorded) if (n !== number && bySid[sid8]?.length) others.push([n, bySid[sid8]]);
    if (others.length) {
      const orig = [...attributed];
      for (let i = 0; i < ev.length; i++) {
        if (!orig[i]) continue;
        const t = ev[i]![0] as number;
        const pair = i > 0 && t - ev[i - 1]![0] <= gap && (orig[i - 1]! > 0 || !!ev[i - 1]![2]);
        const x = pair ? (ev[i - 1]![0] + t) / 2 : t; // интервал записи — по середине, одиночная — по времени
        const tol = pair ? 0 : 1; // границы в маркере округлены до секунды
        const hit = others.find(([, ivs]) => ivs.some(([a, b]) => a - tol <= x && x <= b + tol));
        if (!hit) continue;
        const d = pair ? t - ev[i - 1]![0] : 0;
        const rule = weak[i]!;
        if (rule) {
          attributed[i] = 0;
          takenS.set(hit[0], (takenS.get(hit[0]) ?? 0) + d);
          if (--rules[rule]! <= 0) delete rules[rule];
        } else if (!sharedWith.has(hit[0])) {
          overlapS.set(hit[0], (overlapS.get(hit[0]) ?? 0) + d);
        }
      }
    }
    if (!attributed.some((w) => w > 0)) continue;
    // интервал до предыдущей записи считается, только если она тоже наша
    // или это человеческий промпт, с которого начался наш сегмент
    let sessRaw = 0.0;
    let sessW = 0.0;
    let prompts = 0;
    let sFirst: number | null = null;
    let sLast: number | null = null;
    const brs: Record<string, number> = {};
    const sessIv: [number, number][] = [];
    const sessUsage: [Any[], number][] = []; // (usage-запись, доля) для привязанных ответов модели
    const sUsage = s.usage ?? [];
    const sModels = s.models ?? [];
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      const [ts, b, human] = [e[0] as number, e[1] as string, e[2] as number];
      const w = attributed[i]!;
      if (human && !w && i + 1 < ev.length && attributed[i + 1]! && ev[i + 1]![0] - ts <= gap) prompts++;
      if (!w) continue;
      if (e.length > 4 && e[4] >= 0 && e[4] < sUsage.length) sessUsage.push([sUsage[e[4]]!, w]);
      prompts += human;
      sFirst = sFirst === null ? ts : sFirst;
      sLast = ts;
      if (i > 0 && ts - ev[i - 1]![0] <= gap && (attributed[i - 1]! || ev[i - 1]![2])) {
        const d = ts - ev[i - 1]![0];
        intervals.push([ev[i - 1]![0], ts]);
        sessIv.push([ev[i - 1]![0], ts]);
        sessRaw += d;
        sessW += d * w;
        const key = b || "?";
        brs[key] = (brs[key] ?? 0) + (d * w) / 3600;
      }
    }
    if (sessRaw < 60 && prompts === 0) continue; // меньше минуты и без промптов (случайный хеш в выводе) — сессией не считаем
    if (sessIv.length) iv[sid8] = mergeIntervals([...(iv[sid8] ?? []), ...sessIv]).map(([a, b]) => [Math.floor(a), Math.ceil(b)]);
    nSessions++;
    nPrompts += prompts;
    rawTotal += sessRaw;
    weightedTotal += sessW;
    for (const [u, w] of sessUsage) {
      if (seenMids.has(u[0])) continue; // возобновлённая сессия копирует историю — не считаем дважды
      seenMids.add(u[0]);
      const model: string = u[1] < sModels.length ? sModels[u[1]]! : "?";
      const vals: [number, number, number, number, number] = [u[2], u[3], u[4], u[5], u[6]];
      tok.in += vals[0] * w;
      tok.out += vals[1] * w;
      tok.cw += (vals[2] + vals[3]) * w;
      tok.cr += vals[4] * w;
      if (!byModel.has(model)) byModel.set(model, { tok: 0.0, usd: 0.0, priced: true });
      const m = byModel.get(model)!;
      m.tok += vals.reduce((a, x) => a + x, 0) * w;
      const c = usageCost(model, vals, !!u[7]);
      if (c === null) m.priced = false;
      else m.usd += c * w;
    }
    firstTs = firstTs === null ? sFirst : Math.min(firstTs, sFirst!);
    lastTs = lastTs === null ? sLast : Math.max(lastTs, sLast!);
    const branches: Record<string, number> = {};
    for (const [k, v] of Object.entries(brs).sort((a, b) => b[1] - a[1])) branches[k] = round2(v);
    details.push({ sid: s.sid, src: s.source ?? "claude", start: sFirst!, hours: round2(sessW / 3600), prompts, rules, branches });
  }

  const merged = mergeIntervals(intervals);
  const activeRaw = merged.reduce((s, [a, b]) => s + (b - a), 0); // без двойного счёта между сессиями
  const overlap = rawTotal > 0 ? activeRaw / rawTotal : 1.0;
  const active = (weightedTotal * overlap) / 3600;

  // покрытие
  const prSeen = (p: PR) => seenPrs.has(p.number) || (!!p.headRefName && seenBranches.has(p.headRefName)) || [...seenHashes].some((h) => hashMatches(h, p.commits.map((c) => c.oid)));
  const units = [...prObjs.map(prSeen), ...closers.map((c) => [...seenHashes].some((h) => hashMatches(h, [c.oid])))];
  let cov: Fact["cov"];
  if (nSessions === 0) cov = "none";
  else if (units.length && units.every(Boolean)) cov = "full";
  else cov = "partial";
  // коммиты PR сделаны в облачной сессии, а её выгрузки нет — часть работы не видна
  const known = new Set(sessions.map((s) => s.sid));
  const cloudMissing = uniqSortedStrs(prObjs.flatMap((p) => p.cloud ?? [])).filter((sid) => !known.has(sid));
  if (cloudMissing.length && cov === "full") cov = "partial";

  let diff = prObjs.reduce((s, p) => s + diffSize(p), 0);
  let diffNa = false;
  for (const c of closers) {
    const d = repo.commitDiff(c.oid);
    if (d === null) diffNa = true;
    else diff += d;
  }
  const res: Fact = {
    issue: number,
    h: cov !== "none" ? round2(active) : null,
    h_raw: cov !== "none" ? round2(activeRaw / 3600) : null,
    wall: firstTs !== null && cov !== "none" ? round1((lastTs! - firstTs) / 3600) : null,
    cov,
    sessions: nSessions,
    prompts: nPrompts,
    prs: prObjs.map((p) => p.number),
    commits: prObjs.reduce((s, p) => s + (p.commits_total || p.commits.length), 0) + closers.length,
    diff,
    diff_na: diffNa,
    shared,
    first: firstTs,
    last: lastTs,
    intervals: merged,
    details: [...details].sort((a, b) => a.start - b.start),
    tok: null,
    usd: null,
    iv,
    taken: hoursByIssue(takenS),
    overlap: hoursByIssue(overlapS),
    cloud_missing: cloudMissing,
  };
  Object.assign(res, cov !== "none" ? tokensResult(tok, byModel) : { tok: null, usd: null });
  return res;
}

/** {задача: секунды} → [{issue, h}] по номеру задачи; меньше 0,01 ч не показываем. */
function hoursByIssue(m: Map<number, number>): { issue: number; h: number }[] {
  return [...m].sort((a, b) => a[0] - b[0]).map(([issue, sec]) => ({ issue, h: round2(sec / 3600) })).filter((x) => x.h > 0);
}

/** Свести токены и стоимость в поля результата: tok (целые), usd, usd_partial, models. */
function tokensResult(tok: { in: number; out: number; cw: number; cr: number }, byModel: Map<string, { tok: number; usd: number; priced: boolean }>): Partial<Fact> {
  const total = tok.in + tok.out + tok.cw + tok.cr;
  if (total <= 0) return { tok: null, usd: null };
  const t: Record<string, number> = { in: pyRound(tok.in, 0), out: pyRound(tok.out, 0), cw: pyRound(tok.cw, 0), cr: pyRound(tok.cr, 0), total: pyRound(total, 0) };
  const priced = [...byModel.values()].filter((m) => m.priced);
  const unpriced = [...byModel.entries()].filter(([, m]) => !m.priced).map(([n]) => n).sort();
  const usd = priced.length ? round2([...byModel.values()].reduce((s, m) => s + m.usd, 0)) : null;
  const models: Record<string, { mtok: number; usd: number | null }> = {};
  for (const [name, m] of [...byModel.entries()].sort((a, b) => b[1].tok - a[1].tok)) models[name] = { mtok: round2(m.tok / 1e6), usd: m.priced ? round2(m.usd) : null };
  return { tok: t, usd, usd_partial: unpriced, models };
}

const fmtMtok = (n: number | null | undefined) => fmtH((n || 0) / 1e6, 2);

/** «Токены: 12.3 млн (вход … · выход … · запись кэша … · чтение кэша …); стоимость по API-тарифам ≈ $…». */
function tokensTxt(res: Fact): string {
  const t = res.tok;
  if (!t) return "";
  let s = `Токены: ${fmtMtok(t.total)} млн`;
  if ("in" in t) s += ` (вход ${fmtMtok(t.in)} · выход ${fmtMtok(t.out)} · запись кэша ${fmtMtok(t.cw)} · чтение кэша ${fmtMtok(t.cr)})`;
  if (res.usd !== null && res.usd !== undefined) {
    s += `; стоимость по API-тарифам ≈ $${res.usd.toFixed(2)}`;
    const ms = Object.entries(res.models ?? {}).filter(([, m]) => m.usd);
    if (ms.length > 1) s += " (" + ms.map(([n, m]) => `${n} $${m.usd!.toFixed(2)}`).join(", ") + ")";
  }
  if (res.usd_partial?.length) s += `; без цены (нет в прайсе): ${res.usd_partial.join(", ")}`;
  return s + ".";
}

export function mergeIntervals(iv: [number, number][]): [number, number][] {
  const sorted = [...iv].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Комментарии с маркерами (fact / est)
// ----------------------------------------------------------------------------

function findMarkerComment(issue: Any, kind: string): Any | null {
  for (const c of issue.comments.nodes) if (parseMarker(c.body, kind) !== null) return c;
  return null;
}

/** Строки «+ вручную: N ч» и «Причина: …», дописанные человеком. */
export function extractKeptLines(body: string | null | undefined): [number, string | null, string[]] {
  let manual = 0.0;
  let cause: string | null = null;
  const lines: string[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    const s = line.trim();
    const m = /^\+\s*вручную:\s*([\d.,]+)\s*ч/i.exec(s);
    if (m) {
      manual = parseFloat(m[1]!.replace(",", "."));
      lines.push(s);
    } else if (/^Причина:/i.test(s)) {
      cause = s.slice(s.indexOf(":") + 1).trim();
      lines.push(s);
    }
  }
  return [manual, cause, lines];
}

export function factCommentBody(res: Fact, est: number | null, keptLines: string[], manual: number, cause: string | null): string {
  const h = res.h;
  let text: string;
  if (h === null) {
    text = "Факт недоступен: сессии не найдены (покрытие none).";
  } else {
    const ratio = est ? `, ×${(h / est).toFixed(2)}` : "";
    const estTxt = est ? `оценка ${fmtH(est)} ч${ratio}` : "оценки нет";
    const ns = res.sessions;
    const npr = res.prompts;
    text = `Факт: ${fmtH(h)} ч активных в ${agentsTxt(res)} (${estTxt}). ${ns} ${plural(ns, "сессия", "сессии", "сессий")}, ${npr} ${plural(npr, "промпт", "промпта", "промптов")}, стена ${fmtH(res.wall, 1)} ч, покрытие ${res.cov}.`;
  }
  text += res.prs.length ? " PR " + res.prs.map((p) => `#${p}`).join(", ") + ";" : " PR нет;";
  const nc = res.commits;
  text += ` ${nc} ${plural(nc, "коммит", "коммита", "коммитов")}, дифф ${diffTxt(res)}.`;
  if (res.shared?.length) text += " " + sharedTxt(res) + ".";
  for (const x of res.taken ?? []) text += ` Не засчитано повторно: ${fmtH(x.h)} ч уже в факте #${x.issue}.`;
  for (const x of res.overlap ?? []) text += ` Пересечение с фактом #${x.issue}: ${fmtH(x.h)} ч — пересчитать #${x.issue}.`;
  for (const sid of res.cloud_missing ?? []) text += ` Облачная сессия https://claude.ai/code/${sid} не импортирована — est cloud-import.`;
  if (res.tok) text += "\n" + tokensTxt(res);
  const marker: Record<string, unknown> = { v: 1, h, manual, wall: res.wall, cov: res.cov, sessions: res.sessions, prompts: res.prompts, prs: res.prs, commits: res.commits, diff: res.diff, cause };
  if (res.tok) {
    marker.tok = res.tok;
    marker.usd = res.usd ?? null;
    if (res.models) marker.models = res.models;
  }
  if (res.type) marker.type = res.type; // тип из ветки по конвенции <type>/N-slug
  if (res.shared?.length) {
    const sh: Record<string, number[]> = {};
    for (const s of res.shared) sh[s.unit] = s.with;
    marker.shared = sh;
  }
  if (res.iv && Object.keys(res.iv).length) marker.iv = res.iv; // по ним следующий расчёт видит, что уже засчитано
  if (res.cloud_missing?.length) marker.cloud_missing = res.cloud_missing;
  return [text, ...keptLines, `<!-- fact ${pyDumps(marker)} -->`].join("\n");
}

// Облачная сессия Claude Code (claude.ai/code): GitHub — только REST своего репозитория, GraphQL и проекты закрыты
// прокси сессии, поэтому ни оценки, ни факта там не посчитать — честное «недоступен (облако)» со ссылкой на сессию.
// Цифру даёт локальная сессия: импорт событий облачной сессии (est cloud-import, parseCloudFile).
const isCloud = () => process.env.CLAUDE_CODE_REMOTE === "true";
const CLOUD_ERR = "облачная сессия Claude Code: GitHub GraphQL и проекты отсюда недоступны — оценка, история и sweep только в локальной сессии (docs/cloud-sessions.md в ai-dev)";

/** Комментарий «Факт» задачи, закрытой из облачной сессии: факт недоступен, маркер с cov none и src cloud. */
export function cloudFactBody(sessionId: string | undefined): string {
  const sid = sessionId ? "session_" + sessionId.replace(/^(cse|session)_/, "") : null; // env даёт cse_…, ссылка — session_…
  let text = "Факт недоступен (облако): задача сделана в облачной сессии Claude Code — там est не видит проекта GitHub; цифру даст локальная сессия, импортировав события этой сессии (est cloud-import) (покрытие none).";
  if (sid) text += ` Сессия: https://claude.ai/code/${sid}.`;
  return `${text}\n<!-- fact ${pyDumps({ v: 1, h: null, manual: 0, cov: "none", src: "cloud", session: sid })} -->`;
}

const diffTxt = (res: Fact) => (res.diff_na ? "н/д (без PR)" : `${res.diff} строк`);

/** «общий коммит a9e2854 с #7, #8 (доля 1/3)». */
const sharedTxt = (res: Fact) => (res.shared ?? []).map((s) => `общий ${s.unit} с ${s.with.map((n) => `#${n}`).join(", ")} (доля 1/${s.k})`).join("; ");

function upsertComment(repo: Repo, issue: Any, kind: string, body: string): string {
  const existing = findMarkerComment(issue, kind);
  if (existing) {
    ghRest(`repos/${repo.full}/issues/comments/${existing.databaseId}`, "PATCH", { body });
    return "обновлён";
  }
  ghRest(`repos/${repo.full}/issues/${issue.number}/comments`, "POST", { body });
  return "создан";
}

function setNumberField(repo: Repo, issue: Any, fieldName: string, value: number): void {
  let meta = repo.projectMeta();
  const vals = issueProjectFields(issue, meta);
  let itemId = vals.item_id;
  if (!itemId) {
    const q = "mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }";
    itemId = ghGraphql(q, { p: meta.id, c: issue.id }).addProjectV2ItemById.item.id;
  }
  const q = `mutation($p:ID!,$i:ID!,$f:ID!,$v:Float!){
      updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{number:$v}}){ projectV2Item{ id } } }`;
  try {
    ghGraphql(q, { p: meta.id, i: itemId, f: meta.fields[fieldName]!.id, v: Number(value) });
  } catch (e) {
    if (!(e instanceof EstError) || !(errIs(e, "not found") || errIs(e, "could not resolve"))) throw e;
    // устаревший кэш id проекта/поля — перечитать и повторить один раз
    meta = repo.projectMeta(true);
    ghGraphql(q, { p: meta.id, i: itemId, f: meta.fields[fieldName]!.id, v: Number(value) });
  }
}

/** Поставить необязательное числовое поле, если оно есть в проекте (иначе false). */
function setOptionalNumberField(repo: Repo, issue: Any, fieldName: string, value: number): boolean {
  let meta = repo.projectMeta();
  if (!meta.fields[fieldName] && !repo.optRefreshed) {
    repo.optRefreshed = true;
    meta = repo.projectMeta(true); // кэш метаданных мог быть старше поля
  }
  if (!meta.fields[fieldName]) return false;
  setNumberField(repo, issue, fieldName, value);
  return true;
}

// ----------------------------------------------------------------------------
// История и k
// ----------------------------------------------------------------------------

interface Calib {
  k: number | null;
  n: number;
  p25: number | null;
  p75: number | null;
  share: number | null;
  n_partial: number;
}

/** k = медиана(факт/оценка) по последним `last` закрытым задачам с маркером est и фактом. */
export function calib(rows: Row[], last = 20): Calib {
  const cands: [number, number][] = [];
  let nPartial = 0;
  for (const r of rows) {
    if (r.state !== "CLOSED" || r.fact === null || !r.est_marker) continue;
    const est = r.est_marker.h || r.est;
    if (!est || est <= 0) continue;
    const fm = r.fact_marker;
    if (fm && fm.cov !== undefined && fm.cov !== null && fm.cov !== "full") {
      nPartial++; // неполное покрытие транскриптами — в k не берём (см. вывод history)
      continue;
    }
    cands.push([r.closedAt || 0, r.fact / est]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  const ratios = cands.slice(0, last).map((x) => x[1]).sort((a, b) => a - b);
  if (!ratios.length) return { k: null, n: 0, p25: null, p75: null, share: null, n_partial: nPartial };
  return {
    k: round2(median(ratios)),
    n: ratios.length,
    p25: round2(quantile(ratios, 0.25)!),
    p75: round2(quantile(ratios, 0.75)!),
    share: round2(ratios.filter((x) => x >= 0.5 && x <= 2).length / ratios.length),
    n_partial: nPartial,
  };
}

/** Тип задачи строки проекта: фактический (из ветки, маркер «Факт»), иначе из маркера «Оценка». */
const rowType = (r: Row): string => r.fact_marker?.type || r.est_marker?.type || "";

interface HistoryArgs {
  repo?: string;
  grep?: string;
  allRepos: boolean;
  last?: number;
}

function cmdHistory(args: HistoryArgs): void {
  if (isCloud()) throw new EstError(CLOUD_ERR);
  const registry = loadRegistry();
  const repos = args.allRepos ? Object.keys(registry) : [resolveRepo(args.repo)];
  const now = nowTs();
  const summary: [string, number, number | null, Calib][] = [];
  for (const full of repos) {
    const repo = new Repo(full, registry);
    const rows = repo.projectRows();
    let rowsFact = rows.filter((r) => r.state === "CLOSED" && r.fact !== null);
    if (args.grep) {
      const g = args.grep.toLowerCase();
      rowsFact = rowsFact.filter((r) => r.title.toLowerCase().includes(g) || r.labels.some((l) => l.toLowerCase().includes(g)));
    }
    rowsFact.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    if (args.last) rowsFact = rowsFact.slice(0, args.last);
    const c = calib(rows);
    const noFact90 = rows.filter((r) => r.state === "CLOSED" && r.fact === null && r.stateReason !== "NOT_PLANNED" && (r.closedAt || 0) >= now - 90 * 86400).length;
    const facts = rows.filter((r) => r.fact !== null).map((r) => r.fact!);
    summary.push([full, rows.filter((r) => r.state === "CLOSED" && r.fact !== null).length, facts.length ? median(facts) : null, c]);
    const meta = repo.projectMeta();
    console.log(`== ${full} (проект ${meta.owner} #${meta.number})`);
    if (!rowsFact.length) {
      console.log("история пуста" + (args.grep ? ` (фильтр «${args.grep}»)` : ""));
    } else {
      console.log(`${pad("№", 5, true)} | ${pad("оценка", 6, true)} | ${pad("факт", 6, true)} | ${pad("покр.", 7)} | ${pad("млн ток", 7, true)} | ${pad("$", 7, true)} | ${pad("тип", 8)} | ${pad("метки", 22)} | заголовок`);
      for (const r of rowsFact) {
        const typ = rowType(r);
        const labels = r.labels.filter((l) => l !== "epic").join(",").slice(0, 22);
        const fm = r.fact_marker ?? {};
        const cov = fm.cov || "—";
        const mt = fm.tok ? fmtMtok(fm.tok.total) : "—";
        const usd = fm.usd !== undefined && fm.usd !== null ? Number(fm.usd).toFixed(2) : "—";
        console.log(`${pad(String(r.number), 5, true)} | ${pad(fmtH(r.est), 6, true)} | ${pad(fmtH(r.fact), 6, true)} | ${pad(cov, 7)} | ${pad(mt, 7, true)} | ${pad(usd, 7, true)} | ${pad(typ, 8)} | ${pad(labels, 22)} | ${r.title.slice(0, 60)}`);
      }
    }
    if (c.n) {
      const units = c.k! >= 0.5 && c.k! <= 3 ? "" : " — старые оценки и факты не в одних единицах";
      console.log(`k = ${c.k} (n=${c.n} пар «оценка с маркером + факт full», p25–p75 ${c.p25}–${c.p75}); доля в допуске ×0.5…×2: ${Math.trunc(c.share! * 100)} %${units}`);
    } else {
      console.log("k: нет пар «оценка с маркером est + факт» — калибровка недоступна");
    }
    if (c.n_partial) console.log(`в k не вошли задачи с покрытием partial/none: ${c.n_partial}`);
    console.log(`закрытых за 90 дней без факта: ${noFact90}`);
    console.log();
  }
  if (args.allRepos) {
    console.log("== сводка по всем репозиториям");
    for (const [full, nf, med, c] of summary) console.log(`  ${full}: фактов ${nf}, медиана факта ${fmtH(med)} ч, k=${c.k} (n=${c.n})`);
  }
}

/** k по репо, иначе по всем репо (n≥5), иначе нет. */
function calibForEstimate(repo: Repo, registry: Registry): [Row[], Calib, string] {
  const rows = repo.projectRows();
  let c = calib(rows);
  let level = "репо";
  if (c.n < 5) {
    let allRows = [...rows];
    for (const full of Object.keys(registry)) {
      if (full === repo.full) continue;
      try {
        allRows = allRows.concat(new Repo(full, registry).projectRows());
      } catch (e) {
        if (!(e instanceof EstError)) throw e;
        console.error(`предупреждение: ${full}: ${e.message}`);
      }
    }
    const c2 = calib(allRows);
    if (c2.n >= 5) {
      c = c2;
      level = "все репо";
    }
  }
  return [rows, c, level];
}

// ----------------------------------------------------------------------------
// Команда fact
// ----------------------------------------------------------------------------

function factForIssue(repo: Repo, number: number, gap: number, quiet = false): [Any, Fact] {
  let issue: Any;
  try {
    issue = fetchIssue(repo, number);
  } catch (e) {
    if (!(e instanceof NotAnIssue)) throw e;
    const pr = repo.pr(number);
    if (!pr) throw new EstError(`#${number} не найден в ${repo.full} ни как issue, ни как PR`);
    return factForPr(repo, pr, gap);
  }
  const labels: string[] = issue.labels.nodes.map((l: Any) => l.name);
  const itype = String(issue.issueType?.name ?? "").toLowerCase();
  // эпик — по типу issue «Эпик»/«Epic»; метка epic — запасной вариант для репо без типов
  if (itype === "эпик" || itype === "epic" || labels.includes("epic")) return factForEpic(repo, issue, gap, quiet);
  const [prObjs, closers, weakUsed] = resolveLinks(repo, issue);
  const res = computeFact(repo, number, prObjs, closers, gap);
  res.title = issue.title;
  res.weak_links = weakUsed;
  res.links = prObjs.map((p) => ({ pr: p.number, branch: p.headRefName, why: p.why! }));
  res.type = res.links.map((l) => branchType(l.branch)).find((t) => t) ?? null;
  res.closers = closers.map((c) => c.oid.slice(0, 7));
  res.epic = false;
  return [issue, res];
}

/** Номер оказался PR, а не issue: считаем факт по самому PR (без записи). */
function factForPr(repo: Repo, pr: PR, gap: number): [Any, Fact] {
  const res = computeFact(repo, pr.number, [{ ...pr, why: "сам PR" }], [], gap);
  res.title = pr.title || "";
  res.weak_links = false;
  res.links = [{ pr: pr.number, branch: pr.headRefName, why: "это PR, не issue" }];
  res.closers = [];
  res.epic = false;
  res.is_pr = true;
  const pseudo = { number: pr.number, title: pr.title, labels: { nodes: [] }, comments: { nodes: [] }, projectItems: { nodes: [] }, id: null, is_pr: true };
  return [pseudo, res];
}

/**
 * Факт эпика = сумма фактов подзадач: из поля «Факт, ч» (+ «вручную» из маркера), а для подзадач
 * без поля — по транскриптам.
 */
function factForEpic(repo: Repo, issue: Any, gap: number, quiet = false): [Any, Fact] {
  const number: number = issue.number;
  let subs: Any[] = [];
  for (let page = 1; ; page++) {
    const chunk: Any[] = ghRest(`repos/${repo.full}/issues/${number}/sub_issues?per_page=100&page=${page}`) ?? [];
    subs = subs.concat(chunk);
    if (chunk.length < 100) break;
  }
  const rows = new Map(repo.projectRows().map((r) => [r.number, r]));
  let total = 0.0;
  let tokTotal = 0;
  let usdTotal = 0.0;
  let usdAny = false;
  const parts: Any[] = [];
  let missing = 0;
  for (const s of subs) {
    const row = rows.get(s.number);
    let h: number | null;
    let cov: string;
    let src: string;
    let sTok: number | undefined;
    let sUsd: number | null | undefined;
    if (row && row.fact !== null) {
      const fm = row.fact_marker ?? {};
      const manual = Number(fm.manual || 0);
      h = row.fact + manual;
      cov = fm.cov || "поле";
      src = "поле «Факт, ч»" + (manual ? ` + вручную ${fmtH(manual)} ч` : "");
      sTok = fm.tok?.total;
      sUsd = fm.usd;
    } else {
      const [, r] = factForIssue(repo, s.number, gap, true);
      h = r.h;
      cov = r.cov;
      src = "транскрипты";
      sTok = r.tok?.total;
      sUsd = r.usd;
    }
    tokTotal += Math.trunc(sTok || 0);
    if (sUsd !== null && sUsd !== undefined) {
      usdTotal += Number(sUsd);
      usdAny = true;
    }
    parts.push({ issue: s.number, state: s.state, h, cov, src, title: s.title });
    if (h === null) missing++;
    else total += h;
  }
  void quiet;
  const res: Fact = {
    issue: number,
    title: issue.title,
    epic: true,
    h: subs.length && missing < subs.length ? round2(total) : null,
    wall: null,
    cov: subs.length && missing === 0 ? "full" : missing < subs.length ? "partial" : "none",
    sessions: 0,
    prompts: 0,
    prs: [],
    commits: 0,
    diff: 0,
    shared: [],
    intervals: [],
    subtasks: parts,
    sub_missing: missing,
    details: [],
    links: [],
    closers: [],
    weak_links: false,
    tok: tokTotal ? { total: tokTotal } : null,
    usd: usdAny ? round2(usdTotal) : null,
  };
  return [issue, res];
}

/** «Claude Code», «Codex» или «Claude Code и Codex» — по источникам привязанных сессий. */
function agentsTxt(res: Fact): string {
  const srcs = new Set((res.details ?? []).map((d) => d.src ?? "claude"));
  const names: Record<string, string> = { claude: "Claude Code", codex: "Codex", cloud: "облачной сессии Claude Code" };
  if (!srcs.size) return "Claude Code";
  return [...srcs].sort().map((s) => names[s] ?? s).join(" и ");
}

function printFact(repo: Repo, res: Fact, est: number | null): void {
  console.log(`== ${repo.full}#${res.issue}: ${res.title}`);
  if (res.is_pr) console.log(`ВНИМАНИЕ: #${res.issue} — это PR, а не issue; факт посчитан по самому PR, запись невозможна`);
  if (res.epic) {
    console.log(`эпик: ${res.subtasks!.length} подзадач, без факта: ${res.sub_missing}`);
    for (const p of res.subtasks!) console.log(`  #${pad(String(p.issue), 5)} ${pad(p.state, 6)} ${pad(fmtH(p.h), 6, true)} ч  ${pad(p.cov, 7)} ${pad(p.title.slice(0, 50), 50)} [${p.src}]`);
    console.log(`факт эпика: ${fmtH(res.h)} ч (сумма подзадач с фактом), покрытие ${res.cov}`);
    if (res.tok) console.log(tokensTxt(res));
    return;
  }
  for (const l of res.links ?? []) console.log(`PR #${l.pr} (ветка ${l.branch}) — ${l.why}` + (res.weak_links ? "  [СЛАБАЯ СВЯЗЬ]" : ""));
  if (res.closers?.length) console.log("закрыт коммитом: " + res.closers.join(", "));
  if (!res.links?.length && !res.closers?.length) console.log("PR и коммиты не найдены — привязка только по ветке/первому промпту");
  if (res.shared?.length) console.log("ВНИМАНИЕ: " + sharedTxt(res) + " — часы поделены между задачами");
  if (res.h === null) {
    console.log("факт недоступен: сессии не найдены (покрытие none)");
  } else {
    const estTxt = est ? `оценка ${fmtH(est)} ч, ×${(res.h / est).toFixed(2)}` : "оценки нет";
    const raw = res.shared?.length && res.h_raw !== null && res.h_raw !== undefined ? ` (без деления: ${fmtH(res.h_raw)} ч)` : "";
    console.log(`факт: ${fmtH(res.h)} ч активных в ${agentsTxt(res)}${raw} (${estTxt}); ${res.sessions} сесс., ${res.prompts} промптов, стена ${fmtH(res.wall, 1)} ч, покрытие ${res.cov}`);
  }
  if (res.tok) console.log(tokensTxt(res));
  console.log(`вторичное: PR ${res.prs.map((p) => `#${p}`).join(", ") || "нет"}; коммитов ${res.commits}; дифф ${diffTxt(res)} (без lock/снапшотов/минифицированного)`);
  for (const d of res.details) {
    const brs = Object.entries(d.branches).slice(0, 4).map(([b, h]) => `${b} ${h} ч`).join(", ");
    const rules = Object.entries(d.rules).map(([k, v]) => `${k}:${v}`).join(", ");
    const src = d.src === "codex" ? " [codex]" : "";
    console.log(`  сессия ${d.sid.slice(0, 8)}${src} ${fmtLocal(d.start)}: ${d.hours} ч, ${d.prompts} промптов [${rules}] — ${brs}`);
  }
  for (const x of res.taken ?? []) console.log(`ВНИМАНИЕ: ${fmtH(x.h)} ч по названию/первому промпту уже в факте #${x.issue} — здесь не засчитано; если там ошибка — est fact ${x.issue} --write, потом снова эту задачу`);
  for (const x of res.overlap ?? []) console.log(`ВНИМАНИЕ: ${fmtH(x.h)} ч этой задачи (ветка, субагент, коммит) есть и в факте #${x.issue} — пересчитай его: est fact ${x.issue} --write`);
  for (const sid of res.cloud_missing ?? []) console.log(`ВНИМАНИЕ: часть работы — облачная сессия https://claude.ai/code/${sid}, её события не импортированы: выгрузить браузером и est cloud-import (SKILL.md est, «Облачная сессия»)`);
}

function writeFact(repo: Repo, issue: Any, res: Fact, est: number | null): void {
  if (res.is_pr) throw new EstError(`#${res.issue} — это PR, а не issue: факт по PR не записывается`);
  const existing = findMarkerComment(issue, "fact");
  const [manual, cause, kept] = extractKeptLines(existing ? existing.body : "");
  const body = factCommentBody(res, est, kept, manual, cause);
  const what = upsertComment(repo, issue, "fact", body);
  if (res.iv && Object.keys(res.iv).length) repo.recorded().set(res.issue, res.iv); // следующая задача sweep видит этот факт
  let msg = `комментарий «Факт» ${what}`;
  if (res.h !== null) {
    setNumberField(repo, issue, FIELD_FACT, res.h);
    msg += `, поле «${FIELD_FACT}» = ${fmtH(res.h)}`;
  }
  const extra: [string, number | null][] = [
    [FIELD_TOK, res.tok ? round2(res.tok.total / 1e6) : null],
    [FIELD_USD, res.usd ?? null],
  ];
  for (const [fname, val] of extra) {
    if (val === null) continue;
    if (setOptionalNumberField(repo, issue, fname, val)) msg += `, «${fname}» = ${fmtH(val)}`;
    else msg += ` (поля «${fname}» в проекте нет — пропущено)`;
  }
  console.log(msg);
}

interface FactArgs {
  number?: number;
  repo?: string;
  write: boolean;
  gap: number;
  json: boolean;
  sweep: boolean;
  since: string;
}

function cmdFact(args: FactArgs): void {
  const registry = loadRegistry();
  if (args.gap < 1) throw new EstError(`--gap должен быть ≥ 1 минуты, получено ${args.gap}`);
  if (args.sweep && args.number !== undefined) throw new EstError("номер issue и --sweep несовместимы: либо одно, либо другое");
  if (isCloud()) {
    if (args.number === undefined) throw new EstError(CLOUD_ERR);
    console.log(
      `облачная сессия Claude Code: GitHub GraphQL и поля проекта отсюда недоступны — факт не посчитать и не записать${args.write ? " (--write ничего не пишет)" : ""}.\n` +
        `Запиши комментарий ниже в issue #${args.number} инструментом GitHub; «Готово» ставит workflow проекта «Item closed», иначе — пользователь.\n\n` +
        cloudFactBody(process.env.CLAUDE_CODE_REMOTE_SESSION_ID),
    );
    return;
  }
  const repo = new Repo(resolveRepo(args.repo), registry);
  const meta = repo.projectMeta();
  if (args.sweep) {
    const since = parseSince(args.since);
    const now = nowTs();
    const rows = repo.projectRows().filter((r) => r.state === "CLOSED" && r.fact === null && r.stateReason !== "NOT_PLANNED" && (r.closedAt || 0) >= now - since);
    rows.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    console.log(`== ${repo.full}: закрытых без факта за ${args.since}: ${rows.length}`);
    const stats: Record<string, number> = { full: 0, partial: 0, none: 0 };
    let total = 0.0;
    let epicsTotal = 0.0;
    let allIv: [number, number][] = [];
    for (const r of rows) {
      let issue: Any;
      let res: Fact;
      try {
        [issue, res] = factForIssue(repo, r.number, args.gap, true);
      } catch (e) {
        if (!(e instanceof EstError)) throw e;
        console.log(`  #${r.number}: ошибка: ${e.message}`);
        continue;
      }
      stats[res.cov] = (stats[res.cov] ?? 0) + 1;
      const h = res.h;
      if (h !== null) {
        if (res.epic) epicsTotal += h; // эпик — сумма подзадач, в общий итог не входит (иначе двойной счёт)
        else {
          total += h;
          allIv = allIv.concat(res.intervals ?? []);
        }
      }
      let extra = res.epic ? "эпик" : res.prs.length ? "PR " + res.prs.map((p) => `#${p}`).join(", ") : "без PR";
      if (res.weak_links) extra += " (слабая связь)";
      if (res.shared?.length) extra += ` (доля 1/${Math.max(...res.shared.map((s) => s.k))})`;
      console.log(`  #${pad(String(r.number), 5)} ${pad(fmtH(h), 6, true)} ч  ${pad(res.cov, 7)} оценка ${pad(fmtH(r.est), 5, true)}  ${pad(extra, 26)} ${r.title.slice(0, 50)}`);
      if (args.write && res.cov !== "none") writeFact(repo, issue, res, r.est);
    }
    const unionH = mergeIntervals(allIv).reduce((s, [a, b]) => s + (b - a), 0) / 3600;
    console.log(`итого: full ${stats.full}, partial ${stats.partial}, none ${stats.none}; сумма часов ${fmtH(total)} (без эпиков; эпики ${fmtH(epicsTotal)} ч — сумма своих подзадач)`);
    if (total - unionH > 0.05) console.log(`ВНИМАНИЕ: интервалы задач пересекаются: сумма ${fmtH(total)} ч при объединении ${fmtH(unionH)} ч — двойной счёт ≈ ${fmtH(total - unionH)} ч`);
    if (!args.write) console.log("(без --write ничего не записано)");
    return;
  }
  if (args.number === undefined) throw new EstError("укажите номер issue или --sweep");
  const [issue, res] = factForIssue(repo, args.number, args.gap);
  const est = issueProjectFields(issue, meta).est;
  if (args.json) {
    const out: Any = { ...res, est };
    delete out.details;
    delete out.intervals;
    delete out.iv;
    console.log(JSON.stringify(out, null, 1));
  } else {
    printFact(repo, res, est);
  }
  if (args.write) writeFact(repo, issue, res, est);
  else if (!args.json) console.log("(без --write ничего не записано)");
}

// ----------------------------------------------------------------------------
// Команда estimate
// ----------------------------------------------------------------------------

export const SCALE = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 13] as const; // ступени оценки, ч; округление к ближайшей

export function roundScale(h: number): number {
  let best: number = SCALE[0];
  for (const s of SCALE) {
    const d = Math.abs(s - h);
    const bd = Math.abs(best - h);
    if (d < bd || (d === bd && s < best)) best = s;
  }
  return best;
}

interface EstimateArgs {
  number: number;
  repo?: string;
  hours?: number;
  type: string;
  analogs: string;
  mult: number;
  note: string;
  write: boolean;
}

/**
 * Оценка = прогноз по фактам аналогов: часы, токены и стоимость — медианы фактов × поправка.
 * --hours — только экспертная оценка, когда аналогов с фактом нет (доверие C). k справочный.
 */
function cmdEstimate(args: EstimateArgs): void {
  if (isCloud()) throw new EstError(CLOUD_ERR);
  const registry = loadRegistry();
  const repo = new Repo(resolveRepo(args.repo), registry);
  const meta = repo.projectMeta();
  if (!(EST_TYPES as readonly string[]).includes(args.type)) throw new EstError(`--type должен быть одним из: ${EST_TYPES.join(", ")}`);
  if (args.hours !== undefined && !(args.hours > 0)) throw new EstError(`--hours должен быть больше 0, получено ${fmtH(args.hours)}`);
  if (![0.5, 1, 1.5, 2].includes(args.mult)) throw new EstError("--mult допускает только 0.5, 1, 1.5 или 2");
  // аналоги: номер issue этого репо (254) или задача другого репо из реестра (owner/repo#254)
  const analogs: (number | string)[] = []; // number — этот репо; "owner/repo#N" — другой
  for (let a of args.analogs.split(",")) {
    a = a.trim().replace(/^#+/, "");
    if (!a) continue;
    const m = /^([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)#(\d+)$/u.exec(a);
    if (m && m[1] !== repo.full) {
      const key = `${m[1]}#${parseInt(m[2]!, 10)}`;
      if (!analogs.includes(key)) analogs.push(key);
      continue;
    }
    if (m) a = m[2]!;
    if (!isDigits(a)) throw new EstError(`аналог «${a}» — не номер issue и не owner/repo#N`);
    const n = parseInt(a, 10);
    if (n === args.number) throw new EstError(`аналог #${a} — это сама оцениваемая задача`);
    if (!analogs.includes(n)) analogs.push(n);
  }
  const [rows, c, level] = calibForEstimate(repo, registry);
  const byNum = new Map(rows.map((r) => [r.number, r]));
  const facts: number[] = [];
  const toks: number[] = [];
  const usds: number[] = [];
  const parts: string[] = [];
  const otherParts = new Map<string, string[]>();
  const otherRows = new Map<string, Map<number, Row>>();

  const take = (r: Row, label: string, bucket: string[]) => {
    const fm = r.fact_marker ?? {};
    if (r.fact === null) {
      bucket.push(`${label} (факт неизвестен)`);
      return;
    }
    const cov = fm.cov || "full";
    if (cov !== "full") {
      bucket.push(`${label} (факт ${fmtH(r.fact)} ч, покрытие ${cov} — не учтён)`);
      return;
    }
    facts.push(Number(r.fact));
    const tt = fm.tok?.total;
    if (tt) toks.push(tt / 1e6);
    if (fm.usd !== undefined && fm.usd !== null) usds.push(Number(fm.usd));
    bucket.push(`${label} (факт ${fmtH(r.fact)} ч)`);
  };

  for (const a of analogs) {
    if (typeof a === "string") {
      const [full, numS] = a.split("#") as [string, string];
      const num = parseInt(numS, 10);
      if (!otherRows.has(full)) {
        if (!(full in registry)) throw new EstError(`аналог ${a}: репозиторий ${full} не в реестре ${REGISTRY_PATH}`);
        otherRows.set(full, new Map(new Repo(full, registry).projectRows().map((r) => [r.number, r])));
      }
      const r = otherRows.get(full)!.get(num);
      if (!r) throw new EstError(`аналог ${a} не найден в проекте репозитория ${full}`);
      if (!otherParts.has(full)) otherParts.set(full, []);
      take(r, `#${num}`, otherParts.get(full)!);
      continue;
    }
    const r = byNum.get(a);
    if (!r) {
      try {
        fetchIssue(repo, a);
      } catch (e) {
        if (!(e instanceof EstError)) throw e;
        throw new EstError(`аналог #${a} не найден в репо ${repo.full} как issue (${e.message})`);
      }
      console.error(`предупреждение: аналог #${a} есть в репо, но не в проекте — факт неизвестен`);
      parts.push(`#${a} (нет в проекте)`);
      continue;
    }
    take(r, `#${a}`, parts);
  }
  for (const [full, lst] of otherParts) parts.push(`из проекта ${full}: ` + lst.join(", "));
  const analogTxt = parts.length ? parts.join("; ") : "нет";

  const expert = args.hours !== undefined;
  if (!facts.length && !expert) throw new EstError("нет аналогов с фактом (покрытие full) — укажи --analogs с фактами или --hours как экспертную оценку");
  if (facts.length === 1 && !expert) throw new EstError("один аналог — не прогноз: добавь второй аналог или --hours");
  let tokF: number | null = null;
  let usdF: number | null = null;
  let spreadTxt: string | null = null;
  let raw: number | null = null;
  let h: number;
  let basis: string;
  if (facts.length) {
    raw = median(facts) * args.mult;
    h = roundScale(raw);
    if (toks.length) tokF = median(toks) * args.mult;
    if (usds.length) usdF = median(usds) * args.mult;
    const mn = Math.min(...facts);
    const mx = Math.max(...facts);
    if (mn > 0 && mx / mn > 3) spreadTxt = ` Разброс фактов аналогов ${fmtH(mn)}…${fmtH(mx)} ч — взята медиана.`;
    basis = "прогноз по фактам аналогов";
    if (expert) {
      // экспертные часы поверх прогноза: токены и стоимость масштабируются пропорционально
      const ratio = raw > 0 ? args.hours! / raw : 1;
      basis = `экспертная оценка; по аналогам вышло бы ${fmtH(h)} ч, токены и стоимость пересчитаны ×${ratio.toFixed(1)}`;
      h = roundScale(args.hours!);
      tokF = tokF !== null ? tokF * ratio : null;
      usdF = usdF !== null ? usdF * ratio : null;
    }
  } else {
    h = roundScale(args.hours!);
    basis = "экспертная оценка, аналогов с фактом нет";
  }
  if (expert && Math.abs(h - args.hours!) > 1e-9) console.error(`предупреждение: --hours ${fmtH(args.hours)} округлено к шкале: ${fmtH(h)}`);
  const sameType = rows.filter((r) => r.state === "CLOSED" && r.fact !== null && (r.fact_marker?.cov ?? "full") === "full" && rowType(r) === args.type).length;
  const counted = facts.length;
  const conf = expert ? "C" : counted >= 3 && sameType >= 5 ? "A" : "B";
  let forecast = `Оценка: ${fmtH(h)} ч`;
  if (tokF !== null) forecast += `, ≈ ${fmtH(tokF, tokF < 1 ? 2 : 1)} млн токенов`;
  if (usdF !== null) forecast += usdF < 1 ? `, ≈ $${usdF.toFixed(2)}` : `, ≈ $${usdF.toFixed(0)}`;
  if (facts.length && (toks.length < facts.length || usds.length < facts.length)) forecast += ` (токены и стоимость по ${Math.min(toks.length, usds.length)} из ${facts.length} аналогов)`;
  const note = args.note ? ` (${args.note})` : "";
  const multTxt = facts.length ? ` Поправка: ×${fmtH(args.mult)}${note}.` : "";
  const kTxt = c.n ? `k=${c.k} (n=${c.n}, уровень «${level}»; справочно, к прогнозу не применяется)` : "k: истории нет";
  const text = `${forecast} (тип ${args.type}, доверие ${conf}; ${basis}). Аналоги: ${analogTxt}.${multTxt}${spreadTxt ?? ""} ${kTxt}.`;
  const marker = {
    v: 2,
    h,
    raw: raw !== null ? round2(raw) : null,
    type: args.type,
    analogs,
    mult: args.mult,
    tok: tokF !== null ? round2(tokF) : null,
    usd: usdF !== null ? round2(usdF) : null,
    expert,
    k: c.k,
    n: c.n,
    conf,
  };
  const body = text + "\n" + `<!-- est ${pyDumps(marker)} -->`;
  const issue = fetchIssue(repo, args.number);
  const cur = issueProjectFields(issue, meta);
  console.log(`== ${repo.full}#${args.number}: ${issue.title}`);
  console.log(`текущая «${FIELD_EST}»: ${fmtH(cur.est)}; статус: ${cur.status || "—"}`);
  const over = raw !== null && !expert ? raw : expert ? args.hours! : null;
  if (over !== null && over > SCALE[SCALE.length - 1]!) console.log(`ВНИМАНИЕ: выходит ${fmtH(over)} ч > 13 — в поле записано ${fmtH(h)}, задачу надо дробить на подзадачи`);
  console.log("комментарий:");
  console.log(body);
  if (args.write) {
    const what = upsertComment(repo, issue, "est", body);
    setNumberField(repo, issue, FIELD_EST, h);
    console.log(`комментарий «Оценка» ${what}, поле «${FIELD_EST}» = ${fmtH(h)}`);
  } else {
    console.log("(без --write ничего не записано)");
  }
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `est — оценка задач по истории проекта и факт из транскриптов Claude Code, Codex и облачных сессий.

  est history [--repo o/r] [--grep СЛОВО] [--all-repos] [--last N]
  est fact <N> [--repo o/r] [--write] [--gap 30] [--json]
  est fact --sweep [--since 90d] [--repo o/r] [--write]
  est estimate <N> [--repo o/r] --type <type> --analogs a,b[,c] [--mult 0.5|1|1.5|2] [--note "причина"] [--write]
  est estimate <N> [--repo o/r] --type <type> --hours H [--write]
  est cloud-import <выгрузка.json>...   — события облачной сессии (SKILL.md, «Облачная сессия») в источники факта
  <type> — ${EST_TYPES.join(" ")}`;

/** Выгрузки облачных сессий → каталог состояния; сводка по каждой, чтобы было видно, что легло. */
function cmdCloudImport(files: string[]): void {
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  for (const f of files) {
    let data: Any;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      throw new EstError(`${f}: ${(e as Error).message}`);
    }
    if (!isCloudExport(data)) throw new EstError(`${f}: не выгрузка облачной сессии (нужны session, repo, events — сниппет из SKILL.md est)`);
    const s = parseCloudFile(f);
    const dst = cloudPath(data.repo, data.session);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, JSON.stringify(data));
    const n = data.events.length;
    const span = s.ev.length ? `${hhmm(s.ev[0]![0])}–${hhmm(s.ev[s.ev.length - 1]![0])} UTC` : "без записей";
    const title = data.title ? `, «${data.title}»` : "";
    console.log(`${data.session} (${data.repo}${title}): ${n} ${plural(n, "событие", "события", "событий")}, ${s.n_human} ${plural(s.n_human, "промпт", "промпта", "промптов")}, ${span} → ${dst}`);
  }
}

function intArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new EstError(`${name}: ожидается целое число, получено «${v}»`);
  return parseInt(v, 10);
}

function floatArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new EstError(`${name}: ожидается число, получено «${v}»`);
  return n;
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  const rest = argv.slice(1);
  try {
    if (!cmd || cmd === "-h" || cmd === "--help") {
      console.log(USAGE);
      return cmd ? 0 : 2;
    }
    if (cmd === "cloud-import") {
      if (!rest.length) throw new EstError("укажите файлы выгрузки облачной сессии");
      cmdCloudImport(rest);
      return 0;
    }
    if (cmd === "history") {
      const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, grep: { type: "string" }, "all-repos": { type: "boolean", default: false }, last: { type: "string" } } });
      cmdHistory({ repo: values.repo, grep: values.grep, allRepos: values["all-repos"], last: intArg(values.last, "--last") });
      return 0;
    }
    if (cmd === "fact") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { repo: { type: "string" }, write: { type: "boolean", default: false }, gap: { type: "string", default: "30" }, json: { type: "boolean", default: false }, sweep: { type: "boolean", default: false }, since: { type: "string", default: "90d" } },
      });
      if (positionals.length > 1) throw new EstError(`лишние аргументы: ${positionals.slice(1).join(" ")}`);
      cmdFact({ number: intArg(positionals[0], "номер issue"), repo: values.repo, write: values.write, gap: intArg(values.gap, "--gap")!, json: values.json, sweep: values.sweep, since: values.since });
      return 0;
    }
    if (cmd === "estimate") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { repo: { type: "string" }, hours: { type: "string" }, type: { type: "string" }, analogs: { type: "string", default: "" }, mult: { type: "string", default: "1" }, note: { type: "string", default: "" }, write: { type: "boolean", default: false } },
      });
      const number = intArg(positionals[0], "номер issue");
      if (number === undefined) throw new EstError("укажите номер issue");
      if (!values.type) throw new EstError(`--type обязателен: ${EST_TYPES.join(", ")}`);
      cmdEstimate({ number, repo: values.repo, hours: floatArg(values.hours, "--hours"), type: values.type, analogs: values.analogs, mult: floatArg(values.mult, "--mult")!, note: values.note, write: values.write });
      return 0;
    }
    throw new EstError(`неизвестная команда «${cmd}»; ожидается history, fact или estimate`);
  } catch (e) {
    if (e instanceof EstError) die(e.message);
    if (e && typeof e === "object" && (e as Any).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") die((e as Error).message, 2);
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
