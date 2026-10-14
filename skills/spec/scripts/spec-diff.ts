#!/usr/bin/env bun
/**
 * spec-diff — the spec diff: test names (folder path + describe + it) between the base branch and HEAD, by static
 * parsing of the files at the two revisions (git cat-file, no runs and no checkouts). Prints a markdown section for the
 * PR body: removed (first), changed (renamed in the same file), added, moved into the tree (a test vanished from a file
 * outside tests/ and appeared in the tree under the same name — a summary by folders); plus test files changed outside
 * the tests/ tree and the number of the PR's new names that aren't statements in the project language.
 *
 *   bun spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--root DIR] [--no-merge-base] [--json]
 *                    [--scenarios issue.md | -]
 *
 * --scenarios — the task body (markdown, `-` — stdin): the scenarios section ("## Scenarios" or its heading in any
 * dictionary language) is matched against added and changed tests and against the describes of new harness checks — a
 * scenario that became a test or a check, an undone scenario and tests beyond the scenarios.
 *
 * The section is in the root's project language (`language` in `.agents/ai-dev.json`, the github skill's dictionary).
 * The default base is the merge-base of the base branch and HEAD (like a PR diff on GitHub). Runs on Bun; needs git.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import locale from "../../github/scripts/locale.ts";
import type { Names } from "../../github/scripts/locale.ts";
import { disablesIn } from "./harness.ts";
import * as L from "./speclib.ts";
import type { Test } from "./speclib.ts";

// the project language and its names: the PR section is in it; main sets it from the root
let LANG = locale.DEFAULT_LANGUAGE;
let N: Names = locale.names(LANG);

/** Below this similarity it's not a rename but a removed and a new requirement: let it be visible. */
export const RENAME_RATIO = 0.6;

