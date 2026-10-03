import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { eslintLinter, exceptionsIn, invariant, lintExceptions } from "../../../skills/spec/scripts/harness.ts";
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
 * Исключение — долг с задачей, которая его снимет: оно записано явно (файл в `exceptions/` папки решения), и как только
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
    expect(r["исключение: createInvoice (#13)"]).toBe("✗ createInvoice уже соблюдает соглашение — убери исключение (#13)");
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

const exception = (item: string, issue: number, reason: string, rule?: string) => JSON.stringify({ item, ...(rule ? { rule } : {}), issue, reason }, null, 2) + "\n";
const AUDIT = "tests/standards/audit";

/** Проект с тестом стандарта: харнесс — из скилла, исключения — тем, что даёт `head` (импорт или exceptionsIn). */
const auditTest = (head: string, exceptions: string) => `import { it } from "bun:test";
import { exceptionsIn, invariant } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};
${head}
invariant(it, {
  registry: "мутации",
  items: ["createInvoice", "importLegacy"],
  name: (m) => m + " пишет аудит",
  key: (m) => m,
  check: (m) => { if (m === "importLegacy") throw new Error("нет аудита"); },
  violator: { name: "без аудита", item: "importLegacy" },
  exceptions: ${exceptions},
});
`;

/** bun test в проекте (`files` — только эти файлы тестов): имя теста → «✓» или «✗ сообщение» из JUnit-отчёта. */
function bunTest(...files: string[]): Record<string, string> {
  spawnSync("bun", ["test", ...files.map((f) => `./${f}`), "--reporter=junit", "--reporter-outfile=r.xml"], { cwd: dir, encoding: "utf8" });
  const xml = readFileSync(path.join(dir, "r.xml"), "utf8");
  const out: Record<string, string> = {};
  const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
  for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const failure = /<failure[^>]*message="([^"]*)"/.exec(m[3] ?? "")?.[1];
    out[unescape(m[1]!)] = failure === undefined ? "✓" : "✗ " + unescape(failure);
  }
  return out;
}

/**
 * Исключения папки решения — каталог `exceptions/`, файл на исключение: подзадачи разбора долга параллельно убирают
 * каждая своё исключение, и удаление своего файла ни с чем не конфликтует — в одном массиве каждая следующая получала
 * конфликт соседних строк и повторный прогон CI.
 */
