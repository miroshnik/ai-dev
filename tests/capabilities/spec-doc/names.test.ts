import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const NAMES = "tests/capabilities/billing/names.exceptions";
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
const json = (x: object) => JSON.stringify(x, null, 2) + "\n";

function doc(names: [string[], string][], ...args: string[]) {
  writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n" });
  writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: names }));
  return runScript("spec-doc", ["r.json", "--root", dir, ...args], dir);
}
/** Исключения названий billing — файл на название (`as` — имя файла) в каталоге папки решения. */
const exceptions = (list: { name: string; issue: number; as?: string; at?: string }[]) =>
  writeTree(dir, Object.fromEntries(list.map((x) => [`${x.at ?? NAMES}/${x.as ?? x.name.replace(/\W+/g, "-")}.json`, json({ file: MAIN, name: x.name, issue: x.issue, reason: "переписать" })])));

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

  it("исключение на название, которое стало утверждением или пропало, — spec-doc просит удалить его файл", () => {
    exceptions([{ name: "Счета", issue: 12, as: "invoices" }, { name: "gone", issue: 12 }]);
    const r = doc([[["Счета"], "выставляются за месяц"]], "--stdout", "--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`исключение названия «Счета» (${MAIN}) не нужно — уже утверждение, удали ${NAMES}/invoices.json`);
    expect(r.stderr).toContain(`исключение названия «gone» (${MAIN}) не нужно — теста нет, удали ${NAMES}/gone.json`);
  });

  // параллельные PR снимают каждый своё исключение: удаление своего файла ни с чем не конфликтует, а в массиве
  // соседние строки конфликтовали в каждом ребейзе
  it("исключение названия — файл в `names.exceptions/` папки решения", () => {
    exceptions([{ name: "returns 201", issue: 12 }]);
    const r = doc([[["Счета"], "returns 201"]], "--strict");
    expect(r.code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(`- «returns 201» — \`${MAIN}\` — #12 переписать\n`);
  });

  it("`--names-baseline` пишет файл на название и удаляет ненужные", () => {
    const AUDIT = "tests/standards/audit/audit.test.ts";
    const two = (billing: [string[], string][]) => {
      writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n", "tests/standards/audit/audit.md": "Аудит.\n" });
      writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: billing, [AUDIT]: [[["Аудит"], "writes row"]] }));
    };
    two([[["createInvoice"], "returns 201"]]);
    const r = runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--names-baseline", "12"], dir);
    expect(r.code).toBe(0);
    const reason = "название — не утверждение; переписать в #12";
    expect(read(`${NAMES}/createInvoice.json`)).toBe(json({ file: MAIN, name: "createInvoice", issue: 12, reason }));
    expect(read(`${NAMES}/returns-201.json`)).toBe(json({ file: MAIN, name: "returns 201", issue: 12, reason }));
    expect(JSON.parse(read("tests/standards/audit/names.exceptions/writes-row.json"))).toEqual({ file: AUDIT, name: "writes row", issue: 12, reason });
    two([[["createInvoice"], "returns 201"]]);
    expect(runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--strict"], dir).code).toBe(0);
    // название переписали: повторный baseline удаляет его файл, остальные не трогает
    two([[["createInvoice"], "возвращает 201"]]);
    expect(runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--names-baseline", "13"], dir).code).toBe(0);
    expect(existsSync(path.join(dir, NAMES, "returns-201.json"))).toBe(false);
    expect(JSON.parse(read(`${NAMES}/createInvoice.json`)).issue).toBe(12);
    // переписали последнее название папки — каталог исключений уходит вместе с файлом
    two([[["Счета"], "возвращает 201"]]);
    expect(runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--names-baseline", "13"], dir).code).toBe(0);
    expect(existsSync(path.join(dir, NAMES))).toBe(false);
  });

  it("исключение названия не в папке своего теста — ошибка --strict", () => {
    exceptions([{ name: "returns 201", issue: 12, at: "tests/capabilities/other/names.exceptions" }]);
    const r = doc([[["Счета"], "returns 201"]], "--stdout", "--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`исключение названия «returns 201» (${MAIN}) — не в папке своего теста: перенеси tests/capabilities/other/names.exceptions/returns-201.json в ${NAMES}/`);
  });

  it("файл в `names.exceptions/` — не исключение названия: ошибка с путём", () => {
    writeTree(dir, { [`${NAMES}/returns-201.json`]: json({ item: "returns 201", issue: 12, reason: "переписать" }) });
    const r = doc([[["Счета"], "returns 201"]], "--stdout");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`${NAMES}/returns-201.json: исключение названия — { file, name, issue, reason }`);
    rmSync(path.join(dir, NAMES, "returns-201.json"));
    writeTree(dir, { [`${NAMES}/returns-201.ts`]: "export default {};\n" });
    expect(doc([[["Счета"], "returns 201"]], "--stdout").stderr).toContain(`${NAMES}/returns-201.ts: исключение названия — файл <название>.json`);
  });

  it("каталог `names.exceptions/` в подпапке папки решения — ошибка с местом каталога", () => {
    exceptions([{ name: "returns 201", issue: 12, at: "tests/capabilities/billing/sub/names.exceptions" }]);
    const r = doc([[["Счета"], "returns 201"]], "--stdout");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`tests/capabilities/billing/sub/names.exceptions/returns-201.json: исключения названий — только в ${NAMES}/ папки решения, не в подпапке`);
  });

  // второй формат — второй путь в коде: прежний массив не читается, его переносит одна команда
  it("`names.exceptions.ts` — ошибка с подсказкой `spec-exceptions`", () => {
    const LEGACY = "tests/capabilities/billing/names.exceptions.ts";
    const SHARED = "tests/standards/spec-names/exceptions.ts";
    const list = `export default [{ file: "${MAIN}", name: "returns 201", issue: 12, reason: "переписать" }];\n`;
    writeTree(dir, { [LEGACY]: list, [SHARED]: list });
    const hint = "перенеси командой spec-exceptions: node .agents/skills/spec/scripts/spec-exceptions.ts";
    const r = doc([[["Счета"], "returns 201"]], "--stdout", "--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${LEGACY}: исключения названий — файл на название в names.exceptions/ папки решения — ${hint}`);
    expect(r.stderr).toContain(`${SHARED}: исключения названий — файл на название в names.exceptions/ папки решения — ${hint}`);
    // baseline поверх прежнего файла переписал бы его исключения новой задачей — отказ, файлы не тронуты
    const b = doc([[["Счета"], "returns 201"]], "--stdout", "--names-baseline", "13");
    expect(b.code).toBe(2);
    expect(b.stderr).toContain(hint);
    expect(existsSync(path.join(dir, NAMES))).toBe(false);
    const flag = doc([[["Счета"], "returns 201"]], "--stdout", "--names-exceptions", SHARED);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain(`--names-exceptions больше нет — исключения названий файлом в names.exceptions/ папки решения: ${hint}`);
  });

  it("исключения названий видны в оглавлении спеки — это долг", () => {
    exceptions([{ name: "returns 201", issue: 12 }]);
    expect(doc([[["Счета"], "returns 201"]]).code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(`## Названия — не утверждения (исключения)\n\n- «returns 201» — \`${MAIN}\` — #12 переписать\n`);
  });
});
