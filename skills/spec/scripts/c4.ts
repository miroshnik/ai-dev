/**
 * c4 — архитектура из модели `tests/architecture/model.ts` в Markdown: три уровня C4 схемами Mermaid (C1 —
 * `C4Context`, C2 — `C4Container`, C3 — `C4Component`) и таблица модулей. Схемы строятся при каждой сборке
 * документации — рукописной, которая отстанет от кода, нет. Порядок элементов — порядок объявления в модели.
 *
 * Метка `<!-- spec: c4-… -->` отдельной строкой в `<папка>.md` заменяется той же схемой (`embed`).
 */

import { adaptersOf, moduleContainers } from "./architecture.ts";
import type { Container, External, Model, Module } from "./architecture.ts";
import { mdText, plural } from "./speclib.ts";

const entries = <T>(r?: Record<string, T>): [string, T][] => Object.entries(r ?? {});
/** Идентификатор Mermaid: латиница, цифры и `_`; префикс разводит одноимённые контейнер и модуль. */
const id = (prefix: string, name: string): string => prefix + name.replace(/[^A-Za-z0-9_]/g, "_");
/** Строка Mermaid: в кавычках, без кавычек и переводов строк внутри. */
const q = (s: string): string => `"${s.replace(/"/g, "'").replace(/\s+/g, " ").trim()}"`;
const paths = (m: Module): string[] => (Array.isArray(m.path) ? m.path : [m.path]).map((p) => p.replace(/\/+$/, ""));
const hosts = (x: { hosts?: string[] }): string => (x.hosts ?? []).join(", ");
const systemName = (m: Model): string => m.name ?? "Система";

function rel(from: string, to: string, label: string, techn = ""): string {
  return `  Rel(${from}, ${to}, ${q(label)}${techn ? ", " + q(techn) : ""})`;
}

const isStorage = (c: Container): boolean => !!c.clients?.length;

function containerLine(name: string, c: Container, indent: string): string {
  return `${indent}${isStorage(c) ? "ContainerDb" : "Container"}(${id("c_", name)}, ${q(name)}, ${q((c.deploy ?? []).join(", "))}, ${q(c.purpose)})`;
}

const externalLines = (m: Model): string[] =>
  entries(m.externals).map(([n, x]) => `  System_Ext(${id("ext_", n)}, ${q(n)}, ${q(x.purpose)})`);

/** «через модуль a» / «через модули a, b». */
const via = (a: string[]): string => `через ${a.length === 1 ? "модуль" : "модули"} ${a.join(", ")}`;

const fence = (kind: string, title: string, body: string[]): string[] => ["```mermaid", kind, `  title ${title}`, ...body, "```"];

/** C1: система и внешние системы; связь подписана модулями-адаптерами и хостами, периметр (без адаптера) — перед системой. */
export function c4Context(m: Model): string[] {
  const link = ([n, x]: [string, External]) => {
    const a = adaptersOf(x);
    return a.length ? rel("system", id("ext_", n), via(a), hosts(x)) : rel(id("ext_", n), "system", "периметр", hosts(x));
  };
  return fence("C4Context", "Система и внешние системы", [`  System(system, ${q(systemName(m))})`, ...externalLines(m), ...entries(m.externals).map(link)]);
}

/**
 * C2: контейнеры внутри системы (хранилище — база), связи `uses`, внешняя система — у каждого контейнера с её
 * адаптером (библиотека-адаптер — во всех своих контейнерах); у периметра связей с контейнерами нет.
 */
export function c4Container(m: Model): string[] {
  const body = [`  System_Boundary(system, ${q(systemName(m))}) {`];
  for (const [n, c] of entries(m.containers)) body.push(containerLine(n, c, "    "));
  body.push("  }", ...externalLines(m));
  for (const [n, c] of entries(m.containers)) for (const u of c.uses ?? []) body.push(rel(id("c_", n), id("c_", u), "использует"));
  const of = moduleContainers(m);
  for (const [n, x] of entries(m.externals)) {
    for (const [cn] of entries(m.containers)) {
      const a = adaptersOf(x).filter((ad) => (of.get(ad) ?? []).includes(cn));
      if (a.length) body.push(rel(id("c_", cn), id("ext_", n), via(a), hosts(x)));
    }
  }
  return fence("C4Container", "Контейнеры", body);
}

/**
 * C3: модули по контейнерам, библиотека — вне их границ (её контейнеры видны по зависящим модулям), зависимости
 * `dependsOn`; хранилище — у модуля, чьи пакеты — его клиенты; внешняя система — у каждого модуля-адаптера.
 */
