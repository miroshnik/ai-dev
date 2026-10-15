import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { codeFiles, deadCode, envVars, examples, invariant, lintExceptions, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { It } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, setLanguage, tmpDir, writeTree } from "../../lib/spec.ts";

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
    expect(r["реестр «мутации» не пуст"]).toStartWith("✗ registry «мутации» is empty");
  });

  it("проверка, которая прошла на заведомом нарушителе, — упавший тест: она ничего не проверяет", async () => {
    const items = [{ name: "createInvoice", audits: true }];
    const lax = await outcomes((it) =>
      invariant(it, { registry: "мутации", items, name: (m) => m.name, check: () => {}, violator }),
    );
    expect(lax["нарушитель не проходит: мутация без записи аудита"]).toStartWith("✗ the check passed on violator");
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
    expect(r["вне охвата: gone"]).toStartWith("✗ element gone is not in registry «формы» — remove from scope");
  });

  it("обязательный элемент пропал из реестра — проверка красная", async () => {
    const r = await outcomes((it) => invariant(it, { registry: "формы", items: forms, key: byNameKey, name: (m) => m.name, check: mustAudit, violator, includes: ["invoice", "signup"] }));
    expect(r["реестр «формы» находит invoice, signup"]).toStartWith("✗ registry «формы» lacks: signup");
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
    expect(r["нарушитель не проходит: без проверки на сервере"]).toStartWith("✗ the check passed on violator");
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

  // конфиг в корне пакета (vite.config.ts) — исходник, как src/: его каталог целиком — не код
  it("codeFiles и sources берут и отдельные файлы — конфиги в корне пакета", () => {
    writeTree(dir, { "src/a.ts": "export {};\n", "vite.config.ts": "export default {};\n", "README.md": "# x\n", "scripts/run.ts": "export {};\n" });
    expect(codeFiles(dir, ["src", "vite.config.ts", "README.md", "missing.ts"])).toEqual(["src/a.ts", "vite.config.ts"]);
    expect(sources(dir, ["vite.config.ts"]).map((x) => x.file)).toEqual(["vite.config.ts"]);
  });
});

let dir: string;
let cleanup: () => void;
// проект на ru: тесты файла ждут русские названия, без манифеста проект — en
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  setLanguage(dir, "ru");
});
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
 * Харнесс не зависит от раннера: `it` передаёт тест. Проекты гоняют Vitest под Node, Elves — bun test; тесты
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

/** Названия тестов, которые харнесс регистрирует в каталоге проекта `cwd` (раннер идёт из него). */
function namesIn(cwd: string, register: (it: It) => void): string[] {
  const back = process.cwd();
  process.chdir(cwd);
  try {
    return collect(register).map((t) => t.name);
  } finally {
    process.chdir(back);
  }
}

/**
 * Тесты, которые порождает харнесс, стоят в спеке проекта рядом с его собственными — они на языке проекта
 * (`language` в `.agents/elves.json` каталога, из которого идёт раннер). Язык читается при регистрации тестов, а не
 * при загрузке харнесса: один процесс гоняет тесты разных проектов.
 */
describe("Харнесс называет свои тесты на языке проекта", () => {
  it("харнесс в проекте на en называет свои тесты по-английски", () => {
    setLanguage(dir, "en");
    const items = [
      { name: "createInvoice", audits: true },
      { name: "importLegacy", audits: false },
    ];
    const names = namesIn(dir, (it) =>
      invariant(it, {
        registry: "mutations",
        items,
        name: (m) => `${m.name} writes an audit record`,
        key: (m) => m.name,
        check: mustAudit,
        violator: { name: "a mutation without an audit record", item: { name: "fake", audits: false } },
        includes: ["createInvoice"],
        outside: [{ item: "login", reason: "no user yet" }],
        exceptions: [{ item: "importLegacy", issue: 12, reason: "audit in #12" }],
      }),
    );
    expect(names).toEqual([
      "registry «mutations» is not empty",
      "registry «mutations» finds createInvoice",
      "violator does not pass: a mutation without an audit record",
      "createInvoice writes an audit record",
      "outside scope: login",
      "exception: importLegacy (#12)",
    ]);
  });

  it("примеры правила, отключения линта, код без потребителя и переменные окружения в проекте на en — по-английски", () => {
    setLanguage(dir, "en");
    writeTree(dir, {
      "src/a.ts": "// eslint-disable-next-line -- #12 a legacy log\nconsole.log(process.env.API_KEY);\n",
      "knip.json": JSON.stringify({ issues: [], configurationHints: [] }),
    });
    const linter = { lint: async () => [] };
    const names = namesIn(dir, (it) => {
      examples(it, {
        linter,
        rule: "no-console",
        bad: [],
        good: [{ name: "a logger in the domain", path: "src/b.ts", code: "log(1);" }],
        outside: [{ name: "console in a build script", path: "scripts/build.ts", code: "console.log(1);" }],
      });
      lintExceptions(it, { root: dir });
      deadCode(it, { root: dir, report: "knip.json", production: true });
      envVars(it, { root: dir, declared: ["API_KEY", "OLD_KEY"], ignore: ["DEBUG"] });
    });
    expect(names).toEqual([
      "rule no-console has a «not allowed» example",
      "allowed: a logger in the domain",
      "outside scope: console in a build script",
      "there are code files in src",
      "exceptions in src/a.ts: all rules (#12)",
      "no files without a consumer (production)",
      "no exports without a consumer (production)",
      "no types without a consumer (production)",
      "no dependencies without an import (production)",
      "no imports of unlisted packages (production)",
      "no unresolved imports (production)",
      "no enum members without a consumer (production)",
      "no namespace members without a consumer (production)",
      "no duplicate exports (production)",
      "no calls to unlisted binaries (production)",
      "no unused catalog entries (production)",
      "no references to missing catalog entries (production)",
      "all knip findings are of known kinds (production)",
      "no knip configuration hints (production)",
      "outside scope without a reason: DEBUG",
      "registry «environment variables in the code» is not empty",
      "violator does not pass: a variable without a declaration",
      "API_KEY is declared",
      "registry «declared environment variables» is not empty",
      "violator does not pass: declared and not read",
      "API_KEY is read in the code",
      "OLD_KEY is read in the code",
    ]);
  });
});
