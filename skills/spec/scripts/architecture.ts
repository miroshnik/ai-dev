/**
 * architecture — модель архитектуры проекта и её проверки. Модель одна, в `tests/architecture/model.ts`: модули (путь,
 * назначение), от каких модулей и внешних пакетов каждый зависит. Из неё:
 *
 * - `boundariesConfig` — правила границ ESLint (eslint-plugin-boundaries проекта): импорт модуля, от которого нельзя
 *   зависеть, — ошибка `lint` и в редакторе; фрагмент `eslint.ts` в `tests/architecture/<name>/`;
 * - `architecture` — тесты: каждый каталог кода принадлежит модулю, внешний пакет импортирует только модуль, которому
 *   он разрешён, и каждый разрешённый пакет реально используется — модель не расходится с кодом ни в одну сторону.
 *
 * Импорты — статическим разбором исходников (без сборки и резолвера): относительные пути, псевдонимы модели и
 * встроенные модули Node — не пакеты. Только `node:`-API и стираемый TypeScript: Node ≥ 22.18 и Bun.
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { invariant } from "./harness.ts";
import type { Exception, It } from "./harness.ts";

export interface Module {
  /** Каталог модуля от корня проекта (или несколько). */
  path: string | string[];
  /** Назначение — одна фраза: зачем модуль и чего в нём нет. */
  purpose: string;
  /** Публичный API модуля (файл-вход), если модуль закрыт за ним. */
  api?: string;
  /** Модули, от которых этот может зависеть (свои файлы — всегда). */
  dependsOn?: string[];
  /** Внешние пакеты, которые этот модуль может импортировать. */
  packages?: string[];
}

export interface Model {
  /** Каталоги кода от корня (по умолчанию `src`): каждый каталог с кодом в них принадлежит модулю. */
  roots?: string[];
  /** Псевдонимы импорта → путь от корня (`{ "@/": "src/" }`): такой импорт локальный, а не пакет. */
  aliases?: Record<string, string>;
  modules: Record<string, Module>;
}

const CODE = /\.[cm]?[jt]sx?$/;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
const BUILTIN = new Set(builtinModules);

