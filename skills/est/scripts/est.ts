#!/usr/bin/env bun
/**
 * est — task estimates from the project's history and actuals from Claude Code and Codex transcripts.
 *
 * Subcommands:
 *   est history  — table of closed tasks with an actual, the calibration coefficient k
 *   est fact     — actual (the agent's active hours) from Claude Code and Codex transcripts for an issue
 *   est estimate — record an estimate with analogs and a marker
 *   est period   — summary of all the repo's sessions over a period, not tied to tasks: the flow before and after
 *
 * Runs on Bun (`bun est.ts …`), only `node:` APIs + the `gh` CLI. The source of truth is GitHub (the project fields
 * "Estimate, h", "Actual, h" and comments with HTML markers <!-- est {...} --> /
 * <!-- fact {...} -->). Without --write nothing is written to GitHub. Cache formats in
 * ~/.config/ai-dev/cache are compatible with the former est.py.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import locale from "../../github/scripts/locale.cjs";
import type { Names, Plural } from "../../github/scripts/locale.cjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const HOME = os.homedir();
// The skill's personal state (repository registry, prices, cache) lives in an agent-neutral directory:
// $AI_DEV_CONFIG_DIR, otherwise ~/.config/ai-dev — one expression in all scripts (the ai-dev config-dir standard):
// github pins a task to a session in the same directory. The old ~/.claude/est moves automatically
// (see ensureConfigDir), leaving a symlink in its place.
export const EST_DIR = process.env.AI_DEV_CONFIG_DIR || path.join(HOME, ".config", "ai-dev");
const LEGACY_EST_DIR = path.join(HOME, ".claude", "est");
export const REGISTRY_PATH = path.join(EST_DIR, "repos.json");
const CACHE_DIR = path.join(EST_DIR, "cache");
// Actual sources: Claude Code transcripts (~/.claude/projects), Codex sessions (~/.codex/sessions) and event exports
// of Claude Code cloud sessions (<state directory>/cloud/<owner>/<repo>/<session>.json, est cloud-import).
export const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const CODEX_DIRS = [path.join(HOME, ".codex", "sessions"), path.join(HOME, ".codex", "archived_sessions")];
export const CLOUD_DIR = path.join(EST_DIR, "cloud");
// Session pinning to tasks: `github task status` "In progress" writes <state directory>/sessions/<session id> with the
// line owner/repo#N — direct evidence "this session worked on this task", stronger than any feature in the transcript.
export const PINS_DIR = path.join(EST_DIR, "sessions");

// Move only while the directory doesn't exist: before the move github puts pins into the old directory and doesn't
// create the new one (github.ts, configDir) — otherwise the registry and prices would stay in the old one.
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
    console.error(`est state moved: ${LEGACY_EST_DIR} → ${EST_DIR} (symlink left in place)`);
  }
  mkdirSync(EST_DIR, { recursive: true });
}

// Project fields by dictionary key (`fields` in the github skill's locales): "Estimate, h" and its Russian name are
// one field, a name in any language; comments are written in the project language (`locale.projectLanguage`), parsed
// in any.
export const FIELD_EST = "estimate";
export const FIELD_FACT = "actual";
export const FIELD_STATUS = "status";
export const FIELD_TOK = "tokens"; // optional fields: present in the project — filled in, absent — skipped
export const FIELD_USD = "cost";

/** Key of a project field by its name in any dictionary language; not an est field — null. */
function fieldKey(name: string | undefined): string | null {
  if (name === "Status") return FIELD_STATUS;
  for (const n of locale.everyNames()) {
    if (name === n.fields.estimate) return FIELD_EST;
    if (name === n.fields.actual) return FIELD_FACT;
    if (name === n.fields.tokens) return FIELD_TOK;
    if (name === n.fields.cost) return FIELD_USD;
  }
  return null;
}
/** Names in the project language of the current directory. */
const projectNames = (): Names => locale.names(locale.projectLanguage());
/** Field name in output: as in the project; no field — in the project language. */
function fieldShown(meta: Meta, key: string): string {
  const n = projectNames();
  const byKey: Record<string, string> = { [FIELD_EST]: n.fields.estimate, [FIELD_FACT]: n.fields.actual, [FIELD_TOK]: n.fields.tokens, [FIELD_USD]: n.fields.cost, [FIELD_STATUS]: "Status" };
  return meta.fields[key]?.name ?? byKey[key] ?? key;
}

// Anthropic public API rates, $ per 1M tokens: (input, output, cache read).
// Cache write = input × 1.25 (TTL 5 min) or × 2 (TTL 1 h). The key is the model id without the date: a date after the
// key in the model id (-YYYYMMDD, on Vertex AI @YYYYMMDD) doesn't change the rate, another continuation is another
// version (claude-opus-5-5 with the key claude-opus-5), it has no price until it is in the price list (#345).
// This is the API equivalent: on a subscription this money isn't charged, but the value is comparable between tasks.
// Override/extension — <state directory>/prices.json in the same format:
// {"<model id>": [input, output, cache_read]}.
export const PRICES_DATE = "2026-10-06";
type Price = [number, number, number];
export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": [10.0, 50.0, 0.25],
  "claude-mythos-5-1": [10.0, 50.0, 0.25],
  "claude-fable-5": [10.0, 50.0, 1.0],
  "claude-mythos-5": [10.0, 50.0, 1.0],
  "claude-opus-5-5": [4.0, 20.0, 0.2],
  "claude-opus-5": [5.0, 25.0, 0.5],
  "claude-opus-4-8": [5.0, 25.0, 0.5],
  "claude-opus-4-7": [5.0, 25.0, 0.5],
  "claude-opus-4-6": [5.0, 25.0, 0.5],
  "claude-sonnet-5-5": [2.0, 10.0, 0.2],
  "claude-sonnet-5": [2.0, 10.0, 0.2],
  "claude-sonnet-4-6": [3.0, 15.0, 0.3],
  "claude-haiku-4-5": [1.0, 5.0, 0.1],
};
// speed=fast; cache read — ×0.1 of input; for other models a fast rate isn't published
const FAST_PRICES: Record<string, Price> = { "claude-opus-5-5": [8.0, 40.0, 0.8], "claude-opus-5": [10.0, 50.0, 1.0] };
const PRICES_PATH = path.join(EST_DIR, "prices.json");
let pricesCache: Record<string, Price> | null = null;

/**
 * Model version — its id without the date: `claude-haiku-4-5-20251001` and `claude-opus-4-5@20251101` —
 * `claude-haiku-4-5`, `claude-opus-4-5`.
 */
const modelVersion = (model: string) => model.replace(/[-@]\d{8}$/, "");

/** A model's rate in the table: by the whole id, otherwise by version; a prefix of another version doesn't count. */
const priceIn = (table: Record<string, Price>, model: string): Price | null =>
  Object.hasOwn(table, model) ? table[model]! : Object.hasOwn(table, modelVersion(model)) ? table[modelVersion(model)]! : null;

/** (input, output, cache read) $/M for the model, or null if the model isn't in the price list. */
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
  return (fast ? priceIn(FAST_PRICES, model) : null) ?? priceIn(table, model);
}

/** Cost of one model response in $; vals = (input, output, cache write 5m, cache write 1h, cache read). */
export function usageCost(model: string, vals: [number, number, number, number, number], fast = false, table?: Record<string, Price>): number | null {
  const p = priceFor(model, fast, table);
  if (!p) return null;
  const [pin, pout, pcr] = p;
  const [i, o, cw5, cw1, cr] = vals;
  return (i * pin + o * pout + cw5 * pin * 1.25 + cw1 * pin * 2.0 + cr * pcr) / 1e6;
}

// Task types = conventional commit types + research (a spike without code). The same words are
// branch prefixes: <type>/<issue>-<slug> (an area prefix is allowed: <area>/<type>/<issue>-<slug>).
export const EST_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"] as const;
// the same copy — TASK_TYPES and TASK_BRANCH_RE in skills/github/scripts/github.ts: there's no shared module (a skill
// is installed alone), the standard tests/standards/task-branch keeps the parsing identical
const BRANCH_CONV_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + EST_TYPES.join("|") + ")/(\\d{1,6})-", "iu");
const PR_PAGE = 50;
const PR_MAX = 500;
const ISSUES_MAX = 500; // how many closed issues the index of closing commits keeps
const SESSION_CACHE_V = 18; // transcript cache format version (changed — reparse); 11 = session name history
// (title_hist), 12 = cloud sessions, 13 = all session directories (cwds), 14 = PR repository on pr-link, 16 = git and
// gh listing hashes — only own ones, 17 = shell keywords in a listing, 18 = agent number on a record (task fan-out)
const PROJECT_META_TTL = 86400; // a day: reread the cache of project/field ids
const OPEN_PRS_TTL = 3600; // an hour: the list of open PRs (their branches are someone else's)
// Long-lived branches: "neutral" — by themselves they don't link a task, but inside an anchor window they count.
const BASE_BRANCHES = new Set(["main", "master", "develop", "dev", "staging", "production", "release"]);

// Repository registry — the personal file <state directory>/repos.json (not part of the skill's repo).
// Format: {"owner/repo": {"paths": ["/abs/path/to/checkout", ...],
//                         "project": {"owner": "<owner>", "number": <N>}}}
// Without an entry the repo is determined from git remote origin of the current directory, the project — by its
// link to the repository; paths are needed to find transcripts (~/.claude/projects).
export type Registry = Record<string, { paths?: string[]; project?: { owner: string; number: number | string } }>;

// Files not counted in the diff: lock files, snapshots, minified code, build output.
const DIFF_EXCLUDE = new RegExp(
  "(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?|Cargo\\.lock|" +
    "poetry\\.lock|composer\\.lock|Gemfile\\.lock|go\\.sum|Podfile\\.lock)$" +
    "|(^|/)__snapshots__/|\\.snap$|\\.min\\.(js|css)$|(^|/)(dist|build)/|\\.generated\\.",
  "i",
);

export class EstError extends Error {}

/** The number exists, but not as an issue (usually it's a PR). */
export class NotAnIssue extends EstError {}

const errIs = (e: unknown, text: string) => String((e as Error).message ?? e).toLowerCase().includes(text.toLowerCase());

