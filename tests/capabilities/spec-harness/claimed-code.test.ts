import { chmodSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { deadCode, envVars } from "../../../skills/spec/scripts/harness.ts";
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
});
