/**
 * speclib — общее для spec-doc, spec-diff, spec-publish, spec-exceptions и харнесса: дерево tests/, модель теста,
 * `Source:` публикации, разбор отчётов раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML
 * от `bun test`), разбор исходников тестов парсером (describe/it/test для TS/JS: названия и
 * проза из JSDoc) и правило файлов исключений папки решения (`exceptionFile`).
 *
 * Запуск — Bun (`bun script.ts`; только `node:`-API, поэтому идёт и под Node ≥ 22.18), без
 * зависимостей (парсер — файл скилла `vendor/babel-parser.cjs`) и без конфигурации под
 * репозиторий: дерево tests/ из правила «Specification — decisions» (skills/spec/canon.md) и
 * стандартные форматы отчётов.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as babel from "./vendor/babel-parser.cjs";

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

// ---------- разбор исходников ----------

/** Узел AST Babel: вид, границы в исходнике и поля своего вида. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  loc: { start: { line: number; column: number } };
  [field: string]: unknown;
}

/** Комментарий из разбора: блочный или строчный, границы в исходнике. */
interface AstComment {
  type: "CommentBlock" | "CommentLine";
  start: number;
  end: number;
}

interface Parsed {
  program: AstNode & { interpreter?: AstNode | null };
  comments: AstComment[];
}

/*
 * Парсер — `@babel/parser` 7.29.9 файлом в скилле: `vendor/babel-parser.cjs` — `lib/index.js` пакета (один файл без
 * `require`) без последней строки `//# sourceMappingURL` — карты рядом нет, Vitest ищет её и печатает ошибку; типы —
 * `vendor/babel-parser.d.cts`, лицензия рядом. Скрипты скилла — без зависимостей, job `spec-diff` в CI проекта — без
 * установки пакетов. Обновить — `npm pack @babel/parser`: его `lib/index.js` и `LICENSE` — сюда, версию — в этот
 * комментарий. Свой лексер угадывал, где регулярка, шаблон, комментарий и аргумент типа, и терял тесты молча (#267,
 * #269, #271, #275); синтаксис TypeScript шире любой догадки (#277).
 *
 * Импорт статический, вверху файла: `createRequire(import.meta.url)` ломал Playwright и Jest в проекте без
 * `"type": "module"` — они грузят TS как CommonJS, где `import.meta` — синтаксическая ошибка (#303,
 * tests/standards/harness-load).
 */

const OPTIONS = {
  sourceType: "module",
  // ошибки, после которых AST есть (строгий режим, декоратор параметра), разбору не мешают
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowUndeclaredExports: true,
  allowNewTargetOutsideFunction: true,
  allowSuperOutsideMethod: true,
};
// декораторы — и в позиции после export, и у параметров (TS experimentalDecorators — ошибкой с восстановлением)
const DECORATORS = ["decorators", "decoratorAutoAccessors"];

/**
 * Наборы плагинов по расширению файла, по порядку попыток: `.ts` — без JSX (`<T>x` — приведение типа), `.tsx` — с
 * JSX, JS — с JSX; файл неизвестен — TypeScript, затем TSX.
 */
function pluginSets(file?: string): unknown[][] {
  const ts = ["typescript", ...DECORATORS];
  if (file && /\.d\.[cm]?ts$/.test(file)) return [[["typescript", { dts: true }], ...DECORATORS]];
  if (file && /\.[cm]?ts$/.test(file)) return [ts];
  if (file && /\.tsx$/.test(file)) return [[...ts, "jsx"]];
  if (file && /\.[cm]?jsx?$/.test(file)) return [["jsx", ...DECORATORS]];
  return [ts, [...ts, "jsx"]];
}

/** AST исходника TS/JS; не разобрать — ошибка с местом (`Unexpected token (3:7)`). */
function parseCode(source: string, file?: string): Parsed {
  let first: Error | undefined;
  for (const plugins of pluginSets(file)) {
    try {
      return babel.parse(source, { ...OPTIONS, plugins }) as Parsed;
    } catch (e) {
      first ??= e as Error;
    }
  }
  throw new Error(`не разобран: ${first!.message}`);
}

const isNode = (v: unknown): v is AstNode => !!v && typeof v === "object" && typeof (v as AstNode).type === "string" && typeof (v as AstNode).start === "number";

