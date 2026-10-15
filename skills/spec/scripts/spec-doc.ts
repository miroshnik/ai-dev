#!/usr/bin/env bun
/**
 * spec-doc — documentation from runner reports (Vitest/Jest JSON, Playwright JSON, JUnit XML from bun test): a section
 * per folder tests/capabilities/<name> ("What the system does"), tests/architecture/<name> ("What it's made of") and
 * tests/standards/<name> ("Which rules the code obeys"). A page is a story: the description <folder>.md next to the
 * tests under the heading (the first paragraph goes to the index, the md headings — under the folder heading), the main
 * file <name>.test.ts for all kinds (<name>.e2e.ts next to it — right after it; in a monorepo — also
 * <name>/<package>/<name>.test.ts; rule.test.ts — a hint to rename), a describe → a section with prose from its own
 * JSDoc, the section's tests collapsed into <details> with a counter. Sections go in the order of the main file, then
 * of the packages' main files by package name, the other files follow by path. The header of another file of the
 * folder doesn't go into the documentation — the script names the file, --strict gives code 1. No source — no prose.
 * tests/lib is skipped; tests outside the tree go to the "Outside the tree" section — that's a signal. A describe or it
 * name that isn't a statement in the project language — a warning line in stderr, without an exit code.
 *
 *   bun spec-doc.ts report.json [report2.xml …] [--root DIR] [--out docs/spec | --stdout] [--strict]
 *                   [--meta .spec-meta]
 *
 * Harness run metadata (`.spec-meta/` in the root or --meta) — the example code and exception reasons under the test
 * line. The architecture model (`tests/architecture/model.ts`) — the architecture.md page: C4 diagrams and the module
 * table (`c4.ts`); the `<!-- spec: c4-… -->` mark in `<folder>.md` is replaced with the same diagram. A scenario trace
 * (the harness `sequence`) — a sequence diagram under its test or where `<!-- spec: sequence-<id> -->` stands in
 * `<folder>.md`.
 *
 * Output by default — docs/spec/: README.md (index), architecture.md, capabilities/<name>.md, architecture/<name>.md,
 * standards/<name>.md; it deletes its own outdated files (with the marker in any dictionary language). The
 * documentation text is in the root's project language (`language` in `.agents/elves.json`, the github skill's
 * dictionary). Runs under Bun, no dependencies.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import locale from "../../github/scripts/locale.ts";
import type { Names, Plural } from "../../github/scripts/locale.ts";
import type { Model } from "./architecture.ts";
import * as C4 from "./c4.ts";
import type { Call } from "./harness.ts";
import * as L from "./speclib.ts";
import type { Kind, Test } from "./speclib.ts";

// the project language and its names: everything that goes into docs/spec is in it; main sets it from the root
let LANG = locale.DEFAULT_LANGUAGE;
let N: Names = locale.names(LANG);

const ICON: Record<string, string> = { passed: "✅", failed: "❌", skipped: "⏭️", todo: "📝" };
// section order — the reader's questions: what it does, what it's made of, which rules the code obeys
const KINDS: Kind[] = ["capability", "architecture", "standard"];
const SUBDIR: Record<string, string> = { capability: "capabilities", architecture: "architecture", standard: "standards" };

/** A table of contents section heading — the reader's question about the tree root. */
function sectionTitle(kind: Kind): string {
  if (kind === "capability") return N.spec.doc.capabilities;
  if (kind === "architecture") return N.spec.doc.architecture;
  return N.spec.doc.standards;
}

// doc — prose paragraphs from JSDoc: for a group — the main file's header, for a describe from several files — in
// file order (the main one first), a repeat once
type Node = { tests: Test[]; children: Map<string, Node>; doc: string[] };
type Group = { kind: Kind; name: string; tests: Test[]; tree: Node; doc: string[]; testDocs: Map<string, string[]> };

/** A number and the word form in the project language: "2 tests". */
const count = (forms: Plural, n: number): string => locale.count(LANG, forms, n);
const testsWord = (n: number): string => L.testsWord(LANG, n);

