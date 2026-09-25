#!/usr/bin/env bun
/**
 * github — проект GitHub репозитория по канону AGENTS.md (раздел «Проект (GitHub Projects)»).
 *
 * Подкоманды:
 *   github project check — сверка с каноном по пунктам ✅/❌
 *   github project fix   — довести до канона: API, шаги UI со ссылками, удаление и переименование — с --confirm
 *
 * Запуск — Bun (`bun github.ts …`), только `node:`-API + CLI `gh`. Проверка и исправление — одна функция
 * `analyze`: каждое расхождение несёт свой шаг исправления, поэтому `check` и `fix` не расходятся.
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ----------------------------------------------------------------------------
// Канон
// ----------------------------------------------------------------------------

export const VIEWS = [
  { name: "Доска", layout: "BOARD_LAYOUT" },
  { name: "Таблица", layout: "TABLE_LAYOUT" },
  { name: "Роадмэп", layout: "ROADMAP_LAYOUT" },
] as const;
export const STATUS = "Status";
export const STATUS_OPTIONS = ["Бэклог", "В работе", "Готово"] as const;
export const [BACKLOG, , DONE] = STATUS_OPTIONS;
export const NUMBER_FIELDS = ["Оценка, ч", "Факт, ч", "Токены, млн", "Стоимость, $"] as const;
export const PRIORITY = "Priority";
export const ISSUE_TYPES = ["Задача", "Баг", "Эпик"] as const;
export const WORKFLOW_ADDED = "Item added to project";
export const WORKFLOW_CLOSED = "Item closed";
export const WORKFLOW_AUTO_ADD = "Auto-add to project";
/** Эталон: новый проект — его копия (представления, поля, настроенные workflow, кроме auto-add). */
export const DEFAULT_TEMPLATE = "miroshnik/6";

// Варианты Status нового проекта и их канонические имена: переименование с тем же id сохраняет значения
// задач и цель workflow «Item closed» (замена вариантов целиком даёт новые id).
const STATUS_ALIASES: Record<string, string> = { todo: BACKLOG, backlog: BACKLOG, "to do": BACKLOG, "in progress": "В работе", doing: "В работе", done: DONE };
const TYPE_ALIASES: Record<string, string> = { task: "Задача", bug: "Баг", epic: "Эпик" };
// Встроенные поля проекта; свои — всё остальное (TEXT, NUMBER, DATE, SINGLE_SELECT, ITERATION…).
const BUILTIN_FIELDS = new Set(["TITLE", "ASSIGNEES", "LABELS", "LINKED_PULL_REQUESTS", "MILESTONE", "REPOSITORY", "REVIEWERS", "PARENT_ISSUE", "SUB_ISSUES_PROGRESS", "CREATED", "UPDATED", "CLOSED", "TRACKS", "TRACKED_BY", "ISSUE_TYPE"]);
const NOT_DONE_REASONS = new Set(["NOT_PLANNED", "DUPLICATE"]);

// ----------------------------------------------------------------------------
// Модель
// ----------------------------------------------------------------------------

export interface Io {
  /** `gh` с аргументами и stdin → stdout; ошибка — исключение. Внешний край: в тестах подменяется. */
  gh: (args: string[], stdin?: string) => string;
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
}

export interface ProjectRef {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
}
interface View {
  id: string;
  number: number;
  name: string;
  layout: string;
  filter: string | null;
  sortBy: string[];
  columnsBy: string[];
}
interface Option {
  id: string;
  name: string;
  color: string;
  description: string;
}
interface Field {
  id: string;
  name: string;
  dataType: string;
  isIssueField: boolean;
  options: Option[] | null;
}
interface Workflow {
  id: string;
  number: number;
  /** В адресе workflow в UI — он, а не number: `<проект>/workflows/<fullDatabaseId>`. */
  fullDatabaseId: string | number;
  name: string;
  enabled: boolean;
}
interface Item {
  id: string;
  issue: { id: string; number: number; state: string; stateReason: string | null } | null;
  status: string | null;
}
interface Project extends ProjectRef {
  views: View[];
  fields: Field[];
  workflows: Workflow[];
  items: Item[];
}
interface Owner {
  org: boolean;
  id: string;
  login: string;
  issueTypes: { id: string; name: string; isEnabled: boolean }[];
  issueFields: { id: string; name: string }[];
}
export interface State {
  repo: { id: string; name: string; nameWithOwner: string; owner: Owner; linked: ProjectRef[] };
  project: Project | null;
  openIssues: { id: string; number: number }[];
}