/** Дочерние узлы в порядке исходника; комментарии, привязанные к узлу, — не узлы. */
function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.endsWith("Comments")) continue;
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Обход AST в порядке исходника: visit вернул false — внутрь узла не идти. */
function walkAst(node: AstNode, visit: (n: AstNode) => boolean | void): void {
  if (visit(node) === false) return;
  for (const c of children(node)) walkAst(c, visit);
}

/** Комментарии исходника по разбору — [начало, текст]; шебанг — тоже комментарий. */
export function commentsOf(source: string, file?: string): [number, string][] {
  const ast = parseCode(source, file);
  const out: [number, string][] = ast.comments.map((c) => [c.start, source.slice(c.start, c.end)]);
  const bang = ast.program.interpreter;
  if (bang) out.unshift([bang.start, source.slice(bang.start, bang.end)]);
  return out;
}

/** Строки исходника, известные без прогона: литералы и шаблоны без подстановок. */
export function stringsOf(source: string, file?: string): string[] {
  const out: string[] = [];
  walkAst(parseCode(source, file).program, (n) => {
    const s = staticString(n);
    if (s !== null && n.type !== "BinaryExpression") out.push(s);
  });
  return out;
}

/** Имя вызываемого: `f(…)` и `x.f(…)` — `f`; вычисляемое — null. */
function calleeName(call: AstNode): string | null {
  const callee = call.callee as AstNode;
  const id = callee.type === "MemberExpression" && !callee.computed ? (callee.property as AstNode) : callee;
  return id.type === "Identifier" ? (id.name as string) : null;
}

/**
 * Значения опции `key` объектов литералом в аргументах вызова (ключ — имя или строка): `invariant(it, { registry: … })`.
 * Объект переменной или `...spec()` не вычислить без прогона.
 */
function optionValues(call: AstNode, key: string): AstNode[] {
  const out: AstNode[] = [];
  for (const a of call.arguments as AstNode[]) {
    if (a.type !== "ObjectExpression") continue;
    for (const p of a.properties as AstNode[]) {
      if (p.type !== "ObjectProperty" || p.computed) continue;
      const k = p.key as AstNode;
      if ((k.type === "Identifier" ? k.name : k.type === "StringLiteral" ? k.value : null) === key) out.push(p.value as AstNode);
    }
  }
  return out;
}

/** Значения опции `key` — строки, известные без прогона. */
function optionsOf(call: AstNode, key: string): string[] {
  return optionValues(call, key).flatMap((v) => staticString(v) ?? []);
}

/**
 * Вызовы харнесса и имя проверки по опциям вызова: у invariant — реестр (его `rule` — соглашение папки, не имя), у
 * examples — правило линтера, у deadCode — `rule` запуска (`production: true` без него — «production»), у architecture
 * имени нет — модель одна. null — имени нет или его не вычислить без прогона.
 */
const HARNESS_NAMES: Record<string, (call: AstNode) => string | null> = {
  invariant: (n) => optionsOf(n, "registry")[0] ?? null,
  examples: (n) => optionsOf(n, "rule")[0] ?? null,
  deadCode: (n) => optionsOf(n, "rule")[0] ?? (optionValues(n, "production").some((v) => v.type === "BooleanLiteral" && v.value === true) ? "production" : null),
  architecture: () => null,
};

/** Вызовы харнесса: describe, в котором вызван любой из них, — сценарий стандарта (`spec-diff --scenarios`). */
export const HARNESS_CALLS: readonly string[] = Object.keys(HARNESS_NAMES);

/** Проверка харнесса в исходнике: вызов, цепочка describe на его месте и реестр или правило (null — не вычислить без прогона). */
export interface HarnessCall {
  call: string;
  describes: string[];
  value: string | null;
}

/** Строка, известная без прогона: литерал, шаблон без подстановок или их сложение через `+`; иначе null. */
function staticString(n: AstNode | undefined): string | null {
  if (!n) return null;
  if (n.type === "StringLiteral") return n.value as string;
  if (n.type === "TemplateLiteral") {
    const quasis = n.quasis as { value: { cooked: string | null } }[];
    return quasis.length === 1 ? quasis[0]!.value.cooked : null;
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const a = staticString(n.left as AstNode);
    const b = a === null ? null : staticString(n.right as AstNode);
    return b === null ? null : a + b;
  }
  return null;
}

