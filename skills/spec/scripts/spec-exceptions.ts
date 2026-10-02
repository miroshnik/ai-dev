#!/usr/bin/env bun
/**
 * spec-exceptions — перенос исключений в формат «файл на элемент»: каждый `exceptions.ts` (`.mts`, `.js`, `.mjs`,
 * `.json`) папки решения в `tests/` раскладывается в каталог `exceptions/` рядом — файл `<элемент>.json` на
 * исключение (`{ item, rule?, issue, reason }`), старый файл удаляется. Импорт в файлах папки
 * (`import exceptions from "./exceptions.ts"`) становится `const exceptions = exceptionsIn()` харнесса, путь к старому
 * файлу в `package.json` и workflow CI (`spec-claims --exceptions`) — путём к каталогу. Чего не переписать (ссылка из
 * другой папки, нет импорта харнесса) — строка `!`. Исключения названий spec-doc (`{ file, name }`) не переносятся —
 * у них свой формат. Повторный запуск ничего не меняет.
 *
 *   bun spec-exceptions.ts [--root DIR]
 *
 * Коды: 0 — перенесено или переносить нечего, 1 — осталось поправить руками, 2 — ошибка вызова или файла исключений.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { TESTS } from "./speclib.ts";

const USAGE = "spec-exceptions.ts [--root DIR]";
const LEGACY = /^exceptions\.(ts|mts|js|mjs|json)$/;
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "exceptions"]);

interface Entry {
  item: string;
  rule?: string;
  issue: number;
  reason: string;
}

/** Файлы под каталогом (от корня проекта), по порядку; каталоги исключений и зависимостей — мимо. */
function walk(root: string, rel: string): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((e) => (e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(root, `${rel}/${e.name}`)) : [`${rel}/${e.name}`]))
    .sort();
}

/** Список исключений из прежнего файла: JSON — разбор, модуль — `default` (или `exceptions`). */
async function loadLegacy(abs: string): Promise<unknown> {
  if (abs.endsWith(".json")) return JSON.parse(readFileSync(abs, "utf8"));
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown; exceptions?: unknown };
  return mod.default ?? mod.exceptions;
}

/** Имя файла исключения — элемент (и соглашение) латиницей: стабильно, видно в дереве и в диффе. */
const slug = (e: Entry): string =>
  ((e.rule ? `${e.rule}--` : "") + e.item)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 100) || "exception";

const json = (e: Entry): string =>
  JSON.stringify({ item: e.item, ...(e.rule ? { rule: e.rule } : {}), issue: e.issue, reason: e.reason }, null, 2) + "\n";

