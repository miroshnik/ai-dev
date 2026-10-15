/**
 * Фикстура «реальный проект» для e2e флоу: то, на чём флоу ломался в проектах, а не в тестах Elves, — `.gitignore`,
 * прячущий файлы флоу (#299), ключи разработчика в `.env.local` (#424), `package.json` без `"type"` — Playwright грузит
 * тесты как CommonJS (#303), workspace-пакет, журнал spec-claims от двух раннеров и настоящий knip. Не спека.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { REPO, type Sandbox } from "./elves.ts";
import { gitRepo, writeTree } from "./spec.ts";

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Как в проекте до флоу: скрипты spec ведут в копию `.agents`, которую поставит установка. */
const SPEC = "bun --no-env-file .agents/skills/spec/scripts";

const FILES: Record<string, string> = {
  "package.json": json({
    name: "shop",
    private: true,
    workspaces: ["packages/*"],
    scripts: {
      // пара из готовой строки check (#442): стандарты — в test:spec, test их не повторяет
      test: "bun test --reporter=junit --reporter-outfile=.spec-report.xml --path-ignore-patterns='tests/standards/**'",
      "test:spec": "bun test tests/standards --reporter=junit --reporter-outfile=.spec-standards.xml",
      "test:e2e": "playwright test",
      "spec:claims": `${SPEC}/spec-claims.ts --entries tests/standards/entry-points/entries.ts`,
      "spec:doc": `${SPEC}/spec-doc.ts .spec-report.xml .spec-standards.xml .spec-playwright.json .spec-claims.xml --strict`,
      "spec:diff": `${SPEC}/spec-diff.ts`,
    },
    dependencies: { "@shop/prices": "workspace:*" },
    devDependencies: { "@playwright/test": "^1.63.0", knip: "^6.41.0" },
  }),
  // личные заметки агента и каталоги инструментов прячут часто — вместе с ними git спрятал бы файлы флоу
  ".gitignore": ["node_modules/", ".env*.local", "CLAUDE.md", ".claude/", "vendor/", "docs/spec/", ".spec-*", "test-results/", ""].join("\n"),
  // ключ из `vercel env pull`: проверки его не видят — CI, где файла нет, их не видит тоже
  ".env.local": "PAYMENTS_KEY=live-key\n",
  "bunfig.toml": '[test]\npreload = ["./tests/lib/journal.ts"]\n',
  // тесты bun test и preload knip берёт входами сам — по скрипту `bun test`, обёрнутому в slot (#452)
  "knip.json": json({
    workspaces: {
      ".": {
        entry: ["src/server.ts", "tests/standards/entry-points/entries.ts"],
        project: ["src/**/*.ts", "tests/**/*.ts"],
      },
      "packages/*": { project: ["src/**/*.ts"] },
    },
  }),
  "playwright.config.ts": [
    'import { defineConfig } from "@playwright/test";',
    "",
    "// журнал e2e — в своём каталоге: раннер юнитов в начале прогона стирает только свой",
    'process.env.SPEC_JOURNAL ??= ".spec-journal/e2e";',
    "",
    "export default defineConfig({",
    '  testDir: "tests",',
    '  testMatch: "**/*.e2e.ts",',
    '  globalSetup: "./tests/lib/journal-e2e.ts",',
    '  reporter: [["line"], ["json", { outputFile: ".spec-playwright.json" }]],',
    "});",
    "",
  ].join("\n"),
  "packages/prices/package.json": json({ name: "@shop/prices", version: "0.0.0", private: true, main: "src/index.ts" }),
  "packages/prices/src/index.ts": 'import { VAT } from "./vat.ts";\n\nexport const withVat = (net: number): number => Math.round(net * (1 + VAT));\n',
  "packages/prices/src/vat.ts": "export const VAT = 0.2;\n",
  "src/server.ts": [
    'import { withVat } from "@shop/prices";',
    "",
    "type Handler = (body: { net?: number; id?: string }) => unknown;",
    "",
    "const orders = new Map<string, number>();",
    "",
    "export const routes: Record<string, Handler> = {",
    '  "POST /orders": ({ net = 0 }) => {',
    "    const id = String(orders.size + 1);",
    "    orders.set(id, withVat(net));",
    "    return { id, total: orders.get(id), paid: Boolean(process.env.PAYMENTS_KEY) };",
    "  },",
    '  "GET /orders/:id": ({ id = "" }) => ({ id, total: orders.get(id) ?? null }),',
    "};",
    "",
  ].join("\n"),
  "tests/lib/app.ts": [
    'import { journal } from "../../.agents/skills/spec/scripts/harness.ts";',
    'import { routes } from "../../src/server.ts";',
    "",
    "// сборка тестов оборачивает точки входа журналом; e2e передаёт файл теста сам",
    "export function call(id: string, body: { net?: number; id?: string } = {}, test?: string): unknown {",
    "  journal(id, test ? { test } : {});",
    "  return routes[id]!(body);",
    "}",
    "",
  ].join("\n"),
  "tests/lib/journal.ts": [
    'import { resetJournal } from "../../.agents/skills/spec/scripts/harness.ts";',
    "",
    'process.env.SPEC_JOURNAL ??= ".spec-journal/unit";',
    "resetJournal();",
    "",
  ].join("\n"),
  "tests/lib/journal-e2e.ts": [
    'import { resetJournal } from "../../.agents/skills/spec/scripts/harness.ts";',
    "",
    "export default function journalReset(): void {",
    "  resetJournal();",
    "}",
    "",
  ].join("\n"),
  "tests/capabilities/orders/orders.md": "Заказы магазина: сумма с НДС, оплата, поиск по номеру.\n",
  "tests/capabilities/orders/orders.test.ts": [
    'import { describe, expect, it } from "bun:test";',
    'import { call } from "../../lib/app.ts";',
    "",
    'describe("Заказ считается с НДС и уходит в оплату, только когда платёжный сервис настроен", () => {',
    '  it("сумма заказа — цена с НДС 20%", () => {',
    '    expect(call("POST /orders", { net: 1000 })).toMatchObject({ total: 1200 });',
    "  });",
    "",
    '  it("без ключа платёжного сервиса заказ не уходит в оплату", () => {',
    '    expect(call("POST /orders", { net: 1000 })).toMatchObject({ paid: false });',
    "  });",
    "});",
    "",
  ].join("\n"),
  "tests/capabilities/orders/orders.e2e.ts": [
    'import { expect, test } from "@playwright/test";',
    'import { call } from "../../lib/app.ts";',
    "",
    'test.describe("Заказ считается с НДС и уходит в оплату, только когда платёжный сервис настроен", () => {',
    '  test("созданный заказ находится по номеру", () => {',
    '    const { id } = call("POST /orders", { net: 500 }, test.info().file) as { id: string };',
    '    expect(call("GET /orders/:id", { id }, test.info().file)).toEqual({ id, total: 600 });',
    "  });",
    "});",
    "",
  ].join("\n"),
  "tests/standards/entry-points/entry-points.md": "Каждая точка входа вызывается тестом capability.\n",
  "tests/standards/entry-points/entries.ts": 'import { routes } from "../../../src/server.ts";\n\nexport default () => Object.keys(routes);\n',
  "tests/standards/dead-code/dead-code.md": "Файл, экспорт или зависимость, до которых не доходит ни одна точка входа, — мёртвый код.\n",
  "tests/standards/dead-code/dead-code.test.ts": [
    'import { describe, it } from "bun:test";',
    'import { deadCode, exceptionsIn } from "../../../.agents/skills/spec/scripts/harness.ts";',
    "",
    'describe("Нет кода без потребителя", () => deadCode(it, { root: process.cwd(), exceptions: exceptionsIn() }));',
    "",
  ].join("\n"),
};