function git(args: string[], cwd: string, input?: string): Buffer {
  const r = spawnSync("git", args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString("utf8").trim()}`);
  return r.stdout;
}

const gitText = (args: string[], cwd: string): string => git(args, cwd).toString("utf8");

function findRoot(root?: string): { top: string; root: string; prefix: string } {
  const abs = path.resolve(root ?? process.cwd());
  const top = gitText(["rev-parse", "--show-toplevel"], abs).trim();
  const rel = path.relative(top, abs).replace(/\\/g, "/");
  return { top, root: abs, prefix: rel === "" ? "" : rel + "/" };
}

const wanted = (rel: string) => L.isTestFile(rel) && L.classify(rel)[0] !== "lib";

/**
 * A copy of the ai-dev flow (`.agents/`, `.claude/` from the root) isn't project code: `install` puts it there, nobody
 * edits it by hand, the project's linters don't see it. Its tests and lint disables aren't project decisions and don't
 * go into the spec diff.
 */
const FLOW_COPY = /^\.(?:agents|claude)\//;

/**
 * {path relative to the root: source} for the test files of the tests/ tree at a revision (without lib).
 * The contents come from one `git cat-file --batch`, not `git show` per file: in a repository with hundreds of test
 * files that's two processes instead of hundreds.
 */
function testsAtRev(rev: string, top: string, prefix: string): Map<string, string> {
  const list = gitText(["ls-tree", "-r", "--name-only", "-z", rev, "--", prefix + L.TESTS], top);
  const paths = list.split("\0").filter((p) => p && p.startsWith(prefix) && wanted(p.slice(prefix.length)));
  return filesAtRev(rev, top, prefix, paths);
}

/** {path relative to the root: source} for paths from the git root at a revision; no file — no key either. */
function filesAtRev(rev: string, top: string, prefix: string, paths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  if (!paths.length) return files;
  const buf = git(["cat-file", "--batch"], top, paths.map((p) => `${rev}:${p}\n`).join(""));
  // the reply per object: `<sha> <type> <size>\n<contents>\n`; no object — `<rev>:<path> missing\n`
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.toString("utf8", pos, nl);
    pos = nl + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    files.set(p.slice(prefix.length), buf.toString("utf8", pos, pos + size));
    pos += size + 1;
  }
  return files;
}

function testsInWorktree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const fn of names) {
      const full = path.join(dir, fn);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (wanted(rel)) files.set(rel, readFileSync(full, "utf8"));
    }
  };
  walk(path.join(root, L.TESTS));
  return files;
}

// a name that can't be computed — a stderr line once: the same test is both in the base and in the head
const unnamedSeen = new Set<string>();

/** A harness check in a test file: the call from parsing and the file path. */
export type Check = L.HarnessCall & { path: string };

/**
 * Tests and harness checks of files; a file that can't be parsed and a test whose name can't be computed statically —
 * a line in stderr.
 */
function parseFiles(files: Map<string, string>, label: string): { tests: Test[]; checks: Check[] } {
  const tests: Test[] = [];
  const checks: Check[] = [];
  for (const file of [...files.keys()].sort()) {
    try {
      const scan = L.scanJs(file, files.get(file)!);
      tests.push(...scan.tests);
      checks.push(...scan.checks.map((c) => ({ ...c, path: file })));
      for (const u of scan.unnamed) {
        const key = JSON.stringify([file, u.kind, u.name]);
        if (unnamedSeen.has(key)) continue;
        unnamedSeen.add(key);
        console.error(`spec-diff: ${label}: ${file}:${u.line}: the ${u.kind} name can't be computed statically (${u.name}) — the test isn't in the lists`);
      }
    } catch (e) {
      console.error(`spec-diff: ${label}: ${file}: ${(e as Error).message}`);
    }
  }
  return { tests, checks };
}

/** Test files changed outside tests/ (including untracked ones with --worktree), except the flow copy. */
function outOfTreeFiles(base: string, head: string, top: string, prefix: string, worktree: boolean): string[] {
  const spec = ["--", ".", `:(exclude)${prefix}${L.TESTS}`];
  const changed = worktree
    ? gitText(["diff", "--name-only", "-z", base, ...spec], top) + gitText(["ls-files", "--others", "--exclude-standard", "-z", ...spec], top)
    : gitText(["diff", "--name-only", "-z", base, head, ...spec], top);
  const out = new Set<string>();
  for (const p of changed.split("\0")) {
    const rel = p.slice(prefix.length);
    if (p && p.startsWith(prefix) && L.isTestFile(rel) && !FLOW_COPY.test(rel)) out.add(rel);
  }
  return [...out].sort();
}

/** A test outside the tree at the base that vanished from its file: a candidate for moved. */
export interface Moved {
  test: Test; // the test in the tree, the path is new
  from: string; // the file outside the tree at the base
}

/**
 * Tests of files outside the tree changed in the PR: they were there at the base, at HEAD they're gone from the same
 * file (the file was deleted or the test was removed from it). Only they can count as moved: a test that stayed in
 * place is the source of a copy, not of a move. `count` — how many tests the file had at the base.
 */
function outOfTreePool(
  base: string,
  head: string,
  top: string,
  root: string,
  prefix: string,
  outFiles: string[],
  worktree: boolean,
): { pool: Test[]; count: Map<string, number>; gone: Set<string> } {
  const pool: Test[] = [];
  const count = new Map<string, number>();
  const gone = new Set<string>();
  if (!outFiles.length) return { pool, count, gone };
  const baseFiles = filesAtRev(base, top, prefix, outFiles.map((f) => prefix + f));
  let headFiles: Map<string, string>;
  if (worktree) {
    headFiles = new Map();
    for (const f of outFiles) {
      const full = path.join(root, f);
      if (existsSync(full)) headFiles.set(f, readFileSync(full, "utf8"));
    }
  } else {
    headFiles = filesAtRev(head, top, prefix, outFiles.map((f) => prefix + f));
  }
  const nameKey = (t: Test) => JSON.stringify([t.describes, t.name]);
  for (const f of outFiles) {
    const src = baseFiles.get(f);
    if (src === undefined) continue;
    const baseTests = parseFiles(new Map([[f, src]]), "base").tests;
    count.set(f, baseTests.length);
    if (!headFiles.has(f)) gone.add(f);
    const left = new Map<string, number>();
    for (const t of parseFiles(new Map([[f, headFiles.get(f) ?? ""]]), "HEAD").tests) left.set(nameKey(t), (left.get(nameKey(t)) ?? 0) + 1);
    for (const t of baseTests) {
      const k = nameKey(t);
      const n = left.get(k) ?? 0;
      if (n > 0) left.set(k, n - 1);
      else pool.push(t);
    }
  }
  return { pool, count, gone };
}

/** String similarity by Ratcliff/Obershelp (like difflib.SequenceMatcher.ratio without heuristics). */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  return (2 * matching(a, b)) / (a.length + b.length);
}

function matching(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let best = 0;
  let bi = 0;
  let bj = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) {
      if (a[i] === b[j]) {
        cur[j + 1] = prev[j]! + 1;
        if (cur[j + 1]! > best) {
          best = cur[j + 1]!;
          bi = i + 1 - best;
          bj = j + 1 - best;
        }
      }
    }
    prev = cur;
  }
  if (!best) return 0;
  return best + matching(a.slice(0, bi), b.slice(0, bj)) + matching(a.slice(bi + best), b.slice(bj + best));
}

/** Greedy matching by descending similarity; deterministic (ties are broken by order). */
function pair(
  removed: Test[],
  added: Test[],
  cond: (r: Test, a: Test) => boolean,
  score: (r: Test, a: Test) => number,
  threshold: number,
): [Test, Test][] {
  const cands: [number, number, number][] = [];
  removed.forEach((r, i) => {
    added.forEach((a, j) => {
      if (!cond(r, a)) return;
      const sc = score(r, a);
      if (sc >= threshold) cands.push([-sc, i, j]);
    });
  });
  cands.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const usedR = new Set<number>();
  const usedA = new Set<number>();
  const pairs: [Test, Test][] = [];
  for (const [, i, j] of cands) {
    if (usedR.has(i) || usedA.has(j)) continue;
    usedR.add(i);
    usedA.add(j);
    pairs.push([removed[i]!, added[j]!]);
  }
  removed.splice(0, removed.length, ...removed.filter((_, i) => !usedR.has(i)));
  added.splice(0, added.length, ...added.filter((_, j) => !usedA.has(j)));
  return pairs;
}

/** A body with no check: `() => {}`, `async () => {}`, `function () {}` — without spaces, as in `Test.body`. */
const EMPTY_BODY = /^,(?:async)?(?:\([^)]*\)=>|function\w*\([^)]*\))\{\}$/;

/**
 * The body for matching — without trailing commas before `)`, `]`, `}` and after the last argument: prettier adds them
 * when it wraps a call with a long name, and in a body the wrap shifted to the right (#324). The check doesn't change
 * because of them, while the exact body would split a rename into "removed" and "added".
 */
const plainBody = (body: string) => body.replace(/,(?=[)\]}]|$)/g, "");

const sameDescribes = (r: Test, a: Test) => r.describes.length === a.describes.length && r.describes.every((d, i) => d === a.describes[i]);

export function diff(
  baseTests: Test[],
  headTests: Test[],
  pool: Test[] = [],
): { removed: Test[]; changed: [Test, Test][]; added: Test[]; moved: Moved[] } {
  const b = new Map<string, Test>();
  const h = new Map<string, Test>();
  for (const t of baseTests) if (!b.has(L.keyOf(t))) b.set(L.keyOf(t), t);
  for (const t of headTests) if (!h.has(L.keyOf(t))) h.set(L.keyOf(t), t);
  const removed = [...b.entries()].filter(([k]) => !h.has(k)).map(([, t]) => t);
  let added = [...h.entries()].filter(([k]) => !b.has(k)).map(([, t]) => t);
  // 0) the same name and describe as a test that vanished outside the tree — moved into the tree, not new.
  // An exact match, no similarity: a test renamed during the move is honestly "added".
  const from = new Map<string, Test[]>();
  for (const t of pool) {
    const k = JSON.stringify([t.describes, t.name]);
    from.set(k, [...(from.get(k) ?? []), t]);
  }
  // All HEAD tests go, not one per key: identical tests of two files moved into one folder are one requirement
  // there, but both are moved, and the source files are moved whole.
  const moved: Moved[] = [];
  const movedKeys = new Set<string>();
  for (const t of headTests) {
    if (b.has(L.keyOf(t))) continue;
    const src = from.get(JSON.stringify([t.describes, t.name]))?.shift();
    if (!src) continue;
    moved.push({ test: t, from: src.path });
    movedKeys.add(L.keyOf(t));
  }
  added = added.filter((a) => !movedKeys.has(L.keyOf(a)));
  // 1) the same file and the same body, unique in the file among the removed and among the new — the test is renamed,
  // even if both the describe and the name changed (turning names into statements). An empty body isn't a sign: it
  // has no check
  const bodyKey = (t: Test) => {
    const body = t.body && plainBody(t.body);
    return body && !EMPTY_BODY.test(body) ? JSON.stringify([t.path, body]) : "";
  };
  const once = (list: Test[]) => {
    const n = new Map<string, number>();
    for (const t of list) if (bodyKey(t)) n.set(bodyKey(t), (n.get(bodyKey(t)) ?? 0) + 1);
    return n;
  };
  const [inRemoved, inAdded] = [once(removed), once(added)];
  const unique = (t: Test) => !!bodyKey(t) && inRemoved.get(bodyKey(t)) === 1 && inAdded.get(bodyKey(t)) === 1;
  const changed = pair(removed, added, (r, a) => unique(r) && bodyKey(r) === bodyKey(a), () => 1, 1);
  // 2) the same file and describe, a similar name — the test is renamed
  changed.push(...pair(removed, added, (r, a) => r.path === a.path && sameDescribes(r, a), (r, a) => ratio(r.name, a.name), RENAME_RATIO));
  // 3) the same folder and name, a different describe — the describe is renamed or the test moved to another section,
  // including from another file of the folder: the requirement text is the same, the section changed
  changed.push(
    ...pair(
      removed,
      added,
      (r, a) => L.folderOf(r) === L.folderOf(a) && r.name === a.name,
      (r, a) => ratio(r.describes.join(" › "), a.describes.join(" › ")),
      0,
    ),
  );
  return { removed, changed, added, moved };
}

/**
 * Files outside the tree not moved whole: one moved whole (deleted, all its tests found a pair in the tree) is only a
 * number in the summary; the rest are named: some of their tests found no pair, so something was renamed or lost in
 * the move.
 */
export function unmovedFiles(outFiles: string[], moved: Moved[], count: Map<string, number>, gone: Set<string>): string[] {
  const n = new Map<string, number>();
  for (const m of moved) n.set(m.from, (n.get(m.from) ?? 0) + 1);
  return outFiles.filter((f) => !(gone.has(f) && (count.get(f) ?? 0) > 0 && n.get(f) === count.get(f)));
}

const outMark = (t: Test) => (L.classify(t.path)[0] === "out" ? ` ⚠️ ${N.spec.diff.outsideMark}` : "");
const entry = (t: Test) => `- \`${L.folderOf(t)}\` · ${L.titleOf(t)}${outMark(t)}`;