function die(msg: string, code = 1): never {
  console.error(`error: ${msg}`);
  process.exit(code);
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

/** ISO string (UTC, with Z or an offset) → epoch seconds. */
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

export function plural(n: number, one: string, other: string): string {
  return Math.abs(n) === 1 ? one : other;
}

export function parseSince(s: string): number {
  const m = /^(\d+)([dhwm])$/.exec(s.trim());
  if (!m) throw new EstError(`invalid period «${s}», expected like 90d / 12w / 6m / 48h`);
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
  if (!n) throw new EstError("median of an empty list");
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * round(x, nd) as in Python: to the nearest, and an exact half (0.125 → 0.12) — to even.
 * This way actuals and k match those computed by the former est.py; toFixed alone rounds a half up.
 */
export function pyRound(x: number, nd: number): number {
  const long = x.toFixed(nd + 30); // exact decimal expansion of the binary value
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

/** Like json.dumps(ensure_ascii=False): separators ", " and ": " — markers stay readable and compatible. */
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
  // each write has its own temp file: concurrent est runs (parallel sessions, sweep, dashboard) write one cache (#347)
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function mtimeOf(file: string): number {
  return statSync(file).mtimeMs / 1000;
}

const sameMtime = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-3;

/** *.jsonl recursively (like glob **\/*.jsonl), sorted. */
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

/** The network didn't come back over all the retries of a gh call: no point going further down the list (#353). */
export class NetworkError extends EstError {}

/** A network or GitHub server failure (timeout, dropped connection, 5xx) — not a request error: a retry may succeed. */
const NETWORK_FAILURE = /dial tcp|i\/o timeout|timed out|TLS handshake|connection reset|connection refused|broken pipe|unexpected EOF|no such host|network is unreachable|stream error|Client\.Timeout|deadline exceeded|HTTP 5\d\d|status code: 5\d\d/i;
/** The request didn't reach GitHub: the connection wasn't established. */
const NOT_SENT = /dial tcp|TLS handshake|no such host|network is unreachable/i;

/** Pauses before gh call retries on a network failure, ms: `AI_DEV_GH_RETRY_MS`, comma-separated, else 2, 5, 15 s. */
function retryPauses(): number[] {
  const env = process.env.AI_DEV_GH_RETRY_MS;
  return env === undefined ? [2000, 5000, 15000] : env.split(",").filter(Boolean).map(Number);
}

/**
 * A command; gh is retried with pauses on a network failure (#353). `idempotent: false` (a new comment) — retry only if
 * the request wasn't sent: otherwise GitHub may have accepted it, and a retry would duplicate the comment.
 */
function run(cmd: string[], stdin?: string, idempotent = true): string {
  const pauses = cmd[0] === "gh" ? retryPauses() : [];
  const what = `command ${cmd.slice(0, 3).join(" ")}…`;
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { input: stdin, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new EstError(`command '${cmd[0]}' not found; the gh CLI must be installed`);
      throw new EstError(`${what}: ${r.error.message}`);
    }
    if (r.status === 0) return r.stdout;
    const err = (r.stderr || "").trim();
    const failed = `${what} exited with code ${r.status}: ${err.slice(0, 500)}`;
    if (!pauses.length || !NETWORK_FAILURE.test(err)) throw new EstError(failed);
    if (!idempotent && !NOT_SENT.test(err)) throw new EstError(`${failed} — network failure, but the request may have reached GitHub: no retry, so as not to post it twice; check and retry`);
    if (attempt >= pauses.length) throw new NetworkError(`${failed} — network failure, retries: ${pauses.length}`);
    console.error(`network failure, retry in ${pauses[attempt]! / 1000} s: ${what}`);
    Bun.sleepSync(pauses[attempt]!);
  }
}

function ghGraphql(query: string, variables: Record<string, unknown>): Any {
  const out = run(["gh", "api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  const data = JSON.parse(out);
  if (data.errors && data.errors.length) {
    const msgs = data.errors.map((e: Any) => e.message ?? "").join("; ");
    if (!data.data) throw new EstError(`GraphQL: ${msgs}`);
    console.error(`GraphQL warning: ${msgs}`);
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
  const out = run(cmd, stdin, method !== "POST");
  return out.trim() ? JSON.parse(out) : null;
}

// ----------------------------------------------------------------------------
// Repository registry and projects
// ----------------------------------------------------------------------------

export function loadRegistry(): Registry {
  ensureConfigDir();
  if (!existsSync(REGISTRY_PATH)) {
    saveJson(REGISTRY_PATH, {});
    console.error(`created the registry ${REGISTRY_PATH}`);
  }
  const reg = loadJson<unknown>(REGISTRY_PATH, null);
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw new EstError(`the registry ${REGISTRY_PATH} is corrupted`);
  return reg as Registry;
}

function detectRepo(): string {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (r.error) throw new EstError("git not found; pass --repo owner/repo");
  if (r.status !== 0) throw new EstError("couldn't determine the repository from git remote origin; pass --repo owner/repo");
  const url = r.stdout.trim();
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new EstError(`couldn't parse the remote «${url}»; pass --repo owner/repo`);
  return `${m[1]}/${m[2]}`;
}

export function resolveRepo(arg?: string): string {
  const repo = arg || detectRepo();
  if (!/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(repo)) throw new EstError(`invalid --repo format «${repo}», expected owner/repo`);
  return repo;
}

// ----------------------------------------------------------------------------
// Cache data types (compatible with est.py)
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
  /** Cloud sessions from the `Claude-Session` trailer of PR commits: transcripts in the cloud (est cloud-import). */
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
  /** The organization's issue type ("Epic"); a personal account has no types — an epic has the `epic` label. */
  issueType?: string | null;
  /** Number of the task's epic (the sub-issue parent). */
  parent?: number | null;
  /** Issue description size, chars, without answers to questions (descSize) — a size feature for picking analogs. */
  size?: number;
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
  /** Fields by key (FIELD_*): id, name in the project, options. */
  fields: Record<string, { id: string; name: string; options: Record<string, string> }>;
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

/** Session summary (Claude Code or Codex), as in the sessions.json cache. */
export interface Session {
  sid: string;
  cwd: string | null;
  cwds?: string[]; // all record directories in order of appearance: a session may move to another repository mid-work
  n_human: number;
  ev: Any[][]; // [ts, branch, human, hint?, uidx?, agent? (0 — the session itself, k — the k-th subagent)]
  prlinks: [number, number, string?][]; // [ts, PR number, PR repository owner/name — prRepository in Claude Code]
  commits: [number, string][];
  first_refs: number[];
  first_urls: string[];
  usage: Any[][]; // [mid, model_idx, in, out, cw5, cw1, cr, fast]
  models: string[];
  title: string; // the latest name
  title_refs: number[];
  title_urls: string[];
  title_hist?: [number, string][]; // (rename time, name) — in transcript order
  n_subagents: number;
  source: string;
  routine: boolean;
  mtime?: number;
  v?: number;
  guest?: boolean; // a transcript from another registry repository's directory or the app's temp folder:
  // linked only by features of the task's repository
}

/**
 * The part of an actual computed by a cloud session from its own transcript in the container (`est fact <N>` in the
 * cloud) and handed over by the `cloud` marker of the "Actual" comment: project fields can't be set from the cloud —
 * the local computation sets them, adding up the parts.
 */
export interface CloudPart {
  session: string;
  h: number;
  iv: [number, number][];
  prompts: number;
  agents?: number; // the cloud session's subagents whose work is linked to the task
  tok: { in: number; out: number; cw: number; cr: number; total: number } | null;
  models: Record<string, { mtok: number; usd: number | null }>;
  steps?: number; // the part's turns (model responses), including subagents
  steps_agents?: number;
  tail?: number; // turns with context larger than TAIL_CTX
  preamble?: number; // context of the first top-level turn
  ctx_end?: number; // context of the last top-level turn
}

/** Turn context from which a turn is "tail": turns with such context were 20 % of turns and 45 % of tokens. */
export const TAIL_CTX = 400_000;

/** Cloud parts from all comments with the "Actual" marker: per session — the last one, order — of first appearance. */
export function cloudPartsIn(bodies: string[]): CloudPart[] {
  const by = new Map<string, CloudPart>();
  for (const b of bodies) for (const p of parseMarker(b, "fact")?.cloud ?? []) if (p && typeof p.session === "string") by.set(p.session, p);
  return [...by.values()];
}

/** The subset of Repo the actual computation needs (in tests — a stub without GitHub). */
export interface FactRepo {
  full: string;
  prs(): Map<number, PR>;
  openPrs(): OpenPrs;
  closers(): Closers;
  sessions(): Session[];
  neutralBranches(): Set<string>;
  commitDiff(oid: string): number | null;
  /** Intervals of already recorded actuals: issue → sid (8 chars) → [(start, end)]; from the "Actual" markers. */
  recorded?(): Recorded;
  /** Session pinning to tasks: session id → `owner/repo#N` (loadPins); a session without a pin — by features. */
  pins?(): Map<string, string>;
}

export type Recorded = Map<number, Record<string, [number, number][]>>;

const PR_FIELDS = `number title state headRefName baseRefName body mergedAt updatedAt additions deletions changedFiles
        mergeCommit{oid} closingIssuesReferences(first:20){nodes{number}}
        commits(first:100){totalCount nodes{commit{oid authoredDate messageBody}}}
        files(first:100){nodes{path additions deletions}}`;

/** Cloud sessions from `Claude-Session: https://claude.ai/code/session_…` trailers in a commit message. */
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

/** A repository + its GitHub project + caches. */
export class Repo implements FactRepo {
  full: string;
  owner: string;
  name: string;
  paths: string[];
  otherPaths: string[];
  projectRef: { owner: string; number: number | string } | undefined;
  cacheDir: string;
  defaultBranch: string | null = null;
  optRefreshed = false;
  private meta_: Meta | null = null;
  private prs_: Map<number, PR> | null = null;
  private open_: OpenPrs | null = null;
  private closers_: Closers | null = null;
  private sessions_: Session[] | null = null;
  private parsed_: Parsed | null = null;
  private rows_: Row[] | null = null;
  private recorded_: Recorded | null = null;
  private pins_: Map<string, string> | null = null;

  constructor(full: string, registry: Registry) {
    this.full = full;
    const [owner, name] = full.split("/") as [string, string];
    this.owner = owner;
    this.name = name;
    const cfg = registry[full] ?? {};
    this.paths = cfg.paths ?? [];
    // directories of other registry repositories: guest sessions are looked up there (a task started
    // from another repository's directory)
    this.otherPaths = uniqSortedStrs(Object.entries(registry).filter(([k]) => k !== full).flatMap(([, c]) => c.paths ?? [])).filter((x) => !this.paths.includes(x));
    this.projectRef = cfg.project;
    this.cacheDir = path.join(CACHE_DIR, full.replace("/", "__"));
  }

  // --- project ----------------------------------------------------------
  /** Project id, field ids and Status options. Cached on disk (a day, with a registry check). */
  projectMeta(force = false): Meta {
    if (this.meta_ && !force) return this.meta_;
    const file = path.join(this.cacheDir, "project.json");
    const cached = force ? null : loadJson<Meta | null>(file, null);
    if (cached && cached.fields?.[FIELD_FACT]?.name) {
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
      if (!(e instanceof EstError) || e instanceof NetworkError) throw e; // the network isn't "not an organization": otherwise a false "Could not resolve to a User"
      pv = null;
    }
    if (!pv) {
      const data = ghGraphql(q.replace("organization(login:$o)", "user(login:$o)"), { o: owner, n: number });
      pv = data?.user?.projectV2 ?? null;
    }
    if (!pv) throw new EstError(`project ${owner} #${number} not found`);
    const fields: Meta["fields"] = {};
    for (const f of pv.fields.nodes) {
      const key = fieldKey(f.name);
      if (key) {
        const options: Record<string, string> = {};
        for (const o of f.options ?? []) options[o.name] = o.id;
        fields[key] = { id: f.id, name: f.name, options };
      }
    }
    const missing = [FIELD_EST, FIELD_FACT, FIELD_STATUS].filter((k) => !fields[k]).map((k) => fieldShown({ fields } as Meta, k));
    if (missing.length) throw new EstError(`project ${owner} #${number} has no fields: ${missing.join(", ")}`);
    const meta: Meta = { id: pv.id, owner, number, title: pv.title, fields, fetched_at: nowTs() };
    saveJson(file, meta);
    this.meta_ = meta;
    return meta;
  }

  /** Project items, once per run. */
  projectRows(): Row[] {
    if (this.rows_ === null) this.rows_ = this.projectItems();
    return this.rows_;
  }

  /** Intervals of recorded actuals (the "Actual" marker, the iv field); a write in this run adds to them. */
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

  /** Session pinning to tasks, once per run. */
  pins(): Map<string, string> {
    if (this.pins_ === null) this.pins_ = loadPins();
    return this.pins_;
  }

  private findProject(): [string, number] {
    if (this.projectRef) return [this.projectRef.owner, Number(this.projectRef.number)];
    const q = `query($o:String!,$r:String!){ repository(owner:$o,name:$r){
            projectsV2(first:5){ nodes{ number title owner{ ... on Organization{login} ... on User{login} } } } } }`;
    const nodes = ghGraphql(q, { o: this.owner, r: this.name }).repository.projectsV2.nodes;
    if (!nodes.length) throw new EstError(`repository ${this.full} has no linked project and no entry in ${REGISTRY_PATH}`);
    return [nodes[0].owner.login, nodes[0].number];
  }

  /** All project items with fields and the issue's latest comments. */
  private projectItems(): Row[] {
    const meta = this.projectMeta();
    const q = `
        query($id:ID!,$c:String){ node(id:$id){ ... on ProjectV2{
          items(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ id type
            content{ __typename ... on Issue{ id number title body state stateReason closedAt createdAt issueType{name} parent{number}
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
          issueType: c.issueType?.name ?? null,
          parent: c.parent?.number ?? null,
          size: descSize(c.body ?? ""),
          est: null,
          fact: null,
          status: null,
          est_marker: null,
          fact_marker: null,
        };
        for (const fv of it.fieldValues.nodes) {
          const key = fieldKey(fv.field?.name);
          if (key === FIELD_EST) row.est = fv.number ?? null;
          else if (key === FIELD_FACT) row.fact = fv.number ?? null;
          else if (key === FIELD_STATUS) row.status = fv.name ?? null;
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
  /** Cache of merged PRs (incrementally by updatedAt). */
  prs(): Map<number, PR> {
    if (this.prs_ !== null) return this.prs_;
    const file = path.join(this.cacheDir, "prs.json");
    const cache = loadJson<Any>(file, { prs: {} });
    let prs = new Map<number, PR>();
    for (const [k, v] of Object.entries(cache.prs ?? {})) prs.set(Number(k), v as PR);
    if ([...prs.values()].some((v) => !("baseRefName" in v) || !("cloud" in v))) prs = new Map(); // old cache format — reread
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

  /** One PR (including unmerged ones) — from the cache or by a request. null — only if there's no such PR. */
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

  /** Open PRs: {number: {headRefName, closing}} — their branches are foreign to other tasks (cached for an hour). */
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
   * Index of the closers of all the repo's closed issues (incrementally by updatedAt):
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

  /** Diff of a single commit (for an issue without a PR): lines without lock files/snapshots/minified code. Cached. */
  commitDiff(oid: string): number | null {
    const file = path.join(this.cacheDir, "commits.json");
    const cache = loadJson<Record<string, number>>(file, {});
    if (oid in cache) return cache[oid]!;
    let data: Any;
    try {
      data = ghRest(`repos/${this.full}/commits/${oid}`);
    } catch (e) {
      if (!(e instanceof EstError)) throw e;
      console.error(`warning: diff of commit ${oid.slice(0, 7)} not fetched: ${e.message}`);
      return null;
    }
    let n = 0;
    for (const f of data.files ?? []) if (!DIFF_EXCLUDE.test(f.filename || "")) n += (f.additions || 0) + (f.deletions || 0);
    cache[oid] = n;
    saveJson(file, cache);
    return n;
  }

  // --- transcripts -------------------------------------------------------
  /** Sessions for the actual: the repository's own (no routines), guests and pinned ones (selectSessions). */
  sessions(): Session[] {
    if (this.sessions_ === null) {
      const p = this.parsed();
      this.sessions_ = selectSessions(p.all, this.paths, p.guests, p.pinned);
    }
    return this.sessions_;
  }

  /** Sessions for a period summary: all of the repository's own and pinned ones, no guests (selectPeriodSessions). */
  periodSessions(): Session[] {
    const p = this.parsed();
    return selectPeriodSessions(p.all, this.paths, p.pinned);
  }

  private parsed(): Parsed {
    if (this.parsed_ === null) this.parsed_ = loadSessions(this);
    return this.parsed_;
  }
}

// ----------------------------------------------------------------------------
// Markers in comments
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
// Claude Code transcripts
// ----------------------------------------------------------------------------

export const encodePath = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

const HASH_RE = /(?<![0-9a-zA-Z])[0-9a-f]{7,40}(?![0-9a-zA-Z])/g;
// "#N" — boundaries like \w in Python (letters and digits of any alphabet)
const ISSUE_REF_RE = /(?<![\p{L}\p{N}_/])#(\d{1,6})(?![\p{L}\p{N}_])/gu;
const ISSUE_URL_RE = /github\.com\/([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)\/issues\/(\d{1,6})(?!\d)/gu; // issue URL with the repo
// Not human prompts: notifications, service insertions, automatic routines (scheduled-task).
const SKIP_PROMPT_PREFIXES = ["<task-notification", "<\\task-notification", "<local-command", "<command-", "<system-reminder", "<\\system-reminder", "<bash-", "<scheduled-task", "<\\scheduled-task"];

const refsIn = (txt: string) => uniqSortedNums([...txt.matchAll(ISSUE_REF_RE)].map((m) => parseInt(m[1]!, 10)));
const urlsIn = (txt: string) => uniqSortedStrs([...txt.matchAll(ISSUE_URL_RE)].map((m) => `${m[1]}#${parseInt(m[2]!, 10)}`));

// Subagent assignment: a number or link right after the word "task" (`subagentPrompt.task` in any dictionary language:
// "Task #42") or at the very start is the task; after "epic" (`subagentPrompt.epic`, with any ending) and "PR" it isn't
const ISSUE_ALT = String.raw`#(\d{1,6})(?![\p{L}\p{N}_])|(?:https?:\/\/)?github\.com\/([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)\/issues\/(\d{1,6})(?!\d)`;
const TASK_WORDS = locale.every((n) => n.subagentPrompt.task).map(locale.escapeRe).join("|");
const EPIC_WORDS = locale.every((n) => n.subagentPrompt.epic).map((w) => `${locale.escapeRe(w)}\\p{L}*`).join("|");
const TASK_WORD_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${TASK_WORDS})\s+(?:${ISSUE_ALT})`, "iu");
const TASK_LEAD_RE = new RegExp(String.raw`^\s*(?:${ISSUE_ALT})`, "u");
const NOT_TASK_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${EPIC_WORDS}|PR)\s*[:—-]?\s*(?:${ISSUE_ALT})`, "giu");

/**
 * The task from a subagent assignment: "Task #42 (epic #40). …" — 42, "#42 (epic #40): …" — 42, an issue link — with
 * the repository (`o/r#42`). Without these signs — as before: exactly one number without links or exactly one link
 * (and the number matching it), not counting numbers after "epic" and "PR". The hint is hard (its own record — whole,
 * someone else's — zero, branches and windows aren't looked at), so when unclear there is none: "look at #42 and #39"
 * — empty, records go by branch.
 */
function taskHintIn(txt: string): string {
  const key = (m: RegExpExecArray) => (m[1] ? String(parseInt(m[1], 10)) : `${m[2]}#${parseInt(m[3]!, 10)}`);
  const m = TASK_WORD_RE.exec(txt) ?? TASK_LEAD_RE.exec(txt);
  if (m) return key(m);
  const rest = txt.replace(NOT_TASK_RE, " ");
  const nums = refsIn(rest);
  const urls = urlsIn(rest);
  if (urls.length === 1 && (!nums.length || (nums.length === 1 && nums[0] === parseInt(urls[0]!.split("#")[1]!, 10)))) return urls[0]!;
  if (nums.length === 1 && !urls.length) return String(nums[0]);
  return "";
}

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

// The app's insertion into the prompt text: Claude Code desktop (Code tab) puts it before the
// human's text. An unclosed one runs to the end of the text.
const REMINDER_RE = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** Prompt text without <system-reminder> insertions: by it we decide if it's a human and look up the task number. */
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
  cwds: string[];
  n_human: number;
  ev: Any[][];
  prlinks: [number, number, string?][];
  commits: [number, string][];
  listed: [number, string][]; // hashes from git listing output — only own ones go into commits (finishCommits)
  first_refs: number[] | null;
  first_urls: string[];
  usage: Any[][];
  models: string[];
  mids: Set<string>;
  title: string;
  titles: [number, string][];
}

const newAcc = (): Acc => ({ cwd: null, cwds: [], n_human: 0, ev: [], prlinks: [], commits: [], listed: [], first_refs: null, first_urls: [], usage: [], models: [], mids: new Set(), title: "", titles: [] });

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

/** Commit hashes from a tool's output (at most 60 per output, 5000 per session). */
function collectHashes(into: [number, string][], ts: number, txt: string): void {
  const seen = new Set<string>();
  for (const m of txt.matchAll(HASH_RE)) {
    const h = m[0];
    if (!seen.has(h) && seen.size < 60 && into.length < 5000) {
      seen.add(h);
      into.push([ts, h]);
    }
  }
}

// Listing: git and gh commands that don't make commits but list them — including someone else's (neighbor worktrees,
// branches, log, fetch, PRs and issues via the API). The canon says to look at neighbors before work and after a
// merge, and a fresh hash of someone else's PR in such output close in time to its commit is a false anchor (#134).
// `gh pr view` isn't a listing: SKILL.md advises printing your PR's commits with it before `est fact`, it's an anchor.
const LIST_GIT = new Set(["worktree", "branch", "log", "show", "status", "fetch", "switch", "checkout", "rev-parse", "rev-list", "reflog", "for-each-ref", "show-ref", "cherry", "describe", "diff", "ls-remote", "remote", "name-rev", "merge-base", "shortlog", "blame", "ls-files", "ls-tree", "cat-file"]);
const LIST_GH = new Set(["issue", "run", "project", "label", "search", "pr list", "pr checks", "pr status", "pr diff", "repo view", "api"]);
// a shell around a listing: makes no commits; everything else (a script, bun, make…) may commit — not a listing
const LIST_SHELL = new Set(["cd", "pwd", "echo", "printf", "true", "set", "export", "read", "head", "tail", "grep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq", "wc", "cat", "ls", "column", "jq", "date"]);
// shell keywords (#142): before a command they're stripped, and the command itself is checked (an `if`/`while`
// condition too); a `for … in …` and `case … in` header isn't a command; closing ones are skipped
const SHELL_PREFIX = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
const SHELL_SKIP = new Set(["for", "case", "done", "fi", "esac", "}"]);

/**
 * The command is only a git and gh listing (with a shell around it): hashes in its output aren't anchors unless the
 * session made the commit itself.
 */
function gitListingOnly(cmd: string): boolean {
  if (/\bmutation\b/.test(cmd)) return false; // a GraphQL mutation may create a commit (createCommitOnBranch)
  let quotedSub = false;
  const bare = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => ((quotedSub ||= q[0] === '"' && /\$\(|`/.test(q)), "''"));
  if (quotedSub) return false; // "$(…)" — a command inside quotes is invisible to the parsing
  let list = false;
  const segs = bare.replace(/\d*[<>]+&?\s*[^\s;&|()]*/g, " ").replace(/\$\(|`/g, ";").split(/&&|\|\||[;|&\n()]/);
  for (const seg of segs) {
    const w = seg.trim().split(/\s+/).filter(Boolean);
    while (w.length && (SHELL_PREFIX.has(w[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!))) w.shift(); // VAR=… before the command
    if (!w.length || SHELL_SKIP.has(w[0]!)) continue;
    if (w[0] === "git") {
      let i = 1;
      while (i < w.length && w[i]!.startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
      if (!LIST_GIT.has(w[i] ?? "")) return false;
      list = true;
    } else if (w[0] === "gh") {
      if (!LIST_GH.has(w[1] ?? "") && !LIST_GH.has(`${w[1]} ${w[2]}`)) return false;
      if (w[1] === "api" && w.some((x) => /^(-X|--method)/.test(x))) return false; // PUT contents — a commit
      list = true;
    } else if (!LIST_SHELL.has(w[0]!)) return false;
  }
  return list;
}

/**
 * Listing hashes become anchors only if the same commit is in the session's own outputs (git commit, push, a script):
 * an own commit in `git log` extends the window, someone else's in `git worktree list` doesn't link. Then — by time.
 */
function finishCommits(acc: Acc): void {
  const own = new Map<string, string[]>();
  for (const [, h] of acc.commits) own.set(h.slice(0, 7), [...(own.get(h.slice(0, 7)) ?? []), h]);
  for (const c of acc.listed) if (hashMatches(c[1], own.get(c[1].slice(0, 7)) ?? [])) acc.commits.push(c);
  acc.commits.sort(byTs);
}

/**
 * Parse one jsonl (a session or its subagent) into the shared accumulator acc.
 *
 * Subagents (<sid>/subagents/**\/*.jsonl — Agent/Workflow) are part of the same session: their records go into the
 * timeline and give commit anchors, but the "human" prompts in them are assignments from the orchestrator, not from a
 * human, so n_human and the first prompt are taken only from the top level. On the other hand, a subagent's
 * assignment names the task ("Task #N (epic #M)", "#N" or an issue URL — taskHintIn): all records of that subagent
 * get the hint hint=N — this way the work of parallel subagents in a workflow is linked to their own tasks instead of
 * being split by commit order.
 */
function scanJsonl(file: string, acc: Acc, agent: number): void {
  scanRecords(jsonlRecords(file), acc, agent);
}

/**
 * The same from ready records: for a cloud session they're assembled from its events (parseCloudFile). agent — 0 for
 * the session itself, k for the k-th subagent: the number goes into the record, by it the actual computes task fan-out.
 */
function scanRecords(records: Iterable<Any>, acc: Acc, agent: number): void {
  const subagent = agent > 0;
  const commitToolIds = new Set<string>();
  const listingToolIds = new Set<string>();
  let hint = ""; // task hint for subagent records: "N" or "owner/repo#N"
  let hintDone = !subagent;
  let pending: string[] = []; // renames without a time: the time comes from the next record
  let lastTs: number | null = null;
  for (const r of records) {
    const t = r.type;
    const ts = r.timestamp ? parseTs(r.timestamp) : null;
    if (acc.cwd === null && r.cwd) acc.cwd = r.cwd;
    if (r.cwd && !acc.cwds.includes(r.cwd)) acc.cwds.push(r.cwd);
    if (t === "custom-title" && !subagent) {
      // the session name by the "#<number> <task name>" convention links records to the task from the moment of the
      // rename (the first one — from the session start); Claude Code writes it without a time
      // Claude Code repeats the record during the session — only a change of name opens a period
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
      // a PR number without a repository is ambiguous: each repository has its own numbers
      const prRepo = String(r.prRepository || /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(String(r.prUrl ?? ""))?.[1] || "");
      if (ts && Number.isInteger(pr)) acc.prlinks.push(prRepo ? [ts, pr, prRepo] : [ts, pr]);
      continue;
    }
    if (t !== "user" && t !== "assistant") continue;
    if (ts === null) continue;
    const human = !subagent && isHumanPrompt(r);
    if (human) acc.n_human++;
    const msg = r.message ?? {};
    const content = msg.content;
    if (!hintDone && t === "user") {
      // a subagent's first prompt is the assignment from the orchestrator
      const txt = textOfContent(content);
      if (txt.trim()) {
        hintDone = true;
        hint = taskHintIn(txt);
      }
    }
    // Tokens: usage is duplicated on every record of one response (per content block) —
    // count it once per message.id.
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
    acc.ev.push([ts, r.gitBranch || "", human ? 1 : 0, hint, uidx, agent]);
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
        if (typeof cmd === "string" && gitListingOnly(cmd)) listingToolIds.add(b.id);
      } else if (t === "user" && b.type === "tool_result") {
        // Hashes are taken from ANY tool_result, not only after `git commit`: a commit is often made by
        // a script (checks + commit + push), and the hash surfaces in its output. False anchors (old
        // hashes from git log) are cut off by ANCHOR_TOLERANCE — the hash must appear close in time to the
        // commit's authoredDate; fresh foreign ones from a git listing (neighbor worktrees) — by finishCommits.
        let txt = textOfContent(b.content);
        const tur = r.toolUseResult;
        if (tur && typeof tur === "object") txt += "\n" + String(tur.stdout ?? "") + "\n" + String(tur.stderr ?? "");
        if (!commitToolIds.has(b.tool_use_id) && !txt.includes("git") && txt.length > 20000) continue; // huge output without git — don't spend time on it
        collectHashes(listingToolIds.has(b.tool_use_id) ? acc.listed : acc.commits, ts, txt);
      }
    }
  }
  // a rename at the very end: there are no records after it
  for (const title of pending) acc.titles.push([lastTs === null ? 0 : lastTs + 1, title]);
}

/** A session's subagent transcripts: <dir>/<sid>/subagents/**\/*.jsonl. */
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

/** Compact summary of one session: the top-level jsonl + its subagents. */
export function parseSessionFile(file: string): Session {
  const acc = newAcc();
  scanJsonl(file, acc, 0);
  const subs = subagentFiles(file);
  for (const [k, sf] of subs.entries()) {
    try {
      scanJsonl(sf, acc, k + 1);
    } catch {
      continue;
    }
  }
  acc.ev.sort(byTs);
  acc.prlinks.sort(byTs);
  finishCommits(acc);
  return {
    sid: path.basename(file).slice(0, -6),
    cwd: acc.cwd,
    cwds: acc.cwds,
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

/** A shell command from Codex call arguments: `{"cmd": "…"}` or `{"command": ["bash", "-lc", "…"]}`. */
function codexCommand(args: unknown): string {
  let a: Any;
  try {
    a = typeof args === "string" ? JSON.parse(args) : args;
  } catch {
    return "";
  }
  const c = a && typeof a === "object" ? (a.command ?? a.cmd) : null;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const argv = c.map(String);
  return /^(ba|z)?sh$/.test(argv[0] ?? "") && /^-l?c$/.test(argv[1] ?? "") ? argv.slice(2).join(" ") : argv.join(" ");
}

function codexText(out: unknown): string {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return out.map((b) => (b && typeof b === "object" ? String((b as Any).text || "") : "")).join(" ");
  return String(out ?? "");
}

/**
 * Codex session summary (~/.codex/sessions/**\/rollout-*.jsonl) in the same format as Claude Code's.
 *
 * Records: session_meta (cwd, id), event_msg/item_completed with item.type=UserMessage — a human
 * prompt, response_item/{message,custom_tool_call,function_call,*_output} — the agent's work (commit
 * hashes are looked for in tool outputs), token_usage_record — the response's tokens (once per response_id),
 * turn_context / thread_settings_applied — the model. Records have no branch — it's considered neutral.
 */
export function parseCodexFile(file: string): Session {
  const acc = newAcc();
  let sid: string | null = null;
  let model: string | null = null;
  const commitCalls = new Set<string>();
  const listingCalls = new Set<string>();
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
      if (pt === "function_call" && gitListingOnly(codexCommand(inp))) listingCalls.add(p.call_id);
      acc.ev.push([ts, "", 0, "", -1]);
    } else if (pt === "custom_tool_call_output" || pt === "function_call_output") {
      const txt = codexText(p.output);
      acc.ev.push([ts, "", 0, "", -1]);
      if (!commitCalls.has(p.call_id) && !txt.includes("git") && txt.length > 20000) continue;
      collectHashes(listingCalls.has(p.call_id) ? acc.listed : acc.commits, ts, txt);
    }
  }
  acc.ev.sort(byTs);
  finishCommits(acc);
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


/** A cloud session export: what the browser snippet from SKILL.md saves (section "Cloud session"). */
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
 * Claude Code cloud session summary from its events (claude.ai/v1/code/sessions/<id>/events) in the same format as a
 * local one: assistant/user events are the same transcript records. A record has no branch — the `vcs_state_changed`
 * event brings it (on commit and push), before the first such event the branch is neutral; a human is
 * `source: client`; subagent responses (`parent_tool_use_id`) are a separate stream, like a local session's subagent
 * file. The session name comes from the export: "#N …" links, as for a local one.
 */
export function parseCloudFile(file: string): Session {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!isCloudExport(data)) throw new EstError(`${file}: not a cloud session export (needs session, repo, events)`);
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
    // the cloud reports the branch only on commit — a switch to another branch is visible in git output
    if (e.event_type === "user") branch = gitBranchIn(textOfContent(p.message?.content) + "\n" + String(p.tool_use_result?.stdout ?? "")) ?? branch;
  }
  const acc = newAcc();
  scanRecords(top, acc, 0);
  for (const [k, recs] of [...subs.values()].entries()) scanRecords(recs, acc, k + 1);
  acc.ev.sort(byTs);
  finishCommits(acc);
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

/** The last branch git switched to in this output: `Switched to branch 'x'` or a commit line `[x abc1234]`. */
function gitBranchIn(txt: string): string | null {
  let last: string | null = null;
  for (const m of txt.matchAll(/Switched to (?:a new )?branch '([^']+)'|^\[([^\s\]]+)(?: \(root-commit\))? [0-9a-f]{7,40}\]/gm)) last = m[1] ?? m[2] ?? last;
  return last;
}

/**
 * Session key in the "Actual" marker (iv) and in output — 8 chars of the id: for a local one — the UUID start, for a
 * cloud one — after the `session_` prefix shared by all cloud ones (otherwise their intervals would merge into one
 * key).
 */
export const sidKey = (sid: string) => sid.replace(/^session_/, "").slice(0, 8);

/** Path of a cloud session export in the state directory: by repository, the file is the session id. */
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

/** cwd from the first session_meta record. */
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

/**
 * A session belongs to the repository if at least one of its records was made in its directory (or a worktree
 * inside): sessions are also started outside the project and then moved into it. A cloud one — by the export
 * directory, not by the container's cwd.
 */
export function inRepo(s: Session, paths: string[]): boolean {
  if (s.source === "cloud") return true;
  const cwds = s.cwds?.length ? s.cwds : [s.cwd];
  return cwds.some((c) => cwdMatches(c, paths));
}

function cwdMatches(cwd: string | null | undefined, paths: string[]): boolean {
  if (!cwd) return true; // unknown — don't discard
  return paths.some((p) => cwd === p || cwd.startsWith(p.replace(/\/+$/, "") + "/"));
}

/** Codex sessions whose cwd is a repository path; the cwd index is cached by file mtime. */
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

/** Session mtime including subagents (their files are appended later than the top level). */
function sessionMtime(file: string): number {
  let m = mtimeOf(file);
  for (const sf of subagentFiles(file)) {
    try {
      m = Math.max(m, mtimeOf(sf));
    } catch {
      /* the file is gone — doesn't matter */
    }
  }
  return m;
}

function transcriptFiles(repo: Repo): string[] {
  return transcriptFilesIn(repo.paths);
}

/** Claude Code transcripts by work directory: ~/.claude/projects/<path-with-dashes>*\/*.jsonl. */
function transcriptFilesIn(paths: string[], projectsDir = PROJECTS_DIR): string[] {
  const encs = paths.map(encodePath);
  return transcriptFilesWhere((d) => encs.some((e) => d.startsWith(e)), projectsDir);
}

/** Claude Code transcripts in ~/.claude/projects directories whose name fits match. */
function transcriptFilesWhere(match: (dir: string) => boolean, projectsDir = PROJECTS_DIR): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir).filter(match);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const fn of names) if (fn.endsWith(".jsonl")) files.push(path.join(projectsDir, d, fn));
  }
  return uniqSortedStrs(files);
}

/**
 * Transcript directory of the Claude app's temp folder (`…/Claude/scratch-workspaces/…`): a session without a chosen
 * folder works there. Having moved into a repository (change_directory), it keeps writing its transcript there until
 * the app moves it into the repository's directory — already after the task is closed.
 */
const isScratchDir = (dir: string) => dir.includes("-scratch-workspaces-");

/**
 * Repository name `owner/name` in text: in a URL, a pr-link, `git push` output (`…/owner/name.git`), but not as part
 * of another name.
 */
const slugRe = (slug: string) => new RegExp(`(?<![\\w.-])${reEscape(slug)}(?![\\w-]|\\.(?!git\\b)[\\w-])`, "i");

/**
 * Guest sessions: transcripts from other registry repositories' directories and the app's temp folders in which (or
 * in whose subagents) the task repository's name occurs — a conversation in one repository grew into a task of
 * another, a session without a folder moved into the task's repository. Without the repository's name there's no work
 * on its task there: a commit, push, PR and issue URL name it. The index is by mtime (indexFile), the text is read
 * once.
 */
export function guestTranscripts(slug: string, ownPaths: string[], otherPaths: string[], projectsDir = PROJECTS_DIR, indexFile?: string): string[] {
  const own = new Set(transcriptFilesIn(ownPaths, projectsDir));
  const re = slugRe(slug);
  const idx = indexFile ? loadJson<Record<string, { mtime: number; hit: boolean }>>(indexFile, {}) : {};
  let changed = false;
  const out: string[] = [];
  for (const f of uniqSortedStrs(transcriptFilesIn(otherPaths, projectsDir).concat(transcriptFilesWhere(isScratchDir, projectsDir)))) {
    if (own.has(f)) continue;
    let m: number;
    try {
      m = sessionMtime(f);
    } catch {
      continue;
    }
    let c = idx[f];
    if (!c || !sameMtime(c.mtime, m)) {
      const hit = [f, ...subagentFiles(f)].some((x) => {
        try {
          return re.test(readFileSync(x, "utf8"));
        } catch {
          return false;
        }
      });
      c = { mtime: m, hit };
      idx[f] = c;
      changed = true;
    }
    if (c.hit) out.push(f);
  }
  if (indexFile && changed) saveJson(indexFile, idx);
  return out;
}

const PIN_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

/**
 * Session pinning to tasks: the file is the session id, the line in it is the task `owner/repo#N`; anything else
 * (`.gitignore`) is skipped.
 */
export function loadPins(dir = PINS_DIR): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sid of names) {
    if (sid.startsWith(".")) continue;
    let task: string;
    try {
      task = readFileSync(path.join(dir, sid), "utf8").trim();
    } catch {
      continue;
    }
    if (PIN_RE.test(task)) out.set(sid, task);
  }
  return out;
}