export interface RealProject {
  /** `bun run <script> …args` в проекте: код, stdout и весь вывод (stdout и stderr — bun run печатает в него команду). */
  run(script: string, ...args: string[]): { code: number | null; stdout: string; output: string };
  read(rel: string): string;
  write(files: Record<string, string>): void;
  /** Коммит всего, что в рабочем дереве. */
  commit(message: string): void;
  git(...args: string[]): string;
}

/**
 * Проект магазина в `sb.proj` — закоммичен, флоу ещё не стоит: workspace-пакет цен, маршруты, юниты под `bun test`,
 * стандарты своим `test:spec`, e2e под Playwright, реестр точек входа, deadCode. Зависимости — ссылки на `node_modules` Elves (knip и Playwright —
 * его devDependencies), пакет workspace — ссылкой, как его кладёт менеджер пакетов; в PATH песочницы — node: на нём
 * идут knip и Playwright.
 */
export function realProject(sb: Sandbox): RealProject {
  const { proj } = sb;
  writeTree(proj, FILES);
  const modules = path.join(proj, "node_modules");
  mkdirSync(path.join(modules, ".bin"), { recursive: true });
  mkdirSync(path.join(modules, "@playwright"));
  mkdirSync(path.join(modules, "@shop"));
  const dep = (name: string) => path.dirname(createRequire(path.join(REPO, "package.json")).resolve(`${name}/package.json`));
  symlinkSync(dep("knip"), path.join(modules, "knip"));
  symlinkSync(dep("@playwright/test"), path.join(modules, "@playwright/test"));
  symlinkSync(path.join(dep("knip"), "bin/knip.js"), path.join(modules, ".bin/knip"));
  symlinkSync(path.join(dep("@playwright/test"), "cli.js"), path.join(modules, ".bin/playwright"));
  symlinkSync("../../packages/prices", path.join(modules, "@shop/prices"));
  symlinkSync(execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim(), path.join(sb.bin, "node"));
  // кэш трансформаций Playwright — свой: прогон не возьмёт модуль, разобранный прошлым запуском
  sb.env.PWTEST_CACHE_DIR = path.join(sb.tmp, "playwright-cache");
  const repo = gitRepo(proj, { init: false });
  repo.commit({}, "feat: магазин");
  return {
    run(script, ...args) {
      const r = spawnSync(process.execPath, ["run", script, ...args], { cwd: proj, env: sb.env, encoding: "utf8" });
      if (r.error) throw r.error;
      return { code: r.status, stdout: r.stdout, output: r.stdout + r.stderr };
    },
    read: (rel) => readFileSync(path.join(proj, rel), "utf8"),
    write: (files) => writeTree(proj, files),
    commit: (message) => void repo.commit({}, message),
    git: repo.git,
  };
}
