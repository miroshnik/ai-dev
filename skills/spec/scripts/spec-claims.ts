#!/usr/bin/env bun
/**
 * spec-claims — сверка реестра точек входа с журналом вызовов: каждая точка входа (маршрут, страница, job, команда)
 * вызывается хотя бы одним тестом capability. Журнал пишет `journal` харнесса во время прогона; журналы шардов
 * складываются из каталога. Вызов не из `tests/capabilities/` не засчитывается: заявленное поведение — это
 * capability, а не стандарт или хелпер.
 *
 *   bun spec-claims.ts --entries <entries.json | entries.ts> [--journal .spec-journal] [--exceptions <file>]
 *                      [--standard tests/standards/entry-points] [--report .spec-claims.xml]
 *
 * Реестр — JSON-массив строк или модуль проекта (default — массив или функция, которая его возвращает): точки входа
 * из кода, не рукописный список. Исключения — `[{ item, issue, reason }]`: точка без теста с задачей, пока тест не
 * появился; появился — «убери исключение». Отчёт — JUnit в папке стандарта (`spec-doc` кладёт его в спеку со шапкой
 * главного файла стандарта). Коды: 0 — всё заявлено, 1 — есть незаявленные или ошибки исключений, 2 — ошибка вызова.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const USAGE =
  "spec-claims.ts --entries <entries.json | entries.ts> [--journal .spec-journal] [--exceptions <file>] [--standard tests/standards/entry-points] [--report .spec-claims.xml]";
const DESCRIBE = "Каждая точка входа вызывается хотя бы одним тестом capability";
const CAPABILITIES = "tests/capabilities/";

interface Exception {
  item: string;
  issue: number;
  reason: string;
}
interface Case {
  name: string;
  failure?: string;
}

/** JSON-файл или модуль проекта: default — значение или функция, которая его возвращает. */
async function load(file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const v = mod.default;
  return typeof v === "function" ? await (v as () => unknown)() : v;
}

/** Точка входа → файлы тестов, которые её вызывали (все журналы каталога). */
function readJournal(dir: string): Map<string, Set<string>> {
  const calls = new Map<string, Set<string>>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { id, test } = JSON.parse(line) as { id: string; test: string | null };
      calls.set(id, (calls.get(id) ?? new Set()).add(test ?? "(не из теста)"));
    }
  }
  return calls;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JUnit как у `bun test`: suite файла, вложенный suite — describe, testcase с file. */
function junit(file: string, cases: Case[]): string {
  const f = esc(file);
  const body = cases
    .map((c) =>
      c.failure
        ? `      <testcase name="${esc(c.name)}" file="${f}">\n        <failure message="${esc(c.failure)}" />\n      </testcase>`
        : `      <testcase name="${esc(c.name)}" file="${f}" />`,
    )
    .join("\n");
  const failures = cases.filter((c) => c.failure).length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="spec-claims" tests="${cases.length}" failures="${failures}">
  <testsuite name="${f}" file="${f}" tests="${cases.length}" failures="${failures}">
    <testsuite name="${esc(DESCRIBE)}" file="${f}" tests="${cases.length}" failures="${failures}">
${body}
    </testsuite>
  </testsuite>
</testsuites>
`;
}

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        entries: { type: "string" },
        journal: { type: "string", default: ".spec-journal" },
        exceptions: { type: "string" },
        standard: { type: "string", default: "tests/standards/entry-points" },
        report: { type: "string", default: ".spec-claims.xml" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-claims: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = opts.values;
  if (v.help || !v.entries) {
    console.error(USAGE);
    return v.help ? 0 : 2;
  }
  let entries: string[];
  let exceptions: Exception[] = [];
  let calls: Map<string, Set<string>>;
  try {
    const raw = await load(path.resolve(v.entries));
    if (!Array.isArray(raw)) throw new Error(`${v.entries}: реестр — массив точек входа`);
    entries = [...new Set(raw.map((e) => (typeof e === "string" ? e : String((e as { id?: unknown }).id))))].sort();
    if (v.exceptions) exceptions = (await load(path.resolve(v.exceptions))) as Exception[];
    if (!existsSync(v.journal)) {
      throw new Error(`нет журнала ${v.journal} — его пишет journal харнесса во время прогона тестов (журналы шардов — в один каталог)`);
    }
    calls = readJournal(v.journal);
  } catch (e) {
    console.error(`spec-claims: ${(e as Error).message}`);
    return 2;
  }

  const claimed = (id: string) => [...(calls.get(id) ?? [])].some((t) => t.startsWith(CAPABILITIES));
  const excepted = new Map(exceptions.map((e) => [e.item, e]));
  const cases: Case[] = [];
  cases.push({ name: "реестр «точки входа» не пуст", failure: entries.length ? undefined : "реестр точек входа пуст — выборка из кода ошибочна" });
  for (const id of entries.filter((id) => !excepted.has(id))) {
    const from = [...(calls.get(id) ?? [])].sort();
    cases.push({
      name: `${id} вызывается тестом capability`,
      failure: claimed(id) ? undefined : `${id} не вызывается ни одним тестом capability${from.length ? ` (вызовы: ${from.join(", ")})` : ""} — тест или удалить точку входа`,
    });
  }
  for (const e of [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    let failure: string | undefined;
    if (!Number.isInteger(e.issue) || e.issue <= 0) failure = `у исключения ${e.item} нет задачи`;
    else if (!e.reason?.trim()) failure = `у исключения ${e.item} нет причины`;
    else if (!entries.includes(e.item)) failure = `точки входа ${e.item} в реестре нет — убери исключение`;
    else if (claimed(e.item)) failure = `${e.item} уже вызывается тестом capability — убери исключение (#${e.issue})`;
    cases.push({ name: `исключение: ${e.item} (#${e.issue})`, failure });
  }

  const standard = v.standard.replace(/\/+$/, "");
  writeFileSync(v.report, junit(`${standard}/${path.posix.basename(standard)}.test.ts`, cases));
  const unclaimed = entries.filter((id) => !excepted.has(id) && !claimed(id));
  const failed = cases.filter((c) => c.failure);
  console.error(
    `spec-claims: точек входа ${entries.length}, не вызываются тестами capability: ${unclaimed.length}, исключений ${excepted.size}; отчёт — ${v.report}`,
  );
  for (const c of failed) console.error(`spec-claims: ✗ ${c.failure}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
