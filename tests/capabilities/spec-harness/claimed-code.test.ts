import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { configGet, deadCode, dotenvNames, ENV_SERVICE, envNamesIn, envNamesInCode, envVars } from "../../../skills/spec/scripts/harness.ts";
import type { It } from "../../../skills/spec/scripts/harness.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// TypeScript и типы Node — из devDependencies ai-dev: во временном каталоге фикстуры своего node_modules нет
const TSC = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
const TYPES = path.join(path.dirname(createRequire(import.meta.url).resolve("@types/node/package.json")), "..");

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

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

// отчёт `knip --reporter json`: issues — по файлу, в каждом — ключи видов (knip.dev, «Reporters»)
const knip = (issues: object[]) => JSON.stringify({ issues });
// вторая строка вывода — подсказки конфигурации от репортера скилла
const HINTS = path.join(SCRIPTS, "knip-hints.cjs");
const hints = (list: object[]) => JSON.stringify({ configurationHints: list });

/**
 * Код без потребителя — мёртвый: файл, экспорт или зависимость, до которых не доходит ни одна точка входа, knip
 * находит по графу импортов. Его отчёт становится тестами: находка — упавший тест, исключение — с задачей и
 * храповиком.
 */
describe("Код, до которого не доходит ни одна точка входа, — упавший тест (knip)", () => {
  it("файл, экспорт и зависимость без потребителя — упавшие тесты своих видов; чисто — зелёные", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "src/legacy.ts", files: [{ name: "src/legacy.ts" }] },
        { file: "src/math.ts", exports: [{ name: "factorial", line: 12, col: 14 }] },
        { file: "package.json", dependencies: [{ name: "lodash" }] },
      ]),
    });
    const r = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json" }));
    expect(r["нет файлов без потребителя"]).toBe("✗ src/legacy.ts");
    expect(r["нет экспортов без потребителя"]).toBe("✗ src/math.ts#factorial");
    expect(r["нет зависимостей без импорта"]).toBe("✗ package.json#lodash");
    expect(r["нет типов без потребителя"]).toBe("✓");
    expect(r["нет импортов неустановленных пакетов"]).toBe("✓");
    expect(r["все находки knip — известных видов"]).toBe("✓");
  });

  // монорепо: один пакет в двух воркспейсах — две находки; ключ без файла закрыл бы обе и спрятал новую
  it("ключ зависимости, неустановленного пакета и бинарника — с файлом воркспейса: исключение в одном воркспейсе не прячет находку в другом", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "packages/a/package.json", dependencies: [{ name: "lodash" }], binaries: [{ name: "tsx" }] },
        { file: "packages/b/package.json", dependencies: [{ name: "lodash" }], binaries: [{ name: "tsx" }] },
        { file: "packages/a/src/x.ts", unlisted: [{ name: "zod" }] },
        { file: "packages/b/src/y.ts", unlisted: [{ name: "zod" }] },
      ]),
    });
    const r = await outcomes((it) =>
      deadCode(it, {
        root: dir,
        report: ".knip.json",
        exceptions: [
          { item: "dependency:packages/a/package.json#lodash", issue: 1, reason: "уберём с модулем a" },
          { item: "unlisted:packages/a/src/x.ts#zod", issue: 2, reason: "zod — в #2" },
          { item: "binary:packages/a/package.json#tsx", issue: 3, reason: "tsx — в #3" },
        ],
      }),
    );
    expect(r["нет зависимостей без импорта"]).toBe("✗ packages/b/package.json#lodash");
    expect(r["нет импортов неустановленных пакетов"]).toBe("✗ packages/b/src/y.ts#zod");
    expect(r["нет вызовов неустановленных бинарников"]).toBe("✗ packages/b/package.json#tsx");
    expect(r["исключение: dependency:packages/a/package.json#lodash (#1)"]).toBe("✓");
    expect(r["исключение: unlisted:packages/a/src/x.ts#zod (#2)"]).toBe("✓");
    expect(r["исключение: binary:packages/a/package.json#tsx (#3)"]).toBe("✓");
  });

  it("исключение со старым ключом без файла — упавший тест с ключами на замену", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "packages/a/package.json", dependencies: [{ name: "lodash" }] },
        { file: "packages/b/package.json", dependencies: [{ name: "lodash" }] },
      ]),
    });
    const r = await outcomes((it) =>
      deadCode(it, {
        root: dir,
        report: ".knip.json",
        exceptions: [
          { item: "dependency:lodash", issue: 4, reason: "старый ключ" },
          { item: "binary:tsx", issue: 5, reason: "старый ключ, бинарник уже вызывается" },
        ],
      }),
    );
    expect(r["исключение: dependency:lodash (#4)"]).toBe(
      "✗ ключ dependency:lodash — без файла: исключение закрыло бы lodash во всех воркспейсах — переименуй в dependency:packages/a/package.json#lodash, dependency:packages/b/package.json#lodash (#4)",
    );
    expect(r["исключение: binary:tsx (#5)"]).toStartWith("✗ knip больше не находит binary:tsx — убери исключение");
    expect(r["нет зависимостей без импорта"]).toBe("✗ packages/a/package.json#lodash\npackages/b/package.json#lodash");
  });

  it("ссылка catalog: на отсутствующую запись каталога — упавший тест", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "packages/a/package.json", catalogReferences: [{ name: "react", namespace: "react18" }] },
        { file: "pnpm-workspace.yaml", catalog: [{ name: "vue", namespace: "default" }] },
      ]),
    });
    const r = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json" }));
    expect(r["нет ссылок на отсутствующие записи каталога пакетов"]).toBe("✗ packages/a/package.json#react18.react");
    expect(r["нет лишних записей каталога пакетов"]).toBe("✗ pnpm-workspace.yaml#default.vue");
  });

  // knip 6 добавил виды (catalogReferences, cycles), а харнесс их не знал: находка пропадала из отчёта без следа
  it("находка вида, которого харнесс не знает, — упавший тест, а не молчание", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "src/a.ts", owners: [{ name: "@team" }], exports: [], cycles: [[{ name: "src/a.ts" }, { name: "src/b.ts" }]] },
        { file: "src/c.ts", cycles: [] },
      ]),
    });
    const r = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json" }));
    expect(r["все находки knip — известных видов"]).toBe("✗ knip нашёл то, чего харнесс не разбирает: cycles (src/a.ts) — убери вид из запуска knip (--exclude) или обнови скилл spec");
    expect(r["нет экспортов без потребителя"]).toBe("✓");
  });

  it("исключение — зелёное, пока knip его находит; перестал находить — «убери исключение»", async () => {
    writeTree(dir, { ".knip.json": knip([{ file: "src/legacy.ts", files: [{ name: "src/legacy.ts" }] }]) });
    const r = await outcomes((it) =>
      deadCode(it, {
        root: dir,
        report: ".knip.json",
        exceptions: [
          { item: "file:src/legacy.ts", issue: 12, reason: "удалим после миграции в #12" },
          { item: "export:src/math.ts#factorial", issue: 13, reason: "было" },
        ],
      }),
    );
    expect(r["нет файлов без потребителя"]).toBe("✓");
    expect(r["исключение: file:src/legacy.ts (#12)"]).toBe("✓");
    expect(r["исключение: export:src/math.ts#factorial (#13)"]).toStartWith("✗ knip больше не находит export:src/math.ts#factorial — убери исключение");
  });

  it("без отчёта — knip проекта запускается сам (node_modules/.bin/knip --reporter json)", async () => {
    writeTree(dir, {
      "node_modules/.bin/knip": `#!/bin/sh\necho '${knip([{ file: "src/old.ts", files: [{ name: "src/old.ts" }] }])}'\nexit 1\n`,
    });
    chmodSync(path.join(dir, "node_modules/.bin/knip"), 0o755);
    const r = await outcomes((it) => deadCode(it, { root: dir }));
    expect(r["нет файлов без потребителя"]).toBe("✗ src/old.ts");
  });

  // knip выходит с 0 (чисто) или 1 (есть находки); иное — сбой, и пустой вывод не значит «мёртвого кода нет»
  it("knip упал или вывел не JSON — упавший тест с причиной, а не зелёный", async () => {
    const fake = (script: string) => {
      writeTree(dir, { "node_modules/.bin/knip": `#!/bin/sh\n${script}\n` });
      chmodSync(path.join(dir, "node_modules/.bin/knip"), 0o755);
      return outcomes((it) => deadCode(it, { root: dir }));
    };
    const crashed = await fake("echo 'ERROR: не найден tsconfig' >&2\nexit 2");
    expect(crashed["нет файлов без потребителя"]).toStartWith("✗ knip завершился с кодом 2: ERROR: не найден tsconfig");
    const garbage = await fake("echo 'Unused files (1)'\nexit 1");
    expect(garbage["нет экспортов без потребителя"]).toStartWith("✗ knip вывел не JSON");
  });

  it("аргументы knip проекта передаются запуску", async () => {
    writeTree(dir, { "node_modules/.bin/knip": `#!/bin/sh\necho "$@" > args.txt\necho '${knip([])}'\necho '${hints([])}'\n` });
    chmodSync(path.join(dir, "node_modules/.bin/knip"), 0o755);
    const r = await outcomes((it) => deadCode(it, { root: dir, args: ["--tsConfig", "tsconfig.test.json"] }));
    expect(r["нет файлов без потребителя"]).toBe("✓");
    expect(r["нет подсказок конфигурации knip"]).toBe("✓");
    expect(readFileSync(path.join(dir, "args.txt"), "utf8").trim()).toBe(`--reporter json --reporter ${HINTS} --tsConfig tsconfig.test.json`);
    await outcomes((it) => deadCode(it, { root: dir, hints: false }));
    expect(readFileSync(path.join(dir, "args.txt"), "utf8").trim()).toBe("--reporter json");
  });

  // Vitest даёт тесту 5 с, а knip монорепо идёт дольше: запуск под таймаутом первого теста обрывался
  it("knip запускается при регистрации тестов, а не под таймаутом первого теста", () => {
    writeTree(dir, { "node_modules/.bin/knip": `#!/bin/sh\ntouch ran\necho '${knip([])}'\necho '${hints([])}'\n` });
    chmodSync(path.join(dir, "node_modules/.bin/knip"), 0o755);
    const names: string[] = [];
    deadCode((name) => void names.push(name), { root: dir });
    expect(names).toContain("нет файлов без потребителя");
    expect(existsSync(path.join(dir, "ran"))).toBe(true);
  });

  it("находки knip 6: члены перечислений и пространств имён, дубли, бинарники, каталог — упавшие тесты своих видов", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "src/color.ts", enumMembers: [{ name: "Blue", namespace: "Color" }], namespaceMembers: [{ name: "helper", namespace: "Utils" }], duplicates: [[{ name: "sum" }, { name: "add" }]] },
        { file: "package.json", binaries: [{ name: "tsx" }], catalog: [{ name: "react" }] },
      ]),
    });
    const r = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json" }));
    expect(r["нет членов перечислений без потребителя"]).toBe("✗ src/color.ts#Color.Blue");
    expect(r["нет членов пространств имён без потребителя"]).toBe("✗ src/color.ts#Utils.helper");
    expect(r["нет экспортов-дублей"]).toBe("✗ src/color.ts#sum = add");
    expect(r["нет вызовов неустановленных бинарников"]).toBe("✗ package.json#tsx");
    expect(r["нет лишних записей каталога пакетов"]).toBe("✗ package.json#react");
  });
});

