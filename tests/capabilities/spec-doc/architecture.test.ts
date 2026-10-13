import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, SCRIPTS, setLanguage, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
// проект на ru: тесты файла ждут русский вывод, без манифеста проект — en
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  setLanguage(dir, "ru");
});
afterEach(() => cleanup());

const MODEL = "tests/architecture/model.ts";
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");

/** Модель как в проекте: тип из скилла — только `import type`, значение — `satisfies Model`. */
const model = (body: string) =>
  `import type { Model } from ${JSON.stringify(path.join(SCRIPTS, "architecture.ts"))};\n\nexport default ${body} satisfies Model;\n`;

const FULL = `{
  name: "Счета",
  modules: {
    web: { path: "src/web", purpose: "страницы", dependsOn: ["domain"] },
    domain: { path: "src/domain", purpose: "правила счетов", api: "src/domain/index.ts" },
    repo: { path: "src/repo", purpose: "запросы к базе", dependsOn: ["domain"], packages: ["pg"] },
    payments: { path: "src/payments", purpose: "платежи", packages: ["stripe"] },
  },
  externals: {
    stripe: { purpose: "платёжный провайдер", adapter: "payments", hosts: ["api.stripe.com"] },
  },
  containers: {
    app: { purpose: "веб-приложение", modules: ["web", "domain", "repo", "payments"], deploy: ["compose:app"], uses: ["db"] },
    db: { purpose: "база", deploy: ["compose:db"], clients: ["pg"] },
  },
}`;

// общий пакет ui — библиотека в бандле обоих приложений; CDN — периметр, код с ним не говорит
const MONOREPO = `{
  name: "Магазин",
  modules: {
    web: { path: "apps/web", purpose: "сайт", dependsOn: ["ui"] },
    admin: { path: "apps/admin", purpose: "админка", dependsOn: ["ui"] },
    ui: { path: "packages/ui", purpose: "компоненты", library: true },
  },
  externals: {
    telegram: { purpose: "мессенджер", adapter: ["web", "admin"], hosts: ["api.telegram.org"] },
    cdn: { purpose: "CDN перед сайтом" },
  },
  containers: {
    site: { purpose: "сайт", modules: ["web"] },
    backoffice: { purpose: "админка", modules: ["admin"] },
  },
}`;

const MODULES_ONLY = `{
  modules: {
    domain: { path: "src/domain", purpose: "правила счетов" },
    infra: { path: ["src/infra", "src/jobs"], purpose: "база и задачи", dependsOn: ["domain"] },
  },
}`;

// правило архитектуры проекта — сверка модели с кодом; её страница — в списке правил
const RULE = "tests/architecture/modules/modules.test.ts";
const rules = () => vitestReport(dir, { [RULE]: [[[], "каталог src/web — модуль web"]] });

function doc(content: string, ...args: string[]) {
  writeFileSync(path.join(dir, "r.json"), content);
  return runScript("spec-doc", ["r.json", "--root", dir, ...args], dir);
}

const block = (...lines: string[]) => lines.join("\n");

/**
 * Модель — источник архитектуры: схемы C4 и таблица модулей строятся из неё при каждой сборке, рукописной схемы,
 * которая отстанет от кода, нет. Правила из `tests/architecture/<name>` сверяют ту же модель с кодом.
 */
