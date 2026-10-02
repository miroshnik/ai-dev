#!/usr/bin/env bun
/**
 * spec-doc — документация из отчётов раннеров (JSON Vitest/Jest, JSON Playwright, JUnit XML
 * от bun test): раздел на папку tests/capabilities/<name> («Что делает система»),
 * tests/architecture/<name> («Из чего состоит») и tests/standards/<name> («Каким правилам подчиняется
 * код»). Страница — рассказ: описание <папка>.md рядом с тестами под заголовком (первый абзац — в индексе,
 * заголовки md — под заголовком папки), главный файл <name>.test.ts у всех видов (рядом <name>.e2e.ts — следом;
 * rule.test.ts — подсказка переименовать), describe →
 * раздел с прозой из своего JSDoc, тесты раздела свёрнуты в <details> со счётчиком. Разделы идут в
 * порядке главного файла, остальные файлы — следом по пути. Шапка другого файла папки в документацию
 * не идёт — скрипт называет файл, --strict даёт код 1. Исходника нет — без прозы.
 * tests/lib пропускается; тесты вне дерева попадают в раздел «Вне дерева» — это сигнал.
 *
 *   bun spec-doc.ts report.json [report2.xml …] [--root DIR] [--out docs/spec | --stdout] [--strict] [--meta .spec-meta]
 *
 * Метаданные прогона харнесса (`.spec-meta/` в корне или --meta) — код примеров и причины исключений под строкой теста.
 * Модель архитектуры (`tests/architecture/model.ts`) — страница architecture.md: схемы C4 и таблица модулей (`c4.ts`);
 * метка `<!-- spec: c4-… -->` в `<папка>.md` заменяется той же схемой. Трасса сценария (`sequence` харнесса) —
 * сиквенс-схема под его тестом или там, где в `<папка>.md` стоит `<!-- spec: sequence-<id> -->`.
 *
 * Вывод по умолчанию — docs/spec/: README.md (индекс), architecture.md, capabilities/<name>.md, architecture/<name>.md,
 * standards/<name>.md; свои устаревшие файлы (с маркером) удаляет. Запуск — Bun или Node ≥ 22.18, без зависимостей.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { Model } from "./architecture.ts";
import * as C4 from "./c4.ts";
import type { Call } from "./harness.ts";
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
  return mainRank(file) < 2;
}

/**
 * Место файла в рассказе папки: 0 — `<name>.test.*` (утверждения юнитов), 1 — другой `<name>.*` (`.e2e.ts`),
 * 2 — остальные. Рядом `<name>.e2e.ts` и `<name>.test.ts` — страницу открывают юниты, e2e следом: по алфавиту
 * e2e шёл бы первым.
 */
