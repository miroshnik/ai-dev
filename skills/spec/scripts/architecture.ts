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
import type { Dirent } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { codeOnly, envNamesInCode, invariant } from "./harness.ts";
import type { EnvReader, Exception, Invariant, It } from "./harness.ts";

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
  /**
   * Библиотека — общий пакет, который собирается в несколько контейнеров (пакет монорепо в бандле каждого
   * приложения): её контейнеры — контейнеры модулей, которые от неё зависят, и те, где она названа в `modules`.
   */
  library?: boolean;
}

/** Внешняя система (C1): кто она, какие модули с ней говорят и чем — хосты, пакеты, ключи окружения, заголовки. */
export interface External {
  purpose: string;
  /**
   * Модуль-адаптер или несколько: только они говорят с внешней системой. Нет — периметр (CDN, WAF перед системой):
   * с ним не говорит ни один модуль, его хостов, пакетов, ключей и заголовков в коде нет.
   */
  adapter?: string | string[];
  hosts?: string[];
  packages?: string[];
  env?: string[];
  /** Заголовки HTTP, через которые внешняя система интегрируется (`CF-IPCountry` от CDN): читает только адаптер. */
  headers?: string[];
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
  /** Название системы на схемах C1 и C2 документации (по умолчанию — «Система»). */
  name?: string;
  /** Каталоги кода от корня (по умолчанию `src`): каждый каталог с кодом в них принадлежит модулю. */
  roots?: string[];
  /**
   * Псевдонимы импорта → путь от корня (`{ "@/": "src/" }`) или список путей — в монорепо у каждого приложения свой
   * `@/`: такой импорт локальный, а не пакет.
   */
  aliases?: Record<string, string | string[]>;
  modules: Record<string, Module>;
  /** Внешние системы (C1): платёжный провайдер, почта, геокодер… */
  externals?: Record<string, External>;
  /** Контейнеры (C2): развёртываемые единицы и связи между ними. */
  containers?: Record<string, Container>;
}

/**
 * Развёртываемые единицы из конфигов деплоя в репозитории: сервисы `docker-compose.yml` / `compose.yml`, функции
 * `supabase/functions/<имя>`, crons в `vercel.json`, вычислительные ресурсы Terraform в `*.tf` (`terraform:<тип>.<имя>`:
 * сервис ECS, функция Lambda, Cloud Run…). Разбор без зависимостей: сервис compose — ключ с отступом в два пробела
 * под верхним `services:`, ресурс Terraform — строка `resource "<тип>" "<имя>"`.
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
  walkDirs(root, (rel, entries) => {
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".tf")) continue;
      for (const m of readFileSync(path.join(root, rel, e.name), "utf8").matchAll(TF_RESOURCE)) {
        if (TERRAFORM_UNITS.has(m[1]!)) out.add(`terraform:${m[1]}.${m[2]}`);
      }
    }
  });
  return sorted([...out]);
}

// ресурсы Terraform, которые разворачивают код: сервис, функция, задание; кластер, сеть, база — не единица кода
const TERRAFORM_UNITS = new Set([
  "aws_ecs_service",
  "aws_lambda_function",
  "aws_apprunner_service",
  "google_cloud_run_service",
  "google_cloud_run_v2_service",
  "google_cloud_run_v2_job",
  "google_cloudfunctions_function",
  "google_cloudfunctions2_function",
  "azurerm_container_app",
  "azurerm_linux_function_app",
  "kubernetes_deployment",
  "kubernetes_deployment_v1",
  "kubernetes_cron_job_v1",
]);
const TF_RESOURCE = /^[ \t]*resource\s+"([\w-]+)"\s+"([\w-]+)"/gm;

/**
 * Пакеты workspace монорепо — каталоги с `package.json` по шаблонам `workspaces` из `package.json` (список или
 * `{ packages }`) и `packages:` из `pnpm-workspace.yaml`; `!шаблон` исключает. `*` — один уровень каталога, `**` —
 * любая глубина.
 */
