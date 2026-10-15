/**
 * speclib — shared by spec-doc, spec-diff, spec-publish, spec-exceptions, spec-shard and the harness: the tests/ tree,
 * the test model, the publication's `Source:`, parsing of runner reports (Vitest/Jest JSON, Playwright JSON, JUnit XML
 * from `bun test`) and test files' durations from them, parsing of test sources with a parser (describe/it/test for
 * TS/JS: names and prose from JSDoc), the rule for a decision folder's exception files (`exceptionFile`) and the "a
 * name is a statement" rule (`isStatement`).
 *
 * The scripts run under Bun (`bun script.ts`); the harness imports this module too, and a project's test loads the
 * harness under the project's runner, Node included — so only `node:` APIs and erasable TypeScript
 * (tests/standards/harness-load). Without dependencies (the parser is the skill's file `vendor/babel-parser.cjs`) and
 * without per-repository configuration: the tests/ tree from the rule "Specification — decisions"
 * (skills/spec/canon.md) and the standard report formats.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import locale from "../../github/scripts/locale.ts";
import * as babel from "./vendor/babel-parser.cjs";

const posix = path.posix;

export const TESTS = "tests";

/**
 * Source SHA from a publication commit message (`Source: <sha>`, written by spec-publish): 40 chars — SHA-1, 64 —
 * SHA-256. One expression for spec-publish and spec-diff: if they diverge, one script stops recognizing the other's
 * publications.
 */
export const sourceOf = (message: string): string | undefined => /^Source: ([0-9a-f]{40,64})$/m.exec(message)?.[1];
export type Kind = "capability" | "architecture" | "standard" | "lib" | "out";
export type Status = "passed" | "failed" | "skipped" | "todo";

export interface Test {
  path: string; // file path relative to the root, posix
  describes: string[]; // describe chain
  name: string; // it / test
  status: Status;
  reason: string; // skip reason, if the report knows it
  variants: number; // identical records from several reports (Playwright projects) are folded
  body?: string; // call arguments after the name without whitespace — only from source parsing (the test body)
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

/** Requirement identity: folder path + describe + it (the file inside the folder doesn't matter). */
export function keyOf(t: Test): string {
  return JSON.stringify([folderOf(t), t.describes, t.name]);
}

export function titleOf(t: Test): string {
  return [...t.describes, t.name].map(mdText).join(" › ");
}

/**
 * A test or describe name for markdown: `<` outside a code span is escaped — otherwise GitHub takes `<type>` or
 * `<!-- … -->` for HTML and silently drops it. The rest of the markup is as the author wrote it.
 */
export function mdText(s: string): string {
  return s
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "\\<")))
    .join("");
}

/**
 * "1 test", "2 tests", "5 tests" — in language `lang`: the word form from the github skill's dictionary by the
 * language's rules.
 */
export const testsWord = (lang: string, n: number): string => locale.count(lang, locale.names(lang).spec.tests, n);

// Test files: *.test.ts / *.spec.ts / *.e2e.ts (and js/jsx/tsx/mjs/cjs…)
const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

export function isTestFile(p: string): boolean {
  return TEST_FILE.test(p);
}

/**
 * (kind, name) for a path relative to the root: capability / architecture rule / standard with the folder name,
 * lib — not a spec, out — outside the tree (including a file directly in tests/capabilities/ or tests/architecture/).
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

/** A test's decision folder — `tests/<kind>/<name>`; a test outside the decision tree — null. */
export function decisionFolder(file: string): string | null {
  const [kind] = classify(file);
  return kind === "capability" || kind === "architecture" || kind === "standard" ? file.split("/").slice(0, 3).join("/") : null;
}

/** Decision folder exceptions — the `exceptions/` directory, a file per harness registry element (`exceptionsIn`). */
export const EXCEPTIONS_DIR = "exceptions";

// the old format — an array in one file: the harness's exceptions.ts
const LEGACY_EXCEPTIONS = /^exceptions\.(ts|mts|js|mjs|json)$/;

