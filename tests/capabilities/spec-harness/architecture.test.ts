import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { architecture, boundariesConfig, cspConnectSrc, deployUnits, hostsIn, importsIn, networkGuard, workspacePackages } from "../../../skills/spec/scripts/architecture.ts";
import type { Model } from "../../../skills/spec/scripts/architecture.ts";
import { configGet, eslintLinter, examples } from "../../../skills/spec/scripts/harness.ts";
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

// все исходы по порядку: одноимённые тесты разных реестров в словаре затирали бы друг друга
async function allOutcomes(register: (it: It) => void): Promise<[string, string][]> {
  const tests: [string, () => void | Promise<unknown>][] = [];
  register((name, fn) => tests.push([name, fn]));
  const out: [string, string][] = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      out.push([name, "✓"]);
    } catch (e) {
      out.push([name, "✗ " + (e as Error).message]);
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

  // название — утверждение по-русски: «src/app → app» без слов spec-doc --strict не принимает
  it("каталог кода — в модуле: название — утверждение; вне модулей — упавший тест", async () => {
    writeTree(dir, { ...code, "src/stray.js": "export const s = 1;\n", "src/scripts/seed.js": "export const s = 1;\n" });
    const r = await outcomes((it) => architecture(it, { root: dir, model }));
    expect(r["каталог src/domain — в модуле domain"]).toBe("✓");
    expect(r["каталог src/ui — в модуле ui"]).toBe("✓");
    expect(r["каталог src/scripts — в модуле ?"]).toStartWith("✗ src/scripts: код вне модулей модели");
    expect(r["каталог src — в модуле ?"]).toStartWith("✗ src: код вне модулей модели");
  });

  // корень приложения и его библиотека: файлы корня src (proxy.ts, instrumentation.ts) — свой модуль, src/lib — свой
  it("вложенный путь модуля: каталог — в модуле с самым длинным путём, в правилах ESLint он первым", async () => {
    const nested: Model = { roots: ["src"], modules: { app: { path: "src", purpose: "приложение" }, lib: { path: "src/lib", purpose: "библиотека" } } };
    writeTree(dir, { "src/proxy.ts": "export const p = 1;\n", "src/lib/money.ts": "export const m = 1;\n", "src/lib/fmt/date.ts": "export const d = 1;\n" });
    const r = await outcomes((it) => architecture(it, { root: dir, model: nested }));
    expect(r["каталог src — в модуле app"]).toBe("✓");
    expect(r["каталог src/lib — в модуле lib"]).toBe("✓");
    expect(r["каталог src/lib/fmt — в модуле lib"]).toBe("✓");
    const [config] = boundariesConfig(nested, {}) as { settings: Record<string, unknown> }[];
    expect(config!.settings["boundaries/elements"]).toEqual([
      { type: "lib", pattern: "src/lib" },
      { type: "app", pattern: "src" },
    ]);
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

  // корни модели — руками: пакет, добавленный в workspace, иначе остался бы вне проверки целиком
  it("пакет workspace с кодом — в корнях модели; новый пакет вне корней — упавший тест", async () => {
    writeTree(dir, {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*", "packages/*", "!packages/legacy"] }),
      "apps/web/package.json": "{}",
      "apps/web/src/page.ts": "export const p = 1;\n",
      "apps/notes/readme.ts": "export const n = 1;\n",
      "packages/ui/package.json": "{}",
      "packages/ui/button.ts": "export const b = 1;\n",
      "packages/tsconfig/package.json": "{}",
      "packages/tsconfig/base.json": "{}",
      "packages/legacy/package.json": "{}",
      "packages/legacy/index.js": "export const l = 1;\n",
      "packages/new/package.json": "{}",
      "packages/new/src/index.ts": "export const n = 1;\n",
    });
    writeTree(path.join(dir, "pnpm"), {
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - \'packages/**\'\n  - "!**/fixtures/**"\ncatalog:\n  react: ^19\n',
      "apps/api/package.json": "{}",
      "packages/group/inner/package.json": "{}",
      "packages/ui/package.json": "{}",
      "packages/ui/fixtures/demo/package.json": "{}",
      "packages/ui/node_modules/dep/package.json": "{}",
    });
    writeTree(path.join(dir, "yarn"), { "package.json": JSON.stringify({ workspaces: { packages: ["libs/*"] } }), "libs/core/package.json": "{}" });
    expect(workspacePackages(dir)).toEqual(["apps/web", "packages/new", "packages/tsconfig", "packages/ui"]);
    expect(workspacePackages(path.join(dir, "pnpm"))).toEqual(["apps/api", "packages/group/inner", "packages/ui"]);
    expect(workspacePackages(path.join(dir, "yarn"))).toEqual(["libs/core"]);
    expect(workspacePackages(path.join(dir, "apps"))).toEqual([]);

    const ws: Model = {
      roots: ["apps/web/src", "packages"],
      modules: { web: { path: "apps/web/src", purpose: "сайт" }, packages: { path: "packages", purpose: "общие пакеты" } },
    };
    const r = await outcomes((it) => architecture(it, { root: dir, model: ws }));
    expect(r["пакет workspace apps/web — в корнях кода"]).toBe("✓");
    expect(r["пакет workspace packages/ui — в корнях кода"]).toBe("✓");
    expect(r["пакет workspace packages/tsconfig — в корнях кода"]).toBeUndefined();
    const narrow: Model = { ...ws, roots: ["apps/web/src", "packages/ui"] };
    const bad = await outcomes((it) => architecture(it, { root: dir, model: narrow }));
    expect(bad["пакет workspace packages/new — в корнях кода"]).toStartWith("✗ packages/new: пакет workspace с кодом вне корней модели");
    expect(bad["нарушитель не проходит: пакет workspace вне корней"]).toBe("✓");
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

  // список путей — тип модели: локальность решает префикс, а прежний Record<string, string> монорепо не выражал (typecheck)
  it("псевдоним со списком путей — у каждого приложения монорепо свой `@/`, импорт по нему — не пакет", async () => {
    const mono: Model = {
      roots: ["apps/web/src", "apps/admin/src"],
      aliases: { "@/": ["apps/web/src/", "apps/admin/src/"] },
      modules: {
        web: { path: "apps/web/src", purpose: "сайт", packages: ["react"] },
        admin: { path: "apps/admin/src", purpose: "админка" },
      },
    };
    writeTree(dir, {
      "apps/web/src/page.tsx": 'import React from "react";\nimport { a } from "@/lib/a";\nexport const p = { React, a };\n',
      "apps/web/src/lib/a.ts": "export const a = 1;\n",
      "apps/admin/src/page.ts": 'import { b } from "@/b";\nexport const p = b;\n',
      "apps/admin/src/b.ts": "export const b = 1;\n",
    });
    const r = await outcomes((it) => architecture(it, { root: dir, model: mono }));
    expect(r["web импортирует react"]).toBe("✓");
    expect(Object.entries(r).filter(([, v]) => v !== "✓")).toEqual([]);
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
// сторож над «сетью», которая записывает дошедшие до неё запросы
const guarded = (opts: { allow?: string[] } = {}) => {
  const calls: string[] = [];
  const guard = networkGuard(
    c1,
    async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("ok");
    },
    opts,
  );
  return { guard, calls };
};

/**
 * C1 — система и внешние системы. Модель называет каждую внешнюю систему и её адаптер: хосты, пакеты и ключи
 * окружения внешней системы живут только в адаптере, а в тестах падает запрос к хосту вне модели и к объявленному без мока — что система
 * говорит только с объявленными внешними системами, проверено, а не нарисовано.
 */
describe("Внешние системы модели (C1) проверяются кодом", () => {
  // SVG и createElementNS несут URI пространства имён, документация — ссылки в комментариях, примеры — домены RFC 2606
  it("хост и переменная в комментарии, пространство имён SVG и зарезервированный домен — не находки", () => {
    const src = [
      "// документация: https://docs.stripe.com/api",
      '/* "https://old.api.io/v1" */',
      'const svg = \'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>\';',
      'const el = document.createElementNS("http://www.w3.org/2000/svg", "path");',
      'const demo = ["https://example.com/a", "https://api.example.org", "https://x.invalid/", "https://shop.example/", "https://api.test/"];',
      'const api = "https://api.stripe.com/v1";',
    ].join("\n");
    expect(hostsIn(src)).toEqual(["api.stripe.com"]);
  });

  // IP — такой же адрес внешней системы, как домен; локален только loopback: из машины он не уходит
  it("IP в литерале URL — хост внешней системы, loopback — нет", () => {
    const src = [
      'const local = ["http://localhost:3000/", "http://app.localhost/", "http://127.0.0.1:54321/rest", "http://127.1.2.3/", "http://0.0.0.0:8080/"];',
      'const dns = "https://8.8.8.8/resolve";',
    ].join("\n");
    expect(hostsIn(src)).toEqual(["8.8.8.8"]);
  });

  // ссылку открывает браузер посетителя — система с этим хостом не говорит; переход кодом (location) — часть
  // интеграции (оплата, вход), а <link href> и src браузер грузит сам: это хосты
  it("ссылка навигации — `href` ссылки и объекта — не хост; `<link href>`, `src`, `fetch` и `location` — хосты", () => {
    const src = [
      'export const A = () => <a href="https://t.me/support">Telegram</a>;',
      'export const B = () => <Link className="x" href={"https://wa.me/79990000000"}>WhatsApp</Link>;',
      "export const C = (u: string) => <a href={`https://vk.com/${u}`}>VK</a>;",
      'export const links = [{ label: "VK", href: "https://vk.com/club" }];',
      'export const H = () => <link rel="preconnect" href="https://fonts.gstatic.com" />;',
      'export const I = () => <img src="https://cdn.shop.io/logo.png" />;',
      'export const r = fetch("https://api.shop.io/v1");',
      'location.href = "https://pay.provider.io/checkout";',
    ].join("\n");
    expect(hostsIn(src, "links.tsx")).toEqual(["fonts.gstatic.com", "cdn.shop.io", "api.shop.io", "pay.provider.io"]);
  });

  it("хост, пакет и ключ внешней системы с несколькими адаптерами — в любом из них; вне адаптеров — упавший тест", async () => {
    const multi: Model = {
      roots: ["src"],
      modules: {
        bot: { path: "src/bot", purpose: "бот", packages: ["grammy"] },
        notify: { path: "src/notify", purpose: "уведомления" },
        billing: { path: "src/billing", purpose: "счета" },
      },
      externals: { telegram: { purpose: "мессенджер", adapter: ["bot", "notify"], hosts: ["api.telegram.org"], packages: ["grammy"], env: ["TG_TOKEN"] } },
    };
    const files = {
      "src/bot/bot.ts": 'import { Bot } from "grammy";\nexport const b = new Bot(process.env.TG_TOKEN!);\n',
      "src/notify/send.ts": 'export const s = fetch("https://api.telegram.org/bot" + process.env.TG_TOKEN);\n',
      "src/billing/pay.ts": "export const p = 1;\n",
    };
    writeTree(dir, files);
    const ok = await outcomes((it) => architecture(it, { root: dir, model: multi }));
    expect(ok["хост api.telegram.org — только в адаптерах bot, notify"]).toBe("✓");
    expect(ok["пакет grammy внешней системы telegram — только у адаптеров bot, notify"]).toBe("✓");
    expect(ok["ключ TG_TOKEN внешней системы telegram читают только адаптеры bot, notify"]).toBe("✓");
    writeTree(dir, { "src/billing/pay.ts": 'export const p = fetch("https://api.telegram.org/x?t=" + process.env.TG_TOKEN);\n' });
    const bad = await outcomes((it) => architecture(it, { root: dir, model: multi }));
    expect(bad["хост api.telegram.org — только в адаптерах bot, notify"]).toStartWith("✗ хост api.telegram.org внешней системы telegram — вне её адаптеров bot, notify: src/billing/pay.ts");
    expect(bad["ключ TG_TOKEN внешней системы telegram читают только адаптеры bot, notify"]).toStartWith(
      "✗ ключ TG_TOKEN внешней системы telegram читается вне адаптеров bot, notify: src/billing/pay.ts",
    );
    const stray: Model = { ...multi, modules: { ...multi.modules, billing: { path: "src/billing", purpose: "счета", packages: ["grammy"] } } };
    const pkg = await outcomes((it) => architecture(it, { root: dir, model: stray }));
    expect(pkg["пакет grammy внешней системы telegram — только у адаптеров bot, notify"]).toStartWith("✗ пакет grammy внешней системы telegram разрешён не только адаптерам: billing");
  });

  // CDN или WAF перед сайтом: трафик идёт через него, а код с ним не говорит — адаптера нет, и в коде его следов нет
  it("внешняя система без адаптера — периметр: её хост, пакет или ключ в коде — упавший тест", async () => {
    const edge: Model = {
      roots: ["src"],
      modules: { web: { path: "src/web", purpose: "страницы" } },
      externals: { cdn: { purpose: "CDN и WAF перед сайтом", hosts: ["edge.shop.io"], packages: ["edge-sdk"], env: ["EDGE_PURGE_KEY"] } },
    };
    writeTree(dir, { "src/web/page.ts": "export const p = 1;\n" });
    const ok = await outcomes((it) => architecture(it, { root: dir, model: edge }));
    expect(ok["хост edge.shop.io внешней системы cdn — не в коде: адаптера нет"]).toBe("✓");
    expect(ok["пакет edge-sdk внешней системы cdn — ни у одного модуля: адаптера нет"]).toBe("✓");
    expect(ok["ключ EDGE_PURGE_KEY внешней системы cdn — не в коде: адаптера нет"]).toBe("✓");
    writeTree(dir, { "src/web/purge.ts": 'export const u = "https://edge.shop.io/purge";\nexport const k = process.env.EDGE_PURGE_KEY;\n' });
    const withSdk: Model = { ...edge, modules: { web: { path: "src/web", purpose: "страницы", packages: ["edge-sdk"] } } };
    const bad = await outcomes((it) => architecture(it, { root: dir, model: withSdk }));
    expect(bad["хост edge.shop.io внешней системы cdn — не в коде: адаптера нет"]).toStartWith("✗ у внешней системы cdn нет адаптера, а хост edge.shop.io — в коде: src/web/purge.ts");
    expect(bad["пакет edge-sdk внешней системы cdn — ни у одного модуля: адаптера нет"]).toStartWith("✗ у внешней системы cdn нет адаптера, а пакет edge-sdk разрешён модулям: web");
    expect(bad["ключ EDGE_PURGE_KEY внешней системы cdn — не в коде: адаптера нет"]).toStartWith("✗ у внешней системы cdn нет адаптера, а ключ EDGE_PURGE_KEY читается в коде: src/web/purge.ts");
  });

  // интеграция через заголовки: периметр (Cloudflare, балансировщик) кладёт страну и IP посетителя в запрос
  it("заголовок интеграции внешней системы читает только адаптер", async () => {
    const cf: Model = {
      roots: ["src"],
      modules: { geo: { path: "src/geo", purpose: "страна и IP посетителя" }, web: { path: "src/web", purpose: "страницы" } },
      externals: { cloudflare: { purpose: "CDN перед сайтом", adapter: "geo", headers: ["CF-IPCountry", "CF-Connecting-IP"] } },
    };
    writeTree(dir, {
      "src/geo/country.ts": 'export const country = (h: Headers) => h.get("cf-ipcountry");\n',
      "src/web/ip.ts": 'export const ip = (req: { headers: Record<string, string> }) => req.headers["CF-Connecting-IP"];\n// h.get("cf-ipcountry") — в комментарии не чтение\n',
    });
    const r = await outcomes((it) => architecture(it, { root: dir, model: cf }));
    expect(r["заголовок CF-IPCountry внешней системы cloudflare читает только адаптер geo"]).toBe("✓");
    expect(r["заголовок CF-Connecting-IP внешней системы cloudflare читает только адаптер geo"]).toStartWith(
      "✗ заголовок CF-Connecting-IP внешней системы cloudflare читается вне адаптера geo: src/web/ip.ts",
    );
    expect(r["нарушитель не проходит: заголовок вне адаптера"]).toBe("✓");
  });

  it("хост внешней системы в коде — только в её адаптере; необъявленный хост — упавший тест", async () => {
    writeTree(dir, {
      ...adapter,
      "src/billing/pay.ts": 'export const a = fetch("https://api.stripe.com/v1/charges");\nexport const b = fetch("https://evil.io/x");\n',
    });
    const r = await outcomes((it) => architecture(it, { root: dir, model: c1 }));
    expect(r["хост api.stripe.com — только в адаптере stripe"]).toStartWith("✗ хост api.stripe.com внешней системы payments — вне её адаптера stripe: src/billing/pay.ts");
    expect(r["хост evil.io — только в адаптере ?"]).toStartWith("✗ хост evil.io не объявлен ни одной внешней системой модели: src/billing/pay.ts");
  });

  it("исключение — только у реестра, в котором есть его элемент", async () => {
    writeTree(dir, { ...adapter, "src/billing/legacy.ts": 'export const u = "https://legacy.io/api";\n' });
    const exceptions = [{ item: "legacy.io", issue: 7, reason: "уйдёт с переездом в #7" }];
    const all = await allOutcomes((it) => architecture(it, { root: dir, model: c1, exceptions }));
    expect(all.filter(([n]) => n === "исключение: legacy.io (#7)")).toEqual([["исключение: legacy.io (#7)", "✓"]]);
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

  // NestJS: ключ читают аксессором ConfigService — те же readers, что у envVars
  it("ключ внешней системы, прочитанный аксессором конфига вне адаптера, — упавший тест", async () => {
    writeTree(dir, { ...adapter, "src/billing/pay.ts": 'export const k = (config: Config) => config.getOrThrow<string>("STRIPE_KEY");\n' });
    const plain = await outcomes((it) => architecture(it, { root: dir, model: c1 }));
    expect(plain["ключ STRIPE_KEY внешней системы payments читает только адаптер stripe"]).toBe("✓");
    const r = await outcomes((it) => architecture(it, { root: dir, model: c1, readers: [configGet] }));
    expect(r["ключ STRIPE_KEY внешней системы payments читает только адаптер stripe"]).toStartWith(
      "✗ ключ STRIPE_KEY внешней системы payments читается вне адаптера stripe: src/billing/pay.ts",
    );
  });

  it("ключ окружения в комментарии вне адаптера — не чтение", async () => {
    writeTree(dir, { ...adapter, "src/billing/pay.ts": "// ключ (process.env.STRIPE_KEY) читает только адаптер\nexport const k = 1;\n" });
    const r = await outcomes((it) => architecture(it, { root: dir, model: c1 }));
    expect(r["ключ STRIPE_KEY внешней системы payments читает только адаптер stripe"]).toBe("✓");
  });

  // сторож — сеть под моками: что до него дошло, не замокано; дальше пускает только то, что из машины не уходит, и allow
  it("в тестах до сети доходят только loopback и хосты allow", async () => {
    const { guard, calls } = guarded({ allow: ["db"] });
    const through = ["http://localhost:3000/api", "http://app.localhost/", "http://127.0.0.1:54321/", "http://127.9.9.9/", "http://[::1]:8080/", "http://0.0.0.0:3000/", "http://db:5432/", new URL("http://localhost/u"), new Request("http://localhost/r")];
    for (const u of through) expect(await (await guard(u)).text()).toBe("ok");
    expect(calls).toEqual(through.map((u) => (u instanceof Request ? u.url : String(u))));
    expect(guard.rejected).toEqual([]);
  });

  it("запрос к объявленному хосту без мока падает с именем хоста и внешней системы — в сеть не идёт", async () => {
    const { guard, calls } = guarded();
    await expect(guard("https://api.stripe.com/v1/charges")).rejects.toThrow("запрос к хосту api.stripe.com внешней системы payments без мока");
    expect(calls).toEqual([]);
  });

  it("запрос к хосту вне модели падает; публичный IP и домен .test — не локальные", async () => {
    const { guard, calls } = guarded();
    await expect(guard("https://evil.example.com/x")).rejects.toThrow("запрос к хосту evil.example.com вне модели");
    await expect(guard("http://8.8.8.8/")).rejects.toThrow("запрос к хосту 8.8.8.8 вне модели");
    await expect(guard("https://api.test/")).rejects.toThrow("запрос к хосту api.test вне модели");
    expect(calls).toEqual([]);
  });

  // код под тестом ловит исключение fetch (адаптер с try/catch): без проверки после теста тест прошёл бы молча
  it("отвергнутый запрос, который поймал код под тестом, роняет check() после теста", async () => {
    const { guard } = guarded();
    const swallow = (u: string) => guard(u).catch(() => null);
    expect(await swallow("https://api.stripe.com/v1/charges")).toBeNull();
    expect(await swallow("https://evil.io/x")).toBeNull();
    expect(guard.rejected).toEqual(["api.stripe.com", "evil.io"]);
    expect(() => guard.check()).toThrow(/^запросы к сети, отвергнутые сторожем: api\.stripe\.com, evil\.io/);
    expect(guard.rejected).toEqual([]);
    expect(() => guard.check()).not.toThrow();
  });

  it("CSP connect-src браузера собирается из хостов модели", () => {
    const withMaps: Model = { ...c1, externals: { ...c1.externals, maps: { purpose: "карты", adapter: "billing", hosts: ["maps.example.org"] } } };
    expect(cspConnectSrc(withMaps)).toBe("connect-src 'self' https://api.stripe.com https://maps.example.org");
  });
});

const c2: Model = {
  roots: ["src"],
  modules: {
    web: { path: "src/web", purpose: "страницы", dependsOn: ["domain"] },
    domain: { path: "src/domain", purpose: "правила" },
    mailer: { path: "src/mailer", purpose: "письма", packages: ["pg"] },
    repo: { path: "src/repo", purpose: "доступ к базе", packages: ["pg"] },
  },
  containers: {
    app: { purpose: "веб-приложение", modules: ["web", "domain", "repo"], deploy: ["compose:app"], uses: ["db"] },
    mail: { purpose: "отправка писем", modules: ["mailer"], deploy: ["supabase-function:send-email"] },
    db: { purpose: "база", deploy: ["compose:db"], clients: ["pg"] },
  },
};
const deploy = {
  "docker-compose.yml": "services:\n  app:\n    build: .\n  db:\n    image: postgres:17\n",
  "supabase/functions/send-email/index.ts": "export default () => 1;\n",
  "src/web/page.ts": 'import { rule } from "../domain/rule.ts";\nexport const p = rule;\n',
  "src/domain/rule.ts": "export const rule = 1;\n",
  "src/repo/db.ts": 'import pg from "pg";\nexport const db = pg;\n',
  "src/mailer/send.ts": "export const send = 1;\n",
};

// монорепо: два приложения, общие пакеты — библиотеки, собранные в бандл каждого приложения
const mono: Model = {
  roots: ["apps", "packages"],
  modules: {
    web: { path: "apps/web", purpose: "сайт", dependsOn: ["ui"] },
    admin: { path: "apps/admin", purpose: "админка", dependsOn: ["ui", "data"] },
    ui: { path: "packages/ui", purpose: "компоненты", library: true, dependsOn: ["tokens"] },
    tokens: { path: "packages/tokens", purpose: "цвета и отступы", library: true },
    data: { path: "packages/data", purpose: "доступ к базе", library: true, packages: ["pg"] },
  },
  containers: {
    site: { purpose: "сайт", modules: ["web", "data"], uses: ["db"] },
    backoffice: { purpose: "админка", modules: ["admin"] },
    db: { purpose: "база", clients: ["pg"] },
  },
};
const monorepo = {
  "apps/web/page.ts": 'import { b } from "../../packages/ui/button.ts";\nexport const p = b;\n',
  "apps/admin/page.ts": 'import { b } from "../../packages/ui/button.ts";\nexport const p = b;\n',
  "packages/ui/button.ts": "export const b = 1;\n",
  "packages/tokens/colors.ts": "export const c = 1;\n",
  "packages/legacy/old.ts": "export const o = 1;\n",
  "packages/shared/x.ts": "export const x = 1;\n",
  "packages/data/db.ts": 'import pg from "pg";\nexport const db = pg;\n',
};

/**
 * C2 — развёртываемые единицы и связи между ними. Модель называет контейнеры, их модули и связи; реальность —
 * конфиги деплоя в репозитории. Контейнер без конфига и конфиг без контейнера, импорт через границу контейнера и
 * клиент хранилища без связи с ним — упавшие тесты.
 */
describe("Контейнеры модели (C2) сверяются с кодом и конфигами деплоя", () => {
  it("модуль — ровно в одном контейнере", async () => {
    writeTree(dir, deploy);
    const orphan: Model = { ...c2, modules: { ...c2.modules, jobs: { path: "src/jobs", purpose: "задачи" } } };
    const r = await outcomes((it) => architecture(it, { root: dir, model: orphan }));
    expect(r["модуль web — в контейнере app"]).toBe("✓");
    expect(r["модуль jobs — в контейнере ?"]).toStartWith("✗ модуль jobs не входит ни в один контейнер");
  });

  it("зависимость модулей между контейнерами — упавший тест, связь только uses", async () => {
    writeTree(dir, deploy);
    const cross: Model = { ...c2, modules: { ...c2.modules, mailer: { ...c2.modules.mailer!, dependsOn: ["domain"] } } };
    const r = await outcomes((it) => architecture(it, { root: dir, model: cross }));
    expect(r["зависимость web → domain — внутри контейнера"]).toBe("✓");
    expect(r["зависимость mailer → domain — внутри контейнера"]).toStartWith("✗ mailer (mail) зависит от domain (app) — между контейнерами только связь uses");
  });

  it("развёртываемая единица из конфигов деплоя — в модели, контейнер модели — в конфигах", async () => {
    writeTree(dir, { ...deploy, "supabase/functions/resize/index.ts": "export default () => 1;\n", "vercel.json": JSON.stringify({ crons: [{ path: "/api/cron/cleanup", schedule: "0 3 * * *" }] }) });
    expect(deployUnits(dir)).toEqual(["compose:app", "compose:db", "supabase-function:resize", "supabase-function:send-email", "vercel-cron:/api/cron/cleanup"]);
    const ghost: Model = { ...c2, containers: { ...c2.containers, worker: { purpose: "фон", deploy: ["compose:worker"] } } };
    const r = await outcomes((it) => architecture(it, { root: dir, model: ghost }));
    expect(r["развёртываемая единица compose:app — контейнер app"]).toBe("✓");
    expect(r["развёртываемая единица supabase-function:resize — контейнер ?"]).toStartWith("✗ supabase-function:resize есть в конфигах деплоя, но не в модели");
    expect(r["развёртываемая единица compose:worker — контейнер worker"]).toStartWith("✗ compose:worker контейнера worker нет в конфигах деплоя");
  });

  // нарушитель, на котором проверка проходит, не доказывает, что она умеет упасть: тест «нарушитель» — красный
  it("нарушители ключа окружения и зависимости через контейнер падают", async () => {
    writeTree(dir, deploy);
    const both: Model = { ...c2, externals: { mail: { purpose: "почта", adapter: "mailer", env: ["SMTP_URL"] } } };
    const r = await outcomes((it) => architecture(it, { root: dir, model: both }));
    expect(r["нарушитель не проходит: ключ вне адаптера"]).toBe("✓");
    expect(r["нарушитель не проходит: зависимость через контейнер"]).toBe("✓");
  });

  it("развёртываемая единица Terraform — вычислительный ресурс `*.tf`; прочие ресурсы и каталог `.terraform` — нет", () => {
    writeTree(dir, {
      "infra/ecs.tf": 'resource "aws_ecs_service" "api" {\n  name = "api"\n}\n\nresource "aws_ecs_cluster" "main" {}\n# resource "aws_ecs_service" "old" {}\n',
      "infra/lambda.tf": 'resource "aws_lambda_function" "resize" {\n}\n',
      "infra/gcp/run.tf": '  resource "google_cloud_run_v2_service" "web" {}\n',
      "infra/.terraform/modules/x/main.tf": 'resource "aws_ecs_service" "vendored" {}\n',
      "infra/notes.md": 'resource "aws_ecs_service" "doc" {}\n',
    });
    expect(deployUnits(dir)).toEqual(["terraform:aws_ecs_service.api", "terraform:aws_lambda_function.resize", "terraform:google_cloud_run_v2_service.web"]);
  });

  it("библиотека — в контейнерах модулей, которые от неё зависят; модуль без отметки library в нескольких контейнерах — упавший тест", async () => {
    writeTree(dir, monorepo);
    const legacy: Model = {
      ...mono,
      modules: { ...mono.modules, legacy: { path: "packages/legacy", purpose: "старые компоненты", library: true }, shared: { path: "packages/shared", purpose: "общее" } },
      containers: { site: { ...mono.containers!.site!, modules: ["web", "shared"] }, backoffice: { ...mono.containers!.backoffice!, modules: ["admin", "shared"] } },
    };
    const r = await outcomes((it) => architecture(it, { root: dir, model: legacy }));
    expect(r["библиотека ui — в контейнерах backoffice, site"]).toBe("✓");
    expect(r["библиотека tokens — в контейнерах backoffice, site"]).toBe("✓");
    expect(r["зависимость web → ui — внутри контейнера"]).toBe("✓");
    expect(r["зависимость ui → tokens — внутри контейнера"]).toBe("✓");
    expect(r["библиотека legacy — в контейнерах ?"]).toStartWith("✗ библиотека legacy не входит ни в один контейнер: от неё не зависит ни один модуль контейнеров");
    expect(r["модуль shared — в контейнере ?"]).toStartWith("✗ модуль shared — в нескольких контейнерах: backoffice, site — общий пакет отметь library: true");
  });

  it("зависимость библиотеки — внутри каждого её контейнера; клиент хранилища в библиотеке — со связью uses из каждого", async () => {
    writeTree(dir, { ...monorepo, "apps/web/session/s.ts": "export const s = 1;\n" });
    const leaky: Model = {
      ...mono,
      modules: { ...mono.modules, session: { path: "apps/web/session", purpose: "сессия сайта" }, ui: { ...mono.modules.ui!, dependsOn: ["tokens", "session"] } },
      containers: { ...mono.containers, site: { ...mono.containers!.site!, modules: ["web", "data", "session"] } },
    };
    const r = await outcomes((it) => architecture(it, { root: dir, model: leaky }));
    expect(r["зависимость ui → session — внутри контейнера"]).toStartWith("✗ ui (backoffice, site) зависит от session (site) — между контейнерами только связь uses");
    expect(r["клиент pg хранилища db — в контейнере site"]).toBe("✓");
    expect(r["клиент pg хранилища db — в контейнере backoffice"]).toStartWith("✗ контейнер backoffice импортирует клиент pg хранилища db без связи uses: packages/data/db.ts");
  });

  it("клиент хранилища импортирует только контейнер со связью с ним", async () => {
    writeTree(dir, { ...deploy, "src/mailer/send.ts": 'import pg from "pg";\nexport const send = pg;\n' });
    const r = await outcomes((it) => architecture(it, { root: dir, model: c2 }));
    expect(r["клиент pg хранилища db — в контейнере app"]).toBe("✓");
    expect(r["клиент pg хранилища db — в контейнере mail"]).toStartWith("✗ контейнер mail импортирует клиент pg хранилища db без связи uses: src/mailer/send.ts");
  });
});

