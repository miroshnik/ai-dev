#!/usr/bin/env bun
/**
 * spec-doc — документация из отчётов раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML
 * от bun test): раздел на папку tests/capabilities/<name> («Что делает система»),
 * tests/architecture/<name> («Из чего состоит») и tests/standards/<name> («Каким правилам подчиняется
 * код»). Страница — рассказ: описание <папка>.md рядом с тестами под заголовком (первый абзац — в индексе,
 * заголовки md — под заголовком папки), главный файл <name>.test.ts у всех видов (rule.test.ts — подсказка
 * переименовать), describe →
 * раздел с прозой из своего JSDoc, тесты раздела свёрнуты в <details> со счётчиком. Разделы идут в
 * порядке главного файла, остальные файлы — следом по пути. Шапка другого файла папки в документацию
 * не идёт — скрипт называет файл, --strict даёт код 1. Исходника нет — без прозы.
 * tests/lib пропускается; тесты вне дерева попадают в раздел «Вне дерева» — это сигнал.
 *
 *   bun spec-doc.ts report.json [report2.xml …] [--root DIR] [--out docs/spec | --stdout] [--strict]
 *
 * Вывод по умолчанию — docs/spec/: README.md (индекс), capabilities/<name>.md, architecture/<name>.md,
 * standards/<name>.md; свои устаревшие файлы (с маркером) удаляет. Запуск — Bun, без зависимостей.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import * as L from "./speclib.ts";
import type { Kind, Test } from "./speclib.ts";

export const MARK = "<!-- spec-doc: сгенерировано из названий тестов, руками не править -->";
const ICON: Record<string, string> = { passed: "✅", failed: "❌", skipped: "⏭️", todo: "📝" };
// порядок разделов — вопросы читателя: что делает, из чего состоит, каким правилам подчиняется код
const KINDS: Kind[] = ["capability", "architecture", "standard"];
const SECTION: Record<string, string> = {
  capability: "Что делает система",
  architecture: "Из чего состоит",
  standard: "Каким правилам подчиняется код",
};
const SUBDIR: Record<string, string> = { capability: "capabilities", architecture: "architecture", standard: "standards" };
const INTRO =
  "Сгенерировано из дерева `tests/`, названий тестов и их JSDoc (скилл `spec`, `spec-doc`). Руками не править: правка — в тестах.";

// doc — абзацы прозы из JSDoc: у группы — шапка главного файла, у describe из нескольких файлов —
// по порядку файлов (главный первым), повтор один раз
type Node = { tests: Test[]; children: Map<string, Node>; doc: string[] };
type Group = { kind: Kind; name: string; tests: Test[]; tree: Node; doc: string[]; testDocs: Map<string, string[]> };

const plural = L.plural;
const testsWord = L.testsWord;

/** Пропущенные и падающие — то, что стоит заметить; пусто, если всё зелёное. */
function problemsLine(tests: Test[]): string {
  const parts: string[] = [];
  const sk = tests.filter((t) => t.status === "skipped" || t.status === "todo").length;
  const fl = tests.filter((t) => t.status === "failed").length;
  if (sk) parts.push(plural(sk, "пропущен", "пропущено", "пропущено"));
  if (fl) parts.push(plural(fl, "падает", "падают", "падают"));
  return parts.join(", ");
}

function countsLine(tests: Test[]): string {
  return [testsWord(tests.length), problemsLine(tests)].filter(Boolean).join(", ");
}

function findRoot(root?: string): string {
  if (root) return path.resolve(root);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return top;
  } catch {
    /* не git-репозиторий — текущий каталог */
  }
  return process.cwd();
}

const newNode = (): Node => ({ tests: [], children: new Map(), doc: [] });
const testKey = (t: Test): string => JSON.stringify([...t.describes, t.name]);

/**
 * Главный файл папки (`<name>.test.ts`, `<name>.e2e.ts`…) — в нём рассказ, с него начинается страница. Имя —
 * имя папки у всех видов: одно правило вместо особого `rule.test.ts` у стандарта.
 */
