/**
 * c4 — architecture from the model `tests/architecture/model.ts` in Markdown: three C4 levels as Mermaid diagrams (C1 —
 * `C4Context`, C2 — `C4Container`, C3 — `C4Component`) and a table of modules. The diagrams are built on every
 * documentation build — there is no hand-written one to fall behind the code. Element order is the declaration order in
 * the model.
 *
 * A mark `<!-- spec: c4-… -->` on its own line in `<folder>.md` is replaced with the same diagram (`embed`). Labels are
 * in the project language `lang` (the github skill's dictionary), model data — as the project wrote it.
 */

import locale from "../../github/scripts/locale.cjs";
import { adaptersOf, moduleContainers } from "./architecture.ts";
import type { Container, External, Model, Module } from "./architecture.ts";
import { mdText } from "./speclib.ts";

const entries = <T>(r?: Record<string, T>): [string, T][] => Object.entries(r ?? {});
/** Mermaid identifier: Latin letters, digits and `_`; the prefix separates a same-named container and module. */
const id = (prefix: string, name: string): string => prefix + name.replace(/[^A-Za-z0-9_]/g, "_");
/** A Mermaid string: in quotes, without quotes or line breaks inside. */
const q = (s: string): string => `"${s.replace(/"/g, "'").replace(/\s+/g, " ").trim()}"`;
const paths = (m: Module): string[] => (Array.isArray(m.path) ? m.path : [m.path]).map((p) => p.replace(/\/+$/, ""));
const hosts = (x: { hosts?: string[] }): string => (x.hosts ?? []).join(", ");
const systemName = (m: Model, lang: string): string => m.name ?? locale.names(lang).spec.c4.system;

function rel(from: string, to: string, label: string, techn = ""): string {
  return `  Rel(${from}, ${to}, ${q(label)}${techn ? ", " + q(techn) : ""})`;
}

const isStorage = (c: Container): boolean => !!c.clients?.length;

function containerLine(name: string, c: Container, indent: string): string {
  return `${indent}${isStorage(c) ? "ContainerDb" : "Container"}(${id("c_", name)}, ${q(name)}, ${q((c.deploy ?? []).join(", "))}, ${q(c.purpose)})`;
}

const externalLines = (m: Model): string[] =>
  entries(m.externals).map(([n, x]) => `  System_Ext(${id("ext_", n)}, ${q(n)}, ${q(x.purpose)})`);

/** "via module a" / "via modules a, b". */
function via(a: string[], lang: string): string {
  const n = locale.names(lang);
  return locale.fill(a.length === 1 ? n.spec.c4.viaModule : n.spec.c4.viaModules, { modules: a.join(", ") });
}

const fence = (kind: string, title: string, body: string[]): string[] => ["```mermaid", kind, `  title ${title}`, ...body, "```"];

/**
 * C1: the system and external systems; a link is labeled with the adapter modules and hosts, a perimeter one (no
 * adapter) comes before the system.
 */
export function c4Context(m: Model, lang: string): string[] {
  const n = locale.names(lang);
  const link = ([name, x]: [string, External]) => {
    const a = adaptersOf(x);
    return a.length ? rel("system", id("ext_", name), via(a, lang), hosts(x)) : rel(id("ext_", name), "system", n.spec.c4.perimeter, hosts(x));
  };
  return fence("C4Context", n.spec.c4.context, [`  System(system, ${q(systemName(m, lang))})`, ...externalLines(m), ...entries(m.externals).map(link)]);
}

/**
 * C2: containers inside the system (a storage — a database), `uses` links, an external system — at every container
 * with its adapter (a library adapter — in all its containers); the perimeter has no links to containers.
 */
export function c4Container(m: Model, lang: string): string[] {
  const n = locale.names(lang);
  const body = [`  System_Boundary(system, ${q(systemName(m, lang))}) {`];
  for (const [name, c] of entries(m.containers)) body.push(containerLine(name, c, "    "));
  body.push("  }", ...externalLines(m));
  for (const [name, c] of entries(m.containers)) for (const u of c.uses ?? []) body.push(rel(id("c_", name), id("c_", u), n.spec.c4.uses));
  const of = moduleContainers(m);
  for (const [name, x] of entries(m.externals)) {
    for (const [cn] of entries(m.containers)) {
      const a = adaptersOf(x).filter((ad) => (of.get(ad) ?? []).includes(cn));
      if (a.length) body.push(rel(id("c_", cn), id("ext_", name), via(a, lang), hosts(x)));
    }
  }
  return fence("C4Container", n.spec.c4.containers, body);
}

/**
 * C3: modules by container, a library — outside their boundaries (its containers are seen through the modules that
 * depend on it), `dependsOn` dependencies; a storage — at the module whose packages are its clients; an external
 * system — at every adapter module.
 */