function mainRank(file: string): number {
  const [kind, name] = L.classify(file);
  if (!KINDS.includes(kind) || name === null) return 2;
  const parts = file.split("/");
  const base = parts[3]?.split(".") ?? [];
  if (parts.length !== 4 || base[0] !== name) return 2;
  return base[1] === "test" ? 0 : 1;
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
  const rank = (t: Test): string => mainRank(t.path) + t.path;
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

/** Метаданные прогона харнесса: файл теста + название → то, чего нет в названии (код примера, причина исключения). */
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
// тесты, чья схема стоит меткой в описании папки: под тестом её не повторяем
const PLACED = new Set<string>();

/** Сиквенс-схема Mermaid из трассы: участники — в порядке появления; имя, которое не идентификатор, — через `as`. */
export function sequenceLines(calls: Call[]): string[] {
  const ids = new Map<string, string>();
  for (const c of calls) for (const n of [c.from, c.to]) if (!ids.has(n)) ids.set(n, n.replace(/[^A-Za-z0-9_]/g, "_"));
  return [
    "```mermaid",
    "sequenceDiagram",
    ...[...ids].map(([n, id]) => `  participant ${id}${id === n ? "" : ` as ${n}`}`),
    // «;» и «#» Mermaid читает как разделитель и код символа
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

const LANG: Record<string, string> = { ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx" };

/** Под строкой теста: путь и код примера, задача и причина исключения, отключения правил в файле. */
function metaLines(t: Test): string[] {
  const m = META.get(t.path + "\0" + t.name);
  if (!m) return [];
  const out: string[] = [];
  if (m.code !== undefined) {
    if (m.path) out.push(`  \`${m.path}\``);
    out.push("  ```" + (LANG[(m.path ?? "").split(".").pop() ?? ""] ?? ""), ...m.code.split("\n").map((l) => (l ? "  " + l : "")), "  ```");
  }
  if (m.issue !== undefined) out.push(`  > #${m.issue} — ${m.reason ?? ""}`);
  else if (m.reason) out.push(`  > ${m.reason}`); // вне охвата — причина без задачи: это решение, а не долг
  const codeFile = /^исключения в (.+?): /.exec(t.name)?.[1] ?? "";
  for (const d of m.disables ?? []) out.push(`  > \`${codeFile}:${d.line}\` ${d.rules.join(", ") || "все правила"} — ${d.description || "без причины"}`);
  if (m.sequence?.length && !PLACED.has(t.path + "\0" + t.name)) out.push(...sequenceLines(m.sequence).map((l) => "  " + l));
  return out;
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

/** Первый абзац описания группы (не заголовок, не схема и не таблица) одной строкой — описание в индексе. */
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
  const lines = ["", "## Вне дерева", "", `Тесты без дома в ${homes.slice(0, -1).join(", ")} и ${homes.at(-1)} — перенести:`, ""];
  for (const file of [...out.keys()].sort()) lines.push(`- \`${file}\` — ${testsWord(out.get(file)!.length)}`);
  return lines;
}

/** Исключение для старого названия, которое ещё не утверждение (`src` — его файл): `--strict` его пропускает, пока файл есть. */
type NameException = L.NameException & { src: string };
// исключения, которые сейчас действуют (название всё ещё не утверждение): долг, видный в оглавлении
let NAME_DEBT: NameException[] = [];

function debtSection(): string[] {
  if (!NAME_DEBT.length) return [];
  const lines = ["", "## Названия — не утверждения (исключения)", ""];
  for (const x of NAME_DEBT) lines.push(`- «${L.mdText(x.name)}» — \`${x.file}\` — #${x.issue} ${L.mdText(x.reason)}`);
  return lines;
}

/** Страница архитектуры — рядом с README, первая строка раздела «Из чего состоит». */
const ARCH_PAGE = "architecture.md";

function renderIndex(groups: Map<string, Group>, out: Map<string, Test[]>, model: Model | null): string {
  const lines = [MARK, "# Спецификация", "", INTRO];
  for (const kind of KINDS) {
    const names = groupNames(groups, kind);
    const page = kind === "architecture" && model;
    // ни модели, ни правил архитектуры в проекте может не быть вовсе — тогда раздела нет, а не «— нет.»
    if (!names.length && !page && kind === "architecture") continue;
    lines.push("", `## ${SECTION[kind]}`, "");
    if (page) lines.push(`- [Архитектура](${ARCH_PAGE}) — ${C4.modelSummary(model)}`);
    if (!names.length && !page) lines.push("— нет.");
    for (const n of names) lines.push(indexLine(groups.get(kind + "/" + n)!));
  }
  lines.push(...debtSection(), ...outSection(out));
  return lines.join("\n") + "\n";
}

/** Страница архитектуры: схемы и таблица из модели, затем правила, которые сверяют модель с кодом. */
function renderArchitecture(groups: Map<string, Group>, model: Model): string {
  const lines = [MARK, ...C4.architecturePage(model, 1), "## Правила", ""];
  const names = groupNames(groups, "architecture");
  if (!names.length) lines.push("— нет.");
  for (const n of names) lines.push(indexLine(groups.get("architecture/" + n)!));
  return lines.join("\n") + "\n";
}

function renderStdout(groups: Map<string, Group>, out: Map<string, Test[]>, model: Model | null): string {
  const lines = [MARK, "# Спецификация", "", INTRO];
  for (const kind of KINDS) {
    const names = groupNames(groups, kind);
    const page = kind === "architecture" && model;
    if (!names.length && !page && kind === "architecture") continue;
    lines.push("", `## ${SECTION[kind]}`, "");
    if (page) lines.push(...C4.architecturePage(model, 3));
    if (!names.length && !page) lines.push("— нет.");
    for (const n of names) lines.push(renderGroup(groups.get(kind + "/" + n)!, 3).trimEnd(), "");
  }
  lines.push(...debtSection(), ...outSection(out));
  return lines.join("\n").trimEnd() + "\n";
}

/** Свой сгенерированный файл (маркер в первой строке) — его можно удалить; чужой — нет. */
const isOwn = (file: string): boolean => readFileSync(file, "utf8").split("\n", 1)[0] === MARK;

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
    // модель убрали — её страница устарела
    unlinkSync(arch);
    removed.push(ARCH_PAGE);
  }
  for (const g of groups.values()) {
    const rel = path.join(SUBDIR[g.kind]!, g.name + ".md");
    const full = path.join(outDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, MARK + "\n" + renderGroup(g, 1));
    generated.add(rel);
  }
  writeFileSync(path.join(outDir, "README.md"), renderIndex(groups, out, model));
  // все тесты дерева по отчёту — база для spec-diff: тестов харнесса в исходниках не видно, в отчёте — видно
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
        // свой устаревший файл; чужой не трогаем
        unlinkSync(path.join(d, fn));
        removed.push(rel);
      }
    }
  }
  return { generated, removed };
}