function isMain(file: string): boolean {
  const [kind, name] = L.classify(file);
  if (!KINDS.includes(kind) || name === null) return false;
  const parts = file.split("/");
  return parts.length === 4 && parts[3]!.split(".")[0] === name;
}

/** Прежний главный файл стандарта `rule.*` прямо в папке: теперь не главный — его надо переименовать. */
function isLegacyMain(file: string): boolean {
  const [kind, name] = L.classify(file);
  const parts = file.split("/");
  return (kind === "standard" || kind === "architecture") && name !== "rule" && parts.length === 4 && parts[3]!.split(".")[0] === "rule";
}

/** → группы по (вид, имя), тесты вне дерева по файлам, файлы tests/lib. */
export function build(tests: Test[]): { groups: Map<string, Group>; out: Map<string, Test[]>; libFiles: Set<string> } {
  const groups = new Map<string, Group>();
  const out = new Map<string, Test[]>();
  const libFiles = new Set<string>();
  // главный файл папки первым — порядок его describe и есть порядок рассказа; дальше файлы по пути;
  // внутри файла — порядок отчёта (порядок объявления)
  const rank = (t: Test): string => (isMain(t.path) ? "0" : "1") + t.path;
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

/** Главный файл папки, которого ждём, если в отчёте его нет: `<папка>.test.ts`. */
const mainPath = (g: { kind: Kind; name: string }): string => `${L.TESTS}/${SUBDIR[g.kind]}/${g.name}/${g.name}.test.ts`;

/** У группы есть главный файл: в отчёте или на диске (`<папка>.<что угодно>` с тестовым суффиксом). */
function hasMain(g: Group, root: string): boolean {
  if (g.tests.some((t) => isMain(t.path))) return true;
  try {
    return readdirSync(path.join(root, L.TESTS, SUBDIR[g.kind]!, g.name)).some((f) => L.isTestFile(f) && f.split(".")[0] === g.name);
  } catch {
    return false;
  }
}

/**
 * Название — утверждение по-русски: в нём есть русские слова. Идентификатор (camelCase, snake_case), имя функции
 * или файла, английская фраза — не утверждение: читатель спеки не узнает из него, что система делает.
 */
export const isStatement = (name: string): boolean => /[А-Яа-яЁё]/.test(name.replace(/`[^`]*`/g, ""));

/** Названия describe и it, которые не утверждения, — по файлу, без повторов. */
function badNames(groups: Map<string, Group>): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const g of groups.values()) {
    for (const t of g.tests) {
      for (const n of [...t.describes, t.name]) {
        const k = t.path + "\0" + n;
        if (seen.has(k) || isStatement(n)) continue;
        seen.add(k);
        out.push([n, t.path]);
      }
    }
  }
  return out;
}

/** Описание решения — `<папка>.md` рядом с тестами папки, путь от корня. */
export const descriptionPath = (g: { kind: Kind; name: string }): string => `${L.TESTS}/${SUBDIR[g.kind]}/${g.name}/${g.name}.md`;

/**
 * Проза группы: вступление — `<папка>.md` (зачем, причина, отвергнутое), describe и it — их JSDoc из исходников
 * (отчёты комментариев не несут). Describe без тестов в отчёте (имя из it.each с подстановкой) прозу теряет.
 * Возвращает файлы, которых нет на диске (они без прозы), папки без описания, файлы тестов с шапкой — рассказ
 * пишется в одном месте, шапка файла в документацию не идёт, — и прежние главные `rule.*`, которые надо переименовать.
 */
export function attachDocs(
  groups: Map<string, Group>,
  root: string,
): { missing: string[]; headers: string[]; legacy: string[]; undescribed: string[] } {
  const missing: string[] = [];
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
    // порядок файлов — как в build: главный первым
    for (const file of [...new Set(g.tests.map((t) => t.path))]) {
      if (isLegacyMain(file)) legacy.push(file);
      let source: string;
      try {
        source = readFileSync(path.join(root, file), "utf8");
      } catch {
        missing.push(file);
        continue;
      }
      const docs = L.parseDocs(file, source);
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
  return { missing, headers, legacy, undescribed };
}

function testLine(t: Test): string {
  let line = `- ${ICON[t.status] ?? "❔"} ${L.mdText(t.name)}`;
  if (t.status === "skipped") line += t.reason ? ` — пропущен: ${L.mdText(t.reason)}` : " — пропущен";
  else if (t.status === "failed") line += " — падает";
  else if (t.status === "todo") line += " — todo";
  if (t.variants > 1) line += ` (${plural(t.variants, "вариант", "варианта", "вариантов")})`;
  return line;
}

const heading = (level: number, text: string) => "#".repeat(Math.min(level, 6)) + " " + text;

/** Абзацы прозы под заголовком; пусто — ничего. */
function pushDoc(lines: string[], doc: string[]): void {
  if (doc.length) lines.push(doc.join("\n\n"), "");
}

/**
 * Тесты раздела — свёрнутым блоком со счётчиком: рассказ читается заголовками и прозой, проверку
 * открывают по клику. Есть пропущенные или падающие — они в строке-заголовке, блок раскрыт.
 * Проза теста — цитатой внутри пункта списка: список остаётся плотным, строка теста — строкой.
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

/** Markdown описания под заголовком папки уровня level: его заголовки сдвигаются на level − 1 (кроме блоков кода). */
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
 * Заголовок группы на уровне level, под ним описание, describe — глубже. Строки «раздел · путь ·
 * счётчик» нет: раздел и путь следуют из конвенции, статус виден у каждого теста.
 */
function renderGroup(g: Group, level: number): string {
  const lines = [heading(level, g.name), ""];
  pushDoc(lines, g.doc.map((d) => shiftHeadings(d, level)));
  renderNode(g, g.tree, level + 1, lines);
  return lines.join("\n").trimEnd() + "\n";
}

/** Первый абзац описания группы (не заголовок) одной строкой — описание в индексе. */
function summaryOf(g: Group): string {
  const first = (g.doc[0] ?? "").split("\n\n").find((p) => p.trim() && !/^#{1,6}\s/.test(p.trim())) ?? "";
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
  const lines = ["", "## Вне дерева", "", `Тесты без дома в ${homes.slice(0, -1).join(", ")} и ${homes.at(-1)} — перенести:`, ""];
  for (const file of [...out.keys()].sort()) lines.push(`- \`${file}\` — ${testsWord(out.get(file)!.length)}`);
  return lines;
}