interface Mutation {
  op: string;
  input: Record<string, unknown>;
}
/**
 * Шаг исправления: `api` — делает fix; `confirm` — только с --confirm (удаление, переименование, организация);
 * `ui` — руками по ссылке. `sticky` — шаг UI остаётся в списке, даже когда fix уже убрал симптом.
 */
export interface Step {
  kind: "api" | "confirm" | "ui";
  text: string;
  mutations?: Mutation[];
  url?: string;
  sticky?: boolean;
}
export interface Check {
  key: string;
  title: string;
  problems: { text: string; steps: Step[] }[];
}

export class GhError extends Error {}

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const REF = "id number title url closed";
export const Q = {
  RepoState: `query RepoState($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id name nameWithOwner
    owner {
      __typename id login
      ... on Organization {
        issueTypes(first: 50) { nodes { id name isEnabled } }
        issueFields(first: 50) { nodes { __typename ... on IssueFieldSingleSelect { id name } } }
      }
    }
    projectsV2(first: 20) { nodes { ${REF} } }
  }
}`,
  RepoIssues: `query RepoIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id number } }
  }
}`,
  OwnerProjects: `query OwnerProjects($login: String!, $query: String!) {
  repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: 20, query: $query) { nodes { ${REF} } } } }
}`,
  TemplateProject: `query TemplateProject($login: String!, $number: Int!) {
  repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) { ${REF} } } }
}`,
  ProjectState: `query ProjectState($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      ${REF}
      views(first: 50) {
        nodes {
          id number name layout filter
          sortByFields(first: 5) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } }
          verticalGroupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name } } }
        }
      }
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2Field { isIssueField }
          ... on ProjectV2SingleSelectField { isIssueField options { id name color description } }
        }
      }
      workflows(first: 50) { nodes { id number fullDatabaseId name enabled } }
    }
  }
}`,
  ProjectItems: `query ProjectItems($id: ID!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content { __typename ... on Issue { id number state stateReason } }
          status: fieldValueByName(name: "${STATUS}") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`,
} as const;

// Мутации — с одним параметром $input: в input только заданные ключи (null в input GitHub понимает как «стереть»).
const M: Record<string, [field: string, inputType: string, select: string]> = {
  LinkProject: ["linkProjectV2ToRepository", "LinkProjectV2ToRepositoryInput", "repository { id }"],
  UnlinkProject: ["unlinkProjectV2FromRepository", "UnlinkProjectV2FromRepositoryInput", "repository { id }"],
  CopyProject: ["copyProjectV2", "CopyProjectV2Input", `projectV2 { ${REF} }`],
  CreateProject: ["createProjectV2", "CreateProjectV2Input", `projectV2 { ${REF} }`],
  RenameProject: ["updateProjectV2", "UpdateProjectV2Input", "projectV2 { id }"],
  CreateView: ["createProjectV2View", "CreateProjectV2ViewInput", "projectV2View { id }"],
  UpdateView: ["updateProjectV2View", "UpdateProjectV2ViewInput", "projectV2View { id }"],
  DeleteView: ["deleteProjectV2View", "DeleteProjectV2ViewInput", "clientMutationId"],
  CreateField: ["createProjectV2Field", "CreateProjectV2FieldInput", "clientMutationId"],
  UpdateField: ["updateProjectV2Field", "UpdateProjectV2FieldInput", "clientMutationId"],
  DeleteField: ["deleteProjectV2Field", "DeleteProjectV2FieldInput", "clientMutationId"],
  AddIssueField: ["createProjectV2IssueField", "CreateProjectV2IssueFieldInput", "clientMutationId"],
  SetItemStatus: ["updateProjectV2ItemFieldValue", "UpdateProjectV2ItemFieldValueInput", "projectV2Item { id }"],
  AddItem: ["addProjectV2ItemById", "AddProjectV2ItemByIdInput", "item { id }"],
  DeleteItem: ["deleteProjectV2Item", "DeleteProjectV2ItemInput", "deletedItemId"],
  CreateIssueType: ["createIssueType", "CreateIssueTypeInput", "issueType { id }"],
  UpdateIssueType: ["updateIssueType", "UpdateIssueTypeInput", "issueType { id }"],
};

function mutationQuery(op: string): string {
  const spec = M[op];
  if (!spec) throw new GhError(`неизвестная мутация ${op}`);
  const [field, inputType, select] = spec;
  return `mutation ${op}($input: ${inputType}!) { ${field}(input: $input) { ${select} } }`;
}

