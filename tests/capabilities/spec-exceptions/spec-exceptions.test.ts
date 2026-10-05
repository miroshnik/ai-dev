import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, SCRIPTS, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const AUDIT = "tests/standards/audit";
const HARNESS = JSON.stringify(path.join(SCRIPTS, "harness.ts"));
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
const migrate = (...args: string[]) => runScript("spec-exceptions", args, dir);

// исключения проекта до переезда — модуль с типом из харнесса и двумя соглашениями папки
const LEGACY = `import type { Exception } from ${HARNESS};

const exceptions: Exception[] = [
  { item: "importLegacy", issue: 12, reason: "импорт старых данных — аудит в #12" },
  { item: "export:src/math.ts#factorial", rule: "cancel", issue: 7, reason: "уйдёт в #7" },
];
export default exceptions;
`;

const TEST = `import { it } from "bun:test";
import { invariant } from ${HARNESS};
import exceptions from "./exceptions.ts";
import { other } from "./other.ts";

invariant(it, {
  registry: "мутации",
  items: ["createInvoice", "importLegacy"],
  name: (m) => m + " пишет аудит" + other,
  key: (m) => m,
  check: (m) => { if (m === "importLegacy") throw new Error("нет аудита"); },
  violator: { name: "без аудита", item: "importLegacy" },
  exceptions,
});
invariant(it, {
  rule: "cancel",
  registry: "отмены",
  items: ["export:src/math.ts#factorial", "importLegacy"],
  name: (m) => m + " отменяется",
  key: (m) => m,
  check: (m) => { throw new Error(m + " без отмены"); },
  violator: { name: "без отмены", item: "importLegacy" },
  exceptions,
});
`;

const project = () =>
  writeTree(dir, {
    [`${AUDIT}/exceptions.ts`]: LEGACY,
    [`${AUDIT}/audit.test.ts`]: TEST,
    [`${AUDIT}/other.ts`]: 'export const other = "";\n',
  });

