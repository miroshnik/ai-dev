import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, runScript, SCRIPTS, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// С 22.18 Node стирает типы без флага — нижняя граница из SKILL.md; CI ai-dev ставит ровно эту версию.
beforeAll(() => {
  const r = spawnSync("node", ["--version"], { encoding: "utf8" });
  const [major = 0, minor = 0] = (r.stdout ?? "").replace(/^v/, "").split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error(`нужен Node ≥ 22.18 в PATH, есть: ${r.stdout?.trim() || r.error?.message}`);
});

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const BILLING = "tests/capabilities/billing/billing.test.ts";
const DESCRIPTION = { "tests/capabilities/billing/billing.md": "Биллинг: счета клиентам за месяц.\n" };
const source = (...names: string[]) =>
  `import { describe, it } from "vitest";\n` +
  `describe("Счета", () => { ${names.map((n) => `it("${n}", () => {});`).join(" ")} });\n`;

/** Каталог → { относительный путь: содержимое }. */
function readTree(root: string): Record<string, string> {
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  return Object.fromEntries(
    files.map((e) => {
      const full = path.join(e.parentPath, e.name);
      return [path.relative(root, full), readFileSync(full, "utf8")];
    }),
  );
}

describe("Под Node без Bun скрипты spec пишут то же, что под Bun", () => {
  it("spec-doc пишет тот же docs/spec, что под Bun", () => {
    writeTree(dir, { ...DESCRIPTION, [BILLING]: source("выставляется за месяц") });
    writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [BILLING]: [[["Счета"], "выставляется за месяц"]] }));
    const bun = runScript("spec-doc", ["r.json", "--root", dir, "--out", "spec-bun", "--strict"], dir);
    const node = runScript("spec-doc", ["r.json", "--root", dir, "--out", "spec-node", "--strict"], dir, "node");
    expect([bun.code, node.code]).toEqual([0, 0]);
    const out = readTree(path.join(dir, "spec-node"));
    expect(out["capabilities/billing.md"]).toContain("Биллинг: счета клиентам за месяц.\n\n## Счета\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ выставляется за месяц");
    expect(out).toEqual(readTree(path.join(dir, "spec-bun")));
  });

  it("spec-diff печатает тот же раздел для PR, что под Bun", () => {
    const repo = gitRepo(dir);
    const base = repo.commit({ [BILLING]: source("черновик удаляется") });
    repo.commit({ [BILLING]: source("выставляется за месяц") });
    const bun = runScript("spec-diff", ["--base", base], dir);
    const node = runScript("spec-diff", ["--base", base], dir, "node");
    expect([bun.code, node.code]).toEqual([0, 0]);
    expect(node.stdout).toContain("**Удалены (1):**\n\n- `tests/capabilities/billing` · Счета › черновик удаляется");
    expect(node.stdout).toBe(bun.stdout);
  });

  it("spec-publish публикует под Node то же дерево, что под Bun", () => {
    const remote = path.join(dir, "remote.git");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const work = path.join(dir, "work");
    mkdirSync(work);
    const repo = gitRepo(work);
    repo.commit({ "README.md": "# проект\n" });
    repo.git("remote", "add", "origin", remote);
    writeTree(work, { "docs/spec/README.md": "# Спецификация\n", "docs/spec/capabilities/billing.md": "# billing\n" });
    const bun = runScript("spec-publish", ["--branch", "spec-bun"], work);
    const node = runScript("spec-publish", ["--branch", "spec-node"], work, "node");
    expect([bun.code, node.code]).toEqual([0, 0]);
    const tree = (branch: string) => repo.git("rev-parse", `origin/${branch}^{tree}`);
    repo.git("fetch", "-q", "origin", "spec-bun", "spec-node");
    expect(tree("spec-node")).toBe(tree("spec-bun"));
  });

  it("spec-claims пишет под Node тот же отчёт, что под Bun", () => {
    writeTree(dir, {
      "entries.json": JSON.stringify(["POST /invoices", "job:cleanup"]),
      ".spec-journal/1.jsonl": JSON.stringify({ id: "POST /invoices", test: "tests/capabilities/billing/billing.test.ts" }) + "\n",
    });
    const bun = runScript("spec-claims", ["--entries", "entries.json", "--report", "bun.xml"], dir);
    const node = runScript("spec-claims", ["--entries", "entries.json", "--report", "node.xml"], dir, "node");
    expect([bun.code, node.code]).toEqual([1, 1]);
    expect(readFileSync(path.join(dir, "node.xml"), "utf8")).toBe(readFileSync(path.join(dir, "bun.xml"), "utf8"));
  });

  /** Установка флоу кладёт скилл в `.agents/skills/spec` проекта — под `package.json` проекта, а не ai-dev. */
  it("копия скилла в проекте без \"type\": \"module\" запускается под Node без предупреждений", () => {
    writeTree(dir, { [BILLING]: source("выставляется за месяц") });
    writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [BILLING]: [[["Счета"], "выставляется за месяц"]] }));
    cpSync(path.join(SCRIPTS, ".."), path.join(dir, ".agents/skills/spec"), { recursive: true });
    for (const type of ["commonjs", undefined]) {
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", type }));
      const r = spawnSync("node", [".agents/skills/spec/scripts/spec-doc.ts", "r.json", "--stdout"], { cwd: dir, encoding: "utf8" });
      expect({ type, code: r.status, warning: /Warning/.test(r.stderr) }).toEqual({ type, code: 0, warning: false });
      expect(r.stdout).toContain("- ✅ выставляется за месяц");
    }
  });
});