describe("Архитектура — страница из модели `tests/architecture/model.ts`: система, контейнеры, модули", () => {
  it("C1 — система и внешние системы схемой `C4Context`, связь подписана модулем-адаптером", () => {
    writeTree(dir, { [MODEL]: model(FULL) });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/architecture.md")).toContain(
      block(
        "## Система и внешние системы (C1)",
        "",
        "```mermaid",
        "C4Context",
        "  title Система и внешние системы",
        '  System(system, "Счета")',
        '  System_Ext(ext_stripe, "stripe", "платёжный провайдер")',
        '  Rel(system, ext_stripe, "через модуль payments", "api.stripe.com")',
        "```",
      ),
    );
  });

  it("C2 — контейнеры схемой `C4Container`: хранилище — база, связи `uses`, внешняя система — у контейнера с адаптером", () => {
    writeTree(dir, { [MODEL]: model(FULL) });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/architecture.md")).toContain(
      block(
        "## Контейнеры (C2)",
        "",
        "```mermaid",
        "C4Container",
        "  title Контейнеры",
        '  System_Boundary(system, "Счета") {',
        '    Container(c_app, "app", "compose:app", "веб-приложение")',
        '    ContainerDb(c_db, "db", "compose:db", "база")',
        "  }",
        '  System_Ext(ext_stripe, "stripe", "платёжный провайдер")',
        '  Rel(c_app, c_db, "использует")',
        '  Rel(c_app, ext_stripe, "через модуль payments", "api.stripe.com")',
        "```",
      ),
    );
  });

  it("C3 — модули схемой `C4Component` по контейнерам и таблица: назначение, каталог, API, зависимости, пакеты", () => {
    writeTree(dir, { [MODEL]: model(FULL) });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/architecture.md")).toContain(
      block(
        "## Модули (C3)",
        "",
        "```mermaid",
        "C4Component",
        "  title Модули",
        '  Container_Boundary(c_app, "app") {',
        '    Component(m_web, "web", "src/web", "страницы")',
        '    Component(m_domain, "domain", "src/domain", "правила счетов")',
        '    Component(m_repo, "repo", "src/repo", "запросы к базе")',
        '    Component(m_payments, "payments", "src/payments", "платежи")',
        "  }",
        '  ContainerDb(c_db, "db", "compose:db", "база")',
        '  System_Ext(ext_stripe, "stripe", "платёжный провайдер")',
        '  Rel(m_web, m_domain, "зависит")',
        '  Rel(m_repo, m_domain, "зависит")',
        '  Rel(m_repo, c_db, "pg")',
        '  Rel(m_payments, ext_stripe, "вызывает", "api.stripe.com")',
        "```",
        "",
        "| Модуль | Назначение | Каталог | API | Зависит от | Пакеты |",
        "|---|---|---|---|---|---|",
        "| web | страницы | `src/web` | — | domain | — |",
        "| domain | правила счетов | `src/domain` | `src/domain/index.ts` | — | — |",
        "| repo | запросы к базе | `src/repo` | — | domain | `pg` |",
        "| payments | платежи | `src/payments` | — | — | `stripe` |",
      ),
    );
  });

  it("C3 — библиотека вне границ контейнеров; внешняя система с несколькими адаптерами — связь от каждого, без адаптера — периметр перед системой", () => {
    writeTree(dir, { [MODEL]: model(MONOREPO) });
    expect(doc(rules()).code).toBe(0);
    const page = read("docs/spec/architecture.md");
    expect(page).toContain(
      block(
        '  System(system, "Магазин")',
        '  System_Ext(ext_telegram, "telegram", "мессенджер")',
        '  System_Ext(ext_cdn, "cdn", "CDN перед сайтом")',
        '  Rel(system, ext_telegram, "через модули web, admin", "api.telegram.org")',
        '  Rel(ext_cdn, system, "периметр")',
        "```",
      ),
    );
    expect(page).toContain(
      block(
        '  Rel(c_site, ext_telegram, "через модуль web", "api.telegram.org")',
        '  Rel(c_backoffice, ext_telegram, "через модуль admin", "api.telegram.org")',
        "```",
      ),
    );
    expect(page).toContain(
      block(
        "C4Component",
        "  title Модули",
        '  Container_Boundary(c_site, "site") {',
        '    Component(m_web, "web", "apps/web", "сайт")',
        "  }",
        '  Container_Boundary(c_backoffice, "backoffice") {',
        '    Component(m_admin, "admin", "apps/admin", "админка")',
        "  }",
        '  Component(m_ui, "ui", "packages/ui, библиотека", "компоненты")',
        '  System_Ext(ext_telegram, "telegram", "мессенджер")',
        '  System_Ext(ext_cdn, "cdn", "CDN перед сайтом")',
        '  Rel(m_web, m_ui, "зависит")',
        '  Rel(m_admin, m_ui, "зависит")',
        '  Rel(m_web, ext_telegram, "вызывает", "api.telegram.org")',
        '  Rel(m_admin, ext_telegram, "вызывает", "api.telegram.org")',
        "```",
      ),
    );
  });

  it("без внешних систем и контейнеров — только модули: уровень без данных не рисуется", () => {
    writeTree(dir, { [MODEL]: model(MODULES_ONLY) });
    expect(doc(rules()).code).toBe(0);
    const page = read("docs/spec/architecture.md");
    expect(page).not.toContain("(C1)");
    expect(page).not.toContain("(C2)");
    expect(page).toContain(
      block(
        "```mermaid",
        "C4Component",
        "  title Модули",
        '  Component(m_domain, "domain", "src/domain", "правила счетов")',
        '  Component(m_infra, "infra", "src/infra, src/jobs", "база и задачи")',
        '  Rel(m_infra, m_domain, "зависит")',
        "```",
      ),
    );
    expect(page).toContain("| infra | база и задачи | `src/infra`, `src/jobs` | — | domain | — |");
  });

  it("страница архитектуры — первой строкой «Из чего состоит» в оглавлении, на ней — правила из `tests/architecture/<name>`", () => {
    writeTree(dir, { [MODEL]: model(FULL), "tests/architecture/modules/modules.md": "Модель не расходится с кодом.\n" });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(
      block(
        "## Из чего состоит",
        "",
        "- [Архитектура](architecture.md) — модель: 4 модуля, 2 контейнера, 1 внешняя система",
        "- [modules](architecture/modules.md) — Модель не расходится с кодом.",
      ),
    );
    const page = read("docs/spec/architecture.md");
    expect(page).toStartWith("<!-- spec-doc:");
    expect(page).toContain("# Архитектура\n");
    expect(page).toContain("## Правила\n\n- [modules](architecture/modules.md) — Модель не расходится с кодом.\n");

    // в общем документе — под тем же разделом, уровнями ниже
    const out = doc(rules(), "--stdout").stdout;
    expect(out).toContain("## Из чего состоит\n\n### Архитектура\n");
    expect(out).toContain("#### Модули (C3)\n");
  });

  it("модель изменилась — страница тоже; модель убрали — устаревшая страница удаляется", () => {
    writeTree(dir, { [MODEL]: model(MODULES_ONLY) });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/architecture.md")).not.toContain("mailer");

    writeTree(dir, { [MODEL]: model(MODULES_ONLY.replace("modules: {", 'modules: {\n    mailer: { path: "src/mailer", purpose: "письма" },')) });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/architecture.md")).toContain('Component(m_mailer, "mailer", "src/mailer", "письма")');

    rmSync(path.join(dir, MODEL));
    const r = doc(rules());
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, "docs/spec/architecture.md"))).toBe(false);
    expect(r.stderr).toContain("deleted stale docs/spec/architecture.md");
    expect(read("docs/spec/README.md")).not.toContain("architecture.md)");
  });

  it("модель не загружается — код 2 и сообщение", () => {
    writeTree(dir, { [MODEL]: "export default {\n" });
    const broken = doc(rules());
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain(`spec-doc: model ${MODEL} doesn't load`);

    writeTree(dir, { [MODEL]: 'export default { name: "Счета" };\n' });
    const empty = doc(rules());
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain(`spec-doc: model ${MODEL} has no export default with modules`);
  });

  it("в проекте на en подписи схем, таблица модулей и строка оглавления — по-английски", () => {
    setLanguage(dir, "en");
    writeTree(dir, {
      [MODEL]: model(`{
  modules: {
    web: { path: "src/web", purpose: "pages", dependsOn: ["ui"] },
    ui: { path: "src/ui", purpose: "components", library: true },
    payments: { path: "src/payments", purpose: "payments", packages: ["stripe"] },
  },
  externals: {
    stripe: { purpose: "payment provider", adapter: "payments", hosts: ["api.stripe.com"] },
    telegram: { purpose: "messenger", adapter: ["web", "payments"], hosts: ["api.telegram.org"] },
    cdn: { purpose: "CDN in front of the site" },
  },
  containers: {
    app: { purpose: "web app", modules: ["web", "payments"], uses: ["db"] },
    db: { purpose: "database", clients: ["pg"] },
  },
}`),
    });
    expect(doc(rules()).code).toBe(0);
    expect(read("docs/spec/README.md")).toContain(
      "## What it's made of\n\n- [Architecture](architecture.md) — model: 3 modules, 2 containers, 3 external systems\n- [modules](architecture/modules.md)\n",
    );
    const page = read("docs/spec/architecture.md");
    expect(page).toContain(
      "# Architecture\n\nGenerated from the model `tests/architecture/model.ts` (the `spec` skill, `spec-doc`): C4 diagrams and a table of modules. " +
        "Edit the model; the architecture rules check it against the code.\n",
    );
    expect(page).toContain(
      block(
        "## System and external systems (C1)",
        "",
        "```mermaid",
        "C4Context",
        "  title System and external systems",
        '  System(system, "System")',
        '  System_Ext(ext_stripe, "stripe", "payment provider")',
        '  System_Ext(ext_telegram, "telegram", "messenger")',
        '  System_Ext(ext_cdn, "cdn", "CDN in front of the site")',
        '  Rel(system, ext_stripe, "via module payments", "api.stripe.com")',
        '  Rel(system, ext_telegram, "via modules web, payments", "api.telegram.org")',
        '  Rel(ext_cdn, system, "perimeter")',
        "```",
      ),
    );
    expect(page).toContain(block("## Containers (C2)", "", "```mermaid", "C4Container", "  title Containers"));
    expect(page).toContain('  Rel(c_app, c_db, "uses")');
    expect(page).toContain(block("## Modules (C3)", "", "```mermaid", "C4Component", "  title Modules"));
    expect(page).toContain('  Component(m_ui, "ui", "src/ui, library", "components")');
    expect(page).toContain('  Rel(m_web, m_ui, "depends on")');
    expect(page).toContain('  Rel(m_payments, ext_stripe, "calls", "api.stripe.com")');
    expect(page).toContain("| Module | Purpose | Directory | API | Depends on | Packages |\n");
    expect(page).toContain("## Rules\n\n- [modules](architecture/modules.md)\n");
  });

});