function renderIndex(groups: Map<string, Group>, out: Map<string, Test[]>): string {
  const lines = [MARK, "# Спецификация", "", INTRO];
  for (const kind of KINDS) {
    const names = groupNames(groups, kind);
    // правил архитектуры в проекте может не быть вовсе — тогда раздела нет, а не «— нет.»
    if (!names.length && kind === "architecture") continue;
    lines.push("", `## ${SECTION[kind]}`, "");
    if (!names.length) lines.push("— нет.");
    for (const n of names) lines.push(indexLine(groups.get(kind + "/" + n)!));
  }
  lines.push(...outSection(out));
  return lines.join("\n") + "\n";
}

function renderStdout(groups: Map<string, Group>, out: Map<string, Test[]>): string {
  const lines = [MARK, "# Спецификация", "", INTRO];
  for (const kind of KINDS) {
    const names = groupNames(groups, kind);
    if (!names.length && kind === "architecture") continue;
    lines.push("", `## ${SECTION[kind]}`, "");
    if (!names.length) lines.push("— нет.");
    for (const n of names) lines.push(renderGroup(groups.get(kind + "/" + n)!, 3).trimEnd(), "");
  }
  lines.push(...outSection(out));
  return lines.join("\n").trimEnd() + "\n";
}

function writeFiles(groups: Map<string, Group>, out: Map<string, Test[]>, outDir: string): { generated: Set<string>; removed: string[] } {
  const generated = new Set<string>();
  for (const g of groups.values()) {
    const rel = path.join(SUBDIR[g.kind]!, g.name + ".md");
    const full = path.join(outDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, MARK + "\n" + renderGroup(g, 1));
    generated.add(rel);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "README.md"), renderIndex(groups, out));
  const removed: string[] = [];
  for (const sub of Object.values(SUBDIR)) {
    const d = path.join(outDir, sub);
    if (!existsSync(d)) continue;
    for (const fn of readdirSync(d).sort()) {
      const rel = path.join(sub, fn);
      if (!fn.endsWith(".md") || generated.has(rel)) continue;
      const first = readFileSync(path.join(d, fn), "utf8").split("\n", 1)[0];
      if (first === MARK) {
        // свой устаревший файл; чужой не трогаем
        unlinkSync(path.join(d, fn));
        removed.push(rel);
      }
    }
  }
  return { generated, removed };
}