describe("Исключения проекта переезжают в каталог exceptions/ одной командой", () => {
  it("spec-exceptions переносит exceptions.ts в каталог — файл на исключение, старый удалён, импорт в тесте — exceptionsIn()", () => {
    project();
    const r = migrate();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, AUDIT, "exceptions.ts"))).toBe(false);
    expect(JSON.parse(read(`${AUDIT}/exceptions/importLegacy.json`))).toEqual({ item: "importLegacy", issue: 12, reason: "импорт старых данных — аудит в #12" });
    expect(read(`${AUDIT}/exceptions/cancel--export-src-math.ts-factorial.json`)).toBe(
      '{\n  "item": "export:src/math.ts#factorial",\n  "rule": "cancel",\n  "issue": 7,\n  "reason": "уйдёт в #7"\n}\n',
    );
    const test = read(`${AUDIT}/audit.test.ts`);
    expect(test).toContain(`import { exceptionsIn, invariant } from ${HARNESS};\n`);
    expect(test).toContain('import { other } from "./other.ts";\n\nconst exceptions = exceptionsIn();\n');
    expect(test).not.toContain("./exceptions.ts");
    expect(r.stdout).toContain(`- ${AUDIT}/exceptions.ts → ${AUDIT}/exceptions/ (2)`);
    expect(r.stdout).toContain(`~ ${AUDIT}/audit.test.ts: импорт → exceptionsIn()`);
    // после переезда проверка проекта зелёная: исключение то же, но из каталога
    const t = spawnSync("bun", ["test", "--reporter=junit", "--reporter-outfile=r.xml"], { cwd: dir, encoding: "utf8" });
    expect(t.status).toBe(0);
    expect(read("r.xml")).toMatch(/<testcase name="исключение: importLegacy \(#12\)"[^>]*\/>/);
  });

  it("повторный запуск — переносить нечего: код 0, файлы те же", () => {
    project();
    expect(migrate().code).toBe(0);
    const before = read(`${AUDIT}/audit.test.ts`);
    const r = migrate();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exceptions.ts в папках решений нет — переносить нечего");
    expect(read(`${AUDIT}/audit.test.ts`)).toBe(before);
  });

  it("путь к exceptions.ts в package.json и workflow CI — на каталог", () => {
    writeTree(dir, {
      "tests/standards/entry-points/exceptions.ts": 'export default [{ item: "job:cleanup", issue: 12, reason: "тест — в #12" }];\n',
      "package.json": JSON.stringify({ scripts: { claims: "node .agents/skills/spec/scripts/spec-claims.ts --entries e.ts --exceptions tests/standards/entry-points/exceptions.ts" } }, null, 2) + "\n",
      ".github/workflows/ci.yml": "      - run: node spec-claims.ts --exceptions tests/standards/entry-points/exceptions.ts\n",
    });
    const r = migrate();
    expect(r.code).toBe(0);
    expect(read("package.json")).toContain("--exceptions tests/standards/entry-points/exceptions\"");
    expect(read(".github/workflows/ci.yml")).toBe("      - run: node spec-claims.ts --exceptions tests/standards/entry-points/exceptions\n");
    expect(r.stdout).toContain("~ package.json: tests/standards/entry-points/exceptions.ts → tests/standards/entry-points/exceptions");
    expect(r.stdout).toContain("~ .github/workflows/ci.yml: tests/standards/entry-points/exceptions.ts → tests/standards/entry-points/exceptions");
  });

  it("ссылку, которую не переписать, команда называет — код 1", () => {
    project();
    writeTree(dir, { "tests/standards/other/other.test.ts": 'import exceptions from "../audit/exceptions.ts";\nexport { exceptions };\n' });
    const r = migrate();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`! tests/standards/other/other.test.ts: ссылка на ${AUDIT}/exceptions.ts — замени на exceptionsIn("${AUDIT}") харнесса`);
  });

  // каталог один на папку решения: exceptionsIn() теста подпапки читает каталог папки — перенос в каталог подпапки
  // оставил бы исключения непрочитанными
  it("exceptions.ts подпапки переезжает в exceptions/ папки решения — тест подпапки читает его через exceptionsIn()", () => {
    writeTree(dir, {
      [`${AUDIT}/sub/exceptions.ts`]: LEGACY,
      [`${AUDIT}/sub/sub.test.ts`]: TEST,
      [`${AUDIT}/sub/other.ts`]: 'export const other = "";\n',
    });
    const r = migrate();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`- ${AUDIT}/sub/exceptions.ts → ${AUDIT}/exceptions/ (2)`);
    expect(r.stdout).toContain(`~ ${AUDIT}/sub/sub.test.ts: импорт → exceptionsIn()`);
    expect(existsSync(path.join(dir, AUDIT, "sub/exceptions"))).toBe(false);
    expect(JSON.parse(read(`${AUDIT}/exceptions/importLegacy.json`))).toEqual({ item: "importLegacy", issue: 12, reason: "импорт старых данных — аудит в #12" });
    const t = spawnSync("bun", ["test", "--reporter=junit", "--reporter-outfile=r.xml"], { cwd: dir, encoding: "utf8" });
    expect(t.status).toBe(0);
    expect(read("r.xml")).toMatch(/<testcase name="исключение: importLegacy \(#12\)"[^>]*\/>/);
  });
});

const BILLING = "tests/capabilities/billing";
const MAIN = `${BILLING}/billing.test.ts`;
const E2E = `${BILLING}/billing.e2e.ts`;
const AUDIT_TEST = `${AUDIT}/audit.test.ts`;
const REASON = "название — не утверждение; переписать в #12";
const named = (file: string, name: string) => ({ file, name, issue: 12, reason: REASON });
const json = (x: object) => JSON.stringify(x, null, 2) + "\n";
// прежний формат spec-doc --names-baseline — модуль с массивом { file, name, issue, reason }
const namesModule = (list: object[]) => `const exceptions = [\n${list.map((x) => `  ${JSON.stringify(x)},`).join("\n")}\n];\n\nexport default exceptions;\n`;

