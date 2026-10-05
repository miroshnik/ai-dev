import { spawnSync } from "node:child_process";
import { cpSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { REPO } from "../../lib/ai-dev.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// Playwright — из devDependencies ai-dev: во временном проекте своего node_modules нет, он — ссылка на node_modules ai-dev
const PLAYWRIGHT = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")), "cli.js");

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

/** Проект с копией скилла, как после установки флоу, и e2e-тестом, который импортирует харнесс и модель; без браузера. */
function project(type?: "module"): void {
  writeTree(dir, {
    "package.json": JSON.stringify({ name: "app", type }),
    "playwright.config.ts": 'export default { testDir: "e2e" };\n',
    "e2e/harness.spec.ts":
      'import { expect, test } from "@playwright/test";\n' +
      'import { architecture } from "../.agents/skills/spec/scripts/architecture.ts";\n' +
      'import { envNamesIn } from "../.agents/skills/spec/scripts/harness.ts";\n\n' +
      'test("харнесс разбирает исходник", () => {\n' +
      '  expect(typeof architecture).toBe("function");\n' +
      '  expect(envNamesIn("const k = process.env.API_KEY; // process.env.OLD\\n")).toEqual(["API_KEY"]);\n' +
      "});\n",
  });
  cpSync(path.join(SCRIPTS, ".."), path.join(dir, ".agents/skills/spec"), { recursive: true });
  symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
}

/** `playwright test` в проекте; кэш трансформаций — свой, чтобы прогон не взял модуль, разобранный прошлым запуском. */
function playwright(): { code: number | string; output: string } {
  const env = { ...process.env, PWTEST_CACHE_DIR: path.join(dir, ".playwright-cache"), CI: "1" };
  const r = spawnSync("node", [PLAYWRIGHT, "test", "--reporter=line"], { cwd: dir, encoding: "utf8", env });
  return { code: exitOf(r), output: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("Тест проекта импортирует харнесс и модель любым раннером", () => {
  it("Playwright в проекте без \"type\": \"module\" (загрузка CommonJS) импортирует харнесс и модель и проходит тест", () => {
    project();
    const r = playwright();
    expect(r.output).toContain("1 passed");
    expect(r.code).toBe(0);
  });

  it("Playwright в проекте с \"type\": \"module\" (загрузка ESM) импортирует харнесс и модель и проходит тест", () => {
    project("module");
    const r = playwright();
    expect(r.output).toContain("1 passed");
    expect(r.code).toBe(0);
  });
});
