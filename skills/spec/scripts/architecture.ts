/**
 * architecture — the project's architecture model and its checks. There is one model, in `tests/architecture/model.ts`:
 * modules (path, purpose), which modules and external packages each one depends on. From it:
 *
 * - `boundariesConfig` — ESLint boundary rules (the project's eslint-plugin-boundaries): importing a module one may not
 *   depend on is an error in `lint` and in the editor; the `eslint.ts` fragment in `tests/architecture/<name>/`;
 * - `architecture` — tests: each code directory belongs to a module, an external package is imported only by a module
 *   it's allowed for, and each allowed package is actually used — the model doesn't diverge from the code either way.
 *
 * Imports — by static parsing of the sources (no build, no resolver): relative paths, the model's aliases and Node
 * built-in modules aren't packages. Only `node:` APIs and erasable TypeScript: Node ≥ 22.18 and Bun.
 */

import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import locale from "../../github/scripts/locale.cjs";
import type { Names } from "../../github/scripts/locale.cjs";
import { codeOnly, envNamesInCode, invariant } from "./harness.ts";
import type { EnvReader, Exception, Invariant, It } from "./harness.ts";

export interface Module {
  /** The module's directory from the project root (or several). */
  path: string | string[];
  /** Purpose — one phrase: why the module exists and what isn't in it. */
  purpose: string;
  /** The module's public API (the entry file), if the module is closed behind it. */
  api?: string;
  /** Modules this one may depend on (its own files — always). */
  dependsOn?: string[];
  /** External packages this module may import. */
  packages?: string[];
  /**
   * Library — a shared package built into several containers (a monorepo package in each app's bundle): its containers
   * are the containers of the modules that depend on it, and those where it's named in `modules`.
   */
  library?: boolean;
}

/** External system (C1): who it is, which modules talk to it and how — hosts, packages, environment keys, headers. */
export interface External {
  purpose: string;
  /**
   * Adapter module, or several: only they talk to the external system. None — a perimeter (a CDN, a WAF in front of the
   * system): no module talks to it, its hosts, packages, keys and headers aren't in the code.
   */
  adapter?: string | string[];
  hosts?: string[];
  packages?: string[];
  env?: string[];
  /** HTTP headers the external system integrates through (`CF-IPCountry` from a CDN): only the adapter reads them. */
  headers?: string[];
}

/** Container (C2): a deployable unit — an app, a function, a cron, a worker, a database, a storage. */
export interface Container {
  purpose: string;
  /** Code modules deployed in this container. */
  modules?: string[];
  /** Deployable units from configs: `compose:<service>`, `supabase-function:<name>`, `vercel-cron:<path>`. */
  deploy?: string[];
  /** Containers this one is linked to (a request, a queue, a database): a relation, not an import. */
  uses?: string[];
  /** For a storage: the client packages used to talk to it (`pg`, `@supabase/supabase-js`). */
  clients?: string[];
}

export interface Model {
  /** The system's name on the C1 and C2 diagrams of the docs (default — "System"). */
  name?: string;
  /** Code directories from the root (default `src`): each directory with code in them belongs to a module. */
  roots?: string[];
  /**
   * Import aliases → a path from the root (`{ "@/": "src/" }`) or a list of paths — in a monorepo each app has its own
   * `@/`: such an import is local, not a package.
   */
  aliases?: Record<string, string | string[]>;
  modules: Record<string, Module>;
  /** External systems (C1): a payment provider, mail, a geocoder… */
  externals?: Record<string, External>;
  /** Containers (C2): deployable units and the relations between them. */
  containers?: Record<string, Container>;
}

