#!/usr/bin/env bun
/**
 * github — проект и задачи GitHub репозитория по канону AGENTS.md (раздел «Ведение задач»).
 *
 * Подкоманды:
 *   github project check — сверка с каноном по пунктам ✅/❌
 *   github project fix   — довести до канона: API, шаги UI со ссылками, удаление и переименование — с --confirm
 *   github task new      — задача одной командой: тип или метка, проект и Бэклог, Priority, эпик, blocked by, milestone
 *   github task status   — Status в проекте (и эпик — «В работе», когда взята первая подзадача)
 *   github task drop     — закрыть без выполнения и убрать из проекта
 *
 * Запуск — Bun (`bun github.ts …`), только `node:`-API + CLI `gh`. Проверка и исправление — одна функция
 * `analyze`: каждое расхождение несёт свой шаг исправления, поэтому `check` и `fix` не расходятся.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
export const [BACKLOG, IN_PROGRESS, DONE] = STATUS_OPTIONS;
export const NUMBER_FIELDS = ["Оценка, ч", "Факт, ч", "Токены, млн", "Стоимость, $"] as const;
export const PRIORITY = "Priority";
/** Варианты Priority от самого срочного; новой задаче — Medium, эпику — не ниже самой срочной подзадачи. */
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"] as const;
export const DEFAULT_PRIORITY = "Medium";
/** В личном аккаунте типов issue нет — эпик помечается меткой, это единственное исключение. */
export const EPIC_LABEL = { name: "epic", color: "8250DF", description: "Эпик: большая задача с подзадачами" };
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
  /** Пауза перед перечитыванием (GitHub показывает добавленное не сразу); в тестах — без ожидания. */
  sleep?: (ms: number) => void;
}

const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
  issueFields: { id: string; name: string; options: { id: string; name: string }[] }[];
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
        issueFields(first: 50) { nodes { __typename ... on IssueFieldSingleSelect { id name options { id name } } } }
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
  IssueRef: `query IssueRef($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title state stateReason url
      issueType { name }
      labels(first: 20) { nodes { name } }
      parent { id number }
      subIssues(first: 100) { nodes { number state } }
      projectItems(first: 20) { nodes { id project { id } status: fieldValueByName(name: "${STATUS}") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
      issueFieldValues(first: 20) { nodes { __typename ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } } } }
    }
  }
}`,
  TaskContext: `query TaskContext($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    label(name: "${EPIC_LABEL.name}") { id }
    milestones(first: 100, states: OPEN) { nodes { id title } }
  }
}`,
  IssueSearch: `query IssueSearch($q: String!) {
  search(query: $q, type: ISSUE, first: 20) { nodes { ... on Issue { number title state } } }
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
  CreateIssue: ["createIssue", "CreateIssueInput", "issue { id number title url projectItems(first: 10) { nodes { id project { id } } } }"],
  CreateLabel: ["createLabel", "CreateLabelInput", "label { id }"],
  AddBlockedBy: ["addBlockedBy", "AddBlockedByInput", "issue { id }"],
  SetIssueField: ["setIssueFieldValue", "SetIssueFieldValueInput", "issue { id }"],
  CloseIssue: ["closeIssue", "CloseIssueInput", "issue { id state }"],
};

function mutationQuery(op: string): string {
  const spec = M[op];
  if (!spec) throw new GhError(`неизвестная мутация ${op}`);
  const [field, inputType, select] = spec;
  return `mutation ${op}($input: ${inputType}!) { ${field}(input: $input) { ${select} } }`;
}

/** Запрос GraphQL; частичные данные с ошибками — предупреждение, а у мутации (strict) — ошибка: её результат не получен. */
export function graphql(io: Io, query: string, variables: Record<string, unknown>, strict = false): Any {
  const out = io.gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api graphql: ответ не JSON: ${out.slice(0, 200)}`);
  }
  const errors: string[] = (res.errors ?? []).map((e: Any) => e.message ?? String(e));
  if (errors.length && (!res.data || strict)) throw new GhError(`GraphQL: ${errors.join("; ")}`);
  if (errors.length) io.err(`предупреждение GraphQL: ${errors.join("; ")}`);
  return res.data;
}

