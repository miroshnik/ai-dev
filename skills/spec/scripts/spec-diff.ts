#!/usr/bin/env bun
/**
 * spec-diff — дифф спеки: названия тестов (путь папки + describe + it) между базовой веткой
 * и HEAD по статическому разбору файлов на двух ревизиях (git cat-file, без прогонов и
 * чекаутов). Печатает markdown-раздел для тела PR: удалены (первыми), изменены (переименованы
 * в том же файле), добавлены, перенесены в дерево (тест исчез из файла вне tests/ и появился в
 * дереве под тем же именем — сводкой по папкам); плюс файлы тестов, изменённые вне дерева tests/.
 *
 *   bun spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--root DIR] [--no-merge-base] [--json]
 *
 * База по умолчанию — merge-base базовой ветки и HEAD (как дифф PR на GitHub). Запуск — Bun; нужен git.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import * as L from "./speclib.ts";
import type { Test } from "./speclib.ts";

/** Ниже этой похожести — не переименование, а снятое и новое требование: пусть будет видно. */
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
 * {путь относительно корня: исходник} для файлов тестов дерева tests/ на ревизии (без lib).
 * Содержимое — одним `git cat-file --batch`, а не `git show` на каждый файл: в репозитории
 * с сотнями файлов тестов это два процесса вместо сотен.
 */
function testsAtRev(rev: string, top: string, prefix: string): Map<string, string> {
  const list = gitText(["ls-tree", "-r", "--name-only", "-z", rev, "--", prefix + L.TESTS], top);
  const paths = list.split("\0").filter((p) => p && p.startsWith(prefix) && wanted(p.slice(prefix.length)));
  return filesAtRev(rev, top, prefix, paths);
}

/** {путь относительно корня: исходник} для путей от корня git на ревизии; нет файла — нет и ключа. */
function filesAtRev(rev: string, top: string, prefix: string, paths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  if (!paths.length) return files;
  const buf = git(["cat-file", "--batch"], top, paths.map((p) => `${rev}:${p}\n`).join(""));
  // ответ на объект: `<sha> <type> <size>\n<содержимое>\n`; нет объекта — `<rev>:<path> missing\n`
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

function parseFiles(files: Map<string, string>, label: string): Test[] {
  const tests: Test[] = [];
  for (const file of [...files.keys()].sort()) {
    try {
      tests.push(...L.parseSource(file, files.get(file)!));
    } catch (e) {
      console.error(`spec-diff: ${label}: ${file}: ${(e as Error).message}`);
    }
  }
  return tests;
}

/** Файлы тестов, изменённые вне tests/ (в том числе неотслеживаемые при --worktree). */
function outOfTreeFiles(base: string, head: string, top: string, prefix: string, worktree: boolean): string[] {
  const spec = ["--", ".", `:(exclude)${prefix}${L.TESTS}`];
  const changed = worktree
    ? gitText(["diff", "--name-only", "-z", base, ...spec], top) + gitText(["ls-files", "--others", "--exclude-standard", "-z", ...spec], top)
    : gitText(["diff", "--name-only", "-z", base, head, ...spec], top);
  const out = new Set<string>();
  for (const p of changed.split("\0")) {
    if (p && p.startsWith(prefix) && L.isTestFile(p.slice(prefix.length))) out.add(p.slice(prefix.length));
  }
  return [...out].sort();
}

/** Тест вне дерева на базе, исчезнувший из своего файла: кандидат в перенесённые. */
export interface Moved {
  test: Test; // тест в дереве, путь — новый
  from: string; // файл вне дерева на базе
}

/**
 * Тесты файлов вне дерева, изменённых в PR: на базе были, в том же файле на HEAD их нет (файл удалён
 * или тест из него убран). Только они могут считаться перенесёнными: тест, оставшийся на месте, —
 * источник копии, а не переноса. `count` — сколько тестов было в файле на базе.
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
    const baseTests = parseFiles(new Map([[f, src]]), "база");
    count.set(f, baseTests.length);
    if (!headFiles.has(f)) gone.add(f);
    const left = new Map<string, number>();
    for (const t of parseFiles(new Map([[f, headFiles.get(f) ?? ""]]), "HEAD")) left.set(nameKey(t), (left.get(nameKey(t)) ?? 0) + 1);
    for (const t of baseTests) {
      const k = nameKey(t);
      const n = left.get(k) ?? 0;
      if (n > 0) left.set(k, n - 1);
      else pool.push(t);
    }
  }
  return { pool, count, gone };
}

/** Похожесть строк по Ratcliff/Obershelp (как difflib.SequenceMatcher.ratio без эвристик). */
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

/** Жадное сопоставление по убыванию похожести; детерминировано (при равенстве — по порядку). */
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
  // 0) то же имя и describe, что у теста, исчезнувшего вне дерева, — перенесён в дерево, а не новый.
  // Точное совпадение, без похожести: переименованный при переносе тест честно «добавлен».
  const from = new Map<string, Test[]>();
  for (const t of pool) {
    const k = JSON.stringify([t.describes, t.name]);
    from.set(k, [...(from.get(k) ?? []), t]);
  }
  const moved: Moved[] = [];
  added = added.filter((a) => {
    const src = from.get(JSON.stringify([a.describes, a.name]))?.shift();
    if (!src) return true;
    moved.push({ test: a, from: src.path });
    return false;
  });
  // 1) тот же файл и describe, похожее имя — переименован тест
  const changed = pair(removed, added, (r, a) => r.path === a.path && sameDescribes(r, a), (r, a) => ratio(r.name, a.name), RENAME_RATIO);
  // 2) тот же файл и имя, другой describe — переименован describe
  changed.push(
    ...pair(removed, added, (r, a) => r.path === a.path && r.name === a.name, (r, a) => ratio(r.describes.join(" › "), a.describes.join(" › ")), 0),
  );
  return { removed, changed, added, moved };
}

