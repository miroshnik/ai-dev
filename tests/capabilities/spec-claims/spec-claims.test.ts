/**
 * Нет решения — нет кода: каждая точка входа системы (маршрут, страница, job, команда) вызывается хотя бы одним
 * тестом capability. Код, до которого не доходит ни одно заявленное поведение, — кандидат на удаление или
 * незаписанное требование.
 *
 * Тестовое окружение пишет в журнал, какую точку входа и из какого теста вызвали (`journal` харнесса), а после
 * прогона всех тестов и шардов `spec-claims` сверяет реестр точек входа из кода с журналом. Результат — отчёт JUnit:
 * `spec-doc` кладёт его в спеку как обычный стандарт.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const line = (id: string, test: string | null) => JSON.stringify({ id, test }) + "\n";
const claims = (...args: string[]) => runScript("spec-claims", ["--entries", "entries.json", ...args], dir);
const report = () => readFileSync(path.join(dir, ".spec-claims.xml"), "utf8");
const passed = (xml: string, name: string) => new RegExp(`name="${name}"[^>]*/>`).test(xml);
const failed = (xml: string, name: string) => new RegExp(`name="${name}"[^>]*>\\s*<failure`).test(xml);

describe("Каждая точка входа вызывается хотя бы одним тестом capability — по журналу, а не по покрытию", () => {
  it("вызов из теста записывается в журнал вместе с файлом теста, из которого он пришёл", () => {
    writeTree(dir, {
      "tests/capabilities/billing/billing.test.ts": `import { it } from "bun:test";
import { journal } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};
const createInvoice = () => { journal("POST /invoices"); return 1; };
it("счёт создаётся", () => { createInvoice(); });
`,
    });
    const r = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    const files = readdirSync(path.join(dir, ".spec-journal"));
    const records = files.flatMap((f) => readFileSync(path.join(dir, ".spec-journal", f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    expect(records).toEqual([{ id: "POST /invoices", test: "tests/capabilities/billing/billing.test.ts" }]);
  });

  // Покрытие говорит «строка выполнилась», а не «её вызвал тест capability»: вызов из теста стандарта или из
  // хелпера вне тестов заявленным поведением не считается
  it("точка входа без вызова из теста capability — упавший тест сверки и код 1; вызов из теста стандарта не засчитан", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices", "GET /reports", "job:cleanup"]),
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts") + line("GET /reports", "tests/standards/audit/audit.test.ts"),
    });
    const r = claims();
    expect(r.code).toBe(1);
    const xml = report();
    expect(passed(xml, "POST /invoices вызывается тестом capability")).toBe(true);
    expect(failed(xml, "GET /reports вызывается тестом capability")).toBe(true);
    expect(failed(xml, "job:cleanup вызывается тестом capability")).toBe(true);
    expect(r.stderr).toContain("не вызываются тестами capability: 2");
  });

  it("журналы шардов складываются: вызов в любом шарде засчитан", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices", "GET /reports"]),
      ".spec-journal/shard-1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts"),
      ".spec-journal/shard-2.jsonl": line("GET /reports", "tests/capabilities/reports/reports.e2e.ts"),
    });
    expect(claims().code).toBe(0);
  });

  it("реестр — модуль проекта: default — массив или функция, которая его возвращает", () => {
    writeTree(dir, {
      "entries.ts": 'export default async () => ["POST /invoices"];\n',
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts"),
    });
    const r = runScript("spec-claims", ["--entries", "entries.ts"], dir);
    expect(r.code).toBe(0);
  });

  it("пустой реестр — упавший тест: выборка точек входа ошибочна", () => {
    writeTree(dir, { "entries.json": "[]", ".spec-journal/1.jsonl": "" });
    expect(claims().code).toBe(1);
    expect(failed(report(), "реестр «точки входа» не пуст")).toBe(true);
  });
});

describe("Точка входа без теста — исключение с задачей, пока тест не появился", () => {
  it("исключение на точку без теста — зелёное; точка, у которой тест появился, — «убери исключение»", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices", "job:cleanup", "GET /reports"]),
      "exceptions.json": JSON.stringify([
        { item: "job:cleanup", issue: 12, reason: "тест очистки — в #12" },
        { item: "POST /invoices", issue: 13, reason: "было" },
      ]),
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts") + line("GET /reports", "tests/capabilities/reports/reports.test.ts"),
    });
    const r = claims("--exceptions", "exceptions.json");
    expect(r.code).toBe(1);
    const xml = report();
    expect(passed(xml, "исключение: job:cleanup \\(#12\\)")).toBe(true);
    expect(failed(xml, "исключение: POST /invoices \\(#13\\)")).toBe(true);
    expect(xml).toContain("POST /invoices уже вызывается тестом capability — убери исключение (#13)");
  });
});

describe("Сверка попадает в спеку как стандарт", () => {
  it("отчёт — JUnit в папке стандарта tests/standards/entry-points: spec-doc показывает его со шапкой главного файла", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices"]),
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts"),
      "tests/standards/entry-points/entry-points.test.ts": "/** Каждая точка входа вызывается тестом capability. */\nexport {};\n",
    });
    expect(claims().code).toBe(0);
    const doc = runScript("spec-doc", [".spec-claims.xml", "--root", dir, "--stdout"], dir);
    expect(doc.code).toBe(0);
    expect(doc.stdout).toContain("### entry-points\n\nКаждая точка входа вызывается тестом capability.\n\n#### Каждая точка входа вызывается хотя бы одним тестом capability");
    expect(doc.stdout).toContain("- ✅ POST /invoices вызывается тестом capability");
  });

  it("нет журнала — код 2 и подсказка, откуда он берётся", () => {
    writeFileSync(path.join(dir, "entries.json"), "[]");
    const r = claims();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("journal");
  });
});
