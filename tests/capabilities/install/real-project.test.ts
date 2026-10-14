import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, sandbox, type Sandbox } from "../../lib/ai-dev.ts";
import { realProject, type RealProject } from "../../lib/real-project.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
let app: RealProject;

// фикстура — свежая на каждый тест: поломка второго не доходит до первого
beforeEach(() => {
  sb = sandbox();
  app = realProject(sb);
  expect(aiDev(sb, ["install", "--lang", "ru"]).code).toBe(0);
  app.commit("chore(agents): флоу ai-dev");
});
afterEach(() => sb.cleanup());

// вывод упавшего скрипта (null — прошёл): падение объясняет себя, а не показывает код 1
const failed = (r: { code: number | null; output: string }) => (r.code === 0 ? null : r.output.slice(-4000));

/**
 * Половину багов флоу нашли проекты, а не тесты ai-dev: в ai-dev нет `.gitignore` с шаблонами агентов, ключей в
 * `.env.local`, CommonJS, workspace, настоящего knip и журнала от двух раннеров. Поэтому установку и скрипты флоу
 * проверяет проект, где всё это есть, — так, как их гоняют агент и CI.
 */
describe("Флоу работает в проекте, устроенном как настоящий, а не только в тестах ai-dev", () => {
  it("установка флоу в проект с .env.local, CJS package.json и workspace проходит, и скрипты флоу работают в нём", () => {
    const check = aiDev(sb, ["check"]);
    expect(check.stdout + check.stderr).not.toContain("❌");
    expect(check.code).toBe(0);
    // `.gitignore` прячет CLAUDE.md, .claude/ и vendor/ — файлы флоу всё равно в коммите
    expect(app.git("status", "--porcelain", "--ignored", "--", ".agents", ".claude", "AGENTS.md")).toBe("");
    // PR установки трогает только копию флоу: тестов и исключений проекта в нём нет
    const diff = app.run("spec:diff", "--base", "HEAD~1");
    expect(failed(diff)).toBeNull();
    expect(diff.stdout).toContain("Тесты не менялись.");
    expect(diff.stdout).not.toContain(".agents/");
    // тесты идут через slot; ключ из .env.local до них не доходит — иначе «без ключа … не уходит в оплату» красный
    expect(failed(app.run("test"))).toBeNull();
    expect(failed(app.run("test:e2e"))).toBeNull();
    expect(failed(app.run("spec:claims"))).toBeNull();
    expect(failed(app.run("spec:doc"))).toBeNull();
  });

  it("spec-claims и deadCode на фикстуре зелёные и краснеют на её поломке", () => {
    expect(failed(app.run("test"))).toBeNull();
    expect(failed(app.run("test:e2e"))).toBeNull();
    expect(failed(app.run("spec:claims"))).toBeNull();
    // поломка: маршрут без теста и модуль пакета, который никто не импортирует
    app.write({
      "src/server.ts": app.read("src/server.ts").replace("\n};\n", '\n  "DELETE /orders/:id": ({ id = "" }) => orders.delete(id),\n};\n'),
      "packages/prices/src/discount.ts": "export const discount = (net: number): number => Math.round(net * 0.9);\n",
    });
    const test = app.run("test");
    expect(test.code).toBe(1);
    expect(test.output).toContain("(fail) Нет кода без потребителя > нет файлов без потребителя");
    expect(test.output).toContain("packages/prices/src/discount.ts");
    const claims = app.run("spec:claims");
    expect(claims.code).toBe(1);
    expect(claims.output).toContain("not called by capability tests: 1");
    expect(app.read(".spec-claims.xml")).toMatch(/name="DELETE \/orders\/:id вызывается тестом capability"[^>]*>\s*<failure/);
  });
});
