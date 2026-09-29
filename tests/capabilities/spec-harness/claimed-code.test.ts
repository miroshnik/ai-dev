import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { deadCode, envNamesIn, envVars } from "../../../skills/spec/scripts/harness.ts";
import type { It } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

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

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

// отчёт `knip --reporter json`: issues — по файлу, в каждом — ключи видов (knip.dev, «Reporters»)
const knip = (issues: object[]) => JSON.stringify({ issues });

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
    expect(r["нет зависимостей без импорта"]).toBe("✗ lodash");
    expect(r["нет типов без потребителя"]).toBe("✓");
    expect(r["нет импортов неустановленных пакетов"]).toBe("✓");
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
    writeTree(dir, { "node_modules/.bin/knip": `#!/bin/sh\necho "$@" > args.txt\necho '${knip([])}'\n` });
    chmodSync(path.join(dir, "node_modules/.bin/knip"), 0o755);
    const r = await outcomes((it) => deadCode(it, { root: dir, args: ["--tsConfig", "tsconfig.test.json"] }));
    expect(r["нет файлов без потребителя"]).toBe("✓");
    expect(readFileSync(path.join(dir, "args.txt"), "utf8").trim()).toBe("--reporter json --tsConfig tsconfig.test.json");
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
    expect(r["нет вызовов неустановленных бинарников"]).toBe("✗ tsx");
    expect(r["нет лишних записей каталога пакетов"]).toBe("✗ react");
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
});