describe("Исключения названий spec-doc переезжают в names.exceptions/ той же командой", () => {
  it("`spec-exceptions` переносит `names.exceptions.ts` в каталог", () => {
    writeTree(dir, {
      [`${BILLING}/names.exceptions.ts`]: namesModule([named(MAIN, "returns 201"), named(E2E, "returns 201"), named(MAIN, "createInvoice")]),
      [`${BILLING}/billing.md`]: "Биллинг.\n",
    });
    const r = migrate();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, BILLING, "names.exceptions.ts"))).toBe(false);
    expect(read(`${BILLING}/names.exceptions/returns-201.json`)).toBe(json(named(MAIN, "returns 201")));
    // то же название в другом файле папки — свой файл с суффиксом
    expect(read(`${BILLING}/names.exceptions/returns-201-2.json`)).toBe(json(named(E2E, "returns 201")));
    expect(read(`${BILLING}/names.exceptions/createInvoice.json`)).toBe(json(named(MAIN, "createInvoice")));
    expect(r.stdout).toContain(`- ${BILLING}/names.exceptions.ts → ${BILLING}/names.exceptions/ (3)`);
    expect(r.stdout).toContain(`+ ${BILLING}/names.exceptions/returns-201.json`);
    // после переезда spec-doc --strict зелёный: исключения те же, но из каталога
    writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: [[["createInvoice"], "returns 201"]], [E2E]: [[["Счета"], "returns 201"]] }));
    const doc = runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--strict"], dir);
    expect(doc.stderr).not.toContain("не утверждение по-русски");
    expect(doc.code).toBe(0);
  });

  it("`spec-exceptions` раскладывает общий файл `spec-names` по папкам тестов и убирает `--names-exceptions` из `package.json` и CI", () => {
    const SHARED = "tests/standards/spec-names/exceptions.ts";
    const CUSTOM = "tests/legacy-names.ts";
    writeTree(dir, {
      [SHARED]: namesModule([named(MAIN, "returns 201"), named(AUDIT_TEST, "writes row"), named("tests/x.test.ts", "orphan")]),
      [CUSTOM]: namesModule([named(MAIN, "returns 404")]),
      "package.json": JSON.stringify({ scripts: { "spec:doc": `node spec-doc.ts r.xml --strict --names-exceptions ${SHARED}` } }, null, 2) + "\n",
      ".github/workflows/ci.yml": `      - run: node spec-doc.ts r.xml --names-exceptions=${CUSTOM} --strict\n`,
    });
    const r = migrate();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, SHARED))).toBe(false);
    expect(existsSync(path.join(dir, CUSTOM))).toBe(false);
    expect(read(`${BILLING}/names.exceptions/returns-201.json`)).toBe(json(named(MAIN, "returns 201")));
    expect(read(`${BILLING}/names.exceptions/returns-404.json`)).toBe(json(named(MAIN, "returns 404")));
    expect(read(`${AUDIT}/names.exceptions/writes-row.json`)).toBe(json(named(AUDIT_TEST, "writes row")));
    // тест вне папки решения — исключение остаётся у прежнего файла: spec-doc назовёт его ненужным
    expect(read("tests/standards/spec-names/names.exceptions/orphan.json")).toBe(json(named("tests/x.test.ts", "orphan")));
    expect(r.stdout).toContain(`- ${SHARED} → ${BILLING}/names.exceptions/, ${AUDIT}/names.exceptions/, tests/standards/spec-names/names.exceptions/ (3)`);
    expect(JSON.parse(read("package.json")).scripts["spec:doc"]).toBe("node spec-doc.ts r.xml --strict");
    expect(read(".github/workflows/ci.yml")).toBe("      - run: node spec-doc.ts r.xml --strict\n");
    expect(r.stdout).toContain(`~ package.json: --names-exceptions ${SHARED} убран`);
    expect(r.stdout).toContain(`~ .github/workflows/ci.yml: --names-exceptions ${CUSTOM} убран`);
  });
});