export function workspacePackages(root: string): string[] {
  const patterns: string[] = [];
  try {
    const ws = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { workspaces?: string[] | { packages?: string[] } }).workspaces;
    patterns.push(...(Array.isArray(ws) ? ws : (ws?.packages ?? [])));
  } catch {
    /* нет package.json или workspaces */
  }
  try {
    let inPackages = false;
    for (const line of readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s+-\s+(["']?)(.+?)\1\s*(?:#.*)?$/.exec(line);
        if (m) patterns.push(m[2]!);
      }
    }
  } catch {
    /* нет pnpm-workspace.yaml */
  }
  if (!patterns.length) return [];
  const include = patterns.filter((p) => !p.startsWith("!")).map(glob);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => glob(p.slice(1)));
  const out: string[] = [];
  walkDirs(root, (rel, entries) => {
    if (!rel || !entries.some((e) => e.isFile() && e.name === "package.json")) return;
    if (include.some((r) => r.test(rel)) && !exclude.some((r) => r.test(rel))) out.push(rel);
  });
  return sorted(out);
}

/** Шаблон каталога workspace → RegExp: `*` и `?` — внутри одного уровня, `**` — любая глубина, и нулевая. */
function glob(pattern: string): RegExp {
  const segs = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  const body = segs
    .map((s) => (s === "**" ? "\0" : s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
    .join("/")
    .replace(/\0\//g, "(?:.*/)?")
    .replace(/\/\0/g, "(?:/.*)?")
    .replace(/\0/g, ".*");
  return new RegExp(`^${body}$`);
}

/** Обход каталогов репозитория (без `node_modules`, сборок и скрытых): visit получает путь от корня и записи каталога. */
function walkDirs(root: string, visit: (rel: string, entries: Dirent[]) => void, rel = ""): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  visit(rel, entries);
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) walkDirs(root, visit, rel ? `${rel}/${e.name}` : e.name);
  }
}

/** Есть ли в каталоге файл кода (объявления `.d.ts` — не код). */
function hasCode(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) =>
    e.isDirectory() ? !SKIP.has(e.name) && hasCode(path.join(dir, e.name)) : CODE.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name),
  );
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
        // первым — самый длинный путь: плагин берёт первый подходящий элемент, а src/lib вложен в src
        "boundaries/elements": all
          .flatMap((name) => paths(model.modules[name]!).map((p) => ({ type: name, pattern: p })))
          .sort((a, b) => b.pattern.length - a.pattern.length),
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
export function importsIn(text: string, aliases: Record<string, string | string[]> = {}): string[] {
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
  /** Заголовки внешних систем модели, которые исходник называет строкой, — в нижнем регистре. */
  headers: string[];
}

