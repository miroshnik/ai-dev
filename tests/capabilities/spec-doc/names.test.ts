import { readFileSync, writeFileSync } from "node:fs";
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

  it("--names-baseline пишет исключения для всех текущих нарушений одной задачей", () => {
    const r = doc([[["createInvoice"], "returns 201"], [["Счета"], "выставляются за месяц"]], "--stdout", "--names-baseline", "12");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`${EXCEPTIONS}: исключений названий — 2 (#12)`);
    const text = read(EXCEPTIONS);
    expect(text).toContain("export default exceptions;");
    expect(text).toContain(`{ file: "${MAIN}", name: "createInvoice", issue: 12, reason: "название — не утверждение; переписать в #12" }`);
    expect(text).toContain(`{ file: "${MAIN}", name: "returns 201", issue: 12, reason: "название — не утверждение; переписать в #12" }`);
    expect(doc([[["createInvoice"], "returns 201"], [["Счета"], "выставляются за месяц"]], "--stdout", "--strict").code).toBe(0);
  });

  it("исключения названий видны в оглавлении спеки — это долг", () => {
    exceptions([{ name: "returns 201", issue: 12 }]);
    expect(doc([[["Счета"], "returns 201"]]).code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(`## Названия — не утверждения (исключения)\n\n- «returns 201» — \`${MAIN}\` — #12 переписать\n`);
  });
});
