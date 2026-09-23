/**
 * speclib — общее для spec-doc и spec-diff: дерево tests/, модель теста, разбор отчётов
 * раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML от `bun test`) и статический разбор
 * исходников тестов (сканер describe/it/test для TS/JS: названия и проза из JSDoc).
 *
 * Запуск — Bun (`bun script.ts`; только `node:`-API, поэтому идёт и под Node ≥ 22.18), без
 * зависимостей и без конфигурации под репозиторий: дерево tests/ из правила
 * «Спецификация — тесты» и стандартные форматы отчётов.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const posix = path.posix;

export const TESTS = "tests";
export type Kind = "capability" | "standard" | "lib" | "out";
export type Status = "passed" | "failed" | "skipped" | "todo";

export interface Test {
  path: string; // путь файла относительно корня, posix
  describes: string[]; // цепочка describe
  name: string; // it / test
  status: Status;
  reason: string; // причина пропуска, если отчёт её знает
  variants: number; // одинаковые записи из нескольких отчётов (проекты Playwright) свёрнуты
}

export function makeTest(
  file: string,
  describes: string[],
  name: string,
  status: Status = "passed",
  reason = "",
  variants = 1,
): Test {
  return { path: file, describes, name, status, reason, variants };
}

export function folderOf(t: Test): string {
  return posix.dirname(t.path);
}

/** Идентичность требования: путь папки + describe + it (файл внутри папки не важен). */
export function keyOf(t: Test): string {
  return JSON.stringify([folderOf(t), t.describes, t.name]);
}

export function titleOf(t: Test): string {
  return [...t.describes, t.name].map(mdText).join(" › ");
}

/**
 * Имя теста или describe для markdown: `<` вне code span экранируется — иначе GitHub примет
 * `<type>` или `<!-- … -->` за HTML и молча выбросит. Остальная разметка — как написал автор.
 */
export function mdText(s: string): string {
  return s
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "\\<")))
    .join("");
}

// Файлы тестов: *.test.ts / *.spec.ts / *.e2e.ts (и js/jsx/tsx/mjs/cjs…)
const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

export function isTestFile(p: string): boolean {
  return TEST_FILE.test(p);
}

/**
 * (вид, имя) для пути относительно корня: capability/standard с именем папки,
 * lib — не спека, out — вне дерева (в том числе файл прямо в tests/capabilities/).
 */
export function classify(p: string): [Kind, string | null] {
  const parts = p.split("/");
  if (parts.length >= 4 && parts[0] === TESTS) {
    if (parts[1] === "capabilities") return ["capability", parts[2]!];
    if (parts[1] === "standards") return ["standard", parts[2]!];
  }
  if (parts.length >= 3 && parts[0] === TESTS && parts[1] === "lib") return ["lib", null];
  return ["out", null];
}

/** Статус набора: любой failed → failed; иначе есть passed → passed; иначе todo/skipped. */
export function combineStatus(a: Status, b: Status): Status {
  const order: Record<Status, number> = { failed: 3, passed: 2, todo: 1, skipped: 0 };
  return order[a] >= order[b] ? a : b;
}

/** Одинаковые записи из нескольких отчётов — в одну, порядок первого появления. */
export function mergeTests(tests: Test[]): Test[] {
  const byKey = new Map<string, Test>();
  for (const t of tests) {
    const k = t.path + "\0" + keyOf(t);
    const m = byKey.get(k);
    if (m) {
      m.status = combineStatus(m.status, t.status);
      m.reason = m.reason || t.reason;
      m.variants += t.variants;
    } else {
      byKey.set(k, { ...t, describes: [...t.describes] });
    }
  }
  return [...byKey.values()];
}

// ---------- пути ----------

const DRIVE = /^[A-Za-z]:\//;

/**
 * Путь из отчёта → относительно корня. Абсолютный путь с другой машины (CI) приводится
 * по сегменту /tests/; иначе — как есть, без ведущего слеша.
 */