// import x from "./exceptions.ts" · import { exceptions } from … · import { exceptions as x } from … (+ with { type })
const IMPORT = /^import\s+(?:(\w+)|\{\s*(\w+)(?:\s+as\s+(\w+))?\s*\})\s+from\s+(["'])([^"']+)\4(?:\s+with\s*\{[^}]*\})?\s*;?[ \t]*\n?/gm;
const ANY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\1/g;
const HARNESS = /^import\s*\{([^}]*)\}\s*from\s*(["'])([^"']*\/harness(?:\.ts)?)\2/m;
const HARNESS_TYPE = /^import\s+type\s*\{[^}]*\}\s*from\s*(["'])([^"']*\/harness(?:\.ts)?)\1\s*;?[ \t]*\n/m;

/** Путь импорта из файла указывает на прежний файл исключений (с расширением или без). */
function pointsTo(fromFile: string, spec: string, legacy: string): boolean {
  if (!spec.startsWith(".")) return false;
  const target = path.posix.join(path.posix.dirname(fromFile), spec);
  return target === legacy || target === legacy.replace(/\.[^./]+$/, "");
}

/** Конец последнего оператора import в начале файла — после его строки. */
function afterImports(text: string): number {
  let end = 0;
  let open = false;
  let at = 0;
  for (const line of text.split("\n")) {
    const next = at + line.length + 1;
    if (!open && /^import\b/.test(line)) open = true;
    if (open && (/\bfrom\s*["'][^"']+["']/.test(line) || /^import\s*["'][^"']+["']/.test(line))) {
      open = false;
      end = Math.min(next, text.length);
    }
    at = next;
  }
  return end;
}

/** Добавить `exceptionsIn` в импорт харнесса: в список значений, иначе рядом с импортом типов; нет ни того ни другого — null. */
function withHarnessImport(text: string): string | null {
  const m = HARNESS.exec(text);
  if (m) {
    const names = m[1]!.split(",").map((x) => x.trim()).filter(Boolean);
    if (names.includes("exceptionsIn")) return text;
    const sorted = names.every((x, i) => i === 0 || names[i - 1]! <= x);
    const all = sorted ? [...names, "exceptionsIn"].sort() : [...names, "exceptionsIn"];
    const indent = /\n([ \t]+)\S/.exec(m[1]!)?.[1];
    const list = indent !== undefined ? `{\n${all.map((x) => `${indent}${x},`).join("\n")}\n}` : `{ ${all.join(", ")} }`;
    return text.slice(0, m.index) + `import ${list} from ${m[2]}${m[3]}${m[2]}` + text.slice(m.index + m[0].length);
  }
  const t = HARNESS_TYPE.exec(text);
  if (t) {
    const at = t.index + t[0].length;
    return text.slice(0, at) + `import { exceptionsIn } from ${t[1]}${t[2]}${t[1]};\n` + text.slice(at);
  }
  return null;
}

export async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { root: { type: "string" }, help: { type: "boolean", short: "h", default: false } } }));
  } catch (e) {
    console.error(`spec-exceptions: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.error(USAGE);
    return 0;
  }
  const root = path.resolve(values.root ?? ".");
  const files = walk(root, TESTS);
  const legacy = files.filter((f) => LEGACY.test(path.posix.basename(f)));
  const out: string[] = [];
  const manual: string[] = [];
  const moved: string[] = [];

  for (const rel of legacy) {
    let list: unknown;
    try {
      list = await loadLegacy(path.join(root, rel));
    } catch (e) {
      console.error(`spec-exceptions: ${rel} не загружается: ${(e as Error).message}`);
      return 2;
    }
    if (!Array.isArray(list)) {
      console.error(`spec-exceptions: ${rel} — нужен export default [{ item, issue, reason }]`);
      return 2;
    }
    if (list.length && list.every((x) => x && typeof x === "object" && typeof x.item !== "string" && typeof x.name === "string")) {
      out.push(`○ ${rel}: исключения названий spec-doc — не переносятся`);
      continue;
    }
    const bad = list.findIndex((x) => !x || typeof x !== "object" || typeof x.item !== "string");
    if (bad >= 0) {
      console.error(`spec-exceptions: ${rel}: пункт ${bad + 1} — не исключение { item, issue, reason }`);
      return 2;
    }
    const folder = path.posix.dirname(rel);
    const dir = `${folder}/exceptions`;
    const written: string[] = [];
    for (const e of list as Entry[]) {
      const body = json(e);
      let name = slug(e);
      // имя занято другим исключением — суффикс; тот же текст — уже перенесено
      for (let n = 2; existsSync(path.join(root, dir, `${name}.json`)) && readFileSync(path.join(root, dir, `${name}.json`), "utf8") !== body; n++) {
        name = `${slug(e)}-${n}`;
      }
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, `${name}.json`), body);
      written.push(`${dir}/${name}.json`);
    }
    rmSync(path.join(root, rel));
    moved.push(rel);
    out.push(`- ${rel} → ${dir}/ (${written.length})`, ...written.map((w) => `+ ${w}`));

    // импорт в файлах папки — на exceptionsIn(): каталог папки теста харнесс находит сам
    for (const file of files.filter((f) => f.startsWith(`${folder}/`) && CODE.test(f) && f !== rel)) {
      const text = readFileSync(path.join(root, file), "utf8");
      const names: string[] = [];
      const rest = text.replace(IMPORT, (all, def: string | undefined, named: string | undefined, alias: string | undefined, _q: string, spec: string) => {
        if (!pointsTo(file, spec, rel)) return all;
        if (named !== undefined && named !== "exceptions" && named !== "default") return all;
        names.push(def ?? alias ?? named!);
        return "";
      });
      const name = names[0];
      if (name === undefined) continue;
      const at = afterImports(rest);
      const next = withHarnessImport(rest.slice(0, at) + `\nconst ${name} = exceptionsIn();\n` + rest.slice(at));
      if (next === null) {
        manual.push(`! ${file}: импорт ${rel} не заменён — нет импорта харнесса, добавь import { exceptionsIn } и const ${name} = exceptionsIn()`);
        continue;
      }
      writeFileSync(path.join(root, file), next);
      out.push(`~ ${file}: импорт → exceptionsIn()`);
    }
  }

  // путь к прежнему файлу в скриптах проекта и CI (spec-claims --exceptions) — путём к каталогу
  const configs = ["package.json", ...walk(root, ".github/workflows").filter((f) => /\.ya?ml$/.test(f))];
  for (const file of configs.filter((f) => existsSync(path.join(root, f)))) {
    let text = readFileSync(path.join(root, file), "utf8");
    for (const rel of moved) {
      const re = new RegExp(`(?<![\\w./-])${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`, "g");
      if (!re.test(text)) continue;
      const dir = `${path.posix.dirname(rel)}/exceptions`;
      text = text.replace(re, dir);
      writeFileSync(path.join(root, file), text);
      out.push(`~ ${file}: ${rel} → ${dir}`);
    }
  }

  // ссылки на перенесённые файлы, которые команда не переписала, — руками
  for (const file of walk(root, TESTS).filter((f) => CODE.test(f))) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(ANY_IMPORT)) {
      const rel = moved.find((l) => pointsTo(file, m[2]!, l));
      if (rel) manual.push(`! ${file}: ссылка на ${rel} — замени на exceptionsIn("${path.posix.dirname(rel)}") харнесса`);
    }
  }

  if (!moved.length) out.push("exceptions.ts в папках решений нет — переносить нечего");
  for (const l of [...out, ...manual]) console.log(l);
  return manual.length ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
