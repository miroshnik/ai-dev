import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const FILE = "tests/standards/no-console/no-console.test.ts";

/**
 * Код примера и причина исключения — в вызове харнесса, а не в названии теста: отчёт раннера их не несёт. Поэтому
 * харнесс при регистрации тестов пишет метаданные прогона, а `spec-doc` показывает их на странице стандарта.
 */
describe("Проверка оставляет метаданные прогона — спека показывает примеры и долг", () => {
  it("examples и исключения пишут метаданные прогона для spec-doc", () => {
    writeTree(dir, {
      [FILE]: `import { it } from "bun:test";
import { examples, invariant } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};
const linter = { async lint(code) { return /console/.test(code) ? [{ ruleId: "no-console", message: "x" }] : []; } };
examples(it, {
  linter,
  rule: "no-console",
  bad: [{ name: "console.log в домене", path: "src/domain/a.ts", code: "console.log(1);" }],
  good: [{ name: "логгер в домене", path: "src/domain/b.ts", code: "log(1);" }],
});
invariant(it, {
  registry: "мутации",
  items: ["createInvoice", "importLegacy"],
  name: (m) => m + " пишет аудит",
  key: (m) => m,
  check: (m) => { if (m === "importLegacy") throw new Error("нет аудита"); },
  violator: { name: "без аудита", item: "importLegacy" },
  exceptions: [{ item: "importLegacy", issue: 12, reason: "импорт старых данных — аудит в #12" }],
});
`,
    });
    const r = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    const records = readdirSync(path.join(dir, ".spec-meta")).flatMap((f) =>
      readFileSync(path.join(dir, ".spec-meta", f), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        { file: FILE, test: "нельзя: console.log в домене", path: "src/domain/a.ts", code: "console.log(1);" },
        { file: FILE, test: "можно: логгер в домене", path: "src/domain/b.ts", code: "log(1);" },
        { file: FILE, test: "исключение: importLegacy (#12)", issue: 12, reason: "импорт старых данных — аудит в #12" },
      ]),
    );
  });
});