/** Whose exceptions file it is and in what form. */
export interface ExceptionFile {
  /** The decision folder `tests/<kind>/<name>` these exceptions belong to. */
  folder: string;
  /** The folder's exceptions directory. */
  dir: typeof EXCEPTIONS_DIR;
  /**
   * The old format — an array in one file of the folder or a subfolder: spec-exceptions moves it into the folder's
   * `dir` directory.
   */
  legacy: boolean;
  /** Misplaced or of the wrong kind — what's wrong; such a file isn't read as an exception. */
  error?: string;
}

/**
 * Exceptions file of which decision folder? One rule for the harness, spec-doc, spec-diff and spec-exceptions; a copy
 * in the github skill (`pr labels`: a mechanical edit) is checked against it by the standard
 * `tests/standards/exception-files`.
 *
 * - `tests/<kind>/<name>/exceptions/<element>.json` — the folder's exception;
 * - another file in the directory (not `.json`, a nested directory) — an error: an exception is a JSON file;
 * - the directory in a subfolder of the decision folder — an error: there's one directory per folder, `exceptionsIn()`
 *   of a test in any subfolder reads it;
 * - `exceptions.{ts,mts,js,mjs,json}` in the folder or a subfolder — the folder's old exceptions format;
 * - outside decision folders, and hidden files — not exceptions (null).
 */
export function exceptionFile(p: string): ExceptionFile | null {
  const folder = decisionFolder(p);
  if (folder === null) return null;
  const inner = p.split("/").slice(3);
  if (inner.some((s) => s.startsWith("."))) return null;
  const at = inner.findIndex((s, i) => (i < inner.length - 1 ? s === EXCEPTIONS_DIR : LEGACY_EXCEPTIONS.test(s)));
  if (at < 0) return null;
  const dir = EXCEPTIONS_DIR;
  if (at === inner.length - 1) return { folder, dir, legacy: true };
  if (at > 0) return { folder, dir, legacy: false, error: `exceptions — only in ${folder}/${dir}/ of the decision folder, not in a subfolder` };
  if (inner.length > 2 || !p.endsWith(".json")) return { folder, dir, legacy: false, error: "an exception is an <element>.json file with { item, issue, reason }" };
  return { folder, dir, legacy: false };
}

// a word: letters, the capital — only the first or all (an abbreviation), parts — joined by an apostrophe or a hyphen
// ("user's", "e-mail"); letters of a caseless script (ideographs, kana) — a whole word, it has no spaces between words
const PART = String.raw`(?:\p{Lo}+|\p{Lu}+|\p{L}[\p{Ll}\p{M}]*)`;
const WORD = new RegExp(String.raw`^${PART}(?:['’-]${PART})*$`, "u");
// marks around a word in a sentence: quotes and brackets, at the end — also punctuation
const EDGES = /^["'«“‘([{]+|["'»”’)\]}.,;:!?…]+$/gu;

/**
 * A name is a statement in the project language; code in backticks doesn't count. `ru` — it has Cyrillic words. Another
 * language — a phrase: two words or more, or one word (of two letters or more, without a hyphen) as a whole. An
 * identifier (`parseScenarios`, `foo_bar`, `fooBar`, `foo-bar`), a function or file name, a path, a word with a number
 * (`returns 201`) isn't a statement: the spec reader won't learn from it what the system does. A rule without an exit
 * code: spec-doc warns, spec-diff counts the PR's new ones.
 */
export function isStatement(name: string, lang: string): boolean {
  const text = name.replace(/`[^`]*`/g, "");
  if (lang === "ru") return /\p{Script=Cyrillic}/u.test(text);
  const tokens = text.split(/\s+/).map((t) => t.replace(EDGES, "")).filter(Boolean);
  const words = tokens.filter((t) => WORD.test(t));
  if (words.length >= 2) return true;
  const [only] = words;
  return tokens.length === 1 && only !== undefined && [...only].length >= 2 && !/['’-]/.test(only);
}

/** Suite status: any failed → failed; otherwise any passed → passed; otherwise todo/skipped. */
export function combineStatus(a: Status, b: Status): Status {
  const order: Record<Status, number> = { failed: 3, passed: 2, todo: 1, skipped: 0 };
  return order[a] >= order[b] ? a : b;
}

/** Identical records from several reports — into one, in order of first appearance. */
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

// ---------- paths ----------

const DRIVE = /^[A-Za-z]:\//;

/**
 * A path from a report → relative to the root. An absolute path from another machine (CI) is mapped by the /tests/
 * segment; otherwise — as is, without the leading slash.
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

// ---------- reports ----------

type Report = { kind: "junit"; text: string } | { kind: "vitest" | "playwright"; data: Json };

/** A report's format — by the content, not the extension: XML — JUnit, JSON — Vitest/Jest or Playwright. */
function readReport(file: string): Report {
  const text = readFileSync(file, "utf8");
  if (text.trimStart().startsWith("<")) return { kind: "junit", text };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: neither JSON nor XML (${(e as Error).message})`);
  }
  if (data && typeof data === "object") {
    const d = data as Json;
    if ("testResults" in d) return { kind: "vitest", data: d };
    if ("suites" in d && "config" in d) return { kind: "playwright", data: d };
  }
  throw new Error(`${file}: unknown report format (expected Vitest/Jest JSON, Playwright JSON or JUnit XML from bun test)`);
}