export function graphql(io: Io, query: string, variables: Record<string, unknown>): Any {
  const out = io.gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api graphql: ответ не JSON: ${out.slice(0, 200)}`);
  }
  const errors: string[] = (res.errors ?? []).map((e: Any) => e.message ?? String(e));
  if (errors.length && !res.data) throw new GhError(`GraphQL: ${errors.join("; ")}`);
  if (errors.length) io.err(`предупреждение GraphQL: ${errors.join("; ")}`);
  return res.data;
}

function mutate(io: Io, m: Mutation): Any {
  return graphql(io, mutationQuery(m.op), { input: m.input });
}

/** Реальный `gh`: код возврата ≠ 0 — исключение с stderr. */
export function realGh(args: string[], stdin?: string): string {
  const r = spawnSync("gh", args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new GhError("не найдена команда gh; нужен установленный gh CLI");
    throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.error.message}`);
  }
  // gh api graphql при ошибках GraphQL выходит с 1, но JSON с errors в stdout — пусть разберёт graphql()
  if (r.status !== 0 && !r.stdout.trim().startsWith("{")) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || "").trim().slice(0, 500)}`);
  return r.stdout;
}

// ----------------------------------------------------------------------------
// Чтение состояния
// ----------------------------------------------------------------------------

function pages<T>(fetch: (after: string | null) => { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }): T[] {
  const out: T[] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page = fetch(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}

const ref = (p: Any): ProjectRef => ({ id: p.id, number: p.number, title: p.title, url: p.url, closed: !!p.closed });

export function loadState(io: Io, slug: string): State {
  const [owner, name] = slug.split("/") as [string, string];
  const data = graphql(io, Q.RepoState, { owner, name });
  const r = data?.repository;
  if (!r) throw new GhError(`репозиторий ${slug} не найден или нет доступа`);
  const o = r.owner;
  const repo: State["repo"] = {
    id: r.id,
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    owner: {
      org: o.__typename === "Organization",
      id: o.id,
      login: o.login,
      issueTypes: (o.issueTypes?.nodes ?? []).filter(Boolean),
      issueFields: (o.issueFields?.nodes ?? []).filter((f: Any) => f && f.name),
    },
    linked: (r.projectsV2?.nodes ?? []).filter(Boolean).map(ref),
  };
  const openIssues = pages<{ id: string; number: number }>((after) => graphql(io, Q.RepoIssues, { owner, name, after }).repository.issues);
  const main = repo.linked.find((p) => p.title === repo.name && !p.closed) ?? repo.linked.find((p) => !p.closed) ?? null;
  return { repo, project: main ? loadProject(io, main.id) : null, openIssues };
}

function loadProject(io: Io, id: string): Project {
  const p = graphql(io, Q.ProjectState, { id }).node;
  if (!p) throw new GhError(`проект ${id} не найден или нет доступа (нужен scope project: gh auth refresh -s project)`);
  const items = pages<Any>((after) => graphql(io, Q.ProjectItems, { id, after }).node.items);
  return {
    ...ref(p),
    views: p.views.nodes.map((v: Any) => ({
      id: v.id,
      number: v.number,
      name: v.name,
      layout: v.layout,
      filter: v.filter ?? null,
      sortBy: (v.sortByFields?.nodes ?? []).map((s: Any) => s.field?.name).filter(Boolean),
      columnsBy: (v.verticalGroupByFields?.nodes ?? []).map((f: Any) => f?.name).filter(Boolean),
    })),
    fields: p.fields.nodes
      .filter((f: Any) => f && f.id)
      .map((f: Any) => ({ id: f.id, name: f.name, dataType: f.dataType, isIssueField: !!f.isIssueField, options: f.options ?? null })),
    workflows: p.workflows.nodes.filter(Boolean),
    items: items.map((it: Any) => ({
      id: it.id,
      issue: it.content?.__typename === "Issue" ? { id: it.content.id, number: it.content.number, state: it.content.state, stateReason: it.content.stateReason ?? null } : null,
      status: it.status?.name ?? null,
    })),
  };
}

// ----------------------------------------------------------------------------
// Сверка с каноном
// ----------------------------------------------------------------------------

const nums = (xs: { number: number }[]) => xs.map((x) => `#${x.number}`).join(", ");
const q = (s: string) => `«${s}»`;

