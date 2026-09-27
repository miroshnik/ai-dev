import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { eslintLinter, invariant, lintExceptions } from "../../../skills/spec/scripts/harness.ts";
import type { Exception, It } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// `it` раннера подменяется сборщиком: харнесс только регистрирует тесты, запускать их — дело раннера
async function outcomes(register: (it: It) => void): Promise<Record<string, string>> {
  const tests: [string, () => void | Promise<unknown>][] = [];
  register((name, fn) => tests.push([name, fn]));
  const out: Record<string, string> = {};
  for (const [name, fn] of tests) {
    try {
      await fn();
      out[name] = "✓";
    } catch (e) {
      out[name] = "✗ " + (e as Error).message;
    }
  }
  return out;
}

interface Mutation {
  name: string;
  audits: boolean;
}
const items: Mutation[] = [
  { name: "createInvoice", audits: true },
  { name: "importLegacy", audits: false },
];
const run = (exceptions: Exception[]) =>
  outcomes((it) =>
    invariant(it, {
      registry: "мутации",
      items,
      name: (m) => `${m.name} пишет запись аудита`,
      key: (m) => m.name,
      check: (m) => {
        if (!m.audits) throw new Error(`${m.name} не пишет аудит`);
      },
      violator: { name: "мутация без аудита", item: { name: "fake", audits: false } },
      exceptions,
    }),
  );

/**
 * Исключение — долг с задачей, которая его снимет: оно записано явно (`exceptions.ts` в папке решения), и как только
 * элемент начал соблюдать соглашение, проверка требует убрать исключение — долг только уменьшается.
 */
describe("Исключение из соглашения — явное, с задачей, и уходит, когда больше не нужно", () => {
  it("исключённый элемент, который нарушает соглашение, — зелёный тест «исключение: …» вместо обычного", async () => {
    const r = await run([{ item: "importLegacy", issue: 12, reason: "импорт старых данных — аудит в #12" }]);
    expect(r["исключение: importLegacy (#12)"]).toBe("✓");
    expect(r["importLegacy пишет запись аудита"]).toBeUndefined();
    expect(r["createInvoice пишет запись аудита"]).toBe("✓");
  });

  it("исключённый элемент, который уже соблюдает соглашение, — упавший тест «убери исключение»", async () => {
    const r = await run([
      { item: "importLegacy", issue: 12, reason: "аудит в #12" },
      { item: "createInvoice", issue: 13, reason: "было давно" },
    ]);
    expect(r["исключение: createInvoice (#13)"]).toStartWith("✗ createInvoice уже соблюдает соглашение — убери исключение из exceptions.ts");
  });

  it("исключение без задачи или без причины — упавший тест", async () => {
    const r = await run([
      { item: "importLegacy", issue: 0, reason: "потом" },
      { item: "createInvoice", issue: 13, reason: "" },
    ]);
    expect(r["исключение: importLegacy (#0)"]).toStartWith("✗ у исключения importLegacy нет задачи");
    expect(r["исключение: createInvoice (#13)"]).toStartWith("✗ у исключения createInvoice нет причины");
  });

  it("исключение на элемент, которого нет в реестре, — упавший тест", async () => {
    const r = await run([
      { item: "importLegacy", issue: 12, reason: "аудит в #12" },
      { item: "deletedMutation", issue: 14, reason: "удалена" },
    ]);
    expect(r["исключение: deletedMutation (#14)"]).toStartWith("✗ элемента deletedMutation в реестре «мутации» нет — убери исключение");
  });
});

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

/**
 * Исключение из линт-правила — отключение в коде, там, где нарушение: с названием правила и задачей, которая его
 * снимет. Общий `eslint-disable` без правил глушит и правило, проверяющее директивы, поэтому формат проверяет тест.
 */
describe("Отключение линт-правила в коде — исключение с задачей, и уходит, когда больше не нужно", () => {
  it("отключение с правилом и «-- #N причина» — зелёный тест файла; без задачи, без причины или без правила — упавший", async () => {
    writeTree(dir, {
      "src/ok.ts": "// eslint-disable-next-line no-console -- #12 логгер в #12\nconsole.log(1);\n",
      "src/no-issue.ts": "// eslint-disable-next-line no-console -- временно\nconsole.log(1);\n",
      "src/no-reason.ts": "console.log(1); // eslint-disable-line no-console\n",
      "src/blanket.ts": "/* eslint-disable -- #12 всё сразу */\nconsole.log(1);\n",
      "src/clean.ts": "export const x = 1;\n",
    });
    const r = await outcomes((it) => lintExceptions(it, { root: dir, dirs: ["src"] }));
    expect(r["исключения в src/ok.ts: no-console"]).toBe("✓");
    expect(r["исключения в src/no-issue.ts: no-console"]).toStartWith("✗ src/no-issue.ts:1 — отключение без «-- #N причина»");
    expect(r["исключения в src/no-reason.ts: no-console"]).toStartWith("✗ src/no-reason.ts:1 — отключение без «-- #N причина»");
    expect(r["исключения в src/blanket.ts: все правила"]).toStartWith("✗ src/blanket.ts:1 — отключение без названия правила");
    expect(Object.keys(r).some((n) => n.includes("clean.ts"))).toBe(false);
  });

  it("файлов кода не нашлось — упавший тест: путь ошибочен", async () => {
    const r = await outcomes((it) => lintExceptions(it, { root: dir, dirs: ["srcc"] }));
    expect(r["в srcc есть файлы кода"]).toStartWith("✗");
  });

  it("отключение, которое больше ничего не глушит, — ошибка lint: храповик встроен в конфиг collectEslint", async () => {
    writeTree(dir, {
      "package.json": JSON.stringify({ name: "app", type: "module" }),
      "eslint.config.mjs": `import { collectEslint } from ${JSON.stringify(path.join(SCRIPTS, "eslint-config.ts"))};\nexport default [{ rules: { "no-console": "error" } }, ...(await collectEslint(import.meta.dirname))];\n`,
    });
    const linter = eslintLinter({ cwd: dir, module: createRequire(import.meta.url).resolve("eslint") });
    const stale = await linter.lint("// eslint-disable-next-line no-console -- #12 x\nexport const a = 1;\n", "src/a.js");
    expect(stale.map((m) => m.message).join("\n")).toContain("Unused eslint-disable directive");
    const used = await linter.lint("// eslint-disable-next-line no-console -- #12 x\nconsole.log(1);\n", "src/b.js");
    expect(used).toEqual([]);
  });
});