/** Skipped and failing — what's worth noticing; empty if everything is green. */
function problemsLine(tests: Test[]): string {
  const parts: string[] = [];
  const sk = tests.filter((t) => t.status === "skipped" || t.status === "todo").length;
  const fl = tests.filter((t) => t.status === "failed").length;
  if (sk) parts.push(count(N.spec.doc.skippedCount, sk));
  if (fl) parts.push(count(N.spec.doc.failingCount, fl));
  return parts.join(", ");
}

function countsLine(tests: Test[]): string {
  return [testsWord(tests.length), problemsLine(tests)].filter(Boolean).join(", ");
}

/** A number and a word in English — for stderr messages (they aren't in the project language): "1 file", "2 files". */
const enCount = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Test counters for stderr: "12 tests, 1 skipped, 1 failing". */
function enCountsLine(tests: Test[]): string {
  const sk = tests.filter((t) => t.status === "skipped" || t.status === "todo").length;
  const fl = tests.filter((t) => t.status === "failed").length;
  return [enCount(tests.length, "test"), sk ? `${sk} skipped` : "", fl ? `${fl} failing` : ""].filter(Boolean).join(", ");
}

function findRoot(root?: string): string {
  if (root) return path.resolve(root);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return top;
  } catch {
    /* not a git repository — the current directory */
  }
  return process.cwd();
}

const newNode = (): Node => ({ tests: [], children: new Map(), doc: [] });
const testKey = (t: Test): string => JSON.stringify([...t.describes, t.name]);

/**
 * The folder's main file (`<name>.test.ts`, `<name>.e2e.ts`…) — it holds the story, the page starts with it. Its name
 * is the folder name for all kinds: one rule instead of a special `rule.test.ts` for a standard. It lies in the folder
 * root or in a monorepo package subfolder (`<name>/<package>/<name>.test.ts`: a package has its own runner, but the
 * decision is one); not deeper.
 * → the package ("" — the folder root) and whether these are unit statements (`.test.*`); not the main one — null.
 */
function mainOf(file: string): { pkg: string; unit: boolean } | null {
  const [kind, name] = L.classify(file);
  if (!KINDS.includes(kind) || name === null) return null;
  const inner = file.split("/").slice(3);
  const base = inner.at(-1)!.split(".");
  if (inner.length > 2 || base[0] !== name) return null;
  return { pkg: inner.length === 2 ? inner[0]! : "", unit: base[1] === "test" };
}

const isMain = (file: string): boolean => mainOf(file) !== null;

/**
 * A file's place in the folder's story — the sort key: the main file in the folder root, then the subfolders' main
 * files by package name, then the rest; for the main one — first `<name>.test.*` (unit statements), then another
 * `<name>.*` (`.e2e.ts`): alphabetically e2e would come first. Within a place — by path.
 */
function mainRank(file: string): string {
  const m = mainOf(file);
  return (m ? "0" + m.pkg + "\0" + (m.unit ? "0" : "1") : "1") + "\0" + file;
}

/** The former main file of a standard, `rule.*` right in the folder: no longer the main one — it must be renamed. */
function isLegacyMain(file: string): boolean {
  const [kind, name] = L.classify(file);
  const parts = file.split("/");
  return (kind === "standard" || kind === "architecture") && name !== "rule" && parts.length === 4 && parts[3]!.split(".")[0] === "rule";
}

/** → groups by (kind, name), tests outside the tree by file, tests/lib files. */
export function build(tests: Test[]): { groups: Map<string, Group>; out: Map<string, Test[]>; libFiles: Set<string> } {
  const groups = new Map<string, Group>();
  const out = new Map<string, Test[]>();
  const libFiles = new Set<string>();
  // the folder's main file first — the order of its describes is the order of the story; then the packages' main
  // files, then files by path; within a file — the report order (declaration order)
  const rank = (t: Test): string => mainRank(t.path);
  const sorted = [...tests].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  for (const t of sorted) {
    const [kind, name] = L.classify(t.path);
    if (kind === "lib") {
      libFiles.add(t.path);
      continue;
    }
    if (kind === "out" || name === null) {
      if (!out.has(t.path)) out.set(t.path, []);
      out.get(t.path)!.push(t);
      continue;
    }
    const gk = kind + "/" + name;
    if (!groups.has(gk)) groups.set(gk, { kind, name, tests: [], tree: newNode(), doc: [], testDocs: new Map() });
    const g = groups.get(gk)!;
    g.tests.push(t);
    let node = g.tree;
    for (const d of t.describes) {
      if (!node.children.has(d)) node.children.set(d, newNode());
      node = node.children.get(d)!;
    }
    node.tests.push(t);
  }
  return { groups, out, libFiles };
}