/** Все расхождения с каноном по пунктам; у каждого — шаги исправления. Проекта нет — только пункт привязки. */
export function analyze(s: State): Check[] {
  const p = s.project;
  const checks: Check[] = [];
  const add = (key: string, title: string) => {
    const c: Check = { key, title, problems: [] };
    checks.push(c);
    return (text: string, ...steps: Step[]) => c.problems.push({ text, steps });
  };

  const link = add("link", `Проект привязан к репозиторию и называется ${q(s.repo.name)}`);
  if (!p) {
    link("к репозиторию не привязан ни один открытый проект", { kind: "api", text: `найти, скопировать с эталона или создать проект ${q(s.repo.name)} и привязать к ${s.repo.nameWithOwner}` });
    return checks;
  }
  const used = p.items.length > 0;
  const guarded = (text: string, ...mutations: Mutation[]): Step => ({ kind: used ? "confirm" : "api", text, mutations });
  const api = (text: string, ...mutations: Mutation[]): Step => ({ kind: "api", text, mutations });
  const ui = (text: string, url: string): Step => ({ kind: "ui", text, url });

  if (p.title !== s.repo.name) link(`название ${q(p.title)}`, guarded(`переименовать проект ${q(p.title)} → ${q(s.repo.name)}`, { op: "RenameProject", input: { projectId: p.id, title: s.repo.name } }));
  for (const other of s.repo.linked.filter((x) => x.id !== p.id)) {
    link(`привязан ещё проект ${q(other.title)} (${other.url})`, { kind: "confirm", text: `отвязать от репозитория проект ${q(other.title)}`, mutations: [{ op: "UnlinkProject", input: { projectId: other.id, repositoryId: s.repo.id } }] });
  }

  // Представления: по имени; нет — переименовать лишнее того же вида или создать; лишние — удалить.
  const views = add("views", `Представления ${VIEWS.map((v) => q(v.name)).join(", ")} — нужного вида, без фильтра, других нет`);
  const canonNames = new Set<string>(VIEWS.map((v) => v.name));
  const spare = p.views.filter((v) => !canonNames.has(v.name));
  for (const c of VIEWS) {
    const v = p.views.find((x) => x.name === c.name);
    if (!v) {
      const cand = spare.find((x) => x.layout === c.layout);
      if (cand) {
        spare.splice(spare.indexOf(cand), 1);
        views(`нет ${q(c.name)}`, guarded(`переименовать представление ${q(cand.name)} → ${q(c.name)}`, { op: "UpdateView", input: { viewId: cand.id, name: c.name } }));
      } else {
        views(`нет ${q(c.name)}`, api(`создать представление ${q(c.name)} (${c.layout})`, { op: "CreateView", input: { projectId: p.id, name: c.name, layout: c.layout } }));
      }
      continue;
    }
    if (v.layout !== c.layout) views(`${q(c.name)} — ${v.layout}`, api(`${q(c.name)}: вид ${c.layout}`, { op: "UpdateView", input: { viewId: v.id, layout: c.layout } }));
    if (v.filter) views(`у ${q(c.name)} фильтр ${q(v.filter)}`, api(`${q(c.name)}: снять фильтр ${q(v.filter)}`, { op: "UpdateView", input: { viewId: v.id, filter: "" } }));
    if (c.layout === "BOARD_LAYOUT" && v.layout === c.layout && v.columnsBy[0] !== STATUS) {
      views(`колонки ${q(c.name)} не по Status`, ui(`${q(c.name)}: View options → Column by → Status → Save`, `${p.url}/views/${v.number}`));
    }
  }
  for (const v of spare) views(`лишнее ${q(v.name)}`, guarded(`удалить представление ${q(v.name)}`, { op: "DeleteView", input: { viewId: v.id } }));

  // Status: варианты по имени или по известному английскому имени — с тем же id; недостающие — новые.
  const status = add("status", `${STATUS}: ${STATUS_OPTIONS.join(" → ")}`);
  const sf = p.fields.find((f) => f.name === STATUS && f.options);
  if (!sf) {
    status(`нет поля ${STATUS}`, api(`создать поле ${STATUS}`, { op: "CreateField", input: { projectId: p.id, dataType: "SINGLE_SELECT", name: STATUS, singleSelectOptions: STATUS_OPTIONS.map((name) => ({ name, color: "GRAY", description: "" })) } }));
  } else if (sf.options!.map((o) => o.name).join("\n") !== STATUS_OPTIONS.join("\n")) {
    const left = [...sf.options!];
    const take = (pred: (o: Option) => boolean) => {
      const i = left.findIndex(pred);
      return i < 0 ? null : left.splice(i, 1)[0]!;
    };
    const next = STATUS_OPTIONS.map((name) => {
      const o = take((x) => x.name === name) ?? take((x) => STATUS_ALIASES[x.name.toLowerCase()] === name);
      return o ? { id: o.id, name, color: o.color, description: o.description ?? "" } : { name, color: "GRAY", description: "" };
    });
    const drop = left.length ? `; удалить ${left.map((o) => q(o.name)).join(", ")}` : "";
    status(`варианты: ${sf.options!.map((o) => o.name).join(", ") || "нет"}`, guarded(`${STATUS}: ${STATUS_OPTIONS.join(", ")} (существующие переименовать с тем же id${drop})`, { op: "UpdateField", input: { fieldId: sf.id, singleSelectOptions: next } }));
  }

  // Поля: четыре числовых; своих полей сверх канона нет; в организации Priority — поле issue.
  const fields = add("fields", `Поля ${NUMBER_FIELDS.map(q).join(", ")} (Number), других своих нет`);
  for (const name of NUMBER_FIELDS) {
    const f = p.fields.find((x) => x.name === name);
    const create: Mutation = { op: "CreateField", input: { projectId: p.id, dataType: "NUMBER", name } };
    if (!f) fields(`нет ${q(name)}`, api(`создать поле ${q(name)} (Number)`, create));
    else if (f.dataType !== "NUMBER") fields(`${q(name)} — ${f.dataType}`, { kind: "confirm", text: `пересоздать поле ${q(name)} как Number (значения поля пропадут)`, mutations: [{ op: "DeleteField", input: { fieldId: f.id } }, create] });
  }
  const orgPriority = s.repo.owner.org ? s.repo.owner.issueFields.find((f) => f.name === PRIORITY) : undefined;
  const isCanon = (f: Field) => BUILTIN_FIELDS.has(f.dataType) || f.name === STATUS || (NUMBER_FIELDS as readonly string[]).includes(f.name) || (s.repo.owner.org && f.isIssueField && f.name === PRIORITY);
  const ownPriority = p.fields.find((f) => f.name === PRIORITY && !f.isIssueField);
  for (const f of p.fields.filter((x) => !isCanon(x) && x !== ownPriority)) {
    fields(`лишнее ${q(f.name)} (${f.dataType}${f.isIssueField ? ", поле issue" : ""})`, guarded(`удалить поле ${q(f.name)}`, { op: "DeleteField", input: { fieldId: f.id } }));
  }
  if (ownPriority && !s.repo.owner.org) fields(`лишнее ${q(PRIORITY)} — в личном аккаунте приоритет не ведём`, guarded(`удалить поле ${q(PRIORITY)}`, { op: "DeleteField", input: { fieldId: ownPriority.id } }));

  if (s.repo.owner.org) {
    const org = s.repo.owner.login;
    const prio = add("priority", `${PRIORITY} — поле issue организации в проекте, ${q("Таблица")} и ${q("Доска")} сортируются по нему`);
    const connected = p.fields.some((f) => f.isIssueField && f.name === PRIORITY);
    if (!connected) {
      const connect: Mutation[] = orgPriority ? [{ op: "AddIssueField", input: { projectId: p.id, issueFieldId: orgPriority.id } }] : [];
      if (ownPriority) {
        prio(`своё поле проекта ${q(PRIORITY)} вместо поля issue`, { kind: "confirm", text: `удалить своё поле ${q(PRIORITY)} и подключить поле issue ${PRIORITY}`, mutations: [{ op: "DeleteField", input: { fieldId: ownPriority.id } }, ...connect] });
      } else if (orgPriority) {
        prio(`поле issue ${PRIORITY} не подключено`, api(`подключить поле issue ${PRIORITY}`, ...connect));
      }
      if (!orgPriority) prio(`в организации нет поля issue ${PRIORITY}`, ui(`создать поле issue ${PRIORITY} (single select: Urgent, High, Medium, Low), затем снова fix`, `https://github.com/organizations/${org}/settings/issue-fields`));
    }
    for (const name of ["Таблица", "Доска"]) {
      const v = p.views.find((x) => x.name === name);
      if (v && v.sortBy[0] !== PRIORITY) prio(`${q(name)} не сортируется по ${PRIORITY}`, ui(`${q(name)}: View options → Sort by → ${PRIORITY} → Save`, `${p.url}/views/${v.number}`));
    }

    const types = add("types", `Типы issue организации: ${ISSUE_TYPES.join(", ")} — и только они`);
    const t = s.repo.owner.issueTypes;
    const url = `https://github.com/organizations/${org}/settings/issue-types`;
    const claimed = new Set<string>();
    for (const name of ISSUE_TYPES) {
      const exact = t.find((x) => x.name === name);
      if (exact) {
        claimed.add(exact.id);
        if (!exact.isEnabled) types(`${q(name)} выключен`, { kind: "confirm", text: `включить тип ${q(name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: exact.id, isEnabled: true } }] });
        continue;
      }
      const alias = t.find((x) => !claimed.has(x.id) && TYPE_ALIASES[x.name.toLowerCase()] === name);
      if (alias) {
        claimed.add(alias.id);
        types(`нет ${q(name)}`, { kind: "confirm", text: `переименовать тип ${q(alias.name)} → ${q(name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: alias.id, name, isEnabled: true } }] });
      } else {
        types(`нет ${q(name)}`, { kind: "confirm", text: `создать тип ${q(name)}`, url, mutations: [{ op: "CreateIssueType", input: { ownerId: s.repo.owner.id, name, isEnabled: true, color: name === "Эпик" ? "PURPLE" : name === "Баг" ? "RED" : "GRAY" } }] });
      }
    }
    for (const x of t.filter((x) => x.isEnabled && !claimed.has(x.id))) {
      types(`лишний ${q(x.name)}`, { kind: "confirm", text: `выключить тип ${q(x.name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: x.id, isEnabled: false } }] });
    }
  }

  // Workflow: API их не включает и не показывает цель — только UI. Ненастроенного нет в списке.
  const wf = add("workflows", `Workflow ${[WORKFLOW_ADDED, WORKFLOW_CLOSED, WORKFLOW_AUTO_ADD].map(q).join(", ")} включены`);
  const how: Record<string, string> = {
    [WORKFLOW_ADDED]: `Edit → Set value → ${STATUS}: ${BACKLOG}`,
    [WORKFLOW_CLOSED]: `Edit → Set value → ${STATUS}: ${DONE}`,
    // is:open — иначе обновлённая закрытая задача (и not planned) вернётся в проект
    [WORKFLOW_AUTO_ADD]: `Edit → репозиторий ${s.repo.name}, фильтр is:issue is:open (Enter)`,
  };
  for (const name of [WORKFLOW_ADDED, WORKFLOW_CLOSED, WORKFLOW_AUTO_ADD]) {
    const w = p.workflows.find((x) => x.name === name);
    if (w?.enabled) continue;
    // ненастроенного workflow нет в API — ссылка на список, он там в меню слева
    wf(`${q(name)} ${w ? "выключен" : "не настроен"}`, ui(`${q(name)}: ${how[name]} → Save and turn on workflow`, `${p.url}/workflows${w ? `/${w.fullDatabaseId}` : ""}`));
  }

  // Задачи: статусы по канону. Закрытые не в «Готово» — симптом «Item closed» на удалённом варианте Status.
  const opt = (name: string) => sf?.options?.find((o) => o.name === name)?.id;
  const setStatus = (it: Item, name: string): Mutation => ({ op: "SetItemStatus", input: { projectId: p.id, itemId: it.id, fieldId: sf!.id, value: { singleSelectOptionId: opt(name) } } });
  const statusReady = !!(opt(BACKLOG) && opt(DONE));
  const closedAdd = add("closed", `Закрытые задачи — в ${q(DONE)}, закрытые без выполнения — вне проекта`);
  const issues = p.items.filter((it) => it.issue);
  const notDone = issues.filter((it) => it.issue!.state === "CLOSED" && !NOT_DONE_REASONS.has(it.issue!.stateReason ?? "") && it.status !== DONE);
  if (notDone.length) {
    const steps: Step[] = [];
    if (statusReady) steps.push(api(`${STATUS} ${q(DONE)}: ${nums(notDone.map((it) => it.issue!))}`, ...notDone.map((it) => setStatus(it, DONE))));
    const closed = p.workflows.find((x) => x.name === WORKFLOW_CLOSED);
    // статусы fix поставит сам, а цель workflow из API не видна — проверить её в UI, даже когда симптом снят
    if (closed?.enabled) steps.push({ ...ui(`${q(WORKFLOW_CLOSED)}: проверить Set value → ${STATUS}: ${DONE}, иначе Edit → ${DONE} → Save`, `${p.url}/workflows/${closed.fullDatabaseId}`), sticky: true });
    closedAdd(`не в ${q(DONE)}: ${nums(notDone.map((it) => it.issue!))}`, ...steps);
  }
  const dropped = issues.filter((it) => it.issue!.state === "CLOSED" && NOT_DONE_REASONS.has(it.issue!.stateReason ?? ""));
  if (dropped.length) closedAdd(`закрыты без выполнения, но в проекте: ${nums(dropped.map((it) => it.issue!))}`, api(`убрать из проекта ${nums(dropped.map((it) => it.issue!))}`, ...dropped.map((it) => ({ op: "DeleteItem", input: { projectId: p.id, itemId: it.id } }))));

  const open = add("open", `Открытые задачи репозитория — в проекте, со ${STATUS}`);
  const inProject = new Set(issues.map((it) => it.issue!.id));
  const missing = s.openIssues.filter((i) => !inProject.has(i.id));
  if (missing.length) open(`не в проекте: ${nums(missing)}`, api(`добавить в проект ${nums(missing)}`, ...missing.map((i) => ({ op: "AddItem", input: { projectId: p.id, contentId: i.id } }))));
  const noStatus = issues.filter((it) => it.issue!.state === "OPEN" && !it.status);
  if (noStatus.length) open(`без ${STATUS}: ${nums(noStatus.map((it) => it.issue!))}`, ...(statusReady ? [api(`${STATUS} ${q(BACKLOG)}: ${nums(noStatus.map((it) => it.issue!))}`, ...noStatus.map((it) => setStatus(it, BACKLOG)))] : []));

  return checks;
}

// ----------------------------------------------------------------------------
// Команды
// ----------------------------------------------------------------------------

function header(io: Io, s: State): void {
  io.out(`Проект ${s.repo.nameWithOwner}: ${s.project ? s.project.url : "нет"}`);
}

function report(io: Io, s: State, checks: Check[]): boolean {
  for (const c of checks) {
    io.out(`${c.problems.length ? "❌" : "✅"} ${c.title}`);
    for (const pr of c.problems) io.out(`   · ${pr.text}`);
  }
  if (s.project && !s.repo.owner.org) io.out(`➖ ${PRIORITY} и типы issue — в личном аккаунте их нет`);
  return checks.every((c) => !c.problems.length);
}

export function cmdCheck(io: Io, slug: string): number {
  const s = loadState(io, slug);
  header(io, s);
  return report(io, s, analyze(s)) ? 0 : 1;
}

/** Проекта нет: привязать одноимённый проект владельца, иначе скопировать эталон, иначе создать. */
function ensureProject(io: Io, s: State, template: string | null): string {
  const found = graphql(io, Q.OwnerProjects, { login: s.repo.owner.login, query: s.repo.name })?.repositoryOwner?.projectsV2?.nodes ?? [];
  const same = found.find((p: Any) => p && p.title === s.repo.name && !p.closed);
  const link = (p: ProjectRef) => mutate(io, { op: "LinkProject", input: { projectId: p.id, repositoryId: s.repo.id } });
  if (same) {
    link(same);
    return `привязан проект ${q(same.title)} (${same.url})`;
  }
  if (template) {
    const [login, number] = template.split("/");
    let tpl: Any = null;
    try {
      tpl = graphql(io, Q.TemplateProject, { login, number: Number(number) })?.repositoryOwner?.projectV2 ?? null;
    } catch (e) {
      io.err(`эталон ${template} недоступен: ${(e as Error).message}`);
    }
    if (tpl) {
      const copy = mutate(io, { op: "CopyProject", input: { projectId: tpl.id, ownerId: s.repo.owner.id, title: s.repo.name, includeDraftIssues: false } }).copyProjectV2.projectV2;
      link(copy);
      return `проект ${q(s.repo.name)} — копия эталона ${template} (${copy.url}), привязан`;
    }
    io.err(`эталон ${template} не найден — проект создаётся с нуля`);
  }
  const created = mutate(io, { op: "CreateProject", input: { ownerId: s.repo.owner.id, title: s.repo.name, repositoryId: s.repo.id } }).createProjectV2.projectV2;
  return `создан проект ${q(s.repo.name)} (${created.url}), привязан`;
}

export function cmdFix(io: Io, slug: string, opts: { confirm: boolean; template: string | null }): number {
  const done: string[] = [];
  const failed: string[] = [];
  const tried = new Set<string>();
  const sticky: Step[] = [];
  let s = loadState(io, slug);
  // Раунды: шаг может открыть следующий (новое поле Status → статусы задач); повторно шаг не делается.
  for (let round = 0; round < 5; round++) {
    if (!s.project) {
      try {
        done.push(ensureProject(io, s, opts.template));
      } catch (e) {
        failed.push(`проект: ${(e as Error).message}`);
        break;
      }
      s = loadState(io, slug);
      if (!s.project) break;
      continue;
    }
    const all = analyze(s).flatMap((c) => c.problems.flatMap((pr) => pr.steps));
    sticky.push(...all.filter((st) => st.sticky));
    const steps = all
      .filter((st) => st.mutations?.length && (st.kind === "api" || (st.kind === "confirm" && opts.confirm)) && !tried.has(st.text));
    if (!steps.length) break;
    for (const st of steps) {
      tried.add(st.text);
      try {
        for (const m of st.mutations!) mutate(io, m);
        done.push(st.text);
      } catch (e) {
        failed.push(`${st.text}: ${(e as Error).message}${st.url ? ` — в UI: ${st.url}` : ""}`);
      }
    }
    s = loadState(io, slug);
  }

  header(io, s);
  for (const d of done) io.out(`+ ${d}`);
  for (const f of failed) io.out(`! ${f}`);
  const checks = analyze(s);
  const left = [...sticky, ...checks.flatMap((c) => c.problems.flatMap((pr) => pr.steps))];
  const uniq = (xs: Step[]) => xs.filter((x, i) => xs.findIndex((y) => y.text === x.text) === i);
  const ui = uniq(left.filter((st) => st.kind === "ui"));
  const confirm = uniq(left.filter((st) => st.kind === "confirm" && !opts.confirm));
  if (ui.length) {
    io.out("Шаги в UI — браузером сессии, без браузера — пользователю; затем снова check:");
    ui.forEach((st, i) => io.out(`${i + 1}. ${st.text} — ${st.url}`));
  }
  if (confirm.length) {
    io.out("Нужно подтверждение пользователя — затем fix --confirm:");
    confirm.forEach((st, i) => io.out(`${i + 1}. ${st.text}${st.url ? ` (или в UI: ${st.url})` : ""}`));
  }
  io.out("Итог:");
  const ok = report(io, s, checks);
  return ok && !failed.length && !ui.length && !confirm.length ? 0 : 1;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `github — проект GitHub репозитория по канону AGENTS.md

  github project check [--repo owner/repo]
  github project fix   [--repo owner/repo] [--confirm] [--template owner/N | none]

check — пункты ✅/❌, код 0 — всё по канону, 1 — есть ❌.
fix   — исправляет через API; шаги UI печатает со ссылками; удаление и переименование в проекте
        с задачами и настройки организации — только с --confirm (после «да» пользователя).
        Проекта нет — привязывает одноимённый, иначе копирует эталон (${DEFAULT_TEMPLATE}), иначе создаёт.`;

function detectRepo(): string {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((r.stdout ?? "").trim());
  if (r.status !== 0 || !m) throw new GhError("не удалось определить репозиторий из git remote origin; укажите --repo owner/repo");
  return `${m[1]}/${m[2]}`;
}

export function main(argv: string[], io: Io): number {
  try {
    const [group, cmd, ...rest] = argv;
    if (!group || group === "-h" || group === "--help") {
      io.out(USAGE);
      return group ? 0 : 2;
    }
    if (group !== "project" || (cmd !== "check" && cmd !== "fix")) {
      io.err(`неизвестная команда «${argv.slice(0, 2).join(" ")}»; ожидается project check или project fix`);
      return 2;
    }
    if (io.env.CLAUDE_CODE_REMOTE === "true") {
      io.err("облачная сессия: GitHub Projects ей недоступны (Projects v2 — 403, docs/cloud-sessions.md) — проект проверяет и чинит локальная сессия");
      return 2;
    }
    const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, confirm: { type: "boolean", default: false }, template: { type: "string", default: DEFAULT_TEMPLATE } } });
    const slug = values.repo ?? detectRepo();
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new GhError(`неверный --repo «${slug}», ожидается owner/repo`);
    const template = values.template === "none" ? null : values.template!;
    if (template && !/^[\w.-]+\/\d+$/.test(template)) throw new GhError(`неверный --template «${template}», ожидается owner/N или none`);
    return cmd === "check" ? cmdCheck(io, slug) : cmdFix(io, slug, { confirm: values.confirm!, template });
  } catch (e) {
    if (e instanceof GhError || (e as Any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      io.err(`ошибка: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), { gh: realGh, out: (l) => console.log(l), err: (l) => console.error(l), env: process.env });
}