/** Модель архитектуры проекта — одна, на этом месте. */
const MODEL = `${L.TESTS}/architecture/model.ts`;

/** Модель из `tests/architecture/model.ts` (export default); файла нет — null, не загружается — ошибка с причиной. */
async function loadModel(root: string): Promise<Model | null> {
  const file = path.join(root, MODEL);
  if (!existsSync(file)) return null;
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    throw new Error(`модель ${MODEL} не загружается: ${(e as Error).message}`);
  }
  const m = mod.default as Model | undefined;
  if (!m || typeof m !== "object" || !m.modules || typeof m.modules !== "object") throw new Error(`модель ${MODEL} — нет export default с modules`);
  return m;
}

/** Метки `<!-- spec: … -->` в описаниях групп → схемы из модели; возвращает непонятые метки с файлом. */
const SEQUENCE_MARK = /^[ \t]*<!--\s*spec:\s*sequence-([\w-]+)\s*-->[ \t]*$/gm;

function embedMarks(groups: Map<string, Group>, model: Model | null): string[] {
  const problems: string[] = [];
  for (const g of groups.values()) {
    const files = new Set(g.tests.map((t) => t.path));
    g.doc = g.doc.map((d) => {
      // сценарий — по id среди тестов этой папки: схема в рассказе, под тестом её уже нет
      const withSequences = d.replace(SEQUENCE_MARK, (line, id: string) => {
        const hit = [...META].find(([k, m]) => m.id === id && m.sequence && files.has(k.split("\0")[0]!));
        if (!hit) {
          problems.push(`метка <!-- spec: sequence-${id} --> в ${descriptionPath(g)}: нет сценария ${id} в тестах папки`);
          return line;
        }
        PLACED.add(hit[0]);
        return sequenceLines(hit[1].sequence!).join("\n");
      });
      const { text, bad } = C4.embed(withSequences, model);
      for (const b of bad) {
        const mark = `<!-- spec: ${b.mark} -->`;
        problems.push(
          b.missing === "model"
            ? `метка ${mark} в ${descriptionPath(g)}: нет модели ${MODEL}`
            : `неизвестная метка ${mark} в ${descriptionPath(g)} — есть: ${[...Object.keys(C4.MARKS), "sequence-<id>"].join(", ")}`,
        );
      }
      return text;
    });
  }
  return problems;
}

/** Прежний формат исключений названий — массив в одном файле папки решения и общий файл; не читается, переносит spec-exceptions. */
const LEGACY_NAMES = /^names\.exceptions\.(ts|mts|js|mjs|json)$/;
const SHARED_NAMES = `${L.TESTS}/standards/spec-names/exceptions.ts`;
const MIGRATE = "перенеси командой spec-exceptions: node .agents/skills/spec/scripts/spec-exceptions.ts";

