import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { architecture, boundariesConfig, cspConnectSrc, deployUnits, hostsIn, importsIn, networkGuard } from "../../../skills/spec/scripts/architecture.ts";
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

  it("клиент хранилища импортирует только контейнер со связью с ним", async () => {
    writeTree(dir, { ...deploy, "src/mailer/send.ts": 'import pg from "pg";\nexport const send = pg;\n' });
    const r = await outcomes((it) => architecture(it, { root: dir, model: c2 }));
    expect(r["клиент pg хранилища db — в контейнере app"]).toBe("✓");
    expect(r["клиент pg хранилища db — в контейнере mail"]).toStartWith("✗ контейнер mail импортирует клиент pg хранилища db без связи uses: src/mailer/send.ts");
  });
});