// главный файл capability billing и его описание — место для метки
const BILLING = "tests/capabilities/billing/billing.test.ts";
const billing = () => vitestReport(dir, { [BILLING]: [[["Счета"], "выставляется за месяц"]] });
const DESCRIBED = "tests/capabilities/billing/billing.md";

/** Схема нужна и в рассказе capability или правила: метка в описании берёт её из той же модели, копии нет. */
describe("Схема из модели встраивается меткой в `<папка>.md`", () => {
  it("метка `<!-- spec: c4-… -->` в описании заменяется схемой или таблицей модулей", () => {
    writeTree(dir, {
      [MODEL]: model(FULL),
      [DESCRIBED]: "Счета выставляются раз в месяц.\n\n<!-- spec: c4-context -->\n\nКто что делает:\n\n<!-- spec: c4-modules -->\n",
    });
    expect(doc(billing(), "--strict").code).toBe(0);
    const page = read("docs/spec/capabilities/billing.md");
    expect(page).toContain("Счета выставляются раз в месяц.\n\n```mermaid\nC4Context\n");
    expect(page).toContain("Кто что делает:\n\n| Модуль | Назначение | Каталог | API | Зависит от | Пакеты |\n");
    expect(page).not.toContain("<!-- spec:");
  });

  it("метка без модели или неизвестная — spec-doc называет файл и метку, --strict — код 1", () => {
    writeTree(dir, { [DESCRIBED]: "Счета.\n\n<!-- spec: c4-container -->\n" });
    const noModel = doc(billing(), "--strict");
    expect(noModel.code).toBe(1);
    expect(noModel.stderr).toContain(`spec-doc: mark <!-- spec: c4-container --> in ${DESCRIBED}: no model ${MODEL}`);
    expect(doc(billing()).code).toBe(0);

    writeTree(dir, { [MODEL]: model(FULL), [DESCRIBED]: "Счета.\n\n<!-- spec: c4-deploy -->\n" });
    const unknown = doc(billing(), "--strict");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(`spec-doc: unknown mark <!-- spec: c4-deploy --> in ${DESCRIBED}`);
  });
});