export function loadReport(file: string, root: string): Test[] {
  const r = readReport(file);
  if (r.kind === "junit") return parseJunit(r.text, root);
  return r.kind === "vitest" ? parseVitest(r.data, root) : parsePlaywright(r.data, root);
}

/**
 * Test files' durations in a report, ms, by the file path as the report gives it (an absolute path from another
 * machine included): spec-shard lays out CI shards by them. Vitest/Jest — from the first test's start to the last one's
 * end (`endTime - startTime`), without them — the sum of the tests; Playwright — the sum of all results of the file's
 * tests: each project and retry takes a worker's time; JUnit from `bun test` — the `time` of the file's suite. A file
 * met twice in one report (two runner projects) — the sum.
 */
export function loadDurations(file: string): Map<string, number> {
  const r = readReport(file);
  const out = new Map<string, number>();
  const add = (p: string, ms: number): void => {
    p = p.replace(/\\/g, "/");
    if (p && Number.isFinite(ms) && ms >= 0) out.set(p, (out.get(p) ?? 0) + ms);
  };
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  if (r.kind === "junit") {
    // the file's suite is a testsuite at the top level (<testsuites> isn't one), describe — nested ones
    let depth = 0;
    for (const m of r.text.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)testsuite\b([^>]*?)(\/?)>/g)) {
      if (m[0][1] === "!") continue;
      if (m[1] === "/") {
        depth--;
        continue;
      }
      if (depth === 0) {
        const a = xmlAttrs(m[2] ?? "");
        add(a.file || a.name || "", Number(a.time) * 1000);
      }
      if (m[3] !== "/") depth++;
    }
  } else if (r.kind === "vitest") {
    for (const tr of arr(r.data.testResults)) {
      const [start, end] = [tr.startTime, tr.endTime];
      const ms = typeof start === "number" && typeof end === "number" && end >= start ? end - start : arr(tr.assertionResults).reduce((s, a) => s + num(a.duration), 0);
      add(str(tr.name), ms);
    }
  } else {
    const rootDir = str(((r.data.config ?? {}) as Json).rootDir).replace(/\\/g, "/");
    const total = (suite: Json): number =>
      arr(suite.specs).reduce((s, spec) => s + arr(spec.tests).reduce((t, test) => t + arr(test.results).reduce((u, res) => u + num(res.duration), 0), 0), 0) +
      arr(suite.suites).reduce((s, sub) => s + total(sub), 0);
    for (const fileSuite of arr(r.data.suites)) {
      const f = (str(fileSuite.file) || str(fileSuite.title)).replace(/\\/g, "/");
      add(rootDir ? posix.join(rootDir, f) : f, total(fileSuite));
    }
  }
  return out;
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

