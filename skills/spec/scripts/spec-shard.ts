#!/usr/bin/env bun
/**
 * spec-shard — a CI shard's test files by the durations of the last green run, not by the count of tests. A runner's
 * `--shard` doesn't look at time: Playwright cuts the suite in a row by the count of tests in path order, Vitest —
 * files by the hash of the path; the heavy tests of one folder go to one shard, the PR waits for it, the others stand
 * idle. The script lays out the files greedily — the longest into the lightest shard — and prints the shard's filters
 * for the runner, one per line; CI passes them to the runner instead of `--shard`.
 *
 *   bun spec-shard.ts --shard <k>/<n> --runner vitest|playwright --list <file|-> [--report <file>]… [--root DIR]
 *
 * - `--list` — the run's test files: `vitest list --filesOnly --json=<file>`, `playwright test --list --reporter=json`
 *   or one path per line; absolute paths — relative to the root (`--root`, default — the current directory: the runner
 *   reads the filters from it).
 * - `--report` — the last green run's reports, the same formats as for spec-doc (Vitest/Jest JSON, Playwright JSON,
 *   JUnit from `bun test`); a report's path is matched to the listed file it ends with — a report from another machine
 *   works. A missing report file isn't an error: the reports are an artifact of the previous run, and it may be gone.
 *   No durations — the files are split equally by count; a file without a measurement gets the mean.
 * - A filter is what the runner understands: Vitest — the path (it takes a file whose path contains the filter),
 *   Playwright — an escaped regular expression anchored at the end of the path. A filter that also takes another file
 *   (a path inside another path) — both go into one shard: the shard's filters take exactly its files.
 * - The same inputs give the same shards: files and ties — by path, without time or randomness.
 *
 * Codes: 0 — the shard is printed (an empty one too: more shards than files — stdout is empty, CI doesn't start the
 * runner: without filters it would run everything), 2 — a call error (arguments, the list or a report unreadable).
 * Runs under Bun, no dependencies.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDurations } from "./speclib.ts";

const posix = path.posix;

const USAGE = "spec-shard --shard <k>/<n> --runner vitest|playwright --list <file|-> [--report <file>]… [--root DIR]";
/** `--help`, `-h` (tests/standards/cli-help): the synopsis, what it does and examples. */
const HELP = `${USAGE}

A CI shard's test files by the durations of the last green run, not by the count of tests: greedily — the longest file
into the lightest shard; the shard's filters for the runner go to stdout, one per line (an empty shard — nothing).
--list — vitest list --filesOnly --json=<file>, playwright test --list --reporter=json or one path per line; --report —
the last green run's reports (Vitest/Jest JSON, Playwright JSON, JUnit from bun test), a missing one is skipped; no
durations — the files are split equally by count, a file without a measurement gets the mean. Code 2 — a call error.

Examples:
  spec-shard --shard 2/3 --runner vitest --list .spec-files.json --report .spec-last/.spec-report.json
  spec-shard --shard 1/2 --runner playwright --list .spec-files.json --report .spec-last/.spec-playwright.json`;

const RUNNERS = ["vitest", "playwright"] as const;
type Runner = (typeof RUNNERS)[number];