function changedEntry([o, n]: [Test, Test]): string {
  const md = (parts: string[]) => parts.map(L.mdText).join(" › ");
  if (sameDescribes(o, n)) {
    const prefix = n.describes.length ? md(n.describes) + " › " : "";
    return `- \`${L.folderOf(n)}\` · ${prefix}~~${L.mdText(o.name)}~~ → ${L.mdText(n.name)}${outMark(n)}`;
  }
  // both the describe and the name changed (or there was no describe) — the old name is struck through whole
  if (o.name !== n.name || !o.describes.length) return `- \`${L.folderOf(n)}\` · ~~${L.titleOf(o)}~~ → ${L.titleOf(n)}${outMark(n)}`;
  return `- \`${L.folderOf(n)}\` · ~~${md(o.describes)}~~ → ${md(n.describes)} › ${L.mdText(n.name)}${outMark(n)}`;
}

/** Move summary: per folder — how many tests and from how many files outside the tree; per test — only in --json. */
function movedLines(moved: Moved[]): string[] {
  const byFolder = new Map<string, { tests: number; files: Set<string> }>();
  for (const m of moved) {
    const g = byFolder.get(L.folderOf(m.test)) ?? { tests: 0, files: new Set<string>() };
    g.tests++;
    g.files.add(m.from);
    byFolder.set(L.folderOf(m.test), g);
  }
  const files = new Set(moved.map((m) => m.from)).size;
  const fileWord = (n: number) => locale.count(LANG, N.spec.diff.files, n);
  const folderLine = (f: string) => {
    const g = byFolder.get(f)!;
    return `- \`${f}\` — ${locale.fill(N.spec.diff.movedFolder, { tests: L.testsWord(LANG, g.tests), files: fileWord(g.files.size) })}`;
  };
  return [locale.fill(N.spec.diff.moved, { n: moved.length, tests: L.TESTS, files: fileWord(files) }), "", ...[...byFolder.keys()].sort().map(folderLine), ""];
}

// ---------- decisions outside test names: the model, exceptions, harness checks ----------

/** Decisions of one kind at a revision — lines for a list; removed and added are the difference of lines. */
export interface Decisions {
  model: string[];
  exceptions: string[];
  checks: string[];
}