/**
 * Transcripts of sessions pinned to the repository's tasks — in any ~/.claude/projects directory: a pin names the
 * session by id, and the id is its transcript's file name. A session started outside registry directories is found
 * too.
 */
export function pinnedTranscripts(slug: string, pins: Map<string, string>, projectsDir = PROJECTS_DIR): string[] {
  const prefix = slug.toLowerCase() + "#";
  const sids = new Set([...pins].filter(([, task]) => task.toLowerCase().startsWith(prefix)).map(([sid]) => sid));
  return sids.size ? transcriptFilesWhere(() => true, projectsDir).filter((f) => sids.has(path.basename(f, ".jsonl"))) : [];
}

/**
 * The repository's sessions from parsed transcripts: from its directories, guests and those pinned to its tasks. A
 * pinned one isn't discarded as a routine (few prompts, no PR or commits) and isn't marked a guest: `task status` named
 * its task.
 */
export function selectSessions(parsed: Record<string, Session>, paths: string[], guests: Set<string>, pinned: Set<string>): Session[] {
  const sessions: Session[] = [];
  for (const [f, s] of Object.entries(parsed)) {
    if (!s.ev.length) continue;
    if (pinned.has(f)) sessions.push(s);
    else if (s.routine) continue;
    else if (inRepo(s, paths)) sessions.push(s);
    else if (guests.has(f)) sessions.push({ ...s, guest: true });
  }
  return sessions;
}

/**
 * Sessions for a period summary: all from the repository's directories — including short ones without commits and
 * PRs, which the actual discards as routines — and those pinned to its tasks. No guests: their work is in their own
 * repository, here it's only a mention.
 */
export function selectPeriodSessions(parsed: Record<string, Session>, paths: string[], pinned: Set<string>): Session[] {
  return Object.entries(parsed)
    .filter(([f, s]) => s.ev.length && (pinned.has(f) || inRepo(s, paths)))
    .map(([, s]) => s);
}

/** The repository's parsed transcripts by file, and which of them are guests and pinned. */
interface Parsed {
  all: Record<string, Session>;
  guests: Set<string>;
  pinned: Set<string>;
}

/** Transcript parsing with an mtime cache (incremental). */
function loadSessions(repo: Repo): Parsed {
  if (!repo.paths.length) throw new EstError(`no local paths for ${repo.full} in ${REGISTRY_PATH} — nowhere to look for transcripts`);
  const file = path.join(repo.cacheDir, "sessions.json");
  const cache = loadJson<Record<string, Session>>(file, {});
  const out: Record<string, Session> = {};
  let changed = false;
  const guests = new Set(guestTranscripts(repo.full, repo.paths, repo.otherPaths, PROJECTS_DIR, path.join(repo.cacheDir, "guest-index.json")));
  const pinned = new Set(pinnedTranscripts(repo.full, repo.pins()));
  const files = uniqSortedStrs(transcriptFiles(repo).concat([...guests], [...pinned])).concat(codexFiles(repo), cloudFiles(repo));
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
      console.error(`skipped ${f}: ${(e as Error).message}`);
      continue;
    }
    s.mtime = mtime;
    s.v = SESSION_CACHE_V;
    out[f] = s;
    changed = true;
  }
  const same = Object.keys(cache).length === Object.keys(out).length && Object.keys(cache).every((k) => k in out);
  if (changed || !same) saveJson(file, out);
  return { all: out, guests, pinned };
}

// ----------------------------------------------------------------------------
// Linking a task to PRs/commits
// ----------------------------------------------------------------------------

/** Task branch by the canon — `[<area>/]<type>/<N>-<slug>`: type (lowercase) and number, otherwise null. */
export function taskBranch(branch: string | null | undefined): { type: string; issue: number } | null {
  const m = BRANCH_CONV_RE.exec(branch || "");
  return m ? { type: m[1]!.toLowerCase(), issue: parseInt(m[2]!, 10) } : null;
}

const branchTokens = (branch: string | null | undefined) => (branch || "").split(/[/_\-.]+/).filter(Boolean);
const isDigits = (s: string) => /^\d+$/.test(s);

/**
 * A branch by the <type>/N-slug convention — task N and only it: a number in the slug (a response code, a version)
 * isn't the number. Otherwise — the number as a separate token (issue-N-…, /N-…, -N-…), neighboring tokens not purely
 * numeric (so that dates like 2026-09-16 aren't caught).
 */
export function branchHasIssue(branch: string | null | undefined, n: number): boolean {
  const conv = taskBranch(branch);
  if (conv) return conv.issue === n;
  const toks = branchTokens(branch);
  const sn = String(n);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const prev = i > 0 ? toks[i - 1]! : "";
    const nxt = i + 1 < toks.length ? toks[i + 1]! : "";
    if ([`issue${sn}`, `issues${sn}`, `gh${sn}`].includes(t.toLowerCase())) return true;
    if (t === sn) {
      if (isDigits(prev) || isDigits(nxt)) continue;
      if (n < 10 && !["issue", "issues", "gh"].includes(prev.toLowerCase())) continue; // single-digit numbers — only with an explicit issue-N
      return true;
    }
  }
  return false;
}

/**
 * Task number from a branch: <type>/N-slug (convention) or issue-N / issues/N.
 * Bare numbers elsewhere (release/2026-09) aren't counted as a number.
 */
export function branchIssueNumber(branch: string | null | undefined): number | null {
  const conv = taskBranch(branch);
  if (conv) return conv.issue;
  const m2 = /(?:^|[/_-])issues?[/_-]?(\d{1,6})(?:$|[/_-])/i.exec(branch || "");
  return m2 ? parseInt(m2[1]!, 10) : null;
}

/** Task type from a <type>/N-slug branch, if the branch follows the convention. */
export function branchType(branch: string | null | undefined): string | null {
  return taskBranch(branch)?.type ?? null;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (pick: (n: Names) => string) => locale.every(pick).flatMap((s) => s.split(" "));
const CLOSING_WORDS = words((n) => n.est.closingWords).map(locale.escapeRe).join("|");

function closingRe(repo: Pick<Repo, "owner" | "name">, n: number): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${CLOSING_WORDS})` +
      `[\\s:]*(?:#|https://github\\.com/${reEscape(repo.owner)}/${reEscape(repo.name)}/issues/)${n}(?!\\d)`,
    "iu",
  );
}

function fetchIssue(repo: Repo, number: number): Any {
  const q = `
    query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){
      id number title body state stateReason closedAt createdAt url
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
    if (e instanceof EstError && errIs(e, "Could not resolve to an Issue")) throw new NotAnIssue(`#${number} is not an issue in ${repo.full}`);
    throw e;
  }
  const issue = data.repository.issue;
  if (!issue) throw new EstError(`issue #${number} not found in ${repo.full}`);
  // close events — into the common timeline list (fact/est markers are looked for in the last 100 comments)
  issue.timelineItems.nodes.push(...(issue.closedEvents?.nodes ?? []));
  return issue;
}

interface IssueFields {
  item_id: string | null;
  est: number | null;
  fact: number | null;
  status: string | null;
}

/** Project field values for an issue (item_id, est, fact, status). */
function issueProjectFields(issue: Any, meta: Meta): IssueFields {
  for (const it of issue.projectItems?.nodes ?? []) {
    if (it.project.id !== meta.id) continue;
    const vals: IssueFields = { item_id: it.id, est: null, fact: null, status: null };
    for (const fv of it.fieldValues.nodes) {
      const key = fieldKey(fv.field?.name);
      if (key === FIELD_EST) vals.est = fv.number ?? null;
      else if (key === FIELD_FACT) vals.fact = fv.number ?? null;
      else if (key === FIELD_STATUS) vals.status = fv.name ?? null;
    }
    return vals;
  }
  return { item_id: null, est: null, fact: null, status: null };
}

type Closer = { oid: string; at: number | null };

/** What PR linking needs from a repository: the name, the PR cache and a PR by number. */
type LinkRepo = Pick<Repo, "full" | "owner" | "name" | "prs" | "pr">;

