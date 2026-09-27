import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { eslintLinter, examples } from "../../../skills/spec/scripts/harness.ts";
import type { It, LintMessage, Linter } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

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

// линтер-заглушка: правило no-console срабатывает на console.log вне tests/
const fake = (extra: (code: string) => LintMessage[] = () => []): Linter => ({
  async lint(code, filePath) {
    const own = /console\.log/.test(code) && !filePath.startsWith("tests/") ? [{ ruleId: "no-console", message: "Unexpected console statement." }] : [];
    return [...own, ...extra(code)];
  },
});

describe("Линт-правило проверяется примерами «нельзя», «можно», «вне охвата»", () => {
  it("«нельзя» падает, если правило не сработало; «можно» и «вне охвата» — если сработало", async () => {
    const r = await outcomes((it) =>
      examples(it, {
        linter: fake(),
        rule: "no-console",
        bad: [
          { name: "console.log в коде", path: "src/a.ts", code: "console.log(1);" },
          { name: "console.error в коде", path: "src/b.ts", code: "console.error(1);" },
        ],
        good: [
          { name: "логгер вместо console", path: "src/a.ts", code: "log(1);" },
          { name: "console.log в коде", path: "src/c.ts", code: "console.log(1);" },
        ],
        outside: [{ name: "console.log в тесте", path: "tests/a.test.ts", code: "console.log(1);" }],
      }),
    );
    expect(r["нельзя: console.log в коде"]).toBe("✓");
    expect(r["нельзя: console.error в коде"]).toStartWith("✗ правило no-console не сработало: src/b.ts");
    expect(r["можно: логгер вместо console"]).toBe("✓");
    expect(r["можно: console.log в коде"]).toStartWith("✗ правило no-console сработало: src/c.ts — Unexpected console statement.");
    expect(r["вне охвата: console.log в тесте"]).toBe("✓");
  });

  // без «нельзя» нечем доказать, что правило умеет падать — как нарушитель у реестра
  it("правило без примера «нельзя» — упавший тест", async () => {
    const r = await outcomes((it) => examples(it, { linter: fake(), rule: "no-console", bad: [], good: [{ name: "чисто", path: "src/a.ts", code: "" }] }));
    expect(r["у правила no-console есть пример «нельзя»"]).toStartWith("✗");
  });

  it("срабатывание другого правила не засчитывается ни за «нельзя», ни против «можно»", async () => {
    const other = fake(() => [{ ruleId: "eqeqeq", message: "Expected '==='." }]);
    const r = await outcomes((it) =>
      examples(it, {
        linter: other,
        rule: "no-console",
        bad: [{ name: "только eqeqeq", path: "src/a.ts", code: "a == b;" }],
        good: [{ name: "eqeqeq не мешает", path: "src/b.ts", code: "a == b;" }],
      }),
    );
    expect(r["нельзя: только eqeqeq"]).toStartWith("✗ правило no-console не сработало");
    expect(r["можно: eqeqeq не мешает"]).toBe("✓");
  });

  it("пример, который не разбирается, — упавший тест, а не ложное «можно»", async () => {
    const broken = fake((code) => (code.includes("{{") ? [{ ruleId: null, message: "Parsing error: Unexpected token", fatal: true }] : []));
    const r = await outcomes((it) =>
      examples(it, { linter: broken, rule: "no-console", bad: [{ name: "x", path: "src/a.ts", code: "console.log(1);" }], good: [{ name: "опечатка", path: "src/b.ts", code: "{{" }] }),
    );
    expect(r["можно: опечатка"]).toStartWith("✗ пример не разбирается: src/b.ts — Parsing error: Unexpected token");
  });
});

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

// ESLint — из devDependencies ai-dev: во временном каталоге фикстуры своего node_modules нет
const ESLINT = createRequire(import.meta.url).resolve("eslint");
const FRAGMENT = "tests/standards/domain-no-console/eslint.ts";

// ESLint кэширует модуль конфига в процессе: проект без фрагмента — в своём каталоге, а не тот же без файла
function project(root = dir, withFragment = true): string {
  writeTree(root, {
    "package.json": JSON.stringify({ name: "app", type: "module" }),
    "eslint.config.mjs": `import { collectEslint } from ${JSON.stringify(path.join(SCRIPTS, "eslint-config.ts"))};\nexport default [...(await collectEslint(import.meta.dirname))];\n`,
    ...(withFragment ? { [FRAGMENT]: `export default [{ files: ["src/domain/**/*.js"], rules: { "no-console": "error" } }];\n` } : {}),
    "src/domain/invoice.js": "console.log(1);\n",
    "src/ui/page.js": "console.log(1);\n",
  });
  return root;
}