export function toRepoPath(p: string, root: string): string {
  p = (p ?? "").replace(/\\/g, "/");
  if (p.startsWith("/") || DRIVE.test(p)) {
    if (root) {
      const rel = path.relative(root, p).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    }
    const idx = p.indexOf("/" + TESTS + "/");
    if (idx >= 0) return p.slice(idx + 1);
    return p.replace(/^\/+/, "");
  }
  return p ? posix.normalize(p) : p;
}

// ---------- отчёты ----------

export function loadReport(file: string, root: string): Test[] {
  const text = readFileSync(file, "utf8");
  if (text.trimStart().startsWith("<")) return parseJunit(text, root);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: не JSON и не XML (${(e as Error).message})`);
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if ("testResults" in d) return parseVitest(d, root);
    if ("suites" in d && "config" in d) return parsePlaywright(d, root);
  }
  throw new Error(`${file}: неизвестный формат отчёта (ожидаю JSON Vitest/Jest, JSON Playwright или JUnit XML от bun test)`);
}

const VITEST_STATUS: Record<string, Status> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  pending: "skipped",
  disabled: "skipped",
  todo: "todo",
};

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** JSON Vitest (`--reporter=json`) — он же формат Jest: testResults[].assertionResults[]. */
export function parseVitest(data: Json, root: string): Test[] {
  const tests: Test[] = [];
  for (const tr of arr(data.testResults)) {
    const file = toRepoPath(str(tr.name), root);
    for (const a of arr(tr.assertionResults)) {
      const status = VITEST_STATUS[str(a.status)] ?? "failed";
      const describes = arr(a.ancestorTitles).map((x) => String(x));
      tests.push(makeTest(file, describes, str(a.title) || str(a.fullName), status));
    }
  }
  return tests;
}

const PW_STATUS: Record<string, Status> = { expected: "passed", flaky: "passed", unexpected: "failed", skipped: "skipped" };

/**
 * JSON Playwright (`--reporter=json`): suites[] по файлам, вложенные suites — describe,
 * specs[].tests[] — по одному на проект (chromium, firefox…) — сворачиваются в одну строку.
 */
export function parsePlaywright(data: Json, root: string): Test[] {
  const config = (data.config ?? {}) as Json;
  const rootDir = str(config.rootDir).replace(/\\/g, "/");
  const tests: Test[] = [];

  const specToTest = (spec: Json, describes: string[], file: string): Test => {
    const statuses: Status[] = [];
    const reasons: string[] = [];
    for (const t of arr(spec.tests)) {
      statuses.push(PW_STATUS[str(t.status)] ?? "failed");
      for (const ann of arr(t.annotations)) {
        const type = str(ann.type);
        if ((type === "skip" || type === "fixme") && str(ann.description)) reasons.push(str(ann.description));
      }
    }
    let status: Status = "passed";
    for (const s of statuses) if (s !== "skipped") status = combineStatus(status, s);
    if (statuses.length && statuses.every((s) => s === "skipped")) status = "skipped";
    return makeTest(file, describes, str(spec.title), status, reasons[0] ?? "");
  };

  const walk = (suite: Json, describes: string[], file: string): void => {
    for (const spec of arr(suite.specs)) tests.push(specToTest(spec, describes, file));
    for (const sub of arr(suite.suites)) walk(sub, [...describes, str(sub.title)], file);
  };

  for (const fileSuite of arr(data.suites)) {
    const f = (str(fileSuite.file) || str(fileSuite.title)).replace(/\\/g, "/");
    const file = toRepoPath(rootDir ? posix.join(rootDir, f) : f, root);
    walk(fileSuite, [], file);
  }
  return tests;
}

const XML_ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
function xmlUnescape(s: string): string {
  return s.replace(XML_ENTITY, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e] ?? "";
  });
}

function xmlAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = xmlUnescape(m[2] ?? m[3] ?? "");
  return out;
}

type Suite = { name: string; file: string };

/**
 * JUnit XML от `bun test --reporter=junit`: файл — testsuite с name = file, describe — вложенные
 * testsuite с атрибутом file, тест — testcase (file, name). Разбор регулярными выражениями со
 * стеком suite: XML-парсера без зависимостей нет, а формат прост. `<skipped/>` — пропущен,
 * `<skipped message="TODO"/>` — todo, failure/error — падает.
 */
export function parseJunit(text: string, root: string): Test[] {
  const tests: Test[] = [];
  const stack: Suite[] = [];
  const TOKEN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>/g;
  let caseAttrs: Record<string, string> | null = null;
  let caseStart = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (!m[2]) continue; // CDATA или комментарий
    const closing = m[1] === "/";
    const selfClosing = m[4] === "/";
    if (m[2] === "testsuite") {
      if (closing) stack.pop();
      else if (!selfClosing) {
        const a = xmlAttrs(m[3] ?? "");
        stack.push({ name: a.name ?? "", file: (a.file ?? "").replace(/\\/g, "/") });
      }
      continue;
    }
    if (!closing) {
      const a = xmlAttrs(m[3] ?? "");
      if (selfClosing) tests.push(junitCase(a, "", stack, root));
      else {
        caseAttrs = a;
        caseStart = m.index + m[0].length;
      }
    } else if (caseAttrs) {
      tests.push(junitCase(caseAttrs, text.slice(caseStart, m.index), stack, root));
      caseAttrs = null;
    }
  }
  return mergeTests(tests);
}

function junitCase(a: Record<string, string>, body: string, stack: Suite[], root: string): Test {
  // describe — вложенные suite с file, чьё имя не равно файлу (suite самого файла — не describe)
  const describes = stack.filter((s) => s.file && s.name !== s.file).map((s) => s.name);
  const suiteFile = [...stack].reverse().find((s) => s.file)?.file ?? "";
  const file = toRepoPath((a.file ?? "").replace(/\\/g, "/") || suiteFile, root);
  let status: Status = "passed";
  let reason = "";
  const sk = /<skipped\b([^>]*)/.exec(body);
  if (sk) {
    const msg = (xmlAttrs(sk[1] ?? "").message ?? "").trim();
    if (msg === "TODO") status = "todo";
    else {
      status = "skipped";
      reason = msg;
    }
  } else if (/<(failure|error)\b/.test(body)) {
    status = "failed";
  }
  return makeTest(file, describes, a.name ?? "", status, reason);
}

// ---------- статический разбор исходников ----------

// describe / it / test / suite / context (+ x/f-варианты Jest, test.describe Playwright),
// модификаторы — только из списка: test.step, test.use, test.beforeEach и т. п. — не тесты.
const JS_CALL = /(?<![\w$.])(?:test\.)?[xf]?(describe|it|test|suite|context)((?:\.\w+)*)\s*\(/y;
const DESCRIBE_KINDS = new Set(["describe", "suite", "context"]);
const MODS_OK = new Set([
  "skip", "only", "todo", "each", "for", "concurrent", "sequential", "fails",
  "runIf", "skipIf", "serial", "parallel", "fixme", "fail", "shuffle",
]);
const WS = " \t\r\n";

function skipLineComment(s: string, i: number): number {
  const j = s.indexOf("\n", i);
  return j < 0 ? s.length : j;
}

function skipBlockComment(s: string, i: number): number {
  const j = s.indexOf("*/", i + 2);
  return j < 0 ? s.length : j + 2;
}

/** i — открывающая кавычка; вернуть индекс после закрывающей. Шаблонные строки — с ${…}. */
export function skipString(s: string, i: number): number {
  const q = s[i];
  const n = s.length;
  let j = i + 1;
  if (q !== "`") {
    while (j < n && s[j] !== q) {
      if (s[j] === "\\") j++;
      else if (s[j] === "\n") break;
      j++;
    }
    return Math.min(j + 1, n);
  }
  while (j < n && s[j] !== "`") {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s.startsWith("${", j)) {
      j = skipTemplateExpr(s, j + 2);
      continue;
    }
    j++;
  }
  return Math.min(j + 1, n);
}