/** Vitest JSON (`--reporter=json`) — also the Jest format: testResults[].assertionResults[]. */
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
 * Playwright JSON (`--reporter=json`): suites[] per file, nested suites — describe, specs[].tests[] — one per project
 * (chromium, firefox…) — are folded into one row.
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
 * JUnit XML from `bun test --reporter=junit`: a file is a testsuite with name = file, describe — nested testsuites with
 * the file attribute, a test — a testcase (file, name). Parsing with regular expressions and a suite stack: there's no
 * XML parser without dependencies, and the format is simple. `<skipped/>` — skipped, `<skipped message="TODO"/>` —
 * todo, failure/error — failed. A hook (`beforeAll`, `afterAll`) of a skipped describe bun writes as a skipped testcase
 * `(unnamed)` without `line` — it isn't a test and is dropped; a failed hook stays: its failure is visible.
 */
export function parseJunit(text: string, root: string): Test[] {
  const tests: Test[] = [];
  const stack: Suite[] = [];
  const TOKEN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>/g;
  let caseAttrs: Record<string, string> | null = null;
  let caseStart = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (!m[2]) continue; // CDATA or a comment
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
      const body = text.slice(caseStart, m.index);
      if (!skippedHook(caseAttrs, body)) tests.push(junitCase(caseAttrs, body, stack, root));
      caseAttrs = null;
    }
  }
  return mergeTests(tests);
}

/** A skipped describe's hook: a test always has `line`, a hook — the name `(unnamed)` and no `line` (bun 1.4). */
function skippedHook(a: Record<string, string>, body: string): boolean {
  return a.name === "(unnamed)" && a.line === undefined && /<skipped\b/.test(body);
}

