/**
 * speclib — общее для spec-doc, spec-diff, spec-publish, spec-exceptions и харнесса: дерево tests/, модель теста,
 * `Source:` публикации, разбор отчётов раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML
 * от `bun test`), статический разбор исходников тестов (сканер describe/it/test для TS/JS:
 * названия и проза из JSDoc) и правило файлов исключений папки решения (`exceptionFile`).
 *
 * Запуск — Bun (`bun script.ts`; только `node:`-API, поэтому идёт и под Node ≥ 22.18), без
 * зависимостей и без конфигурации под репозиторий: дерево tests/ из правила
 * «Спецификация — решения» (skills/spec/canon.md) и стандартные форматы отчётов.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const posix = path.posix;

export const TESTS = "tests";

/**
 * SHA исходника из сообщения коммита публикации (`Source: <sha>`, пишет spec-publish): 40 знаков — SHA-1, 64 — SHA-256.
 * Выражение одно на spec-publish и spec-diff: разойдутся — один скрипт перестанет узнавать публикации другого.
 */
export const sourceOf = (message: string): string | undefined => /^Source: ([0-9a-f]{40,64})$/m.exec(message)?.[1];
export type Kind = "capability" | "architecture" | "standard" | "lib" | "out";
export type Status = "passed" | "failed" | "skipped" | "todo";

