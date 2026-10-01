#!/usr/bin/env bun
/**
 * spec-diff — дифф спеки: названия тестов (путь папки + describe + it) между базовой веткой
 * и HEAD по статическому разбору файлов на двух ревизиях (git cat-file, без прогонов и
 * чекаутов). Печатает markdown-раздел для тела PR: удалены (первыми), изменены (переименованы
 * в том же файле), добавлены, перенесены в дерево (тест исчез из файла вне tests/ и появился в
 * дереве под тем же именем — сводкой по папкам); плюс файлы тестов, изменённые вне дерева tests/.
 *
 *   bun spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--root DIR] [--no-merge-base] [--json]
 *                    [--scenarios issue.md | -]
 *
 * --scenarios — тело задачи (markdown, `-` — stdin): раздел «## Сценарии» сверяется с добавленными и изменёнными
 * тестами — сценарий, ставший тестом, несделанный сценарий и тесты сверх сценариев.
 *
 * База по умолчанию — merge-base базовой ветки и HEAD (как дифф PR на GitHub). Запуск — Bun; нужен git.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { disablesIn } from "./harness.ts";
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

/** Тело без проверки: `() => {}`, `async () => {}`, `function () {}` — без пробелов, как в `Test.body`. */
const EMPTY_BODY = /^,(?:async)?(?:\([^)]*\)=>|function\w*\([^)]*\))\{\}$/;

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
  // Идут все тесты HEAD, а не по одному на ключ: одинаковые тесты двух файлов, перенесённых в одну
  // папку, там — одно требование, но перенесены оба, и файлы-источники перенесены целиком.
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
  // 1) тот же файл и то же тело, единственное в файле среди снятых и среди новых, — переименован тест, даже если
  // сменились и describe, и имя (перевод названий в утверждения). Пустое тело — не признак: проверки в нём нет
  const bodyKey = (t: Test) => (t.body && !EMPTY_BODY.test(t.body) ? JSON.stringify([t.path, t.body]) : "");
  const once = (list: Test[]) => {
    const n = new Map<string, number>();
    for (const t of list) if (bodyKey(t)) n.set(bodyKey(t), (n.get(bodyKey(t)) ?? 0) + 1);
    return n;
  };
  const [inRemoved, inAdded] = [once(removed), once(added)];
  const unique = (t: Test) => !!bodyKey(t) && inRemoved.get(bodyKey(t)) === 1 && inAdded.get(bodyKey(t)) === 1;
  const changed = pair(removed, added, (r, a) => unique(r) && bodyKey(r) === bodyKey(a), () => 1, 1);
  // 2) тот же файл и describe, похожее имя — переименован тест
  changed.push(...pair(removed, added, (r, a) => r.path === a.path && sameDescribes(r, a), (r, a) => ratio(r.name, a.name), RENAME_RATIO));
  // 3) та же папка и имя, другой describe — переименован describe или тест переложен в другой раздел,
  // в том числе из другого файла папки: текст требования тот же, сменился раздел
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
  // сменились и describe, и имя (или describe не было) — зачёркнуто старое название целиком
  if (o.name !== n.name || !o.describes.length) return `- \`${L.folderOf(n)}\` · ~~${L.titleOf(o)}~~ → ${L.titleOf(n)}${outMark(n)}`;
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

// ---------- решения вне названий тестов: модель, исключения, проверки харнесса ----------

/** Решения одного вида на ревизии — строки для списка; снятые и добавленные — разница строк. */
export interface Decisions {
  model: string[];
  exceptions: string[];
  checks: string[];
}