function junitCase(a: Record<string, string>, body: string, stack: Suite[], root: string): Test {
  // describe — nested suites with file whose name isn't the file (the file's own suite isn't a describe)
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

// ---------- source parsing ----------

/** A Babel AST node: the type, bounds in the source and the fields of its type. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  loc: { start: { line: number; column: number } };
  [field: string]: unknown;
}

/** A comment from parsing: block or line, bounds in the source. */
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
 * The parser is `@babel/parser` 7.29.9 as a file in the skill: `vendor/babel-parser.cjs` is the package's
 * `lib/index.js` (a single file without `require`) without the last line `//# sourceMappingURL` — there's no map next
 * to it, Vitest looks for it and prints an error; types — `vendor/babel-parser.d.cts`, the license next to it. The
 * skill's scripts have no dependencies, the `spec-diff` job in the project's CI installs no packages. To update —
 * `npm pack @babel/parser`: its `lib/index.js` and `LICENSE` go here, the version — into this comment. Our own lexer
 * guessed where a regex, a template, a comment and a type argument were, and silently lost tests (#267, #269, #271,
 * #275); TypeScript syntax is wider than any guess (#277).
 *
 * The import is static, at the top of the file: `createRequire(import.meta.url)` broke Playwright and Jest in a project
 * without `"type": "module"` — they load TS as CommonJS, where `import.meta` is a syntax error (#303,
 * tests/standards/harness-load).
 */

const OPTIONS = {
  sourceType: "module",
  // errors after which there's still an AST (strict mode, a parameter decorator) don't get in the way of parsing
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowUndeclaredExports: true,
  allowNewTargetOutsideFunction: true,
  allowSuperOutsideMethod: true,
};
// decorators — both in the position after export and on parameters (TS experimentalDecorators — an error with recovery)
const DECORATORS = ["decorators", "decoratorAutoAccessors"];

/**
 * Plugin sets by file extension, in order of attempts: `.ts` — without JSX (`<T>x` is a type cast), `.tsx` — with JSX,
 * JS — with JSX; an unknown file — TypeScript, then TSX.
 */
function pluginSets(file?: string): unknown[][] {
  const ts = ["typescript", ...DECORATORS];
  if (file && /\.d\.[cm]?ts$/.test(file)) return [[["typescript", { dts: true }], ...DECORATORS]];
  if (file && /\.[cm]?ts$/.test(file)) return [ts];
  if (file && /\.tsx$/.test(file)) return [[...ts, "jsx"]];
  if (file && /\.[cm]?jsx?$/.test(file)) return [["jsx", ...DECORATORS]];
  return [ts, [...ts, "jsx"]];
}

/** The AST of a TS/JS source; can't parse — an error with the location (`Unexpected token (3:7)`). */
function parseCode(source: string, file?: string): Parsed {
  let first: Error | undefined;
  for (const plugins of pluginSets(file)) {
    try {
      return babel.parse(source, { ...OPTIONS, plugins }) as Parsed;
    } catch (e) {
      first ??= e as Error;
    }
  }
  throw new Error(`can't parse: ${first!.message}`);
}

const isNode = (v: unknown): v is AstNode => !!v && typeof v === "object" && typeof (v as AstNode).type === "string" && typeof (v as AstNode).start === "number";

/** Child nodes in source order; comments attached to a node aren't nodes. */
function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.endsWith("Comments")) continue;
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** AST walk in source order: visit returned false — don't go into the node. */
function walkAst(node: AstNode, visit: (n: AstNode) => boolean | void): void {
  if (visit(node) === false) return;
  for (const c of children(node)) walkAst(c, visit);
}

/** The source's comments from parsing — [start, text]; a shebang is a comment too. */
export function commentsOf(source: string, file?: string): [number, string][] {
  const ast = parseCode(source, file);
  const out: [number, string][] = ast.comments.map((c) => [c.start, source.slice(c.start, c.end)]);
  const bang = ast.program.interpreter;
  if (bang) out.unshift([bang.start, source.slice(bang.start, bang.end)]);
  return out;
}

/** The source's strings known without running: literals and templates without substitutions. */
export function stringsOf(source: string, file?: string): string[] {
  const out: string[] = [];
  walkAst(parseCode(source, file).program, (n) => {
    const s = staticString(n);
    if (s !== null && n.type !== "BinaryExpression") out.push(s);
  });
  return out;
}

/** The callee's name: `f(…)` and `x.f(…)` — `f`; computed — null. */
function calleeName(call: AstNode): string | null {
  const callee = call.callee as AstNode;
  const id = callee.type === "MemberExpression" && !callee.computed ? (callee.property as AstNode) : callee;
  return id.type === "Identifier" ? (id.name as string) : null;
}

/**
 * Values of option `key` in object literals among the call's arguments (the key is a name or a string):
 * `invariant(it, { registry: … })`. An object from a variable or `...spec()` can't be computed without running.
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

/** Values of option `key` — strings known without running. */
function optionsOf(call: AstNode, key: string): string[] {
  return optionValues(call, key).flatMap((v) => staticString(v) ?? []);
}

/**
 * Harness calls and the check name from the call's options: for invariant — the registry (its `rule` is the folder's
 * convention, not a name), for examples — the linter rule, for deadCode — the run's `rule` (`production: true` without
 * it — "production"), architecture has no name — there's one model. null — no name, or it can't be computed without
 * running.
 */
const HARNESS_NAMES: Record<string, (call: AstNode) => string | null> = {
  invariant: (n) => optionsOf(n, "registry")[0] ?? null,
  examples: (n) => optionsOf(n, "rule")[0] ?? null,
  deadCode: (n) => optionsOf(n, "rule")[0] ?? (optionValues(n, "production").some((v) => v.type === "BooleanLiteral" && v.value === true) ? "production" : null),
  architecture: () => null,
};

/** Harness calls: a describe in which any of them is called is a standard's scenario (`spec-diff --scenarios`). */
export const HARNESS_CALLS: readonly string[] = Object.keys(HARNESS_NAMES);

/**
 * A harness check in the source: the call, the describe chain at its place and the registry or rule (null — can't be
 * computed without running).
 */
export interface HarnessCall {
  call: string;
  describes: string[];
  value: string | null;
}

/** A string known without running: a literal, a substitution-free template or their `+` concatenation; else null. */
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

// describe / it / test / suite / context (+ Jest's x/f variants, Playwright's test.describe), modifiers only from the
// list: test.step, test.use, test.beforeEach etc. aren't tests
const KIND = /^[xf]?(describe|it|test|suite|context)$/;
const DESCRIBE_KINDS = new Set(["describe", "suite", "context"]);
const MODS_OK = new Set([
  "skip", "only", "todo", "each", "for", "concurrent", "sequential", "fails",
  "runIf", "skipIf", "serial", "parallel", "fixme", "fail", "shuffle",
]);
// modifiers with two calls: `it.each(table)(name, …)`, `it.each\`table\`(name, …)`, `it.skipIf(condition)(name, …)`
const CURRIED = ["each", "for", "runIf", "skipIf"];

/** The test call's kind by the name chain (`test.describe.serial` → describe); not a test — null. */
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

/** A test or describe call — the kind and the arguments, name first; the `.each(…)` table and any other call — null. */
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
 * Prose from the source's JSDoc — what isn't visible from the names. Keys are the JSON of the name chain, as for a
 * test: describe — [describes…], it — [describes…, name].
 */
export interface Docs {
  file: string; // JSDoc at the start of the file, before code: what this capability or standard is
  describes: Map<string, string>; // JSDoc right before describe
  tests: Map<string, string>; // JSDoc right before it / test
}

/** A test or describe call whose name can't be computed without running (a template with substitution, a variable). */
export interface Unnamed {
  line: number;
  kind: string;
  /** The name expression from the source, shortened. */
  name: string;
  /** JSDoc right before the call — prose with nothing to attach to. */
  doc: string;
}

/**
 * JSDoc text without the comment brackets and leading `*`; lines are kept (markdown), empty ones at the edges and
 * repeated ones are removed. Block tags (@see, @param…) aren't prose: everything from the first tag on is dropped.
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
 * JSDoc by code position: the prose is the last JSDoc before the code, comments between them don't interfere.
 * Consecutive comments with only whitespace between them form one group; the key is the start of the code after the
 * group. The first JSDoc of a group before any code is a candidate for the file's prose. `//` and a block comment with
 * a single asterisk aren't prose.
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

/** Tests from a TS/JS source. */
export function parseJs(file: string, source: string): Test[] {
  return scanJs(file, source).tests;
}

/**
 * Tests and prose of a source by AST. The name is a string known without running (a literal, a template without
 * substitutions), the call's first argument (for .each / .for / .runIf / .skipIf — of the second call), with a type
 * argument `<…>` allowed anywhere; describe opens nesting for all of its arguments. A name that can't be computed goes
 * to `unnamed`, and the call isn't parsed further: the chain of its tests is unknown. JSDoc right before a call is its
 * prose; the file's first JSDoc followed by something other than a call (usually imports) is the file's prose. Harness
 * calls (`HARNESS_CALLS`) go to `checks` with the describe chain: their tests aren't named in the source. Can't parse —
 * an error.
 */
export function scanJs(file: string, source: string): { tests: Test[]; docs: Docs; unnamed: Unnamed[]; checks: HarnessCall[] } {
  const ast = parseCode(source, file);
  const doc = jsdocs(source, ast);
  const out: Test[] = [];
  const unnamed: Unnamed[] = [];
  const checks: HarnessCall[] = [];
  const docs: Docs = { file: "", describes: new Map(), tests: new Map() };
  const calls = new Set<number>(); // starts of test calls: JSDoc before them isn't the file's prose

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
      // Playwright's `test.fail()`, `test.skip(condition, "reason")` aren't tests: there's no callback
      if (!first || !rest.some(isFunction)) return true;
      const text = source.slice(first.start, first.end).replace(/\s+/g, " ");
      unnamed.push({ line: first.loc.start.line, kind: call.kind, name: text.length > 60 ? text.slice(0, 59) + "…" : text, doc: doc.at.get(n.start) ?? "" });
      return false;
    }
    const inner = [...chain, name];
    if (DESCRIBE_KINDS.has(call.kind)) {
      addDoc(docs.describes, inner, doc.at.get(n.start));
    } else {
      // the body is the rest of the call's arguments: a renamed test with the same check is recognized by it
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