export interface Test {
  path: string; // путь файла относительно корня, posix
  describes: string[]; // цепочка describe
  name: string; // it / test
  status: Status;
  reason: string; // причина пропуска, если отчёт её знает
  variants: number; // одинаковые записи из нескольких отчётов (проекты Playwright) свёрнуты
  body?: string; // аргументы вызова после названия без пробелов — только из разбора исходника (тело теста)
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

/** «1 тест», «2 теста», «5 тестов»: число и форма слова по правилам русского. */
export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return `${n} ${one}`;
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const testsWord = (n: number) => plural(n, "тест", "теста", "тестов");

// Файлы тестов: *.test.ts / *.spec.ts / *.e2e.ts (и js/jsx/tsx/mjs/cjs…)
const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

export function isTestFile(p: string): boolean {
  return TEST_FILE.test(p);
}

/**
 * (вид, имя) для пути относительно корня: capability / правило архитектуры / стандарт с именем папки,
 * lib — не спека, out — вне дерева (в том числе файл прямо в tests/capabilities/ или tests/architecture/).
 */
export function classify(p: string): [Kind, string | null] {
  const parts = p.split("/");
  if (parts.length >= 4 && parts[0] === TESTS) {
    if (parts[1] === "capabilities") return ["capability", parts[2]!];
    if (parts[1] === "architecture") return ["architecture", parts[2]!];
    if (parts[1] === "standards") return ["standard", parts[2]!];
  }
  if (parts.length >= 3 && parts[0] === TESTS && parts[1] === "lib") return ["lib", null];
  return ["out", null];
}

/** Папка решения теста — `tests/<вид>/<имя>`; тест вне дерева решений — null. */
export function decisionFolder(file: string): string | null {
  const [kind] = classify(file);
  return kind === "capability" || kind === "architecture" || kind === "standard" ? file.split("/").slice(0, 3).join("/") : null;
}

/** Исключения папки решения — каталог `exceptions/`, файл на элемент реестра харнесса (`exceptionsIn`). */
export const EXCEPTIONS_DIR = "exceptions";

/**
 * Исключения названий spec-doc — каталог `names.exceptions/` папки решения, файл на название: параллельные PR
 * снимают каждый свой файл, а в общем массиве соседние строки конфликтовали.
 */
export const NAMES_DIR = "names.exceptions";

// прежний формат — массив в одном файле: exceptions.ts харнесса, names.exceptions.ts spec-doc
const LEGACY_EXCEPTIONS = /^(names\.)?exceptions\.(ts|mts|js|mjs|json)$/;

/** Чей файл исключений и в каком виде. */
export interface ExceptionFile {
  /** Папка решения `tests/<вид>/<имя>`, чьи это исключения. */
  folder: string;
  /** Каталог исключений папки: элементы реестров харнесса или названия spec-doc. */
  dir: typeof EXCEPTIONS_DIR | typeof NAMES_DIR;
  /** Прежний формат — массив в одном файле папки или её подпапки: переносит spec-exceptions в каталог `dir` папки. */
  legacy: boolean;
  /** Не на месте или не того вида — что не так; такой файл исключением не читается. */
  error?: string;
}

/**
 * Файл исключений какой папки решения? Одно правило на харнесс, spec-doc, spec-diff и spec-exceptions; копия в скилле
 * github (`pr labels`: механическая правка) сверяется с ним стандартом `tests/standards/exception-files`.
 *
 * - `tests/<вид>/<имя>/exceptions/<элемент>.json` (`names.exceptions/<название>.json`) — исключение папки;
 * - иной файл в каталоге (не `.json`, вложенный каталог) — ошибка: исключение — JSON-файл;
 * - каталог в подпапке папки решения — ошибка: каталог один на папку, его читает `exceptionsIn()` теста любой подпапки;
 * - `exceptions.{ts,mts,js,mjs,json}` (`names.exceptions.*`) в папке или подпапке — прежний формат исключений папки;
 * - вне папок решений и скрытые файлы — не исключения (null).
 */
export function exceptionFile(p: string): ExceptionFile | null {
  const folder = decisionFolder(p);
  if (folder === null) return null;
  const inner = p.split("/").slice(3);
  if (inner.some((s) => s.startsWith("."))) return null;
  const at = inner.findIndex((s, i) => (i < inner.length - 1 ? s === EXCEPTIONS_DIR || s === NAMES_DIR : LEGACY_EXCEPTIONS.test(s)));
  if (at < 0) return null;
  if (at === inner.length - 1) return { folder, dir: inner[at]!.startsWith(`${NAMES_DIR}.`) ? NAMES_DIR : EXCEPTIONS_DIR, legacy: true };
  const dir = inner[at] as ExceptionFile["dir"];
  const what = dir === NAMES_DIR ? "исключения названий" : "исключения";
  if (at > 0) return { folder, dir, legacy: false, error: `${what} — только в ${folder}/${dir}/ папки решения, не в подпапке` };
  if (inner.length > 2 || !p.endsWith(".json")) {
    const form = dir === NAMES_DIR ? "исключение названия — файл <название>.json с { file, name, issue, reason }" : "исключение — файл <элемент>.json с { item, issue, reason }";
    return { folder, dir, legacy: false, error: form };
  }
  return { folder, dir, legacy: false };
}

/** Исключение названия: тест, название, задача на переписывание и причина. */
export interface NameException {
  file: string;
  name: string;
  issue: number;
  reason: string;
}

/**
 * Исключение названия файлом в `<папка>/names.exceptions/`: имя — название латиницей (стабильно, видно в диффе);
 * занято другим исключением — суффикс, тот же текст — тот же файл. Возвращает путь от корня.
 */
export function writeNameException(root: string, folder: string, x: NameException): string {
  const dir = `${folder}/${NAMES_DIR}`;
  const body = JSON.stringify({ file: x.file, name: x.name, issue: x.issue, reason: x.reason }, null, 2) + "\n";
  const slug = x.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 100) || "name";
  let name = slug;
  for (let n = 2; existsSync(path.join(root, dir, `${name}.json`)) && readFileSync(path.join(root, dir, `${name}.json`), "utf8") !== body; n++) name = `${slug}-${n}`;
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, `${name}.json`), body);
  return `${dir}/${name}.json`;
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
/** Пробел JS — WhiteSpace и LineTerminator стандарта (NBSP, `\f`, BOM…), ровно `\s` регулярок JS: одно понятие на весь обход. */
const isSpace = (c: string): boolean => /\s/.test(c);

function skipLineComment(s: string, i: number): number {
  const j = s.indexOf("\n", i);
  return j < 0 ? s.length : j;
}