function skipTemplateExpr(s: string, i: number): number {
  const n = s.length;
  let d = 0;
  let j = i;
  while (j < n) {
    const c = s[j]!;
    if (c === "'" || c === '"' || c === "`") {
      j = skipString(s, j);
      continue;
    }
    if (c === "{") d++;
    else if (c === "}") {
      if (d === 0) return j + 1;
      d--;
    }
    j++;
  }
  return n;
}

/** i — индекс после '('; вернуть индекс после парной ')'. */
export function skipBalanced(s: string, i: number): number {
  const n = s.length;
  let d = 1;
  let j = i;
  while (j < n && d) {
    const c = s[j]!;
    if (c === "'" || c === '"' || c === "`") {
      j = skipString(s, j);
      continue;
    }
    if (s.startsWith("//", j)) {
      j = skipLineComment(s, j);
      continue;
    }
    if (s.startsWith("/*", j)) {
      j = skipBlockComment(s, j);
      continue;
    }
    if (c === "(") d++;
    else if (c === ")") d--;
    j++;
  }
  return j;
}

const unescape = (name: string): string => name.replace(/\\(.)/g, "$1");
const isIdentChar = (c: string): boolean => /[\w$]/.test(c);

/** Тесты из исходника TS/JS. */
export function parseSource(file: string, source: string): Test[] {
  return parseJs(file, source);
}