describe("Исключения папки решения — файл на элемент: параллельные PR не правят один файл", () => {
  it("исключение — файл в каталоге exceptions/ папки решения: exceptionsIn собирает каталог", () => {
    writeTree(dir, {
      [`${AUDIT}/audit.test.ts`]: auditTest("", "exceptionsIn()"),
      [`${AUDIT}/exceptions/importLegacy.json`]: exception("importLegacy", 12, "импорт старых данных — аудит в #12"),
    });
    const r = bunTest();
    expect(r["исключение: importLegacy (#12)"]).toBe("✓");
    expect(r["createInvoice пишет аудит"]).toBe("✓");
    expect(r["importLegacy пишет аудит"]).toBeUndefined();
  });

  it("исключение, которое больше не нарушает, — упавший тест «убери исключение» с путём файла", async () => {
    writeTree(dir, {
      [`${AUDIT}/exceptions/importLegacy.json`]: exception("importLegacy", 12, "аудит в #12"),
      [`${AUDIT}/exceptions/createInvoice.json`]: exception("createInvoice", 13, "было давно"),
    });
    const list = exceptionsIn(path.join(dir, AUDIT));
    expect(list.map((e) => [e.item, e.issue, path.relative(dir, e.file!)])).toEqual([
      ["createInvoice", 13, `${AUDIT}/exceptions/createInvoice.json`],
      ["importLegacy", 12, `${AUDIT}/exceptions/importLegacy.json`],
    ]);
    const r = await run(list);
    expect(r["исключение: importLegacy (#12)"]).toBe("✓");
    expect(r["исключение: createInvoice (#13)"]).toBe(`✗ createInvoice уже соблюдает соглашение — убери исключение: удали ${path.join(dir, AUDIT, "exceptions/createInvoice.json")} (#13)`);
  });

  it("два файла на один элемент — ошибка с путями обоих", () => {
    writeTree(dir, {
      [`${AUDIT}/exceptions/a.json`]: exception("importLegacy", 12, "аудит в #12"),
      [`${AUDIT}/exceptions/b.json`]: exception("importLegacy", 14, "ещё раз"),
      [`${AUDIT}/exceptions/c.json`]: exception("importLegacy", 15, "другое соглашение", "cancel"),
    });
    expect(() => exceptionsIn(path.join(dir, AUDIT))).toThrow(`исключение importLegacy — в двух файлах: ${path.join(dir, AUDIT, "exceptions/a.json")}, ${path.join(dir, AUDIT, "exceptions/b.json")} — оставь один`);
  });

  it("файл в exceptions/ — не JSON-исключение { item, issue, reason }: ошибка с путём файла", () => {
    writeTree(dir, { [`${AUDIT}/exceptions/importLegacy.ts`]: 'export default { item: "importLegacy" };\n' });
    expect(() => exceptionsIn(path.join(dir, AUDIT))).toThrow(`${AUDIT}/exceptions/importLegacy.ts: исключение — файл <элемент>.json`);
    writeTree(dir, { "tests/standards/other/exceptions/x.json": '{ "issue": 1 }' });
    expect(() => exceptionsIn(path.join(dir, "tests/standards/other"))).toThrow("tests/standards/other/exceptions/x.json: исключение — { item, issue, reason }");
  });

  it("exceptions.ts в папке решения — упавший тест с подсказкой команды переноса", () => {
    writeTree(dir, {
      [`${AUDIT}/audit.test.ts`]: auditTest('import exceptions from "./exceptions.ts";', "exceptions"),
      [`${AUDIT}/exceptions.ts`]: 'export default [{ item: "importLegacy", issue: 12, reason: "аудит в #12" }];\n',
    });
    const r = bunTest();
    expect(r["исключение: importLegacy (#12)"]).toBe("✓");
    expect(r["исключения — файлом на элемент в exceptions/, а не в exceptions.ts"]).toBe(
      `✗ ${AUDIT}/exceptions.ts: исключения — файл на элемент в ${AUDIT}/exceptions/ — перенеси командой spec-exceptions: node .agents/skills/spec/scripts/spec-exceptions.ts`,
    );
  });

  // каталог один на папку решения: exceptionsIn() теста любой подпапки читает каталог папки, а не подпапки
  it("каталог exceptions/ в подпапке папки решения — упавший тест с местом каталога, исключение из него не читается", () => {
    writeTree(dir, {
      [`${AUDIT}/sub/sub.test.ts`]: auditTest("", "exceptionsIn()"),
      [`${AUDIT}/sub/exceptions/importLegacy.json`]: exception("importLegacy", 12, "аудит в #12"),
    });
    const r = bunTest();
    expect(r["исключения — файлы <элемент>.json в exceptions/ папки решения"]).toBe(
      `✗ ${AUDIT}/sub/exceptions/importLegacy.json: исключения — только в ${AUDIT}/exceptions/ папки решения, не в подпапке`,
    );
    expect(r["importLegacy пишет аудит"]).toBe("✗ нет аудита");
  });

  it("exceptions.ts подпапки — упавший тест с подсказкой переноса в exceptions/ папки решения", () => {
    writeTree(dir, {
      [`${AUDIT}/sub/sub.test.ts`]: auditTest('import exceptions from "./exceptions.ts";', "exceptions"),
      [`${AUDIT}/sub/exceptions.ts`]: 'export default [{ item: "importLegacy", issue: 12, reason: "аудит в #12" }];\n',
    });
    const r = bunTest();
    expect(r["исключения — файлом на элемент в exceptions/, а не в exceptions.ts"]).toBe(
      `✗ ${AUDIT}/sub/exceptions.ts: исключения — файл на элемент в ${AUDIT}/exceptions/ — перенеси командой spec-exceptions: node .agents/skills/spec/scripts/spec-exceptions.ts`,
    );
  });
});

