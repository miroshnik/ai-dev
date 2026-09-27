import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
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

/**
 * На реальном проекте в одной папке стандарта живут несколько соглашений над одним реестром, часть элементов
 * намеренно вне охвата, а проверка бывает из двух половин. Всё это видно в спеке, а не спрятано фильтром в коде теста.
 */
describe("Реестр + инвариант на реальном коде: несколько правил в папке, охват, обязательные элементы, нарушители", () => {
  const forms: Mutation[] = [
    { name: "invoice", audits: true },
    { name: "login", audits: false },
  ];
  const byNameKey = (m: Mutation) => m.name;

  it("исключения двух инвариантов одной папки не мешают друг другу", async () => {
    const exceptions = [
      { rule: "audit", item: "login", issue: 12, reason: "вход без аудита до #12" },
      { rule: "cancel", item: "invoice", issue: 13, reason: "отмена счёта — в #13" },
    ];
    const noCancel = (m: Mutation) => {
      if (m.name === "invoice") throw new Error("нет отмены");
    };
    const r = await outcomes((it) => {
      invariant(it, { rule: "audit", registry: "формы", items: forms, key: byNameKey, name: (m) => `${m.name} пишет аудит`, check: mustAudit, violator, exceptions });
      invariant(it, { rule: "cancel", registry: "формы", items: forms, key: byNameKey, name: (m) => `${m.name} отменяется`, check: noCancel, violator: { name: "форма без отмены", item: { name: "invoice", audits: true } }, exceptions });
    });
    expect(r["исключение (audit): login (#12)"]).toBe("✓");
    expect(r["исключение (cancel): invoice (#13)"]).toBe("✓");
    expect(Object.entries(r).filter(([, v]) => v !== "✓")).toEqual([]);
  });

  it("два инварианта в одном describe дают разные названия служебных тестов", () => {
    const names = collect((it) => {
      invariant(it, { rule: "audit", registry: "формы", items: forms, name: (m) => `${m.name} пишет аудит`, check: mustAudit, violator });
      invariant(it, { rule: "cancel", registry: "формы", items: forms, name: (m) => `${m.name} отменяется`, check: mustAudit, violator });
    }).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("реестр «формы» не пуст (audit)");
    expect(names).toContain("нарушитель не проходит (cancel): мутация без записи аудита");
  });

  it("элемент вне охвата — с причиной на странице, пропал из реестра — «убери из охвата»", async () => {
    const outside = [
      { item: "login", reason: "форма входа — аудит пишет сервис авторизации" },
      { item: "gone", reason: "удалена" },
    ];
    const r = await outcomes((it) => invariant(it, { registry: "формы", items: forms, key: byNameKey, name: (m) => `${m.name} пишет аудит`, check: mustAudit, violator, outside }));
    expect(r["вне охвата: login"]).toBe("✓");
    expect(r["login пишет аудит"]).toBeUndefined();
    expect(r["вне охвата: gone"]).toStartWith("✗ элемента gone в реестре «формы» нет — убери из охвата");
  });

  it("обязательный элемент пропал из реестра — проверка красная", async () => {
    const r = await outcomes((it) => invariant(it, { registry: "формы", items: forms, key: byNameKey, name: (m) => m.name, check: mustAudit, violator, includes: ["invoice", "signup"] }));
    expect(r["реестр «формы» находит invoice, signup"]).toStartWith("✗ в реестре «формы» нет: signup");
  });

  it("каждый из нескольких нарушителей валит проверку", async () => {
    // проверка из двух половин — клиент и сервер; сервер проверка забыла
    type Form = { name: string; client: boolean; server: boolean };
    const clientOnly = (f: Form) => {
      if (!f.client) throw new Error("нет проверки на клиенте");
    };
    const r = await outcomes((it) =>
      invariant(it, {
        registry: "формы",
        items: [{ name: "invoice", client: true, server: true }],
        name: (f) => f.name,
        check: clientOnly,
        violator: [
          { name: "без проверки на клиенте", item: { name: "x", client: false, server: true } },
          { name: "без проверки на сервере", item: { name: "y", client: true, server: false } },
        ],
      }),
    );
    expect(r["нарушитель не проходит: без проверки на клиенте"]).toBe("✓");
    expect(r["нарушитель не проходит: без проверки на сервере"]).toStartWith("✗ проверка прошла на нарушителе");
  });

  it("реестр из исходников читает текст лениво, нарушитель — текстом", async () => {
    writeTree(dir, { "src/a.ts": "export default 1;\n", "src/b.ts": "export const b = 1;\n" });
    const items = sources(dir, ["src"]);
    expect(items.map((x) => x.file)).toEqual(["src/a.ts", "src/b.ts"]);
    // текст читается при проверке, а не при сборе реестра
    writeTree(dir, { "src/a.ts": "export default 2;\n" });
    expect(items[0]!.text).toBe("export default 2;\n");
    const r = await outcomes((it) =>
      invariant(it, {
        registry: "обработчики",
        items,
        key: (x) => x.file,
        name: (x) => `${x.file} экспортирует default`,
        check: (x) => {
          if (!/export default/.test(x.text)) throw new Error("нет default");
        },
        violator: { name: "обработчик без default", item: source("src/fake.ts", "export const x = 1;\n") },
      }),
    );
    expect(r["нарушитель не проходит: обработчик без default"]).toBe("✓");
    expect(r["src/b.ts экспортирует default"]).toBe("✗ нет default");
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