/**
 * Проза из JSDoc исходника — то, чего не видно из названий. Ключи — JSON цепочки имён,
 * как у теста: describe — [describes…], it — [describes…, имя].
 */
export interface Docs {
  file: string; // JSDoc в начале файла, до кода: что это за capability или стандарт
  describes: Map<string, string>; // JSDoc вплотную перед describe
  tests: Map<string, string>; // JSDoc вплотную перед it / test
}

/**
 * Текст JSDoc без скобок комментария и ведущих `*`; строки сохраняются (markdown), пустые по краям
 * и повторные сняты. Блочные теги (@see, @param…) — не проза: с первого тега всё отброшено.
 */
export function jsdocText(comment: string): string {
  const lines = comment
    .slice(3, -2)
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\*(?= |$))? ?/, "").trimEnd());
  const tag = lines.findIndex((l) => /^@\w/.test(l));
  const out: string[] = [];
  for (const l of tag >= 0 ? lines.slice(0, tag) : lines) if (l || out[out.length - 1]) out.push(l);
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

/**
 * Сканер без полного парсера: строки, комментарии, скобки; describe с телом-колбэком
 * (после `=>` или `function(...)`) открывает вложенность, it/test — тест. Имя — только
 * строковый литерал первым аргументом (у .each / .for — второго вызова); вызов с
 * выражением вместо имени пропускается.
 */
export function parseJs(file: string, source: string): Test[] {
  return scanJs(file, source).tests;
}

/** JSDoc-проза исходника: у файла, у describe и у it / test (см. `scanJs`). */
export function parseDocs(file: string, source: string): Docs {
  return scanJs(file, source).docs;
}

/**
 * Один проход сканера — тесты и проза. JSDoc относится к ближайшему коду после него
 * (комментарии между ними не мешают): вызов describe / it — его проза; первый JSDoc файла,
 * за которым идёт не вызов (обычно импорты), — проза файла. `//` и блочный комментарий с одной
 * звёздочкой — не проза.
 */