const USAGE = "spec-doc.ts report.json [report2.xml …] [--root DIR] [--out docs/spec | --stdout] [--strict]";

export function main(argv: string[]): number {
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
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-doc: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = opts;
  if (values.help || !positionals.length) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }

  const root = findRoot(values.root);
  let tests: Test[] = [];
  for (const r of positionals) {
    try {
      tests.push(...L.loadReport(r, root));
    } catch (e) {
      console.error(`spec-doc: ${(e as Error).message}`);
      return 2;
    }
  }
  tests = L.mergeTests(tests);
  const { groups, out, libFiles } = build(tests);
  const { missing, headers, legacy, undescribed } = attachDocs(groups, root);
  const noMain = [...groups.values()].filter((g) => !hasMain(g, root)).map(mainPath);
  const names = badNames(groups);

  if (values.stdout) {
    process.stdout.write(renderStdout(groups, out));
  } else {
    const outDir = path.isAbsolute(values.out) ? values.out : path.join(root, values.out);
    const { generated, removed } = writeFiles(groups, out, outDir);
    for (const rel of removed) console.error(`spec-doc: удалён устаревший ${path.join(values.out, rel)}`);
    console.error(`spec-doc: ${values.out}: README.md + ${generated.size} файлов`);
  }

  const nCap = groupNames(groups, "capability").length;
  const nArch = groupNames(groups, "architecture").length;
  const nStd = groupNames(groups, "standard").length;
  const inTree = [...groups.values()].flatMap((g) => g.tests);
  const outN = [...out.values()].reduce((s, v) => s + v.length, 0);
  console.error(
    `spec-doc: capabilities ${nCap}, architecture ${nArch}, standards ${nStd}, ${countsLine(inTree)}; ${L.TESTS}/lib пропущено файлов: ${libFiles.size}; вне дерева: ${outN} в ${out.size} файлах`,
  );
  for (const file of [...out.keys()].sort()) console.error(`spec-doc: вне дерева: ${file} (${testsWord(out.get(file)!.length)})`);
  if (missing.length) console.error(`spec-doc: нет исходников (${missing.length}) — проза из JSDoc не взята: ${missing.join(", ")}`);
  for (const file of undescribed) console.error(`spec-doc: нет описания ${file} — зачем, причина, отвергнутое`);
  for (const file of noMain) console.error(`spec-doc: нет главного файла ${file} — его describe открывают страницу`);
  for (const [name, file] of names) console.error(`spec-doc: название — не утверждение по-русски: «${name}» (${file})`);
  for (const file of headers) {
    const [kind, name] = L.classify(file);
    console.error(`spec-doc: шапка файла в документацию не идёт — перенеси в ${descriptionPath({ kind, name: name! })}: ${file}`);
  }
  for (const file of legacy) {
    const base = path.posix.basename(file);
    console.error(`spec-doc: главный файл папки — ${L.classify(file)[1]}${base.slice("rule".length)}, а не ${base} — переименуй: ${file}`);
  }
  return (out.size || headers.length || legacy.length || undescribed.length || noMain.length || names.length) && values.strict ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