/** Исключения названий — файлы каталогов `names.exceptions/` в tests/; `legacy` — файлы прежнего формата. */
function findNameExceptions(root: string): { list: NameException[]; legacy: string[] } {
  const list: NameException[] = [];
  const legacy: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const at = `${rel}/${e.name}`;
      if (e.isDirectory() && e.name === L.NAMES_DIR) list.push(...readNameExceptions(root, at));
      else if (e.isDirectory()) walk(at);
      else if (LEGACY_NAMES.test(e.name) || at === SHARED_NAMES) legacy.push(at);
    }
  };
  walk(L.TESTS);
  return { list: list.sort((a, b) => a.src.localeCompare(b.src)), legacy: legacy.sort() };
}

/** Каталог `names.exceptions/`: файл на исключение — JSON `{ file, name, issue, reason }`, иное — ошибка с путём. */
function readNameExceptions(root: string, dir: string): NameException[] {
  return readdirSync(path.join(root, dir))
    .filter((n) => !n.startsWith("."))
    .map((n) => {
      const src = `${dir}/${n}`;
      if (!n.endsWith(".json")) throw new Error(`${src}: исключение названия — файл <название>.json с { file, name, issue, reason }`);
      let x: Partial<L.NameException> | null;
      try {
        x = JSON.parse(readFileSync(path.join(root, src), "utf8")) as Partial<L.NameException> | null;
      } catch (e) {
        throw new Error(`${src}: не JSON — ${(e as Error).message}`);
      }
      if (!x || typeof x.file !== "string" || typeof x.name !== "string" || !Number.isInteger(x.issue)) {
        throw new Error(`${src}: исключение названия — { file, name, issue, reason }`);
      }
      return { file: x.file, name: x.name, issue: x.issue!, reason: String(x.reason ?? ""), src };
    });
}