const addOnce = (list: string[], text: string): void => {
  if (text && !list.includes(text)) list.push(text);
};

/**
 * The folder's main file we expect when the report doesn't have it: `<folder>.test.ts`; for a folder with package
 * subfolders — or `<package>/<folder>.test.ts`.
 */
function mainPath(g: Group): string {
  const folder = `${L.TESTS}/${SUBDIR[g.kind]}/${g.name}`;
  const packages = g.tests.some((t) => t.path.split("/").length > 4);
  return `${folder}/${g.name}.test.ts` + (packages ? ` or ${folder}/<package>/${g.name}.test.ts` : "");
}

/** The group has a main file: in the report or on disk — in the folder root or in a package subfolder. */
function hasMain(g: Group, root: string): boolean {
  if (g.tests.some((t) => isMain(t.path))) return true;
  const folder = `${L.TESTS}/${SUBDIR[g.kind]}/${g.name}`;
  const files = (rel: string) => {
    try {
      return readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return files(folder).some((e) =>
    e.isDirectory() ? files(`${folder}/${e.name}`).some((f) => L.isTestFile(f.name) && isMain(`${folder}/${e.name}/${f.name}`)) : L.isTestFile(e.name) && isMain(`${folder}/${e.name}`),
  );
}

/** describe and it names that aren't statements — per file, without repeats. */
function badNames(groups: Map<string, Group>): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const g of groups.values()) {
    for (const t of g.tests) {
      for (const n of [...t.describes, t.name]) {
        const k = t.path + "\0" + n;
        if (seen.has(k) || L.isStatement(n, LANG)) continue;
        seen.add(k);
        out.push([n, t.path]);
      }
    }
  }
  return out;
}

/** The decision's description — `<folder>.md` next to the folder's tests, the path from the root. */
export const descriptionPath =(g: { kind: Kind; name: string }): string => `${L.TESTS}/${SUBDIR[g.kind]}/${g.name}/${g.name}.md`;

/**
 * The group's prose: the intro — `<folder>.md` (why, the reason, what was rejected), describe and it — their JSDoc from
 * the sources (reports don't carry comments). A describe without tests in the report (a name from it.each with
 * substitution) loses its prose. Returns files missing on disk (they're without prose), folders without a description,
 * test files with a header — the story is written in one place, a file header doesn't go into the documentation —
 * former main `rule.*` files that must be renamed, and those whose prose can't be taken: the parser didn't parse the
 * file, or a test with JSDoc has a name that can't be computed statically.
 */
export function attachDocs(
  groups: Map<string, Group>,
  root: string,
): { missing: string[]; headers: string[]; legacy: string[]; undescribed: string[]; unread: string[] } {
  const missing: string[] = [];
  const unread: string[] = [];
  const headers: string[] = [];
  const legacy: string[] = [];
  const undescribed: string[] = [];
  for (const g of groups.values()) {
    try {
      const text = readFileSync(path.join(root, descriptionPath(g)), "utf8").trim();
      if (text) g.doc.push(text);
    } catch {
      undescribed.push(descriptionPath(g));
    }
    // file order — as in build: the main one first
    for (const file of [...new Set(g.tests.map((t) => t.path))]) {
      if (isLegacyMain(file)) legacy.push(file);
      let source: string;
      try {
        source = readFileSync(path.join(root, file), "utf8");
      } catch {
        missing.push(file);
        continue;
      }
      let scan: ReturnType<typeof L.scanJs>;
      try {
        scan = L.scanJs(file, source);
      } catch (e) {
        unread.push(`${file}: ${(e as Error).message} — JSDoc prose not taken`);
        continue;
      }
      const { docs } = scan;
      for (const u of scan.unnamed) if (u.doc) unread.push(`${file}:${u.line}: the ${u.kind} name can't be computed statically (${u.name}) — JSDoc prose not taken`);
      if (docs.file) headers.push(file);
      for (const [key, text] of docs.describes) {
        let node: Node | undefined = g.tree;
        for (const d of JSON.parse(key) as string[]) node = node?.children.get(d);
        if (node) addOnce(node.doc, text);
      }
      for (const [key, text] of docs.tests) {
        if (!g.testDocs.has(key)) g.testDocs.set(key, []);
        addOnce(g.testDocs.get(key)!, text);
      }
    }
  }
  return { missing, headers, legacy, undescribed, unread };
}