/** A project data module (model, exceptions) from text: .json — parsed, TS/JS — imported from a temporary file. */
async function loadData(text: string, file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(text);
  const dir = mkdtempSync(path.join(os.tmpdir(), "spec-diff-"));
  try {
    const f = path.join(dir, "data" + path.extname(file));
    writeFileSync(f, text);
    return ((await import(pathToFileURL(f).href)) as { default?: unknown }).default;
  } catch {
    return undefined; // a model with imports beyond the file can't be read statically — the model's decisions aren't shown
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type ModelData = { modules?: Record<string, { dependsOn?: string[]; packages?: string[] }> };

/** Model → "module X", "dependency X → Y", "package P of module X": by kind, by name within a kind. */
export function modelFacts(m: ModelData | undefined): string[] {
  const mods = Object.keys(m?.modules ?? {}).sort();
  const at = (n: string) => m!.modules![n]!;
  return [
    ...mods.map((n) => locale.fill(N.spec.diff.modelModule, { module: n })),
    ...mods.flatMap((n) => [...(at(n).dependsOn ?? [])].sort().map((d) => locale.fill(N.spec.diff.modelDependency, { from: n, to: d }))),
    ...mods.flatMap((n) => [...(at(n).packages ?? [])].sort().map((p) => locale.fill(N.spec.diff.modelPackage, { package: p, module: n }))),
  ];
}

/**
 * What a harness call checks: `registry "mutations"`, `rule no-console`, `code without a consumer (production)`,
 * `architecture model`; a registry or a rule that can't be computed without a run — only the kind.
 */
const checkLabel = (call: string, value: string | null): string => {
  const named = (template: string) => locale.fill(template, { value: value! });
  if (call === "invariant") return value === null ? N.spec.diff.registry : named(N.spec.diff.registryNamed);
  if (call === "examples") return value === null ? N.spec.diff.rule : named(N.spec.diff.ruleNamed);
  if (call === "deadCode") return value === null ? N.spec.diff.deadCode : named(N.spec.diff.deadCodeNamed);
  return N.spec.diff.architecture;
};

// a check named by a call option: without a computable registry or rule it can't be named in the decisions list
const NAMED_BY_OPTION = new Set(["invariant", "examples"]);

/** Harness checks in test sources (file parsing — `parseFiles`): registries, rules, deadCode runs, the model. */
export function checkFacts(checks: Check[]): string[] {
  const out = new Set<string>();
  for (const c of checks) {
    if (c.value === null && NAMED_BY_OPTION.has(c.call)) continue;
    out.add(`\`${path.posix.dirname(c.path)}\` · ${checkLabel(c.call, c.value)}`);
  }
  return [...out].sort();
}

/**
 * A describe with harness checks — a scenario of the "registry + invariant" standard: the folder, the describe chain
 * and what they check.
 */
export interface HarnessDescribe {
  folder: string;
  describes: string[];
  checks: string[];
}

/**
 * A describe with a harness check it didn't have at the base (the describe is new or renamed, the registry or the rule
 * changed): like new and renamed tests, only it closes a scenario. A call outside a describe has nothing to name it
 * by — it's skipped.
 */
export function freshChecks(base: Check[], head: Check[]): HarnessDescribe[] {
  const group = (checks: Check[]) => {
    const out = new Map<string, HarnessDescribe>();
    for (const c of checks) {
      if (!c.describes.length) continue;
      const folder = path.posix.dirname(c.path);
      const k = JSON.stringify([folder, c.describes]);
      const g = out.get(k) ?? { folder, describes: c.describes, checks: [] };
      if (!g.checks.includes(checkLabel(c.call, c.value))) g.checks.push(checkLabel(c.call, c.value));
      out.set(k, g);
    }
    return out;
  };
  const was = group(base);
  return [...group(head)].filter(([k, g]) => g.checks.some((c) => !was.get(k)?.checks.includes(c))).map(([, g]) => ({ ...g, checks: g.checks.sort() }));
}

/**
 * Describes of new tests from the report with no harness call in the sources: the tests are written not by the runner
 * but by a script after the run (the spec-claims report) — the check is visible only in the report, and these tests
 * close the scenario with its name. A describe with a harness call in the sources is `freshChecks`' job: a new registry
 * item in an old check doesn't close a scenario.
 */
export function reportedChecks(fresh: Test[], generated: Set<Test>, sourced: Check[]): HarnessDescribe[] {
  const key = (folder: string, describes: string[]) => JSON.stringify([folder, describes]);
  const inSource = new Set(sourced.map((c) => key(path.posix.dirname(c.path), c.describes)));
  const out = new Map<string, HarnessDescribe>();
  for (const t of fresh) {
    const k = key(L.folderOf(t), t.describes);
    if (!generated.has(t) || !t.describes.length || inSource.has(k)) continue;
    out.set(k, { folder: L.folderOf(t), describes: t.describes, checks: [N.spec.diff.fromReport] });
  }
  return [...out.values()];
}

// the exceptions file — by the exceptionFile rule (speclib), as the harness reads it: exceptions/<item>.json — a harness
// exception; the former exceptions.* — an array (the base revision of the move is still on it); a misplaced file isn't
// read as an exception — we don't show it either
const readable = (rel: string) => {
  const x = L.exceptionFile(rel);
  return x && !x.error ? x : null;
};

/** exceptions.* entry: a harness registry item, `rule` — a convention. */
type ExceptionEntry = { item: string; rule?: string; issue: number; reason: string };

/** Exception line: what's excepted, the task and the reason — each entry has its own, identical ones aren't merged. */
function exceptionLine(folder: string, e: ExceptionEntry): string {
  return `\`${folder}\` · ${e.item} (${e.rule ? `${e.rule}, ` : ""}#${e.issue}) — ${e.reason}`;
}
const CODE = /\.[cm]?[jt]sx?$/;

/** Files at a revision (null — the working tree) by paths from the git root: path without the prefix → text. */
function readFiles(rev: string | null, top: string, prefix: string, paths: string[]): Map<string, string> {
  if (rev !== null) return filesAtRev(rev, top, prefix, paths);
  const out = new Map<string, string>();
  for (const p of paths) {
    try {
      out.set(p.slice(prefix.length), readFileSync(path.join(top, p), "utf8"));
    } catch {
      /* the file isn't in the working tree */
    }
  }
  return out;
}

/**
 * Decisions at a revision: the model, exceptions (exceptions/ and exceptions.* in tests/, lint disables in changed
 * files), checks.
 */
async function decisionsAt(rev: string | null, top: string, prefix: string, changedCode: string[], checks: Check[]): Promise<Decisions> {
  const listed = rev !== null ? gitText(["ls-tree", "-r", "--name-only", "-z", rev, "--", prefix + L.TESTS], top).split("\0") : [];
  const excPaths =
    rev !== null
      ? listed.filter((p) => p.startsWith(prefix) && readable(p.slice(prefix.length)))
      : walkTests(path.join(top, prefix, L.TESTS)).filter((p) => readable(p)).map((p) => prefix + p);
  const modelPath = `${prefix}${L.TESTS}/architecture/model.ts`;
  const files = readFiles(rev, top, prefix, [modelPath, ...excPaths, ...changedCode]);
  const model = files.has(`${L.TESTS}/architecture/model.ts`) ? ((await loadData(files.get(`${L.TESTS}/architecture/model.ts`)!, modelPath)) as ModelData) : undefined;
  const exceptions: string[] = [];
  for (const p of excPaths) {
    const rel = p.slice(prefix.length);
    const { folder, legacy } = readable(rel)!;
    if (!legacy) {
      const data = await loadData(files.get(rel) ?? "null", rel).catch(() => null);
      if (data && typeof data === "object") exceptions.push(exceptionLine(folder, data as ExceptionEntry));
      continue;
    }
    const data = await loadData(files.get(rel) ?? "[]", rel);
    for (const e of Array.isArray(data) ? (data as ExceptionEntry[]) : []) exceptions.push(exceptionLine(folder, e));
  }
  for (const p of changedCode) {
    const rel = p.slice(prefix.length);
    const text = files.get(rel);
    if (!text || !text.includes("eslint-disable")) continue;
    for (const d of disablesIn(rel, text)) exceptions.push(`\`${rel}\` · ${d.rules.join(", ") || N.spec.lint.allRules} — ${d.description || N.spec.lint.noReason}`);
  }
  return { model: modelFacts(model), exceptions: exceptions.sort(), checks: checkFacts(checks) };
}

function walkTests(dir: string, rel = L.TESTS): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) out.push(...walkTests(path.join(dir, e.name), `${rel}/${e.name}`));
    else out.push(`${rel}/${e.name}`);
  }
  return out;
}

