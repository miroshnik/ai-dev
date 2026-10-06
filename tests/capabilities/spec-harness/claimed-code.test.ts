import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
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