export function c4Component(m: Model, lang: string): string[] {
  const n = locale.names(lang);
  const component = (name: string, indent: string) => {
    const x = m.modules[name]!;
    const techn = [...paths(x), ...(x.library ? [n.spec.c4.library] : [])].join(", ");
    return `${indent}Component(${id("m_", name)}, ${q(name)}, ${q(techn)}, ${q(x.purpose)})`;
  };
  const body: string[] = [];
  const placed = new Set<string>();
  for (const [cn, c] of entries(m.containers)) {
    const mods = (c.modules ?? []).filter((x) => m.modules[x] && !m.modules[x].library);
    if (!mods.length) continue;
    body.push(`  Container_Boundary(${id("c_", cn)}, ${q(cn)}) {`, ...mods.map((x) => component(x, "    ")), "  }");
    for (const x of mods) placed.add(x);
  }
  for (const name of Object.keys(m.modules)) if (!placed.has(name)) body.push(component(name, "  "));

  const storageRels: string[] = [];
  const storages = new Set<string>();
  for (const [name, x] of entries(m.modules)) {
    for (const [cn, c] of entries(m.containers)) {
      if (c.modules?.length) continue;
      const clients = (c.clients ?? []).filter((p) => (x.packages ?? []).includes(p));
      if (!clients.length) continue;
      storages.add(cn);
      storageRels.push(rel(id("m_", name), id("c_", cn), clients.join(", ")));
    }
  }
  for (const [cn, c] of entries(m.containers)) if (storages.has(cn)) body.push(containerLine(cn, c, "  "));
  body.push(...externalLines(m));
  for (const [name, x] of entries(m.modules)) for (const d of x.dependsOn ?? []) body.push(rel(id("m_", name), id("m_", d), n.spec.c4.dependsOn));
  body.push(...storageRels);
  for (const [name, x] of entries(m.externals)) for (const a of adaptersOf(x)) body.push(rel(id("m_", a), id("ext_", name), n.spec.c4.calls, hosts(x)));
  return fence("C4Component", n.spec.c4.components, body);
}

/** Module table: purpose, directory, public API, which modules it depends on, which packages it imports. */
export function modulesTable(m: Model, lang: string): string[] {
  const cell = (s: string) => mdText(s).replace(/\|/g, "\\|");
  const code = (xs: string[]) => (xs.length ? xs.map((x) => "`" + x + "`").join(", ") : "—");
  return [
    locale.names(lang).spec.c4.table,
    "|---|---|---|---|---|---|",
    ...entries(m.modules).map(
      ([n, x]) =>
        `| ${cell(n)} | ${cell(x.purpose)} | ${code(paths(x))} | ${code(x.api ? [x.api] : [])} | ${(x.dependsOn ?? []).map(cell).join(", ") || "—"} | ${code(x.packages ?? [])} |`,
    ),
  ];
}

/**
 * Architecture page starting from a heading of level `level`; a level with no data in the model (no external systems,
 * containers) isn't drawn.
 */
export function architecturePage(m: Model, level: number, lang: string): string[] {
  const n = locale.names(lang);
  const h = (l: number, t: string) => "#".repeat(Math.min(l, 6)) + " " + t;
  const out = [h(level, n.spec.c4.title), "", n.spec.c4.intro, ""];
  if (entries(m.externals).length) out.push(h(level + 1, `${n.spec.c4.context} (C1)`), "", ...c4Context(m, lang), "");
  if (entries(m.containers).length) out.push(h(level + 1, `${n.spec.c4.containers} (C2)`), "", ...c4Container(m, lang), "");
  out.push(h(level + 1, `${n.spec.c4.components} (C3)`), "", ...c4Component(m, lang), "", ...modulesTable(m, lang), "");
  return out;
}

/** Table of contents line: how many modules, containers and external systems the model has. */
export function modelSummary(m: Model, lang: string): string {
  const n = locale.names(lang);
  const parts = [locale.count(lang, n.spec.c4.moduleCount, Object.keys(m.modules).length)];
  const nc = entries(m.containers).length;
  const ne = entries(m.externals).length;
  if (nc) parts.push(locale.count(lang, n.spec.c4.containerCount, nc));
  if (ne) parts.push(locale.count(lang, n.spec.c4.externalCount, ne));
  return locale.fill(n.spec.c4.summary, { parts: parts.join(", ") });
}

export const MARKS: Record<string, (m: Model, lang: string) => string[]> = {
  "c4-context": c4Context,
  "c4-container": c4Container,
  "c4-component": c4Component,
  "c4-modules": modulesTable,
};

const MARK_LINE = /^[ \t]*<!--\s*spec:\s*([\w-]+)\s*-->[ \t]*$/gm;

/**
 * Marks `<!-- spec: <name> -->` on their own line → a diagram from the model in language `lang`. A mark without a model
 * or an unknown one stays (an HTML comment isn't visible on the page) and is returned in `bad` — spec-doc names it.
 */
export function embed(text: string, model: Model | null, lang: string): { text: string; bad: { mark: string; missing: "model" | "mark" }[] } {
  const bad: { mark: string; missing: "model" | "mark" }[] = [];
  const out = text.replace(MARK_LINE, (line, name: string) => {
    // a scenario diagram doesn't come from the model: spec-doc puts it in from the test's trace
    if (name.startsWith("sequence-")) return line;
    const render = Object.hasOwn(MARKS, name) ? MARKS[name] : undefined;
    if (!render) bad.push({ mark: name, missing: "mark" });
    else if (!model) bad.push({ mark: name, missing: "model" });
    else return render(model, lang).join("\n");
    return line;
  });
  return { text: out, bad };
}