/**
 * Difference with repeats: identical lines are separate entries (two identical lint disables); one removed — one in
 * the difference.
 */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(x) ?? 0;
    left.set(x, n - 1);
    return n <= 0;
  });
}

/**
 * Decision lines above the threshold — a count per folder or file (the line's first code span), for the model — per
 * kind ("module", "package").
 */
function grouped(items: string[]): string[] {
  const n = new Map<string, number>();
  for (const x of items) {
    const k = /^`[^`]+`/.exec(x)?.[0] ?? x.split(" ")[0]!;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.keys()].sort().map((k) => `- ${k} — ${n.get(k)}`);
}

/**
 * Removed and added decisions by kind — sections for the PR body; no changes of a kind — no section; above the
 * threshold — a summary.
 */
export function decisionLines(base: Decisions, head: Decisions, limit = Infinity): string[] {
  const lines: string[] = [];
  const kinds: [string, keyof Decisions][] = [
    [N.spec.diff.modelTitle, "model"],
    [N.spec.diff.exceptionsTitle, "exceptions"],
    [N.spec.diff.checksTitle, "checks"],
  ];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    if (items.length > limit) lines.push(locale.fill(N.spec.diff.summarized, { title, n: items.length }), "", ...grouped(items), "");
    else lines.push(`**${title} (${items.length}):**`, "", ...items.map((x) => `- ${L.mdText(x)}`), "");
  };
  for (const [title, k] of kinds) {
    section(locale.fill(N.spec.diff.removedKind, { title }), minus(base[k], head[k]));
    section(locale.fill(N.spec.diff.addedKind, { title }), minus(head[k], base[k]));
  }
  return lines;
}

/**
 * Default summary threshold: with more tests in the lists (removed, changed, added) the PR body gets a summary by
 * folders.
 */
export const SUMMARY_LIMIT = 100;

/** Summary by folders: the number removed, changed and added; with a runner report — how many the harness generated. */
function summaryLines(removed: Test[], changed: [Test, Test][], added: Test[], limit: number, harness?: Set<Test>): string[] {
  type Row = { removed: number; changed: number; added: number; harness: number };
  const rows = new Map<string, Row>();
  const row = (t: Test) => {
    const f = L.folderOf(t);
    if (!rows.has(f)) rows.set(f, { removed: 0, changed: 0, added: 0, harness: 0 });
    return rows.get(f)!;
  };
  const count = (ts: Test[], k: "removed" | "changed" | "added") => {
    for (const t of ts) {
      const r = row(t);
      r[k]++;
      if (harness?.has(t)) r.harness++;
    }
  };
  count(removed, "removed");
  count(changed.map(([, n]) => n), "changed");
  count(added, "added");
  const total = removed.length + changed.length + added.length;
  const cols = (r: Row) => [r.removed, r.changed, r.added, ...(harness ? [r.harness] : [])].join(" | ");
  const sum = [...rows.values()].reduce((a, r) => ({ removed: a.removed + r.removed, changed: a.changed + r.changed, added: a.added + r.added, harness: a.harness + r.harness }));
  return [
    locale.fill(N.spec.diff.summary, { tests: L.testsWord(LANG, total), limit }),
    "",
    `| ${N.spec.diff.folder} | ${N.spec.diff.removed} | ${N.spec.diff.changed} | ${N.spec.diff.added} |${harness ? ` ${N.spec.diff.harnessColumn} |` : ""}`,
    `|---|--:|--:|--:|${harness ? "--:|" : ""}`,
    ...[...rows.keys()].sort().map((f) => `| \`${f}\` | ${cols(rows.get(f)!)} |`),
    `| **${N.spec.diff.total}** | ${cols(sum)} |`,
    "",
  ];
}

/** More tests in the lists than the threshold — a summary by folders instead of the lists. */
const summarized = (removed: Test[], changed: [Test, Test][], added: Test[], limit: number) => removed.length + changed.length + added.length > limit;

/**
 * Names the PR brings in that aren't statements in the project language: `it` and `describe` names of new and renamed
 * tests that the same file didn't have at the base — per file, without repeats. Not an error (#447): a number in the PR
 * body, spec-doc names each one in a warning.
 */