const paths = (m: Module): string[] => (Array.isArray(m.path) ? m.path : [m.path]).map((p) => p.replace(/\/+$/, ""));
const names = (model: Model): string[] => Object.keys(model.modules).sort();
const sorted = <T>(xs: T[]): T[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Правила границ ESLint из модели: элемент на модуль, импорт модуля не из `dependsOn` — ошибка
 * `boundaries/dependencies`. Внешние пакеты и встроенные модули правило пропускает — их проверяет `architecture`.
 * `boundaries` — плагин из зависимостей проекта; `settings` — например, резолвер TypeScript для псевдонимов.
 */
export function boundariesConfig(model: Model, boundaries: object, opts: { files?: string[]; settings?: object } = {}): object[] {
  const all = names(model);
  const roots = model.roots ?? ["src"];
  const policies = all.flatMap((name) => {
    const allowed = new Set([name, ...(model.modules[name]!.dependsOn ?? [])]);
    const denied = all.filter((n) => !allowed.has(n));
    if (!denied.length) return [];
    return [
      {
        from: { element: { type: name } },
        disallow: { to: { element: { types: { anyOf: denied } } } },
        message: `модуль ${name} не зависит от {{to.element.type}} — зависимости модулей в tests/architecture/model.ts`,
      },
    ];
  });
  return [
    {
      files: opts.files ?? roots.map((r) => `${r}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`),
      plugins: { boundaries },
      settings: {
        "boundaries/elements": all.flatMap((name) => paths(model.modules[name]!).map((p) => ({ type: name, pattern: p }))),
        "import/resolver": { node: { extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"] } },
        ...opts.settings,
      },
      rules: { "boundaries/dependencies": [2, { default: "allow", policies }] },
    },
  ];
}

// import … from "x", export … from "x", import "x", import("x"), require("x"); `import type` — не зависимость кода
const IMPORT = /^\s*(import|export)\s+(type\s+)?[^;'"]*?\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gm;

/** Внешние пакеты, которые импортирует исходник: имя пакета (`@scope/lib`, `lodash`), по порядку появления, без повторов. */
export function importsIn(text: string, aliases: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    if (m[2]) continue; // import type / export type
    const spec = m[3] ?? m[4] ?? m[5] ?? m[6];
    if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
    if (Object.keys(aliases).some((a) => spec.startsWith(a))) continue;
    const parts = spec.split("/");
    const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (BUILTIN.has(pkg) || out.includes(pkg)) continue;
    out.push(pkg);
  }
  return out;
}

interface Source {
  file: string;
  dir: string;
  packages: string[];
}

function sources(root: string, model: Model): Source[] {
  const out: Source[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(child);
      } else if (CODE.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) {
        out.push({ file: child, dir: rel, packages: importsIn(readFileSync(path.join(root, child), "utf8"), model.aliases) });
      }
    }
  };
  for (const r of model.roots ?? ["src"]) walk(r.replace(/\/+$/, ""));
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** Модули, чьему каталогу принадлежит путь (каталог модуля или вложенный в него). */
function owners(model: Model, dir: string): string[] {
  return names(model).filter((n) => paths(model.modules[n]!).some((p) => dir === p || dir.startsWith(p + "/")));
}

/**
 * Тесты модели: «<каталог> → <модуль>» на каждый каталог с кодом (вне модулей или в нескольких — красный),
 * «<модуль> импортирует <пакет>» на каждый внешний пакет, который модуль импортирует (не разрешён — красный),
 * «<модуль> использует разрешённый пакет <пакет>» на каждый пакет модели (не импортируется — красный: убери из модели).
 * Каждое — «реестр + инвариант»: не пуст, заведомый нарушитель, исключения из `exceptions.ts`.
 */
export function architecture(it: It, opts: { root: string; model: Model; exceptions?: readonly Exception[] }): void {
  const { model } = opts;
  const src = sources(opts.root, model);
  const dirs = sorted([...new Set(src.map((s) => s.dir))]);
  const moduleOf = (dir: string) => owners(model, dir);

  invariant(it, {
    registry: "каталоги кода",
    items: dirs,
    name: (d) => `${d} → ${moduleOf(d).length === 1 ? moduleOf(d)[0] : "?"}`,
    key: (d) => d,
    check: (d) => {
      const own = moduleOf(d);
      if (!own.length) throw new Error(`${d}: код вне модулей модели — добавь модуль в tests/architecture/model.ts или перенеси код`);
      if (own.length > 1) throw new Error(`${d}: каталог в нескольких модулях — ${own.join(", ")}`);
    },
    violator: { name: "каталог вне модулей", item: "__вне_модели__" },
    exceptions: opts.exceptions,
  });

  // пакеты, которые модуль импортирует на деле: модуль → пакет → файлы
  const used = new Map<string, Map<string, string[]>>();
  for (const s of src) {
    const own = moduleOf(s.dir);
    if (own.length !== 1) continue; // вне модулей — уже красный тест каталога
    const byPkg = used.get(own[0]!) ?? new Map<string, string[]>();
    for (const p of s.packages) byPkg.set(p, [...(byPkg.get(p) ?? []), s.file]);
    used.set(own[0]!, byPkg);
  }
  const imports = [...used].flatMap(([mod, byPkg]) => [...byPkg].map(([pkg, files]) => ({ mod, pkg, files })));
  const allowed = (mod: string) => model.modules[mod]?.packages ?? [];
  invariant(it, {
    registry: "внешние пакеты модулей",
    items: imports,
    name: (i) => `${i.mod} импортирует ${i.pkg}`,
    key: (i) => `${i.mod}:${i.pkg}`,
    check: (i) => {
      if (!allowed(i.mod).includes(i.pkg)) throw new Error(`модулю ${i.mod} пакет ${i.pkg} не разрешён: ${i.files.join(", ")}`);
    },
    violator: { name: "пакет, не разрешённый модулю", item: { mod: names(model)[0] ?? "", pkg: "__не_разрешён__", files: ["__нарушитель__"] } },
    exceptions: opts.exceptions,
  });

  const declared = names(model).flatMap((mod) => allowed(mod).map((pkg) => ({ mod, pkg })));
  invariant(it, {
    registry: "разрешённые пакеты модели",
    items: declared,
    name: (d) => `${d.mod} использует разрешённый пакет ${d.pkg}`,
    key: (d) => `${d.mod}:${d.pkg}`,
    check: (d) => {
      if (!used.get(d.mod)?.has(d.pkg)) throw new Error(`модуль ${d.mod} не импортирует ${d.pkg} — убери пакет из модели или поправь код`);
    },
    violator: { name: "разрешённый пакет без импорта", item: { mod: "__нет_модуля__", pkg: "__не_используется__" } },
    exceptions: opts.exceptions,
  });
}
