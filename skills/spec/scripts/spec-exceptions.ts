#!/usr/bin/env bun
/**
 * spec-exceptions — moving exceptions to the "file per item" format: each `exceptions.ts` (`.mts`, `.js`, `.mjs`,
 * `.json`) of a decision folder `tests/<kind>/<name>` or its subfolder is split into the decision folder's
 * `exceptions/` directory — a `<item>.json` file per exception (`{ item, rule?, issue, reason }`), the old file is
 * deleted; which file belongs where — the `exceptionFile` rule (speclib). The import in the folder's files
 * (`import exceptions from "./exceptions.ts"`) becomes the harness's `const exceptions = exceptionsIn()`, the path to the
 * old file in `package.json` and the CI workflow (`spec-claims --exceptions`) — the path to the directory. What can't be
 * rewritten (a reference from another folder, no harness import) — a `!` line. spec-doc name exceptions
 * (`{ file, name }`) — an array in the folder's `names.exceptions.ts`, the shared
 * `tests/standards/spec-names/exceptions.ts` or the `--names-exceptions` file from `package.json` and the CI workflow —
 * are split into the `names.exceptions/` directories of their tests' decision folders (a `<name>.json` file), the
 * `--names-exceptions` flag is removed. A repeated run changes nothing.
 *
 *   bun spec-exceptions.ts [--root DIR]
 *
 * Codes: 0 — moved or nothing to move, 1 — something is left to fix by hand, 2 — a call error or a bad exceptions file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { decisionFolder, EXCEPTIONS_DIR, exceptionFile, NAMES_DIR, type NameException, TESTS, writeNameException } from "./speclib.ts";

const USAGE = "spec-exceptions.ts [--root DIR]";
// the flag of the former shared spec-doc name exceptions file in the project's scripts and CI: `--names-exceptions <path>`
const NAMES_FLAG = /[ \t]+--names-exceptions(?:=|[ \t]+)([^\s"']+)/g;
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", EXCEPTIONS_DIR, NAMES_DIR]);

interface Entry {
  item: string;
  rule?: string;
  issue: number;
  reason: string;
}

/** Files under the directory (from the project root), in order; exception and dependency directories are skipped. */
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

/** The exceptions list from the former file: JSON — parsed, a module — `default` (or `exceptions`). */
async function loadLegacy(abs: string): Promise<unknown> {
  if (abs.endsWith(".json")) return JSON.parse(readFileSync(abs, "utf8"));
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown; exceptions?: unknown };
  return mod.default ?? mod.exceptions;
}

/** The exception file's name is the item (and the convention) in Latin letters: stable, visible in the tree and in the diff. */
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

/** The import path from the file points to the former exceptions file (with or without the extension). */
function pointsTo(fromFile: string, spec: string, legacy: string): boolean {
  if (!spec.startsWith(".")) return false;
  const target = path.posix.join(path.posix.dirname(fromFile), spec);
  return target === legacy || target === legacy.replace(/\.[^./]+$/, "");
}

/** The end of the last import statement at the start of the file — after its line. */
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

