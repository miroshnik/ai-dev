import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { isStatement } from "../../../skills/spec/scripts/speclib.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, setLanguage, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
// проект на ru: тесты файла ждут русский вывод, без манифеста проект — en
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  setLanguage(dir, "ru");
});
afterEach(() => cleanup());

const MAIN = "tests/capabilities/billing/billing.test.ts";
const WARN = "spec-doc: warning: the name isn't a statement in the project language";

function doc(names: [string[], string][], ...args: string[]) {
  writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n" });
  writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: names }));
  return runScript("spec-doc", ["r.json", "--root", dir, ...args], dir);
}

/**
 * Замер #441: `--strict` падал на названиях 9 раз за три недели, и все 9 — бумажная работа: тысячи переименований
 * ради чека или названия в исключениях. Правило «название — утверждение» осталось, но PR из-за него не красный:
 * spec-doc называет такое название предупреждением, а тело PR — их число. Структура спеки окупилась и по-прежнему
 * валит `--strict`.
 */
describe("Название, которое не утверждение, — предупреждение, а не ошибка", () => {
  it("название, которое не утверждение, — предупреждение, spec-doc --strict выходит с кодом 0", () => {
    const r = doc([[["createInvoice"], "returns 201"], [["Счета"], "выставляются за месяц"]], "--stdout", "--strict");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`${WARN} (ru): «createInvoice» (${MAIN})`);
    expect(r.stderr).toContain(`${WARN} (ru): «returns 201» (${MAIN})`);
    expect(r.stderr).not.toContain("«Счета»");
  });

  it("тест вне дерева по-прежнему даёт spec-doc --strict код 1", () => {
    writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n" });
    writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: [[["Счета"], "returns 201"]], "src/sum.test.ts": [[["sum"], "складывает"]] }));
    const r = runScript("spec-doc", ["r.json", "--root", dir, "--stdout", "--strict"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("spec-doc: outside the tree: src/sum.test.ts (1 test)");
    expect(r.stderr).toContain(`${WARN} (ru): «returns 201» (${MAIN})`);
  });

  // исключения названий отменены вместе с ошибкой: оставшийся в проекте каталог никто не читает — его удаляют
  it("каталог `names.exceptions/` и прежний `names.exceptions.ts` spec-doc не читает и просит удалить, код выхода не меняется", () => {
    const x = JSON.stringify({ file: MAIN, name: "returns 201", issue: 12, reason: "переписать" });
    writeTree(dir, {
      "tests/capabilities/billing/names.exceptions/returns-201.json": x,
      "tests/standards/audit/names.exceptions.ts": `export default [${x}];\n`,
    });
    const r = doc([[["Счета"], "returns 201"]], "--stdout", "--strict");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("spec-doc: warning: tests/capabilities/billing/names.exceptions isn't read — names aren't exceptions any more, delete it");
    expect(r.stderr).toContain("spec-doc: warning: tests/standards/audit/names.exceptions.ts isn't read — names aren't exceptions any more, delete it");
    expect(r.stderr).toContain(`${WARN} (ru): «returns 201» (${MAIN})`);
    expect(r.stdout).not.toContain("исключения");
  });

  it("флагов `--names-baseline` и `--names-exceptions` нет — ошибка вызова", () => {
    for (const [flag, value] of [["--names-baseline", "12"], ["--names-exceptions", "x.ts"]] as const) {
      const r = doc([[["Счета"], "выставляются за месяц"]], "--stdout", flag, value);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(flag);
    }
  });
});

/**
 * Утверждение — на языке проекта: в ru — русские слова, в другом языке — фраза из слов. Идентификатор, имя функции
 * или файла, слово с числом — не утверждение ни в каком языке: читатель спеки не узнает из него, что система делает.
 */
describe("Название — утверждение на языке проекта", () => {
  it("spec-doc в проекте на en принимает английское утверждение и предупреждает об идентификаторе", () => {
    setLanguage(dir, "en");
    const r = doc(
      [
        [["Invoices"], "an invoice is issued for a month"],
        [["Invoices"], "`parseScenarios` returns null without a section"],
        [["parseScenarios"], "foo_bar"],
        [["Invoices"], "fooBar"],
        [["Invoices"], "foo-bar"],
      ],
      "--stdout",
      "--strict",
    );
    expect(r.code).toBe(0);
    expect([...r.stderr.matchAll(/«(.+?)» \(/g)].map((m) => m[1])).toEqual(["parseScenarios", "foo_bar", "fooBar", "foo-bar"]);
  });

  it("утверждение не на ru — фраза из слов; идентификатор, путь и слово с числом — нет", () => {
    const statements = [
      "Invoices",
      "an invoice is issued for a month",
      "`parseScenarios` returns null without a section",
      "GET /invoices returns the user's invoices",
      "an e-mail is sent once",
      "UI shows an error",
    ];
    const identifiers = ["parseScenarios", "foo_bar", "fooBar", "FooBar", "foo-bar", "spec-doc.ts", "src/billing", "returns 201", "GET /invoices", "x", "`parseScenarios`"];
    expect(statements.filter((n) => !isStatement(n, "en"))).toEqual([]);
    expect(identifiers.filter((n) => isStatement(n, "en"))).toEqual([]);
    // письмо без пробелов между словами — утверждение строкой его букв
    expect(isStatement("請求書は月ごとに発行される", "ja")).toBe(true);
  });

  // Название — требование; идентификатор или английская фраза не говорят читателю спеки, что система делает
  it("название describe или it без русских слов — идентификатор, имя функции или файла — spec-doc называет его и файл", () => {
    const r = doc(
      [
        [["createInvoice"], "returns 201"],
        [["createInvoice"], "счёт `createInvoice()` в `invoice.ts` создаётся по заказу"],
        [["Счета"], "snake_case_name"],
      ],
      "--stdout",
    );
    expect(r.stderr).toContain(`${WARN} (ru): «createInvoice» (${MAIN})`);
    expect(r.stderr).toContain(`${WARN} (ru): «returns 201» (${MAIN})`);
    expect(r.stderr).toContain(`${WARN} (ru): «snake_case_name» (${MAIN})`);
    expect(r.stderr).not.toContain("«счёт");
    expect(r.stderr).not.toContain("«Счета»");
  });
});