/** Тест папки: инвариант на каждое правило над одним реестром, исключения — каталог папки (`exceptionsIn`). */
const rulesTest = (...rules: string[]) => `import { it } from "bun:test";
import { exceptionsIn, invariant } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};
const exceptions = exceptionsIn();
${rules
  .map(
    (rule) => `invariant(it, {
  rule: ${JSON.stringify(rule)},
  registry: "мутации",
  items: ["createInvoice", "importLegacy"],
  name: (m) => m + " соблюдает ${rule}",
  key: (m) => m,
  check: (m) => { if (m === "importLegacy") throw new Error("нарушает ${rule}"); },
  violator: { name: "нарушитель ${rule}", item: "importLegacy" },
  exceptions,
});`,
  )
  .join("\n")}
`;
const RULES = "исключения с rule — к правилам инвариантов папки";

/**
 * Исключение с `rule` берёт только инвариант этого правила. Опечатка в `rule`, переименованное или удалённое правило —
 * и исключение не попадает ни в один тест: храповик его не видит, файл живёт вечно, долг молча выпадает из спеки.
 * Правила своего файла харнесс знает по прогону; правила других файлов папки (подпапки с общим `exceptions/`) идут в
 * другом процессе или позже — их он ищет строкой в коде этих файлов.
 */