/** Issue → PRs (strong and weak links) and closing commits. */
export function resolveLinks(repo: LinkRepo, issue: Any): [PR[], Closer[], boolean] {
  const n: number = issue.number;
  const same = (o: Any) => (o?.repository?.nameWithOwner ?? repo.full) === repo.full;
  const strong = new Map<number, string>();
  const weak = new Map<number, string>();
  let closers: Closer[] = [];
  const add = (d: Map<number, string>, num: number | undefined, why: string) => {
    if (num && num !== n && !d.has(num)) d.set(num, why);
  };

  for (const p of issue.closedByPullRequestsReferences.nodes) if (same(p)) add(strong, p.number, "closed the issue");
  for (const t of issue.timelineItems.nodes) {
    const tn = t.__typename;
    if (tn === "CrossReferencedEvent") {
      const s = t.source ?? {};
      if (s.__typename === "PullRequest" && same(s)) add(weak, s.number, "mention");
    } else if (tn === "ConnectedEvent") {
      const s = t.subject ?? {};
      if (s.__typename === "PullRequest" && same(s)) add(strong, s.number, "linked by hand");
    } else if (tn === "ClosedEvent") {
      const c = t.closer ?? {};
      if (c.__typename === "PullRequest" && same(c)) add(strong, c.number, "closed the issue");
      else if (c.__typename === "Commit") closers.push({ oid: c.oid, at: parseTs(c.authoredDate) });
    }
  }

  const prs = repo.prs();
  const crx = closingRe(repo, n);
  const mention = new RegExp(`(?<![\\p{L}\\p{N}_/])#${n}(?!\\d)`, "u");
  const closerOids = new Set(closers.map((c) => c.oid));
  for (const [num, p] of prs) {
    if (p.closing.includes(n)) add(strong, num, "closingIssuesReferences");
    else if (p.mergeCommit && closerOids.has(p.mergeCommit)) add(strong, num, "the merge commit closed the issue");
    else if (p.commits.some((c) => closerOids.has(c.oid))) add(strong, num, "a PR commit closed the issue");
    else if (crx.test(p.body)) add(strong, num, `Closes #${n} in the PR body`);
    else if (branchHasIssue(p.headRefName, n)) add(strong, num, "number in the branch");
    else if (mention.test(p.body)) add(weak, num, "mention in the PR body");
  }
  for (const num of strong.keys()) weak.delete(num);
  // A mention in a PR that closes other tasks is someone else's work: otherwise a task without its own PR gets its
  // time (with splitting, though that task's actual is already recorded) and the type from its branch.
  for (const num of [...weak.keys()]) {
    const p = repo.pr(num);
    if (p && p.closing.length && !p.closing.includes(n)) weak.delete(num);
  }
  // Weak links are used only if there are no strong ones
  const [use, weakUsed] = strong.size ? [strong, false] : [weak, weak.size > 0];
  const prObjs: PR[] = [];
  for (const [num, why] of [...use.entries()].sort((a, b) => a[0] - b[0])) {
    const p = repo.pr(num);
    if (p) prObjs.push({ ...p, why });
  }
  // closing commits that belong to none of the found PRs
  const prOids = new Set<string>();
  for (const p of prObjs) {
    for (const c of p.commits) prOids.add(c.oid);
    if (p.mergeCommit) prOids.add(p.mergeCommit);
  }
  closers = closers.filter((c) => !prOids.has(c.oid));
  return [prObjs, closers, weakUsed];
}

// ----------------------------------------------------------------------------
// Computing the actual from transcripts
// ----------------------------------------------------------------------------

function diffSize(pr: PR): number {
  if (pr.files.length && pr.files.length >= Math.min(pr.changedFiles, 100)) {
    return pr.files.filter((f) => !DIFF_EXCLUDE.test(f.path)).reduce((s, f) => s + f.a + f.d, 0);
  }
  return pr.additions + pr.deletions;
}

const ANCHOR_TOLERANCE = 30 * 60; // a hash in tool output must be close in time to the commit's authoredDate

/** Index: the first 7 chars of an oid → [(oid, pr_number, authoredDate)] for prefix checks. */
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

/** Short hash h is a prefix of one of oids (or vice versa). */
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
  agents?: number; // subagents whose work is linked to the task (fan-out); absent — the actual predates the feature
  steps?: number; // task turns — model responses, one per message.id, subagents included; absent — the actual
  // predates the feature
  steps_agents?: number; // of them, subagents'
  tail?: number; // turns with context larger than TAIL_CTX — the most expensive
  preamble?: number; // context of the first top-level turn of the earliest session — the price of rules and tools
  ctx_end?: number; // context of the last top-level turn of the latest session
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
  iv?: Record<string, [number, number][]>; // intervals by session (sid, 8 chars) — into the "Actual" marker
  taken?: { issue: number; h: number }[]; // not counted: already in another task's recorded actual
  overlap?: { issue: number; h: number }[]; // counted (pinning, branch, subagent, commit), but also in someone else's actual
  cloud_missing?: string[]; // cloud sessions from the PR commits' trailer whose export is missing (est cloud-import)
  cloud_parts?: CloudPart[]; // parts computed by cloud sessions (the cloud marker) — kept in the marker on rewrite
}

type Anchor = [number, string, string, number]; // (ts, own|foreign, pr|commit, share)

/**
 * Time window for linking: [a, z] (z exclusive if zOpen), only branch br (null — any one that isn't foreign)
 * or a neutral one; rule — "anchor" (own PR/commit) or "title" / "prompt" (the task is named in the session
 * name or in the first prompt — a weak link: it yields to an already recorded actual of another task).
 */
interface Win {
  a: number;
  z: number;
  zOpen: boolean;
  br: string | null;
  w: number;
  rule: string;
}

export function computeFact(repo: FactRepo, number: number, prObjs: PR[], closers: Closer[], gapMin = 30, parts: CloudPart[] = []): Fact {
  const prsAll = repo.prs();
  const openPrs = repo.openPrs().items;
  const cidx = repo.closers();
  const sessions = repo.sessions();
  const neutral = repo.neutralBranches();
  const pins = repo.pins?.() ?? new Map<string, string>();
  const gap = gapMin * 60.0;

  const ourPrs = new Set(prObjs.map((p) => p.number));

  // --- the task's "units" (PR, closing commit) and their share: one PR/commit for k tasks → 1/k ----------
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
  const ourBranches = new Map<string, number>(); // branch → share
  for (const p of prObjs) {
    if (p.headRefName) ourBranches.set(p.headRefName, Math.max(ourBranches.get(p.headRefName) ?? 0, prW.get(p.number)!));
  }
  for (const p of Object.values(openPrs)) {
    if (p.closing.includes(number) && p.headRefName && !ourBranches.has(p.headRefName)) ourBranches.set(p.headRefName, 1.0);
  }
  const ourOid = new Map<string, [number | null, number]>(); // oid → (authoredDate, share)
  for (const p of prObjs) for (const c of p.commits) ourOid.set(c.oid, [c.at, prW.get(p.number)!]);
  for (const c of closers) {
    const iss = issuesOfOid(c.oid);
    ourOid.set(c.oid, [c.at, 1.0 / iss.size]);
    if (iss.size > 1) shared.push({ unit: locale.fill(projectNames().est.fact.commitUnit, { oid: c.oid.slice(0, 7) }), with: others(iss), k: iss.size });
  }

  const idx = oidIndex(prsAll); // commits of merged PRs (foreign anchors)
  const foreignClosers = new Map<string, [string, number | null][]>(); // closing commits of other issues: prefix → [(oid, at)]
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
      branch2prs.get(p.headRefName)!.add(-Number(num)); // an open PR: definitely not ours
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
   * (own/foreign/neutral, share); a hash is an anchor only close in time to the commit date
   * (git commit output can also contain foreign hashes — from git log, rebase etc.).
   */
  const hashClass = (h: string, ts: number): [string, number] => {
    for (const [oid, [at, w]] of ourOid) if ((oid.startsWith(h) || h.startsWith(oid)) && near(ts, at)) return ["own", w];
    for (const [oid, num, at] of idx.get(h.slice(0, 7)) ?? []) if ((oid.startsWith(h) || h.startsWith(oid)) && !ourPrs.has(num) && near(ts, at)) return ["foreign", 0.0];
    for (const [oid, at] of foreignClosers.get(h.slice(0, 7)) ?? []) if ((oid.startsWith(h) || h.startsWith(oid)) && near(ts, at)) return ["foreign", 0.0];
    return ["neutral", 0.0];
  };

  const intervals: [number, number][] = []; // (a, b) without weight — for the union across sessions
  const tok = { in: 0.0, out: 0.0, cw: 0.0, cr: 0.0 }; // tokens of linked responses (with share)
  const byModel = new Map<string, { tok: number; usd: number; priced: boolean }>();
  const seenMids = new Set<string>();
  let rawTotal = 0.0;
  let weightedTotal = 0.0;
  const seenPrs = new Set<number>();
  const seenBranches = new Set<string>();
  const seenHashes = new Set<string>();
  let nSessions = 0;
  let nPrompts = 0;
  let nAgents = 0; // subagents whose work is linked to the task: a fan-out signal
  // turns — model responses, one per message.id; a task's price grows quadratically with their number
  let steps = 0;
  let stepsAgents = 0;
  let tail = 0;
  let preamble: number | null = null;
  let preAt: number | null = null;
  let ctxEnd: number | null = null;
  let endAt: number | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const details: Detail[] = [];
  const iv: Record<string, [number, number][]> = {};
  const takenS = new Map<number, number>(); // task → seconds given to its recorded actual
  const overlapS = new Map<number, number>();
  const recorded = repo.recorded?.() ?? new Map();
  const sharedWith = new Set(shared.flatMap((x) => x.with)); // a shared PR/commit: an overlap is a share, not an error
  const ourKey = `${repo.full}#${number}`;
  const cmpAnchor = (a: Anchor, b: Anchor) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) || a[3] - b[3];

  const sameRepo = (r: string) => r.toLowerCase() === repo.full.toLowerCase();
  const urlRefs = (urls: string[]) => urls.filter((u) => u.startsWith(repo.full + "#")).map((u) => parseInt(u.split("#")[1]!, 10));

  for (const s of sessions) {
    const ev = s.ev;
    if (!ev.length) continue;
    // A pinned session (github task status) goes whole to the task from the pin, with subagents (they have the same id)
    // and with the time before "In progress": it doesn't need the features below, foreign hashes, branches and numbers
    // in its outputs don't take the time away. Pinned to another task — not ours, whatever features of this one it
    // has. Without a pin — features.
    const pin = pins.get(s.sid);
    if (pin !== undefined && pin.toLowerCase() !== ourKey.toLowerCase()) continue;
    const pinned = pin !== undefined;
    // A guest is a transcript from another repository's directory: task numbers and branches there are its own. Its
    // branch is ours only if it's exactly our PR's branch; foreign — only if it's the branch of a foreign PR of our
    // repository.
    const guest = !!s.guest;
    const ourBr = (b: string) => (guest ? !!b && ourBranches.has(b) : isOurBranch(b));
    const foreignBr = (b: string) => {
      if (!guest) return isForeignBranch(b);
      const nums = b && !isNeutral(b) && !ourBranches.has(b) ? branch2prs.get(b) : undefined;
      return !!nums?.size && ![...nums].some((x) => ourPrs.has(x));
    };
    // a guest's pr-link without a repository is ambiguous; with our repository — ours, with another — neither ours nor
    // foreign
    const links = s.prlinks.filter(([, , r]) => (r ? sameRepo(r) : !guest));
    const anchors: Anchor[] = [];
    for (const [ts, pr] of links) {
      const own = ourPrs.has(pr);
      // Claude Code repeats the pr-link of the PR bound to the session even after the merge — that's the app's status,
      // not work: after the merge it's an anchor neither for its own task (otherwise it would take the time of the
      // following ones) nor for someone else's (otherwise it would cut off the window of the next task the session
      // was renamed for)
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
    // a guest is linked only by a feature of our repository; a number in the name — only together with it
    if (
      guest &&
      !pinned &&
      !anchors.some((a) => a[1] === "own") &&
      !ev.some((e) => ourBranches.has(e[1]) || e[3] === ourKey) &&
      !urlRefs(s.first_urls ?? []).includes(number) &&
      !(s.title_hist ?? []).some(([, t]) => urlRefs(urlsIn(t)).includes(number))
    ) {
      continue;
    }
    for (const [, pr] of links) seenPrs.add(pr);
    for (const e of ev) if (e[1]) seenBranches.add(e[1]);
    const foreignTs = anchors.filter((a) => a[1] === "foreign").map((a) => a[0]);

    // windows by anchors: from the previous foreign anchor to our own; inside a window only records
    // on the anchor's branch or on a neutral branch (HEAD/empty/main…) count — foreign branches don't.
    // A session rename is a boundary too: before it, the session worked on the task from the previous name.
    const renames = [...(s.title_hist ?? [])].map((t) => t[0]).sort((x, y) => x - y).slice(1); // the first one — from the session start
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
        // the tail after a pr-link: while the branch is the same and there's no foreign anchor (fixes after review)
        const later = [...foreignTs, ...renames].filter((t) => t > ts);
        const nxtForeign = later.length ? Math.min(...later) : 1e18;
        for (const e of ev) {
          if (e[0] <= ts) continue;
          if (e[0] >= nxtForeign || e[1] !== brAt) break;
          end = e[0];
        }
      }
      windows.push({ a: start, z: end, zOpen: false, br: brAt, w, rule: "anchor" });
    }
    // The task is named in the session name or in the first prompt. A name applies from the moment of the rename
    // (the first one — from the session start): a session renamed for each next task gives the records of a
    // numberless branch to the task under whose name they were made, not to the last one. A name without a
    // number — the first prompt decides; no name — the first prompt for the whole session.
    const promptRefs = new Set<number>([...s.first_refs, ...urlRefs(s.first_urls ?? [])]);
    const titleRefs = (title: string) => new Set<number>([...refsIn(title), ...urlRefs(urlsIn(title))]);
    let hist: [number, Set<number>][] = [...(s.title_hist ?? [])].sort((x, y) => x[0] - y[0]).map(([t, title]) => [t, titleRefs(title)]);
    if (!hist.length && s.title) hist = [[-1e18, titleRefs(s.title)]];
    const segs: { a: number; z: number; refs: Set<number>; rule: string }[] = hist.length
      ? hist.map(([t, refs], k) => ({ a: k ? t : -1e18, z: k + 1 < hist.length ? hist[k + 1]![0] : 1e18, refs: refs.size ? refs : promptRefs, rule: refs.size ? "title" : "prompt" }))
      : [{ a: -1e18, z: 1e18, refs: promptRefs, rule: "prompt" }];
    for (const seg of segs) {
      if (!(seg.refs.size === 1 && seg.refs.has(number))) continue;
      // in the period — a PR of another repository: "#N" in the name is the number of its task, not ours
      if (s.prlinks.some(([t, , r]) => !!r && !sameRepo(r) && t >= seg.a && t < seg.z)) continue;
      // to the end of the period, the first foreign anchor in it or the first switch to a branch that is neither ours
      // nor neutral (the period's starting branch is allowed if it isn't foreign — the task was done on it)
      const later = foreignTs.filter((t) => t >= seg.a);
      let end = Math.min(seg.z, later.length ? Math.min(...later) : 1e18);
      let zOpen = end === seg.z && seg.z < 1e18; // a record at the moment of a rename already belongs to the next task
      let startBranch: string | null = null;
      for (const e of ev) {
        if (e[0] < seg.a) continue;
        if (e[0] >= end) break;
        const b: string = e[1];
        if (isNeutral(b) || ourBr(b)) continue;
        if (foreignBr(b) || (startBranch !== null && b !== startBranch)) {
          end = e[0];
          zOpen = false;
          break;
        }
        startBranch = b;
      }
      windows.push({ a: seg.a, z: end, zOpen, br: null, w: 1.0, rule: seg.rule });
    }

    const attributed: number[] = []; // share (0 — not our record)
    const weak: string[] = []; // weak link rule ("title" / "prompt") or ""
    const rules: Record<string, number> = {};
    for (const e of ev) {
      if (pinned) {
        attributed.push(1.0);
        weak.push("");
        rules["pin"] = (rules["pin"] ?? 0) + 1;
        continue;
      }
      const [ts, b] = [e[0] as number, e[1] as string];
      const hint: string = e.length > 3 ? e[3] : "";
      let w = 0.0;
      let weakRule = "";
      if (hint) {
        // a record of a subagent whose assignment names the task: ours — whole,
        // someone else's — not ours, whatever branches/windows there are
        if (hint === String(number) || hint === ourKey) {
          w = 1.0;
          rules["subagent"] = (rules["subagent"] ?? 0) + 1;
        }
        attributed.push(w);
        weak.push("");
        continue;
      }
      if (ourBr(b)) {
        w = branchW(b);
        rules["branch"] = (rules["branch"] ?? 0) + 1;
      } else if (windows.length && !foreignBr(b)) {
        const ws = windows.filter((x) => x.a <= ts && (x.zOpen ? ts < x.z : ts <= x.z) && (x.br === null || b === x.br || isNeutral(b)));
        if (ws.length) {
          w = Math.max(...ws.map((x) => x.w));
          const anchored = ws.some((x) => x.rule === "anchor");
          const rule = anchored ? "anchor" : ws[0]!.rule;
          rules[rule] = (rules[rule] ?? 0) + 1;
          if (!anchored) weakRule = rule;
        }
      }
      attributed.push(w);
      weak.push(weakRule);
    }
    // A record already counted in a recorded actual of another task of this session (the marker stores intervals):
    // linked only by the name or the first prompt — not counted again; linked by pinning,
    // a branch, a subagent or its own commit — stays, but the overlap is printed (the other actual is probably wrong).
    const sid8 = sidKey(s.sid);
    const others: [number, [number, number][]][] = [];
    for (const [n, bySid] of recorded) if (n !== number && bySid[sid8]?.length) others.push([n, bySid[sid8]]);
    if (others.length) {
      const orig = [...attributed];
      for (let i = 0; i < ev.length; i++) {
        if (!orig[i]) continue;
        const t = ev[i]![0] as number;
        const pair = i > 0 && t - ev[i - 1]![0] <= gap && (orig[i - 1]! > 0 || !!ev[i - 1]![2]);
        const x = pair ? (ev[i - 1]![0] + t) / 2 : t; // a record's interval — by the midpoint, a single one — by time
        const tol = pair ? 0 : 1; // marker boundaries are rounded to a second
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
    // the interval to the previous record counts only if that one is ours too
    // or it's the human prompt our segment started with
    let sessRaw = 0.0;
    let sessW = 0.0;
    let prompts = 0;
    let sFirst: number | null = null;
    let sLast: number | null = null;
    const brs: Record<string, number> = {};
    const sessIv: [number, number][] = [];
    const sessAgents = new Set<number>();
    const sessUsage: [Any[], number, boolean][] = []; // (usage record, share, whether a subagent) for linked model responses
    const sUsage = s.usage ?? [];
    const sModels = s.models ?? [];
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      const [ts, b, human] = [e[0] as number, e[1] as string, e[2] as number];
      const w = attributed[i]!;
      if (human && !w && i + 1 < ev.length && attributed[i + 1]! && ev[i + 1]![0] - ts <= gap) prompts++;
      if (!w) continue;
      if (e.length > 4 && e[4] >= 0 && e[4] < sUsage.length) sessUsage.push([sUsage[e[4]]!, w, e[5] > 0]);
      if (e[5] > 0) sessAgents.add(e[5]);
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
    if (sessRaw < 60 && prompts === 0) continue; // less than a minute and no prompts (a random hash in output) — not counted as a session
    if (sessIv.length) iv[sid8] = mergeIntervals([...(iv[sid8] ?? []), ...sessIv]).map(([a, b]) => [Math.floor(a), Math.ceil(b)]);
    nSessions++;
    nPrompts += prompts;
    nAgents += sessAgents.size;
    rawTotal += sessRaw;
    weightedTotal += sessW;
    let sFirstTop: number | null = null; // context of the session's first and last top-level turns
    let sLastTop: number | null = null;
    for (const [u, w, sub] of sessUsage) {
      if (seenMids.has(u[0])) continue; // a resumed session copies the history — don't count twice
      seenMids.add(u[0]);
      const model: string = u[1] < sModels.length ? sModels[u[1]]! : "?";
      const vals: [number, number, number, number, number] = [u[2], u[3], u[4], u[5], u[6]];
      // a turn is whole for each task, only tokens are split by a shared PR's share
      const ctx = vals[0] + vals[2] + vals[3] + vals[4];
      steps++;
      if (sub) stepsAgents++;
      else {
        if (sFirstTop === null) sFirstTop = ctx;
        sLastTop = ctx;
      }
      if (ctx > TAIL_CTX) tail++;
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
    if (sFirstTop !== null && (preAt === null || sFirst! < preAt)) (preAt = sFirst!), (preamble = sFirstTop);
    if (sLastTop !== null && (endAt === null || sLast! > endAt)) (endAt = sLast!), (ctxEnd = sLastTop);
    const branches: Record<string, number> = {};
    for (const [k, v] of Object.entries(brs).sort((a, b) => b[1] - a[1])) branches[k] = round2(v);
    details.push({ sid: s.sid, src: s.source ?? "claude", start: sFirst!, hours: round2(sessW / 3600), prompts, rules, branches });
  }

  // Cloud parts (computed by the cloud session itself) — as one more session; a session with an imported export
  // is counted from the export, its part isn't.
  const known = new Set(sessions.map((s) => s.sid));
  const partsUsed = parts.filter((p) => !known.has(p.session) && p.h > 0);
  for (const p of partsUsed) {
    const piv: [number, number][] = (p.iv ?? []).map(([a, b]) => [a, b]);
    intervals.push(...piv);
    rawTotal += piv.reduce((acc, [a, b]) => acc + (b - a), 0);
    weightedTotal += p.h * 3600;
    iv[sidKey(p.session)] = piv;
    nSessions++;
    nPrompts += p.prompts || 0;
    nAgents += p.agents || 0;
    if (p.tok) {
      tok.in += p.tok.in || 0;
      tok.out += p.tok.out || 0;
      tok.cw += p.tok.cw || 0;
      tok.cr += p.tok.cr || 0;
    }
    for (const [model, m] of Object.entries(p.models ?? {})) {
      if (!byModel.has(model)) byModel.set(model, { tok: 0.0, usd: 0.0, priced: true });
      const bm = byModel.get(model)!;
      bm.tok += (m.mtok || 0) * 1e6;
      if (m.usd === null) bm.priced = false;
      else bm.usd += m.usd;
    }
    const pFirst = piv.length ? Math.min(...piv.map((x) => x[0])) : null;
    const pLast = piv.length ? Math.max(...piv.map((x) => x[1])) : null;
    if (pFirst !== null) firstTs = firstTs === null ? pFirst : Math.min(firstTs, pFirst);
    if (pLast !== null) lastTs = lastTs === null ? pLast : Math.max(lastTs, pLast);
    // turns and tail add up, preamble — from the earliest part or session, context at the end — from the latest
    steps += p.steps || 0;
    stepsAgents += p.steps_agents || 0;
    tail += p.tail || 0;
    if (p.preamble !== undefined && pFirst !== null && (preAt === null || pFirst < preAt)) (preAt = pFirst), (preamble = p.preamble);
    if (p.ctx_end !== undefined && pLast !== null && (endAt === null || pLast > endAt)) (endAt = pLast), (ctxEnd = p.ctx_end);
    details.push({ sid: p.session, src: "cloud", start: pFirst ?? 0, hours: p.h, prompts: p.prompts || 0, rules: { "cloud part": 1 }, branches: {} });
  }
  const partSids = new Set(partsUsed.map((p) => p.session));

  const merged = mergeIntervals(intervals);
  const activeRaw = merged.reduce((s, [a, b]) => s + (b - a), 0); // without double counting across sessions
  const overlap = rawTotal > 0 ? activeRaw / rawTotal : 1.0;
  const active = (weightedTotal * overlap) / 3600;

  // coverage
  const prSeen = (p: PR) =>
    seenPrs.has(p.number) || (!!p.headRefName && seenBranches.has(p.headRefName)) || [...seenHashes].some((h) => hashMatches(h, p.commits.map((c) => c.oid))) || (p.cloud ?? []).some((sid) => partSids.has(sid));
  const units = [...prObjs.map(prSeen), ...closers.map((c) => [...seenHashes].some((h) => hashMatches(h, [c.oid])))];
  let cov: Fact["cov"];
  if (nSessions === 0) cov = "none";
  else if (units.length && units.every(Boolean)) cov = "full";
  else cov = "partial";
  // the PR's commits were made in a cloud session, and there's neither its export nor its part — part of the work
  // isn't visible
  const cloudMissing = uniqSortedStrs(prObjs.flatMap((p) => p.cloud ?? [])).filter((sid) => !known.has(sid) && !partSids.has(sid));
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
    agents: nAgents,
    steps,
    steps_agents: stepsAgents,
    tail,
    ...(preamble !== null ? { preamble } : {}),
    ...(ctxEnd !== null ? { ctx_end: ctxEnd } : {}),
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
    cloud_parts: parts,
  };
  Object.assign(res, cov !== "none" ? tokensResult(tok, byModel) : { tok: null, usd: null });
  return res;
}