function skipBlockComment(s: string, i: number): number {
  const j = s.indexOf("*/", i + 2);
  return j < 0 ? s.length : j + 2;
}

/** Кусок исходника JS в обходе: комментарий (и шебанг), строка (шаблон — целиком, с `${…}`), регулярка, пробел, символ кода. */
export type JsPart = "comment" | "string" | "regex" | "space" | "code";

/**
 * Один обход кода JS — для сканера названий (`scanJs`, `skipBalanced`, шаблоны) и харнесса (`commentsIn`): next()
 * отдаёт кусок с позиции i. Регулярку от деления отличает `regexAfter` по последнему значащему символу кода, который
 * ведёт сам обход: комментарии и пробелы его не сдвигают. Копии обхода расходились в том, что считать пробелом, и
 * NBSP перед регуляркой одному был кодом, другому — нет.
 */
export class JsWalk {
  readonly s: string;
  /** Позиция обхода: конец куска, который вернул next(). */
  i: number;
  /** Начало куска, который вернул next(). */
  start: number;
  /** Последний значащий символ кода (< 0 — кода не было): по нему решает regexAfter. */
  last: number;

  /** С позиции i: символ перед ней — код (`(`, `{` в `${`); с 0 — начало файла. */
  constructor(s: string, i = 0) {
    this.s = s;
    this.i = this.start = i;
    this.last = i - 1;
  }

  next(): JsPart {
    const s = this.s;
    const i = (this.start = this.i);
    const c = s[i]!;
    let part: JsPart = "code";
    let end = i + 1;
    if ((c === "/" && s[i + 1] === "/") || (c === "#" && i === 0 && s[1] === "!")) {
      part = "comment"; // шебанг — тоже
      end = skipLineComment(s, i);
    } else if (c === "/" && s[i + 1] === "*") {
      part = "comment";
      end = skipBlockComment(s, i);
    } else if (isSpace(c)) {
      part = "space";
    } else if (c === "'" || c === '"' || c === "`") {
      part = "string";
      end = skipString(s, i);
    } else if (c === "/" && regexAfter(s, this.last)) {
      part = "regex";
      end = skipRegex(s, i);
    }
    this.i = end;
    if (part !== "comment" && part !== "space") this.last = end - 1;
    return part;
  }

  /** Код до j разобран снаружи (вызов, имя теста, скобки) — обход продолжается с j. */
  skip(j: number): void {
    this.i = j;
    this.last = j - 1;
  }
}

/** i — открывающая кавычка; вернуть индекс после закрывающей. Шаблонные строки — с ${…}. */
function skipString(s: string, i: number): number {
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

// после них `/` начинает регулярное выражение, а не деление
const BEFORE_REGEX = "(,=:[!&|?{};+-*%<>~^";
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw", "instanceof", "new"]);

/**
 * `/` после кода, который кончается в last, — начало регулярки, а не деление: по символу или слову (не свойству)
 * в last; last < 0 — кода до `/` нет. last — последний значащий символ кода: его ведёт обход `JsWalk`, комментарии и
 * пробелы его не меняют — иначе символ берётся из комментария. Одно правило для названий тестов и харнесса.
 */
function regexAfter(s: string, last: number): boolean {
  if (last < 0 || BEFORE_REGEX.includes(s[last]!)) return true;
  let b = last;
  while (b >= 0 && isIdentChar(s[b]!)) b--;
  return s[b] !== "." && REGEX_WORDS.has(s.slice(b + 1, last + 1));
}

/**
 * i — открывающий `/` регулярного выражения; индекс после флагов. Классы `[…]` и экранирование учтены. Литерал
 * регулярки не переносится на другую строку: без закрывающего `/` в строке это не регулярка — индекс после `/`.
 */
function skipRegex(s: string, i: number): number {
  let j = i + 1;
  let cls = false;
  while (j < s.length && s[j] !== "\n") {
    const c = s[j]!;
    if (c === "\\") j++;
    else if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) break;
    j++;
  }
  if (s[j] !== "/") return i + 1;
  j++;
  while (j < s.length && /[a-z]/i.test(s[j]!)) j++;
  return j;
}