/** Add `exceptionsIn` to the harness import: to the value list, otherwise next to the type import; neither — null. */
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
  // former files — by the exceptionFile rule: in the decision folder or its subfolder, they move to the decision folder's directory
  const legacyOf = (f: string) => {
    const x = exceptionFile(f);
    return x?.legacy ? x : null;
  };
  const legacy = files.filter((f) => legacyOf(f)?.dir === EXCEPTIONS_DIR);
  const configs = ["package.json", ...walk(root, ".github/workflows").filter((f) => /\.ya?ml$/.test(f))].filter((f) => existsSync(path.join(root, f)));
  // name exceptions: the folders' files, the shared file (it is also exceptions.ts — below, by its contents) and the ones named by the flag
  const flagged = configs.flatMap((f) => [...readFileSync(path.join(root, f), "utf8").matchAll(NAMES_FLAG)].map((m) => m[1]!));
  const names = [...new Set([...files.filter((f) => legacyOf(f)?.dir === NAMES_DIR), ...flagged.filter((f) => existsSync(path.join(root, f)))])];
  const out: string[] = [];
  const manual: string[] = [];
  const moved: string[] = [];
  const movedNames: string[] = [];

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
      if (!names.includes(rel)) names.push(rel);
      continue;
    }
    const bad = list.findIndex((x) => !x || typeof x !== "object" || typeof x.item !== "string");
    if (bad >= 0) {
      console.error(`spec-exceptions: ${rel}: пункт ${bad + 1} — не исключение { item, issue, reason }`);
      return 2;
    }
    const folder = legacyOf(rel)!.folder;
    const dir = `${folder}/${EXCEPTIONS_DIR}`;
    const written: string[] = [];
    for (const e of list as Entry[]) {
      const body = json(e);
      let name = slug(e);
      // the name is taken by another exception — a suffix; the same text — already moved
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

    // the import in the files of the folder and its subfolders — to exceptionsIn(): the harness finds the directory of the test's decision folder itself
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

  // name exceptions — a file per name into the decision folder of its test; a test outside the tree — to the former file's decision folder
  for (const rel of names) {
    let list: unknown;
    try {
      list = await loadLegacy(path.join(root, rel));
    } catch (e) {
      console.error(`spec-exceptions: ${rel} не загружается: ${(e as Error).message}`);
      return 2;
    }
    const isName = (x: Partial<NameException> | null) => !!x && typeof x.file === "string" && typeof x.name === "string" && Number.isInteger(x.issue);
    if (!Array.isArray(list) || !list.every(isName)) {
      console.error(`spec-exceptions: ${rel} — нужен export default [{ file, name, issue, reason }]`);
      return 2;
    }
    const written = (list as NameException[]).map((x) =>
      writeNameException(root, decisionFolder(x.file) ?? legacyOf(rel)?.folder ?? path.posix.dirname(rel), { file: x.file, name: x.name, issue: x.issue, reason: String(x.reason ?? "") }),
    );
    rmSync(path.join(root, rel));
    movedNames.push(rel);
    out.push(`- ${rel} → ${[...new Set(written.map((w) => `${path.posix.dirname(w)}/`))].join(", ")} (${written.length})`, ...written.map((w) => `+ ${w}`));
  }

  // the path to the former file in the project's scripts and CI (spec-claims --exceptions) — by the path to the directory; the
  // flag of the former name exceptions file (spec-doc --names-exceptions) — away: the exceptions are already in the directories
  for (const file of configs) {
    let text = readFileSync(path.join(root, file), "utf8");
    for (const rel of moved) {
      const re = new RegExp(`(?<![\\w./-])${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`, "g");
      if (!re.test(text)) continue;
      const dir = `${legacyOf(rel)!.folder}/${EXCEPTIONS_DIR}`;
      text = text.replace(re, dir);
      out.push(`~ ${file}: ${rel} → ${dir}`);
    }
    text = text.replace(NAMES_FLAG, (_all, rel: string) => {
      out.push(`~ ${file}: --names-exceptions ${rel} убран`);
      return "";
    });
    if (text !== readFileSync(path.join(root, file), "utf8")) writeFileSync(path.join(root, file), text);
  }

  // references to the moved files that the command didn't rewrite — by hand
  for (const file of walk(root, TESTS).filter((f) => CODE.test(f))) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(ANY_IMPORT)) {
      const rel = moved.find((l) => pointsTo(file, m[2]!, l));
      if (rel) manual.push(`! ${file}: ссылка на ${rel} — замени на exceptionsIn("${legacyOf(rel)!.folder}") харнесса`);
    }
  }

  if (!moved.length && !movedNames.length) out.push("exceptions.ts в папках решений нет — переносить нечего");
  for (const l of [...out, ...manual]) console.log(l);
  return manual.length ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