export function c4Component(m: Model): string[] {
  const component = (n: string, indent: string) => {
    const x = m.modules[n]!;
    const techn = [...paths(x), ...(x.library ? ["библиотека"] : [])].join(", ");
    return `${indent}Component(${id("m_", n)}, ${q(n)}, ${q(techn)}, ${q(x.purpose)})`;
  };
  const body: string[] = [];
  const placed = new Set<string>();
  for (const [cn, c] of entries(m.containers)) {
    const mods = (c.modules ?? []).filter((x) => m.modules[x] && !m.modules[x].library);
    if (!mods.length) continue;
    body.push(`  Container_Boundary(${id("c_", cn)}, ${q(cn)}) {`, ...mods.map((x) => component(x, "    ")), "  }");
    for (const x of mods) placed.add(x);
  }
  for (const n of Object.keys(m.modules)) if (!placed.has(n)) body.push(component(n, "  "));

  const storageRels: string[] = [];
  const storages = new Set<string>();
  for (const [n, x] of entries(m.modules)) {
    for (const [cn, c] of entries(m.containers)) {
      if (c.modules?.length) continue;
      const via = (c.clients ?? []).filter((p) => (x.packages ?? []).includes(p));
      if (!via.length) continue;
      storages.add(cn);
      storageRels.push(rel(id("m_", n), id("c_", cn), via.join(", ")));
    }
  }
  for (const [cn, c] of entries(m.containers)) if (storages.has(cn)) body.push(containerLine(cn, c, "  "));
  body.push(...externalLines(m));
  for (const [n, x] of entries(m.modules)) for (const d of x.dependsOn ?? []) body.push(rel(id("m_", n), id("m_", d), "зависит"));
  body.push(...storageRels);
  for (const [n, x] of entries(m.externals)) for (const a of adaptersOf(x)) body.push(rel(id("m_", a), id("ext_", n), "вызывает", hosts(x)));
  return fence("C4Component", "Модули", body);
}

/** Таблица модулей: назначение, каталог, публичный API, от каких модулей зависит, какие пакеты импортирует. */
export function modulesTable(m: Model): string[] {
  const cell = (s: string) => mdText(s).replace(/\|/g, "\\|");
  const code = (xs: string[]) => (xs.length ? xs.map((x) => "`" + x + "`").join(", ") : "—");
  return [
    "| Модуль | Назначение | Каталог | API | Зависит от | Пакеты |",
    "|---|---|---|---|---|---|",
    ...entries(m.modules).map(
      ([n, x]) =>
        `| ${cell(n)} | ${cell(x.purpose)} | ${code(paths(x))} | ${code(x.api ? [x.api] : [])} | ${(x.dependsOn ?? []).map(cell).join(", ") || "—"} | ${code(x.packages ?? [])} |`,
    ),
  ];
}

const INTRO =
  "Сгенерировано из модели `tests/architecture/model.ts` (скилл `spec`, `spec-doc`): схемы C4 и таблица модулей. Правка — в модели; с кодом её сверяют правила архитектуры.";

/** Страница архитектуры с заголовка уровня level; уровень без данных в модели (нет внешних систем, контейнеров) не рисуется. */
export function architecturePage(m: Model, level: number): string[] {
  const h = (l: number, t: string) => "#".repeat(Math.min(l, 6)) + " " + t;
  const out = [h(level, "Архитектура"), "", INTRO, ""];
  if (entries(m.externals).length) out.push(h(level + 1, "Система и внешние системы (C1)"), "", ...c4Context(m), "");
  if (entries(m.containers).length) out.push(h(level + 1, "Контейнеры (C2)"), "", ...c4Container(m), "");
  out.push(h(level + 1, "Модули (C3)"), "", ...c4Component(m), "", ...modulesTable(m), "");
  return out;
}

/** Строка оглавления: сколько в модели модулей, контейнеров и внешних систем. */
export function modelSummary(m: Model): string {
  const parts = [plural(Object.keys(m.modules).length, "модуль", "модуля", "модулей")];
  const nc = entries(m.containers).length;
  const ne = entries(m.externals).length;
  if (nc) parts.push(plural(nc, "контейнер", "контейнера", "контейнеров"));
  if (ne) parts.push(plural(ne, "внешняя система", "внешние системы", "внешних систем"));
  return "модель: " + parts.join(", ");
}

export const MARKS: Record<string, (m: Model) => string[]> = {
  "c4-context": c4Context,
  "c4-container": c4Container,
  "c4-component": c4Component,
  "c4-modules": modulesTable,
};

const MARK_LINE = /^[ \t]*<!--\s*spec:\s*([\w-]+)\s*-->[ \t]*$/gm;

/**
 * Метки `<!-- spec: <имя> -->` отдельной строкой → схема из модели. Метка без модели или неизвестная остаётся
 * (HTML-комментарий на странице не виден) и возвращается в `bad` — spec-doc её называет.
 */
export function embed(text: string, model: Model | null): { text: string; bad: { mark: string; missing: "model" | "mark" }[] } {
  const bad: { mark: string; missing: "model" | "mark" }[] = [];
  const out = text.replace(MARK_LINE, (line, name: string) => {
    // схема сценария — не из модели: её ставит spec-doc по трассе теста
    if (name.startsWith("sequence-")) return line;
    const render = Object.hasOwn(MARKS, name) ? MARKS[name] : undefined;
    if (!render) bad.push({ mark: name, missing: "mark" });
    else if (!model) bad.push({ mark: name, missing: "model" });
    else return render(model).join("\n");
    return line;
  });
  return { text: out, bad };
}