function mutate(io: Io, m: Mutation): Any {
  return graphql(io, mutationQuery(m.op), { input: m.input }, true);
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

function loadRepo(io: Io, slug: string): State["repo"] {
  const [owner, name] = slug.split("/") as [string, string];
  const data = graphql(io, Q.RepoState, { owner, name });
  const r = data?.repository;
  if (!r) throw new GhError(`репозиторий ${slug} не найден или нет доступа`);
  const o = r.owner;
  return {
    id: r.id,
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    owner: {
      org: o.__typename === "Organization",
      id: o.id,
      login: o.login,
      issueTypes: (o.issueTypes?.nodes ?? []).filter(Boolean),
      issueFields: (o.issueFields?.nodes ?? []).filter((f: Any) => f && f.name).map((f: Any) => ({ id: f.id, name: f.name, options: f.options ?? [] })),
    },
    linked: (r.projectsV2?.nodes ?? []).filter(Boolean).map(ref),
  };
}

/** Проект репозитория: привязанный с названием = имя репозитория, иначе первый открытый привязанный. */
const mainProject = (repo: State["repo"]) => repo.linked.find((p) => p.title === repo.name && !p.closed) ?? repo.linked.find((p) => !p.closed) ?? null;

export function loadState(io: Io, slug: string): State {
  const [owner, name] = slug.split("/") as [string, string];
  const repo = loadRepo(io, slug);
  const openIssues = pages<{ id: string; number: number }>((after) => graphql(io, Q.RepoIssues, { owner, name, after }).repository.issues);
  const main = mainProject(repo);
  return { repo, project: main ? loadProject(io, main.id) : null, openIssues };
}

function loadProject(io: Io, id: string, withItems = true): Project {
  const p = graphql(io, Q.ProjectState, { id }).node;
  if (!p) throw new GhError(`проект ${id} не найден или нет доступа (нужен scope project: gh auth refresh -s project)`);
  const items = withItems ? pages<Any>((after) => graphql(io, Q.ProjectItems, { id, after }).node.items) : [];
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
// Задачи
// ----------------------------------------------------------------------------

interface Issue {
  id: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  url: string;
  type: string | null;
  labels: string[];
  parent: { id: string; number: number } | null;
  subIssues: { number: number; state: string }[];
  items: { id: string; projectId: string; status: string | null }[];
  priority: string | null;
}

function loadIssue(io: Io, slug: string, number: number): Issue {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueRef, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`задачи #${number} в ${slug} нет`);
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    stateReason: i.stateReason ?? null,
    url: i.url,
    type: i.issueType?.name ?? null,
    labels: (i.labels?.nodes ?? []).map((l: Any) => l.name),
    parent: i.parent ? { id: i.parent.id, number: i.parent.number } : null,
    subIssues: i.subIssues?.nodes ?? [],
    items: (i.projectItems?.nodes ?? []).map((it: Any) => ({ id: it.id, projectId: it.project.id, status: it.status?.name ?? null })),
    priority: (i.issueFieldValues?.nodes ?? []).find((v: Any) => v?.field?.name === PRIORITY)?.name ?? null,
  };
}

interface TaskCtx {
  slug: string;
  repo: State["repo"];
  project: Project;
  status: Field;
}

/** Репозиторий и его проект со Status по канону: без них задачу по канону не завести — сначала project fix. */
function taskContext(io: Io, slug: string): TaskCtx {
  const repo = loadRepo(io, slug);
  const main = mainProject(repo);
  if (!main) throw new GhError(`к ${slug} не привязан проект — сначала github project fix`);
  const project = loadProject(io, main.id, false);
  const status = project.fields.find((f) => f.name === STATUS && f.options);
  if (!status || STATUS_OPTIONS.some((n) => !status.options!.some((o) => o.name === n))) throw new GhError(`${STATUS} проекта не по канону — сначала github project fix`);
  return { slug, repo, project, status };
}

const isEpic = (i: Issue, org: boolean) => (org ? i.type === "Эпик" : i.labels.includes(EPIC_LABEL.name));
const itemIn = (ctx: TaskCtx, i: Pick<Issue, "items">) => i.items.find((it) => it.projectId === ctx.project.id) ?? null;

function setStatus(io: Io, ctx: TaskCtx, itemId: string, name: string): void {
  const optionId = ctx.status.options!.find((o) => o.name === name)!.id;
  mutate(io, { op: "SetItemStatus", input: { projectId: ctx.project.id, itemId, fieldId: ctx.status.id, value: { singleSelectOptionId: optionId } } });
}

/**
 * Элемент задачи в проекте; нет — добавить. Проект мог уже добавить задачу сам (projectV2Ids в createIssue, auto-add),
 * а чтение ещё не показывает: addProjectV2ItemById тогда отвечает «Content already exists» — перечитываем с паузой.
 */