// литерал URL в коде: "https://api.example.com/…" — хост; локальные адреса и IP — не внешние системы
const URL_HOST = /["'`]https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?=[\/"'`?#])/gi;
// локальные адреса — loopback и «этот хост» 0.0.0.0, из машины они не уходят: не внешние системы, сеть до них в тестах
// разрешена (networkGuard); IPv6 — в скобках, как его отдаёт URL.hostname. Любой другой IP — адрес внешней системы
const isLocal = (h: string) => h === "localhost" || h.endsWith(".localhost") || /^127(\.\d+){3}$/.test(h) || h === "0.0.0.0" || h === "[::1]";
// домены для примеров, документации и тестов (RFC 2606, RFC 6761) — в коде это не внешняя система; но запрос к ним в
// тестах — забытый мок или настоящая сеть, поэтому networkGuard их не пропускает (там — isLocal)
const isReserved = (h: string) => /(^|\.)(example|invalid|test)$|(^|\.)example\.(com|net|org)$/.test(h);
// URI пространства имён XML — не адрес сервиса: атрибут xmlns и пространства W3C (createElementNS)
const XMLNS = /xmlns(?::[\w-]+)?\s*=\s*$/;
const NAMESPACE_HOSTS = new Set(["www.w3.org"]);
// значение href — ссылка, которую открывает браузер посетителя (`<a href>`, `<Link href={…}>`, `{ href: … }`): система с
// этим хостом не говорит. `<link href>` браузер грузит сам, `location.href =` — переход кодом (оплата, вход): хосты
const HREF = /(?<![.\w$])["']?href["']?\s*(?:=\s*\{?|:)\s*$/;
const OPEN_TAG = /<([A-Za-z][\w.:-]*)[^<>]*$/;
const isLink = (text: string, at: number): boolean =>
  HREF.test(text.slice(Math.max(0, at - 40), at)) && OPEN_TAG.exec(text.slice(Math.max(0, at - 2000), at))?.[1] !== "link";

/**
 * Хосты внешних систем в литералах URL исходника; комментарии, пространства имён, зарезервированные домены и ссылки
 * навигации (`href`) — нет.
 */
export function hostsIn(source: string, file?: string): string[] {
  return hostsInCode(codeOnly(source, file));
}

/** То же по коду без комментариев: исходник разбирается один раз на хосты, ключи окружения и заголовки. */
function hostsInCode(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) {
    const h = m[1]!.toLowerCase();
    if (isLocal(h) || isReserved(h) || NAMESPACE_HOSTS.has(h) || XMLNS.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    if (isLink(text, m.index)) continue;
    out.add(h);
  }
  return [...out];
}

// строка-литерал, похожая на имя заголовка HTTP: `h.get("cf-ipcountry")`, `req.headers["CF-Connecting-IP"]`
const HEADER_LITERAL = /(["'`])([A-Za-z][A-Za-z0-9-]*)\1/g;

/** Заголовки из `declared` (в нижнем регистре), которые код называет строкой, без учёта регистра. */
function headersInCode(text: string, declared: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HEADER_LITERAL)) {
    const h = m[2]!.toLowerCase();
    if (declared.has(h)) out.add(h);
  }
  return [...out];
}

/**
 * Исходники корней модели: пакеты, хосты, ключи окружения и заголовки — по коду без комментариев, ключи — и способами
 * `readers`.
 */
function sources(root: string, model: Model, readers?: readonly EnvReader[]): Source[] {
  const out: Source[] = [];
  const declared = new Set(Object.values(model.externals ?? {}).flatMap((e) => (e.headers ?? []).map((h) => h.toLowerCase())));
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
        const code = codeOnly(text, child);
        out.push({
          file: child,
          dir: rel,
          packages: importsIn(text, model.aliases),
          hosts: hostsInCode(code),
          env: envNamesInCode(code, { file: child, readers }),
          headers: declared.size ? headersInCode(code, declared) : [],
        });
      }
    }
  };
  for (const r of model.roots ?? ["src"]) walk(r.replace(/\/+$/, ""));
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * Модули, чьему каталогу принадлежит путь: самый длинный подходящий путь модуля (`src/lib` вложен в `src` — каталог
 * `src/lib/x` у модуля `src/lib`); несколько — один и тот же путь у нескольких модулей, это конфликт модели.
 */
