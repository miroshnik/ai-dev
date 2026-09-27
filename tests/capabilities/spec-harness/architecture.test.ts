import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { architecture, cspConnectSrc, importsIn, networkGuard } from "../../../skills/spec/scripts/architecture.ts";
import type { Model } from "../../../skills/spec/scripts/architecture.ts";
import { eslintLinter, examples } from "../../../skills/spec/scripts/harness.ts";
import type { It } from "../../../skills/spec/scripts/harness.ts";
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

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const model: Model = {
  roots: ["src"],
  aliases: { "@/": "src/" },
  modules: {
    domain: { path: "src/domain", purpose: "правила счетов, без ввода-вывода" },
    infra: { path: "src/infra", purpose: "база и внешние сервисы", dependsOn: ["domain"], packages: ["pg"] },
    ui: { path: "src/ui", purpose: "страницы", dependsOn: ["domain"], packages: ["react"] },
  },
};

const code = {
  "src/domain/invoice.js": 'import { round } from "./money.js";\nimport fs from "node:fs";\nexport const total = round;\n',
  "src/domain/money.js": "export const round = (x) => x;\n",
  "src/infra/db.js": 'import pg from "pg";\nimport { total } from "../domain/invoice.js";\nexport const db = { pg, total };\n',
  "src/ui/page.js": 'import React from "react";\nimport { total } from "@/domain/invoice.js";\nexport const page = { React, total };\n',
  "src/ui/types.ts": 'import type { Pool } from "pg";\nexport type P = Pool;\n',
};

/**
 * Модель архитектуры — модули (путь, назначение), от каких модулей и внешних пакетов каждый зависит — одна на проект,
 * в `tests/architecture/model.ts`. Из неё генерируются правила границ ESLint и тесты: код, который вышел за модель,
 * валит проверку, а модель, которая разошлась с кодом, — тоже.
 */
describe("Модель архитектуры проверяется кодом: модули, их зависимости и пакеты", () => {
  // Границы — eslint-plugin-boundaries: работает с ESLint 10 (Sheriff заявляет только ESLint 8–9) и виден в редакторе.
  // Внешние пакеты он в v7.2 не ловит даже явным disallow (проверено на фикстуре) — их проверяет разбор импортов ниже.
  it("импорт через границу модулей — ошибка lint из правил, сгенерированных по модели; разрешённая зависимость — нет", async () => {
    const boundaries = createRequire(import.meta.url).resolve("eslint-plugin-boundaries");
    writeTree(dir, {
      "package.json": JSON.stringify({ name: "app", type: "module" }),
      "tests/architecture/model.ts": `export default ${JSON.stringify(model)};\n`,
      "tests/architecture/boundaries/eslint.ts": [
        `import boundaries from ${JSON.stringify(boundaries)};`,
        `import { boundariesConfig } from ${JSON.stringify(path.join(SCRIPTS, "architecture.ts"))};`,
        `import model from "../model.ts";`,
        `export default boundariesConfig(model, boundaries);`,
      ].join("\n"),
      "eslint.config.mjs": `import { collectEslint } from ${JSON.stringify(path.join(SCRIPTS, "eslint-config.ts"))};\nexport default [...(await collectEslint(import.meta.dirname))];\n`,
      ...code,
    });
    const r = await outcomes((it) =>
      examples(it, {
        linter: eslintLinter({ cwd: dir, module: createRequire(import.meta.url).resolve("eslint") }),
        rule: "boundaries/dependencies",
        bad: [{ name: "домен импортирует инфраструктуру", path: "src/domain/rule.js", code: 'import { db } from "../infra/db.js";\nexport const x = db;\n' }],
        good: [
          { name: "инфраструктура импортирует домен", path: "src/infra/repo.js", code: 'import { total } from "../domain/invoice.js";\nexport const x = total;\n' },
          { name: "импорт внутри модуля", path: "src/domain/other.js", code: 'import { round } from "./money.js";\nexport const x = round;\n' },
        ],
      }),
    );
    expect(r).toEqual({
      "нельзя: домен импортирует инфраструктуру": "✓",
      "можно: инфраструктура импортирует домен": "✓",
      "можно: импорт внутри модуля": "✓",
    });
  });

  it("каталог кода в модуле — зелёный тест «<каталог> → <модуль>», вне модулей — упавший", async () => {
    writeTree(dir, { ...code, "src/stray.js": "export const s = 1;\n", "src/scripts/seed.js": "export const s = 1;\n" });
    const r = await outcomes((it) => architecture(it, { root: dir, model }));
    expect(r["src/domain → domain"]).toBe("✓");
    expect(r["src/ui → ui"]).toBe("✓");
    expect(r["src/scripts → ?"]).toStartWith("✗ src/scripts: код вне модулей модели");
    expect(r["src → ?"]).toStartWith("✗ src: код вне модулей модели");
  });

  it("внешний пакет в модуле, которому он не разрешён, — упавший тест; разрешённый — зелёный", async () => {
    writeTree(dir, { ...code, "src/domain/save.js": 'import pg from "pg";\nexport const s = pg;\n' });
    const r = await outcomes((it) => architecture(it, { root: dir, model }));
    expect(r["infra импортирует pg"]).toBe("✓");
    expect(r["ui импортирует react"]).toBe("✓");
    expect(r["domain импортирует pg"]).toStartWith("✗ модулю domain пакет pg не разрешён: src/domain/save.js");
  });

  it("разрешённый модулю пакет, который им не используется, — упавший тест: модель разошлась с кодом", async () => {
    writeTree(dir, { ...code, "src/ui/page.js": "export const page = 1;\n" });
    const r = await outcomes((it) => architecture(it, { root: dir, model }));
    expect(r["infra использует разрешённый пакет pg"]).toBe("✓");
    expect(r["ui использует разрешённый пакет react"]).toStartWith("✗ модуль ui не импортирует react — убери пакет из модели");
  });
});

