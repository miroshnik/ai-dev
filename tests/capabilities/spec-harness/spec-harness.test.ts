/**
 * Харнесс проверок скилла `spec`: соглашение о коде или поведении проекта проверяется механически, а тесты
 * проверки попадают в отчёт раннера и в спеку так же, как обычные.
 *
 * Соглашение о поведении («каждая мутация пишет аудит») проверяется не на одном примере, а на каждом элементе
 * реестра, который берётся из кода: новый элемент не проскочит мимо. Пустой реестр и проверка, прошедшая на
 * заведомом нарушителе, — упавшие тесты: такая проверка ничего не проверяет.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import type { It } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// `it` раннера подменяется сборщиком: харнесс только регистрирует тесты, запускать их — дело раннера
function collect(register: (it: It) => void): { name: string; run: () => Promise<string> }[] {
  const tests: { name: string; run: () => Promise<string> }[] = [];
  register((name, fn) => {
    tests.push({
      name,
      run: async () => {
        try {
          await fn();
          return "✓";
        } catch (e) {
          return "✗ " + (e as Error).message;
        }
      },
    });
  });
  return tests;
}

async function outcomes(register: (it: It) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of collect(register)) out[t.name] = await t.run();
  return out;
}

interface Mutation {
  name: string;
  audits: boolean;
}

const mustAudit = (m: Mutation) => {
  if (!m.audits) throw new Error(`${m.name} не пишет аудит`);
};
const violator = { name: "мутация без записи аудита", item: { name: "fake", audits: false } };

describe("Соглашение проверяется на каждом элементе реестра из кода, а не на одном примере", () => {
  it("по тесту на элемент с названием-утверждением о нём; нарушающий элемент — упавший тест с причиной", async () => {
    const items = [
      { name: "createInvoice", audits: true },
      { name: "deleteDraft", audits: false },
    ];
    const r = await outcomes((it) =>
      invariant(it, { registry: "мутации", items, name: (m) => `${m.name} пишет запись аудита`, check: mustAudit, violator }),
    );
    expect(r["createInvoice пишет запись аудита"]).toBe("✓");
    expect(r["deleteDraft пишет запись аудита"]).toBe("✗ deleteDraft не пишет аудит");
  });

  // Опечатка в пути или выборке даёт пустой реестр — и зелёную проверку, которая ничего не проверяет
  it("пустой реестр — упавший тест «реестр … не пуст»", async () => {
    const r = await outcomes((it) =>
      invariant(it, { registry: "мутации", items: [], name: (m: Mutation) => m.name, check: mustAudit, violator }),
    );
    expect(r["реестр «мутации» не пуст"]).toStartWith("✗ реестр «мутации» пуст");
  });

  it("проверка, которая прошла на заведомом нарушителе, — упавший тест: она ничего не проверяет", async () => {
    const items = [{ name: "createInvoice", audits: true }];
    const lax = await outcomes((it) =>
      invariant(it, { registry: "мутации", items, name: (m) => m.name, check: () => {}, violator }),
    );
    expect(lax["нарушитель не проходит: мутация без записи аудита"]).toStartWith("✗ проверка прошла на нарушителе");
    const strict = await outcomes((it) => invariant(it, { registry: "мутации", items, name: (m) => m.name, check: mustAudit, violator }));
    expect(strict["нарушитель не проходит: мутация без записи аудита"]).toBe("✓");
    expect(strict["реестр «мутации» не пуст"]).toBe("✓");
  });

  // readdirSync отдаёт файлы в порядке файловой системы: на macOS и Linux он разный, и docs/spec в CI расходился
  // с собранным локально (#74)
  it("тесты элементов идут по названию, а не в порядке реестра: спека одинакова на любой машине", () => {
    const names = (items: Mutation[]) =>
      collect((it) => invariant(it, { registry: "мутации", items, name: (m) => m.name, check: mustAudit, violator }))
        .map((t) => t.name)
        .slice(2);
    expect(names([{ name: "b", audits: true }, { name: "a", audits: true }])).toEqual(["a", "b"]);
    expect(names([{ name: "a", audits: true }, { name: "b", audits: true }])).toEqual(["a", "b"]);
  });

  it("названия тестов без счётчиков: реестр растёт — меняются только тесты новых элементов", async () => {
    const one = collect((it) => invariant(it, { registry: "мутации", items: [{ name: "a", audits: true }], name: (m) => m.name, check: mustAudit, violator }));
    const two = collect((it) =>
      invariant(it, { registry: "мутации", items: [{ name: "a", audits: true }, { name: "b", audits: true }], name: (m) => m.name, check: mustAudit, violator }),
    );
    expect(two.map((t) => t.name).filter((n) => !one.some((t) => t.name === n))).toEqual(["b"]);
  });
});

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

// Файл теста проекта: реестр из файлов каталога, соглашение — «экспортирует default»
const fixture = (importIt: string) => `${importIt}
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { invariant } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};

const root = path.join(import.meta.dirname, "handlers");
const items = readdirSync(root).sort().map((f) => ({ file: f, text: readFileSync(path.join(root, f), "utf8") }));
describe("каждый обработчик экспортирует default", () => {
  invariant(it, {
    registry: "обработчики",
    items,
    name: (h) => h.file + " экспортирует default",
    check: (h) => { if (!/export default/.test(h.text)) throw new Error(h.file + ": нет export default"); },
    violator: { name: "обработчик без export default", item: { file: "fake.ts", text: "export const x = 1;" } },
  });
});
`;

const handlers = { "handlers/a.ts": "export default () => 1;\n", "handlers/b.ts": "export const b = 2;\n" };

/**
 * Харнесс не зависит от раннера: `it` передаёт тест. Проекты гоняют Vitest под Node, ai-dev — bun test; тесты
 * проверки видны в отчёте раннера, а значит и в спеке.
 */
describe("Тесты проверки — в отчёте любого раннера: bun test, Vitest, node:test", () => {
  it("bun test: по тесту на обработчик, нарушитель и «не пуст» — в отчёте, нарушающий обработчик падает", () => {
    writeTree(dir, { ...handlers, "handlers.test.ts": fixture('import { describe, it } from "bun:test";') });
    const r = spawnSync("bun", ["test", "--reporter=junit", "--reporter-outfile=r.xml"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    const xml = readFileSync(path.join(dir, "r.xml"), "utf8");
    for (const name of ["a.ts экспортирует default", "b.ts экспортирует default", "реестр «обработчики» не пуст", "нарушитель не проходит: обработчик без export default"]) {
      expect(xml).toContain(`name="${name}"`);
    }
    expect(xml).toMatch(/name="b\.ts экспортирует default"[^>]*>\s*<failure/);
    expect(xml).not.toMatch(/name="a\.ts экспортирует default"[^>]*>\s*<failure/);
  });

  it("node:test под Node без Bun: те же тесты, нарушающий обработчик падает", () => {
    writeTree(dir, { ...handlers, "handlers.test.ts": fixture('import { describe, it } from "node:test";') });
    const r = spawnSync("node", ["--test", "--test-reporter=tap", "handlers.test.ts"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ok 1 - реестр «обработчики» не пуст");
    expect(r.stdout).toContain("ok 2 - нарушитель не проходит: обработчик без export default");
    expect(r.stdout).toContain("ok 3 - a.ts экспортирует default");
    expect(r.stdout).toContain("not ok 4 - b.ts экспортирует default");
  });
});
