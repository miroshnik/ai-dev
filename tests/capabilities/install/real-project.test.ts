import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { elves, sandbox, type Sandbox } from "../../lib/elves.ts";
import { realProject, type RealProject } from "../../lib/real-project.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
let app: RealProject;

// фикстура — свежая на каждый тест: поломка второго не доходит до первого
beforeEach(() => {
  sb = sandbox();
  app = realProject(sb);
  expect(elves(sb, ["install", "--lang", "ru"]).code).toBe(0);
  app.commit("chore(agents): флоу Elves");
});
afterEach(() => sb.cleanup());

// вывод упавшего скрипта (null — прошёл): падение объясняет себя, а не показывает код 1
const failed = (r: { code: number | null; output: string }) => (r.code === 0 ? null : r.output.slice(-4000));

/**
 * Половину багов флоу нашли проекты, а не тесты Elves: в Elves нет `.gitignore` с шаблонами агентов, ключей в
 * `.env.local`, CommonJS, workspace, настоящего knip и журнала от двух раннеров. Поэтому установку и скрипты флоу
 * проверяет проект, где всё это есть, — так, как их гоняют агент и CI.
 */
describe("Флоу работает в проекте, устроенном как настоящий, а не только в тестах Elves", () => {
  it("установка флоу в проект с .env.local, CJS package.json и workspace проходит, и скрипты флоу работают в нём", () => {
    const check = elves(sb, ["check"]);
    expect(check.stdout + check.stderr).not.toContain("❌");
    expect(check.code).toBe(0);
    // `.gitignore` прячет CLAUDE.md, .claude/ и vendor/ — файлы флоу всё равно в коммите, копии флоу нет
    expect(app.git("status", "--porcelain", "--ignored", "--", ".agents", ".claude", "AGENTS.md")).toBe("");
    expect(app.git("ls-files", "--", ".agents", ".claude").split("\n")).toEqual([".agents/elves.json", ".agents/slot.sh", ".claude/settings.json"]);
    // PR установки трогает только файлы флоу: тестов и исключений проекта в нём нет
    const diff = app.run("spec:diff", "--base", "HEAD~1");
    expect(failed(diff)).toBeNull();
    expect(diff.stdout).toContain("Тесты не менялись.");
    expect(diff.stdout).not.toContain(".agents/");
    // тесты идут через slot; ключ из .env.local до них не доходит — иначе «без ключа … не уходит в оплату» красный
    expect(failed(app.run("test"))).toBeNull();
    expect(failed(app.run("test:spec"))).toBeNull();
    expect(failed(app.run("test:e2e"))).toBeNull();
    expect(failed(app.run("spec:claims"))).toBeNull();
    // отчёт test:spec — вход spec:doc наравне с юнитами: стандарты в спеке, хотя test их не гоняет
    expect(failed(app.run("spec:doc"))).toBeNull();
  });

  it("spec-claims и deadCode на фикстуре зелёные и краснеют на её поломке", () => {
    expect(failed(app.run("test"))).toBeNull();
    expect(failed(app.run("test:spec"))).toBeNull();
    expect(failed(app.run("test:e2e"))).toBeNull();
    expect(failed(app.run("spec:claims"))).toBeNull();
    // поломка: маршрут без теста и модуль пакета, который никто не импортирует
    app.write({
      "src/server.ts": app.read("src/server.ts").replace("\n};\n", '\n  "DELETE /orders/:id": ({ id = "" }) => orders.delete(id),\n};\n'),
      "packages/prices/src/discount.ts": "export const discount = (net: number): number => Math.round(net * 0.9);\n",
    });
    // deadCode — стандарт: краснеет test:spec, test его не гоняет
    expect(failed(app.run("test"))).toBeNull();
    const spec = app.run("test:spec");
    expect(spec.code).toBe(1);
    expect(spec.output).toContain("(fail) Нет кода без потребителя > нет файлов без потребителя");
    expect(spec.output).toContain("packages/prices/src/discount.ts");
    const claims = app.run("spec:claims");
    expect(claims.code).toBe(1);
    expect(claims.output).toContain("not called by capability tests: 1");
    expect(app.read(".spec-claims.xml")).toMatch(/name="DELETE \/orders\/:id вызывается тестом capability"[^>]*>\s*<failure/);
  });
});