/** Harness run metadata: test file + name → what isn't in the name (example code, exception reason). */
type Meta = {
  path?: string;
  code?: string;
  issue?: number;
  reason?: string;
  disables?: { line: number; rules: string[]; description: string }[];
  id?: string;
  sequence?: Call[];
};
let META = new Map<string, Meta>();
// tests whose diagram stands as a mark in the folder description: we don't repeat it under the test
const PLACED = new Set<string>();

/**
 * A Mermaid sequence diagram from a trace: participants — in order of appearance; a name that isn't an identifier —
 * via `as`.
 */
export function sequenceLines(calls: Call[]): string[] {
  const ids = new Map<string, string>();
  for (const c of calls) for (const n of [c.from, c.to]) if (!ids.has(n)) ids.set(n, n.replace(/[^A-Za-z0-9_]/g, "_"));
  return [
    "```mermaid",
    "sequenceDiagram",
    ...[...ids].map(([n, id]) => `  participant ${id}${id === n ? "" : ` as ${n}`}`),
    // Mermaid reads ";" and "#" as a separator and a character code
    ...calls.map((c) => `  ${ids.get(c.from)}->>${ids.get(c.to)}: ${c.message.replace(/[;#]/g, ",")}`),
    "```",
  ];
}

export function loadMeta(dir: string): Map<string, Meta> {
  const out = new Map<string, Meta>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { file, test, ...rest } = JSON.parse(line) as Meta & { file: string; test: string };
      out.set(file + "\0" + test, rest);
    }
  }
  return out;
}

// the language of the example's code block by its file's extension
const FENCE_LANG: Record<string, string> = { ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx" };

/**
 * The lint disables file — from the name of the harness `lintExceptions` test in any dictionary language:
 * "exceptions in <file>: …".
 */
const LINT_FILE = new RegExp(`^(?:${locale.every((n) => n.spec.harness.lintExceptions).map((t) => locale.escapeRe(t.split("{file}")[0]!)).join("|")})(.+?): `);

/** Under the test line: the example's path and code, the exception's task and reason, rule disables in the file. */
function metaLines(t: Test): string[] {
  const m = META.get(t.path + "\0" + t.name);
  if (!m) return [];
  const out: string[] = [];
  if (m.code !== undefined) {
    if (m.path) out.push(`  \`${m.path}\``);
    out.push("  ```" + (FENCE_LANG[(m.path ?? "").split(".").pop() ?? ""] ?? ""), ...m.code.split("\n").map((l) => (l ? "  " + l : "")), "  ```");
  }
  if (m.issue !== undefined) out.push(`  > #${m.issue} — ${m.reason ?? ""}`);
  else if (m.reason) out.push(`  > ${m.reason}`); // out of scope — a reason without a task: it's a decision, not a debt
  const codeFile = LINT_FILE.exec(t.name)?.[1] ?? "";
  for (const d of m.disables ?? []) out.push(`  > \`${codeFile}:${d.line}\` ${d.rules.join(", ") || N.spec.lint.allRules} — ${d.description || N.spec.lint.noReason}`);
  if (m.sequence?.length && !PLACED.has(t.path + "\0" + t.name)) out.push(...sequenceLines(m.sequence).map((l) => "  " + l));
  return out;
}

function testLine(t: Test): string {
  let line = `- ${ICON[t.status] ?? "❔"} ${L.mdText(t.name)}`;
  if (t.status === "skipped") line += ` — ${N.spec.doc.skipped}` + (t.reason ? `: ${L.mdText(t.reason)}` : "");
  else if (t.status === "failed") line += ` — ${N.spec.doc.failing}`;
  else if (t.status === "todo") line += ` — ${N.spec.doc.todo}`;
  if (t.variants > 1) line += ` (${count(N.spec.doc.variants, t.variants)})`;
  return line;
}

const heading = (level: number, text: string) => "#".repeat(Math.min(level, 6)) + " " + text;

/** Prose paragraphs under a heading; empty — nothing. */
function pushDoc(lines: string[], doc: string[]): void {
  if (doc.length) lines.push(doc.join("\n\n"), "");
}

/**
 * The section's tests — a collapsed block with a counter: the story is read through headings and prose, a check is
 * opened by a click. There are skipped or failing ones — they're in the summary line, the block is open.
 * A test's prose — a quote inside the list item: the list stays dense, the test line stays one line.
 */
function renderTests(g: Group, tests: Test[], lines: string[]): void {
  if (!tests.length) return;
  const problems = problemsLine(tests);
  const icon = tests.some((t) => t.status === "failed") ? ICON.failed : problems ? ICON.skipped : ICON.passed;
  lines.push(`<details${problems ? " open" : ""}><summary>${icon} ${countsLine(tests)}</summary>`, "");
  for (const t of tests) {
    lines.push(testLine(t));
    const doc = g.testDocs.get(testKey(t));
    if (doc?.length) lines.push(...doc.join("\n\n").split("\n").map((l) => (l ? "  > " + l : "  >")));
    lines.push(...metaLines(t));
  }
  lines.push("", "</details>", "");
}

function renderNode(g: Group, node: Node, level: number, lines: string[]): void {
  renderTests(g, node.tests, lines);
  for (const [name, child] of node.children) {
    lines.push(heading(level, L.mdText(name)), "");
    pushDoc(lines, child.doc);
    renderNode(g, child, level + 1, lines);
  }
}

/**
 * The description's markdown under a folder heading of level `level`: its headings shift by level − 1 (except code
 * blocks).
 */
function shiftHeadings(text: string, level: number): string {
  let fence = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      return !fence && /^#{1,6}\s/.test(l) ? "#".repeat(level - 1) + l : l;
    })
    .join("\n");
}