class Fail extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The run's test files from the list: paths relative to the root, without repeats, by path. */
function listed(file: string, roots: string[]): string[] {
  let text: string;
  try {
    text = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (e) {
    throw new Fail(`--list ${file}: ${(e as Error).message}`, 2);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined; // not JSON — one path per line
  }
  let paths: string[];
  if (Array.isArray(data)) {
    // vitest list --json: [{ file }], with --filesOnly too
    paths = data.map((x) => (typeof x === "string" ? x : str((x as Json | null)?.file)));
  } else if (data && typeof data === "object" && "suites" in data && "config" in data) {
    // playwright test --list --reporter=json: a file's suite — the path relative to config.rootDir
    const d = data as Json;
    const rootDir = str((d.config as Json | null)?.rootDir).replace(/\\/g, "/");
    paths = (Array.isArray(d.suites) ? (d.suites as Json[]) : []).map((s) => {
      const f = (str(s.file) || str(s.title)).replace(/\\/g, "/");
      return rootDir ? posix.join(rootDir, f) : f;
    });
  } else if (data !== undefined) {
    throw new Fail(`--list ${file}: unknown format (expected vitest list --json, playwright test --list --reporter=json or one path per line)`, 2);
  } else {
    paths = text.split("\n");
  }
  const out = new Set<string>();
  for (const raw of paths) {
    const p = raw.trim().replace(/\\/g, "/");
    if (p) out.add(relative(p, roots));
  }
  return [...out].sort();
}

/** A path from the list — relative to the root; the root is given as is and as the real path (a symlink in it). */
function relative(p: string, roots: string[]): string {
  if (!posix.isAbsolute(p)) return posix.normalize(p);
  for (const root of roots) {
    const rel = posix.relative(root, p);
    if (rel && rel !== ".." && !rel.startsWith("../")) return rel;
  }
  throw new Fail(`${p}: outside the root ${roots[0]} — run from the repository root or pass --root`, 2);
}

/**
 * The listed files' durations, ms. A report's path goes to the listed file it ends with (the longest such); several
 * paths of one report end with one listed file — the shortest is that file, the others lie deeper, in a directory the
 * list doesn't have. A file in several reports — the longest duration: the same report passed twice doesn't double it.
 */
function durations(files: string[], reports: string[]): Map<string, number> {
  const byName = new Map<string, string[]>();
  for (const f of files) byName.set(posix.basename(f), [...(byName.get(posix.basename(f)) ?? []), f]);
  const out = new Map<string, number>();
  for (const report of reports) {
    if (!existsSync(report)) {
      console.error(`spec-shard: no report ${report} — no durations from it`);
      continue;
    }
    let found: Map<string, number>;
    try {
      found = loadDurations(report);
    } catch (e) {
      throw new Fail(`--report ${(e as Error).message}`, 2);
    }
    const mine = new Map<string, { length: number; ms: number }>();
    for (const [p, ms] of found) {
      const f = (byName.get(posix.basename(p)) ?? []).filter((l) => p === l || p.endsWith("/" + l)).sort((a, b) => b.length - a.length)[0];
      if (!f) continue;
      const seen = mine.get(f);
      if (!seen || p.length < seen.length) mine.set(f, { length: p.length, ms });
    }
    for (const [f, { ms }] of mine) out.set(f, Math.max(out.get(f) ?? 0, ms));
  }
  return out;
}

/**
 * Does the filter of file `a` also take file `b` — by the runner's matching of a filter against a path.
 *
 * - Vitest (`filterFiles` in `vitest/node`) takes a file whose path relative to its project's root contains the filter
 *   or the filter's path relative to that root, case-insensitively; the project root isn't known here — any directory
 *   common to both paths is tried.
 * - Playwright tests the regular expression against the absolute path: `(^|/)<a>$` takes a file whose path ends with
 *   `/<a>`.
 */
function takes(runner: Runner, a: string, b: string, root: string): boolean {
  if (runner === "playwright") return `${root}/${b}`.endsWith(`/${a}`);
  const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
  if (!lb.includes(posix.basename(la))) return false;
  for (let i = 0; ; ) {
    if (lb.slice(i).includes(la.slice(i))) return true;
    const j = la.indexOf("/", i);
    if (j < 0 || lb.slice(0, j + 1) !== la.slice(0, j + 1)) return false;
    i = j + 1;
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The runner's filter of a file: it takes the file and at most files of its group (`groupsOf`). */
function filterOf(runner: Runner, file: string): string {
  return runner === "playwright" ? `/(^|\\/)${escapeRe(file)}$/` : file;
}

/** Files whose filters take one another — groups (a union of the "takes" relation), each by path. */
function groupsOf(runner: Runner, files: string[], root: string): string[][] {
  const parent = files.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < files.length; i++)
    for (let j = 0; j < files.length; j++) if (i !== j && takes(runner, files[i]!, files[j]!, root)) parent[find(j)] = find(i);
  const groups = new Map<number, string[]>();
  files.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));
  return [...groups.values()];
}