function owners(model: Model, dir: string): string[] {
  let best = -1;
  let out: string[] = [];
  for (const n of names(model)) {
    for (const p of paths(model.modules[n]!)) {
      if (dir !== p && !dir.startsWith(p + "/")) continue;
      if (p.length > best) [best, out] = [p.length, [n]];
      else if (p.length === best && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/**
 * Тесты модели: «каталог <каталог> — в модуле <модуль>» на каждый каталог с кодом (модуль — с самым длинным
 * подходящим путём; вне модулей или один путь у нескольких — красный),
 * «пакет workspace <путь> — в корнях кода» на каждый пакет монорепо с кодом (вне `roots` — красный),
 * «<модуль> импортирует <пакет>» на каждый внешний пакет, который модуль импортирует (не разрешён — красный),
 * «<модуль> использует разрешённый пакет <пакет>» на каждый пакет модели (не импортируется — красный: убери из модели).
 * Каждое — «реестр + инвариант»: не пуст, заведомый нарушитель, исключения из `exceptions/` папки решения.
 * `outside` — элементы вне модели намеренно, с причиной (инструменты разработки: общий конфиг ESLint, хелперы тестов):
 * решение, а не долг с задачей; пакет workspace — и отметкой `spec-outside(<решение>)` в своём `package.json`.
 * `readers` — свои способы чтения окружения проекта, те же, что у `envVars` (`configGet`): для ключей внешних систем.
 */
export function architecture(
  it: It,
  opts: { root: string; model: Model; exceptions?: readonly Exception[]; outside?: readonly Outside[]; readers?: readonly EnvReader[] },
): void {
  const { model } = opts;
  // реестры собираются целиком, потом регистрируются: исключение уходит только в реестр, где есть его элемент
  const specs: Invariant<unknown>[] = [];
  const add: Add = (spec) => void specs.push(spec as Invariant<unknown>);
  const src = sources(opts.root, model, opts.readers);
  const dirs = sorted([...new Set(src.map((s) => s.dir))]);
  const moduleOf = (dir: string) => owners(model, dir);

  add({
    registry: "каталоги кода",
    items: dirs,
    name: (d) => `каталог ${d} — в модуле ${moduleOf(d).length === 1 ? moduleOf(d)[0] : "?"}`,
    key: (d) => d,
    check: (d) => {
      const own = moduleOf(d);
      if (!own.length) throw new Error(`${d}: код вне модулей модели — добавь модуль в tests/architecture/model.ts или перенеси код`);
      if (own.length > 1) throw new Error(`${d}: каталог в нескольких модулях — ${own.join(", ")}`);
    },
    violator: { name: "каталог вне модулей", item: "__вне_модели__" },
  });

  // корни модели — руками: новый пакет workspace вне них проверка не видела бы целиком
  const roots = (model.roots ?? ["src"]).map((r) => r.replace(/^\.\//, "").replace(/\/+$/, ""));
  const inRoots = (p: string) => roots.some((r) => r === p || r.startsWith(p + "/") || p.startsWith(r + "/"));
  const packages = roots.some((r) => r === "" || r === ".") ? [] : workspacePackages(opts.root).filter((p) => hasCode(path.join(opts.root, p)));
  if (packages.length) {
    add({
      registry: "пакеты workspace",
      items: packages,
      name: (p) => `пакет workspace ${p} — в корнях кода`,
      key: (p) => p,
      // «вне охвата» и исключение пакета — отметкой в его package.json: удалили пакет — ушла и отметка
      fileOf: (p) => path.join(opts.root, p, "package.json"),
      check: (p) => {
        if (!inRoots(p)) throw new Error(`${p}: пакет workspace с кодом вне корней модели — добавь его в roots tests/architecture/model.ts`);
      },
      violator: { name: "пакет workspace вне корней", item: "__вне_корней__" },
    });
  }

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
  add({
    registry: "внешние пакеты модулей",
    items: imports,
    name: (i) => `${i.mod} импортирует ${i.pkg}`,
    key: (i) => `${i.mod}:${i.pkg}`,
    check: (i) => {
      if (!allowed(i.mod).includes(i.pkg)) throw new Error(`модулю ${i.mod} пакет ${i.pkg} не разрешён: ${i.files.join(", ")}`);
    },
    violator: { name: "пакет, не разрешённый модулю", item: { mod: names(model)[0] ?? "", pkg: "__не_разрешён__", files: ["__нарушитель__"] } },
  });

  const declared = names(model).flatMap((mod) => allowed(mod).map((pkg) => ({ mod, pkg })));
  add({
    registry: "разрешённые пакеты модели",
    items: declared,
    name: (d) => `${d.mod} использует разрешённый пакет ${d.pkg}`,
    key: (d) => `${d.mod}:${d.pkg}`,
    check: (d) => {
      if (!used.get(d.mod)?.has(d.pkg)) throw new Error(`модуль ${d.mod} не импортирует ${d.pkg} — убери пакет из модели или поправь код`);
    },
    violator: { name: "разрешённый пакет без импорта", item: { mod: "__нет_модуля__", pkg: "__не_используется__" } },
  });

  if (model.externals) c1(add, model, src);
  if (model.containers) c2(add, opts.root, model, src);
  const exceptions = route(opts.exceptions ?? [], specs);
  const outside = route(opts.outside ?? [], specs);
  for (const [i, spec] of specs.entries()) invariant(it, { ...spec, exceptions: exceptions[i], outside: outside[i] });
}

type Add = <T>(spec: Invariant<T>) => void;

/** «Вне охвата» элемента модели: ключ, причина и, когда элемент есть в нескольких реестрах, имя реестра. */
export interface Outside {
  item: string;
  reason: string;
  rule?: string;
}

/**
 * Исключения и «вне охвата» по реестрам: с `rule` — реестру с этим именем, без — реестрам, в которых есть его элемент;
 * элемента нет нигде — первому реестру, чтобы храповик сказал «убери исключение» («убери из охвата»), а не молчал.
 */
function route<X extends { item: string; rule?: string }>(xs: readonly X[], specs: Invariant<unknown>[]): Omit<X, "rule">[][] {
  const keys = specs.map((sp) => new Set(sp.items.map((x) => String((sp.key ?? sp.name)(x)))));
  const out: Omit<X, "rule">[][] = specs.map(() => []);
  for (const { rule, ...x } of xs) {
    const byRule = rule ? specs.findIndex((sp) => sp.registry === rule) : -1;
    let to = byRule >= 0 ? [byRule] : keys.flatMap((k, i) => (!rule && k.has(x.item) ? [i] : []));
    if (!to.length) to = [0];
    for (const i of to) out[i]!.push(x);
  }
  return out;
}

/**
 * Контейнеры каждого модуля: из `modules` контейнеров, у библиотеки — ещё контейнеры модулей, которые от неё зависят
 * (транзитивно: библиотека библиотеки собирается туда же). Списки отсортированы.
 */
export function moduleContainers(model: Model): Map<string, string[]> {
  const cont = model.containers ?? {};
  const out = new Map(Object.keys(model.modules).map((m) => [m, new Set(Object.keys(cont).filter((c) => (cont[c]!.modules ?? []).includes(m)))]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [m, x] of Object.entries(model.modules)) {
      for (const d of x.dependsOn ?? []) {
        if (!model.modules[d]?.library) continue;
        const to = out.get(d)!;
        for (const c of out.get(m)!) {
          if (to.has(c)) continue;
          to.add(c);
          changed = true;
        }
      }
    }
  }
  return new Map([...out].map(([m, cs]) => [m, sorted([...cs])]));
}

/**
 * C2: модуль — ровно в одном контейнере, библиотека — хотя бы в одном; зависимость модулей — внутри контейнера:
 * цель есть в каждом контейнере источника (между контейнерами — только `uses`); развёртываемые единицы конфигов и
 * модели совпадают в обе стороны; клиент хранилища — только в контейнере со связью `uses` с этим хранилищем.
 */
function c2(add: Add, root: string, model: Model, src: Source[]): void {
  const cont = model.containers!;
  const of = moduleContainers(model);
  const containerOf = (m: string) => of.get(m) ?? [];
  const isLibrary = (m: string) => !!model.modules[m]?.library;
  add({
    registry: "модули в контейнерах",
    items: names(model),
    name: (m) =>
      isLibrary(m) ? `библиотека ${m} — в контейнерах ${containerOf(m).join(", ") || "?"}` : `модуль ${m} — в контейнере ${containerOf(m).length === 1 ? containerOf(m)[0] : "?"}`,
    key: (m) => m,
    check: (m) => {
      const c = containerOf(m);
      if (isLibrary(m)) {
        if (!c.length) throw new Error(`библиотека ${m} не входит ни в один контейнер: от неё не зависит ни один модуль контейнеров`);
        return;
      }
      if (!c.length) throw new Error(`модуль ${m} не входит ни в один контейнер модели`);
      if (c.length > 1) throw new Error(`модуль ${m} — в нескольких контейнерах: ${c.join(", ")} — общий пакет отметь library: true`);
    },
    violator: { name: "модуль вне контейнеров", item: "__вне_контейнеров__" },
  });

  const edges = names(model).flatMap((m) => (model.modules[m]!.dependsOn ?? []).map((d) => ({ m, d })));
  if (edges.length) {
    add({
      registry: "зависимости модулей",
      items: edges,
      name: (e) => `зависимость ${e.m} → ${e.d} — внутри контейнера`,
      key: (e) => `${e.m}→${e.d}`,
      check: (e) => {
        const a = containerOf(e.m);
        const b = containerOf(e.d);
        // модуль вне контейнеров — тоже не «внутри контейнера»: иначе нарушитель прошёл бы на пустом списке
        if (!a.length || a.some((c) => !b.includes(c))) {
          throw new Error(`${e.m} (${a.join(", ") || "?"}) зависит от ${e.d} (${b.join(", ") || "?"}) — между контейнерами только связь uses`);
        }
      },
      violator: { name: "зависимость через контейнер", item: { m: "__a__", d: "__b__" } },
    });
  }

  const found = deployUnits(root);
  const declared = new Map<string, string>();
  for (const [c, x] of Object.entries(cont)) for (const d of x.deploy ?? []) declared.set(d, c);
  add({
    registry: "развёртываемые единицы",
    items: sorted([...new Set([...found, ...declared.keys()])]),
    name: (u) => `развёртываемая единица ${u} — контейнер ${declared.get(u) ?? "?"}`,
    key: (u) => u,
    check: (u) => {
      if (!declared.has(u)) throw new Error(`${u} есть в конфигах деплоя, но не в модели — добавь контейнер в tests/architecture/model.ts`);
      if (!found.includes(u)) throw new Error(`${u} контейнера ${declared.get(u)} нет в конфигах деплоя — модель разошлась с деплоем`);
    },
    violator: { name: "единица вне модели", item: "__вне_модели__" },
  });

  // клиенты хранилищ: какой контейнер их импортирует на деле (библиотека — каждый свой контейнер)
  const storages = Object.entries(cont).flatMap(([s, x]) => (x.clients ?? []).map((pkg) => ({ s, pkg })));
  if (storages.length) {
    const uses = new Map<string, { s: string; pkg: string; c: string; files: string[] }>();
    for (const src1 of src) {
      const mod = owners(model, src1.dir);
      if (mod.length !== 1) continue;
      for (const c of containerOf(mod[0]!)) {
        for (const st of storages) {
          if (!src1.packages.includes(st.pkg)) continue;
          const k = `${st.pkg}:${st.s}:${c}`;
          const u = uses.get(k) ?? { ...st, c, files: [] };
          u.files.push(src1.file);
          uses.set(k, u);
        }
      }
    }
    add({
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
    });
  }
}

/** Модули-адаптеры внешней системы: ни одного — периметр. */
export const adaptersOf = (e: External): string[] => (e.adapter === undefined ? [] : Array.isArray(e.adapter) ? e.adapter : [e.adapter]);

/** «адаптере a» / «адаптерах a, b» — форма по числу адаптеров. */
const adapterWord = (a: string[], one: string, many: string): string => `${a.length === 1 ? one : many} ${a.join(", ")}`;

/**
 * C1: хост внешней системы — только в её адаптерах (хост вне модели — красный), пакет внешней системы — только у
 * адаптеров (модель без противоречий), ключ окружения и заголовок внешней системы читают только адаптеры; у периметра
 * (адаптера нет) ничего из этого в коде нет. Реестры — из модели и кода; реестр, которого модель не объявляет (у внешних
 * систем нет пакетов), не регистрируется.
 */
function c1(add: Add, model: Model, src: Source[]): void {
  const ext = model.externals!;
  const inAdapters = (s: Source, a: string[]) => owners(model, s.dir).some((m) => a.includes(m));
  const files = (xs: Source[]) => xs.map((s) => s.file).join(", ");
  const hostOwner = new Map<string, string>();
  for (const [name, e] of Object.entries(ext)) for (const h of e.hosts ?? []) hostOwner.set(h.toLowerCase(), name);
  const hostFiles = new Map<string, Source[]>();
  for (const s of src) for (const h of s.hosts) hostFiles.set(h, [...(hostFiles.get(h) ?? []), s]);
  const hosts = sorted([...new Set([...hostOwner.keys(), ...hostFiles.keys()])]);
  if (hosts.length) {
    add({
      registry: "хосты внешних систем",
      items: hosts,
      name: (h) => {
        const x = hostOwner.get(h);
        if (!x) return `хост ${h} — только в адаптере ?`;
        const a = adaptersOf(ext[x]!);
        return a.length ? `хост ${h} — только в ${adapterWord(a, "адаптере", "адаптерах")}` : `хост ${h} внешней системы ${x} — не в коде: адаптера нет`;
      },
      key: (h) => h,
      check: (h) => {
        const found = hostFiles.get(h) ?? [];
        const x = hostOwner.get(h);
        if (!x) throw new Error(`хост ${h} не объявлен ни одной внешней системой модели: ${files(found)}`);
        const a = adaptersOf(ext[x]!);
        const outside = found.filter((s) => !inAdapters(s, a));
        if (!outside.length) return;
        if (!a.length) throw new Error(`у внешней системы ${x} нет адаптера, а хост ${h} — в коде: ${files(outside)}`);
        throw new Error(`хост ${h} внешней системы ${x} — вне её ${adapterWord(a, "адаптера", "адаптеров")}: ${files(outside)}`);
      },
      violator: { name: "хост вне модели", item: "__вне_модели__.example" },
    });
  }
  const pkgs = Object.entries(ext).flatMap(([x, e]) => (e.packages ?? []).map((p) => ({ x, p, a: adaptersOf(e) })));
  if (pkgs.length) {
    add({
      registry: "пакеты внешних систем",
      items: pkgs,
      name: (i) =>
        i.a.length ? `пакет ${i.p} внешней системы ${i.x} — только у ${adapterWord(i.a, "адаптера", "адаптеров")}` : `пакет ${i.p} внешней системы ${i.x} — ни у одного модуля: адаптера нет`,
      key: (i) => `${i.x}:${i.p}`,
      check: (i) => {
        const allowedTo = names(model).filter((n) => (model.modules[n]!.packages ?? []).includes(i.p));
        if (!i.a.length) {
          if (allowedTo.length) throw new Error(`у внешней системы ${i.x} нет адаптера, а пакет ${i.p} разрешён модулям: ${allowedTo.join(", ")}`);
          return;
        }
        if (!i.a.some((a) => allowedTo.includes(a))) {
          throw new Error(`${i.a.length === 1 ? `адаптеру ${i.a[0]}` : `ни одному из адаптеров ${i.a.join(", ")}`} пакет ${i.p} внешней системы ${i.x} не разрешён в модели`);
        }
        const others = allowedTo.filter((n) => !i.a.includes(n));
        if (others.length) throw new Error(`пакет ${i.p} внешней системы ${i.x} разрешён не только ${i.a.length === 1 ? "адаптеру" : "адаптерам"}: ${others.join(", ")}`);
      },
      violator: { name: "пакет без адаптера", item: { x: "__нарушитель__", p: "__нет__", a: ["__нет_модуля__"] } },
    });
  }

  // ключ окружения и заголовок — одно соглашение: читает только адаптер; нарушителю — свой исходник, читающий вне адаптера
  type Read = { x: string; k: string; a: string[]; src?: Source[] };
  const readOnlyByAdapters = (registry: string, noun: string, list: (e: External) => string[] | undefined, reads: (s: Source, k: string) => boolean, fake: Partial<Source>) => {
    const items: Read[] = Object.entries(ext).flatMap(([x, e]) => (list(e) ?? []).map((k) => ({ x, k, a: adaptersOf(e) })));
    if (!items.length) return;
    add({
      registry,
      items,
      name: (i) =>
        i.a.length
          ? `${noun} ${i.k} внешней системы ${i.x} ${i.a.length === 1 ? "читает только адаптер" : "читают только адаптеры"} ${i.a.join(", ")}`
          : `${noun} ${i.k} внешней системы ${i.x} — не в коде: адаптера нет`,
      key: (i) => `${i.x}:${i.k}`,
      check: (i) => {
        const outside = (i.src ?? src).filter((s) => reads(s, i.k) && !inAdapters(s, i.a));
        if (!outside.length) return;
        if (!i.a.length) throw new Error(`у внешней системы ${i.x} нет адаптера, а ${noun} ${i.k} читается в коде: ${files(outside)}`);
        throw new Error(`${noun} ${i.k} внешней системы ${i.x} читается вне ${adapterWord(i.a, "адаптера", "адаптеров")}: ${files(outside)}`);
      },
      violator: {
        name: `${noun} вне адаптера`,
        item: { x: "__нарушитель__", k: "__КЛЮЧ__", a: ["__нет_модуля__"], src: [{ file: "__нарушитель__.ts", dir: "__вне_модели__", packages: [], hosts: [], env: [], headers: [], ...fake }] },
      },
    });
  };
  readOnlyByAdapters("ключи окружения внешних систем", "ключ", (e) => e.env, (s, k) => s.env.includes(k), { env: ["__КЛЮЧ__"] });
  readOnlyByAdapters("заголовки внешних систем", "заголовок", (e) => e.headers, (s, k) => s.headers.includes(k.toLowerCase()), { headers: ["__ключ__"] });
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `fetch` под сторожем сети: отвергнутые запросы копятся до проверки после теста. */
export interface GuardedFetch extends Fetch {
  /** Хосты отвергнутых запросов с прошлой проверки, по порядку. */
  rejected: string[];
  /** Проверка после теста (`afterEach`): были отвергнутые — бросает со списком хостов; список очищается. */
  check(): void;
}

/**
 * `fetch` для тестов — сеть под моками: что дошло до сторожа, никто не замокал. В `fetchImpl` пропускаются только
 * локальные адреса (loopback) и хосты `allow` (интеграционный тест с песочницей); запрос к объявленной внешней системе
 * падает с именем хоста и системы — забытый мок не уходит в сеть, к хосту вне модели — «объяви внешнюю систему».
 * Код под тестом может поймать исключение `fetch` — поэтому отвергнутое копится в `rejected`, и `check()` после теста
 * роняет его. Установка — в настройке тестов, раньше моков (`vi.spyOn`, MSW `server.listen()` — поверх):
 * `const guard = networkGuard(model, globalThis.fetch); globalThis.fetch = guard; afterEach(() => guard.check())`.
 */
export function networkGuard(model: Model, fetchImpl: Fetch = globalThis.fetch, opts: { allow?: string[] } = {}): GuardedFetch {
  const owner = new Map<string, string>();
  for (const [name, e] of Object.entries(model.externals ?? {})) for (const h of e.hosts ?? []) owner.set(h.toLowerCase(), name);
  const allow = new Set((opts.allow ?? []).map((h) => h.toLowerCase()));
  const rejected: string[] = [];
  const guard: Fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname.toLowerCase();
    if (isLocal(host) || allow.has(host)) return fetchImpl(input, init);
    rejected.push(host);
    const system = owner.get(host);
    throw new Error(
      system
        ? `запрос к хосту ${host} внешней системы ${system} без мока — замокай запрос: в сеть тесты ходят только к локальным адресам и allow`
        : `запрос к хосту ${host} вне модели — объяви внешнюю систему в tests/architecture/model.ts и замокай запрос`,
    );
  };
  const check = () => {
    if (!rejected.length) return;
    const hosts = [...new Set(rejected)].join(", ");
    rejected.length = 0;
    throw new Error(`запросы к сети, отвергнутые сторожем: ${hosts} — замокай их (исключение fetch мог поймать код под тестом)`);
  };
  return Object.assign(guard, { rejected, check });
}

/** CSP `connect-src` браузера из хостов внешних систем модели: заголовок проекта сверяется с ним тестом. */
export function cspConnectSrc(model: Model, self: string[] = ["'self'"]): string {
  const hosts = sorted([...new Set(Object.values(model.externals ?? {}).flatMap((e) => (e.hosts ?? []).map((h) => h.toLowerCase())))]);
  return ["connect-src", ...self, ...hosts.map((h) => `https://${h}`)].join(" ");
}
