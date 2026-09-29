import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const MAIN = "tests/capabilities/billing/billing.test.ts";
const EXCEPTIONS = "tests/standards/spec-names/exceptions.ts";
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");

function doc(names: [string[], string][], ...args: string[]) {
  writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n" });
  writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: names }));
  return runScript("spec-doc", ["r.json", "--root", dir, ...args], dir);
}
const exceptions = (list: { name: string; issue: number }[]) =>
  writeTree(dir, {
    [EXCEPTIONS]: `const exceptions = ${JSON.stringify(list.map((x) => ({ file: MAIN, name: x.name, issue: x.issue, reason: "переписать" })))};\nexport default exceptions;\n`,
  });

/**
 * На существующей спеке сотни старых названий, а переписать их одним PR нельзя: проверка входит сразу, старые
 * названия — исключениями с задачей на переписывание. Долг только уменьшается: ненужное исключение — красное.
 */
describe("Названия-утверждения вводятся постепенно: старые — исключениями с задачей", () => {
  it("старое название из исключений не валит --strict, новое — валит", () => {
    exceptions([{ name: "returns 201", issue: 12 }]);
    const old = doc([[["Счета"], "returns 201"]], "--stdout", "--strict");
    expect(old.code).toBe(0);
    expect(old.stderr).not.toContain("название — не утверждение по-русски: «returns 201»");
    const fresh = doc([[["Счета"], "returns 201"], [["Счета"], "returns 404"]], "--stdout", "--strict");
    expect(fresh.code).toBe(1);
    expect(fresh.stderr).toContain(`название — не утверждение по-русски: «returns 404» (${MAIN})`);
  });

  it("исключение на название, которое стало утверждением или пропало, — spec-doc просит его убрать", () => {
    exceptions([{ name: "Счета", issue: 12 }, { name: "gone", issue: 12 }]);
    const r = doc([[["Счета"], "выставляются за месяц"]], "--stdout", "--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`исключение названия «Счета» (${MAIN}) не нужно — уже утверждение, убери из ${EXCEPTIONS}`);
    expect(r.stderr).toContain(`исключение названия «gone» (${MAIN}) не нужно — теста нет, убери из ${EXCEPTIONS}`);
  });

  // параллельные PR переписывают названия в разных папках: общий файл исключений конфликтовал бы в каждом ребейзе
  it("--names-baseline раскладывает исключения по папкам их тестов", () => {
    const AUDIT = "tests/standards/audit/audit.test.ts";
    const two = () => {
      writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n", "tests/standards/audit/audit.md": "Аудит.\n" });
      writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: [[["createInvoice"], "returns 201"]], [AUDIT]: [[["Аудит"], "writes row"]] }));
    };
    two();
    const r = runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--names-baseline", "12"], dir);
    expect(r.code).toBe(0);
    const billing = read("tests/capabilities/billing/names.exceptions.ts");
    expect(billing).toContain("export default exceptions;");
    expect(billing).toContain(`{ file: "${MAIN}", name: "createInvoice", issue: 12, reason: "название — не утверждение; переписать в #12" }`);
    expect(billing).toContain(`{ file: "${MAIN}", name: "returns 201", issue: 12, reason: "название — не утверждение; переписать в #12" }`);
    expect(read("tests/standards/audit/names.exceptions.ts")).toContain(`{ file: "${AUDIT}", name: "writes row", issue: 12,`);
    expect(existsSync(path.join(dir, EXCEPTIONS))).toBe(false);
    two();
    expect(runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--strict"], dir).code).toBe(0);
  });

  it("исключение названия в папке решения — --strict его пропускает", () => {
    writeTree(dir, { "tests/capabilities/billing/names.exceptions.ts": `export default [{ file: "${MAIN}", name: "returns 201", issue: 12, reason: "переписать" }];\n` });
    const r = doc([[["Счета"], "returns 201"]], "--strict");
    expect(r.code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(`- «returns 201» — \`${MAIN}\` — #12 переписать\n`);
  });

  // проект, который уже на baseline общим файлом, не ломается: переносит исключения в папки по мере переписывания
  it("исключение из общего файла по-прежнему действует рядом с исключениями папок", () => {
    exceptions([{ name: "returns 201", issue: 12 }]);
    writeTree(dir, { "tests/capabilities/billing/names.exceptions.ts": `export default [{ file: "${MAIN}", name: "returns 404", issue: 13, reason: "переписать" }];\n` });
    expect(doc([[["Счета"], "returns 201"], [["Счета"], "returns 404"]], "--stdout", "--strict").code).toBe(0);
  });

  it("исключение названия не в папке своего теста — ошибка --strict", () => {
    writeTree(dir, { "tests/capabilities/other/names.exceptions.ts": `export default [{ file: "${MAIN}", name: "returns 201", issue: 12, reason: "переписать" }];\n` });
    const r = doc([[["Счета"], "returns 201"]], "--stdout", "--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`исключение названия «returns 201» (${MAIN}) — не в папке своего теста: перенеси из tests/capabilities/other/names.exceptions.ts в tests/capabilities/billing/names.exceptions.ts`);
  });

  it("--names-exceptions с файлом — baseline пишет в этот файл, как раньше", () => {
    const r = doc([[["Счета"], "returns 201"]], "--stdout", "--names-exceptions", EXCEPTIONS, "--names-baseline", "12");
    expect(r.code).toBe(0);
    expect(read(EXCEPTIONS)).toContain(`{ file: "${MAIN}", name: "returns 201", issue: 12,`);
    expect(existsSync(path.join(dir, "tests/capabilities/billing/names.exceptions.ts"))).toBe(false);
  });

  it("исключения названий видны в оглавлении спеки — это долг", () => {
    exceptions([{ name: "returns 201", issue: 12 }]);
    expect(doc([[["Счета"], "returns 201"]]).code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(`## Названия — не утверждения (исключения)\n\n- «returns 201» — \`${MAIN}\` — #12 переписать\n`);
  });
});