/** {task: seconds} → [{issue, h}] by task number; less than 0.01 h isn't shown. */
function hoursByIssue(m: Map<number, number>): { issue: number; h: number }[] {
  return [...m].sort((a, b) => a[0] - b[0]).map(([issue, sec]) => ({ issue, h: round2(sec / 3600) })).filter((x) => x.h > 0);
}

/** Fold tokens and cost into result fields: tok (integers), usd, usd_partial, models. */
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

/** "Tokens: 12.3 M (input … · output … · cache write … · cache read …); cost at API rates ≈ $…". */
/**
 * "Turns: 250 (subagents 2, their turns 120), preamble 104K, context at the end 581K, turns with context > 400K —
 * 31 %."
 */
function stepsTxt(res: Fact, language = locale.projectLanguage()): string {
  const k = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(Math.round(v / 1000)));
  const n = res.steps ?? 0;
  const share = n ? Math.round(((res.tail ?? 0) / n) * 100) : 0;
  return locale.fill(locale.names(language).est.fact.steps, { n, agents: res.agents ?? 0, agentSteps: res.steps_agents ?? 0, preamble: k(res.preamble), end: k(res.ctx_end), tail: TAIL_CTX / 1000, share });
}

function tokensTxt(res: Fact, language = locale.projectLanguage()): string {
  const t = res.tok;
  if (!t) return "";
  const n = locale.names(language);
  let s = locale.fill(n.est.fact.tokens, { total: fmtMtok(t.total) });
  if ("in" in t) s += locale.fill(n.est.fact.tokensSplit, { in: fmtMtok(t.in), out: fmtMtok(t.out), cw: fmtMtok(t.cw), cr: fmtMtok(t.cr) });
  if (res.usd !== null && res.usd !== undefined) {
    s += locale.fill(n.est.fact.cost, { usd: res.usd.toFixed(2) });
    const ms = Object.entries(res.models ?? {}).filter(([, m]) => m.usd);
    if (ms.length > 1) s += " (" + ms.map(([id, m]) => `${id} $${m.usd!.toFixed(2)}`).join(", ") + ")";
  }
  if (res.usd_partial?.length) s += locale.fill(n.est.fact.unpriced, { models: res.usd_partial.join(", ") });
  return s + ".";
}

/**
 * Sweep warning about double counting: the sum of task hours against the union of their intervals within each
 * session (the key is like iv in the "Actual" marker), summed over sessions. Parallel sessions legitimately run at the
 * same time — an overlap between them isn't double counting; double counting is when records of one session went into
 * the actuals of two tasks.
 */
export function sweepOverlapWarning(facts: { h: number; iv?: Record<string, [number, number][]> }[]): string | null {
  const total = facts.reduce((s, f) => s + f.h, 0);
  const bySession = new Map<string, [number, number][]>();
  for (const f of facts) for (const [sid, list] of Object.entries(f.iv ?? {})) bySession.set(sid, [...(bySession.get(sid) ?? []), ...list]);
  let unionSec = 0;
  for (const list of bySession.values()) unionSec += mergeIntervals(list).reduce((s, [a, b]) => s + (b - a), 0);
  const unionH = unionSec / 3600;
  if (total - unionH <= 0.05) return null;
  return `WARNING: intervals of one session in the actuals of different tasks: sum ${fmtH(total)} h against the union by session ${fmtH(unionH)} h — double counting ≈ ${fmtH(total - unionH)} h`;
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
// Comments with markers (fact / est)
// ----------------------------------------------------------------------------

function findMarkerComment(issue: Any, kind: string): Any | null {
  for (const c of issue.comments.nodes) if (parseMarker(c.body, kind) !== null) return c;
  return null;
}

const alt = (xs: string[]) => xs.map(locale.escapeRe).join("|");
// "+ manually: N h" and "Reason: …" in any dictionary language: a human writes the line, the language may have changed
const MANUAL_WORDS = locale.every((n) => n.est.manual).map((m) => m.replace(/^\+\s*/, "").replace(/:$/, ""));
const MANUAL_RE = new RegExp(String.raw`^\+\s*(?:${alt(MANUAL_WORDS)}):\s*([\d.,]+)\s*(?:${alt(locale.every((n) => n.est.hours))})`, "iu");
const REASON_RE = new RegExp(`^(?:${alt(locale.every((n) => n.est.reason))})`, "iu");

/** Lines "+ manually: N h" and "Reason: …" (`est.manual`, `est.reason` in any dictionary language) added by a human. */
export function extractKeptLines(body: string | null | undefined): [number, string | null, string[]] {
  let manual = 0.0;
  let cause: string | null = null;
  const lines: string[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    const s = line.trim();
    const m = MANUAL_RE.exec(s);
    if (m) {
      manual = parseFloat(m[1]!.replace(",", "."));
      lines.push(s);
    } else if (REASON_RE.test(s)) {
      cause = s.slice(s.indexOf(":") + 1).trim();
      lines.push(s);
    }
  }
  return [manual, cause, lines];
}

/**
 * The "Actual" comment in the project language (`language`, by default — of the current directory); the marker is the
 * same in all languages.
 */
export function factCommentBody(res: Fact, est: number | null, keptLines: string[], manual: number, cause: string | null, language = locale.projectLanguage()): string {
  const n = locale.names(language);
  const count = (forms: Plural, x: number) => locale.count(language, forms, x);
  const h = res.h;
  let text: string;
  if (h === null) {
    text = n.est.fact.unavailable;
  } else {
    const estimate = est ? locale.fill(n.est.fact.estimate, { h: fmtH(est), ratio: `, ×${(h / est).toFixed(2)}` }) : n.est.fact.noEstimate;
    const na = res.agents ?? 0;
    const subagents = na ? ` ${count(n.est.fact.subagents, na)},` : "";
    const body = { h: fmtH(h), agents: agentsTxt(res, language), estimate, sessions: count(n.est.fact.sessions, res.sessions), prompts: count(n.est.fact.prompts, res.prompts), subagents, wall: fmtH(res.wall, 1), cov: res.cov };
    text = `${n.comments.actual} ${locale.fill(n.est.fact.body, body)}`;
  }
  text += res.prs.length ? locale.fill(n.est.fact.prs, { list: res.prs.map((p) => `#${p}`).join(", ") }) : n.est.fact.noPr;
  text += locale.fill(n.est.fact.diff, { commits: count(n.est.fact.commits, res.commits), diff: diffTxt(res, language) });
  if (res.shared?.length) text += " " + sharedTxt(res, language) + ".";
  for (const x of res.taken ?? []) text += locale.fill(n.est.fact.taken, { h: fmtH(x.h), issue: x.issue });
  for (const x of res.overlap ?? []) text += locale.fill(n.est.fact.overlap, { h: fmtH(x.h), issue: x.issue });
  for (const sid of res.cloud_missing ?? []) text += locale.fill(n.est.fact.cloudMissing, { sid });
  if (res.tok) text += "\n" + tokensTxt(res, language);
  if (res.steps) text += "\n" + stepsTxt(res, language);
  const marker: Record<string, unknown> = { v: 1, h, manual, wall: res.wall, cov: res.cov, sessions: res.sessions, prompts: res.prompts, agents: res.agents ?? 0, prs: res.prs, commits: res.commits, diff: res.diff, cause };
  if (res.tok) {
    marker.tok = res.tok;
    marker.usd = res.usd ?? null;
    if (res.models) marker.models = res.models;
  }
  if (res.steps) Object.assign(marker, { steps: res.steps, steps_agents: res.steps_agents ?? 0, tail: res.tail ?? 0, preamble: res.preamble ?? null, ctx_end: res.ctx_end ?? null });
  if (res.type) marker.type = res.type; // type from the branch by the <type>/N-slug convention
  if (res.shared?.length) {
    const sh: Record<string, number[]> = {};
    for (const s of res.shared) sh[s.unit] = s.with;
    marker.shared = sh;
  }
  if (res.iv && Object.keys(res.iv).length) marker.iv = res.iv; // by them the next computation sees what's already counted
  if (res.cloud_missing?.length) marker.cloud_missing = res.cloud_missing;
  if (res.cloud_parts?.length) marker.cloud = res.cloud_parts; // computed by the cloud session — without them a recomputation would lose it
  return [text, ...keptLines, `<!-- fact ${pyDumps(marker)} -->`].join("\n");
}

// Claude Code cloud session (claude.ai/code): GitHub — only REST of its own repository, GraphQL and projects are
// closed by the session proxy, so neither an estimate nor an actual can be computed there — an honest "unavailable
// (cloud)" with a link to the session. A local session gives the number: importing the cloud session's events
// (est cloud-import, parseCloudFile).
const isCloud = () => process.env.CLAUDE_CODE_REMOTE === "true";
const CLOUD_ERR = "Claude Code cloud session: GitHub GraphQL and projects are unreachable from here — estimate, history and sweep only in a local session (docs/cloud-sessions.md in ai-dev)";

/** "Actual" comment of a task closed from a cloud session: actual unavailable, a marker with cov none and src cloud. */
/** Cloud session id for a link: env gives cse_…, the link needs session_…. */
const cloudSid = (sessionId: string | undefined) => (sessionId ? "session_" + sessionId.replace(/^(cse|session)_/, "") : null);

/**
 * This cloud session's part of the actual — from its transcript in the container (the work directory is the git
 * root). Without GitHub: linking is by the `<type>/<N>-…` branch, a "#N" first prompt, a subagent assignment; PRs and
 * commits aren't visible from here.
 */
function cloudOwnPart(number: number, session: string, gap: number): CloudPart | null {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const cwd = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
  const sessions = transcriptFilesIn([cwd]).map((f) => parseSessionFile(f)).filter((x) => x.ev.length); // don't discard a routine one: a cloud session is often a single prompt
  if (!sessions.length) return null;
  const stub: FactRepo = {
    full: "cloud",
    prs: () => new Map(),
    openPrs: () => ({ at: 0, items: {} }),
    closers: () => ({ oid: {}, pr: {} }),
    sessions: () => sessions,
    neutralBranches: () => new Set(["main", "master"]),
    commitDiff: () => null,
  };
  const res = computeFact(stub, number, [], [], gap);
  if (!res.h) return null;
  const t = res.tok;
  return {
    session,
    h: res.h,
    iv: (res.intervals ?? []).map(([a, b]) => [Math.floor(a), Math.ceil(b)] as [number, number]),
    prompts: res.prompts,
    agents: res.agents ?? 0,
    tok: t ? { in: t.in, out: t.out, cw: t.cw, cr: t.cr, total: t.total } : null,
    models: res.models ?? {},
    steps: res.steps ?? 0,
    steps_agents: res.steps_agents ?? 0,
    tail: res.tail ?? 0,
    ...(res.preamble !== undefined ? { preamble: res.preamble } : {}),
    ...(res.ctx_end !== undefined ? { ctx_end: res.ctx_end } : {}),
  };
}

/** The "Actual (cloud)" comment in the project language (`language`, by default — of the current directory). */
export function cloudFactBody(sessionId: string | undefined, part: CloudPart | null = null, number?: number, language = locale.projectLanguage()): string {
  const n = locale.names(language);
  const sid = cloudSid(sessionId);
  if (sid && part) {
    const usds = Object.values(part.models).map((m) => m.usd);
    const usd = usds.length && usds.every((u) => u !== null) ? round2(usds.reduce((a, u) => a + (u as number), 0)) : null;
    let text = `${n.est.cloud.actual} ${locale.fill(n.est.cloud.body, { h: fmtH(part.h), prompts: locale.count(language, n.est.fact.prompts, part.prompts) })}`;
    if (part.tok) text += locale.fill(n.est.cloud.tokens, { total: fmtMtok(part.tok.total), cost: usd !== null ? locale.fill(n.est.cloud.cost, { usd: usd.toFixed(2) }) : "" });
    text += locale.fill(n.est.cloud.fields, { sid, number: number ?? "<N>" });
    return `${text}\n<!-- fact ${pyDumps({ v: 1, h: part.h, manual: 0, cov: "cloud", src: "cloud", session: sid, cloud: [part] })} -->`;
  }
  let text = n.est.cloud.unavailable;
  if (sid) text += locale.fill(n.est.cloud.session, { sid });
  return `${text}\n<!-- fact ${pyDumps({ v: 1, h: null, manual: 0, cov: "none", src: "cloud", session: sid })} -->`;
}

const diffTxt = (res: Fact, language = locale.projectLanguage()) => (res.diff_na ? locale.names(language).est.fact.diffNa : locale.fill(locale.names(language).est.fact.diffLines, { n: res.diff }));

/** "shared commit a9e2854 with #7, #8 (share 1/3)". */
const sharedTxt = (res: Fact, language = locale.projectLanguage()) =>
  (res.shared ?? []).map((s) => locale.fill(locale.names(language).est.fact.shared, { unit: s.unit, list: s.with.map((n) => `#${n}`).join(", "), k: s.k })).join("; ");

function upsertComment(repo: Repo, issue: Any, kind: string, body: string): string {
  const existing = findMarkerComment(issue, kind);
  if (existing) {
    ghRest(`repos/${repo.full}/issues/comments/${existing.databaseId}`, "PATCH", { body });
    return "updated";
  }
  ghRest(`repos/${repo.full}/issues/${issue.number}/comments`, "POST", { body });
  return "created";
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
    // stale cache of the project/field id — reread and retry once
    meta = repo.projectMeta(true);
    ghGraphql(q, { p: meta.id, i: itemId, f: meta.fields[fieldName]!.id, v: Number(value) });
  }
}

/** Set an optional number field if the project has it (otherwise false). */
function setOptionalNumberField(repo: Repo, issue: Any, fieldName: string, value: number): boolean {
  let meta = repo.projectMeta();
  if (!meta.fields[fieldName] && !repo.optRefreshed) {
    repo.optRefreshed = true;
    meta = repo.projectMeta(true); // the metadata cache may be older than the field
  }
  if (!meta.fields[fieldName]) return false;
  setNumberField(repo, issue, fieldName, value);
  return true;
}

// ----------------------------------------------------------------------------
// History and k
// ----------------------------------------------------------------------------

interface Calib {
  k: number | null;
  n: number;
  p25: number | null;
  p75: number | null;
  share: number | null;
  n_partial: number;
}