/**
 * Правило ESLint — фрагмент `eslint.ts` в папке своего стандарта: решение, его примеры и механизм в одном месте,
 * а `eslint.config.*` проекта только собирает фрагменты — `lint` и редактор видят правило как обычно.
 */
describe("Правило ESLint живёт в папке своего стандарта, конфиг проекта собирает его из дерева", () => {
  it("eslint.ts стандарта попадает в конфиг: lint проекта ловит нарушение в охвате правила и молчит вне его", async () => {
    project();
    const { ESLint } = await import(ESLINT);
    const results = await new ESLint({ cwd: dir }).lintFiles(["src"]);
    const byFile = Object.fromEntries(results.map((r: { filePath: string; messages: { ruleId: string }[] }) => [path.relative(dir, r.filePath), r.messages.map((m) => m.ruleId)]));
    expect(byFile).toEqual({ "src/domain/invoice.js": ["no-console"], "src/ui/page.js": [] });
  });

  it("примеры идут через тот же конфиг: с фрагментом — зелёные, без фрагмента «нельзя» падает", async () => {
    project();
    const spec = () => ({
      rule: "no-console",
      bad: [{ name: "console.log в домене", path: "src/domain/x.js", code: "console.log(1);\n" }],
      good: [{ name: "без console в домене", path: "src/domain/y.js", code: "export const y = 1;\n" }],
      outside: [{ name: "console.log в UI", path: "src/ui/z.js", code: "console.log(1);\n" }],
    });
    const on = await outcomes((it) => examples(it, { linter: eslintLinter({ cwd: dir, module: ESLINT }), ...spec() }));
    expect(Object.values(on)).toEqual(["✓", "✓", "✓"]);
    const bare = project(path.join(dir, "without-fragment"), false);
    const off = await outcomes((it) => examples(it, { linter: eslintLinter({ cwd: bare, module: ESLINT }), ...spec() }));
    expect(off["нельзя: console.log в домене"]).toStartWith("✗ правило no-console не сработало");
  });

  // flat config опции одного правила не сливает: два фрагмента с no-restricted-syntax на одни файлы — действует последний
  it("запреты двух стандартов на одни файлы действуют оба — у каждого своё правило", async () => {
    const restrict = (id: string, selector: string) =>
      `import { restrict } from ${JSON.stringify(path.join(SCRIPTS, "eslint-config.ts"))};\nexport default restrict({ id: ${JSON.stringify(id)}, selectors: [${JSON.stringify(selector)}], message: "нельзя", files: ["src/**/*.js"] });\n`;
    project();
    writeTree(dir, {
      "tests/standards/no-alert/eslint.ts": restrict("no-alert", "CallExpression[callee.name='alert']"),
      "tests/standards/no-debugger/eslint.ts": restrict("no-debugger", "DebuggerStatement"),
      "src/ui/both.js": "alert(1);\ndebugger;\n",
    });
    const { ESLint } = await import(ESLINT);
    const [res] = await new ESLint({ cwd: dir }).lintFiles(["src/ui/both.js"]);
    expect(res.messages.map((m: { ruleId: string }) => m.ruleId).sort()).toEqual(["spec/no-alert", "spec/no-debugger"]);
  });

  it("collectEslint пропускает tests/lib — хелпер там не фрагмент", async () => {
    project();
    writeTree(dir, { "tests/lib/eslint.ts": "export const helper = 1;\n" });
    const { ESLint } = await import(ESLINT);
    const results = await new ESLint({ cwd: dir }).lintFiles(["src/domain/invoice.js"]);
    expect(results[0].messages.map((m: { ruleId: string }) => m.ruleId)).toEqual(["no-console"]);
  });

  it("фрагмент eslint.mts собирается так же, как eslint.ts", async () => {
    project(dir, false);
    writeTree(dir, { "tests/standards/domain-no-console/eslint.mts": `export default [{ files: ["src/domain/**/*.js"], rules: { "no-console": "error" } }];\n` });
    const { ESLint } = await import(ESLINT);
    const results = await new ESLint({ cwd: dir }).lintFiles(["src/domain/invoice.js"]);
    expect(results[0].messages.map((m: { ruleId: string }) => m.ruleId)).toEqual(["no-console"]);
  });
});
