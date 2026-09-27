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

import { envNamesIn, invariant } from "./harness.ts";
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

/** Внешняя система (C1): кто она, какой модуль с ней говорит и чем — хосты, пакеты, ключи окружения. */
export interface External {
  purpose: string;
  /** Модуль-адаптер: единственный, кто говорит с внешней системой. */
  adapter: string;
  hosts?: string[];
  packages?: string[];
  env?: string[];
}

/** Контейнер (C2): развёртываемая единица — приложение, функция, cron, воркер, база, хранилище. */
export interface Container {
  purpose: string;
  /** Модули кода, которые разворачиваются в этом контейнере. */
  modules?: string[];
  /** Развёртываемые единицы из конфигов: `compose:<сервис>`, `supabase-function:<имя>`, `vercel-cron:<путь>`. */
  deploy?: string[];
  /** Контейнеры, с которыми этот связан (запрос, очередь, база): связь — не импорт. */
  uses?: string[];
  /** У хранилища: пакеты-клиенты, через которые с ним говорят (`pg`, `@supabase/supabase-js`). */
  clients?: string[];
}

export interface Model {
  /** Каталоги кода от корня (по умолчанию `src`): каждый каталог с кодом в них принадлежит модулю. */
  roots?: string[];
  /** Псевдонимы импорта → путь от корня (`{ "@/": "src/" }`): такой импорт локальный, а не пакет. */
  aliases?: Record<string, string>;
  modules: Record<string, Module>;
  /** Внешние системы (C1): платёжный провайдер, почта, геокодер… */
  externals?: Record<string, External>;
  /** Контейнеры (C2): развёртываемые единицы и связи между ними. */
  containers?: Record<string, Container>;
}

/**
 * Развёртываемые единицы из конфигов деплоя в репозитории: сервисы `docker-compose.yml` / `compose.yml`, функции
 * `supabase/functions/<имя>`, crons в `vercel.json`. Разбор без зависимостей: сервис compose — ключ с отступом
 * в два пробела под верхним `services:`.
 */
export function deployUnits(root: string): string[] {
  const out = new Set<string>();
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    let text: string;
    try {
      text = readFileSync(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    let inServices = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^services:\s*$/.test(line)) inServices = true;
      else if (/^\S/.test(line)) inServices = false;
      else if (inServices) {
        const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
        if (m) out.add(`compose:${m[1]}`);
      }
    }
  }
  try {
    for (const e of readdirSync(path.join(root, "supabase", "functions"), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith("_")) out.add(`supabase-function:${e.name}`);
    }
  } catch {
    /* нет функций Supabase */
  }
  try {
    const v = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons?: { path: string }[] };
    for (const c of v.crons ?? []) out.add(`vercel-cron:${c.path}`);
  } catch {
    /* нет vercel.json или crons */
  }
  return sorted([...out]);
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
  hosts: string[];
  env: string[];
}

// литерал URL в коде: "https://api.example.com/…" — хост; локальные адреса и IP — не внешние системы
const URL_HOST = /["'`]https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?=[\/"'`?#])/gi;
const isLocal = (h: string) => h === "localhost" || h.endsWith(".localhost") || h.endsWith(".test") || /^\d+(\.\d+){3}$/.test(h) || h === "::1";

/** Хосты внешних систем в литералах URL исходника. */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) if (!isLocal(m[1]!.toLowerCase())) out.add(m[1]!.toLowerCase());
  return [...out];
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
        const text = readFileSync(path.join(root, child), "utf8");
        out.push({ file: child, dir: rel, packages: importsIn(text, model.aliases), hosts: hostsIn(text), env: envNamesIn(text) });
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

  if (model.externals) c1(it, model, src, opts.exceptions);
  if (model.containers) c2(it, opts.root, model, src, opts.exceptions);
}

/**
 * C2: модуль — ровно в одном контейнере; зависимость модулей — внутри контейнера (между контейнерами — только
 * `uses`); развёртываемые единицы конфигов и модели совпадают в обе стороны; клиент хранилища — только в контейнере
 * со связью `uses` с этим хранилищем.
 */