/**
 * Greedy layout: groups from the heaviest into the lightest shard (ties — the first). The sort is stable: groups of one
 * weight stay in path order — the list is sorted.
 */
function layout(groups: { files: string[]; weight: number }[], n: number): { files: string[]; load: number }[] {
  const shards = Array.from({ length: n }, () => ({ files: [] as string[], load: 0 }));
  const order = [...groups].sort((x, y) => y.weight - x.weight);
  for (const g of order) {
    const lightest = shards.reduce((best, s) => (s.load < best.load ? s : best));
    lightest.files.push(...g.files);
    lightest.load += g.weight;
  }
  return shards;
}

const sec = (ms: number): string => `${Math.round(ms / 1000)} s`;

export function main(argv: string[]): number {
  try {
    let opts;
    try {
      opts = parseArgs({
        args: argv,
        options: {
          shard: { type: "string" },
          runner: { type: "string" },
          list: { type: "string" },
          report: { type: "string", multiple: true, default: [] },
          root: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (e) {
      throw new Fail(`${(e as Error).message}\n${USAGE}`, 2);
    }
    const v = opts.values;
    if (v.help) return console.log(HELP), 0;
    const m = /^(\d+)\/(\d+)$/.exec(v.shard ?? "");
    const [k, n] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
    if (!m || k < 1 || k > n) throw new Fail(`--shard: <k>/<n> with 1 ≤ k ≤ n is needed, not «${v.shard ?? ""}»\n${USAGE}`, 2);
    if (!RUNNERS.includes(v.runner as Runner)) throw new Fail(`--runner: ${RUNNERS.join(" or ")}, not «${v.runner ?? ""}»\n${USAGE}`, 2);
    const runner = v.runner as Runner;
    if (!v.list) throw new Fail(`--list <file|-> is required\n${USAGE}`, 2);
    const root = path.resolve(v.root ?? process.cwd()).replace(/\\/g, "/");
    if (!existsSync(root)) throw new Fail(`--root ${root}: no such directory`, 2);
    const real = realpathSync(root).replace(/\\/g, "/");

    const files = listed(v.list, [root, real]);
    const measured = durations(files, v.report);
    const known = [...measured.values()];
    // no durations at all — every file weighs the same: the split is by count
    const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const weight = (f: string): number => measured.get(f) ?? mean;
    const groups = groupsOf(runner, files, real).map((g) => ({ files: g, weight: g.reduce((s, f) => s + weight(f), 0) }));
    for (const g of groups)
      if (g.files.length > 1) console.error(`spec-shard: one shard for ${g.files.join(", ")} — the filter of one also takes another`);
    const shards = layout(groups, n);
    const mine = shards[k - 1]!;
    const total = shards.reduce((s, x) => s + x.load, 0);
    const count = `shard ${k}/${n} — ${mine.files.length} of ${files.length} files`;
    if (!known.length) console.error(`spec-shard: no durations of the last green run — the files are split equally by count; ${count}`);
    else {
      const unknown = files.filter((f) => !measured.has(f)).length;
      console.error(`spec-shard: ${count}, ${sec(mine.load)} of ${sec(total)} by the last green run${unknown ? `; ${unknown} without a measurement — the mean, ${sec(mean)}` : ""}`);
    }
    const out = [...mine.files].sort().map((f) => filterOf(runner, f));
    if (out.length) process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (e) {
    console.error(`spec-shard: ${(e as Error).message}`);
    return e instanceof Fail ? e.code : 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