/** Модуль данных проекта (модель, исключения) из текста: .json — разбор, TS/JS — импорт временного файла. */
async function loadData(text: string, file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(text);
  const dir = mkdtempSync(path.join(os.tmpdir(), "spec-diff-"));
  try {
    const f = path.join(dir, "data" + path.extname(file));
    writeFileSync(f, text);
    return ((await import(pathToFileURL(f).href)) as { default?: unknown }).default;
  } catch {
    return undefined; // модель с импортами за пределы файла статически не прочесть — решения модели не показываются
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type ModelData = { modules?: Record<string, { dependsOn?: string[]; packages?: string[] }> };

/** Модель → «модуль X», «зависимость X → Y», «пакет P модуля X»: по видам, внутри — по имени. */
export function modelFacts(m: ModelData | undefined): string[] {
  const mods = Object.keys(m?.modules ?? {}).sort();
  const at = (n: string) => m!.modules![n]!;
  return [
    ...mods.map((n) => `модуль ${n}`),
    ...mods.flatMap((n) => [...(at(n).dependsOn ?? [])].sort().map((d) => `зависимость ${n} → ${d}`)),
    ...mods.flatMap((n) => [...(at(n).packages ?? [])].sort().map((p) => `пакет ${p} модуля ${n}`)),
  ];
}

const REGISTRY = /\bregistry:\s*(["'`])(.+?)\1/g;
const RULE = /\brule:\s*(["'`])(.+?)\1/g;

/** Проверки харнесса в исходниках тестов: реестры invariant и правила examples по литералам вызова. */
export function checkFacts(files: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [file, text] of files) {
    const folder = path.posix.dirname(file);
    // значение с подстановкой ${…} — не литерал: реестр вычисляется, статически его не назвать
    for (const m of text.matchAll(REGISTRY)) if (!m[2]!.includes("${")) out.add(`\`${folder}\` · реестр «${m[2]}»`);
    for (const m of text.matchAll(RULE)) if (!m[2]!.includes("${")) out.add(`\`${folder}\` · правило ${m[2]}`);
  }
  return [...out].sort();
}

// exceptions.* харнесса и names.exceptions.* — исключения названий в папке решения (spec-doc)
const EXCEPTIONS = /(^|\/)(names\.)?exceptions\.(ts|mts|js|mjs|json)$/;

/** Пункт exceptions.*: элемент реестра харнесса (`rule` — соглашение) или название теста (spec-names: `file`, `name`). */
type ExceptionEntry = { item?: string; rule?: string; file?: string; name?: string; issue: number; reason: string };

/** Строка исключения: что исключено, задача и причина — у каждого пункта своя, одинаковые не схлопываются. */
function exceptionLine(folder: string, e: ExceptionEntry): string {
  const what = e.item !== undefined ? e.item : `«${e.name}» в \`${e.file}\``;
  return `\`${folder}\` · ${what} (${e.rule ? `${e.rule}, ` : ""}#${e.issue}) — ${e.reason}`;
}
const CODE = /\.[cm]?[jt]sx?$/;

/** Файлы на ревизии (null — рабочее дерево) по путям от корня git: путь без префикса → текст. */
function readFiles(rev: string | null, top: string, prefix: string, paths: string[]): Map<string, string> {
  if (rev !== null) return filesAtRev(rev, top, prefix, paths);
  const out = new Map<string, string>();
  for (const p of paths) {
    try {
      out.set(p.slice(prefix.length), readFileSync(path.join(top, p), "utf8"));
    } catch {
      /* файла нет в рабочем дереве */
    }
  }
  return out;
}

/** Решения на ревизии: модель, исключения (exceptions.* в tests/ и отключения линта в изменённых файлах), проверки. */
async function decisionsAt(rev: string | null, top: string, prefix: string, changedCode: string[], tests: Map<string, string>): Promise<Decisions> {
  const listed = rev !== null ? gitText(["ls-tree", "-r", "--name-only", "-z", rev, "--", prefix + L.TESTS], top).split("\0") : [];
  const excPaths =
    rev !== null
      ? listed.filter((p) => p.startsWith(prefix) && EXCEPTIONS.test(p))
      : walkTests(path.join(top, prefix, L.TESTS)).map((p) => prefix + p).filter((p) => EXCEPTIONS.test(p));
  const modelPath = `${prefix}${L.TESTS}/architecture/model.ts`;
  const files = readFiles(rev, top, prefix, [modelPath, ...excPaths, ...changedCode]);
  const model = files.has(`${L.TESTS}/architecture/model.ts`) ? ((await loadData(files.get(`${L.TESTS}/architecture/model.ts`)!, modelPath)) as ModelData) : undefined;
  const exceptions: string[] = [];
  for (const p of excPaths) {
    const rel = p.slice(prefix.length);
    const data = await loadData(files.get(rel) ?? "[]", rel);
    for (const e of Array.isArray(data) ? (data as ExceptionEntry[]) : []) exceptions.push(exceptionLine(path.posix.dirname(rel), e));
  }
  for (const p of changedCode) {
    const rel = p.slice(prefix.length);
    const text = files.get(rel);
    if (!text || !text.includes("eslint-disable")) continue;
    for (const d of disablesIn(rel, text)) exceptions.push(`\`${rel}\` · ${d.rules.join(", ") || "все правила"} — ${d.description || "без причины"}`);
  }
  return { model: modelFacts(model), exceptions: exceptions.sort(), checks: checkFacts(tests) };
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

/** Разность с повторами: одинаковые строки — разные пункты (два одинаковых отключения линта), снят один — в разнице один. */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(x) ?? 0;
    left.set(x, n - 1);
    return n <= 0;
  });
}

/** Строки решения выше порога — число на папку или файл (первый code span строки), у модели — на вид («модуль», «пакет»). */
function grouped(items: string[]): string[] {
  const n = new Map<string, number>();
  for (const x of items) {
    const k = /^`[^`]+`/.exec(x)?.[0] ?? x.split(" ")[0]!;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.keys()].sort().map((k) => `- ${k} — ${n.get(k)}`);
}

/** Снятые и добавленные решения по видам — разделы для тела PR; нет изменений вида — нет раздела; выше порога — сводкой. */
export function decisionLines(base: Decisions, head: Decisions, limit = Infinity): string[] {
  const lines: string[] = [];
  const kinds: [string, keyof Decisions][] = [["Модель архитектуры", "model"], ["Исключения", "exceptions"], ["Проверки харнесса", "checks"]];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    if (items.length > limit) lines.push(`**${title} (${items.length}), сводкой:**`, "", ...grouped(items), "");
    else lines.push(`**${title} (${items.length}):**`, "", ...items.map((x) => `- ${L.mdText(x)}`), "");
  };
  for (const [title, k] of kinds) {
    section(`${title} — снято`, minus(base[k], head[k]));
    section(`${title} — добавлено`, minus(head[k], base[k]));
  }
  return lines;
}

/** Порог сводки по умолчанию: тестов в списках (удалены, изменены, добавлены) больше — в теле PR сводка по папкам. */
export const SUMMARY_LIMIT = 100;

/** Сводка по папкам: число удалённых, изменённых и добавленных; с отчётом раннера — сколько из них порождено харнессом. */
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
    `**Сводка по папкам** — ${L.testsWord(total)}, больше порога ${limit}: полный список — \`spec-diff --full\` (в CI — summary джоба).`,
    "",
    `| Папка | Удалены | Изменены | Добавлены |${harness ? " Из них харнесса |" : ""}`,
    `|---|--:|--:|--:|${harness ? "--:|" : ""}`,
    ...[...rows.keys()].sort().map((f) => `| \`${f}\` | ${cols(rows.get(f)!)} |`),
    `| **Всего** | ${cols(sum)} |`,
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
  opts: { limit?: number; harness?: Set<Test> } = {},
): string {
  const lines = ["## Спека (тесты)", "", `_База: \`${baseLabel}\`._`, ""];
  if (!removed.length && !changed.length && !added.length && !outFiles.length && !moved.length) {
    lines.push("Тесты не менялись.");
    return lines.join("\n") + "\n";
  }
  const limit = opts.limit ?? SUMMARY_LIMIT;
  if (removed.length + changed.length + added.length > limit) {
    // удалённый тест — снятое требование: в теле PR поимённо, пока их самих не больше порога
    if (removed.length && removed.length <= limit) lines.push(`**Удалены (${removed.length}):**`, "", ...removed.map(entry), "");
    lines.push(...summaryLines(removed, changed, added, limit, opts.harness));
    if (moved.length) lines.push(...movedLines(moved));
    if (outFiles.length) lines.push(`**Вне дерева \`${L.TESTS}/\`** изменены файлы тестов: ${outFiles.map((p) => `\`${p}\``).join(", ")}.`, "");
    return lines.join("\n").trimEnd() + "\n";
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

/** Сценарии задачи — пункты списка раздела «## Сценарии» (до следующего заголовка); чекбоксы сняты; нет раздела — null. */
export function parseScenarios(md: string): string[] | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Сценарии\s*$/.test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(l);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Кавычки, которыми сценарий цитируют целиком: `«…»;` в задаче — то же название, что у теста. */
const QUOTES: [string, string][] = [["«", "»"], ['"', '"'], ["“", "”"], ["`", "`"]];
const TAIL = /[.。;,]+$/;

/** Название для сверки: пробелы схлопнуты, без регистра, без внешних кавычек и знака в конце — до и после кавычек. */
const norm = (s: string): string => {
  let t = s.replace(/\s+/g, " ").trim().replace(TAIL, "");
  for (const [open, close] of QUOTES) {
    const inner = t.slice(open.length, -close.length);
    // «a» и «b» — не цитата целиком: внутри своя закрывающая кавычка
    if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close) && !inner.includes(close)) t = inner.trim().replace(TAIL, "");
  }
  return t.toLowerCase();
};

/** Сценарий ↔ новый тест: совпадает с названием it или с цепочкой «describe › it» (без регистра, внешних кавычек и знака в конце). */
export function matchScenarios(scenarios: string[], fresh: Test[]): { found: [string, Test | null][]; extra: Test[] } {
  const used = new Set<Test>();
  const found = scenarios.map((sc): [string, Test | null] => {
    const want = norm(sc);
    const t = fresh.find((x) => !used.has(x) && (norm(x.name) === want || norm([...x.describes, x.name].join(" › ")) === want)) ?? null;
    if (t) used.add(t);
    return [sc, t];
  });
  return { found, extra: fresh.filter((t) => !used.has(t)) };
}

function scenarioLines(scenarios: string[] | null, fresh: Test[], limit = Infinity): string[] {
  if (scenarios === null) return ["### Сценарии задачи", "", "В задаче нет раздела «## Сценарии» — сверять не с чем.", ""];
  const { found, extra } = matchScenarios(scenarios, fresh);
  const lines = [`### Сценарии задачи (${scenarios.length})`, ""];
  for (const [sc, t] of found) lines.push(t ? `- ✅ ${L.mdText(sc)} — ${entry(t).slice(2)}` : `- ❌ ${L.mdText(sc)} — теста нет`);
  lines.push("");
  if (extra.length > limit) lines.push(`**Тесты сверх сценариев (${extra.length}):** списком — \`spec-diff --full\`.`, "");
  else if (extra.length) lines.push(`**Тесты сверх сценариев (${extra.length}):**`, "", ...extra.map(entry), "");
  return lines;
}

const USAGE =
  "spec-diff.ts [--base origin/main] [--head HEAD | --worktree] [--root DIR] [--no-merge-base] [--json] [--scenarios issue.md | -] [--report отчёт … --spec-branch origin/spec] [--limit 100 | --full]";

/** Тесты без повторов: первым — из исходников, из отчёта — только те, которых там нет (порождённые харнессом, в `harness`). */
function union(a: Test[], b: Test[], harness: Set<Test>): Test[] {
  const keys = new Set(a.map((t) => t.path + "\0" + L.keyOf(t)));
  const extra = b.filter((t) => !keys.has(t.path + "\0" + L.keyOf(t)));
  for (const t of extra) harness.add(t);
  return [...a, ...extra];
}

/**
 * Тесты базы из ветки spec: `tests.json` коммита, чей `Source:` (SHA исходника, его пишет spec-publish) — merge-base
 * или ближайший предок; ветки или файла нет — null.
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
    console.error(`spec-diff: --limit — целое число тестов больше нуля, а не «${v.limit}»\n${USAGE}`);
    return 2;
  }

  let removed: Test[], changed: [Test, Test][], added: Test[], moved: Moved[], outFiles: string[];
  let decisions: string[];
  let decisionData: { base: Decisions; head: Decisions };
  let harnessNote = "";
  const harness = new Set<Test>(); // тесты только из отчёта — порождены харнессом, в исходниках их нет
  try {
    const { top, root, prefix } = findRoot(v.root);
    const base = v["no-merge-base"] ? v.base : gitText(["merge-base", v.base, v.worktree ? "HEAD" : v.head], top).trim();
    const baseFiles = testsAtRev(base, top, prefix);
    let baseTests = parseFiles(baseFiles, v.base);
    const headFiles = v.worktree ? testsInWorktree(root) : testsAtRev(v.head, top, prefix);
    let headTests = parseFiles(headFiles, v.worktree ? "рабочее дерево" : v.head);
    // тесты харнесса (реестры, примеры) в исходниках не названы: голова — по отчёту раннера, база — tests.json ветки spec
    if (v.report?.length) {
      const branch = v["spec-branch"]!;
      const specBase = specTestsAt(branch, base, top);
      if (specBase) {
        // как исходники (wanted): tests/lib не спека — его тесты (setup-проекты e2e) в tests.json не попадают
        const inTree = (t: Test) => t.path.startsWith(L.TESTS + "/") && L.classify(t.path)[0] !== "lib";
        const reported = L.mergeTests(v.report.flatMap((r) => L.loadReport(r, root))).filter(inTree);
        baseTests = union(baseTests, specBase.tests, harness);
        headTests = union(headTests, reported, harness);
        // пропущенная публикация (spec-run: дерево main не проверено целиком) — tests.json старше базы диффа: о разрыве сказать
        const baseSha = gitText(["rev-parse", `${base}^{commit}`], top).trim();
        const gap = specBase.source === baseSha ? "" : ` старше базы диффа ${baseSha.slice(0, 12)}: в списках возможны тесты PR, влитых между ними`;
        harnessNote = `_Тесты харнесса — по отчёту; база — ветка ${branch} (исходник ${specBase.source.slice(0, 12)}${gap})._`;
      } else {
        harnessNote = `_Тесты харнесса: в ветке ${branch} нет tests.json для базы — дифф по исходникам, тестов харнесса в нём не видно._`;
      }
    }
    const changedOut = outOfTreeFiles(base, v.head, top, prefix, v.worktree);
    const { pool, count, gone } = outOfTreePool(base, v.head, top, root, prefix, changedOut, v.worktree);
    ({ removed, changed, added, moved } = diff(baseTests, headTests, pool));
    outFiles = unmovedFiles(changedOut, moved, count, gone);
    // отключения линта — только в изменённых файлах кода: снятое или добавленное исключение всегда в диффе PR
    const changedAll = (
      v.worktree
        ? gitText(["diff", "--name-only", "-z", base, "--", "."], top) + gitText(["ls-files", "--others", "--exclude-standard", "-z", "--", "."], top)
        : gitText(["diff", "--name-only", "-z", base, v.head, "--", "."], top)
    )
      .split("\0")
      .filter((f) => f.startsWith(prefix) && CODE.test(f));
    decisionData = {
      base: await decisionsAt(base, top, prefix, changedAll, baseFiles),
      head: await decisionsAt(v.worktree ? null : v.head, top, prefix, changedAll, headFiles),
    };
    decisions = decisionLines(decisionData.base, decisionData.head, limit);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`spec-diff: ${msg}`);
    if (/merge-base|Not a valid|unknown revision|bad revision/.test(msg)) {
      console.error(`spec-diff: нет ревизии ${v.base}? — git fetch origin или --base <ветка>`);
    }
    return 2;
  }

  const label = v["no-merge-base"] ? v.base : `${v.base} (merge-base)`;
  const shown = { limit, harness: v.report?.length ? harness : undefined };
  let text = v.json ? asJson(label, removed, changed, added, outFiles, moved) : render(label, removed, changed, added, outFiles, moved, shown);
  if (harnessNote && !v.json) text = text.replace(/^(_База: .*_)$/m, (m) => `${m}\n\n${harnessNote}`);
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
    let md: string;
    try {
      md = readFileSync(v.scenarios === "-" ? 0 : v.scenarios, "utf8");
    } catch (e) {
      console.error(`spec-diff: --scenarios: ${(e as Error).message}`);
      return 2;
    }
    const scenarios = parseScenarios(md);
    const fresh = [...added, ...changed.map(([, n]) => n)];
    if (v.json) {
      const j = JSON.parse(text);
      const { found, extra } = scenarios ? matchScenarios(scenarios, fresh) : { found: [], extra: fresh };
      j.scenarios = scenarios === null ? null : found.map(([sc, t]) => ({ scenario: sc, test: t ? { folder: L.folderOf(t), describes: t.describes, name: t.name } : null }));
      j.extra_tests = extra.map((t) => ({ folder: L.folderOf(t), describes: t.describes, name: t.name }));
      text = JSON.stringify(j, null, 2) + "\n";
    } else {
      text = text.trimEnd() + "\n\n" + scenarioLines(scenarios, fresh, limit).join("\n").trimEnd() + "\n";
    }
  }
  process.stdout.write(text);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