function c2(it: It, root: string, model: Model, src: Source[], exceptions?: readonly Exception[]): void {
  const cont = model.containers!;
  const containerOf = (m: string) => Object.keys(cont).filter((c) => (cont[c]!.modules ?? []).includes(m)).sort();
  invariant(it, {
    registry: "модули в контейнерах",
    items: names(model),
    name: (m) => `модуль ${m} — в контейнере ${containerOf(m).length === 1 ? containerOf(m)[0] : "?"}`,
    key: (m) => m,
    check: (m) => {
      const c = containerOf(m);
      if (!c.length) throw new Error(`модуль ${m} не входит ни в один контейнер модели`);
      if (c.length > 1) throw new Error(`модуль ${m} — в нескольких контейнерах: ${c.join(", ")}`);
    },
    violator: { name: "модуль вне контейнеров", item: "__вне_контейнеров__" },
    exceptions,
  });

  const edges = names(model).flatMap((m) => (model.modules[m]!.dependsOn ?? []).map((d) => ({ m, d })));
  if (edges.length) {
    invariant(it, {
      registry: "зависимости модулей",
      items: edges,
      name: (e) => `зависимость ${e.m} → ${e.d} — внутри контейнера`,
      key: (e) => `${e.m}→${e.d}`,
      check: (e) => {
        const a = containerOf(e.m)[0];
        const b = containerOf(e.d)[0];
        if (a !== b) throw new Error(`${e.m} (${a ?? "?"}) зависит от ${e.d} (${b ?? "?"}) — между контейнерами только связь uses`);
      },
      violator: { name: "зависимость через контейнер", item: { m: "__a__", d: "__b__" } },
      exceptions,
    });
  }

  const found = deployUnits(root);
  const declared = new Map<string, string>();
  for (const [c, x] of Object.entries(cont)) for (const d of x.deploy ?? []) declared.set(d, c);
  invariant(it, {
    registry: "развёртываемые единицы",
    items: sorted([...new Set([...found, ...declared.keys()])]),
    name: (u) => `развёртываемая единица ${u} — контейнер ${declared.get(u) ?? "?"}`,
    key: (u) => u,
    check: (u) => {
      if (!declared.has(u)) throw new Error(`${u} есть в конфигах деплоя, но не в модели — добавь контейнер в tests/architecture/model.ts`);
      if (!found.includes(u)) throw new Error(`${u} контейнера ${declared.get(u)} нет в конфигах деплоя — модель разошлась с деплоем`);
    },
    violator: { name: "единица вне модели", item: "__вне_модели__" },
    exceptions,
  });

  // клиенты хранилищ: какой контейнер их импортирует на деле
  const storages = Object.entries(cont).flatMap(([s, x]) => (x.clients ?? []).map((pkg) => ({ s, pkg })));
  if (storages.length) {
    const uses = new Map<string, { s: string; pkg: string; c: string; files: string[] }>();
    for (const src1 of src) {
      const mod = owners(model, src1.dir);
      if (mod.length !== 1) continue;
      const c = containerOf(mod[0]!)[0];
      if (!c) continue;
      for (const st of storages) {
        if (!src1.packages.includes(st.pkg)) continue;
        const k = `${st.pkg}:${st.s}:${c}`;
        const u = uses.get(k) ?? { ...st, c, files: [] };
        u.files.push(src1.file);
        uses.set(k, u);
      }
    }
    invariant(it, {
      registry: "клиенты хранилищ в контейнерах",
      items: [...uses.values()],
      name: (u) => `клиент ${u.pkg} хранилища ${u.s} — в контейнере ${u.c}`,
      key: (u) => `${u.pkg}:${u.c}`,
      check: (u) => {
        if (u.c !== u.s && !(cont[u.c]?.uses ?? []).includes(u.s)) {
          throw new Error(`контейнер ${u.c} импортирует клиент ${u.pkg} хранилища ${u.s} без связи uses: ${u.files.join(", ")}`);
        }
      },
      violator: { name: "клиент без связи", item: { s: "__хранилище__", pkg: "__клиент__", c: "__контейнер__", files: [] } },
      exceptions,
    });
  }
}

/**
 * C1: хост внешней системы — только в её адаптере (хост вне модели — красный), пакет внешней системы — только у
 * адаптера (модель без противоречий), ключ окружения внешней системы — читает только адаптер. Реестры — из модели и
 * кода; реестр, которого модель не объявляет (у внешних систем нет пакетов), не регистрируется.
 */