/**
 * Файлы вне дерева без переноса целиком: перенесённый целиком (удалён, все его тесты нашли пару в
 * дереве) — только число в сводке; остальные — по имени: часть тестов не нашла пары, значит при
 * переносе что-то переименовано или потеряно.
 */
export function unmovedFiles(outFiles: string[], moved: Moved[], count: Map<string, number>, gone: Set<string>): string[] {
  const n = new Map<string, number>();
  for (const m of moved) n.set(m.from, (n.get(m.from) ?? 0) + 1);
  return outFiles.filter((f) => !(gone.has(f) && (count.get(f) ?? 0) > 0 && n.get(f) === count.get(f)));
}

const outMark = (t: Test) => (L.classify(t.path)[0] === "out" ? " ⚠️ вне дерева" : "");
const entry = (t: Test) => `- \`${L.folderOf(t)}\` · ${L.titleOf(t)}${outMark(t)}`;

function changedEntry([o, n]: [Test, Test]): string {
  const md = (parts: string[]) => parts.map(L.mdText).join(" › ");
  if (sameDescribes(o, n)) {
    const prefix = n.describes.length ? md(n.describes) + " › " : "";
    return `- \`${L.folderOf(n)}\` · ${prefix}~~${L.mdText(o.name)}~~ → ${L.mdText(n.name)}${outMark(n)}`;
  }
  return `- \`${L.folderOf(n)}\` · ~~${md(o.describes)}~~ → ${md(n.describes)} › ${L.mdText(n.name)}${outMark(n)}`;
}

/** Сводка переноса: по папке — сколько тестов и из скольких файлов вне дерева; по тесту — только в --json. */
function movedLines(moved: Moved[]): string[] {
  const byFolder = new Map<string, { tests: number; files: Set<string> }>();
  for (const m of moved) {
    const g = byFolder.get(L.folderOf(m.test)) ?? { tests: 0, files: new Set<string>() };
    g.tests++;
    g.files.add(m.from);
    byFolder.set(L.folderOf(m.test), g);
  }
  const files = new Set(moved.map((m) => m.from)).size;
  const fileWord = (n: number) => L.plural(n, "файла", "файлов", "файлов");
  return [
    `**Перенесены в дерево (${moved.length}):** названия те же, что вне \`${L.TESTS}/\` на базе; из ${fileWord(files)}.`,
    "",
    ...[...byFolder.keys()].sort().map((f) => `- \`${f}\` — ${L.testsWord(byFolder.get(f)!.tests)} из ${fileWord(byFolder.get(f)!.files.size)}`),
    "",
  ];
}

export function render(
  baseLabel: string,
  removed: Test[],
  changed: [Test, Test][],
  added: Test[],
  outFiles: string[],
  moved: Moved[] = [],
): string {
  const lines = ["## Спека (тесты)", "", `_База: \`${baseLabel}\`._`, ""];
  if (!removed.length && !changed.length && !added.length && !outFiles.length && !moved.length) {
    lines.push("Тесты не менялись.");
    return lines.join("\n") + "\n";
  }
  const sections: [string, string[]][] = [
    ["Удалены", removed.map(entry)],
    ["Изменены", changed.map(changedEntry)],
    ["Добавлены", added.map(entry)],
  ];
  for (const [title, items] of sections) {
    if (items.length) lines.push(`**${title} (${items.length}):**`, "", ...items, "");
    else lines.push(`**${title}:** нет.`, "");
  }
  if (moved.length) lines.push(...movedLines(moved));
  if (outFiles.length) lines.push(`**Вне дерева \`${L.TESTS}/\`** изменены файлы тестов: ${outFiles.map((p) => `\`${p}\``).join(", ")}.`, "");
  return lines.join("\n").trimEnd() + "\n";
}

function asJson(baseLabel: string, removed: Test[], changed: [Test, Test][], added: Test[], outFiles: string[], moved: Moved[]): string {
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
      },
      null,
      2,
    ) + "\n"
  );
}

const USAGE = "spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--root DIR] [--no-merge-base] [--json]";

export function main(argv: string[]): number {
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

  let removed: Test[], changed: [Test, Test][], added: Test[], moved: Moved[], outFiles: string[];
  try {
    const { top, root, prefix } = findRoot(v.root);
    const base = v["no-merge-base"] ? v.base : gitText(["merge-base", v.base, v.worktree ? "HEAD" : v.head], top).trim();
    const baseTests = parseFiles(testsAtRev(base, top, prefix), v.base);
    const headFiles = v.worktree ? testsInWorktree(root) : testsAtRev(v.head, top, prefix);
    const headTests = parseFiles(headFiles, v.worktree ? "рабочее дерево" : v.head);
    const changedOut = outOfTreeFiles(base, v.head, top, prefix, v.worktree);
    const { pool, count, gone } = outOfTreePool(base, v.head, top, root, prefix, changedOut, v.worktree);
    ({ removed, changed, added, moved } = diff(baseTests, headTests, pool));
    outFiles = unmovedFiles(changedOut, moved, count, gone);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`spec-diff: ${msg}`);
    if (/merge-base|Not a valid|unknown revision|bad revision/.test(msg)) {
      console.error(`spec-diff: нет ревизии ${v.base}? — git fetch origin или --base <ветка>`);
    }
    return 2;
  }

  const label = v["no-merge-base"] ? v.base : `${v.base} (merge-base)`;
  process.stdout.write(v.json ? asJson(label, removed, changed, added, outFiles, moved) : render(label, removed, changed, added, outFiles, moved));
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