export function newNotStatements(fresh: Test[], base: Test[], lang: string): number {
  const key = (t: Test, n: string) => t.path + "\0" + n;
  const had = new Set(base.flatMap((t) => [...t.describes, t.name].map((n) => key(t, n))));
  const out = new Set<string>();
  for (const t of fresh) for (const n of [...t.describes, t.name]) if (!had.has(key(t, n)) && !L.isStatement(n, lang)) out.add(key(t, n));
  return out.size;
}

/** The line about test files changed outside the `tests/` tree. */
const outsideFilesLine = (outFiles: string[]): string =>
  locale.fill(N.spec.diff.outsideFiles, { tests: L.TESTS, files: outFiles.map((p) => `\`${p}\``).join(", ") });

/**
 * The section for the PR body; `note` — a line under the base (where the harness tests come from). A test not among the
 * task's scenarios (`extra`) is a mark in the list: the test itself is already there, we don't print it a second time.
 * `notStatements` — the number of the PR's new names that aren't statements: a line after the lists.
 */
export function render(
  baseLabel: string,
  removed: Test[],
  changed: [Test, Test][],
  added: Test[],
  outFiles: string[],
  moved: Moved[] = [],
  opts: { limit?: number; harness?: Set<Test>; extra?: Set<Test>; note?: string; notStatements?: number } = {},
): string {
  const lines = [N.prSpecSection, "", locale.fill(N.spec.diff.base, { base: baseLabel }), ""];
  if (opts.note) lines.push(opts.note, "");
  if (!removed.length && !changed.length && !added.length && !outFiles.length && !moved.length) {
    lines.push(N.spec.diff.unchanged);
    return lines.join("\n") + "\n";
  }
  const limit = opts.limit ?? SUMMARY_LIMIT;
  const names = opts.notStatements ? [locale.fill(N.spec.diff.notStatements, { n: opts.notStatements }), ""] : [];
  if (summarized(removed, changed, added, limit)) {
    // a removed test is a removed requirement: named one by one in the PR body while there aren't more of them than
    // the threshold
    if (removed.length && removed.length <= limit) lines.push(`**${N.spec.diff.removed} (${removed.length}):**`, "", ...removed.map(entry), "");
    lines.push(...summaryLines(removed, changed, added, limit, opts.harness));
    if (moved.length) lines.push(...movedLines(moved));
    if (outFiles.length) lines.push(outsideFilesLine(outFiles), "");
    lines.push(...names);
    return lines.join("\n").trimEnd() + "\n";
  }
  const mark = (t: Test) => (opts.extra?.has(t) ? ` — ${N.spec.diff.extraMark}` : "");
  const sections: [string, string[]][] = [
    [N.spec.diff.removed, removed.map(entry)],
    [N.spec.diff.changed, changed.map((p) => changedEntry(p) + mark(p[1]))],
    [N.spec.diff.added, added.map((t) => entry(t) + mark(t))],
  ];
  for (const [title, items] of sections) {
    if (items.length) lines.push(`**${title} (${items.length}):**`, "", ...items, "");
    else lines.push(locale.fill(N.spec.diff.empty, { title }), "");
  }
  if (moved.length) lines.push(...movedLines(moved));
  if (outFiles.length) lines.push(outsideFilesLine(outFiles), "");
  lines.push(...names);
  return lines.join("\n").trimEnd() + "\n";
}