function c1(it: It, model: Model, src: Source[], exceptions?: readonly Exception[]): void {
  const ext = model.externals!;
  const moduleOfFile = (s: Source) => owners(model, s.dir);
  const inAdapter = (s: Source, adapter: string) => moduleOfFile(s).includes(adapter);
  const hostOwner = new Map<string, string>();
  for (const [name, e] of Object.entries(ext)) for (const h of e.hosts ?? []) hostOwner.set(h.toLowerCase(), name);
  const hostFiles = new Map<string, Source[]>();
  for (const s of src) for (const h of s.hosts) hostFiles.set(h, [...(hostFiles.get(h) ?? []), s]);
  const hosts = sorted([...new Set([...hostOwner.keys(), ...hostFiles.keys()])]);
  if (hosts.length) {
    invariant(it, {
      registry: "хосты внешних систем",
      items: hosts,
      name: (h) => `хост ${h} — только в адаптере ${hostOwner.has(h) ? ext[hostOwner.get(h)!]!.adapter : "?"}`,
      key: (h) => h,
      check: (h) => {
        const files = hostFiles.get(h) ?? [];
        const owner = hostOwner.get(h);
        if (!owner) throw new Error(`хост ${h} не объявлен ни одной внешней системой модели: ${files.map((s) => s.file).join(", ")}`);
        const outside = files.filter((s) => !inAdapter(s, ext[owner]!.adapter));
        if (outside.length) throw new Error(`хост ${h} внешней системы ${owner} — вне её адаптера ${ext[owner]!.adapter}: ${outside.map((s) => s.file).join(", ")}`);
      },
      violator: { name: "хост вне модели", item: "__вне_модели__.example" },
      exceptions,
    });
  }
  const pkgs = Object.entries(ext).flatMap(([x, e]) => (e.packages ?? []).map((p) => ({ x, p, a: e.adapter })));
  if (pkgs.length) {
    invariant(it, {
      registry: "пакеты внешних систем",
      items: pkgs,
      name: (i) => `пакет ${i.p} внешней системы ${i.x} — только у адаптера ${i.a}`,
      key: (i) => `${i.x}:${i.p}`,
      check: (i) => {
        if (!(model.modules[i.a]?.packages ?? []).includes(i.p)) throw new Error(`адаптеру ${i.a} пакет ${i.p} внешней системы ${i.x} не разрешён в модели`);
        const others = names(model).filter((n) => n !== i.a && (model.modules[n]!.packages ?? []).includes(i.p));
        if (others.length) throw new Error(`пакет ${i.p} внешней системы ${i.x} разрешён не только адаптеру: ${others.join(", ")}`);
      },
      violator: { name: "пакет без адаптера", item: { x: "__нарушитель__", p: "__нет__", a: "__нет_модуля__" } },
      exceptions,
    });
  }
  const keys = Object.entries(ext).flatMap(([x, e]) => (e.env ?? []).map((k) => ({ x, k, a: e.adapter })));
  if (keys.length) {
    invariant(it, {
      registry: "ключи окружения внешних систем",
      items: keys,
      name: (i) => `ключ ${i.k} внешней системы ${i.x} читает только адаптер ${i.a}`,
      key: (i) => `${i.x}:${i.k}`,
      check: (i) => {
        const outside = src.filter((s) => s.env.includes(i.k) && !inAdapter(s, i.a));
        if (outside.length) throw new Error(`ключ ${i.k} внешней системы ${i.x} читается вне адаптера ${i.a}: ${outside.map((s) => s.file).join(", ")}`);
      },
      violator: { name: "ключ вне адаптера", item: { x: "__нарушитель__", k: "__КЛЮЧ__", a: "__нет_модуля__" } },
      exceptions,
    });
  }
}

/**
 * `fetch` для тестов: запрос к хосту вне модели (внешние системы и `allow`) падает — система в тестах говорит только
 * с объявленными внешними системами (и там их мокают); локальные адреса — всегда можно. Установка — в настройке
 * тестов: `globalThis.fetch = networkGuard(model, globalThis.fetch)`.
 */
export function networkGuard(
  model: Model,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = globalThis.fetch,
  opts: { allow?: string[] } = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const allowed = new Set([...Object.values(model.externals ?? {}).flatMap((e) => (e.hosts ?? []).map((h) => h.toLowerCase())), ...(opts.allow ?? [])]);
  return async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname.toLowerCase();
    if (!isLocal(host) && !allowed.has(host)) throw new Error(`запрос к хосту ${host} вне модели — объяви внешнюю систему в tests/architecture/model.ts или замокай запрос`);
    return fetchImpl(input, init);
  };
}

/** CSP `connect-src` браузера из хостов внешних систем модели: заголовок проекта сверяется с ним тестом. */
export function cspConnectSrc(model: Model, self: string[] = ["'self'"]): string {
  const hosts = sorted([...new Set(Object.values(model.externals ?? {}).flatMap((e) => (e.hosts ?? []).map((h) => h.toLowerCase())))]);
  return ["connect-src", ...self, ...hosts.map((h) => `https://${h}`)].join(" ");
}