describe("Исключение с rule — к правилу инварианта папки: опечатка не выпадает из спеки молча", () => {
  it("исключение с rule, которого нет ни у одного инварианта папки, — упавший тест с путём файла", () => {
    writeTree(dir, {
      [`${AUDIT}/audit.test.ts`]: rulesTest("audit"),
      [`${AUDIT}/exceptions/audit--importLegacy.json`]: exception("importLegacy", 12, "аудит в #12", "audit"),
      [`${AUDIT}/exceptions/audti--importLegacy.json`]: exception("importLegacy", 13, "опечатка в rule", "audti"),
      "tests/standards/plain/plain.test.ts": auditTest("", "exceptionsIn()"),
      "tests/standards/plain/exceptions/audit--importLegacy.json": exception("importLegacy", 12, "у инварианта нет rule", "audit"),
    });
    const r = bunTest(`${AUDIT}/audit.test.ts`);
    expect(r["исключение (audit): importLegacy (#12)"]).toBe("✓");
    expect(r[RULES]).toBe(`✗ ${AUDIT}/exceptions/audti--importLegacy.json: правила «audti» нет ни у одного инварианта папки (у инвариантов файла: audit) — поправь rule или удали файл`);
    const plain = bunTest("tests/standards/plain/plain.test.ts");
    expect(plain[RULES]).toBe("✗ tests/standards/plain/exceptions/audit--importLegacy.json: правила «audit» нет ни у одного инварианта папки (инварианты файла — без rule) — поправь rule или удали файл");
    expect(plain["importLegacy пишет аудит"]).toBe("✗ нет аудита");
  });

  it("исключение с rule инварианта из другого файла папки — не ошибка", () => {
    writeTree(dir, {
      [`${AUDIT}/client/client.test.ts`]: rulesTest("client"),
      [`${AUDIT}/server/server.test.ts`]: rulesTest("server"),
      [`${AUDIT}/exceptions/client--importLegacy.json`]: exception("importLegacy", 12, "клиент — в #12", "client"),
      [`${AUDIT}/exceptions/server--importLegacy.json`]: exception("importLegacy", 13, "сервер — в #13", "server"),
    });
    // файл папки отдельно — как в раннере, что изолирует файлы: правило другого файла в этом процессе не регистрируется
    const client = bunTest(`${AUDIT}/client/client.test.ts`);
    expect(client["исключение (client): importLegacy (#12)"]).toBe("✓");
    expect(client[RULES]).toBe("✓");
    expect(bunTest(`${AUDIT}/server/server.test.ts`)[RULES]).toBe("✓");
    writeTree(dir, { [`${AUDIT}/exceptions/srever--importLegacy.json`]: exception("importLegacy", 14, "опечатка", "srever") });
    expect(bunTest(`${AUDIT}/client/client.test.ts`)[RULES]).toStartWith(`✗ ${AUDIT}/exceptions/srever--importLegacy.json: правила «srever» нет`);
  });

  // сторож от перекоррекции: сверка не трогает исключения, которые берёт инвариант папки
  it("исключения с rule своих инвариантов и без rule — зелёные, как раньше", () => {
    writeTree(dir, {
      [`${AUDIT}/audit.test.ts`]: rulesTest("audit", "cancel"),
      [`${AUDIT}/exceptions/audit--importLegacy.json`]: exception("importLegacy", 12, "аудит в #12", "audit"),
      [`${AUDIT}/exceptions/cancel--importLegacy.json`]: exception("importLegacy", 13, "отмена в #13", "cancel"),
      "tests/standards/single/single.test.ts": rulesTest("audit"),
      "tests/standards/single/exceptions/importLegacy.json": exception("importLegacy", 14, "без rule — ко всем соглашениям папки"),
    });
    const r = bunTest(`${AUDIT}/audit.test.ts`);
    expect(r["исключение (audit): importLegacy (#12)"]).toBe("✓");
    expect(r["исключение (cancel): importLegacy (#13)"]).toBe("✓");
    expect(Object.entries(r).filter(([, v]) => v !== "✓")).toEqual([]);
    const single = bunTest("tests/standards/single/single.test.ts");
    expect(single["исключение (audit): importLegacy (#14)"]).toBe("✓");
    expect(single[RULES]).toBeUndefined();
  });
});

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
    expect(r["исключения в src/ok.ts: no-console (#12)"]).toBe("✓");
    expect(r["исключения в src/no-issue.ts: no-console"]).toStartWith("✗ src/no-issue.ts:1 — отключение без «-- #N причина»");
    expect(r["исключения в src/no-reason.ts: no-console"]).toStartWith("✗ src/no-reason.ts:1 — отключение без «-- #N причина»");
    expect(r["исключения в src/blanket.ts: все правила (#12)"]).toStartWith("✗ src/blanket.ts:1 — отключение без названия правила");
    expect(Object.keys(r).some((n) => n.includes("clean.ts"))).toBe(false);
  });

  // ESLint читает директивы только в комментариях: текст в строке — фикстура теста или сообщение, а не отключение
  it("отключение линта в строковом литерале — не исключение", async () => {
    writeTree(dir, {
      "src/fixture.ts": [
        'export const a = "// eslint-disable-next-line no-console -- временно";',
        "export const b = `/* eslint-disable */ ${a}`;",
        'export const c = /"/.test(a) ? "// eslint-disable-next-line no-alert" : "";',
        "f(); // регулярка после комментария — не деление (#269)",
        '/"/.test(a) ? "// eslint-disable-next-line no-alert" : "";',
      ].join("\n") + "\n",
      "src/mixed.ts": 'const url = "http://x"; // eslint-disable-line no-console -- #3 адрес\nconst s = "// eslint-disable no-alert";\n',
    });
    const r = await outcomes((it) => lintExceptions(it, { root: dir, dirs: ["src"] }));
    expect(Object.keys(r).some((n) => n.includes("fixture.ts"))).toBe(false);
    expect(r["исключения в src/mixed.ts: no-console (#3)"]).toBe("✓");
  });

  it("тест отключений линта в файле называет задачи отключений", async () => {
    writeTree(dir, { "src/a.ts": "// eslint-disable-next-line no-console -- #12 логгер\nconsole.log(1);\n// eslint-disable-next-line no-alert -- #7 диалог\nalert(1);\n" });
    const r = await outcomes((it) => lintExceptions(it, { root: dir, dirs: ["src"] }));
    expect(r["исключения в src/a.ts: no-alert, no-console (#7, #12)"]).toBe("✓");
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
