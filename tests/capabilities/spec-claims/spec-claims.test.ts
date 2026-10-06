import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { testFileIn } from "../../../skills/spec/scripts/harness.ts";
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
  // V8 (Vitest) пишет анонимную async-функцию теста после await кадром `at async <путь>` — без имени и скобок
  it("вызов после await в анонимной async-функции теста — файл теста из кадра «at async»", () => {
    const stack = [
      "Error",
      "    at journal (/repo/.agents/skills/spec/scripts/harness.ts:470:5)",
      "    at createInvoice (/repo/src/helpers/api.ts:12:3)",
      "    at async /repo/tests/capabilities/billing/billing.test.ts:8:5",
    ].join("\n");
    expect(testFileIn(stack, "/repo")).toBe("tests/capabilities/billing/billing.test.ts");
    expect(testFileIn(stack.replace("at async /repo", "at async file:///repo"), "/repo")).toBe("tests/capabilities/billing/billing.test.ts");
  });

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

  // два обработчика с одним id склеились бы в одну точку: вызов покрытого засчитался бы и непокрытому
  it("id, повторённый в реестре, — упавший тест: непокрытая точка не прячется за покрытой с тем же id", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["GET /items", "POST /invoices", "GET /items"]),
      ".spec-journal/1.jsonl": line("GET /items", "tests/capabilities/items/items.test.ts") + line("POST /invoices", "tests/capabilities/billing/billing.test.ts"),
    });
    const r = claims();
    expect(r.code).toBe(1);
    const xml = report();
    expect(failed(xml, "id точек входа в реестре не повторяются")).toBe(true);
    expect(xml).toContain("id повторяется в реестре: GET /items ×2");
  });

  // разошедшийся формат («GET /reports/42» против «GET /reports/:id») иначе виден только косвенно — «не вызывается»
  it("id из журнала, которого нет в реестре, — упавший тест: формат id журнала разошёлся с реестром или реестр неполон", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices", "GET /reports/:id"]),
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts") + line("GET /reports/42", "tests/capabilities/reports/reports.test.ts"),
    });
    const r = claims();
    expect(r.code).toBe(1);
    const xml = report();
    expect(failed(xml, "id из журнала есть в реестре")).toBe(true);
    expect(xml).toContain("id из журнала нет в реестре: GET /reports/42 (вызовы: tests/capabilities/reports/reports.test.ts)");
    expect(failed(xml, "GET /reports/:id вызывается тестом capability")).toBe(true);
  });
});

describe("Журнал — только текущего прогона: прежние прогоны не засчитываются", () => {
  // локально журналы копятся от прогона к прогону: удалённый тест продолжал бы «вызывать» точку входа
  it("resetJournal в начале прогона стирает журналы своего каталога; журнал другого раннера в соседнем подкаталоге цел, spec-claims складывает подкаталоги", () => {
    writeTree(dir, {
      "bunfig.toml": '[test]\npreload = ["./tests/setup.ts"]\n',
      "tests/setup.ts": `import { resetJournal } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};\nresetJournal();\n`,
      "tests/capabilities/billing/billing.test.ts": `import { it } from "bun:test";
import { journal } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};
it("счёт создаётся", () => { journal("POST /invoices"); });
`,
      "entries.json": JSON.stringify(["POST /invoices", "GET /reports"]),
      ".spec-journal/unit/old.jsonl": line("GET /removed", "tests/capabilities/old/old.test.ts"),
      ".spec-journal/e2e/1.jsonl": line("GET /reports", "tests/capabilities/reports/reports.e2e.ts"),
    });
    const r = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8", env: { ...process.env, SPEC_JOURNAL: ".spec-journal/unit" } });
    expect(r.status).toBe(0);
    expect(readdirSync(path.join(dir, ".spec-journal/unit"))).not.toContain("old.jsonl");
    expect(readdirSync(path.join(dir, ".spec-journal/e2e"))).toEqual(["1.jsonl"]);
    const c = claims();
    expect(c.stderr).not.toContain("GET /removed");
    expect(c.code).toBe(0);
  });
});

describe("Точка входа без теста — исключение с задачей, пока тест не появился", () => {
  it("исключение на точку без теста — зелёное; точка, у которой тест появился, — «убери исключение»", () => {
    const EXC = "tests/standards/entry-points/exceptions";
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices", "job:cleanup", "GET /reports"]),
      [`${EXC}/job-cleanup.json`]: JSON.stringify({ item: "job:cleanup", issue: 12, reason: "тест очистки — в #12" }),
      [`${EXC}/POST-invoices.json`]: JSON.stringify({ item: "POST /invoices", issue: 13, reason: "было" }),
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts") + line("GET /reports", "tests/capabilities/reports/reports.test.ts"),
    });
    const r = claims("--exceptions", EXC);
    expect(r.code).toBe(1);
    const xml = report();
    expect(passed(xml, "исключение: job:cleanup \\(#12\\)")).toBe(true);
    expect(failed(xml, "исключение: POST /invoices \\(#13\\)")).toBe(true);
    expect(xml).toContain(`POST /invoices уже вызывается тестом capability — убери исключение: удали ${EXC}/POST-invoices.json (#13)`);
  });

  it("исключения — каталог: файл вместо каталога — код 2 и подсказка переноса", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["job:cleanup"]),
      "tests/standards/entry-points/exceptions.ts": 'export default [{ item: "job:cleanup", issue: 12, reason: "тест — в #12" }];\n',
      ".spec-journal/1.jsonl": "",
    });
    const r = claims("--exceptions", "tests/standards/entry-points/exceptions.ts");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--exceptions — каталог exceptions/ (файл на исключение), а не файл tests/standards/entry-points/exceptions.ts — перенеси командой spec-exceptions");
  });
});

describe("Сверка попадает в спеку как стандарт", () => {
  it("отчёт — JUnit в папке стандарта tests/standards/entry-points: spec-doc показывает его с описанием entry-points.md", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices"]),
      ".spec-journal/1.jsonl": line("POST /invoices", "tests/capabilities/billing/billing.test.ts"),
      "tests/standards/entry-points/entry-points.md": "Каждая точка входа вызывается тестом capability.\n",
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