/** k = median(actual/estimate) over the last `last` closed tasks with an est marker and an actual. */
export function calib(rows: Row[], last = 20): Calib {
  const cands: [number, number][] = [];
  let nPartial = 0;
  for (const r of rows) {
    if (r.state !== "CLOSED" || r.fact === null || !r.est_marker) continue;
    const est = r.est_marker.h || r.est;
    if (!est || est <= 0) continue;
    const fm = r.fact_marker;
    if (fm && fm.cov !== undefined && fm.cov !== null && fm.cov !== "full") {
      nPartial++; // incomplete transcript coverage — not taken into k (see the history output)
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

/** Task type of a project row: the actual one (from the branch, the "Actual" marker), else the "Estimate" marker's. */
const rowType = (r: Row): string => r.fact_marker?.type || r.est_marker?.type || "";

/**
 * History table: the labels column is sized by the longest labels string (decision labels are the first feature of an
 * analog, truncated they can't be compared); `epic` isn't a feature, it's left out.
 */
export function historyTable(rows: Row[]): string[] {
  const labelsOf = (r: Row) => r.labels.filter((l) => l !== "epic").join(",");
  const w = Math.max("labels".length, ...rows.map((r) => labelsOf(r).length));
  const out = [`${pad("#", 5, true)} | ${pad("est.", 6, true)} | ${pad("actual", 6, true)} | ${pad("cov.", 7)} | ${pad("M tok", 7, true)} | ${pad("$", 7, true)} | ${pad("agents", 6, true)} | ${pad("turns", 5, true)} | ${pad("type", 8)} | ${pad("labels", w)} | title`];
  for (const r of rows) {
    const fm = r.fact_marker ?? {};
    const cov = fm.cov || "—";
    const mt = fm.tok ? fmtMtok(fm.tok.total) : "—";
    const usd = fm.usd !== undefined && fm.usd !== null ? Number(fm.usd).toFixed(2) : "—";
    // the task's subagents and turns are fan-out and size features; an actual computed before the feature — a dash
    const ag = typeof fm.agents === "number" ? String(fm.agents) : "—";
    const st = typeof fm.steps === "number" ? String(fm.steps) : "—";
    out.push(`${pad(String(r.number), 5, true)} | ${pad(fmtH(r.est), 6, true)} | ${pad(fmtH(r.fact), 6, true)} | ${pad(cov, 7)} | ${pad(mt, 7, true)} | ${pad(usd, 7, true)} | ${pad(ag, 6, true)} | ${pad(st, 5, true)} | ${pad(rowType(r), 8)} | ${pad(labelsOf(r), w)} | ${r.title.slice(0, 60)}`);
  }
  return out;
}

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
    console.log(`== ${full} (project ${meta.owner} #${meta.number})`);
    if (!rowsFact.length) {
      console.log("history is empty" + (args.grep ? ` (filter «${args.grep}»)` : ""));
    } else {
      for (const line of historyTable(rowsFact)) console.log(line);
    }
    if (c.n) {
      const units = c.k! >= 0.5 && c.k! <= 3 ? "" : " — old estimates and actuals aren't in the same units";
      console.log(`k = ${c.k} (n=${c.n} pairs «estimate with a marker + actual full», p25–p75 ${c.p25}–${c.p75}); share within ×0.5…×2: ${Math.trunc(c.share! * 100)} %${units}`);
    } else {
      console.log("k: no pairs «estimate with the est marker + actual» — calibration unavailable");
    }
    if (c.n_partial) console.log(`tasks with coverage partial/none left out of k: ${c.n_partial}`);
    const shares = usdShares(usdByModel(rowsFact.map((r) => r.fact_marker)));
    if (shares.length) console.log(`$ by model: ${sharesTxt(shares)} — ${TARIFF_NOTE} (est period)`);
    console.log(`closed in 90 days without an actual: ${noFact90}`);
    console.log();
  }
  if (args.allRepos) {
    console.log("== summary across all repositories");
    for (const [full, nf, med, c] of summary) console.log(`  ${full}: actuals ${nf}, median actual ${fmtH(med)} h, k=${c.k} (n=${c.n})`);
  }
}

/** k by repo, otherwise by all repos (n≥5), otherwise none; the level is in the project language. */
function calibForEstimate(repo: Repo, registry: Registry): [Row[], Calib, string] {
  const rows = repo.projectRows();
  let c = calib(rows);
  let level = projectNames().est.estimate.levelRepo;
  if (c.n < 5) {
    let allRows = [...rows];
    for (const full of Object.keys(registry)) {
      if (full === repo.full) continue;
      try {
        allRows = allRows.concat(new Repo(full, registry).projectRows());
      } catch (e) {
        if (!(e instanceof EstError)) throw e;
        console.error(`warning: ${full}: ${e.message}`);
      }
    }
    const c2 = calib(allRows);
    if (c2.n >= 5) {
      c = c2;
      level = projectNames().est.estimate.levelAll;
    }
  }
  return [rows, c, level];
}

// ----------------------------------------------------------------------------
// The fact command
// ----------------------------------------------------------------------------

function factForIssue(repo: Repo, number: number, gap: number, quiet = false): [Any, Fact] {
  let issue: Any;
  try {
    issue = fetchIssue(repo, number);
  } catch (e) {
    if (!(e instanceof NotAnIssue)) throw e;
    const pr = repo.pr(number);
    if (!pr) throw new EstError(`#${number} not found in ${repo.full} either as an issue or as a PR`);
    return factForPr(repo, pr, gap);
  }
  const labels: string[] = issue.labels.nodes.map((l: Any) => l.name);
  const itype = String(issue.issueType?.name ?? "").toLowerCase();
  // epic — by the issue type "Epic" in any dictionary language; the epic label is the fallback for repos without types
  if (locale.every((n) => n.issueTypes.epic.toLowerCase()).includes(itype) || labels.includes("epic")) return factForEpic(repo, issue, gap, quiet);
  const [prObjs, closers, weakUsed] = resolveLinks(repo, issue);
  const parts = cloudPartsIn(issue.comments.nodes.map((c: Any) => c.body));
  const res = computeFact(repo, number, prObjs, closers, gap, parts);
  res.title = issue.title;
  res.weak_links = weakUsed;
  res.links = prObjs.map((p) => ({ pr: p.number, branch: p.headRefName, why: p.why! }));
  res.type = res.links.map((l) => branchType(l.branch)).find((t) => t) ?? null;
  res.closers = closers.map((c) => c.oid.slice(0, 7));
  res.epic = false;
  return [issue, res];
}

/** The number turned out to be a PR, not an issue: compute the actual for the PR itself (no write). */
function factForPr(repo: Repo, pr: PR, gap: number): [Any, Fact] {
  const res = computeFact(repo, pr.number, [{ ...pr, why: "the PR itself" }], [], gap);
  res.title = pr.title || "";
  res.weak_links = false;
  res.links = [{ pr: pr.number, branch: pr.headRefName, why: "this is a PR, not an issue" }];
  res.closers = [];
  res.epic = false;
  res.is_pr = true;
  const pseudo = { number: pr.number, title: pr.title, labels: { nodes: [] }, comments: { nodes: [] }, projectItems: { nodes: [] }, id: null, is_pr: true };
  return [pseudo, res];
}

/**
 * An epic's actual = the sum of its subtasks' actuals: from the "Actual, h" field (+ "manually" from the marker), and
 * for subtasks without the field — from transcripts.
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
      cov = fm.cov || "field";
      src = `field «${fieldShown(repo.projectMeta(), FIELD_FACT)}»` + (manual ? ` + manually ${fmtH(manual)} h` : "");
      sTok = fm.tok?.total;
      sUsd = fm.usd;
    } else {
      const [, r] = factForIssue(repo, s.number, gap, true);
      h = r.h;
      cov = r.cov;
      src = "transcripts";
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

/** "Claude Code", "Codex" or "Claude Code and Codex" — by the sources of linked sessions. */
function agentsTxt(res: Fact, language = locale.projectLanguage()): string {
  const n = locale.names(language);
  const srcs = new Set((res.details ?? []).map((d) => d.src ?? "claude"));
  const names: Record<string, string> = { claude: "Claude Code", codex: "Codex", cloud: n.est.fact.cloudAgent };
  if (!srcs.size) return "Claude Code";
  return [...srcs].sort().map((s) => names[s] ?? s).join(n.est.fact.and);
}

function printFact(repo: Repo, res: Fact, est: number | null): void {
  console.log(`== ${repo.full}#${res.issue}: ${res.title}`);
  if (res.is_pr) console.log(`WARNING: #${res.issue} is a PR, not an issue; the actual is computed for the PR itself, it can't be written`);
  if (res.epic) {
    console.log(`epic: ${res.subtasks!.length} ${plural(res.subtasks!.length, "subtask", "subtasks")}, without an actual: ${res.sub_missing}`);
    for (const p of res.subtasks!) console.log(`  #${pad(String(p.issue), 5)} ${pad(p.state, 6)} ${pad(fmtH(p.h), 6, true)} h  ${pad(p.cov, 7)} ${pad(p.title.slice(0, 50), 50)} [${p.src}]`);
    console.log(`epic actual: ${fmtH(res.h)} h (sum of the subtasks with an actual), coverage ${res.cov}`);
    if (res.tok) console.log(tokensTxt(res, "en"));
    return;
  }
  for (const l of res.links ?? []) console.log(`PR #${l.pr} (branch ${l.branch}) — ${l.why}` + (res.weak_links ? "  [WEAK LINK]" : ""));
  if (res.closers?.length) console.log("closed by commit: " + res.closers.join(", "));
  if (!res.links?.length && !res.closers?.length) console.log("no PRs or commits found — linking only by the branch / first prompt");
  if (res.shared?.length) console.log("WARNING: hours split between the tasks — " + sharedTxt(res));
  if (res.h === null) {
    console.log("actual unavailable: no sessions found (coverage none)");
  } else {
    const estTxt = est ? `estimate ${fmtH(est)} h, ×${(res.h / est).toFixed(2)}` : "no estimate";
    const raw = res.shared?.length && res.h_raw !== null && res.h_raw !== undefined ? ` (unsplit: ${fmtH(res.h_raw)} h)` : "";
    console.log(`actual: ${fmtH(res.h)} h active in ${agentsTxt(res, "en")}${raw} (${estTxt}); ${res.sessions} sess., ${res.prompts} prompts, wall ${fmtH(res.wall, 1)} h, coverage ${res.cov}`);
  }
  if (res.tok) console.log(tokensTxt(res, "en"));
  console.log(`secondary: PR ${res.prs.map((p) => `#${p}`).join(", ") || "none"}; commits ${res.commits}; diff ${diffTxt(res, "en")} (without lock files / snapshots / minified)`);
  for (const d of res.details) {
    const brs = Object.entries(d.branches).slice(0, 4).map(([b, h]) => `${b} ${h} h`).join(", ");
    const rules = Object.entries(d.rules).map(([k, v]) => `${k}:${v}`).join(", ");
    const src = d.src === "codex" ? " [codex]" : "";
    console.log(`  session ${sidKey(d.sid)}${src} ${fmtLocal(d.start)}: ${d.hours} h, ${d.prompts} prompts [${rules}] — ${brs}`);
  }
  for (const x of res.taken ?? []) console.log(`WARNING: Not counted again: ${fmtH(x.h)} h already in the actual of #${x.issue} (linked by the session name / first prompt); if that actual is wrong — est fact ${x.issue} --write, then this task again`);
  for (const x of res.overlap ?? []) console.log(`WARNING: Overlap with the actual of #${x.issue}: ${fmtH(x.h)} h of this task (pinning, branch, subagent, commit) — recompute #${x.issue}: est fact ${x.issue} --write`);
  for (const sid of res.cloud_missing ?? []) console.log(`WARNING: part of the work is the cloud session https://claude.ai/code/${sid}, its events aren't imported: export them through the browser and est cloud-import (SKILL.md est, «Cloud session»)`);
}

/** Writes the actual (comment and project fields); returns the comment body. */
function writeFact(repo: Repo, issue: Any, res: Fact, est: number | null): string {
  if (res.is_pr) throw new EstError(`#${res.issue} is a PR, not an issue: an actual for a PR isn't written`);
  const existing = findMarkerComment(issue, "fact");
  const [manual, cause, kept] = extractKeptLines(existing ? existing.body : "");
  const body = factCommentBody(res, est, kept, manual, cause);
  const what = upsertComment(repo, issue, "fact", body);
  if (res.iv && Object.keys(res.iv).length) repo.recorded().set(res.issue, res.iv); // the sweep's next task sees this actual
  let msg = `«Actual» comment ${what}`;
  if (res.h !== null) {
    setNumberField(repo, issue, FIELD_FACT, res.h);
    msg += `, field «${fieldShown(repo.projectMeta(), FIELD_FACT)}» = ${fmtH(res.h)}`;
  }
  const extra: [string, number | null][] = [
    [FIELD_TOK, res.tok ? round2(res.tok.total / 1e6) : null],
    [FIELD_USD, res.usd ?? null],
  ];
  for (const [fname, val] of extra) {
    if (val === null) continue;
    if (setOptionalNumberField(repo, issue, fname, val)) msg += `, «${fieldShown(repo.projectMeta(), fname)}» = ${fmtH(val)}`;
    else msg += ` (the project has no field «${fieldShown(repo.projectMeta(), fname)}» — skipped)`;
  }
  console.log(msg);
  return body;
}

/**
 * Actuals to recompute for a model (#345): closed tasks of the window whose spend (the actual marker, `models`)
 * includes this model version, newest first, then their closed epics — an epic's cost is the sum of its subtasks'
 * actuals.
 */
export function factsWithModel(rows: Row[], model: string, since: number, now: number): Row[] {
  const version = modelVersion(model);
  const done = (r: Row) => r.state === "CLOSED" && r.stateReason !== "NOT_PLANNED";
  const tasks = rows
    .filter((r) => done(r) && !isEpicRow(r) && (r.closedAt || 0) >= now - since)
    .filter((r) => Object.keys(r.fact_marker?.models ?? {}).some((m) => modelVersion(m) === version))
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const parents = new Set(tasks.map((r) => r.parent));
  return [...tasks, ...rows.filter((r) => done(r) && isEpicRow(r) && parents.has(r.number))];
}

interface FactArgs {
  number?: number;
  repo?: string;
  write: boolean;
  gap: number;
  json: boolean;
  sweep: boolean;
  since: string;
  model?: string;
}

/** Exit code: 1 — a sweep with --write failed to write something (#353). */
function cmdFact(args: FactArgs): number {
  const registry = loadRegistry();
  if (args.gap < 1) throw new EstError(`--gap must be ≥ 1 minute, got ${args.gap}`);
  if (args.sweep && args.number !== undefined) throw new EstError("an issue number and --sweep are incompatible: one or the other");
  if (args.model !== undefined && !args.sweep) throw new EstError("--model — only with --sweep: recomputing the recorded actuals with this model");
  if (isCloud()) {
    if (args.number === undefined) throw new EstError(CLOUD_ERR);
    const sid = cloudSid(process.env.CLAUDE_CODE_REMOTE_SESSION_ID);
    const part = sid ? cloudOwnPart(args.number, sid, args.gap) : null;
    const what = part
      ? `this session's part of the actual is computed from its transcript (${fmtH(part.h)} h); the project fields can't be set from here — a local session sets them (est fact ${args.number} --write or --sweep)`
      : "this session's actual can't be computed: the transcript isn't linked to the task (branch <type>/<N>-… or «#N» in the first prompt) — a local session imports the events (est cloud-import)";
    console.log(
      `Claude Code cloud session: GitHub GraphQL and the project fields are unreachable from here — ${what}${args.write ? " (--write writes nothing)" : ""}.\n` +
        `Write the comment below into issue #${args.number} with a GitHub tool; «${projectNames().status.done}» is set by the project workflow «Item closed», otherwise by the user.\n\n` +
        cloudFactBody(process.env.CLAUDE_CODE_REMOTE_SESSION_ID, part, args.number),
    );
    return 0;
  }
  const repo = new Repo(resolveRepo(args.repo), registry);
  const meta = repo.projectMeta();
  if (args.sweep) {
    const since = parseSince(args.since);
    const now = nowTs();
    let rows: Row[];
    if (args.model !== undefined) {
      rows = factsWithModel(repo.projectRows(), args.model, since, now);
      console.log(`== ${repo.full}: closed with an actual on ${modelVersion(args.model)} in ${args.since} (with their epics): ${rows.length}`);
    } else {
      rows = repo.projectRows().filter((r) => r.state === "CLOSED" && r.fact === null && r.stateReason !== "NOT_PLANNED" && (r.closedAt || 0) >= now - since);
      rows.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
      console.log(`== ${repo.full}: closed without an actual in ${args.since}: ${rows.length}`);
    }
    const stats: Record<string, number> = { full: 0, partial: 0, none: 0 };
    let total = 0.0;
    let epicsTotal = 0.0;
    const counted: { h: number; iv?: Record<string, [number, number][]> }[] = [];
    // one task's error — a line, and on down the list; a network that didn't come back over the retries — stop: the
    // following ones would wait through the same retries (#353)
    const failed: number[] = [];
    let left: Row[] = [];
    const failure = (r: Row, what: string, e: unknown, i: number) => {
      if (!(e instanceof EstError)) throw e;
      console.log(`  #${r.number}: ${what}: ${e.message}`);
      failed.push(r.number);
      if (e instanceof NetworkError) left = rows.slice(i + 1);
      return e instanceof NetworkError;
    };
    for (const [i, r] of rows.entries()) {
      let issue: Any;
      let res: Fact;
      try {
        [issue, res] = factForIssue(repo, r.number, args.gap, true);
      } catch (e) {
        if (failure(r, "error", e, i)) break;
        continue;
      }
      stats[res.cov] = (stats[res.cov] ?? 0) + 1;
      const h = res.h;
      if (h !== null) {
        if (res.epic) epicsTotal += h; // an epic is the sum of its subtasks, not in the overall total (otherwise double counting)
        else {
          total += h;
          counted.push({ h, iv: res.iv });
        }
      }
      let extra = res.epic ? "epic" : res.prs.length ? "PR " + res.prs.map((p) => `#${p}`).join(", ") : "no PR";
      if (res.weak_links) extra += " (weak link)";
      if (res.shared?.length) extra += ` (share 1/${Math.max(...res.shared.map((s) => s.k))})`;
      // recomputing gives the whole actual by the current logic, not just one rate: the previous hours sit alongside so
      // the difference is visible before --write
      if (args.model !== undefined) extra += `; was ${fmtH(r.fact)} h, $${fmtH(r.fact_marker?.usd ?? null)} → $${fmtH(res.usd ?? null)}`;
      console.log(`  #${pad(String(r.number), 5)} ${pad(fmtH(h), 6, true)} h  ${pad(res.cov, 7)} estimate ${pad(fmtH(r.est), 5, true)}  ${pad(extra, 26)} ${r.title.slice(0, 50)}`);
      if (args.write && res.cov !== "none") {
        let body: string;
        try {
          body = writeFact(repo, issue, res, r.est);
        } catch (e) {
          if (failure(r, "error writing", e, i)) break;
          continue;
        }
        // further in this same sweep an epic adds up its subtasks' actuals from the project rows — they need the
        // written one, not the previous one
        if (h !== null) r.fact = h;
        r.fact_marker = parseMarker(body, "fact");
      }
    }
    if (left.length) console.log(`the network didn't come back within the retries — sweep stopped, not processed: ${left.length}`);
    console.log(`total: full ${stats.full}, partial ${stats.partial}, none ${stats.none}; sum of hours ${fmtH(total)} (without epics; epics ${fmtH(epicsTotal)} h — the sum of their subtasks)`);
    const warning = sweepOverlapWarning(counted);
    if (warning) console.log(warning);
    if (!args.write) console.log("(nothing written without --write)");
    else if (failed.length || left.length) {
      const missed = [...failed, ...left.map((r) => r.number)];
      console.log(`not written: ${missed.length} — ${missed.map((n) => `#${n}`).join(", ")}`);
      const opts = `--repo ${repo.full}${args.gap === 30 ? "" : ` --gap ${args.gap}`}`;
      // a regular sweep takes only tasks without an actual — it would skip the written ones; a sweep by model would
      // recompute them too
      console.log(
        args.model === undefined
          ? `retry: est fact --sweep --since ${args.since} ${opts} --write — it skips the written ones`
          : `retry task by task, in order (a sweep would recompute the written ones too): est fact <N> ${opts} --write — ${missed.map((n) => `#${n}`).join(", ")}`,
      );
      return 1;
    }
    return 0;
  }
  if (args.number === undefined) throw new EstError("pass an issue number or --sweep");
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
  else if (!args.json) console.log("(nothing written without --write)");
  return 0;
}

// ----------------------------------------------------------------------------
// The estimate command
// ----------------------------------------------------------------------------

export const SCALE = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 13] as const; // estimate steps, h; rounding to the nearest

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
  tokMult?: number; // token and cost correction; without it — the same as for hours
  tokNote?: string;
  note: string;
  write: boolean;
}

/** Token correction steps: fan-out in the pilot gave ×2.5 to tokens at ×0.8 to hours — hence there's also ×3. */
const TOK_MULTS = [0.5, 1, 1.5, 2, 3];

/**
 * Forecast from the analogs' actuals: hours — median × hours correction, to a scale step; tokens and cost — median ×
 * token correction (without it — the same as for hours): with fan-out tokens grow while hours shrink.
 */
export function forecast(facts: number[], toks: number[], usds: number[], mult: number, tokMult = mult): { raw: number; h: number; tok: number | null; usd: number | null } {
  const raw = median(facts) * mult;
  return { raw, h: roundScale(raw), tok: toks.length ? median(toks) * tokMult : null, usd: usds.length ? median(usds) * tokMult : null };
}

const isPublic = (full: string): boolean => ghRest(`repos/${full}`)?.visibility === "public";

/**
 * Analogs from non-public repos that the estimate would name in a public one: the "Estimate" comment writes them as
 * owner/repo#N, and GitHub keeps the previous version of a comment in the edit history — a rewrite doesn't undo the
 * leak.
 */
function hiddenAnalogs(repo: Repo, analogs: (number | string)[]): string[] {
  const other = analogs.filter((a): a is string => typeof a === "string");
  if (!other.length || !isPublic(repo.full)) return [];
  const pub = new Map<string, boolean>();
  return other.filter((a) => {
    const full = a.split("#")[0]!;
    if (!pub.has(full)) pub.set(full, isPublic(full));
    return !pub.get(full);
  });
}

// ----------------------------------------------------------------------------
// Analog picking by the script
// ----------------------------------------------------------------------------

/** Non-decision labels: `epic` is the kind of task, the questions label (in any dictionary language) is its state. */
const NOT_DECISION = new Set(["epic", ...locale.every((n) => n.labels.questions)]);
/** Title stop words (shorter than three letters are cut off anyway): they don't point to task similarity. */
const STOP_WORDS = new Set(words((n) => n.est.stopWords));
/** Word stem — the first four letters: "estimate", "estimates", "estimated" are one word (five letters already split
 * Russian forms with a fleeting vowel); crude, but needs no dictionary, and in backtest #279 no worse than five. */
const STEM = 4;

/** Title words by stem: stem → the word as it stands in the title (lowercase), in order. */
export function titleWords(title: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    const stem = w.slice(0, STEM);
    if (!out.has(stem)) out.set(stem, w);
  }
  return out;
}