/** i — индекс после `${`; вернуть индекс после парной `}`. */
function skipTemplateExpr(s: string, i: number): number {
  const w = new JsWalk(s, i);
  for (let d = 0; w.i < s.length; ) {
    if (w.next() !== "code") continue;
    const c = s[w.start];
    if (c === "{") d++;
    else if (c === "}") {
      if (d === 0) return w.i;
      d--;
    }
  }
  return s.length;
}

/** i — индекс после '('; вернуть индекс после парной ')'. */
export function skipBalanced(s: string, i: number): number {
  const w = new JsWalk(s, i);
  for (let d = 1; d && w.i < s.length; ) {
    if (w.next() !== "code") continue;
    const c = s[w.start];
    if (c === "(") d++;
    else if (c === ")") d--;
  }
  return w.i;
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

/**
 * Один проход сканера — тесты и проза. JSDoc относится к ближайшему коду после него
 * (комментарии между ними не мешают): вызов describe / it — его проза; первый JSDoc файла,
 * за которым идёт не вызов (обычно импорты), — проза файла. `//` и блочный комментарий с одной
 * звёздочкой — не проза.
 */
export function scanJs(file: string, source: string): { tests: Test[]; docs: Docs } {
  const s = source;
  const n = s.length;
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

  const skipSpace = (j: number): number => {
    while (j < n && isSpace(s[j]!)) j++;
    return j;
  };

  const w = new JsWalk(s);
  while (w.i < n) {
    const before = w.last; // значащий символ кода перед куском: `=>` или `)` перед телом describe
    const part = w.next();
    const i = w.start;
    if (part === "comment") {
      if (s.startsWith("/**", i) && !s.startsWith("/**/", i)) {
        doc = { text: jsdocText(s.slice(i, w.i)) };
        if (!code && !fileDoc) fileDoc = doc;
      }
      continue;
    }
    if (part === "space") continue;
    // код: JSDoc до него — проза этого кода (вызова describe / it), дальше не тянется
    const d = doc;
    doc = null;
    code = true;
    if (part !== "code") continue; // строка или регулярка
    const c = s[i]!;
    if (c === "{") {
      depth++;
      if (pending && paren === pending.paren + 1 && (s[before] === ">" || s[before] === ")")) {
        stack.push({ name: pending.name, depth });
        pending = null;
      }
      continue;
    }
    if (c === "}") {
      if (stack.length && stack[stack.length - 1]!.depth === depth) stack.pop();
      depth--;
      continue;
    }
    if (c === "(") {
      paren++;
      continue;
    }
    if (c === ")") {
      paren--;
      if (pending && paren <= pending.paren) pending = null;
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
          const k = skipSpace(j);
          if (s[k] === "(") {
            j = k + 1;
            paren++;
          } else {
            w.skip(j);
            continue;
          }
        }
        const k = skipSpace(j);
        const q = s[k];
        if (q === "'" || q === '"' || q === "`") {
          const end = skipString(s, k);
          const name = unescape(s.slice(k + 1, end - 1));
          const chain = [...stack.map((x) => x.name), name];
          if (DESCRIBE_KINDS.has(kind)) {
            pending = { name, paren: p0 };
            addDoc(docs.describes, chain, d?.text ?? "");
          } else {
            // тело — остаток аргументов вызова: переименованный тест с той же проверкой узнаётся по нему
            const t = makeTest(file, chain.slice(0, -1), name);
            t.body = s.slice(end, Math.max(end, skipBalanced(s, end) - 1)).replace(/\s+/g, "");
            out.push(t);
            addDoc(docs.tests, chain, d?.text ?? "");
          }
          w.skip(end);
          continue;
        }
        w.skip(j);
        continue;
      }
      let j = i + 1;
      while (j < n && isIdentChar(s[j]!)) j++;
      w.skip(j);
    }
  }
  docs.file = fileDoc?.text ?? "";
  return { tests: out, docs };
}