const USAGE =
  "spec-doc.ts report.json [report2.xml …] [--root DIR] [--out docs/spec | --stdout] [--strict] [--meta .spec-meta] [--names-baseline N]";

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
        "names-exceptions": { type: "string" },
        "names-baseline": { type: "string" },
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
  // флаг прежнего общего файла: молча пропустить его — значит потерять исключения
  if (values["names-exceptions"] !== undefined) {
    console.error(`spec-doc: --names-exceptions больше нет — исключения названий файлом в ${L.NAMES_DIR}/ папки решения: ${MIGRATE}`);
    return 2;
  }

  const root = findRoot(values.root);
  let tests: Test[] = [];
  // CI задан — отчёт обязан быть: прогон, который его не написал, иначе молча выкинет свои тесты из спеки
  const inCi = !!process.env.CI && !["0", "false"].includes(process.env.CI);
  for (const r of positionals) {
    if (!existsSync(r)) {
      console.error(`spec-doc: отчёта ${r} нет — его тесты в спеку не попали${inCi ? "" : " (локально — предупреждение, в CI — ошибка)"}`);
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
  const { missing, headers, legacy, undescribed } = attachDocs(groups, root);
  const noMain = [...groups.values()].filter((g) => !hasMain(g, root)).map(mainPath);
  // названия: старые — исключениями с задачей (файл на название в папке решения), новые нарушения и ненужные
  // исключения — ошибки
  let found;
  try {
    found = findNameExceptions(root);
  } catch (e) {
    console.error(`spec-doc: ${(e as Error).message}`);
    return 2;
  }
  let nameExceptions = found.list;
  const legacyNames = found.legacy.map((f) => `${f}: исключения названий — файл на название в ${L.NAMES_DIR}/ папки решения — ${MIGRATE}`);
  const nameKey = (file: string, name: string) => file + "\0" + name;
  const bad = badNames(groups);
  const badKeys = new Set(bad.map(([n, f]) => nameKey(f, n)));
  if (values["names-baseline"] !== undefined) {
    const issue = Number(values["names-baseline"]);
    if (!Number.isInteger(issue) || issue <= 0) {
      console.error(`spec-doc: --names-baseline — номер задачи на переписывание, а не «${values["names-baseline"]}»\n${USAGE}`);
      return 2;
    }
    // исключения прежнего файла не прочитаны: baseline записал бы их заново с новой задачей
    if (legacyNames.length) {
      for (const m of legacyNames) console.error(`spec-doc: ${m}`);
      return 2;
    }
    // ненужные — файл долой (опустевший каталог тоже), новые — файлом в папку решения своего теста
    const stale = nameExceptions.filter((x) => !badKeys.has(nameKey(x.file, x.name)));
    for (const x of stale) unlinkSync(path.resolve(root, x.src));
    for (const d of new Set(stale.map((x) => path.posix.dirname(x.src)))) if (!readdirSync(path.resolve(root, d)).length) rmdirSync(path.resolve(root, d));
    const have = new Set(nameExceptions.map((x) => nameKey(x.file, x.name)));
    const fresh = bad
      .filter(([n, f]) => !have.has(nameKey(f, n)))
      .map(([name, file]) => {
        const x = { file, name, issue, reason: `название — не утверждение; переписать в #${issue}` };
        return { ...x, src: L.writeNameException(root, L.decisionFolder(file)!, x) };
      });
    nameExceptions = [...nameExceptions.filter((x) => badKeys.has(nameKey(x.file, x.name))), ...fresh];
    console.error(`spec-doc: исключения названий (#${issue}) — добавлено ${fresh.length}, удалено ${stale.length}`);
  }
  const excepted = new Set(nameExceptions.map((x) => nameKey(x.file, x.name)));
  const names = bad.filter(([n, f]) => !excepted.has(nameKey(f, n)));
  const allNames = new Set([...groups.values()].flatMap((g) => g.tests.flatMap((t) => [...t.describes, t.name].map((n) => nameKey(t.path, n)))));
  NAME_DEBT = nameExceptions.filter((x) => badKeys.has(nameKey(x.file, x.name)));
  const home = (x: NameException) => L.decisionFolder(x.file);
  const staleNames = [
    ...nameExceptions
      .filter((x) => !badKeys.has(nameKey(x.file, x.name)))
      .map((x) => `исключение названия «${x.name}» (${x.file}) не нужно — ${allNames.has(nameKey(x.file, x.name)) ? "уже утверждение" : "теста нет"}, удали ${x.src}`),
    // исключение папки — только для её тестов: иначе владелец папки снимает чужой долг
    ...nameExceptions
      .filter((x) => home(x) !== null && home(x) !== path.posix.dirname(path.posix.dirname(x.src)))
      .map((x) => `исключение названия «${x.name}» (${x.file}) — не в папке своего теста: перенеси ${x.src} в ${home(x)}/${L.NAMES_DIR}/`),
    ...legacyNames,
  ];
  const marks = embedMarks(groups, model);

  if (values.stdout) {
    process.stdout.write(renderStdout(groups, out, model));
  } else {
    const outDir = path.isAbsolute(values.out) ? values.out : path.join(root, values.out);
    const { generated, removed } = writeFiles(groups, out, outDir, model);
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
  for (const m of staleNames) console.error(`spec-doc: ${m}`);
  if (NAME_DEBT.length) console.error(`spec-doc: названий в исключениях — ${NAME_DEBT.length}`);
  for (const file of headers) {
    const [kind, name] = L.classify(file);
    console.error(`spec-doc: шапка файла в документацию не идёт — перенеси в ${descriptionPath({ kind, name: name! })}: ${file}`);
  }
  for (const file of legacy) {
    const base = path.posix.basename(file);
    console.error(`spec-doc: главный файл папки — ${L.classify(file)[1]}${base.slice("rule".length)}, а не ${base} — переименуй: ${file}`);
  }
  for (const m of marks) console.error(`spec-doc: ${m}`);
  return (out.size || headers.length || legacy.length || undescribed.length || noMain.length || names.length || staleNames.length || marks.length) && values.strict ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