/**
 * Deployable units from the repository's deploy configs: `docker-compose.yml` / `compose.yml` services,
 * `supabase/functions/<name>` functions, crons in `vercel.json`, Terraform compute resources in `*.tf`
 * (`terraform:<type>.<name>`: an ECS service, a Lambda function, Cloud Run…). Parsing without dependencies: a compose
 * service is a key indented by two spaces under the top-level `services:`, a Terraform resource is the line
 * `resource "<type>" "<name>"`.
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
    /* no Supabase functions */
  }
  try {
    const v = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons?: { path: string }[] };
    for (const c of v.crons ?? []) out.add(`vercel-cron:${c.path}`);
  } catch {
    /* no vercel.json or crons */
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

// Terraform resources that deploy code: a service, a function, a job; a cluster, network, database isn't a code unit
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
 * Monorepo workspace packages — directories with `package.json` by the `workspaces` patterns from `package.json` (a
 * list or `{ packages }`) and `packages:` from `pnpm-workspace.yaml`; `!pattern` excludes. `*` — one directory level,
 * `**` — any depth.
 */
export function workspacePackages(root: string): string[] {
  const patterns: string[] = [];
  try {
    const ws = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { workspaces?: string[] | { packages?: string[] } }).workspaces;
    patterns.push(...(Array.isArray(ws) ? ws : (ws?.packages ?? [])));
  } catch {
    /* no package.json or workspaces */
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
    /* no pnpm-workspace.yaml */
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

/** Workspace directory pattern → RegExp: `*` and `?` stay within one level, `**` — any depth, including zero. */
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

/**
 * Walks the repository's directories (without `node_modules`, builds and hidden ones): visit gets the path from the
 * root and the directory's entries.
 */
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

/** Whether the directory has a code file (`.d.ts` declarations aren't code). */
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
 * ESLint boundary rules from the model: an element per module, importing a module not in `dependsOn` is a
 * `boundaries/dependencies` error. The rule skips external packages and built-in modules — `architecture` checks them.
 * `boundaries` — the plugin from the project's dependencies; `settings` — e.g. the TypeScript resolver for aliases.
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
        message: `module ${name} doesn't depend on {{to.element.type}} — module dependencies are in tests/architecture/model.ts`,
      },
    ];
  });
  return [
    {
      files: opts.files ?? roots.map((r) => `${r}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`),
      plugins: { boundaries },
      settings: {
        // the longest path first: the plugin takes the first matching element, and src/lib is nested in src
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

// import … from "x", export … from "x", import "x", import("x"), require("x"); `import type` isn't a code dependency
const IMPORT = /^\s*(import|export)\s+(type\s+)?[^;'"]*?\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gm;

/** External packages a source imports: package name (`@scope/lib`, `lodash`), in order of appearance, no repeats. */
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
  /** Headers of the model's external systems that the source names as a string — in lower case. */
  headers: string[];
}

// a URL literal in code: "https://api.example.com/…" — a host; local addresses and IPs aren't external systems
const URL_HOST = /["'`]https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?=[\/"'`?#])/gi;
// local addresses — loopback and "this host" 0.0.0.0 never leave the machine: not external systems, tests may reach
// them over the network (networkGuard); IPv6 is in brackets, as URL.hostname returns it. Any other IP is an external
// system's address
const isLocal = (h: string) => h === "localhost" || h.endsWith(".localhost") || /^127(\.\d+){3}$/.test(h) || h === "0.0.0.0" || h === "[::1]";
// domains for examples, docs and tests (RFC 2606, RFC 6761) — in code they aren't an external system; but a request to
// them in tests is a forgotten mock or the real network, so networkGuard doesn't let them through (it uses isLocal)
const isReserved = (h: string) => /(^|\.)(example|invalid|test)$|(^|\.)example\.(com|net|org)$/.test(h);
// XML namespace URIs aren't service addresses: the xmlns attribute and the W3C namespaces (createElementNS)
const XMLNS = /xmlns(?::[\w-]+)?\s*=\s*$/;
const NAMESPACE_HOSTS = new Set(["www.w3.org"]);
// an href value is a link the visitor's browser opens (`<a href>`, `<Link href={…}>`, `{ href: … }`): the system
// doesn't talk to that host. `<link href>` is loaded by the browser itself, `location.href =` is navigation by code
// (payment, sign-in): those are hosts
const HREF = /(?<![.\w$])["']?href["']?\s*(?:=\s*\{?|:)\s*$/;
const OPEN_TAG = /<([A-Za-z][\w.:-]*)[^<>]*$/;
const isLink = (text: string, at: number): boolean =>
  HREF.test(text.slice(Math.max(0, at - 40), at)) && OPEN_TAG.exec(text.slice(Math.max(0, at - 2000), at))?.[1] !== "link";

/**
 * Hosts of external systems in the source's URL literals; comments, namespaces, reserved domains and navigation links
 * (`href`) aren't.
 */
export function hostsIn(source: string, file?: string): string[] {
  return hostsInCode(codeOnly(source, file));
}

/** The same over code without comments: a source is parsed once for hosts, environment keys and headers. */
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

// a string literal that looks like an HTTP header name: `h.get("cf-ipcountry")`, `req.headers["CF-Connecting-IP"]`
const HEADER_LITERAL = /(["'`])([A-Za-z][A-Za-z0-9-]*)\1/g;

/** Headers from `declared` (in lower case) that the code names as a string, case-insensitively. */
function headersInCode(text: string, declared: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HEADER_LITERAL)) {
    const h = m[2]!.toLowerCase();
    if (declared.has(h)) out.add(h);
  }
  return [...out];
}

/**
 * Sources of the model's roots: packages, hosts, environment keys and headers — from code without comments, keys — also
 * via `readers`.
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
 * Modules whose directory the path belongs to: the module with the longest matching path (`src/lib` is nested in
 * `src` — directory `src/lib/x` belongs to module `src/lib`); several — the same path in several modules, a model
 * conflict.
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
 * Model tests: "directory <directory> is in module <module>" for each directory with code (the module with the longest
 * matching path; outside the modules or one path in several modules — red),
 * "workspace package <path> is in the code roots" for each monorepo package with code (outside `roots` — red),
 * "<module> imports <package>" for each external package the module imports (not allowed — red),
 * "<module> uses allowed package <package>" for each model package (not imported — red: remove it from the model).
 * Each is "registry + invariant": not empty, a known violator, exceptions from the decision folder's `exceptions/`.
 * `outside` — elements outside the model on purpose, with a reason (dev tools: the shared ESLint config, test helpers):
 * a decision, not a debt with a task; a workspace package — also with the mark `spec-outside(<decision>)` in its
 * `package.json`.
 * `readers` — the project's own ways of reading the environment, the same as for `envVars` (`configGet`): for
 * external system keys.
 */
export function architecture(
  it: It,
  opts: { root: string; model: Model; exceptions?: readonly Exception[]; outside?: readonly Outside[]; readers?: readonly EnvReader[] },
): void {
  const { model } = opts;
  // registries and test names are in the project language (the directory the runner runs from), at registration
  const N = locale.names(locale.projectLanguage());
  // registries are collected in full, then registered: an exception goes only to the registry that has its element
  const specs: Invariant<unknown>[] = [];
  const add: Add = (spec) => void specs.push(spec as Invariant<unknown>);
  const src = sources(opts.root, model, opts.readers);
  const dirs = sorted([...new Set(src.map((s) => s.dir))]);
  const moduleOf = (dir: string) => owners(model, dir);

  add({
    registry: N.spec.architecture.dirsRegistry,
    items: dirs,
    name: (d) => locale.fill(N.spec.architecture.dirName, { dir: d, module: moduleOf(d).length === 1 ? moduleOf(d)[0]! : "?" }),
    key: (d) => d,
    check: (d) => {
      const own = moduleOf(d);
      if (!own.length) throw new Error(`${d}: code outside the model's modules — add a module to tests/architecture/model.ts or move the code`);
      if (own.length > 1) throw new Error(`${d}: the directory is in several modules — ${own.join(", ")}`);
    },
    violator: { name: N.spec.architecture.dirViolator, item: "__outside_model__" },
  });

  // the model's roots are set by hand: the check wouldn't see a new workspace package outside them at all
  const roots = (model.roots ?? ["src"]).map((r) => r.replace(/^\.\//, "").replace(/\/+$/, ""));
  const inRoots = (p: string) => roots.some((r) => r === p || r.startsWith(p + "/") || p.startsWith(r + "/"));
  const packages = roots.some((r) => r === "" || r === ".") ? [] : workspacePackages(opts.root).filter((p) => hasCode(path.join(opts.root, p)));
  if (packages.length) {
    add({
      registry: N.spec.architecture.workspaceRegistry,
      items: packages,
      name: (p) => locale.fill(N.spec.architecture.workspaceName, { path: p }),
      key: (p) => p,
      // "outside scope" and a package exception — a mark in its package.json: a deleted package takes its mark with it
      fileOf: (p) => path.join(opts.root, p, "package.json"),
      check: (p) => {
        if (!inRoots(p)) throw new Error(`${p}: a workspace package with code outside the model's roots — add it to roots in tests/architecture/model.ts`);
      },
      violator: { name: N.spec.architecture.workspaceViolator, item: "__outside_roots__" },
    });
  }

  // packages a module actually imports: module → package → files
  const used = new Map<string, Map<string, string[]>>();
  for (const s of src) {
    const own = moduleOf(s.dir);
    if (own.length !== 1) continue; // outside the modules — the directory test is already red
    const byPkg = used.get(own[0]!) ?? new Map<string, string[]>();
    for (const p of s.packages) byPkg.set(p, [...(byPkg.get(p) ?? []), s.file]);
    used.set(own[0]!, byPkg);
  }
  const imports = [...used].flatMap(([mod, byPkg]) => [...byPkg].map(([pkg, files]) => ({ mod, pkg, files })));
  const allowed = (mod: string) => model.modules[mod]?.packages ?? [];
  add({
    registry: N.spec.architecture.importsRegistry,
    items: imports,
    name: (i) => locale.fill(N.spec.architecture.importsName, { module: i.mod, package: i.pkg }),
    key: (i) => `${i.mod}:${i.pkg}`,
    check: (i) => {
      if (!allowed(i.mod).includes(i.pkg)) throw new Error(`package ${i.pkg} is not allowed for module ${i.mod}: ${i.files.join(", ")}`);
    },
    violator: { name: N.spec.architecture.importsViolator, item: { mod: names(model)[0] ?? "", pkg: "__not_allowed__", files: ["__violator__"] } },
  });

  const declared = names(model).flatMap((mod) => allowed(mod).map((pkg) => ({ mod, pkg })));
  add({
    registry: N.spec.architecture.allowedRegistry,
    items: declared,
    name: (d) => locale.fill(N.spec.architecture.allowedName, { module: d.mod, package: d.pkg }),
    key: (d) => `${d.mod}:${d.pkg}`,
    check: (d) => {
      if (!used.get(d.mod)?.has(d.pkg)) throw new Error(`module ${d.mod} doesn't import ${d.pkg} — remove the package from the model or fix the code`);
    },
    violator: { name: N.spec.architecture.allowedViolator, item: { mod: "__no_module__", pkg: "__unused__" } },
  });

  if (model.externals) c1(add, N, model, src);
  if (model.containers) c2(add, N, opts.root, model, src);
  const exceptions = route(opts.exceptions ?? [], specs);
  const outside = route(opts.outside ?? [], specs);
  for (const [i, spec] of specs.entries()) invariant(it, { ...spec, exceptions: exceptions[i], outside: outside[i] });
}

type Add = <T>(spec: Invariant<T>) => void;

/** "Outside scope" for a model element: key, reason and the registry name when the element is in several registries. */
export interface Outside {
  item: string;
  reason: string;
  rule?: string;
}

/**
 * The model's registries: an exception's `rule` names a registry in any dictionary language — the project could have
 * changed its language.
 */
const REGISTRIES: ((n: Names) => string)[] = [
  (n) => n.spec.architecture.dirsRegistry,
  (n) => n.spec.architecture.workspaceRegistry,
  (n) => n.spec.architecture.importsRegistry,
  (n) => n.spec.architecture.allowedRegistry,
  (n) => n.spec.architecture.containersRegistry,
  (n) => n.spec.architecture.edgesRegistry,
  (n) => n.spec.architecture.unitsRegistry,
  (n) => n.spec.architecture.clientsRegistry,
  (n) => n.spec.architecture.hostsRegistry,
  (n) => n.spec.architecture.packagesRegistry,
  (n) => n.spec.architecture.envRegistry,
  (n) => n.spec.architecture.headersRegistry,
];
/** The registry name in the project language for a `rule` in any dictionary language; not a model registry — as is. */
const registryOf = (rule: string, n: Names): string => REGISTRIES.find((pick) => locale.every(pick).includes(rule))?.(n) ?? rule;

/**
 * Exceptions and "outside scope" by registry: with `rule` — to the registry with that name, without — to the registries
 * that have its element; the element is nowhere — to the first registry, so the ratchet says "remove the exception"
 * ("remove from scope") instead of staying silent.
 */
function route<X extends { item: string; rule?: string }>(xs: readonly X[], specs: Invariant<unknown>[]): Omit<X, "rule">[][] {
  const keys = specs.map((sp) => new Set(sp.items.map((x) => String((sp.key ?? sp.name)(x)))));
  const out: Omit<X, "rule">[][] = specs.map(() => []);
  const n = locale.names(locale.projectLanguage());
  for (const { rule, ...x } of xs) {
    const byRule = rule ? specs.findIndex((sp) => sp.registry === registryOf(rule, n)) : -1;
    let to = byRule >= 0 ? [byRule] : keys.flatMap((k, i) => (!rule && k.has(x.item) ? [i] : []));
    if (!to.length) to = [0];
    for (const i of to) out[i]!.push(x);
  }
  return out;
}

/**
 * Each module's containers: from the containers' `modules`, for a library — also the containers of the modules that
 * depend on it (transitively: a library's library is built into the same ones). The lists are sorted.
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
 * C2: a module is in exactly one container, a library — in at least one; module dependencies stay inside a container:
 * the target is in every container of the source (across containers — only `uses`); the deployable units of the configs
 * and of the model match both ways; a storage client is only in a container with a `uses` relation to that storage.
 */
function c2(add: Add, N: Names, root: string, model: Model, src: Source[]): void {
  const cont = model.containers!;
  const of = moduleContainers(model);
  const containerOf = (m: string) => of.get(m) ?? [];
  const isLibrary = (m: string) => !!model.modules[m]?.library;
  add({
    registry: N.spec.architecture.containersRegistry,
    items: names(model),
    name: (m) =>
      isLibrary(m)
        ? locale.fill(N.spec.architecture.libraryName, { module: m, containers: containerOf(m).join(", ") || "?" })
        : locale.fill(N.spec.architecture.moduleName, { module: m, container: containerOf(m).length === 1 ? containerOf(m)[0]! : "?" }),
    key: (m) => m,
    check: (m) => {
      const c = containerOf(m);
      if (isLibrary(m)) {
        if (!c.length) throw new Error(`library ${m} is in no container: no module of the containers depends on it`);
        return;
      }
      if (!c.length) throw new Error(`module ${m} is in no container of the model`);
      if (c.length > 1) throw new Error(`module ${m} is in several containers: ${c.join(", ")} — mark a shared package with library: true`);
    },
    violator: { name: N.spec.architecture.containersViolator, item: "__outside_containers__" },
  });

  const edges = names(model).flatMap((m) => (model.modules[m]!.dependsOn ?? []).map((d) => ({ m, d })));
  if (edges.length) {
    add({
      registry: N.spec.architecture.edgesRegistry,
      items: edges,
      name: (e) => locale.fill(N.spec.architecture.edgeName, { from: e.m, to: e.d }),
      key: (e) => `${e.m}→${e.d}`,
      check: (e) => {
        const a = containerOf(e.m);
        const b = containerOf(e.d);
        // a module outside containers isn't "inside a container" either: else a violator would pass on an empty list
        if (!a.length || a.some((c) => !b.includes(c))) {
          throw new Error(`${e.m} (${a.join(", ") || "?"}) depends on ${e.d} (${b.join(", ") || "?"}) — across containers only a uses link`);
        }
      },
      violator: { name: N.spec.architecture.edgeViolator, item: { m: "__a__", d: "__b__" } },
    });
  }

  const found = deployUnits(root);
  const declared = new Map<string, string>();
  for (const [c, x] of Object.entries(cont)) for (const d of x.deploy ?? []) declared.set(d, c);
  add({
    registry: N.spec.architecture.unitsRegistry,
    items: sorted([...new Set([...found, ...declared.keys()])]),
    name: (u) => locale.fill(N.spec.architecture.unitName, { unit: u, container: declared.get(u) ?? "?" }),
    key: (u) => u,
    check: (u) => {
      if (!declared.has(u)) throw new Error(`${u} is in the deploy configs but not in the model — add a container to tests/architecture/model.ts`);
      if (!found.includes(u)) throw new Error(`${u} of container ${declared.get(u)} is not in the deploy configs — the model diverged from the deploy`);
    },
    violator: { name: N.spec.architecture.unitViolator, item: "__outside_model__" },
  });

  // storage clients: which container actually imports them (a library — each of its containers)
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
      registry: N.spec.architecture.clientsRegistry,
      items: [...uses.values()],
      name: (u) => locale.fill(N.spec.architecture.clientName, { package: u.pkg, storage: u.s, container: u.c }),
      key: (u) => `${u.pkg}:${u.c}`,
      check: (u) => {
        if (u.c !== u.s && !(cont[u.c]?.uses ?? []).includes(u.s)) {
          throw new Error(`container ${u.c} imports client ${u.pkg} of storage ${u.s} without a uses link: ${u.files.join(", ")}`);
        }
      },
      violator: { name: N.spec.architecture.clientViolator, item: { s: "__storage__", pkg: "__client__", c: "__container__", files: [] } },
    });
  }
}

/** The external system's adapter modules: none — a perimeter. */
export const adaptersOf = (e: External): string[] => (e.adapter === undefined ? [] : Array.isArray(e.adapter) ? e.adapter : [e.adapter]);

/** "adapter a" / "adapters a, b" — the form by the number of adapters. */
const adapterWord = (a: string[], one: string, many: string): string => `${a.length === 1 ? one : many} ${a.join(", ")}`;

/**
 * C1: an external system's host is only in its adapters (a host outside the model — red), an external system's package
 * is only with the adapters (a model without contradictions), only adapters read an external system's environment key
 * and header; a perimeter (no adapter) has none of these in the code. Registries come from the model and the code; a
 * registry the model doesn't declare (the external systems have no packages) isn't registered.
 */
function c1(add: Add, N: Names, model: Model, src: Source[]): void {
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
      registry: N.spec.architecture.hostsRegistry,
      items: hosts,
      name: (h) => {
        const x = hostOwner.get(h);
        if (!x) return locale.fill(N.spec.architecture.hostName, { host: h, adapters: locale.fill(N.spec.architecture.inAdapter, { list: "?" }) });
        const a = adaptersOf(ext[x]!);
        const adapters = locale.fill(a.length === 1 ? N.spec.architecture.inAdapter : N.spec.architecture.inAdapters, { list: a.join(", ") });
        return a.length ? locale.fill(N.spec.architecture.hostName, { host: h, adapters }) : locale.fill(N.spec.architecture.hostPerimeter, { host: h, system: x });
      },
      key: (h) => h,
      check: (h) => {
        const found = hostFiles.get(h) ?? [];
        const x = hostOwner.get(h);
        if (!x) throw new Error(`host ${h} is declared by no external system of the model: ${files(found)}`);
        const a = adaptersOf(ext[x]!);
        const outside = found.filter((s) => !inAdapters(s, a));
        if (!outside.length) return;
        if (!a.length) throw new Error(`external system ${x} has no adapter, yet host ${h} is in the code: ${files(outside)}`);
        throw new Error(`host ${h} of external system ${x} is outside its ${adapterWord(a, "adapter", "adapters")}: ${files(outside)}`);
      },
      violator: { name: N.spec.architecture.hostViolator, item: "__outside_model__.example" },
    });
  }
  const pkgs = Object.entries(ext).flatMap(([x, e]) => (e.packages ?? []).map((p) => ({ x, p, a: adaptersOf(e) })));
  if (pkgs.length) {
    add({
      registry: N.spec.architecture.packagesRegistry,
      items: pkgs,
      name: (i) =>
        i.a.length
          ? locale.fill(N.spec.architecture.packageName, { package: i.p, system: i.x, adapters: locale.fill(i.a.length === 1 ? N.spec.architecture.withAdapter : N.spec.architecture.withAdapters, { list: i.a.join(", ") }) })
          : locale.fill(N.spec.architecture.packagePerimeter, { package: i.p, system: i.x }),
      key: (i) => `${i.x}:${i.p}`,
      check: (i) => {
        const allowedTo = names(model).filter((n) => (model.modules[n]!.packages ?? []).includes(i.p));
        if (!i.a.length) {
          if (allowedTo.length) throw new Error(`external system ${i.x} has no adapter, yet package ${i.p} is allowed for modules: ${allowedTo.join(", ")}`);
          return;
        }
        if (!i.a.some((a) => allowedTo.includes(a))) {
          throw new Error(`package ${i.p} of external system ${i.x} is not allowed in the model for ${i.a.length === 1 ? `adapter ${i.a[0]}` : `any of adapters ${i.a.join(", ")}`}`);
        }
        const others = allowedTo.filter((n) => !i.a.includes(n));
        if (others.length) throw new Error(`package ${i.p} of external system ${i.x} is allowed not only for ${i.a.length === 1 ? "the adapter" : "the adapters"}: ${others.join(", ")}`);
      },
      violator: { name: N.spec.architecture.packageViolator, item: { x: "__violator__", p: "__none__", a: ["__no_module__"] } },
    });
  }

  // an environment key and a header are one convention: only the adapter reads them; the violator gets its own source
  // that reads outside the adapter
  type Read = { x: string; k: string; a: string[]; src?: Source[] };
  const readOnlyByAdapters = (registry: string, noun: string, word: string, list: (e: External) => string[] | undefined, reads: (s: Source, k: string) => boolean, fake: Partial<Source>) => {
    const items: Read[] = Object.entries(ext).flatMap(([x, e]) => (list(e) ?? []).map((k) => ({ x, k, a: adaptersOf(e) })));
    if (!items.length) return;
    add({
      registry,
      items,
      name: (i) =>
        i.a.length
          ? locale.fill(i.a.length === 1 ? N.spec.architecture.readName : N.spec.architecture.readNameMany, { noun, key: i.k, system: i.x, list: i.a.join(", ") })
          : locale.fill(N.spec.architecture.readPerimeter, { noun, key: i.k, system: i.x }),
      key: (i) => `${i.x}:${i.k}`,
      check: (i) => {
        const outside = (i.src ?? src).filter((s) => reads(s, i.k) && !inAdapters(s, i.a));
        if (!outside.length) return;
        if (!i.a.length) throw new Error(`external system ${i.x} has no adapter, yet ${word} ${i.k} is read in the code: ${files(outside)}`);
        throw new Error(`${word} ${i.k} of external system ${i.x} is read outside its ${adapterWord(i.a, "adapter", "adapters")}: ${files(outside)}`);
      },
      violator: {
        name: locale.fill(N.spec.architecture.readViolator, { noun }),
        item: { x: "__violator__", k: "__KEY__", a: ["__no_module__"], src: [{ file: "__violator__.ts", dir: "__outside_model__", packages: [], hosts: [], env: [], headers: [], ...fake }] },
      },
    });
  };
  readOnlyByAdapters(N.spec.architecture.envRegistry, N.spec.architecture.envNoun, "key", (e) => e.env, (s, k) => s.env.includes(k), { env: ["__KEY__"] });
  readOnlyByAdapters(N.spec.architecture.headersRegistry, N.spec.architecture.headerNoun, "header", (e) => e.headers, (s, k) => s.headers.includes(k.toLowerCase()), { headers: ["__key__"] });
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `fetch` under the network guard: rejected requests accumulate until the check after the test. */
export interface GuardedFetch extends Fetch {
  /** Hosts of rejected requests since the last check, in order. */
  rejected: string[];
  /** The check after a test (`afterEach`): rejected requests — throws with the list of hosts; the list is cleared. */
  check(): void;
}

/**
 * `fetch` for tests — the network under mocks: whatever reached the guard, nobody mocked. Only local addresses
 * (loopback) and the `allow` hosts (an integration test with a sandbox) pass through to `fetchImpl`; a request to a
 * declared external system fails with the host and system name — a forgotten mock doesn't go to the network; to a host
 * outside the model — "declare the external system". The code under test may catch the `fetch` exception — so
 * rejections accumulate in `rejected`, and `check()` after the test throws them. Setup — in the test setup, before the
 * mocks (`vi.spyOn`, MSW `server.listen()` — on top of it):
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
        ? `request to host ${host} of external system ${system} without a mock — mock the request: tests go to the network only to local addresses and allow`
        : `request to host ${host} outside the model — declare the external system in tests/architecture/model.ts and mock the request`,
    );
  };
  const check = () => {
    if (!rejected.length) return;
    const hosts = [...new Set(rejected)].join(", ");
    rejected.length = 0;
    throw new Error(`network requests rejected by the guard: ${hosts} — mock them (the code under test may have caught the fetch exception)`);
  };
  return Object.assign(guard, { rejected, check });
}

/**
 * The browser's CSP `connect-src` from the hosts of the model's external systems: a test checks the project's header
 * against it.
 */
export function cspConnectSrc(model: Model, self: string[] = ["'self'"]): string {
  const hosts = sorted([...new Set(Object.values(model.externals ?? {}).flatMap((e) => (e.hosts ?? []).map((h) => h.toLowerCase())))]);
  return ["connect-src", ...self, ...hosts.map((h) => `https://${h}`)].join(" ");
}