function ensureItem(io: Io, ctx: TaskCtx, i: Pick<Issue, "id" | "number" | "items">): { id: string; added: boolean } {
  const it = itemIn(ctx, i);
  if (it) return { id: it.id, added: false };
  try {
    return { id: mutate(io, { op: "AddItem", input: { projectId: ctx.project.id, contentId: i.id } }).addProjectV2ItemById.item.id, added: true };
  } catch (e) {
    if (!/already exists/i.test((e as Error).message)) throw e;
  }
  for (let k = 0; k < 5; k++) {
    (io.sleep ?? pause)(1000);
    const again = itemIn(ctx, loadIssue(io, ctx.slug, i.number));
    if (again) return { id: again.id, added: false };
  }
  throw new GhError(`#${i.number} уже в проекте, но элемент не виден — повторить: github task status ${i.number} <статус>`);
}

/** Префикс эпика — часть заголовка до « · »: с него начинаются заголовки эпика и всех подзадач. */
export function epicPrefix(title: string): string | null {
  const i = title.indexOf(" · ");
  return i > 0 ? title.slice(0, i) : null;
}

export interface NewTask {
  title: string;
  body: string;
  type: string;
  epic?: number;
  milestone?: string;
  blockedBy: number[];
  priority?: string;
}

export function cmdTaskNew(io: Io, slug: string, o: NewTask): number {
  const [owner, name] = slug.split("/");
  const ctx = taskContext(io, slug);
  const org = ctx.repo.owner.org;

  // Всё проверяется до создания: задача не должна появиться наполовину.
  if (!(ISSUE_TYPES as readonly string[]).includes(o.type)) throw new GhError(`--type: ${ISSUE_TYPES.join(", ")}`);
  const issueType = org ? ctx.repo.owner.issueTypes.find((t) => t.name === o.type && t.isEnabled) : undefined;
  if (org && !issueType) throw new GhError(`в организации нет включённого типа ${q(o.type)} — github project fix`);
  if (!org && o.priority) throw new GhError("в личном аккаунте полей issue нет — приоритет не ведём, --priority не нужен");
  let priority: { fieldId: string; optionId: string; name: string } | null = null;
  if (org) {
    const f = ctx.repo.owner.issueFields.find((x) => x.name === PRIORITY);
    if (!f) throw new GhError(`в организации нет поля issue ${PRIORITY} — github project fix`);
    const want = o.priority ?? DEFAULT_PRIORITY;
    const opt = f.options.find((x) => x.name === want);
    if (!opt) throw new GhError(`--priority: ${f.options.map((x) => x.name).join(", ")}`);
    priority = { fieldId: f.id, optionId: opt.id, name: want };
  }
  let title = o.title.trim();
  const epic = o.epic === undefined ? null : loadIssue(io, slug, o.epic);
  if (epic) {
    if (!isEpic(epic, org)) throw new GhError(`#${epic.number} — не эпик (${org ? "тип не «Эпик»" : `нет метки ${EPIC_LABEL.name}`})`);
    if (epic.state !== "OPEN") throw new GhError(`эпик #${epic.number} закрыт`);
    const prefix = epicPrefix(epic.title);
    if (prefix && !title.startsWith(`${prefix} · `)) title = `${prefix} · ${title}`;
  }
  const blockers = o.blockedBy.map((n) => loadIssue(io, slug, n));
  const needCtx = !!o.milestone || (!org && o.type === "Эпик");
  const repoCtx = needCtx ? graphql(io, Q.TaskContext, { owner, name }).repository : null;
  const milestone = o.milestone ? (repoCtx.milestones.nodes as { id: string; title: string }[]).find((m) => m.title === o.milestone) : undefined;
  if (o.milestone && !milestone) throw new GhError(`открытого milestone ${q(o.milestone)} нет`);
  const dup = (graphql(io, Q.IssueSearch, { q: `repo:${slug} is:issue is:open in:title "${title.replaceAll('"', "")}"` }).search.nodes as Any[]).find((x) => x?.title === title);
  if (dup) throw new GhError(`открытая задача с таким заголовком уже есть: #${dup.number}`);

  const done: string[] = [];
  const input: Record<string, unknown> = { repositoryId: ctx.repo.id, title, body: o.body, projectV2Ids: [ctx.project.id] };
  if (issueType) {
    input.issueTypeId = issueType.id;
    done.push(`тип ${q(o.type)}`);
  }
  if (!org && o.type === "Эпик") {
    let labelId: string | undefined = repoCtx.label?.id;
    if (!labelId) {
      labelId = mutate(io, { op: "CreateLabel", input: { repositoryId: ctx.repo.id, ...EPIC_LABEL } }).createLabel.label.id as string;
      done.push(`создана метка ${q(EPIC_LABEL.name)}`);
    }
    input.labelIds = [labelId];
    done.push(`метка ${q(EPIC_LABEL.name)} — тип в личном аккаунте`);
  }
  if (milestone) input.milestoneId = milestone.id;
  if (epic) input.parentIssueId = epic.id;
  if (priority) input.issueFields = [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }];
  const created = mutate(io, { op: "CreateIssue", input }).createIssue.issue;

  // Status ставим сами, не дожидаясь workflow «Item added to project».
  const listed = (created.projectItems?.nodes ?? []).map((it: Any) => ({ id: it.id, projectId: it.project.id, status: null }));
  const item = ensureItem(io, ctx, { id: created.id, number: created.number, items: listed }).id;
  setStatus(io, ctx, item, BACKLOG);
  done.push(`проект ${q(ctx.project.title)}: ${STATUS} ${q(BACKLOG)}`);
  if (priority) done.push(`${PRIORITY} ${q(priority.name)}`);
  if (epic) done.push(`подзадача эпика #${epic.number}`);
  for (const b of blockers) {
    if (b.state !== "OPEN") {
      done.push(`#${b.number} закрыта — не блокирует, пропущена`);
      continue;
    }
    mutate(io, { op: "AddBlockedBy", input: { issueId: created.id, blockingIssueId: b.id } });
    done.push(`blocked by #${b.number}`);
  }
  if (milestone) done.push(`milestone ${q(milestone.title)}`);
  // эпик — не ниже самой срочной открытой подзадачи
  if (epic && priority) {
    const rank = (p: string | null) => (p === null ? PRIORITIES.length : (PRIORITIES as readonly string[]).indexOf(p));
    if (rank(priority.name) < rank(epic.priority)) {
      mutate(io, { op: "SetIssueField", input: { issueId: epic.id, issueFields: [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }] } });
      done.push(`${PRIORITY} эпика #${epic.number}: ${epic.priority ?? "—"} → ${priority.name}`);
    }
  }

  io.out(`Создана #${created.number} ${created.title} — ${created.url}`);
  for (const d of done) io.out(`+ ${d}`);
  if (o.type === "Эпик") io.out("Дальше: эпик не оценивается — его «Оценка, ч» = сумма оценок подзадач.");
  else io.out(`Дальше: оценка — скилл est (est estimate ${created.number} --type <тип ветки> --analogs …)${epic ? `; «Оценка, ч» эпика #${epic.number} — пересчитать суммой подзадач` : ""}.`);
  return 0;
}