/**
 * An answer to a question in the questions section: from "Answer…:" (`est.answer` in any dictionary language) to the
 * next list item or a blank line.
 */
const ANSWER_RE = new RegExp(String.raw`\s*(?:\*\*)?(?:${locale.every((n) => n.est.answer).map(locale.escapeRe).join("|")})[^:\n]*:(?:\*\*)?[^\n]*(?:\n(?![ \t]*(?:\d+\.|$))[^\n]*)*`, "gm");
/** The issue's questions section — `sections.questions` in any dictionary language — up to the next section. */
const QUESTIONS_RE = new RegExp(String.raw`(?<=^|\n)(?:${locale.every((n) => n.sections.questions).map(locale.escapeRe).join("|")})\n[\s\S]*?(?=\n## |$)`);

/**
 * Issue description size, chars, — a task size feature: in backtest #279 it is tied to the actual more closely than
 * the manual estimate. Answers to questions and ✅ marks don't count: they are added after the estimate, and for closed
 * tasks they would inflate the size.
 */
export function descSize(body: string): number {
  return body.replace(QUESTIONS_RE, (sec) => sec.replace(ANSWER_RE, "").replace(/✅\s*/g, "")).length;
}

const EPIC_TYPES = new Set(locale.every((n) => n.issueTypes.epic).map((t) => t.toLowerCase()));
const isEpicRow = (r: Row): boolean => r.labels.includes("epic") || EPIC_TYPES.has((r.issueType ?? "").toLowerCase());
/**
 * A closed task with a measured actual (coverage full), not an epic (its actual is the sum of its subtasks): an analog
 * and a backtest sample.
 */
const factRow = (r: Row): boolean => r.state === "CLOSED" && r.fact !== null && r.fact > 0 && (r.fact_marker?.cov ?? "full") === "full" && !isEpicRow(r);

/** The task analogs are picked for — its features at the time of the estimate. */
export interface AnalogTarget {
  number: number;
  title: string;
  labels: string[];
  createdAt: number | null;
  size: number;
}

/**
 * An analog and how it is similar: shared decision labels, the same type, shared words (as in the task title), size
 * relative to the task's size.
 */
export interface Analog {
  row: Row;
  score: number;
  labels: string[];
  sameType: boolean;
  words: string[];
  sizeRatio: number | null;
}

/** Analogs the script takes: a median of three is steadier than of two, and a fourth added no backtest accuracy. */
const ANALOG_K = 3;
const wordsCache = new WeakMap<Row, Map<string, string>>();

/**
 * Analogs are the most similar closed tasks with a full actual, closed before the estimated one was created (as the
 * script would have estimated on the creation day: the backtest doesn't look into the future). Similarity is a sum: a
 * shared decision label ×3, the same type ×2, a shared title word ×1, minus 3 × |ln| of the description size ratio
 * (+200 chars — an empty description doesn't go to infinity); on a tie — the recently closed ones. Weights are from
 * backtest #279: the feature queue "labels → type → words → size" gave noticeably fewer hits, the description size
 * weighs no less than labels.
 */
export function pickAnalogs(target: AnalogTarget, type: string, rows: Row[], k = ANALOG_K): Analog[] {
  const tl = new Set(target.labels.filter((l) => !NOT_DECISION.has(l)));
  const tw = titleWords(target.title);
  const out: Analog[] = [];
  for (const r of rows) {
    if (r.number === target.number || !factRow(r)) continue;
    if (target.createdAt !== null && !(r.closedAt !== null && r.closedAt < target.createdAt)) continue;
    let cw = wordsCache.get(r);
    if (!cw) wordsCache.set(r, (cw = titleWords(r.title)));
    const labels = r.labels.filter((l) => tl.has(l));
    const sameType = rowType(r) === type;
    const words = [...tw].filter(([stem]) => cw.has(stem)).map(([, w]) => w);
    const size = r.size ?? 0;
    const score = 3 * labels.length + (sameType ? 2 : 0) + words.length - 3 * Math.abs(Math.log((target.size + 200) / (size + 200)));
    out.push({ row: r, score, labels, sameType, words, sizeRatio: target.size > 0 && size > 0 ? size / target.size : null });
  }
  out.sort((a, b) => b.score - a.score || (b.row.closedAt ?? 0) - (a.row.closedAt ?? 0) || b.row.number - a.row.number);
  return out.slice(0, k);
}

/**
 * How the analog is similar to the task — for the "Estimate" comment in the project language:
 * `label est · type feat · words «a», «b» · description ×0.8`.
 */
function analogWhy(a: Analog, type: string, language: string): string {
  const n = locale.names(language);
  const parts: string[] = [];
  if (a.labels.length) parts.push(`${locale.plural(language, n.est.estimate.labels, a.labels.length)} ${a.labels.join(", ")}`);
  if (a.sameType) parts.push(locale.fill(n.est.estimate.type, { type }));
  if (a.words.length) parts.push(`${locale.plural(language, n.est.estimate.words, a.words.length)} ${a.words.map((w) => `«${w}»`).join(", ")}`);
  if (a.sizeRatio !== null) parts.push(locale.fill(n.est.estimate.size, { ratio: fmtH(a.sizeRatio, 1) }));
  return parts.join(" · ");
}

/**
 * Estimate = forecast from the analogs' actuals: hours, tokens and cost — medians of actuals × correction. The script
 * picks analogs (pickAnalogs), --analogs is a manual choice when the agent sees a difference the features don't catch.
 * --hours — only an expert estimate, when there are no analogs with an actual (confidence C). k is for reference.
 */
function cmdEstimate(args: EstimateArgs): void {
  if (isCloud()) throw new EstError(CLOUD_ERR);
  const registry = loadRegistry();
  if (!(EST_TYPES as readonly string[]).includes(args.type)) throw new EstError(`--type must be one of: ${EST_TYPES.join(", ")}`);
  if (args.hours !== undefined && !(args.hours > 0)) throw new EstError(`--hours must be greater than 0, got ${fmtH(args.hours)}`);
  if (![0.5, 1, 1.5, 2].includes(args.mult)) throw new EstError("--mult allows only 0.5, 1, 1.5 or 2");
  if (args.tokMult !== undefined && !TOK_MULTS.includes(args.tokMult)) throw new EstError("--tok-mult allows only 0.5, 1, 1.5, 2 or 3");
  const tokMult = args.tokMult ?? args.mult;
  const auto = !args.analogs.trim() && args.hours === undefined; // neither --analogs nor --hours — the script picks analogs
  const repo = new Repo(resolveRepo(args.repo), registry);
  // analogs: an issue number of this repo (254) or a task of another registry repo (owner/repo#254)
  const analogs: (number | string)[] = []; // number — this repo; "owner/repo#N" — another one
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
    if (!isDigits(a)) throw new EstError(`analog «${a}» is neither an issue number nor owner/repo#N`);
    const n = parseInt(a, 10);
    if (n === args.number) throw new EstError(`analog #${a} is the task being estimated`);
    if (!analogs.includes(n)) analogs.push(n);
  }
  // a downward correction to analogs from other repos without a named difference underestimated big tasks threefold
  // (#348) — hence the rule "no difference — ×1"
  if (args.mult < 1 && analogs.some((a) => typeof a === "string") && !args.note.trim()) {
    const msg = `downward correction against another repo's analogs (×${fmtH(args.mult)}): name the difference in --note, no difference — ×1`;
    if (args.write) throw new EstError(msg); // before any write
    console.error(`warning: ${msg}; with --write — refused`);
  }
  const hidden = hiddenAnalogs(repo, analogs);
  if (hidden.length) {
    const msg = `${repo.full} is a public repo, and the ${plural(hidden.length, "analog", "analogs")} ${hidden.join(", ")} — from a non-public one: the other task's name and number would stay in the «Estimate» comment and in its edit history. Take analogs from ${repo.full} or give an expert estimate (--hours)`;
    if (args.write) throw new EstError(msg); // before any write
    console.error(`warning: ${msg}; with --write — refused`);
  }
  const meta = repo.projectMeta();
  const [rows, c, level] = calibForEstimate(repo, registry);
  const byNum = new Map(rows.map((r) => [r.number, r]));
  const facts: number[] = [];
  const toks: number[] = [];
  const usds: number[] = [];
  const parts: string[] = [];
  const otherParts = new Map<string, string[]>();
  const otherRows = new Map<string, Map<number, Row>>();

  // the "Estimate" comment is in the project language
  const language = locale.projectLanguage();
  const n = locale.names(language);
  const take = (r: Row, label: string, bucket: string[], why = "") => {
    const fm = r.fact_marker ?? {};
    if (r.fact === null) {
      bucket.push(locale.fill(n.est.estimate.unknown, { label }));
      return;
    }
    const cov = fm.cov || "full";
    if (cov !== "full") {
      bucket.push(locale.fill(n.est.estimate.partialCoverage, { label, h: fmtH(r.fact), cov }));
      return;
    }
    facts.push(Number(r.fact));
    const tt = fm.tok?.total;
    if (tt) toks.push(tt / 1e6);
    if (fm.usd !== undefined && fm.usd !== null) usds.push(Number(fm.usd));
    bucket.push(locale.fill(n.est.estimate.analog, { label, h: fmtH(r.fact), why: why ? `: ${why}` : "" }));
  };

  const issue = fetchIssue(repo, args.number);
  for (const a of analogs) {
    if (typeof a === "string") {
      const [full, numS] = a.split("#") as [string, string];
      const num = parseInt(numS, 10);
      if (!otherRows.has(full)) {
        if (!(full in registry)) throw new EstError(`analog ${a}: repository ${full} isn't in the registry ${REGISTRY_PATH}`);
        otherRows.set(full, new Map(new Repo(full, registry).projectRows().map((r) => [r.number, r])));
      }
      const r = otherRows.get(full)!.get(num);
      if (!r) throw new EstError(`analog ${a} not found in the project of repository ${full}`);
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
        throw new EstError(`analog #${a} not found in repo ${repo.full} as an issue (${e.message})`);
      }
      console.error(`warning: analog #${a} is in the repo but not in the project — its actual is unknown`);
      parts.push(locale.fill(n.est.estimate.notInProject, { label: `#${a}` }));
      continue;
    }
    take(r, `#${a}`, parts);
  }
  if (auto) {
    // without --analogs and --hours there are no analogs in the list — the script picks them
    const target = { number: args.number, title: issue.title, labels: (issue.labels?.nodes ?? []).map((l: Any) => l.name), createdAt: parseTs(issue.createdAt), size: descSize(issue.body ?? "") };
    const picked = pickAnalogs(target, args.type, rows);
    if (picked.length < 2) throw new EstError(`${repo.full} has fewer than two tasks with an actual (coverage full) closed before #${args.number} was created — analogs from another repo (--analogs owner/repo#N) or an expert estimate (--hours)`);
    for (const a of picked) {
      analogs.push(a.row.number);
      take(a.row, `#${a.row.number}`, parts, analogWhy(a, args.type, language));
    }
  }
  for (const [full, lst] of otherParts) parts.push(locale.fill(n.est.estimate.otherProject, { repo: full, list: lst.join(", ") }));
  const analogTxt = parts.length ? parts.join("; ") : n.est.estimate.none;

  const expert = args.hours !== undefined;
  if (!facts.length && !expert) throw new EstError("no analogs with an actual (coverage full) — pass --analogs with actuals or --hours as an expert estimate");
  if (facts.length === 1 && !expert) throw new EstError("one analog isn't a forecast: add a second analog or --hours");
  let tokF: number | null = null;
  let usdF: number | null = null;
  let spreadTxt: string | null = null;
  let raw: number | null = null;
  let h: number;
  let basis: string;
  if (facts.length) {
    const f = forecast(facts, toks, usds, args.mult, tokMult);
    raw = f.raw;
    h = f.h;
    tokF = f.tok;
    usdF = f.usd;
    const mn = Math.min(...facts);
    const mx = Math.max(...facts);
    if (mn > 0 && mx / mn > 3) spreadTxt = locale.fill(n.est.estimate.spread, { min: fmtH(mn), max: fmtH(mx) });
    basis = n.est.estimate.forecast;
    if (expert) {
      // expert hours over the forecast: tokens and cost scale proportionally
      const ratio = raw > 0 ? args.hours! / raw : 1;
      basis = locale.fill(n.est.estimate.expertOver, { h: fmtH(h), ratio: ratio.toFixed(1) });
      h = roundScale(args.hours!);
      tokF = tokF !== null ? tokF * ratio : null;
      usdF = usdF !== null ? usdF * ratio : null;
    }
  } else {
    h = roundScale(args.hours!);
    basis = n.est.estimate.expert;
  }
  if (expert && Math.abs(h - args.hours!) > 1e-9) console.error(`warning: --hours ${fmtH(args.hours)} rounded to the scale: ${fmtH(h)}`);
  const sameType = rows.filter((r) => r.state === "CLOSED" && r.fact !== null && (r.fact_marker?.cov ?? "full") === "full" && rowType(r) === args.type).length;
  const counted = facts.length;
  const conf = expert ? "C" : counted >= 3 && sameType >= 5 ? "A" : "B";
  let headline = locale.fill(n.est.estimate.headline, { h: fmtH(h) });
  if (tokF !== null) headline += locale.fill(n.est.estimate.tokens, { tok: fmtH(tokF, tokF < 1 ? 2 : 1) });
  if (usdF !== null) headline += usdF < 1 ? `, ≈ $${usdF.toFixed(2)}` : `, ≈ $${usdF.toFixed(0)}`;
  if (facts.length && (toks.length < facts.length || usds.length < facts.length)) headline += locale.fill(n.est.estimate.partial, { k: Math.min(toks.length, usds.length), n: facts.length });
  const note = args.note ? ` (${args.note})` : "";
  let multTxt = facts.length ? locale.fill(n.est.estimate.correction, { mult: fmtH(args.mult), note }) : "";
  if (facts.length && tokMult !== args.mult) multTxt += locale.fill(n.est.estimate.tokCorrection, { mult: fmtH(tokMult), note: args.tokNote ? ` (${args.tokNote})` : "" });
  const kTxt = c.n ? locale.fill(n.est.estimate.k, { k: String(c.k), n: c.n, level }) : n.est.estimate.noK;
  const text = locale.fill(n.est.estimate.body, { headline, type: args.type, conf, basis, auto: auto ? n.est.estimate.auto : "", analogs: analogTxt, correction: multTxt, spread: spreadTxt ?? "", k: kTxt });
  const marker = {
    v: 2,
    h,
    raw: raw !== null ? round2(raw) : null,
    type: args.type,
    analogs,
    mult: args.mult,
    tok_mult: tokMult,
    tok: tokF !== null ? round2(tokF) : null,
    usd: usdF !== null ? round2(usdF) : null,
    expert,
    auto,
    k: c.k,
    n: c.n,
    conf,
  };
  const body = text + "\n" + `<!-- est ${pyDumps(marker)} -->`;
  const cur = issueProjectFields(issue, meta);
  console.log(`== ${repo.full}#${args.number}: ${issue.title}`);
  console.log(`current «${fieldShown(meta, FIELD_EST)}»: ${fmtH(cur.est)}; status: ${cur.status || "—"}`);
  const over = raw !== null && !expert ? raw : expert ? args.hours! : null;
  if (over !== null && over > SCALE[SCALE.length - 1]!) console.log(`WARNING: it comes to ${fmtH(over)} h > 13 — the field gets ${fmtH(h)}, the task should be split into subtasks`);
  console.log("comment:");
  console.log(body);
  if (args.write) {
    const what = upsertComment(repo, issue, "est", body);
    setNumberField(repo, issue, FIELD_EST, h);
    console.log(`«Estimate» comment ${what}, field «${fieldShown(meta, FIELD_EST)}» = ${fmtH(h)}`);
  } else {
    console.log("(nothing written without --write)");
  }
}