describe("Импорт — это пакет, только если не локальный путь, не псевдоним, не встроенный модуль и не тип", () => {
  it("псевдоним, относительный путь, node:-модуль, встроенный без префикса и import type — не пакеты; scope и подпуть — имя пакета", () => {
    const text = [
      'import a from "@/domain/x.js";',
      'import b from "./y.js";',
      'import fs from "node:fs";',
      'import path from "path";',
      'import type { T } from "pg";',
      'import { z } from "@scope/lib/deep";',
      'export { w } from "lodash/fp";',
      'const r = await import("react");',
      'const q = require("qs");',
    ].join("\n");
    expect(importsIn(text, { "@/": "src/" })).toEqual(["@scope/lib", "lodash", "react", "qs"]);
  });
});

const c1: Model = {
  roots: ["src"],
  modules: {
    billing: { path: "src/billing", purpose: "счета" },
    stripe: { path: "src/stripe", purpose: "адаптер платёжного провайдера", packages: ["stripe"] },
  },
  externals: {
    payments: { purpose: "платежи картой", adapter: "stripe", hosts: ["api.stripe.com"], packages: ["stripe"], env: ["STRIPE_KEY"] },
  },
};
const adapter = {
  "src/stripe/client.ts": 'import Stripe from "stripe";\nconst url = "https://api.stripe.com/v1";\nconst key = process.env.STRIPE_KEY;\nexport const s = { Stripe, url, key };\n',
  "src/billing/invoice.ts": "export const total = 1;\n",
};

/**
 * C1 — система и внешние системы. Модель называет каждую внешнюю систему и её адаптер: хосты, пакеты и ключи
 * окружения внешней системы живут только в адаптере, а запрос к хосту вне модели в тестах падает — что система
 * говорит только с объявленными внешними системами, проверено, а не нарисовано.
 */
describe("Внешние системы модели (C1) проверяются кодом", () => {
  it("хост внешней системы в коде — только в её адаптере; необъявленный хост — упавший тест", async () => {
    writeTree(dir, {
      ...adapter,
      "src/billing/pay.ts": 'export const a = fetch("https://api.stripe.com/v1/charges");\nexport const b = fetch("https://evil.example.com/x");\n',
    });
    const r = await outcomes((it) => architecture(it, { root: dir, model: c1 }));
    expect(r["хост api.stripe.com — только в адаптере stripe"]).toStartWith("✗ хост api.stripe.com внешней системы payments — вне её адаптера stripe: src/billing/pay.ts");
    expect(r["хост evil.example.com — только в адаптере ?"]).toStartWith("✗ хост evil.example.com не объявлен ни одной внешней системой модели: src/billing/pay.ts");
  });

  it("пакет внешней системы разрешён только её адаптеру — иначе модель противоречит себе", async () => {
    writeTree(dir, adapter);
    const both: Model = { ...c1, modules: { ...c1.modules, billing: { path: "src/billing", purpose: "счета", packages: ["stripe"] } } };
    const ok = await outcomes((it) => architecture(it, { root: dir, model: c1 }));
    expect(ok["пакет stripe внешней системы payments — только у адаптера stripe"]).toBe("✓");
    const bad = await outcomes((it) => architecture(it, { root: dir, model: both }));
    expect(bad["пакет stripe внешней системы payments — только у адаптера stripe"]).toStartWith("✗ пакет stripe внешней системы payments разрешён не только адаптеру: billing");
  });

  it("ключ окружения внешней системы читает только её адаптер", async () => {
    writeTree(dir, { ...adapter, "src/billing/pay.ts": "export const k = process.env.STRIPE_KEY;\n" });
    const r = await outcomes((it) => architecture(it, { root: dir, model: c1 }));
    expect(r["ключ STRIPE_KEY внешней системы payments читает только адаптер stripe"]).toStartWith(
      "✗ ключ STRIPE_KEY внешней системы payments читается вне адаптера stripe: src/billing/pay.ts",
    );
  });

  it("в тестах запрос к хосту вне модели падает, к объявленному — идёт дальше", async () => {
    const calls: string[] = [];
    const fetchGuarded = networkGuard(c1, async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("ok");
    });
    await expect(fetchGuarded("https://evil.example.com/x")).rejects.toThrow("запрос к хосту evil.example.com вне модели");
    expect(await (await fetchGuarded("https://api.stripe.com/v1/charges")).text()).toBe("ok");
    expect(await (await fetchGuarded("http://localhost:3000/api")).text()).toBe("ok");
    expect(calls).toEqual(["https://api.stripe.com/v1/charges", "http://localhost:3000/api"]);
  });

  it("CSP connect-src браузера собирается из хостов модели", () => {
    const withMaps: Model = { ...c1, externals: { ...c1.externals, maps: { purpose: "карты", adapter: "billing", hosts: ["maps.example.org"] } } };
    expect(cspConnectSrc(withMaps)).toBe("connect-src 'self' https://api.stripe.com https://maps.example.org");
  });
});