/**
 * The group heading at level `level`, the description under it, describes — deeper. There's no "section · path ·
 * counter" line: the section and the path follow from the convention, the status is visible at each test.
 */
function renderGroup(g: Group, level: number): string {
  const lines = [heading(level, g.name), ""];
  pushDoc(lines, g.doc.map((d) => shiftHeadings(d, level)));
  renderNode(g, g.tree, level + 1, lines);
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * The first paragraph of the group's description (not a heading, a diagram or a table) as one line — the description
 * in the index.
 */
function summaryOf(g: Group): string {
  const first = (g.doc[0] ?? "").split("\n\n").find((p) => p.trim() && !/^(#{1,6}\s|```|~~~|\|)/.test(p.trim())) ?? "";
  return first.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
}

function indexLine(g: Group): string {
  const summary = summaryOf(g);
  const problems = problemsLine(g.tests);
  const text = summary && problems ? `${summary} (${problems})` : summary || problems;
  return `- [${g.name}](${SUBDIR[g.kind]}/${g.name}.md)` + (text ? ` — ${text}` : "");
}

function groupNames(groups: Map<string, Group>, kind: Kind): string[] {
  return [...groups.values()].filter((g) => g.kind === kind).map((g) => g.name).sort();
}

function outSection(out: Map<string, Test[]>): string[] {
  if (!out.size) return [];
  const homes = KINDS.map((k) => `\`${L.TESTS}/${SUBDIR[k]}/<name>\``);
  const intro = locale.fill(N.spec.doc.outsideIntro, { homes: homes.slice(0, -1).join(", "), last: homes.at(-1)! });
  const lines = ["", `## ${N.spec.doc.outside}`, "", intro, ""];
  for (const file of [...out.keys()].sort()) lines.push(`- \`${file}\` — ${testsWord(out.get(file)!.length)}`);
  return lines;
}

/** The architecture page — next to README, the first line of the "What it's made of" section. */
const ARCH_PAGE = "architecture.md";

function renderIndex(groups: Map<string, Group>, out: Map<string, Test[]>, model: Model | null): string {
  const lines = [N.spec.doc.mark, `# ${N.spec.doc.title}`, "", N.spec.doc.intro];
  for (const kind of KINDS) {
    const names = groupNames(groups, kind);
    const page = kind === "architecture" && model;
    // a project may have neither a model nor architecture rules at all — then there's no section, not "— none."
    if (!names.length && !page && kind === "architecture") continue;
    lines.push("", `## ${sectionTitle(kind)}`, "");
    if (page) lines.push(`- [${N.spec.c4.title}](${ARCH_PAGE}) — ${C4.modelSummary(model, LANG)}`);
    if (!names.length && !page) lines.push(N.spec.doc.none);
    for (const n of names) lines.push(indexLine(groups.get(kind + "/" + n)!));
  }
  lines.push(...outSection(out));
  return lines.join("\n") + "\n";
}

/** The architecture page: diagrams and the table from the model, then the rules checking the model against the code. */
function renderArchitecture(groups: Map<string, Group>, model: Model): string {
  const lines = [N.spec.doc.mark, ...C4.architecturePage(model, 1, LANG), `## ${N.spec.doc.rules}`, ""];
  const names = groupNames(groups, "architecture");
  if (!names.length) lines.push(N.spec.doc.none);
  for (const n of names) lines.push(indexLine(groups.get("architecture/" + n)!));
  return lines.join("\n") + "\n";
}

function renderStdout(groups: Map<string, Group>, out: Map<string, Test[]>, model: Model | null): string {
  const lines = [N.spec.doc.mark, `# ${N.spec.doc.title}`, "", N.spec.doc.intro];
  for (const kind of KINDS) {
    const names = groupNames(groups, kind);
    const page = kind === "architecture" && model;
    if (!names.length && !page && kind === "architecture") continue;
    lines.push("", `## ${sectionTitle(kind)}`, "");
    if (page) lines.push(...C4.architecturePage(model, 3, LANG));
    if (!names.length && !page) lines.push(N.spec.doc.none);
    for (const n of names) lines.push(renderGroup(groups.get(kind + "/" + n)!, 3).trimEnd(), "");
  }
  lines.push(...outSection(out));
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Its own generated file (the marker in the first line) can be deleted; someone else's can't. The marker is in any
 * dictionary language: the project changed its language — the files of the former language are its own too.
 */
const isOwn = (file: string): boolean => locale.every((n) => n.spec.doc.mark).includes(readFileSync(file, "utf8").split("\n", 1)[0]!);

function writeFiles(
  groups: Map<string, Group>,
  out: Map<string, Test[]>,
  outDir: string,
  model: Model | null,
): { generated: Set<string>; removed: string[] } {
  const generated = new Set<string>();
  const removed: string[] = [];
  mkdirSync(outDir, { recursive: true });
  const arch = path.join(outDir, ARCH_PAGE);
  if (model) {
    writeFileSync(arch, renderArchitecture(groups, model));
    generated.add(ARCH_PAGE);
  } else if (existsSync(arch) && isOwn(arch)) {
    // the model was removed — its page is outdated
    unlinkSync(arch);
    removed.push(ARCH_PAGE);
  }
  for (const g of groups.values()) {
    const rel = path.join(SUBDIR[g.kind]!, g.name + ".md");
    const full = path.join(outDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, N.spec.doc.mark + "\n" + renderGroup(g, 1));
    generated.add(rel);
  }
  writeFileSync(path.join(outDir, "README.md"), renderIndex(groups, out, model));
  // all the tree's tests from the report — the base for spec-diff: harness tests aren't visible in the sources, in the
  // report they are
  const seen = new Set<string>();
  const list = [...groups.values()]
    .flatMap((g) => g.tests.map((t) => ({ path: t.path, describes: t.describes, name: t.name })))
    .filter((t) => {
      const k = JSON.stringify(t);
      return !seen.has(k) && !!seen.add(k);
    })
    .sort((x, y) => (JSON.stringify([x.path, x.describes, x.name]) < JSON.stringify([y.path, y.describes, y.name]) ? -1 : 1));
  writeFileSync(path.join(outDir, "tests.json"), JSON.stringify(list, null, 1) + "\n");
  for (const sub of Object.values(SUBDIR)) {
    const d = path.join(outDir, sub);
    if (!existsSync(d)) continue;
    for (const fn of readdirSync(d).sort()) {
      const rel = path.join(sub, fn);
      if (!fn.endsWith(".md") || generated.has(rel)) continue;
      if (isOwn(path.join(d, fn))) {
        // its own outdated file; someone else's we don't touch
        unlinkSync(path.join(d, fn));
        removed.push(rel);
      }
    }
  }
  return { generated, removed };
}

/** The project's architecture model — one, at this place. */
const MODEL = `${L.TESTS}/architecture/model.ts`;

/**
 * The model from `tests/architecture/model.ts` (export default); no file — null, doesn't load — an error with the
 * reason.
 */
async function loadModel(root: string): Promise<Model | null> {
  const file = path.join(root, MODEL);
  if (!existsSync(file)) return null;
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    throw new Error(`model ${MODEL} doesn't load: ${(e as Error).message}`);
  }
  const m = mod.default as Model | undefined;
  if (!m || typeof m !== "object" || !m.modules || typeof m.modules !== "object") throw new Error(`model ${MODEL} has no export default with modules`);
  return m;
}

/**
 * `<!-- spec: … -->` marks in group descriptions → diagrams from the model; returns the unrecognized marks with the
 * file.
 */
const SEQUENCE_MARK = /^[ \t]*<!--\s*spec:\s*sequence-([\w-]+)\s*-->[ \t]*$/gm;

function embedMarks(groups: Map<string, Group>, model: Model | null): string[] {
  const problems: string[] = [];
  for (const g of groups.values()) {
    const files = new Set(g.tests.map((t) => t.path));
    g.doc = g.doc.map((d) => {
      // a scenario — by id among this folder's tests: the diagram is in the story, it's no longer under the test
      const withSequences = d.replace(SEQUENCE_MARK, (line, id: string) => {
        const hit = [...META].find(([k, m]) => m.id === id && m.sequence && files.has(k.split("\0")[0]!));
        if (!hit) {
          problems.push(`mark <!-- spec: sequence-${id} --> in ${descriptionPath(g)}: no scenario ${id} in the folder's tests`);
          return line;
        }
        PLACED.add(hit[0]);
        return sequenceLines(hit[1].sequence!).join("\n");
      });
      const { text, bad } = C4.embed(withSequences, model, LANG);
      for (const b of bad) {
        const mark = `<!-- spec: ${b.mark} -->`;
        problems.push(
          b.missing === "model"
            ? `mark ${mark} in ${descriptionPath(g)}: no model ${MODEL}`
            : `unknown mark ${mark} in ${descriptionPath(g)} — available: ${[...Object.keys(C4.MARKS), "sequence-<id>"].join(", ")}`,
        );
      }
      return text;
    });
  }
  return problems;
}

// the former name exceptions — a directory of the decision folder and its old array file: names aren't exceptions any
// more (#447), nobody reads them
const NAMES_LEFTOVER = /^names\.exceptions(?:\.(?:ts|mts|js|mjs|json))?$/;

/** Leftover name exceptions under tests/ — the directory or the file, as a path from the root. */
function leftoverNames(root: string, rel = L.TESTS): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.name !== "node_modules")
    .flatMap((e) => (NAMES_LEFTOVER.test(e.name) ? [`${rel}/${e.name}`] : e.isDirectory() ? leftoverNames(root, `${rel}/${e.name}`) : []))
    .sort();
}

const USAGE =
  "spec-doc report.json [report2.xml …] [--root DIR] [--out docs/spec | --stdout] [--strict] [--meta .spec-meta]";
/** `--help`, `-h` (tests/standards/cli-help): the synopsis, what it does and examples. */
const HELP = `${USAGE}

Documentation from runner reports (Vitest/Jest JSON, Playwright JSON, JUnit XML from bun test): a page per folder of
tests/capabilities, tests/architecture and tests/standards with prose from JSDoc and <folder>.md, by default into
docs/spec; --strict — code 1 when a file's header doesn't go into the documentation.

Examples:
  spec-doc .spec-report.json --strict
  spec-doc .spec-report.xml e2e-report.json --stdout`;

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        out: { type: "string", default: path.join("docs", "spec") },
        stdout: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        meta: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-doc: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = opts;
  if (values.help) return console.log(HELP), 0;
  if (!positionals.length) return console.error(USAGE), 2;
  const root = findRoot(values.root);
  LANG = locale.projectLanguage(root);
  N = locale.names(LANG);
  let tests: Test[] = [];
  // CI is set — the report must exist: otherwise a run that didn't write it silently drops its tests from the spec
  const inCi = !!process.env.CI && !["0", "false"].includes(process.env.CI);
  for (const r of positionals) {
    if (!existsSync(r)) {
      console.error(`spec-doc: no report ${r} — its tests didn't get into the spec${inCi ? "" : " (locally a warning, in CI an error)"}`);
      if (inCi) return 2;
      continue;
    }
    try {
      tests.push(...L.loadReport(r, root));
    } catch (e) {
      console.error(`spec-doc: ${(e as Error).message}`);
      return 2;
    }
  }
  tests = L.mergeTests(tests);
  let model: Model | null;
  try {
    model = await loadModel(root);
  } catch (e) {
    console.error(`spec-doc: ${(e as Error).message}`);
    return 2;
  }
  META = loadMeta(path.resolve(root, values.meta ?? ".spec-meta"));
  const { groups, out, libFiles } = build(tests);
  const { missing, headers, legacy, undescribed, unread } = attachDocs(groups, root);
  const noMain = [...groups.values()].filter((g) => !hasMain(g, root)).map(mainPath);
  // a name that isn't a statement — a warning: the rule stays, the PR isn't red because of it (#447)
  const names = badNames(groups);
  const leftovers = leftoverNames(root);
  const marks = embedMarks(groups, model);

  if (values.stdout) {
    process.stdout.write(renderStdout(groups, out, model));
  } else {
    const outDir = path.isAbsolute(values.out) ? values.out : path.join(root, values.out);
    const { generated, removed } = writeFiles(groups, out, outDir, model);
    for (const rel of removed) console.error(`spec-doc: deleted stale ${path.join(values.out, rel)}`);
    console.error(`spec-doc: ${values.out}: README.md + ${enCount(generated.size, "file")}`);
  }

  const nCap = groupNames(groups, "capability").length;
  const nArch = groupNames(groups, "architecture").length;
  const nStd = groupNames(groups, "standard").length;
  const inTree = [...groups.values()].flatMap((g) => g.tests);
  const outN = [...out.values()].reduce((s, v) => s + v.length, 0);
  console.error(
    `spec-doc: capabilities ${nCap}, architecture ${nArch}, standards ${nStd}, ${enCountsLine(inTree)}; ${L.TESTS}/lib files skipped: ${libFiles.size}; outside the tree: ${outN} in ${enCount(out.size, "file")}`,
  );
  for (const file of [...out.keys()].sort()) console.error(`spec-doc: outside the tree: ${file} (${enCount(out.get(file)!.length, "test")})`);
  if (missing.length) console.error(`spec-doc: no sources (${missing.length}) — JSDoc prose not taken: ${missing.join(", ")}`);
  for (const m of unread) console.error(`spec-doc: ${m}`);
  for (const file of undescribed) console.error(`spec-doc: no description ${file} — why, the reason, the rejected options`);
  for (const file of noMain) console.error(`spec-doc: no main file ${file} — its describe blocks open the page`);
  for (const [name, file] of names) console.error(`spec-doc: warning: the name isn't a statement in the project language (${LANG}): «${name}» (${file})`);
  for (const at of leftovers) console.error(`spec-doc: warning: ${at} isn't read — names aren't exceptions any more, delete it`);
  for (const file of headers) {
    const [kind, name] = L.classify(file);
    console.error(`spec-doc: a file header doesn't go into the documentation — move it to ${descriptionPath({ kind, name: name! })}: ${file}`);
  }
  for (const file of legacy) {
    const base = path.posix.basename(file);
    console.error(`spec-doc: the folder's main file is ${L.classify(file)[1]}${base.slice("rule".length)}, not ${base} — rename: ${file}`);
  }
  for (const m of marks) console.error(`spec-doc: ${m}`);
  return (out.size || headers.length || legacy.length || undescribed.length || noMain.length || marks.length) && values.strict ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