function asJson(baseLabel: string, removed: Test[], changed: [Test, Test][], added: Test[], outFiles: string[], moved: Moved[], notStatements: number): string {
  const d = (t: Test) => ({ file: t.path, folder: L.folderOf(t), describes: t.describes, name: t.name });
  return (
    JSON.stringify(
      {
        base: baseLabel,
        removed: removed.map(d),
        changed: changed.map(([o, n]) => ({ old: d(o), new: d(n) })),
        added: added.map(d),
        moved: moved.map((m) => ({ from: m.from, ...d(m.test) })),
        out_of_tree_files: outFiles,
        not_statements: notStatements,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Task scenarios — the list items of the scenarios section (up to the next heading); checkboxes stripped; no section —
 * null. The heading is in any dictionary language (`## Scenarios` or its translation): the task could have been written
 * before the project language changed.
 */
export function parseScenarios(md: string): string[] | null {
  const lines = md.split(/\r?\n/);
  const heads = locale.every((n) => n.sections.scenarios).map((h) => new RegExp(`^${locale.escapeRe(h).replace(/ +/g, "\\s+")}\\s*$`));
  const start = lines.findIndex((l) => heads.some((h) => h.test(l.trim())));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(l);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Quotes that quote a scenario whole: `«…»;` in a task is the same name as the test's. */
const QUOTES: [string, string][] = [["«", "»"], ['"', '"'], ["“", "”"], ["`", "`"]];
const TAIL = /[.。;,]+$/;

/**
 * A name for matching: whitespace collapsed, case-insensitive, without outer quotes and a trailing mark — both before
 * and after the quotes.
 */
const norm = (s: string): string => {
  let t = s.replace(/\s+/g, " ").trim().replace(TAIL, "");
  for (const [open, close] of QUOTES) {
    const inner = t.slice(open.length, -close.length);
    // "a" and "b" isn't a whole quote: its own closing quote is inside
    if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close) && !inner.includes(close)) t = inner.trim().replace(TAIL, "");
  }
  return t.toLowerCase();
};

/** A scenario and what it became: new tests, a harness check's describe, or nothing. */
export interface Found {
  scenario: string;
  tests: Test[];
  harness: HarnessDescribe | null;
}

/**
 * Scenario ↔ new tests: each one whose it name or "describe › it" chain matches it (case-insensitive, without outer
 * quotes and a trailing mark) — one scenario is checked both on the server and in the UI; no test — the describe of a
 * new harness check, its name or chain. Tests that check generated (`generated` — only from the report) are tests of
 * its scenario, not beyond the scenarios.
 */
export function matchScenarios(
  scenarios: string[],
  fresh: Test[],
  checks: HarnessDescribe[] = [],
  generated: Set<Test> = new Set(),
): { found: Found[]; extra: Test[] } {
  const used = new Set<Test>();
  const usedChecks = new Set<HarnessDescribe>();
  const found = scenarios.map((scenario): Found => {
    const want = norm(scenario);
    const tests = fresh.filter((x) => norm(x.name) === want || norm([...x.describes, x.name].join(" › ")) === want);
    if (tests.length) {
      for (const t of tests) used.add(t);
      return { scenario, tests, harness: null };
    }
    const harness = checks.find((c) => !usedChecks.has(c) && (norm(c.describes.at(-1)!) === want || norm(c.describes.join(" › ")) === want)) ?? null;
    if (harness) usedChecks.add(harness);
    return { scenario, tests, harness };
  });
  const covered = (t: Test) =>
    generated.has(t) && [...usedChecks].some((c) => c.folder === L.folderOf(t) && c.describes.length === t.describes.length && c.describes.every((d, i) => d === t.describes[i]));
  return { found, extra: fresh.filter((t) => !used.has(t) && !covered(t)) };
}

const harnessEntry = (c: HarnessDescribe) =>
  `\`${c.folder}\` · ${c.describes.map(L.mdText).join(" › ")} — ${N.spec.diff.harnessCheck}: ${c.checks.map(L.mdText).join(", ")}`;

/**
 * Scenario matching without repeats: a scenario that became a test is named the same as the test — while the tests are
 * in the lists above (`listed`), it's only in the count, and a test beyond the scenarios is a mark there too; the
 * folder summary has no lists — then it's the test's line. A harness check scenario is the check's line, an undone
 * one — its own text.
 */
function scenarioLines(scenarios: string[] | null, match: { found: Found[]; extra: Test[] }, listed: boolean, limit = Infinity): string[] {
  if (scenarios === null) return [`### ${N.spec.diff.scenarios}`, "", locale.fill(N.spec.diff.noScenarios, { section: N.sections.scenarios }), ""];
  const { found, extra } = match;
  const lines = [`### ${N.spec.diff.scenarios} (${scenarios.length})`, ""];
  const done = found.filter((f) => f.tests.length).length;
  if (listed && done) lines.push(locale.fill(N.spec.diff.becameTests, { n: done }), "");
  const items = found.flatMap(({ scenario, tests, harness }) =>
    tests.length
      ? listed
        ? []
        : tests.map((t) => `- ✅ ${entry(t).slice(2)}`)
      : [harness ? `- ✅ ${harnessEntry(harness)}` : `- ❌ ${L.mdText(scenario)} — ${N.spec.diff.noTest}`],
  );
  if (items.length) lines.push(...items, "");
  if (!extra.length) return lines;
  const title = `**${N.spec.diff.extraTitle} (${extra.length}):**`;
  if (listed) lines.push(`${title} ${locale.fill(N.spec.diff.extraListed, { mark: N.spec.diff.extraMark })}`, "");
  else if (extra.length > limit) lines.push(`${title} ${N.spec.diff.extraFull}`, "");
  else lines.push(title, "", ...extra.map(entry), "");
  return lines;
}

const USAGE =
  "spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--root DIR] [--no-merge-base] [--json] [--scenarios issue.md | -] [--report report … --spec-branch origin/spec] [--limit 100 | --full]";

/**
 * Tests without repeats: from the sources first, from the report — only those not there (generated by the harness, in
 * `harness`).
 */
function union(a: Test[], b: Test[], harness: Set<Test>): Test[] {
  const keys = new Set(a.map((t) => t.path + "\0" + L.keyOf(t)));
  const extra = b.filter((t) => !keys.has(t.path + "\0" + L.keyOf(t)));
  for (const t of extra) harness.add(t);
  return [...a, ...extra];
}

/**
 * Base tests from the spec branch: `tests.json` of the commit whose `Source:` (the source SHA, spec-publish writes it)
 * is the merge-base or the nearest ancestor; no branch or file — null.
 */
function specTestsAt(branch: string, base: string, top: string): { tests: Test[]; source: string } | null {
  let log: string;
  try {
    log = gitText(["log", "--format=%H%x1f%B%x1e", branch, "--"], top);
  } catch {
    return null;
  }
  for (const rec of log.split("\x1e")) {
    const [sha, body = ""] = rec.trim().split("\x1f");
    const source = L.sourceOf(body);
    if (!sha || !source) continue;
    if (source !== base && spawnSync("git", ["merge-base", "--is-ancestor", source, base], { cwd: top }).status !== 0) continue;
    try {
      const list = JSON.parse(gitText(["show", `${sha}:tests.json`], top)) as { path: string; describes: string[]; name: string }[];
      return { tests: list.map((x) => L.makeTest(x.path, x.describes, x.name)), source };
    } catch {
      return null;
    }
  }
  return null;
}

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        base: { type: "string", default: "origin/main" },
        head: { type: "string", default: "HEAD" },
        worktree: { type: "boolean", default: false },
        root: { type: "string" },
        "no-merge-base": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        scenarios: { type: "string" },
        report: { type: "string", multiple: true },
        "spec-branch": { type: "string", default: "origin/spec" },
        full: { type: "boolean", default: false },
        limit: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-diff: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = opts.values;
  if (v.help) {
    console.error(USAGE);
    return 0;
  }
  const limit = v.full ? Infinity : v.limit === undefined ? SUMMARY_LIMIT : Number(v.limit);
  if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) {
    console.error(`spec-diff: --limit is a whole number of tests greater than zero, not «${v.limit}»\n${USAGE}`);
    return 2;
  }
  // the root's project language, before parsing: base and head decision lines (model, harness checks) are compared in it
  LANG = locale.projectLanguage(path.resolve(v.root ?? process.cwd()));
  N = locale.names(LANG);

  let removed: Test[], changed: [Test, Test][], added: Test[], moved: Moved[], outFiles: string[];
  let decisions: string[];
  let decisionData: { base: Decisions; head: Decisions };
  let harnessNote = "";
  const harness = new Set<Test>(); // tests only from the report — generated by the harness, not in the sources
  let checks: HarnessDescribe[];
  let sourced: Check[]; // harness calls in the head's sources: their describes aren't "report only"
  let notStatements: number;
  try {
    const { top, root, prefix } = findRoot(v.root);
    const base = v["no-merge-base"] ? v.base : gitText(["merge-base", v.base, v.worktree ? "HEAD" : v.head], top).trim();
    const baseFiles = testsAtRev(base, top, prefix);
    const baseScan = parseFiles(baseFiles, v.base);
    let baseTests = baseScan.tests;
    const headFiles = v.worktree ? testsInWorktree(root) : testsAtRev(v.head, top, prefix);
    const headScan = parseFiles(headFiles, v.worktree ? "working tree" : v.head);
    let headTests = headScan.tests;
    // a standard scenario is a harness check's describe: from the sources, without the report and the spec branch
    checks = freshChecks(baseScan.checks, headScan.checks);
    sourced = headScan.checks;
    // harness tests (registries, examples) aren't named in the sources: the head — from the runner report, the base —
    // tests.json of the spec branch
    if (v.report?.length) {
      const branch = v["spec-branch"]!;
      const specBase = specTestsAt(branch, base, top);
      if (specBase) {
        // like the sources (wanted): tests/lib isn't spec — its tests (e2e setup projects) don't get into tests.json
        const inTree = (t: Test) => t.path.startsWith(L.TESTS + "/") && L.classify(t.path)[0] !== "lib";
        const reported = L.mergeTests(v.report.flatMap((r) => L.loadReport(r, root))).filter(inTree);
        baseTests = union(baseTests, specBase.tests, harness);
        headTests = union(headTests, reported, harness);
        // a skipped publish (spec-run: main's tree wasn't checked as a whole) — tests.json is older than the diff base:
        // report the gap
        const baseSha = gitText(["rev-parse", `${base}^{commit}`], top).trim();
        const gap = specBase.source === baseSha ? "" : locale.fill(N.spec.diff.harnessGap, { sha: baseSha.slice(0, 12) });
        harnessNote = locale.fill(N.spec.diff.harnessNote, { branch, source: specBase.source.slice(0, 12), gap });
      } else {
        harnessNote = locale.fill(N.spec.diff.noSpecBase, { branch });
      }
    }
    const changedOut = outOfTreeFiles(base, v.head, top, prefix, v.worktree);
    const { pool, count, gone } = outOfTreePool(base, v.head, top, root, prefix, changedOut, v.worktree);
    ({ removed, changed, added, moved } = diff(baseTests, headTests, pool));
    notStatements = newNotStatements([...added, ...changed.map(([, n]) => n)], baseTests, LANG);
    outFiles = unmovedFiles(changedOut, moved, count, gone);
    // lint disables — only in changed code files: a removed or added exception is always in the PR diff
    const changedAll = (
      v.worktree
        ? gitText(["diff", "--name-only", "-z", base, "--", "."], top) + gitText(["ls-files", "--others", "--exclude-standard", "-z", "--", "."], top)
        : gitText(["diff", "--name-only", "-z", base, v.head, "--", "."], top)
    )
      .split("\0")
      .filter((f) => f.startsWith(prefix) && CODE.test(f) && !FLOW_COPY.test(f.slice(prefix.length)));
    decisionData = {
      base: await decisionsAt(base, top, prefix, changedAll, baseScan.checks),
      head: await decisionsAt(v.worktree ? null : v.head, top, prefix, changedAll, headScan.checks),
    };
    decisions = decisionLines(decisionData.base, decisionData.head, limit);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`spec-diff: ${msg}`);
    if (/merge-base|Not a valid|unknown revision|bad revision/.test(msg)) {
      console.error(`spec-diff: no revision ${v.base}? — git fetch origin or --base <branch>`);
    }
    return 2;
  }

  // scenarios before the lists: a test beyond the scenarios is marked right in them
  let scenarios: string[] | null = null;
  if (v.scenarios !== undefined) {
    try {
      scenarios = parseScenarios(readFileSync(v.scenarios === "-" ? 0 : v.scenarios, "utf8"));
    } catch (e) {
      console.error(`spec-diff: --scenarios: ${(e as Error).message}`);
      return 2;
    }
  }
  const fresh = [...added, ...changed.map(([, n]) => n)];
  const match = scenarios ? matchScenarios(scenarios, fresh, [...checks, ...reportedChecks(fresh, harness, sourced)], harness) : { found: [], extra: fresh };

  const label = v["no-merge-base"] ? v.base : `${v.base} (merge-base)`;
  const shown = { limit, harness: v.report?.length ? harness : undefined, extra: scenarios ? new Set(match.extra) : undefined, note: harnessNote, notStatements };
  let text = v.json ? asJson(label, removed, changed, added, outFiles, moved, notStatements) : render(label, removed, changed, added, outFiles, moved, shown);
  if (v.json) {
    const j = JSON.parse(text);
    j.decisions = Object.fromEntries(
      (["model", "exceptions", "checks"] as const).map((k) => [k, { removed: minus(decisionData.base[k], decisionData.head[k]), added: minus(decisionData.head[k], decisionData.base[k]) }]),
    );
    text = JSON.stringify(j, null, 2) + "\n";
  } else if (decisions.length) {
    text = text.trimEnd() + "\n\n" + decisions.join("\n").trimEnd() + "\n";
  }
  if (v.scenarios !== undefined) {
    if (v.json) {
      const j = JSON.parse(text);
      const d = (t: Test) => ({ folder: L.folderOf(t), describes: t.describes, name: t.name });
      j.scenarios =
        scenarios === null
          ? null
          : match.found.map(({ scenario, tests, harness: h }) => ({
              scenario,
              tests: tests.map(d),
              harness: h ? { folder: h.folder, describes: h.describes, checks: h.checks } : null,
            }));
      j.extra_tests = match.extra.map(d);
      text = JSON.stringify(j, null, 2) + "\n";
    } else {
      const listed = !summarized(removed, changed, added, limit);
      text = text.trimEnd() + "\n\n" + scenarioLines(scenarios, match, listed, limit).join("\n").trimEnd() + "\n";
    }
  }
  process.stdout.write(text);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