// describe / it / test / suite / context (+ x/f-варианты Jest, test.describe Playwright), модификаторы — только из
// списка: test.step, test.use, test.beforeEach и т. п. — не тесты
const KIND = /^[xf]?(describe|it|test|suite|context)$/;
const DESCRIBE_KINDS = new Set(["describe", "suite", "context"]);
const MODS_OK = new Set([
  "skip", "only", "todo", "each", "for", "concurrent", "sequential", "fails",
  "runIf", "skipIf", "serial", "parallel", "fixme", "fail", "shuffle",
]);
// модификаторы с двумя вызовами: `it.each(таблица)(имя, …)`, `it.each\`таблица\`(имя, …)`, `it.skipIf(условие)(имя, …)`
const CURRIED = ["each", "for", "runIf", "skipIf"];

/** Вид вызова теста по цепочке имён (`test.describe.serial` → describe); не тест — null. */
function testCallee(n: unknown): { kind: string; curried: boolean } | null {
  const names: string[] = [];
  let c = n as AstNode;
  while (isNode(c) && c.type === "MemberExpression" && !c.computed && (c.property as AstNode).type === "Identifier") {
    names.unshift((c.property as AstNode).name as string);
    c = c.object as AstNode;
  }
  if (!isNode(c) || c.type !== "Identifier") return null;
  names.unshift(c.name as string);
  const at = names[0] === "test" && names.length > 1 && KIND.test(names[1]!) ? 1 : 0;
  const kind = KIND.exec(names[at]!)?.[1];
  const mods = names.slice(at + 1);
  if (!kind || !mods.every((x) => MODS_OK.has(x))) return null;
  return { kind, curried: mods.some((x) => CURRIED.includes(x)) };
}

/** Вызов теста или describe — вид и аргументы с именем первым; таблица `.each(…)` и иной вызов — null. */
function testCall(call: AstNode): { kind: string; args: AstNode[] } | null {
  const args = call.arguments as AstNode[];
  const direct = testCallee(call.callee);
  if (direct) return direct.curried ? null : { kind: direct.kind, args };
  const callee = call.callee as AstNode;
  const inner = callee.type === "CallExpression" ? callee.callee : callee.type === "TaggedTemplateExpression" ? callee.tag : null;
  const curried = testCallee(inner);
  return curried?.curried ? { kind: curried.kind, args } : null;
}

const isFunction = (n: AstNode): boolean => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression";

/**
 * Проза из JSDoc исходника — то, чего не видно из названий. Ключи — JSON цепочки имён,
 * как у теста: describe — [describes…], it — [describes…, имя].
 */
export interface Docs {
  file: string; // JSDoc в начале файла, до кода: что это за capability или стандарт
  describes: Map<string, string>; // JSDoc вплотную перед describe
  tests: Map<string, string>; // JSDoc вплотную перед it / test
}

