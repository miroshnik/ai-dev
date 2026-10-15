/**
 * harness — tests of mechanical checks for the spec tree (tests/capabilities, tests/architecture, tests/standards):
 * a check registers ordinary runner tests, so it shows up in the runner's report and in the spec-doc documentation.
 *
 * "Registry + invariant" — a behavior convention ("every mutation writes an audit record") is checked on every element
 * of a registry taken from the code, not on one example. "Examples" — a lint rule is checked on code where it must
 * fire, stay silent and not apply; the linter goes through an adapter (ESLint — `eslintLinter`).
 *
 * The runner doesn't matter: `it` passes the test (Vitest, Jest, bun test, node:test — all have `it(name, fn)`).
 * Import from the skill's copy in the project (`.agents/skills/spec/scripts/harness.ts`); the project's test loads it
 * under the project's runner — Bun, Node, Vitest, Playwright or Jest, as ESM or as CommonJS — so only erasable
 * TypeScript syntax and `node:` APIs, with no dependencies (tests/standards/harness-load).
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import locale from "../../github/scripts/locale.ts";
import type { Names } from "../../github/scripts/locale.ts";
import type { Model } from "./architecture.ts";
import knipHints from "./knip-hints.cjs";
import { commentsOf, decisionFolder, EXCEPTIONS_DIR, exceptionFile, stringsOf } from "./speclib.ts";

/**
 * Harness test names are in the project language (`language` in `.agents/elves.json` of the directory the runner runs
 * from): they stand in the project's spec next to its own. The language is read when tests are registered, not when the
 * module loads.
 */
const localeNames = (): Names => locale.names(locale.projectLanguage());

/** The runner's `it`: a name and a body; the body throws (expect) on a violation. */
export type It = (name: string, fn: () => void | Promise<unknown>) => unknown;

export interface Invariant<T> {
  /** Registry name — for the "not empty" test: "mutations", "test files that spawn processes". */
  registry: string;
  /**
   * Registry elements — from the code (router, schema, files), not a hand-written list: a new element won't slip past
   * the check. Computed before tests are registered — an async registry is awaited with a top-level `await` in the test
   * file.
   */
  items: readonly T[];
  /** Name of an element's test — a statement about it: "createInvoice writes an audit record". */
  name: (item: T) => string;
  /** Check of one element: throws if the element breaks the convention. */
  check: (item: T) => unknown;
  /**
   * A known violator: the check must fail on it — otherwise it checks nothing. A check made of several halves (client
   * and server) has a violator for each.
   */
  violator: { name: string; item: T } | readonly { name: string; item: T }[];
  /** Element key for exceptions, scope and `includes` — a stable identifier (name, path); defaults to the test name. */
  key?: (item: T) => string;
  /**
   * The element's file from the project root (route, script, migration): "outside scope" and the element's exception
   * are a mark in it (`marksIn`), not a record in the test. Element removed — the mark is gone too; two PRs don't edit
   * a shared file. `null` — no file of its own (a schema row, a router entry): `outside` and `exceptions/`. The root is
   * the directory with the `tests/` tree the decision folder is in, whatever the runner's cwd (a package directory in a
   * monorepo) — no correction for cwd; an absolute path is taken as is; a path with no file — a failing test.
   */
  fileOf?: (item: T) => string | null | undefined;
  /**
   * Convention identifier when a folder has several over one registry: exceptions only with this `rule`; service tests
   * name it: registry "forms" is not empty (audit).
   */
  rule?: string;
  /**
   * Exceptions — the decision folder's `exceptions/` directory (`exceptionsIn()`): the element, the task that lifts it,
   * and the reason.
   */
  exceptions?: readonly Exception[];
  /** Outside scope — elements the convention deliberately doesn't cover, with a reason: it is shown on the page. */
  outside?: readonly { item: string; reason: string }[];
  /** Keys that must be in the registry: "not empty" won't notice that the selection lost half of the elements. */
  includes?: readonly string[];
}

/** An exception from a convention: the element key, the number of the task that pays off the debt, and the reason. */
export interface Exception {
  item: string;
  issue: number;
  reason: string;
  /**
   * The convention (the invariant's `rule`) the exception belongs to; without it — all invariants of the folder. No
   * invariant of the folder has the rule — a failing test "exceptions with a rule belong to the folder's invariant
   * rules" with the file path.
   */
  rule?: string;
  /** Exception file — set by `exceptionsIn` or a mark: the ratchet names which file to delete or where the mark is. */
  file?: string;
  /** Line of the mark in the element's file — an exception by a mark, not by a file in `exceptions/`. */
  line?: number;
}

/** An element's "outside scope": key and reason; for a mark — its location. */
interface Outside {
  item: string;
  reason: string;
  file?: string;
  line?: number;
}

/**
 * A mark in the element's file — a comment, like `eslint-disable` for lint: `spec-outside(<decision>[/<rule>]): reason`
 * or `spec-exception(<decision>[/<rule>]) #N: reason`. The decision is the decision folder's name (`audit` —
 * `tests/standards/audit`): a file can be an element of registries of different folders, the mark names its own;
 * `rule` is the folder's invariant, without it — all of them.
 */
export interface Mark {
  kind: "outside" | "exception";
  decision: string;
  rule?: string;
  issue?: number;
  reason: string;
  file: string;
  line: number;
}