/**
 * Конфиг knip — тоже решение о том, что считать мёртвым: лишний `ignore` прячет будущие находки, `entry` без совпадений
 * делает мёртвым всё, до чего дошла бы точка входа. Такие места knip называет подсказками конфигурации, но в JSON-отчёт
 * их не кладёт — их печатает репортер скилла, и каждая становится находкой.
 */
describe("Подсказка конфигурации knip — упавший тест: конфиг не врёт о точках входа и исключениях", () => {
  it("подсказка конфигурации knip (лишний ignore, entry без совпадений) — упавший тест; исключение — по ключу подсказки", async () => {
    writeTree(dir, {
      ".knip.json":
        knip([]) +
        "\n" +
        hints([
          { type: "ignoreDependencies", identifier: "lodash", workspace: "packages/a" },
          { type: "entry-empty", identifier: "src/main.ts", workspace: ".", file: "knip.json" },
          { type: "ignore", identifier: "src/gen/**", workspace: "." },
        ]),
    });
    const r = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json", exceptions: [{ item: "hint:.#ignore:src/gen/**", issue: 6, reason: "генератор вернётся в #6" }] }));
    expect(r["нет подсказок конфигурации knip"]).toBe("✗ .#entry-empty:src/main.ts\npackages/a#ignoreDependencies:lodash");
    expect(r["исключение: hint:.#ignore:src/gen/** (#6)"]).toBe("✓");
  });

  it("отчёт файлом без подсказок конфигурации — упавший тест с командой, которая их добавит", async () => {
    writeTree(dir, { ".knip.json": knip([]) });
    const r = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json" }));
    // репортер — путём от корня проекта: в проекте это копия скилла, .agents/skills/spec/scripts/knip-hints.cjs
    expect(r["нет подсказок конфигурации knip"]).toBe(
      `✗ в отчёте .knip.json нет подсказок конфигурации — сформируй его: knip --reporter json --reporter ${path.relative(dir, HINTS)} > .knip.json (или hints: false)`,
    );
    expect(r["нет файлов без потребителя"]).toBe("✓");
    const off = await outcomes((it) => deadCode(it, { root: dir, report: ".knip.json", hints: false }));
    expect(off["нет подсказок конфигурации knip"]).toBeUndefined();
  });

  it("репортер подсказок печатает подсказки knip строкой JSON: тип, идентификатор, воркспейс, файл", () => {
    // так зовёт репортер knip: подсказки — как их собрал knip, путь файла абсолютный, идентификатор бывает регуляркой
    const call = `import report from ${JSON.stringify(HINTS)};
report({ cwd: "/repo", isDisableConfigHints: false, configurationHints: [
  { type: "ignore", identifier: /src\\/gen\\/.+/, workspaceName: "packages/a", filePath: "/repo/knip.json" },
  { type: "workspaces", identifier: "packages/old" },
] });`;
    const r = spawnSync("bun", ["-e", call], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      configurationHints: [
        { type: "ignore", identifier: "src/gen/.+", workspace: "packages/a", file: "knip.json" },
        { type: "workspaces", identifier: "packages/old", workspace: "." },
      ],
    });
  });
});