export function cmdTaskStatus(io: Io, slug: string, number: number, status: string): number {
  if (!(STATUS_OPTIONS as readonly string[]).includes(status)) throw new GhError(`статус: ${STATUS_OPTIONS.join(", ")}`);
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  const item = ensureItem(io, ctx, issue);
  setStatus(io, ctx, item.id, status);
  io.out(`+ #${issue.number}: ${STATUS} ${q(status)}${item.added ? " (добавлена в проект)" : ""}`);
  if (!issue.parent) return 0;
  const epic = loadIssue(io, slug, issue.parent.number);
  const epicStatus = itemIn(ctx, epic)?.status ?? null;
  if (status === IN_PROGRESS && epic.state === "OPEN" && (epicStatus === null || epicStatus === BACKLOG)) {
    setStatus(io, ctx, ensureItem(io, ctx, epic).id, IN_PROGRESS);
    io.out(`+ эпик #${epic.number}: ${STATUS} ${q(IN_PROGRESS)} — взята первая подзадача`);
  }
  if (status === IN_PROGRESS && epic.state === "CLOSED") io.out(`Дальше: эпик #${epic.number} закрыт, а подзадача снова в работе — переоткрыть его (и его milestone, если закрыт).`);
  if (status === DONE && epic.state === "OPEN" && epic.subIssues.length && epic.subIssues.every((x) => x.state === "CLOSED")) {
    io.out(`Дальше: все подзадачи эпика #${epic.number} закрыты — закрыть эпик и поставить ему ${q(DONE)}.`);
  }
  return 0;
}

