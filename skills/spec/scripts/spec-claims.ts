#!/usr/bin/env bun
/**
 * spec-claims — checks the entry-point registry against the call log: every entry point (route, page, job, command) is
 * called by at least one capability test. The log is written by the harness's `journal` during the run; logs of shards
 * and runners are gathered from the directory and its subdirectories (a directory per runner). A call not from
 * `tests/capabilities/` doesn't count: claimed behavior is a capability, not a standard or a helper. Ids in the
 * registry don't repeat (a repeat would hide an uncovered entry point behind a covered one), every id of the log is in
 * the registry (otherwise the format diverged or the registry is incomplete).
 *
 *   bun spec-claims.ts --entries <entries.json | entries.ts> [--journal .spec-journal] [--exceptions <directory>]
 *                      [--standard tests/standards/entry-points] [--report .spec-claims.xml]
 *
 * The registry is a JSON array of strings or a project module (default — an array or a function that returns it): entry
 * points from the code, not a hand-written list. Exceptions — the standard folder's `exceptions/` directory, a file per
 * exception (`{ item, issue, reason }`): an entry point without a test, with a task, until a test appears; once it
 * appears — "remove the exception". The report is JUnit in the standard's folder (`spec-doc` puts it into the spec with
 * the description from the standard's `<folder>.md`). Codes: 0 — everything is claimed, 1 — there are unclaimed ones or
 * exception errors, 2 — a call error.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import locale from "../../github/scripts/locale.ts";
import { exceptionFiles } from "./harness.ts";
import type { Exception } from "./harness.ts";

const USAGE =
  "spec-claims.ts --entries <entries.json | entries.ts> [--journal .spec-journal] [--exceptions tests/standards/entry-points/exceptions] [--standard tests/standards/entry-points] [--report .spec-claims.xml]";
const CAPABILITIES = "tests/capabilities/";

interface Case {
  name: string;
  failure?: string;
}

/** A JSON file or a project module: default — a value or a function that returns it. */
async function load(file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const v = mod.default;
  return typeof v === "function" ? await (v as () => unknown)() : v;
}

/** Entry point → test files that called it (all logs of the directory and subdirectories — a directory per runner). */
function readJournal(dir: string): Map<string, Set<string>> {
  const calls = new Map<string, Set<string>>();
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" });
  for (const f of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { id, test } = JSON.parse(line) as { id: string; test: string | null };
      calls.set(id, (calls.get(id) ?? new Set()).add(test ?? "(not from a test)"));
    }
  }
  return calls;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JUnit as in `bun test`: a suite per file, a nested suite — describe, testcase with file. */
function junit(file: string, describe: string, cases: Case[]): string {
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
    <testsuite name="${esc(describe)}" file="${f}" tests="${cases.length}" failures="${failures}">
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
  let repeated: string[];
  let exceptions: Exception[] = [];
  let calls: Map<string, Set<string>>;
  try {
    const raw = await load(path.resolve(v.entries));
    if (!Array.isArray(raw)) throw new Error(`${v.entries}: the registry is an array of entry points`);
    const ids = raw.map((e) => (typeof e === "string" ? e : String((e as { id?: unknown }).id)));
    const count = new Map<string, number>();
    for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
    entries = [...count.keys()].sort();
    repeated = entries.filter((id) => count.get(id)! > 1).map((id) => `${id} ×${count.get(id)}`);
    if (v.exceptions) {
      // a file per exception: the old array in one file is migrated by a command, not read by a second path
      if (existsSync(v.exceptions) && !statSync(v.exceptions).isDirectory()) {
        throw new Error(`--exceptions is an exceptions/ directory (a file per exception), not the file ${v.exceptions} — move it with spec-exceptions`);
      }
      exceptions = exceptionFiles(v.exceptions);
    }
    if (!existsSync(v.journal)) {
      throw new Error(`no log ${v.journal} — the harness's journal writes it during the test run (shard logs go into one directory)`);
    }
    calls = readJournal(v.journal);
  } catch (e) {
    console.error(`spec-claims: ${(e as Error).message}`);
    return 2;
  }

  // check test names are in the project language, like the harness's names: they go into the spec
  const N = locale.names(locale.projectLanguage());
  const claimed = (id: string) => [...(calls.get(id) ?? [])].some((t) => t.startsWith(CAPABILITIES));
  const excepted = new Map(exceptions.map((e) => [e.item, e]));
  const cases: Case[] = [];
  cases.push({
    name: locale.fill(N.spec.harness.registryNotEmpty, { registry: N.spec.claims.registry, tag: "" }),
    failure: entries.length ? undefined : "the entry-point registry is empty — the selection from the code is wrong",
  });
  cases.push({
    name: N.spec.claims.unique,
    failure: repeated.length
      ? `an id repeats in the registry: ${repeated.join(", ")} — each entry point has its own id, otherwise an uncovered one hides behind a covered one`
      : undefined,
  });
  for (const id of entries.filter((id) => !excepted.has(id))) {
    const from = [...(calls.get(id) ?? [])].sort();
    cases.push({
      name: locale.fill(N.spec.claims.called, { entry: id }),
      failure: claimed(id) ? undefined : `${id} is not called by any capability test${from.length ? ` (calls: ${from.join(", ")})` : ""} — add a test or remove the entry point`,
    });
  }
  const registered = new Set(entries);
  const unknown = [...calls.keys()]
    .filter((id) => !registered.has(id))
    .sort()
    .map((id) => `${id} (calls: ${[...calls.get(id)!].sort().join(", ")})`);
  cases.push({
    name: N.spec.claims.known,
    failure: unknown.length
      ? `ids from the log are not in the registry: ${unknown.join("; ")} — the log's id format diverged from the registry, the registry is incomplete, or the log is left over from a previous run (resetJournal)`
      : undefined,
  });
  for (const e of [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    let failure: string | undefined;
    if (!Number.isInteger(e.issue) || e.issue <= 0) failure = `exception ${e.item} has no issue`;
    else if (!e.reason?.trim()) failure = `exception ${e.item} has no reason`;
    else if (!entries.includes(e.item)) failure = `entry point ${e.item} is not in the registry — remove the exception: delete ${e.file}`;
    else if (claimed(e.item)) failure = `${e.item} is already called by a capability test — remove the exception: delete ${e.file} (#${e.issue})`;
    cases.push({ name: locale.fill(N.spec.harness.exception, { tag: "", item: e.item, issue: e.issue }), failure });
  }

  const standard = v.standard.replace(/\/+$/, "");
  writeFileSync(v.report, junit(`${standard}/${path.posix.basename(standard)}.test.ts`, N.spec.claims.describe, cases));
  const unclaimed = entries.filter((id) => !excepted.has(id) && !claimed(id));
  const failed = cases.filter((c) => c.failure);
  console.error(
    `spec-claims: entry points: ${entries.length}, not called by capability tests: ${unclaimed.length}, exceptions: ${excepted.size}; report: ${v.report}`,
  );
  for (const c of failed) console.error(`spec-claims: ✗ ${c.failure}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
