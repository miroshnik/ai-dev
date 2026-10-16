import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { packageProject } from "../../lib/npm.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

/** Стандарт проекта на харнессе из пакета. */
const STANDARD = [
  'import { describe, it } from "bun:test";',
  'import { invariant } from "@miroshnik/elves/spec/harness";',
  "",
  'const handlers = ["createInvoice", "listInvoices"];',
  "",
  'describe("Every handler is named in camelCase", () => {',
  "  invariant(it, {",
  '    registry: "handlers",',
  "    items: handlers,",
  "    key: (h) => h,",
  "    name: (h) => `${h} is in camelCase`,",
  "    check: (h) => {",
  "      if (!/^[a-z][A-Za-z]*$/.test(h)) throw new Error(`${h} is not in camelCase`);",
  "    },",
  '    violator: { name: "snake_case", item: "create_invoice" },',
  '    includes: ["createInvoice"],',
  "  });",
  "});",
  "",
].join("\n");

/** Процесс в каталоге проекта; окружение прогона — без отметок CI и слота: проект сам по себе. */
function run(cwd: string, cmd: string, args: string[]) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

/**
 * Тонкий проект: флоу приходит пакетом `@miroshnik/elves` из devDependencies, копии `.agents/skills` нет. Харнесс
 * тесты проекта импортируют из пакета, spec-скрипты CI и агент зовут `elves <скрипт>` из `node_modules/.bin` — версии
 * проекта (#556).
 */
describe("Харнесс и spec-скрипты — из пакета @miroshnik/elves, без копии флоу в проекте", () => {
  it("тест проекта импортирует харнесс из пакета и проходит под bun test", () => {
    const proj = packageProject("harness-runners", { "tests/standards/handlers/handlers.test.ts": STANDARD });
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
    const bun = run(proj, process.execPath, ["test", "--reporter=junit", "--reporter-outfile=report.xml"]);
    expect({ code: exitOf(bun), output: bun.stderr }).toMatchObject({ code: 0, output: expect.stringContaining(" 5 pass\n 0 fail") });
    // пять тестов харнесса — непустой реестр, includes, нарушитель и по тесту на элемент реестра; элементы — в отчёте
    const report = readFileSync(path.join(proj, "report.xml"), "utf8");
    for (const name of ["createInvoice is in camelCase", "listInvoices is in camelCase"]) expect(report).toContain(`name="${name}"`);
  });

  it("elves spec-doc и elves spec-diff из node_modules/.bin работают в проекте без копии флоу", () => {
    const proj = packageProject("spec-scripts", { ".gitignore": "node_modules/\ndocs/spec/\n.spec-report.xml\n" });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", ...args], { cwd: proj, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeTree(proj, {
      "tests/capabilities/invoices/invoices.md": "Invoices go to the accountant as PDF.\n",
      "tests/capabilities/invoices/invoices.test.ts": 'import { describe, expect, it } from "bun:test";\n\ndescribe("Invoices export", () => {\n  it("an invoice exports to PDF", () => expect(1).toBe(1));\n});\n',
    });
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const elves = path.join(proj, "node_modules/.bin/elves");

    const diff = run(proj, elves, ["spec-diff", "--base", "HEAD~1"]);
    expect({ code: exitOf(diff), stderr: diff.stderr }).toEqual({ code: 0, stderr: "" });
    expect(diff.stdout).toContain("an invoice exports to PDF");

    const report = run(proj, process.execPath, ["test", "--reporter=junit", "--reporter-outfile=.spec-report.xml"]);
    expect(exitOf(report)).toBe(0);
    const doc = run(proj, elves, ["spec-doc", ".spec-report.xml", "--strict"]);
    expect({ code: exitOf(doc), stderr: doc.stderr }).toMatchObject({ code: 0, stderr: expect.stringContaining("capabilities 1, architecture 0, standards 0, 1 test") });
    expect(readFileSync(path.join(proj, "docs/spec/capabilities/invoices.md"), "utf8")).toContain("an invoice exports to PDF");
  });
});
