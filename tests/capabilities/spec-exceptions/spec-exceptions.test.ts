import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

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

  it("ссылку, которую не переписать, команда называет — код 1; исключения названий spec-doc не трогает", () => {
    project();
    writeTree(dir, {
      "tests/standards/other/other.test.ts": 'import exceptions from "../audit/exceptions.ts";\nexport { exceptions };\n',
      "tests/standards/spec-names/exceptions.ts": 'export default [{ file: "tests/x.test.ts", name: "returns 201", issue: 3, reason: "переписать" }];\n',
      "tests/capabilities/billing/names.exceptions.ts": 'export default [{ file: "tests/capabilities/billing/billing.test.ts", name: "returns 201", issue: 3, reason: "переписать" }];\n',
    });
    const r = migrate();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`! tests/standards/other/other.test.ts: ссылка на ${AUDIT}/exceptions.ts — замени на exceptionsIn("${AUDIT}") харнесса`);
    expect(r.stdout).toContain("○ tests/standards/spec-names/exceptions.ts: исключения названий spec-doc — не переносятся");
    expect(existsSync(path.join(dir, "tests/standards/spec-names/exceptions.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "tests/capabilities/billing/names.exceptions.ts"))).toBe(true);
  });
});