/**
 * Код, до которого доходят только тесты, в обычном запуске knip живой: тесты — его точки входа. Режим production
 * (`knip --production`) смотрит только код продукта — отдельный запуск со своими тестами и своими исключениями.
 */
describe("Код, до которого доходят только тесты, — находка режима production", () => {
  it("режим production — knip с --production, тесты с пометкой (production)", async () => {
    writeTree(dir, {
      "node_modules/.bin/knip": `#!/bin/sh\necho "$@" > args.txt\necho '${knip([{ file: "src/a.ts", exports: [{ name: "onlyInTests" }] }])}'\necho '${hints([])}'\n`,
    });
    chmodSync(path.join(dir, "node_modules/.bin/knip"), 0o755);
    const r = await outcomes((it) => deadCode(it, { root: dir, production: true, args: ["--strict"] }));
    expect(r["нет экспортов без потребителя (production)"]).toBe("✗ src/a.ts#onlyInTests");
    expect(r["нет экспортов без потребителя"]).toBeUndefined();
    expect(r["нет подсказок конфигурации knip (production)"]).toBe("✓");
    expect(readFileSync(path.join(dir, "args.txt"), "utf8").trim()).toBe(`--reporter json --reporter ${HINTS} --production --strict`);
  });

  // в production knip не смотрит devDependencies и тесты: храповик общего исключения там ложно требовал бы «убери»
  it("исключение с rule — только своего запуска; без rule — гасит находку во всех, храповик — у запуска без rule", async () => {
    writeTree(dir, {
      ".knip.json": knip([
        { file: "src/a.ts", exports: [{ name: "legacy" }] },
        { file: "package.json", devDependencies: [{ name: "vitest" }] },
      ]),
      ".knip-production.json": knip([{ file: "src/a.ts", exports: [{ name: "legacy" }, { name: "testOnly" }] }]),
    });
    const exceptions = [
      { item: "export:src/a.ts#legacy", issue: 1, reason: "общий долг" },
      { item: "dependency:package.json#vitest", issue: 2, reason: "тесты переезжают в #2" },
      { item: "export:src/a.ts#testOnly", issue: 3, reason: "нужен только тестам — в #3", rule: "production" },
    ];
    const r = await outcomes((it) => {
      deadCode(it, { root: dir, report: ".knip.json", exceptions, hints: false });
      deadCode(it, { root: dir, report: ".knip-production.json", production: true, exceptions, hints: false });
    });
    expect(r["нет экспортов без потребителя"]).toBe("✓");
    expect(r["нет зависимостей без импорта"]).toBe("✓");
    expect(r["нет экспортов без потребителя (production)"]).toBe("✓");
    expect(r["исключение: export:src/a.ts#legacy (#1)"]).toBe("✓");
    expect(r["исключение: dependency:package.json#vitest (#2)"]).toBe("✓");
    expect(r["исключение (production): export:src/a.ts#testOnly (#3)"]).toBe("✓");
    expect(Object.keys(r).filter((n) => n.startsWith("исключение (production)"))).toEqual(["исключение (production): export:src/a.ts#testOnly (#3)"]);
    expect(r["исключение: export:src/a.ts#testOnly (#3)"]).toBeUndefined();
    // опечатка в rule — исключение не берёт ни один запуск: упавший тест сверки, а не молча выпавший долг
    const typo = await outcomes((it) =>
      deadCode(it, { root: dir, report: ".knip-production.json", production: true, hints: false, exceptions: [{ ...exceptions[2]!, rule: "prodution" }] }),
    );
    expect(typo["нет экспортов без потребителя (production)"]).toBe("✗ src/a.ts#legacy\nsrc/a.ts#testOnly");
    expect(typo["исключения с rule — к правилам инвариантов папки"]).toStartWith("✗ исключение export:src/a.ts#testOnly: правила «prodution» нет ни у одного инварианта папки");
  });
});