export function cmdTaskDrop(io: Io, slug: string, number: number, duplicateOf?: number): number {
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  if (issue.state === "CLOSED" && issue.stateReason === "COMPLETED") throw new GhError(`#${number} закрыта как выполненная — drop только для невыполненных`);
  const dup = duplicateOf === undefined ? null : loadIssue(io, slug, duplicateOf);
  if (issue.state === "OPEN") {
    mutate(io, { op: "CloseIssue", input: { issueId: issue.id, stateReason: dup ? "DUPLICATE" : "NOT_PLANNED", ...(dup ? { duplicateIssueId: dup.id } : {}) } });
    io.out(`+ #${number} закрыта: ${dup ? `дубль #${dup.number}` : "not planned"}`);
  }
  // закрытую без выполнения «Item closed» запишет в «Готово» — в проекте ей не место
  const item = itemIn(ctx, issue);
  if (item) {
    mutate(io, { op: "DeleteItem", input: { projectId: ctx.project.id, itemId: item.id } });
    io.out(`+ #${number} убрана из проекта ${q(ctx.project.title)}`);
  }
  if (issue.parent) io.out(`Дальше: «Оценка, ч» эпика #${issue.parent.number} — пересчитать суммой оставшихся подзадач.`);
  return 0;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `github — проект и задачи GitHub репозитория по канону AGENTS.md

  github project check [--repo owner/repo]
  github project fix   [--repo owner/repo] [--confirm] [--template owner/N | none]
  github task new      --title "…" [--body "…" | --body-file F] [--type Задача|Баг|Эпик] [--epic N]
                       [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low] [--repo owner/repo]
  github task status   <N> <Бэклог|В работе|Готово> [--repo owner/repo]
  github task drop     <N> [--duplicate-of M] [--repo owner/repo]

check — пункты ✅/❌, код 0 — всё по канону, 1 — есть ❌.
fix   — исправляет через API; шаги UI печатает со ссылками; удаление и переименование в проекте
        с задачами и настройки организации — только с --confirm (после «да» пользователя).
        Проекта нет — привязывает одноимённый, иначе копирует эталон (${DEFAULT_TEMPLATE}), иначе создаёт.
task  — задача по канону; new печатает созданное и следующий шаг (оценка через est).`;

const issueNumber = (s: string | undefined, what: string): number => {
  const m = /^#?(\d+)$/.exec((s ?? "").trim());
  if (!m) throw new GhError(`${what}: ожидается номер задачи, а не «${s ?? ""}»`);
  return Number(m[1]);
};

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
    const known: Record<string, string[]> = { project: ["check", "fix"], task: ["new", "status", "drop"] };
    if (!known[group]?.includes(cmd ?? "")) {
      io.err(`неизвестная команда «${argv.slice(0, 2).join(" ")}»; ожидается project check|fix или task new|status|drop`);
      return 2;
    }
    if (io.env.CLAUDE_CODE_REMOTE === "true") {
      io.err("облачная сессия: GitHub Projects ей недоступны (Projects v2 — 403, docs/cloud-sessions.md) — проект проверяет и чинит локальная сессия");
      return 2;
    }
    const repoOf = (v: string | undefined) => {
      const slug = v ?? detectRepo();
      if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new GhError(`неверный --repo «${slug}», ожидается owner/repo`);
      return slug;
    };
    if (group === "task") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          "body-file": { type: "string" },
          type: { type: "string", default: "Задача" },
          epic: { type: "string" },
          milestone: { type: "string" },
          "blocked-by": { type: "string" },
          priority: { type: "string" },
          "duplicate-of": { type: "string" },
        },
      });
      const slug = repoOf(values.repo);
      if (cmd === "new") {
        if (positionals.length) throw new GhError(`лишние аргументы: ${positionals.join(" ")}`);
        if (!values.title?.trim()) throw new GhError("--title обязателен");
        if (values.body !== undefined && values["body-file"]) throw new GhError("--body или --body-file, не оба");
        const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : (values.body ?? "");
        const blockedBy = (values["blocked-by"] ?? "").split(",").filter((x) => x.trim()).map((x) => issueNumber(x, "--blocked-by"));
        const epic = values.epic === undefined ? undefined : issueNumber(values.epic, "--epic");
        return cmdTaskNew(io, slug, { title: values.title, body, type: values.type!, epic, milestone: values.milestone, blockedBy, priority: values.priority });
      }
      const number = issueNumber(positionals[0], `task ${cmd}`);
      if (cmd === "status") return cmdTaskStatus(io, slug, number, positionals.slice(1).join(" "));
      if (positionals.length > 1) throw new GhError(`лишние аргументы: ${positionals.slice(1).join(" ")}`);
      return cmdTaskDrop(io, slug, number, values["duplicate-of"] === undefined ? undefined : issueNumber(values["duplicate-of"], "--duplicate-of"));
    }
    const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, confirm: { type: "boolean", default: false }, template: { type: "string", default: DEFAULT_TEMPLATE } } });
    const slug = repoOf(values.repo);
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