export function scanJs(file: string, source: string): { tests: Test[]; docs: Docs } {
  const s = source;
  const n = s.length;
  let i = s.startsWith("#!") ? skipLineComment(s, 0) : 0;
  let depth = 0;
  let paren = 0;
  const stack: { name: string; depth: number }[] = []; // describe и глубина фигурных скобок его тела
  let pending: { name: string; paren: number } | null = null; // describe, у которого ещё не найдено тело
  const out: Test[] = [];
  const docs: Docs = { file: "", describes: new Map(), tests: new Map() };
  let doc: { text: string } | null = null; // последний JSDoc, пока после него не было кода
  let fileDoc: { text: string } | null = null; // первый JSDoc до кода
  let code = false;

  const addDoc = (m: Map<string, string>, chain: string[], text: string): void => {
    if (!text) return;
    const k = JSON.stringify(chain);
    const prev = m.get(k);
    m.set(k, prev && prev !== text ? prev + "\n\n" + text : text);
  };

  const prevSig = (j: number): string => {
    let k = j - 1;
    while (k >= 0 && WS.includes(s[k]!)) k--;
    return k >= 0 ? s[k]! : "";
  };
  const skipWs = (j: number): number => {
    while (j < n && WS.includes(s[j]!)) j++;
    return j;
  };

  while (i < n) {
    const c = s[i]!;
    if (c === "/" && s.startsWith("//", i)) {
      i = skipLineComment(s, i);
      continue;
    }
    if (c === "/" && s.startsWith("/*", i)) {
      const end = skipBlockComment(s, i);
      if (s.startsWith("/**", i) && !s.startsWith("/**/", i)) {
        doc = { text: jsdocText(s.slice(i, end)) };
        if (!code && !fileDoc) fileDoc = doc;
      }
      i = end;
      continue;
    }
    if (WS.includes(c)) {
      i++;
      continue;
    }
    // код: JSDoc до него — проза этого кода (вызова describe / it), дальше не тянется
    const d = doc;
    doc = null;
    code = true;
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "{") {
      depth++;
      if (pending && paren === pending.paren + 1 && (prevSig(i) === ">" || prevSig(i) === ")")) {
        stack.push({ name: pending.name, depth });
        pending = null;
      }
      i++;
      continue;
    }
    if (c === "}") {
      if (stack.length && stack[stack.length - 1]!.depth === depth) stack.pop();
      depth--;
      i++;
      continue;
    }
    if (c === "(") {
      paren++;
      i++;
      continue;
    }
    if (c === ")") {
      paren--;
      if (pending && paren <= pending.paren) pending = null;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      JS_CALL.lastIndex = i;
      const m = JS_CALL.exec(s);
      const mods = m ? m[2]!.split(".").filter(Boolean) : [];
      if (m && mods.every((x) => MODS_OK.has(x))) {
        if (d && d === fileDoc) fileDoc = null; // вплотную к вызову — проза вызова, а не файла
        const kind = m[1]!;
        const p0 = paren;
        let j = m.index + m[0].length;
        paren++;
        if (mods.includes("each") || mods.includes("for")) {
          j = skipBalanced(s, j);
          paren--;
          const k = skipWs(j);
          if (s[k] === "(") {
            j = k + 1;
            paren++;
          } else {
            i = j;
            continue;
          }
        }
        const k = skipWs(j);
        const q = s[k];
        if (q === "'" || q === '"' || q === "`") {
          const end = skipString(s, k);
          const name = unescape(s.slice(k + 1, end - 1));
          const chain = [...stack.map((x) => x.name), name];
          if (DESCRIBE_KINDS.has(kind)) {
            pending = { name, paren: p0 };
            addDoc(docs.describes, chain, d?.text ?? "");
          } else {
            out.push(makeTest(file, chain.slice(0, -1), name));
            addDoc(docs.tests, chain, d?.text ?? "");
          }
          i = end;
          continue;
        }
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && isIdentChar(s[j]!)) j++;
      i = j;
      continue;
    }
    i++;
  }
  docs.file = fileDoc?.text ?? "";
  return { tests: out, docs };
}