// a mark starts the comment text; the reason runs to the end of the line, without a block comment's closing
const MARK = /^spec-(outside|exception)\(([^()\s]*)\)\s*(?:#(\d+))?\s*:?\s*(.*?)\s*(?:\*\/|-->)?\s*$/;
// not a JS file: the mark right after the comment start — //, /*, * of a block, #, --, <!--, ;
const MARK_LINE = /(?:^|\s)(?:\/\/|\/\*+|\*|#|--|<!--|;)\s*(spec-(?:outside|exception)\(.*)$/;

function markOf(file: string, line: number, text: string): Mark | null {
  const m = MARK.exec(text);
  if (!m) return null;
  const [decision, ...rule] = m[2]!.split("/");
  return { kind: m[1] as Mark["kind"], decision: decision!, ...(rule.length ? { rule: rule.join("/") } : {}), ...(m[3] ? { issue: Number(m[3]) } : {}), reason: m[4]!, file, line };
}

// a JSON string or a structural token: number values, true and null carry no marks — skipped
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|[{}[\]:,]/g;

/**
 * JSON comments — values of the top-level `"//"` key (an npm convention: `package.json` has no comments), a string or a
 * list of strings: the offset in the text and the string.
 */
function jsonNotes(text: string): [number, string][] {
  const out: [number, string][] = [];
  const notes: boolean[] = []; // open containers: true — a list under the top-level "//" key
  let key = "";
  let prev = "";
  for (const m of text.matchAll(JSON_TOKEN)) {
    const t = m[0];
    const note = notes.length === 1 && prev === ":" && key === "//";
    if (t === "{" || t === "[") notes.push(note && t === "[");
    else if (t === "}" || t === "]") notes.pop();
    else if (t.startsWith('"')) {
      if (note || (notes.length === 2 && notes[1])) out.push([m.index, JSON.parse(t) as string]);
      else if (notes.length === 1 && (prev === "{" || prev === ",")) key = JSON.parse(t) as string;
    }
    prev = t;
  }
  return out;
}

/** Strict JSON: it has no comments. JSONC (`tsconfig.json`) isn't parsed — its marks are in comments. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks in a file: in JS/TS code — only in comments (strings, templates, regexes are skipped, a parser does it), in
 * JSON — the value of the top-level `"//"` key (a string or a list; JSONC with comments — like other files), in other
 * files (SQL, shell, HTML) — right after the comment start. A mark starts at the beginning of the comment text: a
 * mention of the format mid-prose is not a mark.
 */
export function marksIn(file: string, text: string): Mark[] {
  const out: Mark[] = [];
  if (/\.json$/i.test(file) && isJson(text)) {
    for (const [at, note] of jsonNotes(text)) {
      const mark = markOf(file, text.slice(0, at).split("\n").length, note);
      if (mark) out.push(mark);
    }
    return out;
  }
  if (!CODE.test(file)) {
    text.split("\n").forEach((l, i) => {
      const m = MARK_LINE.exec(l);
      const mark = m && markOf(file, i + 1, m[1]!);
      if (mark) out.push(mark);
    });
    return out;
  }
  for (const [at, comment] of commentsOf(text, file)) {
    if (!comment.includes("spec-")) continue;
    const first = text.slice(0, at).split("\n").length;
    comment.split("\n").forEach((l, i) => {
      const mark = markOf(file, first + i, l.replace(/^\s*(?:\/\/+|\/\*+|\*+)?\s*/, ""));
      if (mark) out.push(mark);
    });
  }
  return out;
}

const MIGRATE = "migrate with spec-exceptions: bun --no-env-file .agents/skills/spec/scripts/spec-exceptions.ts";

/**
 * Exceptions of a decision folder — the `exceptions/` directory, a file per exception (`<element>.json`:
 * `{ item, issue, reason, rule? }`): parallel PRs each add and remove their own file, while in a shared array
 * neighboring lines conflict. The directory is `<dir>/exceptions`, by default the calling test's folder (by the stack,
 * like `meta`); no directory — no exceptions. A file that isn't a JSON exception, or one element (with the same `rule`)
 * in two files — an error with the paths.
 */
export function exceptionsIn(dir?: string): Exception[] {
  // from the test file's location, not from cwd: a monorepo package's runner runs from its own directory
  const folder = dir ?? callerFolder()?.abs;
  if (folder === undefined) throw new Error("exceptionsIn: not called from a test file — pass the decision folder's directory");
  return exceptionFiles(path.join(folder, EXCEPTIONS_DIR));
}

/**
 * Exceptions from a directory of files (`<decision folder>/exceptions`): a file per exception, by file name. No
 * directory — no exceptions: git doesn't keep an empty directory, the last lifted exception takes it along. An
 * exception's `file` is from the repository root (`shownPath`): the "delete" hint is read from there, not from the
 * runner's cwd.
 */
export function exceptionFiles(at: string): Exception[] {
  let names: string[];
  try {
    names = readdirSync(at).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out: Exception[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const abs = path.resolve(at, name);
    const file = shownPath(abs);
    if (!name.endsWith(".json")) throw new Error(`${file}: an exception is an <element>.json file with { item, issue, reason }`);
    let data: Partial<Exception>;
    try {
      data = JSON.parse(readFileSync(abs, "utf8")) as Partial<Exception>;
    } catch (e) {
      throw new Error(`${file}: not JSON — ${(e as Error).message}`);
    }
    if (!data || typeof data !== "object" || typeof data.item !== "string") throw new Error(`${file}: an exception is { item, issue, reason }, rule is optional`);
    const key = `${data.rule ?? ""}\0${data.item}`;
    const twin = seen.get(key);
    if (twin) throw new Error(`exception ${data.item}${data.rule ? ` (${data.rule})` : ""} is in two files: ${twin}, ${file} — keep one`);
    seen.set(key, file);
    out.push({ item: data.item, issue: data.issue as number, reason: String(data.reason ?? ""), ...(data.rule ? { rule: data.rule } : {}), file });
  }
  return out;
}

/**
 * Repository root — the nearest directory up from cwd with `.git` (a directory or a worktree file); none — cwd. Paths
 * in hints are from it: a monorepo package's runner runs from the package directory, while the hint is read from the
 * root.
 */
function repoRoot(): string {
  const cwd = process.cwd();
  for (let d = cwd; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return cwd;
  }
}

/** A file path for a hint: from the repository root; outside the repository — absolute. */
function shownPath(abs: string): string {
  const rel = path.relative(repoRoot(), abs);
  return (rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel).split(path.sep).join("/");
}

/**
 * The calling test's decision folder: from the project root (`tests/<kind>/<name>`, outside `tests/` — the file's
 * directory), its absolute path and the project root (the directory with the `tests/` tree) that `rel` is counted from.
 */
function callerFolder(): { rel: string; abs: string; base: string } | null {
  const t = testFileAt(new Error().stack ?? "", process.cwd());
  if (!t) return null;
  const rel = folderOf(t.rel);
  const base = t.abs.slice(0, t.abs.length - t.rel.length);
  return { rel, abs: path.join(base, rel), base };
}

/** A test file's decision folder from the project root: `tests/<kind>/<name>`; outside `tests/` — its directory. */
function folderOf(file: string): string {
  const parts = file.split("/");
  return parts[0] === "tests" && parts.length > 3 ? parts.slice(0, 3).join("/") : path.posix.dirname(file);
}

/**
 * Files under a directory from the project root (`base`, cwd by default), in order; hidden ones and dependencies are
 * skipped.
 */
function filesUnder(rel: string, base = process.cwd()): string[] {
  let entries;
  try {
    entries = readdirSync(path.resolve(base, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => (e.isDirectory() ? filesUnder(`${rel}/${e.name}`, base) : [`${rel}/${e.name}`]))
    .sort();
}

/**
 * The calling test folder's exceptions in the wrong place or form (the `exceptionFile` rule): an old `exceptions.ts` of
 * the folder or a subfolder — a failing test with a migration hint; an `exceptions/` directory in a subfolder and
 * non-JSON in the directory — a failing test with the paths. One per folder per run; the check registers it itself — a
 * project that still imports `exceptions.ts` doesn't call `exceptionsIn`.
 */
function legacyExceptions(it: It): void {
  const caller = callerFolder();
  if (caller === null) return;
  const { rel: folder, base } = caller;
  if (decisionFolder(`${folder}/_`) !== folder || seen.has(`legacy\0${folder}`)) return;
  seen.add(`legacy\0${folder}`);
  const found = filesUnder(folder, base).flatMap((f) => {
    const x = exceptionFile(f);
    return x?.dir === EXCEPTIONS_DIR ? [{ f, x }] : [];
  });
  const at = (f: string) => shownPath(path.join(base, f));
  const legacy = found.filter(({ x }) => x.legacy).map(({ f, x }) => `${at(f)}: exceptions — a file per element in ${x.folder}/${EXCEPTIONS_DIR}/ — ${MIGRATE}`);
  const misplaced = found.filter(({ x }) => x.error).map(({ f, x }) => `${at(f)}: ${x.error}`);
  const N = localeNames();
  if (legacy.length) {
    it(N.spec.harness.exceptionFiles, () => {
      throw new Error(legacy.join("\n"));
    });
  }
  if (misplaced.length) {
    it(N.spec.harness.exceptionJson, () => {
      throw new Error(misplaced.join("\n"));
    });
  }
}

/**
 * Invariant rules of a test file per run, plus the exceptions and marks the invariant didn't take: their `rule` is
 * another rule's.
 */
interface RuleLedger {
  rules: Set<string>;
  skipped: Exception[];
  marks: Mark[];
}

// by `it` and test file: a test collector inside a harness test has its own `it`, its check doesn't mix with others'
const ledgers = new WeakMap<It, Map<string, RuleLedger>>();

/**
 * An exception or mark with a `rule` that no invariant of the folder has (a typo, the rule renamed or removed) is taken
 * by no invariant: the ratchet doesn't see it, and the debt silently drops out of the spec. When an invariant sets
 * aside an exception or mark with another `rule`, a check test is registered — one for exceptions and one for marks,
 * one per file; it runs after the file is collected and knows the rules of all its invariants.
 * Rules of other files of the folder (subfolders with a shared `exceptions/`) run in another process or later — their
 * check looks them up as strings in the code of those files.
 */
function unknownRules(it: It, rule: string | undefined, exceptions: readonly Exception[], marks: readonly Mark[]): void {
  const caller = testFileAt(new Error().stack ?? "", process.cwd());
  const file = caller?.rel ?? "";
  const byFile = ledgers.get(it) ?? new Map<string, RuleLedger>();
  ledgers.set(it, byFile);
  const ledger = byFile.get(file) ?? { rules: new Set<string>(), skipped: [], marks: [] };
  byFile.set(file, ledger);
  if (rule) ledger.rules.add(rule);
  const reconcile = <X extends { rule?: string }>(list: X[], add: readonly X[], name: string, id: (x: X) => string, line: (x: X, have: string) => string): void => {
    if (!add.length) return;
    const first = !list.length;
    list.push(...add);
    if (!first) return;
    it(name, () => {
      const lost = new Map<string, X>();
      let elsewhere: Set<string> | null = null;
      for (const x of list) {
        if (ledger.rules.has(x.rule!)) continue;
        elsewhere ??= caller ? stringsBeside(caller.rel, caller.abs.slice(0, caller.abs.length - caller.rel.length)) : new Set();
        if (!elsewhere.has(x.rule!)) lost.set(id(x), x);
      }
      if (!lost.size) return;
      const rules = [...ledger.rules].sort();
      const have = rules.length ? `the file's invariants have: ${rules.join(", ")}` : "the file's invariants have no rule";
      throw new Error([...lost.values()].map((x) => line(x, have)).join("\n"));
    });
  };
  const N = localeNames();
  reconcile(
    ledger.skipped,
    exceptions.filter((e) => e.rule && e.rule !== rule),
    N.spec.harness.exceptionRules,
    (e) => e.file ?? `${e.rule}\0${e.item}`,
    (e, have) => `${e.file ?? `exception ${e.item}`}: no invariant of the folder has rule «${e.rule}» (${have}) — fix the rule or ${e.file ? "delete the file" : "remove the exception"}`,
  );
  reconcile(ledger.marks, marks, N.spec.harness.markRules, (m) => `${m.file}:${m.line}`, (m, have) => `${m.file}:${m.line}: no invariant of the folder has rule «${m.rule}» (${have}) — fix the mark or remove it`);
}

/**
 * Strings in the code of other files of the test's decision folder (`base` — the project root): the rules of their
 * invariants that this run doesn't see.
 */
function stringsBeside(file: string, base: string): Set<string> {
  const out = new Set<string>();
  for (const f of filesUnder(folderOf(file), base)) {
    if (f === file || !CODE.test(f)) continue;
    for (const s of stringsOf(readFileSync(path.resolve(base, f), "utf8"), f)) out.add(s);
  }
  return out;
}

/**
 * What to do with an unneeded exception: remove the mark, delete the exception file, and an exception without a file —
 * remove it from the list.
 */
const dropHint = (e: Exception): string => (e.line ? `remove the mark in ${e.file}:${e.line}` : e.file ? `remove the exception: delete ${e.file}` : "remove the exception");

/**
 * The folder's marks in element files (`fileOf`): "outside scope" and exceptions by element key; marks with another
 * invariant's `rule` go to the rule check. A mark in a file of two elements is taken by neither — a failing test: which
 * one it belongs to is unknown. `fileOf` is read from the project root the decision folder is counted from, not from
 * the runner's cwd; a path with no file is a failing test, not a skip: the mark is there, the harness wouldn't see it.
 */
function elementMarks<T>(it: It, spec: Invariant<T>, key: (item: T) => string, tag: string): { outside: Outside[]; exceptions: Exception[]; skipped: Mark[] } {
  const out = { outside: [] as Outside[], exceptions: [] as Exception[], skipped: [] as Mark[] };
  const folder = spec.fileOf && callerFolder();
  if (!folder) return out;
  const decision = path.posix.basename(folder.rel);
  const byFile = new Map<string, string[]>();
  for (const item of spec.items) {
    const f = spec.fileOf!(item);
    if (f) byFile.set(f, [...(byFile.get(f) ?? []), key(item)]);
  }
  const shared: string[] = [];
  const missing: string[] = [];
  for (const [file, keys] of byFile) {
    let text: string;
    try {
      text = readFileSync(path.resolve(folder.base, file), "utf8");
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file: fileOf is a path from the project root (the directory with tests/), without a correction for the runner's cwd" : (e as Error).message;
      missing.push(`${keys.join(", ")}: fileOf ${file} — ${why}`);
      continue;
    }
    if (!text.includes("spec-")) continue;
    // an absolute path (built from a root) is shown from the repository root, like other hints
    const shown = path.isAbsolute(file) ? shownPath(file) : file;
    const mine = marksIn(shown, text).filter((m) => m.decision === decision);
    out.skipped.push(...mine.filter((m) => m.rule && m.rule !== spec.rule));
    const marks = mine.filter((m) => !m.rule || m.rule === spec.rule);
    if (!marks.length) continue;
    if (keys.length > 1) {
      shared.push(`${shown}:${marks[0]!.line}: the mark is read by elements ${keys.join(", ")} — which one it belongs to is unknown: an element without its own file goes to outside and exceptions/`);
      continue;
    }
    for (const m of marks) {
      if (m.kind === "outside") out.outside.push({ item: keys[0]!, reason: m.reason, file: shown, line: m.line });
      else out.exceptions.push({ item: keys[0]!, issue: m.issue ?? 0, reason: m.reason, ...(m.rule ? { rule: m.rule } : {}), file: shown, line: m.line });
    }
  }
  if (shared.length) {
    it(locale.fill(localeNames().spec.harness.markOneElement, { tag }), () => {
      throw new Error(shared.join("\n"));
    });
  }
  if (missing.length) {
    it(locale.fill(localeNames().spec.harness.elementFiles, { tag }), () => {
      throw new Error(missing.join("\n"));
    });
  }
  return out;
}

/**
 * Tests of a convention: "registry is not empty" (a typo in a path doesn't pass silently), "violator does not pass"
 * (the check can fail) and a test per element. No counters in the names: the registry grows — the spec diff shows only
 * the new elements.
 */
export function invariant<T>(it: It, spec: Invariant<T>): void {
  legacyExceptions(it);
  const N = localeNames();
  // several conventions over one registry in one describe: the rule tells the service tests apart
  const tag = spec.rule ? ` (${spec.rule})` : "";
  it(locale.fill(N.spec.harness.registryNotEmpty, { registry: spec.registry, tag }), () => {
    if (!spec.items.length) throw new Error(`registry «${spec.registry}» is empty — nothing to check: the registry's path or query is wrong`);
  });
  const key = spec.key ?? spec.name;
  const byKey = new Map(spec.items.map((item) => [key(item), item]));
  if (spec.includes?.length) {
    it(locale.fill(N.spec.harness.registryFinds, { registry: spec.registry, items: spec.includes.join(", "), tag }), () => {
      const missing = spec.includes!.filter((k) => !byKey.has(k));
      if (missing.length) throw new Error(`registry «${spec.registry}» lacks: ${missing.join(", ")} — the registry's query lost elements`);
    });
  }
  const violators = Array.isArray(spec.violator) ? spec.violator : [spec.violator as { name: string; item: T }];
  for (const v of violators) {
    it(locale.fill(N.spec.harness.violator, { tag, name: v.name }), async () => {
      try {
        await spec.check(v.item);
      } catch {
        return;
      }
      throw new Error(`the check passed on violator «${v.name}» — it checks nothing`);
    });
  }
  // a mark in the element's file is its record; the same record also in the test or exceptions/ — a failing test, and
  // the mark applies
  const marks = elementMarks(it, spec, key, tag);
  const marked = new Map<string, string>();
  const twice: string[] = [];
  for (const m of [...marks.outside, ...marks.exceptions]) {
    const at = `${m.file}:${m.line}`;
    if (marked.has(m.item)) twice.push(`${m.item}: marks ${marked.get(m.item)} and ${at} — keep one`);
    else marked.set(m.item, at);
  }
  // an exception without a rule applies to all conventions of the folder, with a rule — only to its own
  const listed = [...(spec.exceptions ?? []).filter((e) => !e.rule || e.rule === spec.rule), ...(spec.outside ?? [])] as (Exception | Outside)[];
  for (const x of listed.filter((x) => marked.has(x.item))) twice.push(`${x.item}: mark ${marked.get(x.item)} and ${x.file ?? "outside in the test"} — keep one`);
  if (twice.length) {
    it(locale.fill(N.spec.harness.oneRecord, { tag }), () => {
      throw new Error(twice.join("\n"));
    });
  }
  const unmarked = <X extends { item: string }>(xs: readonly X[] | undefined): X[] => (xs ?? []).filter((x) => !marked.has(x.item));
  const excepted = new Map([...unmarked(spec.exceptions).filter((e) => !e.rule || e.rule === spec.rule), ...marks.exceptions].map((e) => [e.item, e]));
  const outside = new Map<string, Outside>([...unmarked(spec.outside), ...marks.outside].map((o) => [o.item, o]));
  // by name, not in registry order: the order of files and queries depends on the machine, the spec doesn't
  const named = spec.items.filter((item) => !excepted.has(key(item)) && !outside.has(key(item))).map((item) => ({ name: spec.name(item), item }));
  named.sort(byName);
  for (const { name, item } of named) {
    it(name, async () => {
      await spec.check(item);
    });
  }
  // outside scope — deliberately, with the reason on the page; the element is gone — remove the scope record
  for (const o of [...outside.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))) {
    const name = locale.fill(N.spec.harness.outside, { tag, item: o.item });
    meta(name, { reason: o.reason });
    it(name, () => {
      if (!o.reason.trim()) throw new Error(`element ${o.item} outside scope has no reason${o.line ? ` — add the reason to the mark in ${o.file}:${o.line}` : ""}`);
      if (!byKey.has(o.item)) throw new Error(`element ${o.item} is not in registry «${spec.registry}» — remove from scope`);
    });
  }
  // ratchet: an exception lives while the element breaks the convention; once it complies — remove the exception
  const exceptions = [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  for (const e of exceptions) {
    const name = locale.fill(N.spec.harness.exception, { tag, item: e.item, issue: e.issue });
    meta(name, { issue: e.issue, reason: e.reason });
    it(name, async () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`exception ${e.item} has no task — ${e.line ? `add #N to the mark in ${e.file}:${e.line}` : "issue: the number of the task that pays off the debt"}`);
      if (!e.reason.trim()) throw new Error(`exception ${e.item} has no reason${e.line ? ` — add the reason to the mark in ${e.file}:${e.line}` : ""}`);
      if (!byKey.has(e.item)) throw new Error(`element ${e.item} is not in registry «${spec.registry}» — ${dropHint(e)}`);
      try {
        await spec.check(byKey.get(e.item)!);
      } catch {
        return;
      }
      throw new Error(`${e.item} already complies with the convention — ${dropHint(e)} (#${e.issue})`);
    });
  }
  unknownRules(it, spec.rule, spec.exceptions ?? [], marks.skipped);
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** A linter message about code: the rule (null — not a rule, e.g. a parse error) and the text. */
export interface LintMessage {
  ruleId: string | null;
  message: string;
  fatal?: boolean;
}

/** The project's linter: code and file path (from the project root — by it the config decides if the rule applies). */
export interface Linter {
  lint(code: string, filePath: string): Promise<LintMessage[]>;
  /**
   * Load the config ahead of time: `await linter.ready()` at the top level of the file — not under the first example's
   * timeout. Optional for an adapter without a slow load; `eslintLinter()` always has it.
   */
  ready?(): Promise<void>;
}

/** An example for a rule: name (a statement), path from the project root, and code. */
export interface Example {
  name: string;
  path: string;
  code: string;
  /** For "not allowed": how many times the rule must fire (at least once by default). */
  count?: number;
}

export interface Examples {
  linter: Linter;
  /** Rule identifier as the linter reports it: `no-console`, `boundaries/element-types`. */
  rule: string;
  /** On this code the rule must fire — otherwise it checks nothing. */
  bad: Example[];
  /** On this code the rule must stay silent. */
  good?: Example[];
  /** A file outside the rule's scope: the same violation is allowed there. */
  outside?: Example[];
}

/**
 * Tests of a rule: "not allowed: …" — the rule fired, "allowed: …" and "outside scope: …" — it didn't. Other rules'
 * hits count neither for nor against; an example that doesn't parse is a failing test. Without "not allowed" — a
 * failing test "rule … has a 'not allowed' example": there's nothing to prove the rule can fail.
 */
export function examples(it: It, spec: Examples): void {
  const fires = async (e: Example): Promise<LintMessage[]> => {
    const messages = await spec.linter.lint(e.code, e.path);
    const fatal = messages.find((m) => m.fatal);
    if (fatal) throw new Error(`the example doesn't parse: ${e.path} — ${fatal.message}`);
    return messages.filter((m) => m.ruleId === spec.rule);
  };
  // the linter config loads at registration, not under the first example's timeout; a load error shows up in an example
  spec.linter.ready?.().catch(() => {});
  const N = localeNames();
  if (!spec.bad.length) {
    it(locale.fill(N.spec.harness.badExample, { rule: spec.rule }), () => {
      throw new Error(`rule ${spec.rule} has no «not allowed» example — nothing proves it can fail`);
    });
  }
  for (const e of [...spec.bad.map((x) => [N.spec.harness.bad, x] as const), ...(spec.good ?? []).map((x) => [N.spec.harness.good, x] as const), ...(spec.outside ?? []).map((x) => [N.spec.harness.outsideExample, x] as const)]) {
    meta(`${e[0]}: ${e[1].name}`, { path: e[1].path, code: e[1].code });
  }
  for (const e of spec.bad) {
    it(`${N.spec.harness.bad}: ${e.name}`, async () => {
      const hits = (await fires(e)).length;
      if (e.count !== undefined && hits !== e.count) throw new Error(`rule ${spec.rule} fired ${hits} ${hits === 1 ? "time" : "times"}, expected ${e.count} — ${e.path}`);
      if (!hits) throw new Error(`rule ${spec.rule} didn't fire: ${e.path}`);
    });
  }
  const silent = (label: string) => (e: Example) =>
    it(`${label}: ${e.name}`, async () => {
      const hit = await fires(e);
      if (hit.length) throw new Error(`rule ${spec.rule} fired: ${e.path} — ${hit.map((m) => m.message).join("; ")}`);
    });
  (spec.good ?? []).forEach(silent(N.spec.harness.good));
  (spec.outside ?? []).forEach(silent(N.spec.harness.outsideExample));
}

/**
 * Linter — the project's ESLint with its config (`eslint.config.*` in `cwd`): an example is checked the same way `lint`
 * will check a file at that path. ESLint is taken from the project's dependencies (`module` — another path to the
 * package); it loads on the first example, so test registration is synchronous.
 */
export function eslintLinter(opts: { cwd?: string; module?: string } = {}): Required<Linter> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  type Engine = {
    lintText(code: string, o: { filePath: string }): Promise<{ messages: LintMessage[] }[]>;
    calculateConfigForFile(filePath: string): Promise<unknown>;
  };
  let engine: Promise<Engine> | null = null;
  const load = async (): Promise<Engine> => {
    const entry = opts.module ?? createRequire(path.join(cwd, "package.json")).resolve("eslint");
    const { ESLint } = (await import(pathToFileURL(entry).href)) as { ESLint: new (o: { cwd: string }) => Engine };
    return new ESLint({ cwd });
  };
  let warmed: Promise<void> | null = null;
  return {
    async lint(code, filePath) {
      engine ??= load();
      const [result] = await (await engine).lintText(code, { filePath: path.join(cwd, filePath) });
      return (result?.messages ?? []).map((m) => ({ ruleId: m.ruleId, message: m.message, fatal: m.fatal }));
    },
    // ESLint loads the config lazily, on the first file: computing the config for a project file loads it now
    ready() {
      engine ??= load();
      warmed ??= engine.then((e) => e.calculateConfigForFile(path.join(cwd, "index.js"))).then(() => undefined);
      return warmed;
    },
  };
}

/** A lint rule disable in code: file, line, rules (empty — all) and the description after " -- ". */
export interface Disable {
  file: string;
  line: number;
  rules: string[];
  description: string;
}

const CODE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const DIRECTIVE = /^(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?=\s|\*\/|$)([^\n]*?)(?:\*\/|$)/m;

/** A code file for a registry over sources: path from the root and text. */
export interface SourceFile {
  file: string;
  readonly text: string;
}

/** A violator of a registry over sources — as text, with no file on disk. */
export function source(file: string, text: string): SourceFile {
  return { file, text };
}

/**
 * Registry of code files in directories and files (from the root; a file — a config at the package root,
 * `vite.config.ts`): the list is cheap, the text is read on first access — parsing all of `src/` happens in the element
 * check, not when tests are collected.
 */
export function sources(root: string, dirs: string[] = ["src"]): SourceFile[] {
  return codeFiles(root, dirs).map((file) => {
    let text: string | undefined;
    return {
      file,
      get text() {
        return (text ??= readFileSync(path.join(root, file), "utf8"));
      },
    };
  });
}

/**
 * Code files in directories (from the root), in order, without repeats; an element of `dirs` is a directory or a code
 * file (a config at the package root); a missing one is skipped.
 */
export function codeFiles(root: string, dirs: string[]): string[] {
  const out = new Set<string>();
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      // not a directory — a code file on its own
      if ((e as { code?: string }).code === "ENOTDIR" && CODE.test(rel)) out.add(rel);
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
      } else if (CODE.test(e.name)) out.add(child);
    }
  };
  for (const d of dirs) walk(d.replace(/\/+$/, ""));
  return [...out].sort();
}

/**
 * Text without comments (replaced with spaces, line breaks kept): code scanners don't see prose and old code. Comments
 * come from parsing, as in the name scanner: `//` in a string or JSX text is not a comment. `file` is the path for
 * parsing by extension (`.tsx` — with JSX; none — TypeScript, then TSX); a source that can't be parsed is an error.
 */
export function codeOnly(text: string, file?: string): string {
  let out = "";
  let at = 0;
  for (const [i, c] of commentsOf(text, file)) {
    out += text.slice(at, i) + c.replace(/[^\n]/g, " ");
    at = i + c.length;
  }
  return out + text.slice(at);
}

/**
 * Lint rule disables in a file: `// eslint-disable-next-line a, b -- #12 reason` and the same block comments. ESLint
 * reads directives only in comments: `// eslint-disable` in a string is a fixture or a message, not a disable.
 */
export function disablesIn(file: string, text: string): Disable[] {
  const out: Disable[] = [];
  for (const [at, comment] of commentsOf(text, file)) {
    const m = DIRECTIVE.exec(comment);
    if (!m) continue;
    const [head, ...desc] = m[1]!.split(/\s--\s|\s--$/);
    out.push({
      file,
      line: text.slice(0, at).split("\n").length,
      rules: head!.split(",").map((r) => r.trim()).filter(Boolean),
      description: desc.join(" -- ").trim(),
    });
  }
  return out;
}

/**
 * Lint rule exceptions — disables in code: a test per file with disables ("exceptions in <file>: <rules>"), each
 * disable names its rule and has "-- #N reason". A blanket `eslint-disable` without rules is forbidden: it silences
 * both the rules and this check inside the linter — hence it's a test, not an ESLint rule. No code files — a failing
 * test: the path is wrong. The ratchet (a disable no longer silences anything) is in the `collectEslint` config.
 */
export function lintExceptions(it: It, opts: { root: string; dirs?: string[] }): void {
  const dirs = opts.dirs ?? ["src"];
  const files = codeFiles(opts.root, dirs);
  const N = localeNames();
  it(locale.fill(N.spec.harness.codeFiles, { dirs: dirs.join(", ") }), () => {
    if (!files.length) throw new Error(`no code files in ${dirs.join(", ")} — the path is wrong`);
  });
  for (const file of files) {
    const text = readFileSync(path.join(opts.root, file), "utf8");
    if (!text.includes("eslint-disable")) continue;
    const disables = disablesIn(file, text);
    if (!disables.length) continue;
    const rules = [...new Set(disables.flatMap((d) => (d.rules.length ? d.rules : [N.spec.lint.allRules])))].sort();
    // the disables' tasks go into the name: the spec shows which decision allows the exception
    const issues = [...new Set(disables.map((d) => /^#(\d+)/.exec(d.description)?.[1]).filter((x): x is string => !!x).map(Number))].sort((a, b) => a - b);
    const name = locale.fill(N.spec.harness.lintExceptions, { file, rules: rules.join(", "), issues: issues.length ? ` (${issues.map((n) => `#${n}`).join(", ")})` : "" });
    meta(name, { disables: disables.map((d) => ({ line: d.line, rules: d.rules, description: d.description })) });
    it(name, () => {
      const bad = disables.flatMap((d) => {
        if (!d.rules.length) return [`${d.file}:${d.line} — a disable without a rule name: a blanket eslint-disable silences everything, checks included`];
        if (!/^#\d+\s+\S/.test(d.description)) return [`${d.file}:${d.line} — a disable without «-- #N reason»: ${d.rules.join(", ")}`];
        return [];
      });
      if (bad.length) throw new Error(bad.join("\n"));
    });
  }
}

// a test file in the call stack: *.test.* / *.spec.* / *.e2e.* (V8 and JavaScriptCore; file:// — for ESM)
// for a module's top-level frame Bun writes only the line, no column: "at /…/x.test.ts:4"
// V8 writes an anonymous async function after await as the frame "at async <path>" — no name, no parentheses
const STACK_FILE = /(?:\(|\bat\s+(?:async\s+)?)(?:file:\/\/)?(\/[^()\n]*?\.(?:test|spec|e2e)\.[cm]?[jt]sx?)(?=:\d+)/g;
const seen = new Set<string>();
const journaled = new Set<string>();
let journalFile: string | null = null;

/** The test file the call comes from, relative to the project root — by the stack; not from a test — null. */
function callerTest(root: string): string | null {
  return testFileIn(new Error().stack ?? "", root);
}

/**
 * The test file in the call stack, from the project root: the first frame `*.test.*` / `*.spec.*` / `*.e2e.*` (V8 and
 * JavaScriptCore, `file://` for ESM, `at async` after await); not from a test — null.
 */
export function testFileIn(stack: string, root: string): string | null {
  return testFileAt(stack, root)?.rel ?? null;
}

/** The same plus the file's absolute path: `rel` — from the project root, `abs` ends with `rel`. */
function testFileAt(stack: string, root: string): { rel: string; abs: string } | null {
  for (const m of stack.matchAll(STACK_FILE)) {
    const abs = m[1]!;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!rel.startsWith("..")) return { rel, abs };
    const i = abs.indexOf("/tests/");
    if (i >= 0) return { rel: abs.slice(i + 1), abs };
  }
  return null;
}

let metaFile: string | null = null;

/**
 * Run metadata for `spec-doc`: what the test name lacks — the example's code, the task and the exception's reason. A
 * JSON line `{ file, test, … }` in `.spec-meta/<process>.jsonl` (`SPEC_META` — another directory); the test file comes
 * from the registration stack. The standard's page shows them under the test's line.
 */
function meta(test: string, data: object, file: string | null = callerTest(process.cwd())): void {
  const root = process.cwd();
  if (!file) return;
  const key = `meta\0${file}\0${test}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!metaFile) {
    const dir = path.resolve(root, process.env.SPEC_META ?? ".spec-meta");
    mkdirSync(dir, { recursive: true });
    metaFile = path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  }
  appendFileSync(metaFile, JSON.stringify({ file, test, ...data }) + "\n");
}

/**
 * Entry-point call log: the test environment records a call of an entry point (route, job, command) — with a router or
 * handler wrapper in the test build. The test file is found by the stack; where there's no test stack (e2e: the
 * request arrives at the server) — pass it explicitly (`test.info().file` in Playwright). A record is a JSON line in
 * `.spec-journal/<process>.jsonl` (`SPEC_JOURNAL` — another directory, each runner has its own: `.spec-journal/unit`);
 * `spec-claims` checks it against the registry after all tests and shards have run.
 */
export function journal(id: string, opts: { test?: string; root?: string } = {}): void {
  const root = opts.root ?? process.cwd();
  const test = opts.test ? path.relative(root, path.resolve(root, opts.test)).split(path.sep).join("/") : callerTest(root);
  const key = `${id}\0${test}`;
  if (journaled.has(key)) return;
  journaled.add(key);
  if (!journalFile) {
    const dir = journalDir(root);
    mkdirSync(dir, { recursive: true });
    journalFile = path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  }
  appendFileSync(journalFile, JSON.stringify({ id, test }) + "\n");
}

const journalDir = (root: string): string => path.resolve(root, process.env.SPEC_JOURNAL ?? ".spec-journal");

/**
 * Run start — logs of previous runs go away: otherwise a deleted test keeps "calling" an entry point. Called once per
 * runner run, before the tests (Vitest and Playwright globalSetup, bun test preload); erases `*.jsonl` in its own
 * directory (`SPEC_JOURNAL`), leaves subdirectories — other runners' logs — alone.
 */
export function resetJournal(opts: { root?: string } = {}): void {
  const dir = journalDir(opts.root ?? process.cwd());
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) rmSync(path.join(dir, f), { force: true });
  }
  journalFile = null;
  journaled.clear();
}

/** A call at a model boundary: who, to whom, what. */
export interface Call {
  from: string;
  to: string;
  message: string;
}

// the running scenario's trace: a file's tests run in turn, one scenario at a time (test.concurrent isn't for sequence)
let activeTrace: Call[] | null = null;

/**
 * A call at a model boundary — written by a wrapper in the test build, next to `journal`: an entry point, an external
 * system adapter, a storage client, a call to another container. Participants are model element names. Outside a
 * scenario (`sequence`) — nothing; a call within a participant (`from === to`) is not a boundary: a rearrangement
 * inside a module doesn't change the diagram.
 */
export function trace(from: string, to: string, message: string): void {
  if (activeTrace && from !== to) activeTrace.push({ from, to, message });
}

const callLine = (c: Call): string => `${c.from} → ${c.to}: ${c.message}`;

/** Diagram participants, when a model is given: modules, external systems, containers. */
const modelParticipants = (m: Model): Set<string> => new Set([...Object.keys(m.modules), ...Object.keys(m.externals ?? {}), ...Object.keys(m.containers ?? {})]);

/**
 * A capability scenario — a test whose trace of calls at model boundaries becomes a sequence diagram on the capability
 * page (`spec-doc`: under the test, or by the mark `<!-- spec: sequence-<id> -->` in `<folder>.md`). `order` — a
 * declared order (`"app → db: reserve"`) when the order itself is a decision: the trace must contain its steps in this
 * sequence (anything in between), otherwise the test is red. `model` — participants only from the model. Without
 * `order` the diagram is documentation.
 */
export function sequence(
  it: It,
  name: string,
  fn: () => void | Promise<unknown>,
  opts: { id?: string; order?: string[]; model?: Model } = {},
): void {
  // the test file — by the registration stack: when the test runs, it's no longer in the stack
  const file = callerTest(process.cwd());
  it(name, async () => {
    const calls: Call[] = [];
    activeTrace = calls;
    try {
      await fn();
    } finally {
      activeTrace = null;
    }
    meta(name, { ...(opts.id ? { id: opts.id } : {}), sequence: calls }, file);
    if (opts.model) {
      const known = modelParticipants(opts.model);
      const unknown = [...new Set(calls.flatMap((c) => [c.from, c.to]).filter((x) => !known.has(x)))];
      if (unknown.length) throw new Error(unknown.map((x) => `participant ${x} is not a model element`).join("\n"));
    }
    if (opts.order?.length) {
      const lines = calls.map(callLine);
      let j = 0;
      for (const l of lines) if (l === opts.order[j]) j++;
      if (j < opts.order.length) {
        const after = j ? `after «${opts.order[j - 1]}»` : "from the start of the scenario";
        throw new Error(`the order of scenario «${name}» is broken: no «${opts.order[j]}» ${after}\ntrace:\n${lines.join("\n") || "— empty"}`);
      }
    }
  });
}

// knip finding kinds (knip.dev, "Reporters", JSON) → test name in the project language and the exception key prefix
const KNIP: [(n: Names) => string, string, string[]][] = [
  [(n) => n.spec.harness.knip.files, "file", ["files"]],
  [(n) => n.spec.harness.knip.exports, "export", ["exports", "nsExports"]],
  [(n) => n.spec.harness.knip.types, "type", ["types", "nsTypes"]],
  [(n) => n.spec.harness.knip.dependencies, "dependency", ["dependencies", "devDependencies", "optionalPeerDependencies"]],
  [(n) => n.spec.harness.knip.unlisted, "unlisted", ["unlisted"]],
  [(n) => n.spec.harness.knip.unresolved, "unresolved", ["unresolved"]],
  // knip 6 kinds (JSONReportEntry): enum and namespace members, duplicate exports, binaries, pnpm catalog
  [(n) => n.spec.harness.knip.enumMembers, "enumMember", ["enumMembers"]],
  [(n) => n.spec.harness.knip.nsMembers, "nsMember", ["namespaceMembers"]],
  [(n) => n.spec.harness.knip.duplicates, "duplicate", ["duplicates"]],
  [(n) => n.spec.harness.knip.binaries, "binary", ["binaries"]],
  [(n) => n.spec.harness.knip.catalog, "catalog", ["catalog"]],
  [(n) => n.spec.harness.knip.catalogReferences, "catalogReference", ["catalogReferences"]],
];
// report row keys that aren't finding kinds: the file and the owners (CODEOWNERS)
const KNIP_ROW = new Set(["file", "owners", ...KNIP.flatMap(([, , keys]) => keys)]);
// kinds whose key used to have no file (`dependency:lodash`) and covered the package in all workspaces
const KEYED_BY_NAME = new Set(["dependency", "unlisted", "binary", "catalog"]);
// the configuration hints reporter: knip's JSON doesn't have them; the path comes from the file itself, import.meta
// can't be used here (harness-load)
const HINTS_REPORTER = knipHints.file;

type KnipItem = { name: string; namespace?: string };
type KnipHint = { type: string; identifier: string; workspace?: string };
type KnipReport = { issues?: Record<string, unknown>[]; configurationHints?: KnipHint[] };

/**
 * A knip finding for display and the exception key: a file — its path, the rest — `<file>#<name>`. The file comes from
 * knip's report: for a dependency — the workspace's `package.json`, for an unlisted package — the file with the
 * import, for a catalog — the catalog file; a name in a namespace (an enum member, a catalog entry) —
 * `<namespace>.<name>`.
 */
function knipShown(kind: string, file: string, item: KnipItem | KnipItem[]): string {
  if (Array.isArray(item)) return `${file}#${item.map((x) => x.name).join(" = ")}`; // duplicates: one export's names
  if (kind === "file") return item.name;
  return `${file}#${item.namespace ? item.namespace + "." : ""}${item.name}`;
}

/** A configuration hint for display and the exception key (`hint:<…>`): workspace, hint type and what it names. */
const hintShown = (h: KnipHint): string => `${h.workspace ?? "."}#${h.type}:${h.identifier}`;

/** Parsed knip output: findings by kind (key → display), lines of unknown kinds, hints (null — not in the output). */
interface KnipFindings {
  kinds: Map<string, Map<string, string>>;
  unknown: string[];
  hints: Map<string, string> | null;
}

/**
 * Findings by kind: kind key (`file:…`, `export:<file>#<name>`, `dependency:<package.json>#<package>`) → what to
 * display.
 */
function knipFindings(report: KnipReport): KnipFindings {
  const kinds = new Map(KNIP.map(([, kind]) => [kind, new Map<string, string>()]));
  const unknown = new Set<string>();
  for (const issue of report.issues ?? []) {
    const file = String(issue.file ?? "");
    for (const [, kind, keys] of KNIP) {
      for (const k of keys) {
        for (const item of (issue[k] as (KnipItem | KnipItem[])[] | undefined) ?? []) {
          const shown = knipShown(kind, file, item);
          kinds.get(kind)!.set(`${kind}:${shown}`, shown);
        }
      }
    }
    // a kind the harness doesn't know (new in knip, cycles with --cycles) is not silence: the `catalog:` reference
    // was such a kind
    for (const [k, v] of Object.entries(issue)) if (!KNIP_ROW.has(k) && Array.isArray(v) && v.length) unknown.add(`${k} (${file})`);
  }
  const hints = Array.isArray(report.configurationHints) ? new Map(report.configurationHints.map((h) => [`hint:${hintShown(h)}`, hintShown(h)])) : null;
  return { kinds, unknown: [...unknown].sort(), hints };
}

/**
 * knip output — a `json` report line and a `knip-hints.cjs` hints line; a report from a file — also a single JSON. Not
 * JSON — an error.
 */
function knipOutput(text: string): KnipReport {
  try {
    return JSON.parse(text) as KnipReport;
  } catch {
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) throw new Error("empty output");
    return Object.assign({}, ...lines.map((l) => JSON.parse(l) as KnipReport)) as KnipReport;
  }
}

export interface DeadCode {
  /** Project root for knip — the directory with its config and `node_modules/.bin/knip`; finding keys are from it. */
  root: string;
  /** Ready output of `knip --reporter json --reporter <skill>/knip-hints.cjs` (from `root`) instead of running knip. */
  report?: string;
  /** The project's knip arguments: `--tsConfig`, `--workspace`, … */
  args?: readonly string[];
  /** Exceptions — `exceptionsIn()`: finding key, task, reason; with `rule` — only for the run with this `rule`. */
  exceptions?: readonly Exception[];
  /** Production mode (`knip --production`): code reached only by tests is a finding. The run's rule is `production`. */
  production?: boolean;
  /** Run name when a folder has several (modes, workspaces): a tag in test names and exceptions with this `rule`. */
  rule?: string;
  /** knip configuration hints are findings (yes by default); `false` — not checked. */
  hints?: boolean;
}

/**
 * Code without a consumer — from knip's report: a test per finding kind (files, exports, types, dependencies, unlisted
 * packages, unresolved imports, pnpm catalog…) — failing with the list of findings; "all knip findings are of known
 * kinds" — a new knip kind doesn't pass silently; "no knip configuration hints" — a redundant ignore and an entry
 * without matches. The report — a file (`report`) or a run of the project's knip (`node_modules/.bin/knip`) — at test
 * registration, not under the first test's timeout. An exception is a finding key (`file:src/legacy.ts`,
 * `export:src/math.ts#factorial`, `dependency:packages/a/package.json#lodash`, `hint:.#ignore:src/gen/**`) with a task:
 * green while knip finds it, otherwise "remove". An exception with `rule` — only for its own run; without `rule` — it
 * silences the finding in all runs of the folder, and the ratchet is at the run without `rule`: in production knip
 * doesn't look at devDependencies and tests, and "remove" there would be false.
 */
export function deadCode(it: It, opts: DeadCode): void {
  const rule = opts.rule ?? (opts.production ? "production" : undefined);
  const tag = rule ? ` (${rule})` : "";
  const hints = opts.hints ?? true;
  // knip at registration: on a monorepo it takes longer than the test timeout (5 s in Vitest); a failure goes into
  // the tests, not into collecting the file
  let findings: KnipFindings | Error;
  try {
    findings = runKnip(opts, hints);
  } catch (e) {
    findings = e as Error;
  }
  const load = (): KnipFindings => {
    if (findings instanceof Error) throw findings;
    return findings;
  };
  legacyExceptions(it);
  const all = opts.exceptions ?? [];
  const own = all.filter((e) => e.rule === rule || (!e.rule && !rule));
  const silenced = new Set([...own, ...all.filter((e) => !e.rule)].map((e) => e.item));
  const open = (found: Map<string, string>) => [...found].filter(([key]) => !silenced.has(key)).map(([, shown]) => shown).sort();
  const N = localeNames();
  for (const [name, kind] of KNIP) {
    it(name(N) + tag, () => {
      const found = open(load().kinds.get(kind)!);
      if (found.length) throw new Error(found.join("\n"));
    });
  }
  it(locale.fill(N.spec.harness.knip.known, { tag }), () => {
    const { unknown } = load();
    if (unknown.length) throw new Error(`knip found what the harness doesn't parse: ${unknown.join(", ")} — exclude the kind from the knip run (--exclude) or update the spec skill`);
  });
  if (hints) {
    it(locale.fill(N.spec.harness.knip.hints, { tag }), () => {
      const found = load().hints;
      const reporter = path.relative(opts.root, HINTS_REPORTER).split(path.sep).join("/");
      if (!found && opts.report) throw new Error(`report ${opts.report} has no configuration hints — generate it: knip --reporter json --reporter ${reporter} > ${opts.report} (or hints: false)`);
      if (!found) throw new Error(`knip printed no configuration hints — reporter ${reporter} didn't run`);
      const left = open(found);
      if (left.length) throw new Error(left.join("\n"));
    });
  }
  for (const e of [...own].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    const name = locale.fill(N.spec.harness.exception, { tag, item: e.item, issue: e.issue });
    meta(name, { issue: e.issue, reason: e.reason });
    it(name, () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`exception ${e.item} has no task`);
      if (!e.reason.trim()) throw new Error(`exception ${e.item} has no reason`);
      const kind = e.item.split(":")[0]!;
      const found = kind === "hint" ? load().hints : load().kinds.get(kind);
      if (found?.has(e.item)) return;
      const name = e.item.slice(kind.length + 1);
      // a key without a file is from the old format: name the same package's findings to replace it with
      const renames =
        KEYED_BY_NAME.has(kind) && !name.includes("#")
          ? [...(found?.keys() ?? [])].filter((k) => {
              const tail = k.slice(k.lastIndexOf("#") + 1);
              return tail === name || (kind === "catalog" && tail.endsWith("." + name));
            })
          : [];
      if (renames.length) throw new Error(`key ${e.item} has no file: the exception would hide ${name} in every workspace — rename it to ${renames.join(", ")} (#${e.issue})`);
      throw new Error(`knip no longer finds ${e.item} — ${dropHint(e)} (#${e.issue})`);
    });
  }
  unknownRules(it, rule, all, []);
}

/**
 * knip's report: the `report` file or a run of the project's knip with the hints reporter; a knip failure is an error,
 * not "clean".
 */
function runKnip(opts: DeadCode, hints: boolean): KnipFindings {
  let text: string;
  if (opts.report) text = readFileSync(path.resolve(opts.root, opts.report), "utf8");
  else {
    const args = ["--reporter", "json", ...(hints ? ["--reporter", HINTS_REPORTER] : []), ...(opts.production ? ["--production"] : []), ...(opts.args ?? [])];
    // a monorepo report is megabytes: the default output buffer (1 MB in Node) would cut it off
    const r = spawnSync(path.join(opts.root, "node_modules", ".bin", "knip"), args, { cwd: opts.root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw new Error(`knip didn't start: ${r.error.message} — install knip in the project or pass report`);
    // 0 — clean, 1 — there are findings; anything else is a knip failure, not "no dead code"
    if (r.status !== 0 && r.status !== 1) throw new Error(`knip exited with code ${r.status ?? r.signal}: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
    text = r.stdout;
  }
  let report: KnipReport;
  try {
    report = knipOutput(text);
  } catch {
    throw new Error(`knip printed non-JSON — the report can't be parsed: ${text.trim().slice(0, 300)}`);
  }
  return knipFindings(report);
}

// variable name and field access: .X, ?.X, ["X"], ?.["X"], [`X`]
const ENV_NAME = "[A-Z_][A-Z0-9_]*";
const FIELD = `(?:\\?\\.|\\.)(${ENV_NAME})|(?:\\?\\.)?\\[\\s*["'\`](${ENV_NAME})["'\`]\\s*\\]`;
const ENV_OBJECT = "\\bprocess\\??\\.env\\b|\\bimport\\.meta\\??\\.env\\b";
// the whole environment source: process.env, import.meta.env, Vite's loadEnv result (argument parentheses — one level)
const ENV_SOURCE = `(?:${ENV_OBJECT}|\\bloadEnv\\s*\\((?:[^()]|\\([^()]*\\))*\\))(?!\\s*(?:\\?\\.|[.[]))`;
// type annotation before "=": a comma only inside <…>, else in `(a: A, env = process.env)` a would become the alias
const TYPE = "(?:\\s*:\\s*(?:[^=;,(){}<>]|<[^<>]*>)+?)?";
const ENV_READ = new RegExp(`(?:${ENV_OBJECT})(?:${FIELD})`, "g");
const ENV_ALIAS = new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)${TYPE}\\s*=\\s*${ENV_SOURCE}`, "g");
const ENV_DESTRUCTURE = new RegExp(`\\{([^{}]*)\\}${TYPE}\\s*=\\s*${ENV_SOURCE}`, "g");
const IS_ENV_NAME = new RegExp(`^${ENV_NAME}$`);

/**
 * Service environment variables — outside the `envVars` check; a project with its own registries on `invariant` skips
 * the same ones.
 */
export const ENV_SERVICE: readonly string[] = ["NODE_ENV", "CI", "TZ", "PORT", "HOME", "PATH", "PWD", "DEV", "PROD", "MODE", "SSR", "BASE_URL"];

/**
 * The project's own way of reading the environment beyond the built-in ones: a regexp — the name in the `name` group or
 * the first one (the `g` flag isn't needed), a function — names from comment-free code and the file path from the root.
 */
export type EnvReader = RegExp | ((code: string, file: string) => Iterable<string>);

/**
 * Config accessor: `.get('X')`, `.getOrThrow<string>('X')` on an object of any name (NestJS `ConfigService`, a custom
 * config). Not built in: `.get('X')` exists on Map, caches and `URLSearchParams` — a project adds it in `readers`.
 */
export const configGet: RegExp = new RegExp(`\\.(?:get|getOrThrow)\\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\\s*\\(\\s*["'\`](?<name>${ENV_NAME})["'\`]`);

/**
 * Names of environment variables a source reads. One parameter: a project calls `sources.flatMap(envNamesIn)`, and an
 * optional second one would get the `flatMap` index — a type error (#303). The file is known — `envNamesInCode`.
 */
export function envNamesIn(source: string): string[] {
  return envNamesInCode(codeOnly(source));
}

/**
 * The same on comment-free code — `codeOnly(text, file)`: the set of parser plugins by file extension. `readers` — the
 * project's own ways of reading (`configGet`, a regexp, a function), `file` — the path for a function.
 */
export function envNamesInCode(text: string, opts: { file?: string; readers?: readonly EnvReader[] } = {}): string[] {
  const out = new Set<string>();
  // a source under another name: a default parameter `(env = process.env)`, `const e = import.meta.env`,
  // `const env = loadEnv(mode, root)`
  for (const [, alias] of text.matchAll(ENV_ALIAS)) {
    const a = alias!.replace(/\$/g, "\\$");
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${a}(?:${FIELD})`, "g"))) out.add(m[1] ?? m[2]!);
  }
  for (const m of text.matchAll(ENV_READ)) out.add(m[1] ?? m[2]!);
  // `const { A = "x", B: b } = process.env`: the key runs up to ":" or "=", the `...rest` remainder is not a variable
  for (const m of text.matchAll(ENV_DESTRUCTURE)) {
    for (const part of m[1]!.split(",")) {
      const name = part.split(/[:=]/)[0]!.trim().replace(/^(["'`])(.*)\1$/, "$2");
      if (IS_ENV_NAME.test(name)) out.add(name);
    }
  }
  for (const r of opts.readers ?? []) {
    if (typeof r === "function") {
      for (const n of r(text, opts.file ?? "")) out.add(n);
      continue;
    }
    for (const m of text.matchAll(new RegExp(r.source, r.flags.includes("g") ? r.flags : r.flags + "g"))) {
      const n = m.groups?.name ?? m.slice(1).find((x) => x !== undefined);
      if (n) out.add(n);
    }
  }
  return [...out];
}

/**
 * Declared variables of a dotenv file (`.env.example`) — for `declared`: `X=…`, `export X=…` and commented-out
 * `# X=…` — optional ones with a default in the code: they aren't in `.env`, they are in the environment schema. Prose
 * in a comment is not a declaration. In order, without repeats.
 */
export function dotenvNames(text: string): string[] {
  const out = new Set<string>();
  const commented = new RegExp(`^\\s*#+\\s*(?:export\\s+)?(${ENV_NAME})\\s*=`);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line) ?? commented.exec(line);
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/** Environment variables read by code files (from the root): name → files. `cache` — names of a file shared by apps. */
function envReads(root: string, files: readonly string[], readers?: readonly EnvReader[], cache = new Map<string, string[]>()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    let names = cache.get(file);
    if (!names) {
      names = envNamesInCode(codeOnly(readFileSync(path.join(root, file), "utf8"), file), { file, readers });
      cache.set(file, names);
    }
    for (const n of names) out.set(n, [...new Set([...(out.get(n) ?? []), file])]);
  }
  return out;
}

/** A directory's package.json (from the root): name and `dependencies` packages; no file or not JSON — null. */
function packageJson(root: string, dir: string): { name?: string; dependencies: string[]; workspaces?: unknown } | null {
  try {
    const p = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")) as { name?: string; dependencies?: Record<string, string>; workspaces?: unknown };
    return { name: p.name, dependencies: Object.keys(p.dependencies ?? {}), workspaces: p.workspaces };
  } catch {
    return null;
  }
}

/**
 * Workspace patterns: `workspaces` of the root package.json (an array or `{ packages }`) and `packages` of
 * pnpm-workspace.yaml.
 */
function workspacePatterns(root: string): string[] {
  const out: string[] = [];
  const ws = packageJson(root, ".")?.workspaces;
  const list: unknown = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(list)) out.push(...list.filter((x): x is string => typeof x === "string"));
  let yaml = "";
  try {
    yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    /* not pnpm */
  }
  // parsing without dependencies: `packages: [a, b]` on one line or a "- pattern" list under the key up to the next
  // top-level key
  const flow = /^packages:\s*\[([^\]]*)\]/m.exec(yaml);
  if (flow) out.push(...flow[1]!.split(","));
  const block = /^packages:[ \t]*(?:#.*)?\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m.exec(yaml);
  for (const l of block?.[1]!.split(/\r?\n/) ?? []) {
    const m = /^\s+-\s*(.+?)\s*(?:#.*)?$/.exec(l);
    if (m) out.push(m[1]!);
  }
  return out.map((p) => p.trim().replace(/^(["'])(.*)\1$/, "$2").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
}

/** Workspace pattern → path regexp: `*` — one level, `**` — any depth. */
function globRegExp(pattern: string): RegExp {
  const segs = pattern.split("/");
  const re = segs.map((s, i) => {
    const last = i === segs.length - 1;
    if (s === "**") return last ? ".*" : "(?:[^/]+/)*";
    return s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + (last ? "" : "/");
  });
  return new RegExp(`^${re.join("")}$`);
}

/** Workspace packages by name: directory from the root and `dependencies`. A pattern with `!` is an exclusion. */
function workspacePackages(root: string): Map<string, { dir: string; dependencies: string[] }> {
  const patterns = workspacePatterns(root);
  const include = patterns.filter((p) => !p.startsWith("!"));
  const yes = include.map(globRegExp);
  const no = patterns.filter((p) => p.startsWith("!")).map((p) => globRegExp(p.slice(1)));
  // walk only under the patterns' constant part and no deeper than them: without `**` it doesn't descend into the
  // packages' code directories
  const bases = include.map((p) => {
    const segs = p.split("/");
    const glob = segs.findIndex((s) => /[*?]/.test(s));
    return (glob < 0 ? segs : segs.slice(0, glob)).join("/");
  });
  const depth = include.some((p) => p.includes("**")) ? Infinity : Math.max(0, ...include.map((p) => p.split("/").length));
  const near = (d: string) => bases.some((b) => !b || b === d || b.startsWith(d + "/") || d.startsWith(b + "/"));
  const out = new Map<string, { dir: string; dependencies: string[] }>();
  const walk = (rel: string, level: number): void => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (!near(child)) continue;
      if (yes.some((r) => r.test(child)) && !no.some((r) => r.test(child))) {
        const p = packageJson(root, child);
        if (p?.name) out.set(p.name, { dir: child, dependencies: p.dependencies });
      }
      if (level + 1 < depth) walk(child, level + 1);
    }
  };
  if (include.length) walk("", 0);
  return out;
}

/**
 * A monorepo app: a directory with package.json, declared variables, its own code directories and files (`dirs` by
 * default).
 */
export interface EnvApp {
  dir: string;
  declared: readonly string[];
  dirs?: string[];
}

/**
 * Reads of monorepo apps: files of the app and of the workspace packages from its `dependencies`, transitively
 * (devDependencies don't get into the build) — a package reads the environment of the app whose build it got into.
 * `dirs` — from each package's directory.
 */
function appReads(root: string, apps: Record<string, EnvApp>, dirs: string[], readers?: readonly EnvReader[]): { app: string; declared: readonly string[]; reads: Map<string, string[]> }[] {
  const ws = workspacePackages(root);
  const cache = new Map<string, string[]>();
  return Object.entries(apps).map(([app, a]) => {
    const dir = path.posix.normalize(a.dir).replace(/\/+$/, "");
    const pkgs = [dir];
    const queue = [...(packageJson(root, dir)?.dependencies ?? [])];
    const seenDeps = new Set<string>();
    while (queue.length) {
      const name = queue.shift()!;
      const p = ws.get(name);
      if (!p || seenDeps.has(name)) continue;
      seenDeps.add(name);
      if (!pkgs.includes(p.dir)) pkgs.push(p.dir);
      queue.push(...p.dependencies);
    }
    const files = pkgs.flatMap((p) => codeFiles(root, (p === dir ? (a.dirs ?? dirs) : dirs).map((d) => path.posix.join(p, d))));
    return { app, declared: a.declared, reads: envReads(root, [...new Set(files)], readers, cache) };
  });
}

/**
 * Environment variables — declared and read: "<VAR> is declared" for each one the code reads (`process.env.X`,
 * `import.meta.env?.X`, `["X"]`, destructuring, an alias of the source and of Vite's `loadEnv` result, own ways —
 * `readers`), and "<VAR> is read in the code" for each declared one (`declared` — from the project's environment
 * schema: zod, t3-env, `dotenvNames(.env.example)`). Monorepo — `apps` instead of `declared`: an element is
 * `<app>/<VAR>`, workspace packages' reads belong to the apps whose build they're in. Service ones (`ENV_SERVICE` and
 * `ignore`) are outside the check.
 */
export function envVars(
  it: It,
  opts: {
    root: string;
    /** Code directories and files: from the root, in a monorepo — from each package's directory; `src` by default. */
    dirs?: string[];
    readers?: readonly EnvReader[];
    outside?: readonly { item: string; reason: string }[];
    /** Deprecated: no reason and no ratchet — a failing test "move it to outside". */
    ignore?: readonly string[];
    exceptions?: readonly Exception[];
  } & ({ declared: readonly string[]; apps?: undefined } | { apps: Record<string, EnvApp>; declared?: undefined }),
): void {
  const skip = new Set([...ENV_SERVICE, ...(opts.ignore ?? [])]);
  const N = localeNames();
  if (opts.ignore?.length) {
    it(locale.fill(N.spec.harness.ignoreNoReason, { items: [...opts.ignore].sort().join(", ") }), () => {
      throw new Error("ignore holds no reason — move it to outside: [{ item, reason }] (the reason is on the page; once the variable is gone — «remove from scope»)");
    });
  }
  const dirs = opts.dirs ?? ["src"];
  // one app — the element key is the variable name; monorepo apps — <app>/<VAR>
  const apps = opts.apps
    ? appReads(opts.root, opts.apps, dirs, opts.readers)
    : [{ app: "", declared: opts.declared, reads: envReads(opts.root, codeFiles(opts.root, dirs), opts.readers) }];
  const byApp = new Map(apps.map((a) => [a.app, { declared: new Set(a.declared), reads: a.reads }]));
  const of = (app: string) => byApp.get(app) ?? { declared: new Set<string>(), reads: new Map<string, string[]>() };
  type Item = { app: string; v: string };
  const keyOf = (i: Item) => (i.app ? `${i.app}/${i.v}` : i.v);
  const readItems = apps.flatMap((a) => [...a.reads.keys()].filter((v) => !skip.has(v)).map((v) => ({ app: a.app, v })));
  const declaredItems = apps.flatMap((a) => [...new Set(a.declared)].filter((v) => !skip.has(v)).map((v) => ({ app: a.app, v })));
  // an exception and "outside scope" go to the check whose registry has the variable; in none — to the first one:
  // "remove" there
  const inReads = new Set(readItems.map(keyOf));
  const inDeclared = new Set(declaredItems.map(keyOf));
  const forReads = <T extends { item: string }>(xs?: readonly T[]) => xs?.filter((x) => inReads.has(x.item) || !inDeclared.has(x.item));
  const forDeclared = <T extends { item: string }>(xs?: readonly T[]) => xs?.filter((x) => inDeclared.has(x.item));
  invariant(it, {
    registry: N.spec.harness.env.inCode,
    items: readItems,
    name: (i) => locale.fill(N.spec.harness.env.declaredName, { name: keyOf(i) }),
    key: keyOf,
    check: (i) => {
      const schema = i.app ? `the environment schema of app ${i.app}` : "the environment schema";
      if (!of(i.app).declared.has(i.v)) throw new Error(`${i.v} is read in ${(of(i.app).reads.get(i.v) ?? []).join(", ")} but not declared in ${schema}`);
    },
    violator: { name: N.spec.harness.env.undeclared, item: { app: "", v: "__UNDECLARED__" } },
    exceptions: forReads(opts.exceptions),
    outside: forReads(opts.outside),
  });
  invariant(it, {
    registry: N.spec.harness.env.declared,
    items: declaredItems,
    name: (i) => locale.fill(N.spec.harness.env.readName, { name: keyOf(i) }),
    key: keyOf,
    check: (i) => {
      if (of(i.app).reads.has(i.v)) return;
      throw new Error(
        i.app
          ? `${i.v} is declared in the environment schema of app ${i.app} but read neither by it nor by its packages — remove it from the environment schema`
          : `${i.v} is declared but not read — remove it from the environment schema`,
      );
    },
    violator: { name: N.spec.harness.env.unread, item: { app: "", v: "__UNREAD__" } },
    exceptions: forDeclared(opts.exceptions),
    outside: forDeclared(opts.outside),
  });
}