// ----------------------------------------------------------------------------
// The backtest command
// ----------------------------------------------------------------------------

/** Estimate accuracy on a sample: the share of actual/estimate within ×0.5…×2, and k — the median actual/estimate. */
export interface BacktestLine {
  n: number;
  share: number | null;
  k: number | null;
}

export interface Backtest {
  tasks: number; // closed tasks with a full actual, not epics
  mech: BacktestLine; // the mechanical estimate for all tasks that had enough analogs
  same: number; // of them with a manual estimate — the common sample of the three lines below
  mechSame: BacktestLine;
  manual: BacktestLine;
  mechMult: BacktestLine; // the mechanical estimate × the correction the agent gave in the manual estimate
}

/** pairs — [actual, estimate]. */
function backtestLine(pairs: [number, number][]): BacktestLine {
  const ratios = pairs.map(([f, e]) => f / e).sort((a, b) => a - b);
  if (!ratios.length) return { n: 0, share: null, k: null };
  return { n: ratios.length, share: ratios.filter((x) => x >= 0.5 && x <= 2).length / ratios.length, k: round2(median(ratios)) };
}

/**
 * Each closed task with an actual is estimated mechanically, the way `est estimate` without --analogs would have on the
 * creation day (pickAnalogs takes only those closed earlier); a manual estimate is an est marker without `auto`. The
 * comparison is on tasks that have both: otherwise the samples differ, and the shares aren't comparable.
 */
export function backtest(rows: Row[]): Backtest {
  const pool = rows.filter((r) => factRow(r) && r.createdAt !== null);
  const mech: [number, number][] = [];
  const mechSame: [number, number][] = [];
  const manual: [number, number][] = [];
  const mechMult: [number, number][] = [];
  for (const t of pool) {
    const em = t.est_marker;
    const type = em?.type || rowType(t);
    const picked = pickAnalogs({ number: t.number, title: t.title, labels: t.labels, createdAt: t.createdAt, size: t.size ?? 0 }, type, rows);
    if (picked.length < 2) continue;
    const raw = median(picked.map((a) => a.row.fact!));
    const h = roundScale(raw);
    mech.push([t.fact!, h]);
    const hand = em && !em.auto ? Number(em.h || t.est) : 0;
    if (!(hand > 0)) continue;
    mechSame.push([t.fact!, h]);
    manual.push([t.fact!, hand]);
    mechMult.push([t.fact!, roundScale(raw * (Number(em.mult) || 1))]);
  }
  return { tasks: pool.length, mech: backtestLine(mech), same: manual.length, mechSame: backtestLine(mechSame), manual: backtestLine(manual), mechMult: backtestLine(mechMult) };
}

function cmdBacktest(args: { repo?: string; allRepos: boolean }): void {
  if (isCloud()) throw new EstError(CLOUD_ERR);
  const registry = loadRegistry();
  const repos = args.allRepos ? Object.keys(registry) : [resolveRepo(args.repo)];
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);
  const line = (name: string, l: BacktestLine) => `  ${pad(name, 30)} within tolerance ${pct(l.share)}, k=${l.k ?? "—"}`;
  for (const full of repos) {
    let rows: Row[];
    try {
      rows = new Repo(full, registry).projectRows();
    } catch (e) {
      if (!(e instanceof EstError) || !args.allRepos) throw e;
      console.error(`warning: ${full}: ${e.message}`);
      continue;
    }
    const b = backtest(rows);
    console.log(`== ${full}: estimate backtest — analogs only from tasks closed before the estimated one was created`);
    console.log(`tasks with an actual (coverage full, no epics): ${b.tasks}; the mechanics had enough analogs (≥ 2): ${b.mech.n}, within ×0.5…×2 — ${pct(b.mech.share)}, k=${b.mech.k ?? "—"}`);
    if (b.same) {
      console.log(`on one sample with a manual estimate, n=${b.same}:`);
      console.log(line("mechanics", b.mechSame));
      console.log(line("manual", b.manual));
      console.log(line("mechanics × manual correction", b.mechMult));
    } else {
      console.log("no manual estimates with an actual — nothing to compare the mechanics with");
    }
    console.log();
  }
}

// ----------------------------------------------------------------------------
// The period command — summary of all the repo's sessions over a period, not tied to tasks
// ----------------------------------------------------------------------------

/** The model rate is separate from the flow: a model change changes a task's $ manyfold with the same flow. */
const TARIFF_NOTE = "the $ trend mixes the flow with the model rate: compare the flow by tokens and output";

/** $ by model from the "Actual" markers (models: {model: {mtok, usd}}); a model without a price is skipped. */
export function usdByModel(markers: Any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const fm of markers) {
    for (const [m, v] of Object.entries(fm?.models ?? {})) {
      const usd = (v as Any)?.usd;
      if (typeof usd === "number" && usd > 0) out[m] = (out[m] ?? 0) + usd;
    }
  }
  return out;
}

/** $ shares by model, descending: [model, share 0…1]. */
export function usdShares(byModel: Record<string, number>): [string, number][] {
  const total = Object.values(byModel).reduce((a, x) => a + x, 0);
  if (!(total > 0)) return [];
  return Object.entries(byModel)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([m, v]) => [m, v / total]);
}

/** «claude-opus-5 62 %, claude-fable-5-1 38 %, claude-haiku-4-5 <1 %». */
export const sharesTxt = (shares: [string, number][]) => shares.map(([m, x]) => `${m} ${Math.round(x * 100) || "<1"} %`).join(", ");

/** A moment for --since/--until: 90d / 12w / 6m / 48h ago, a YYYY-MM-DD date (local midnight) or an ISO time. */
export function parseWhen(s: string, now = nowTs()): number {
  const v = s.trim();
  if (/^\d+[dhwm]$/.test(v)) return now - parseSince(v);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime() / 1000;
  const t = /^\d{4}-\d{2}-\d{2}T/.test(v) ? parseTs(v) : null;
  if (t === null) throw new EstError(`invalid date «${s}»: expected YYYY-MM-DD, an ISO time or 90d / 12w / 6m / 48h`);
  return t;
}

/** Periods [start, end): the i-th --until closes the i-th --since, without it — until now. */
export function parsePeriods(since: string[], until: string[], now = nowTs()): [number, number][] {
  if (!since.length) throw new EstError("pass --since: the start of the period (YYYY-MM-DD, an ISO time or 90d)");
  if (until.length > since.length) throw new EstError("--until without its --since: periods are pairs --since … [--until …] in order");
  return since.map((s, i) => {
    const a = parseWhen(s, now);
    const z = i < until.length ? parseWhen(until[i]!, now) : now;
    if (!(a < z)) throw new EstError(`period ${i + 1}: the end isn't after the start (${fmtLocal(a)} … ${fmtLocal(z)})`);
    return [a, z];
  });
}

/** Summary of the repository's sessions over the period [since, until): everything the agent did, not tied to tasks. */
export interface Period {
  since: number;
  until: number;
  sessions: number; // sessions with records in the period
  prs: number; // PRs merged in the period
  h: number; // agent hours, s: active time per session, summed
  machine: number; // machine hours, s: the union of active intervals of all sessions
  tok: number; // total tokens
  out: number; // of them output
  usd: number | null; // null — no model from the price list
  models: Record<string, number>; // $ by model from the price list
  unpriced: string[]; // models without a price
  steps: number; // turns — model responses, one per message.id
  agents: number; // subagents with records in the period
  prompts: number; // human prompts
}

/**
 * Period summary over all sessions — like the actual, but without linking: active time is the gaps between neighboring
 * records of a session no longer than gap, both in the period; tokens and cost — once per model response (a resumed
 * session copies the history); machine hours — the union of all sessions' gaps, their ratio to agent hours is
 * parallelism.
 */
export function periodSummary(sessions: Session[], prs: PR[], since: number, until: number, gapMin = 30): Period {
  const gap = gapMin * 60;
  const seen = new Set<string>();
  const all: [number, number][] = [];
  const byModel = new Map<string, number | null>();
  const res: Period = { since, until, sessions: 0, prs: 0, h: 0, machine: 0, tok: 0, out: 0, usd: null, models: {}, unpriced: [], steps: 0, agents: 0, prompts: 0 };
  const inside = (t: number) => t >= since && t < until;
  for (const s of sessions) {
    const ev = s.ev;
    const agents = new Set<number>();
    let touched = false;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      const t = e[0] as number;
      if (!inside(t)) continue;
      touched = true;
      if (e[2]) res.prompts++;
      if (e[5] > 0) agents.add(e[5]);
      const prev = i > 0 ? (ev[i - 1]![0] as number) : null;
      if (prev !== null && prev >= since && t - prev <= gap) {
        all.push([prev, t]);
        res.h += t - prev;
      }
      const u = e.length > 4 && e[4] >= 0 ? s.usage?.[e[4]] : undefined;
      if (!u || seen.has(u[0])) continue;
      seen.add(u[0]);
      const model: string = s.models?.[u[1]] ?? "?";
      const vals: [number, number, number, number, number] = [u[2], u[3], u[4], u[5], u[6]];
      res.steps++;
      res.tok += vals.reduce((a, x) => a + x, 0);
      res.out += vals[1];
      const c = usageCost(model, vals, !!u[7]);
      const was = byModel.has(model) ? byModel.get(model)! : 0;
      byModel.set(model, c === null || was === null ? null : was + c);
    }
    if (touched) res.sessions++;
    res.agents += agents.size;
  }
  res.machine = mergeIntervals(all).reduce((a, [x, y]) => a + (y - x), 0);
  for (const [m, v] of byModel) {
    if (v === null) res.unpriced.push(m);
    else res.models[m] = v;
  }
  res.unpriced.sort();
  if (Object.keys(res.models).length) res.usd = Object.values(res.models).reduce((a, x) => a + x, 0);
  res.prs = prs.filter((p) => p.mergedAt !== null && inside(p.mergedAt)).length;
  return res;
}

/** Period table: totals, also per merged PR; for two periods the "after / before" ratio; then the $ share by model. */
export function periodTable(ps: Period[]): string[] {
  const when = (t: number) => {
    const s = fmtLocal(t);
    return s.endsWith(" 00:00") ? s.slice(0, 10) : s;
  };
  const heads = ps.map((p) => `${when(p.since)} … ${when(p.until)}`);
  const int = (v: number) => String(Math.round(v));
  const one = (v: number) => fmtH(v, 1);
  const hrs = (v: number) => fmtH(v, 2);
  const mln = (v: number) => fmtH(v / 1e6, 1);
  const thou = (v: number) => String(Math.round(v / 1e3));
  const usd = (v: number) => v.toFixed(2);
  const h = (p: Period) => p.h / 3600;
  const m = (p: Period) => p.machine / 3600;
  const perPr = (f: (p: Period) => number | null) => (p: Period) => {
    const v = f(p);
    return v === null || !p.prs ? null : v / p.prs;
  };
  type Line = [string, (p: Period) => number | null, (v: number) => string];
  const lines: (Line | string)[] = [
    ["sessions", (p) => p.sessions, int],
    ["merged PRs", (p) => p.prs, int],
    ["agent hours (sum over sessions)", h, hrs],
    ["machine hours (union of sessions)", m, hrs],
    ["session parallelism", (p) => (p.machine ? p.h / p.machine : null), (v) => `×${one(v)}`],
    ["tokens, M", (p) => p.tok, mln],
    ["output, K", (p) => p.out, thou],
    ["cost, $", (p) => p.usd, usd],
    ["turns", (p) => p.steps, int],
    ["subagents", (p) => p.agents, int],
    ["human prompts", (p) => p.prompts, int],
    "per merged PR:",
    ["  agent hours", perPr(h), hrs],
    ["  machine hours", perPr(m), hrs],
    ["  tokens, M", perPr((p) => p.tok), mln],
    ["  output, K", perPr((p) => p.out), thou],
    ["  cost, $", perPr((p) => p.usd), usd],
    ["  turns", perPr((p) => p.steps), one],
    ["  subagents", perPr((p) => p.agents), one],
    ["  human prompts", perPr((p) => p.prompts), one],
    ["$ per 1M tokens", (p) => (p.usd !== null && p.tok ? p.usd / (p.tok / 1e6) : null), usd],
  ];
  const ratio = ps.length === 2;
  const ratioOf = (f: (p: Period) => number | null) => {
    const [a, b] = [f(ps[0]!), f(ps[1]!)];
    return a && b !== null ? `×${fmtH(b / a, 2)}` : "—";
  };
  const head = ["", ...heads, ...(ratio ? ["after / before"] : [])];
  const rows = lines.map((l) => (typeof l === "string" ? l : [l[0], ...ps.map((p) => {
    const v = l[1](p);
    return v === null ? "—" : l[2](v);
  }), ...(ratio ? [ratioOf(l[1])] : [])]));
  const widths = head.map((x, i) => Math.max(x.length, ...rows.map((r) => (typeof r === "string" ? 0 : r[i]!.length))));
  const fmt = (r: string[]) => r.map((x, i) => (i ? pad(x, widths[i]!, true) : pad(x, widths[0]!))).join("  ").trimEnd();
  const out = [fmt(head), ...rows.map((r) => (typeof r === "string" ? r : fmt(r)))];
  out.push("");
  ps.forEach((p, i) => {
    const shares = usdShares(p.models);
    const unpriced = p.unpriced.length ? `; no price (not in the price list): ${p.unpriced.join(", ")}` : "";
    out.push(`$ by model ${heads[i]}: ${shares.length ? sharesTxt(shares) : "—"}${unpriced}`);
  });
  out.push(`${TARIFF_NOTE}; $ per 1M tokens — the rate shift.`);
  return out;
}

interface PeriodArgs {
  repo?: string;
  periods: [number, number][];
  gap: number;
}

function cmdPeriod(args: PeriodArgs): void {
  if (isCloud()) throw new EstError(CLOUD_ERR);
  const repo = new Repo(resolveRepo(args.repo), loadRegistry());
  const sessions = repo.periodSessions();
  const prs = [...repo.prs().values()];
  console.log(`== ${repo.full}: all of the repository's sessions over the period, without linking to tasks`);
  for (const line of periodTable(args.periods.map(([a, z]) => periodSummary(sessions, prs, a, z, args.gap)))) console.log(line);
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `est — estimates tasks from the project's history and records the actual from Claude Code, Codex and cloud session transcripts.

  est history [--repo o/r] [--grep WORD] [--all-repos] [--last N]
  est fact <N> [--repo o/r] [--write] [--gap 30] [--json]
  est fact --sweep [--since 90d] [--repo o/r] [--write]
  est fact --sweep --model <id> [--since 90d] [--repo o/r] [--write]   — recompute the recorded actuals with this model and their epics
  est estimate <N> [--repo o/r] --type <type> [--mult 0.5|1|1.5|2] [--note "reason"] [--tok-mult 0.5|1|1.5|2|3 [--tok-note "reason"]] [--write]   — the script picks analogs
  est estimate <N> [--repo o/r] --type <type> --analogs a,b[,c] [--mult …] [--note …] [--write]   — analogs by hand
  est estimate <N> [--repo o/r] --type <type> --hours H [--write]   — expert, when there are no analogs
  est backtest [--repo o/r] [--all-repos]   — mechanics vs manual estimates on closed tasks
  est period --since DATE [--until DATE] [--since DATE [--until DATE]] [--repo o/r] [--gap 30]   — all of the repo's sessions over the period; two periods — side by side, «after / before»
  est cloud-import <export.json>...   — cloud session events (SKILL.md, «Cloud session») into the sources of the actual
  <type> — ${EST_TYPES.join(" ")}`;

/** Cloud session exports → the state directory; a summary of each, so that it's visible what landed. */
function cmdCloudImport(files: string[]): void {
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  for (const f of files) {
    let data: Any;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      throw new EstError(`${f}: ${(e as Error).message}`);
    }
    if (!isCloudExport(data)) throw new EstError(`${f}: not a cloud session export (needs session, repo, events — the snippet from SKILL.md est)`);
    const s = parseCloudFile(f);
    const dst = cloudPath(data.repo, data.session);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, JSON.stringify(data));
    const n = data.events.length;
    const span = s.ev.length ? `${hhmm(s.ev[0]![0])}–${hhmm(s.ev[s.ev.length - 1]![0])} UTC` : "no records";
    const title = data.title ? `, «${data.title}»` : "";
    console.log(`${data.session} (${data.repo}${title}): ${n} ${plural(n, "event", "events")}, ${s.n_human} ${plural(s.n_human, "prompt", "prompts")}, ${span} → ${dst}`);
  }
}

function intArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new EstError(`${name}: expected an integer, got «${v}»`);
  return parseInt(v, 10);
}

function floatArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new EstError(`${name}: expected a number, got «${v}»`);
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
      if (!rest.length) throw new EstError("pass the cloud session export files");
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
        options: { repo: { type: "string" }, write: { type: "boolean", default: false }, gap: { type: "string", default: "30" }, json: { type: "boolean", default: false }, sweep: { type: "boolean", default: false }, since: { type: "string", default: "90d" }, model: { type: "string" } },
      });
      if (positionals.length > 1) throw new EstError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      return cmdFact({ number: intArg(positionals[0], "issue number"), repo: values.repo, write: values.write, gap: intArg(values.gap, "--gap")!, json: values.json, sweep: values.sweep, since: values.since, model: values.model });
    }
    if (cmd === "period") {
      const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, since: { type: "string", multiple: true }, until: { type: "string", multiple: true }, gap: { type: "string", default: "30" } } });
      const gap = intArg(values.gap, "--gap")!;
      if (gap < 1) throw new EstError(`--gap must be ≥ 1 minute, got ${gap}`);
      cmdPeriod({ repo: values.repo, periods: parsePeriods(values.since ?? [], values.until ?? []), gap });
      return 0;
    }
    if (cmd === "backtest") {
      const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, "all-repos": { type: "boolean", default: false } } });
      cmdBacktest({ repo: values.repo, allRepos: values["all-repos"] });
      return 0;
    }
    if (cmd === "estimate") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { repo: { type: "string" }, hours: { type: "string" }, type: { type: "string" }, analogs: { type: "string", default: "" }, mult: { type: "string", default: "1" }, note: { type: "string", default: "" }, "tok-mult": { type: "string" }, "tok-note": { type: "string" }, write: { type: "boolean", default: false } },
      });
      const number = intArg(positionals[0], "issue number");
      if (number === undefined) throw new EstError("pass the issue number");
      if (!values.type) throw new EstError(`--type is required: ${EST_TYPES.join(", ")}`);
      cmdEstimate({ number, repo: values.repo, hours: floatArg(values.hours, "--hours"), type: values.type, analogs: values.analogs, mult: floatArg(values.mult, "--mult")!, tokMult: floatArg(values["tok-mult"], "--tok-mult"), tokNote: values["tok-note"], note: values.note, write: values.write });
      return 0;
    }
    throw new EstError(`unknown command «${cmd}»; expected history, fact, estimate, backtest, period or cloud-import`);
  } catch (e) {
    if (e instanceof EstError) die(e.message);
    if (e && typeof e === "object" && (e as Any).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") die((e as Error).message, 2);
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
