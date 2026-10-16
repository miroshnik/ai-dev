import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { REPO } from "../../lib/elves.ts";
import { packageProject } from "../../lib/npm.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// Playwright — из devDependencies Elves: во временном проекте своего node_modules нет, он — ссылка на node_modules Elves
const PLAYWRIGHT = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")), "cli.js");

/** e2e-тест проекта: импортирует харнесс и модель из копии скилла и разбирает исходник. */
const PROJECT_SPEC =
  'import { expect, test } from "@playwright/test";\n' +
  'import { architecture } from "../.agents/skills/spec/scripts/architecture.ts";\n' +
  'import { envNamesIn } from "../.agents/skills/spec/scripts/harness.ts";\n\n' +
  'test("харнесс разбирает исходник", () => {\n' +
  '  expect(typeof architecture).toBe("function");\n' +
  '  expect(envNamesIn("const k = process.env.API_KEY; // process.env.OLD\\n")).toEqual(["API_KEY"]);\n' +
  "});\n";

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

/**
 * Проект с копией скиллов, как после установки флоу (харнесс берёт названия из словаря скилла github), и e2e-тестом,
 * который импортирует харнесс и модель; без браузера.
 */
function project(type?: "module" | "commonjs"): void {
  writeTree(dir, {
    "package.json": JSON.stringify({ name: "app", type }),
    "playwright.config.ts": 'export default { testDir: "e2e" };\n',
    "e2e/harness.spec.ts": PROJECT_SPEC,
  });
  cpSync(path.join(SCRIPTS, ".."), path.join(dir, ".agents/skills/spec"), { recursive: true });
  cpSync(path.join(SCRIPTS, "../../github"), path.join(dir, ".agents/skills/github"), { recursive: true });
  symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
}

/** `playwright test` в проекте; кэш трансформаций — свой, чтобы прогон не взял модуль, разобранный прошлым запуском. */
function playwright(cwd = dir): { code: number | string; output: string } {
  const env = { ...process.env, PWTEST_CACHE_DIR: path.join(cwd, ".playwright-cache"), CI: "1" };
  const r = spawnSync("node", [PLAYWRIGHT, "test", "--reporter=line"], { cwd, encoding: "utf8", env });
  return { code: exitOf(r), output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * Проект без копии флоу — с пакетом `@miroshnik/elves` в devDependencies, как его публикует CI: e2e-тест импортирует
 * харнесс и модель из пакета. Node не снимает типы в node_modules (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), и
 * Playwright файлы node_modules не транспилирует — грузится сборка для Node (`default` в `exports`).
 */
function fromPackage(type?: "module" | "commonjs"): string {
  const spec = PROJECT_SPEC.replace("../.agents/skills/spec/scripts/architecture.ts", "@miroshnik/elves/spec/architecture").replace("../.agents/skills/spec/scripts/harness.ts", "@miroshnik/elves/spec/harness");
  return packageProject(`harness-load-${type ?? "typeless"}`, { "playwright.config.ts": 'export default { testDir: "e2e" };\n', "e2e/harness.spec.ts": spec }, type ? { type } : {});
}

/**
 * Свой загрузчик Node — у `eslint.config.*` проекта и `node --test`: фрагмент ESLint, харнесс и модель он грузит как
 * есть, без транспиляции раннера. Проект с `"type": "commonjs"` объявил бы ESM-модули копии CommonJS — у скиллов spec и
 * github поэтому свой `"type": "module"`.
 */
function nodeImport(): { code: number | string; output: string } {
  const code = ["eslint-config", "harness", "architecture"].map((m) => `await import("./.agents/skills/spec/scripts/${m}.ts");`).join(" ");
  const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf8" });
  return { code: exitOf(r), output: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("Тест проекта импортирует харнесс и модель любым раннером", () => {
  it("Playwright в проекте без \"type\": \"module\" (загрузка CommonJS) импортирует харнесс и модель и проходит тест", () => {
    project();
    const r = playwright();
    expect(r.output).toContain("1 passed");
    expect(r.code).toBe(0);
  });

  it("Node проекта с \"type\": \"commonjs\" своим загрузчиком импортирует фрагмент ESLint, харнесс и модель без ошибок и предупреждений", () => {
    project("commonjs");
    const r = nodeImport();
    expect(r.output).toBe("");
    expect(r.code).toBe(0);
  });

  it("Playwright в проекте с \"type\": \"module\" (загрузка ESM) импортирует харнесс и модель и проходит тест", () => {
    project("module");
    const r = playwright();
    expect(r.output).toContain("1 passed");
    expect(r.code).toBe(0);
  });
});

describe("Тест проекта импортирует харнесс и модель из пакета @miroshnik/elves любым раннером", () => {
  it("Playwright в проекте без \"type\": \"module\" (загрузка CommonJS) импортирует из пакета харнесс и модель и проходит тест", () => {
    const r = playwright(fromPackage());
    expect(r.output).toContain("1 passed");
    expect(r.code).toBe(0);
  });

  it("Playwright в проекте с \"type\": \"module\" (загрузка ESM) импортирует из пакета харнесс и модель и проходит тест", () => {
    const r = playwright(fromPackage("module"));
    expect(r.output).toContain("1 passed");
    expect(r.code).toBe(0);
  });

  /**
   * Сборка идёт на машине CI, а работает у проекта: путь, запечённый в модуль при сборке, вёл бы в никуда. Так было с
   * репортёром knip — `__filename` CommonJS-модуля сборщик заменял путём машины сборки, и `deadCode` под Node (Jest,
   * Playwright, node:test) звал knip с несуществующим файлом.
   */
  it("deadCode харнесса из пакета под Node зовёт knip с репортёром из самого пакета, а не с машины сборки", () => {
    const proj = packageProject("harness-load-knip", {
      "tests/standards/dead-code/dead-code.test.ts": 'import { describe, it } from "node:test";\nimport { deadCode } from "@miroshnik/elves/spec/harness";\n\ndescribe("No dead code", () => {\n  deadCode(it, { root: process.cwd() });\n});\n',
    });
    // knip проекта — заглушка: записывает аргументы, отчёт — чистый
    writeFileSync(path.join(proj, "node_modules/.bin/knip"), `#!/bin/sh\necho "$@" > knip-args.txt\necho '{"issues":[]}'\necho '{"configurationHints":[]}'\n`, { mode: 0o755 });
    const r = spawnSync("node", ["--test", "tests/standards/dead-code/dead-code.test.ts"], { cwd: proj, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect({ code: exitOf(r), output: r.stdout + r.stderr }).toMatchObject({ code: 0 });
    const reporter = readFileSync(path.join(proj, "knip-args.txt"), "utf8").trim().split(" ")[3] ?? "";
    expect(reporter).toStartWith(path.join(realpathSync(proj), "node_modules/@miroshnik/elves/"));
    expect(existsSync(reporter)).toBe(true);
  });

  it("Node проекта с \"type\": \"commonjs\" своим загрузчиком импортирует из пакета фрагмент ESLint, харнесс, модель и github без ошибок и предупреждений", () => {
    const proj = fromPackage("commonjs");
    const code = ["spec/eslint-config", "spec/harness", "spec/architecture", "github"].map((m) => `await import("@miroshnik/elves/${m}");`).join(" ");
    const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: proj, encoding: "utf8" });
    expect((r.stdout ?? "") + (r.stderr ?? "")).toBe("");
    expect(exitOf(r)).toBe(0);
  });
});