/** Вызов теста или describe, чьё название не вычислить без прогона (шаблон с подстановкой, переменная). */
export interface Unnamed {
  line: number;
  kind: string;
  /** Выражение названия из исходника, сокращённое. */
  name: string;
  /** JSDoc вплотную перед вызовом — проза, которую не к чему привязать. */
  doc: string;
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
 * JSDoc по месту кода: проза — последний JSDoc перед кодом, комментарии между ними не мешают. Комментарии подряд, между
 * которыми только пробелы, — одна группа; ключ — начало кода после группы. Первый JSDoc группы до всякого кода —
 * кандидат в прозу файла. `//` и блочный комментарий с одной звёздочкой — не проза.
 */
function jsdocs(source: string, ast: Parsed): { at: Map<number, string>; head: { at: number; text: string } | null } {
  const at = new Map<number, string>();
  let head: { at: number; text: string } | null = null;
  const blank = (from: number, to: number) => !source.slice(from, to).trim();
  const isDoc = (c: AstComment) => source.startsWith("/**", c.start) && !source.startsWith("/**/", c.start);
  const comments = ast.comments;
  const codeFrom = ast.program.interpreter?.end ?? 0;
  for (let i = 0; i < comments.length; ) {
    let j = i;
    while (j + 1 < comments.length && blank(comments[j]!.end, comments[j + 1]!.start)) j++;
    const group = comments.slice(i, j + 1);
    let after = comments[j]!.end;
    while (after < source.length && /\s/.test(source[after]!)) after++;
    const docs = group.filter(isDoc).map((c) => jsdocText(source.slice(c.start, c.end)));
    if (docs.length) {
      at.set(after, docs[docs.length - 1]!);
      if (i === 0 && blank(codeFrom, group[0]!.start)) head = { at: docs.length > 1 ? -1 : after, text: docs[0]! };
    }
    i = j + 1;
  }
  return { at, head };
}

/** Тесты из исходника TS/JS. */
export function parseJs(file: string, source: string): Test[] {
  return scanJs(file, source).tests;
}

/**
 * Тесты и проза исходника по AST. Имя — строка, известная без прогона (литерал, шаблон без подстановок), первым
 * аргументом вызова (у .each / .for / .runIf / .skipIf — второго), аргумент типа `<…>` в любом месте; describe
 * открывает вложенность для всех своих аргументов. Название, которое не вычислить, — в `unnamed`, вызов не
 * разбирается дальше: цепочка его тестов неизвестна. JSDoc вплотную перед вызовом — его проза; первый JSDoc файла, за
 * которым идёт не вызов (обычно импорты), — проза файла. Вызовы харнесса (`HARNESS_CALLS`) — в `checks` с цепочкой
 * describe: их тесты в исходнике не названы. Не разобрать — ошибка.
 */
export function scanJs(file: string, source: string): { tests: Test[]; docs: Docs; unnamed: Unnamed[]; checks: HarnessCall[] } {
  const ast = parseCode(source, file);
  const doc = jsdocs(source, ast);
  const out: Test[] = [];
  const unnamed: Unnamed[] = [];
  const checks: HarnessCall[] = [];
  const docs: Docs = { file: "", describes: new Map(), tests: new Map() };
  const calls = new Set<number>(); // начала вызовов тестов: JSDoc перед ними — не проза файла

  const addDoc = (m: Map<string, string>, chain: string[], text: string | undefined): void => {
    if (!text) return;
    const k = JSON.stringify(chain);
    const prev = m.get(k);
    m.set(k, prev && prev !== text ? prev + "\n\n" + text : text);
  };

  const visit = (chain: string[]) => (n: AstNode): boolean => {
    if (n.type !== "CallExpression") return true;
    const call = testCall(n);
    if (!call) {
      const name = calleeName(n);
      if (name !== null && Object.hasOwn(HARNESS_NAMES, name)) checks.push({ call: name, describes: chain, value: HARNESS_NAMES[name]!(n) });
      return true;
    }
    calls.add(n.start);
    const [first, ...rest] = call.args;
    const name = staticString(first);
    if (name === null) {
      // `test.fail()`, `test.skip(условие, "причина")` Playwright — не тест: колбэка нет
      if (!first || !rest.some(isFunction)) return true;
      const text = source.slice(first.start, first.end).replace(/\s+/g, " ");
      unnamed.push({ line: first.loc.start.line, kind: call.kind, name: text.length > 60 ? text.slice(0, 59) + "…" : text, doc: doc.at.get(n.start) ?? "" });
      return false;
    }
    const inner = [...chain, name];
    if (DESCRIBE_KINDS.has(call.kind)) {
      addDoc(docs.describes, inner, doc.at.get(n.start));
    } else {
      // тело — остаток аргументов вызова: переименованный тест с той же проверкой узнаётся по нему
      const t = makeTest(file, chain, name);
      t.body = source.slice(first!.end, n.end - 1).replace(/\s+/g, "");
      out.push(t);
      addDoc(docs.tests, inner, doc.at.get(n.start));
    }
    for (const a of rest) walkAst(a, visit(DESCRIBE_KINDS.has(call.kind) ? inner : chain));
    return false;
  };
  walkAst(ast.program, visit([]));
  if (doc.head && !calls.has(doc.head.at)) docs.file = doc.head.text;
  return { tests: out, docs, unnamed, checks };
}