/**
 * Переменная окружения — тоже решение: читается в коде — объявлена в схеме, объявлена — читается. Иначе в проде
 * падает непроверенная переменная или висит забытая.
 */
describe("Каждая переменная окружения объявлена и читается в коде", () => {
  it("читается без объявления — упавший тест; объявлена и не читается — упавший; служебные (NODE_ENV) — вне проверки", async () => {
    writeTree(dir, {
      "src/db.ts": 'const url = process.env.DATABASE_URL;\nconst key = process.env["STRIPE_KEY"];\nconst mode = process.env.NODE_ENV;\n',
      "src/web.ts": "const api = import.meta.env.VITE_API_URL;\nconst { SENTRY_DSN } = process.env;\n",
    });
    const r = await outcomes((it) =>
      envVars(it, { root: dir, dirs: ["src"], declared: ["DATABASE_URL", "VITE_API_URL", "SENTRY_DSN", "OLD_FLAG"] }),
    );
    expect(r["DATABASE_URL объявлена"]).toBe("✓");
    expect(r["SENTRY_DSN объявлена"]).toBe("✓");
    expect(r["STRIPE_KEY объявлена"]).toStartWith("✗ STRIPE_KEY читается в src/db.ts, но не объявлена в схеме окружения");
    expect(r["OLD_FLAG читается в коде"]).toStartWith("✗ OLD_FLAG объявлена, но не читается — убери из схемы");
    expect(r["VITE_API_URL читается в коде"]).toBe("✓");
    expect(Object.keys(r).some((n) => n.startsWith("NODE_ENV"))).toBe(false);
    // служебные — экспортом: проект со своими реестрами на invariant пропускает те же
    expect(ENV_SERVICE).toContain("NODE_ENV");
  });

  // переменная есть только в одном реестре — «читается» или «объявлена»; второй не должен требовать «убери исключение»
  it("исключение переменной — только у проверки, в чьём реестре она есть", async () => {
    writeTree(dir, { "src/db.ts": 'const key = process.env.STRIPE_KEY;\nconst url = process.env.DATABASE_URL;\n' });
    const r = await outcomes((it) =>
      envVars(it, { root: dir, declared: ["DATABASE_URL", "OLD_FLAG"], exceptions: [{ item: "STRIPE_KEY", issue: 5, reason: "в схему — в #5" }, { item: "OLD_FLAG", issue: 6, reason: "уберём в #6" }] }),
    );
    expect(r["исключение: STRIPE_KEY (#5)"]).toBe("✓");
    expect(r["исключение: OLD_FLAG (#6)"]).toBe("✓");
  });

  it("вне охвата — с причиной; переменной нет ни в коде, ни в схеме — «убери из охвата»", async () => {
    writeTree(dir, { "src/sdk.ts": "const t = process.env.SDK_TOKEN;\n" });
    const r = await outcomes((it) =>
      envVars(it, { root: dir, declared: [], outside: [{ item: "SDK_TOKEN", reason: "читает внешний SDK, схема его не видит" }, { item: "GONE", reason: "было" }] }),
    );
    expect(r["вне охвата: SDK_TOKEN"]).toBe("✓");
    expect(r["SDK_TOKEN объявлена"]).toBeUndefined();
    expect(r["вне охвата: GONE"]).toStartWith("✗ элемента GONE в реестре «переменные окружения в коде» нет — убери из охвата");
  });

  it("ignore без причины — упавший тест: перенести в outside", async () => {
    writeTree(dir, { "src/a.ts": "const a = process.env.A;\n" });
    const r = await outcomes((it) => envVars(it, { root: dir, declared: [], ignore: ["A"] }));
    expect(r["вне охвата без причины: A"]).toStartWith("✗ ignore не держит причину — перенеси в outside: [{ item, reason }]");
    expect(r["A объявлена"]).toBeUndefined();
  });

  it("чтение через параметр или переменную со значением process.env — тоже чтение", () => {
    const src = 'function cfg(env = process.env) { return env.API_KEY; }\nconst e = process.env;\nconst db = e["DB_URL"];\nconst n = other.NOT_ENV;\n';
    expect(envNamesIn(src).sort()).toEqual(["API_KEY", "DB_URL"]);
  });

  it("переменная в комментарии — не чтение", () => {
    expect(envNamesIn("// раньше: process.env.OLD_KEY\n/* process.env.GONE */\nconst k = process.env.NEW_KEY;\n")).toEqual(["NEW_KEY"]);
  });

  // проект зовёт `sources.flatMap(envNamesIn)`: второй необязательный параметр получил бы индекс flatMap — TS2345 (#303)
  it("envNamesIn вызывается ссылкой в flatMap без ошибки типов: параметр у неё один", () => {
    writeTree(dir, {
      "env.test.mts": `import { envNamesIn } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};\n\nexport const names: string[] = ["const a = process.env.A;"].flatMap(envNamesIn);\n`,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, target: "es2022", module: "nodenext", noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, typeRoots: [TYPES], types: ["node"] },
        files: ["env.test.mts"],
      }),
    });
    const r = spawnSync("node", [TSC, "-p", dir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(exitOf(r)).toBe(0);
    expect(["const a = process.env.A; // process.env.OLD", "const b = import.meta.env.VITE_B;"].flatMap(envNamesIn)).toEqual(["A", "VITE_B"]);
  });

  it("чтение через ?. и в скобках у import.meta.env — тоже чтение", () => {
    const src = 'const a = import.meta.env?.VITE_A;\nconst b = process.env?.B;\nconst c = import.meta.env["VITE_C"];\nconst d = process.env?.["D"];\nconst e = import.meta.env[`VITE_E`];\n';
    expect(envNamesIn(src).sort()).toEqual(["B", "D", "VITE_A", "VITE_C", "VITE_E"]);
  });

  it("деструктуризация с умолчанием и из import.meta.env — тоже чтение", () => {
    const src = 'const { A = "x", B: b, C: c = 1, ...rest } = process.env;\nconst { VITE_D }: Env = import.meta.env;\n';
    expect(envNamesIn(src).sort()).toEqual(["A", "B", "C", "VITE_D"]);
  });

  // vite.config: окружение режима — результат loadEnv, а не process.env
  it("псевдоним результата loadEnv Vite — чтение", () => {
    const src = [
      "export default defineConfig(({ mode }) => {",
      '  const env: Record<string, string> = loadEnv(mode, process.cwd(), "");',
      "  const { VITE_PORT } = loadEnv(mode, process.cwd());",
      '  return { define: { api: env.VITE_API, dsn: env?.["SENTRY_DSN"] }, server: { port: Number(VITE_PORT) } };',
      "});",
      "function cfg(flag: boolean, e: NodeJS.ProcessEnv = process.env) { return flag && e.API_KEY; }",
      "const other = load(mode);",
      "const n = other.NOT_ENV;",
      "const proc = process.environment;",
      "const m = proc.NOT_ENV_EITHER;",
    ].join("\n");
    expect(envNamesIn(src).sort()).toEqual(["API_KEY", "SENTRY_DSN", "VITE_API", "VITE_PORT"]);
  });

  // `.get('X')` бывает у Map, кэша, URLSearchParams — аксессор конфига проект подключает сам
  it("аксессор конфига .get('X') и .getOrThrow('X') — чтение с ридером configGet, без него — нет", () => {
    const src = 'const a = this.config.get("DATABASE_URL");\nconst b = configService.getOrThrow<string>(\'JWT_SECRET\');\nconst c = cfg?.get<number>(`APP_PORT`, 3000);\nconst d = headers.get("x-request-id");\n';
    expect(envNamesInCode(src, { readers: [configGet] }).sort()).toEqual(["APP_PORT", "DATABASE_URL", "JWT_SECRET"]);
    expect(envNamesInCode(src)).toEqual([]);
  });

  it("свои способы чтения — регэкспом или функцией по коду", async () => {
    writeTree(dir, { "src/a.ts": '// раньше: env("OLD_KEY")\nconst a = env("API_KEY");\nconst b = secret("DB_PASS");\n' });
    const files: string[] = [];
    const secrets = (code: string, file: string) => {
      files.push(file);
      return [...code.matchAll(/secret\("(\w+)"\)/g)].map((m) => m[1]!);
    };
    const r = await outcomes((it) => envVars(it, { root: dir, declared: ["API_KEY", "DB_PASS"], readers: [/\benv\(\s*"(?<name>[A-Z_]+)"/, secrets] }));
    expect(r["API_KEY объявлена"]).toBe("✓");
    expect(r["DB_PASS объявлена"]).toBe("✓");
    expect(r["API_KEY читается в коде"]).toBe("✓");
    expect(r["OLD_KEY объявлена"]).toBeUndefined();
    expect(files).toEqual(["src/a.ts"]);
  });

  // необязательная переменная с умолчанием в коде — закомментированной строкой: в .env её нет, в схеме она есть
  it(".env.example: X= и закомментированная # X= — объявления, проза в комментарии — нет", () => {
    const text = [
      "# База",
      "DATABASE_URL=postgres://localhost/app",
      "export API_KEY=",
      "# необязательные, умолчание в коде:",
      "# LOG_LEVEL=info",
      "#SENTRY_DSN=",
      "# Set FOO=bar to enable",
      "",
      "  APP_PORT = 3000",
      "DATABASE_URL=",
    ].join("\n");
    expect(dotenvNames(text)).toEqual(["DATABASE_URL", "API_KEY", "LOG_LEVEL", "SENTRY_DSN", "APP_PORT"]);
  });

  // пакет workspace попадает в сборку приложения — и читает его окружение: объявить переменную должно приложение
  it("монорепо: чтение пакета workspace — у каждого приложения, в чьих dependencies он есть; ключ <приложение>/<VAR>", async () => {
    const pkg = (name: string, deps: object = {}, key = "dependencies") => JSON.stringify({ name, [key]: deps });
    writeTree(dir, {
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
      "apps/api/package.json": pkg("api", { "@acme/db": "workspace:*", zod: "^4.0.0" }),
      "apps/api/src/main.ts": "const port = process.env.API_PORT;\n",
      "apps/web/package.json": pkg("web", { "@acme/ui": "workspace:*" }),
      "apps/web/src/main.ts": "const api = import.meta.env.VITE_API;\n",
      "apps/web/vite.config.ts": "const env = loadEnv(mode, process.cwd());\nexport const port = env.VITE_PORT;\n",
      "packages/db/package.json": pkg("@acme/db", { "@acme/log": "workspace:*" }),
      "packages/db/src/index.ts": "export const url = process.env.DATABASE_URL;\n",
      "packages/log/package.json": pkg("@acme/log"),
      "packages/log/src/index.ts": "export const level = process.env.LOG_LEVEL;\n",
      "packages/ui/package.json": pkg("@acme/ui", { "@acme/db": "workspace:*" }, "devDependencies"),
      "packages/ui/src/index.ts": "export const theme = import.meta.env.VITE_THEME;\n",
    });
    const r = await outcomes((it) =>
      envVars(it, {
        root: dir,
        dirs: ["src", "vite.config.ts"],
        apps: {
          api: { dir: "apps/api", declared: ["API_PORT", "DATABASE_URL"] },
          web: { dir: "apps/web", declared: ["VITE_API", "VITE_PORT", "VITE_THEME", "DATABASE_URL"] },
        },
      }),
    );
    expect(r["api/API_PORT объявлена"]).toBe("✓");
    expect(r["api/DATABASE_URL объявлена"]).toBe("✓");
    expect(r["api/LOG_LEVEL объявлена"]).toStartWith("✗ LOG_LEVEL читается в packages/log/src/index.ts, но не объявлена в схеме окружения приложения api");
    expect(r["web/VITE_THEME объявлена"]).toBe("✓");
    expect(r["web/VITE_PORT объявлена"]).toBe("✓");
    // devDependencies в сборку не попадают: DATABASE_URL пакета db — не чтение web
    expect(r["web/DATABASE_URL объявлена"]).toBeUndefined();
    expect(r["web/DATABASE_URL читается в коде"]).toStartWith("✗ DATABASE_URL объявлена в схеме окружения приложения web, но не читается ни им, ни его пакетами");
    expect(r["api/VITE_API объявлена"]).toBeUndefined();
  });

  it("монорепо: пакеты workspace — из workspaces package.json и pnpm-workspace.yaml", async () => {
    const pkg = (name: string, deps: object = {}) => JSON.stringify({ name, dependencies: deps });
    writeTree(dir, {
      "package.json": JSON.stringify({ private: true, workspaces: { packages: ["apps/*"] } }),
      "pnpm-workspace.yaml": "packages:\n  - \"packages/**\"\n  # фикстуры — не пакеты сборки\n  - '!packages/fixtures/**'\ncatalog:\n  zod: ^4.0.0\n",
      "apps/api/package.json": pkg("api", { "@acme/config": "workspace:*", "@acme/fixture": "workspace:*" }),
      "apps/api/src/main.ts": "export {};\n",
      "packages/shared/config/package.json": pkg("@acme/config"),
      "packages/shared/config/src/index.ts": "export const url = process.env.CONFIG_URL;\n",
      "packages/fixtures/x/package.json": pkg("@acme/fixture"),
      "packages/fixtures/x/src/index.ts": "export const f = process.env.FIXTURE_ONLY;\n",
    });
    const r = await outcomes((it) => envVars(it, { root: dir, apps: { api: { dir: "apps/api", declared: ["CONFIG_URL"] } } }));
    expect(r["api/CONFIG_URL объявлена"]).toBe("✓");
    expect(r["api/CONFIG_URL читается в коде"]).toBe("✓");
    expect(r["api/FIXTURE_ONLY объявлена"]).toBeUndefined();
  });
});
