#!/usr/bin/env bun
/**
 * github — проект и задачи GitHub репозитория по канону AGENTS.md (раздел «Ведение задач»; правила целиком —
 * reference.md рядом со SKILL.md: типы, метки решений, эпики, проект, milestones, актуализация блока).
 *
 * Подкоманды:
 *   github project check — сверка с каноном по пунктам ✅/❌
 *   github project fix   — довести до канона: API, шаги UI со ссылками, удаление и переименование — с --confirm
 *   github task new      — задача одной командой: тип или метка, проект и Бэклог, Priority, эпик, blocked by, milestone,
 *                          метки решений (имя решения, вид — цветом)
 *   github task status   — Status в проекте (и эпик — «В работе», когда взята первая подзадача)
 *   github task drop     — закрыть без выполнения и убрать из проекта
 *   github pr labels     — метки решений задаче из «Closes #N» по диффу PR, её эпику — объединение
 *   github pr queue      — голова ли PR в очереди мержа: push, CI и мерж — только у головы
 *
 * Запуск — Bun (`bun github.ts …`), только `node:`-API + CLI `gh`. Проверка и исправление — одна функция
 * `analyze`: каждое расхождение несёт свой шаг исправления, поэтому `check` и `fix` не расходятся.
 * Метки решений сверяются с деревом спеки основной ветки; модель архитектуры читает отдельный процесс того же
 * рантайма (`modelModules`). Мерж в основную ветку — ruleset `ai-dev`: strict и обязательные чеки, зелёные на
 * последних влитых PR.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
/**
 * Метки решений: имя — имя решения (папка дерева спеки или модуль модели), вид — цветом. Решения разных видов с
 * одним именем — одна метка: цвет старшего вида (порядок здесь), в описании все. У архитектуры решение — правило
 * `tests/architecture/<name>` или модуль модели `tests/architecture/model.ts`.
 */
export const DECISIONS = {
  capability: { dir: "capabilities", color: "0E8A16" },
  standard: { dir: "standards", color: "1D76DB" },
  // не FBCA04: он у метки «вопросы», а вид метки решения виден только цветом
  architecture: { dir: "architecture", color: "D93F0B" },
} as const;
export type DecisionKind = keyof typeof DECISIONS;
const DECISION_KINDS = Object.keys(DECISIONS) as DecisionKind[];
const MODEL_PATH = "tests/architecture/model.ts";
export const WORKFLOW_ADDED = "Item added to project";
export const WORKFLOW_CLOSED = "Item closed";
export const WORKFLOW_AUTO_ADD = "Auto-add to project";
/** Эталон: новый проект — его копия (представления, поля, настроенные workflow, кроме auto-add). */
export const DEFAULT_TEMPLATE = "miroshnik/6";
/**
 * Ruleset основной ветки, который ставит fix: GitHub не даёт влить отставшую ветку (strict) и ветку с красным
 * обязательным чеком. strict без обязательных чеков не действует — поэтому в нём и чеки.
 */
export const RULESET = "ai-dev";
/** Обязательный чек — зелёный на каждом из стольких последних влитых PR с чеками. */
export const STABLE_PRS = 10;
/** Роль admin репозитория (`repositoryRoleDatabaseId`) обходит ruleset: прямой push, `gh pr merge --admin`. */
const ADMIN_ROLE = 5;

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
  /** Подпроцесс (`est`, `git` у `task close`) — внешний край: в тестах подменяется. */
  run?: (cmd: string, args: string[], cwd?: string) => RunResult;
  /** Каталог git-шагов `task close`; по умолчанию — текущий. */
  cwd?: string;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function realRun(cmd: string, args: string[], cwd?: string): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? String(r.error.message) : (r.stderr ?? "") };
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
interface Label {
  id: string;
  name: string;
  color: string;
  description: string | null;
  /** Открытые задачи с меткой: сколько всего и номера первых OPEN_SHOWN. */
  open: { total: number; numbers: number[] };
}
/** Решения основной ветки по видам; модель не загрузилась — причина, модули в `architecture` тогда не входят. */
export interface Decisions {
  names: Record<DecisionKind, string[]>;
  modelError: string | null;
}
/** Чек головы PR: зелёный, ещё идёт или иначе (красный, пропущен, отменён). */
type CheckState = "success" | "pending" | "other";
interface Head {
  number: number;
  checks: Record<string, CheckState>;
}
interface Ruleset {
  id: string;
  enforcement: string;
  include: string[];
  strict: boolean;
  contexts: string[];
  bypassAdmin: boolean;
}
/** Мерж в основную ветку: её действующие правила с обязательными чеками и чеки голов PR в неё. */
export interface Merge {
  branch: string;
  /** Правила ветки недоступны на тарифе (приватный репозиторий на Free) — причина от GitHub. */
  unavailable: string | null;
  /** Действующие правила с обязательными чеками: ruleset любого уровня и классическая защита ветки. */
  rules: { source: string; strict: boolean; contexts: string[] }[];
  /** Свой ruleset — `RULESET` этого репозитория, в любом состоянии. */
  own: Ruleset | null;
  /** Последние `STABLE_PRS` влитых PR с чеками, от старых к новым. */
  merged: Head[];
  /** Открытые PR, у которых все чеки уже завершились: чека, которого у них нет, не будет. */
  open: Head[];
}
export interface State {
  repo: { id: string; name: string; nameWithOwner: string; owner: Owner; linked: ProjectRef[] };
  project: Project | null;
  openIssues: { id: string; number: number }[];
  labels: Label[];
  /** Задачи старых меток `вид:имя`, которые сливаются с уже занятым именем: по id метки. */
  labelIssues: Record<string, { id: string; number: number }[]>;
  decisions: Decisions;
  /** Пустой репозиторий (нет основной ветки) — null. */
  merge: Merge | null;
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
  /** Не расхождение, а положение дел (метка нового решения): строка `○`, пункт остаётся ✅. */
  notes: string[];
  /** Пункт неприменим (тариф, нет чеков): строка `➖` с причиной вместо ✅/❌. */
  skip?: string;
}

export class GhError extends Error {}

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const REF = "id number title url closed";
/** Номера открытых задач метки в строке «новое решение»; остальные — числом. */
const OPEN_SHOWN = 10;
/** Сколько последних PR смотрит task close без связи PR с задачей: его зовут сразу после мержа, PR — среди них. */
const RECENT_PRS = 50;
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
      milestone { id number title issues(states: OPEN) { totalCount } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number state merged headRefName baseRefName } }
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
  // HEAD — основная ветка: метки сверяются с тем, что уже влито
  SpecDecisions: `query SpecDecisions($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    capabilities: object(expression: "HEAD:tests/capabilities") { ... on Tree { entries { name type } } }
    standards: object(expression: "HEAD:tests/standards") { ... on Tree { entries { name type } } }
    architecture: object(expression: "HEAD:tests/architecture") { ... on Tree { entries { name type } } }
    model: object(expression: "HEAD:${MODEL_PATH}") { ... on Blob { text } }
  }
}`,
  LabelIssues: `query LabelIssues($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    label(name: $label) { issues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id number } } }
  }
}`,
  RepoLabels: `query RepoLabels($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name color description issues(states: OPEN, first: ${OPEN_SHOWN}) { totalCount nodes { number } } } }
  }
}`,
  PrChange: `query PrChange($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number headRefOid body
      closingIssuesReferences(first: 20) { nodes { number } }
      files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path changeType additions deletions } }
    }
  }
}`,
  ModelAt: `query ModelAt($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Blob { text } } }
}`,
  // Ref.rules — правила действующих ruleset (репозитория и организации), которые GitHub применяет к ветке
  MergeRules: `query MergeRules($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    isPrivate
    defaultBranchRef {
      name
      branchProtectionRule { requiresStrictStatusChecks requiredStatusCheckContexts }
      rules(first: 100) { nodes { type repositoryRuleset { name } parameters { ...StatusChecks } } }
    }
    rulesets(first: 100) {
      nodes {
        id name enforcement
        conditions { refName { include } }
        bypassActors(first: 50) { nodes { bypassMode repositoryRoleDatabaseId } }
        rules(first: 100) { nodes { type parameters { ...StatusChecks } } }
      }
    }
    merged: pullRequests(states: MERGED, last: 30) { nodes { ...Head } }
    open: pullRequests(states: OPEN, last: 30) { nodes { ...Head } }
  }
}
fragment StatusChecks on RuleParameters { ... on RequiredStatusChecksParameters { strictRequiredStatusChecksPolicy requiredStatusChecks { context } } }
fragment Head on PullRequest {
  number baseRefName
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
}`,
  DefaultBranch: `query DefaultBranch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name } }
}`,
  // headRef.compare(headRef: основная ветка): aheadBy — коммиты основной ветки, которых нет в ветке PR (отставание)
  MergeQueue: `query MergeQueue($owner: String!, $name: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: $base, first: 100) {
      nodes {
        number title isDraft headRefName
        headRef { compare(headRef: $base) { aheadBy } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`,
  // PR задачи, с которым GitHub её не связал (task close): последние открытые и влитые, новые первыми
  RecentPrs: `query RecentPrs($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: [OPEN, MERGED], first: ${RECENT_PRS}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number state merged headRefName baseRefName body } }
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
  UpdateLabel: ["updateLabel", "UpdateLabelInput", "label { id }"],
  DeleteLabel: ["deleteLabel", "DeleteLabelInput", "clientMutationId"],
  AddLabels: ["addLabelsToLabelable", "AddLabelsToLabelableInput", "clientMutationId"],
  AddBlockedBy: ["addBlockedBy", "AddBlockedByInput", "issue { id }"],
  SetIssueField: ["setIssueFieldValue", "SetIssueFieldValueInput", "issue { id }"],
  CloseIssue: ["closeIssue", "CloseIssueInput", "issue { id state }"],
  AddComment: ["addComment", "AddCommentInput", "subject { id }"],
  CreateRuleset: ["createRepositoryRuleset", "CreateRepositoryRulesetInput", "ruleset { id }"],
  UpdateRuleset: ["updateRepositoryRuleset", "UpdateRepositoryRulesetInput", "ruleset { id }"],
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
  const labels = loadLabels(io, slug);
  return { repo, project: main ? loadProject(io, main.id) : null, openIssues, labels, labelIssues: mergedIssues(io, slug, labels), decisions: loadDecisions(io, slug), merge: loadMerge(io, slug) };
}

const statusChecks = (rule: Any): { strict: boolean; contexts: string[] } | null =>
  rule?.type === "REQUIRED_STATUS_CHECKS" ? { strict: !!rule.parameters?.strictRequiredStatusChecksPolicy, contexts: (rule.parameters?.requiredStatusChecks ?? []).map((c: Any) => c.context) } : null;

/** Чеки головы PR по имени; перезапуск того же чека — зелёный, если зелёный хоть один. */
function headChecks(pr: Any): Record<string, CheckState> {
  const out: Record<string, CheckState> = {};
  for (const c of pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) {
    if (!c) continue;
    const run = c.__typename === "CheckRun";
    const name: string = run ? c.name : c.context;
    const state: CheckState = run ? (c.status !== "COMPLETED" ? "pending" : c.conclusion === "SUCCESS" ? "success" : "other") : c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "other";
    if (out[name] !== "success") out[name] = state;
  }
  return out;
}

/** Приватный репозиторий на Free: GraphQL молча отдаёт пустые правила, REST — 403 «Upgrade to GitHub Pro…». */
function rulesetsUnavailable(io: Io, slug: string): string | null {
  const out = io.gh(["api", `repos/${slug}/rulesets`]);
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api repos/${slug}/rulesets: ответ не JSON: ${out.slice(0, 200)}`);
  }
  return !Array.isArray(res) && /upgrade/i.test(res?.message ?? "") ? String(res.message) : null;
}

function loadMerge(io: Io, slug: string): Merge | null {
  const [owner, name] = slug.split("/") as [string, string];
  const r = graphql(io, Q.MergeRules, { owner, name })?.repository;
  const b = r?.defaultBranchRef;
  if (!b) return null;
  const heads = (nodes: Any[]): Head[] =>
    (nodes ?? []).filter((p) => p && p.baseRefName === b.name).map((p) => ({ number: p.number, checks: headChecks(p) })).filter((h) => Object.keys(h.checks).length);
  const bp = b.branchProtectionRule;
  const rules = (b.rules?.nodes ?? []).flatMap((x: Any) => {
    const sc = statusChecks(x);
    return sc ? [{ source: `ruleset ${q(x.repositoryRuleset?.name ?? "?")}`, ...sc }] : [];
  });
  if (bp?.requiresStrictStatusChecks || bp?.requiredStatusCheckContexts?.length) rules.push({ source: "защита ветки", strict: !!bp.requiresStrictStatusChecks, contexts: bp.requiredStatusCheckContexts ?? [] });
  const o = (r.rulesets?.nodes ?? []).find((x: Any) => x?.name === RULESET);
  const osc = o ? ((o.rules?.nodes ?? []).map(statusChecks).find(Boolean) ?? { strict: false, contexts: [] }) : null;
  return {
    branch: b.name,
    unavailable: r.isPrivate ? rulesetsUnavailable(io, slug) : null,
    rules,
    own: o
      ? {
          id: o.id,
          enforcement: o.enforcement,
          include: o.conditions?.refName?.include ?? [],
          ...osc!,
          bypassAdmin: (o.bypassActors?.nodes ?? []).some((a: Any) => a?.repositoryRoleDatabaseId === ADMIN_ROLE && a.bypassMode === "ALWAYS"),
        }
      : null,
    merged: heads(r.merged?.nodes).slice(-STABLE_PRS),
    open: heads(r.open?.nodes).filter((h) => Object.values(h.checks).every((c) => c !== "pending")),
  };
}

/** Задачи старых меток, чьё имя уже занято (другой меткой или старой меткой раньше в списке), — их сольёт fix. */
function mergedIssues(io: Io, slug: string, labels: Label[]): State["labelIssues"] {
  const [owner, name] = slug.split("/") as [string, string];
  const seen = new Set(labels.filter((l) => !legacyDecision(l.name)).map((l) => l.name));
  const out: State["labelIssues"] = {};
  for (const l of labels) {
    const old = legacyDecision(l.name);
    if (!old) continue;
    if (seen.has(old.name)) out[l.id] = pages<{ id: string; number: number }>((after) => graphql(io, Q.LabelIssues, { owner, name, label: l.name, after }).repository.label.issues);
    seen.add(old.name);
  }
  return out;
}

function loadLabels(io: Io, slug: string): Label[] {
  const [owner, name] = slug.split("/") as [string, string];
  return pages<Any>((after) => graphql(io, Q.RepoLabels, { owner, name, after }).repository.labels).map(({ issues, ...l }) => ({
    ...l,
    open: { total: issues?.totalCount ?? 0, numbers: (issues?.nodes ?? []).map((i: Any) => i.number) },
  }));
}

/**
 * Модули модели архитектуры и их каталоги: текст модели — во временный файл, `modules` печатает отдельный процесс
 * того же рантайма (Bun или Node стирают типы; `import type` скилла spec модели не нужен). Не загрузилась — причина
 * строкой.
 */
export function modelModules(text: string): Record<string, string[]> | string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "github-model-"));
  try {
    writeFileSync(path.join(dir, "model.ts"), text);
    writeFileSync(
      path.join(dir, "modules.mjs"),
      'const m = await import("./model.ts");\n' +
        "const paths = (p) => (Array.isArray(p) ? p : [p]).map((x) => String(x).replace(/\\/+$/, \"\"));\n" +
        "console.log(JSON.stringify(Object.fromEntries(Object.entries(m.default?.modules ?? {}).map(([k, v]) => [k, paths(v?.path ?? [])]))));\n",
    );
    const r = spawnSync(process.execPath, [path.join(dir, "modules.mjs")], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return ((r.stderr || r.error?.message || "").trim().split("\n").find((l) => /error/i.test(l)) ?? "процесс завершился с ошибкой").trim().slice(0, 200);
    return JSON.parse(r.stdout) as Record<string, string[]>;
  } catch (e) {
    return (e as Error).message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Решения основной ветки: папки дерева спеки по видам и модули модели — у архитектуры. */
export function loadDecisions(io: Io, slug: string): Decisions {
  const [owner, name] = slug.split("/") as [string, string];
  const r = graphql(io, Q.SpecDecisions, { owner, name })?.repository ?? {};
  const dirs = (t: Any): string[] => (t?.entries ?? []).filter((e: Any) => e.type === "tree").map((e: Any) => e.name as string);
  const names = { capability: dirs(r.capabilities), standard: dirs(r.standards), architecture: dirs(r.architecture) };
  let modelError: string | null = null;
  if (r.model) {
    const mods = modelModules(r.model.text ?? "");
    if (typeof mods === "string") modelError = mods;
    else names.architecture.push(...Object.keys(mods));
  }
  for (const k of DECISION_KINDS) names[k] = [...new Set(names[k])].sort();
  return { names, modelError };
}

/** `capability:billing` → вид и имя решения; другое — null. Метка старого вида или вид нового решения в `--labels`. */
export function legacyDecision(label: string): { kind: DecisionKind; name: string } | null {
  const i = label.indexOf(":");
  const kind = label.slice(0, i) as DecisionKind;
  return i > 0 && DECISION_KINDS.includes(kind) && label.length > i + 1 ? { kind, name: label.slice(i + 1) } : null;
}

/** Признак метки решения — описание: цвет у обычной метки может совпасть, имя — тоже. */
const DECISION_MARK = "Решение: ";
const decisionPath = (kind: DecisionKind, name: string) => (kind === "architecture" ? `tests/architecture — правило или модуль ${name}` : `tests/${DECISIONS[kind].dir}/${name}`);

/** Метка решения: цвет старшего вида, в описании пути всех видов; длиннее 100 символов GitHub не примет — тогда виды. */
export function decisionLabel(name: string, kinds: DecisionKind[]): { name: string; color: string; description: string } {
  const ks = DECISION_KINDS.filter((k) => kinds.includes(k));
  const full = DECISION_MARK + ks.map((k) => decisionPath(k, name)).join("; ");
  return { name, color: DECISIONS[ks[0]!].color, description: full.length <= 100 ? full : DECISION_MARK + ks.join(", ") };
}

/** Виды метки решения — по описанию; обычная метка — null. */
export function labelKinds(description: string | null | undefined): DecisionKind[] | null {
  if (!description?.startsWith(DECISION_MARK)) return null;
  const parts = description.slice(DECISION_MARK.length).split(/; |, /);
  return DECISION_KINDS.filter((k) => parts.some((p) => p === k || p.startsWith(`tests/${DECISIONS[k].dir}`)));
}

/** Решения основной ветки по имени: имя → его виды (старший первым). */
function decisionsByName(d: Decisions): Map<string, DecisionKind[]> {
  const out = new Map<string, DecisionKind[]>();
  for (const k of DECISION_KINDS) for (const n of d.names[k]) out.set(n, [...(out.get(n) ?? []), k]);
  return out;
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
    const c: Check = { key, title, problems: [], notes: [] };
    checks.push(c);
    return Object.assign((text: string, ...steps: Step[]) => c.problems.push({ text, steps }), { note: (text: string) => c.notes.push(text), skip: (why: string) => void (c.skip = why) });
  };

  const link = add("link", `Проект привязан к репозиторию и называется ${q(s.repo.name)}`);
  // правило основной ветки от проекта не зависит
  const merge = () => s.merge && analyzeMerge(s.merge, s.repo.id, add("merge", `Мерж в ${s.merge.branch} — только актуальной ветки с зелёными обязательными чеками`));
  if (!p) {
    link("к репозиторию не привязан ни один открытый проект", { kind: "api", text: `найти, скопировать с эталона или создать проект ${q(s.repo.name)} и привязать к ${s.repo.nameWithOwner}` });
    merge();
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

  // Метки решений: по дереву спеки и модели основной ветки. Удалить, переименовать по догадке, слить, сделать меткой
  // решения обычную — только с --confirm: метка стоит на задачах. Одна лишняя и одна недостающая одного вида —
  // переименованная папка, а не два решения. Старый вид `вид:имя` → имя — сам, есть решение или нет: задачи сохраняют
  // метку, догадки нет. Метка без решения на открытой задаче — новое решение (task new ставит её до PR): строка ○, не
  // удаляется и по догадке не переименовывается — это отняло бы её у задачи.
  const labels = add("labels", "Метки решений — имя решения, вид — цветом; по дереву спеки и модели в основной ветке");
  const d = s.decisions;
  if (d.modelError) labels(`модель ${MODEL_PATH} не загружается — метки модулей не сверяются: ${d.modelError}`);
  const want = decisionsByName(d);
  // модель не прочитана — неизвестно, какие модули есть: метки архитектуры не удаляем и не переописываем
  const unsure = (kinds: DecisionKind[]) => !!d.modelError && kinds.includes("architecture");
  const taken = new Map(s.labels.filter((l) => !legacyDecision(l.name)).map((l) => [l.name, l]));
  const orphans: { label: Label; kinds: DecisionKind[] }[] = [];
  for (const l of s.labels) {
    const old = legacyDecision(l.name);
    if (!old) continue;
    const to = decisionLabel(old.name, want.get(old.name) ?? [old.kind]);
    const into = taken.get(old.name);
    if (!into) {
      taken.set(old.name, { ...l, ...to });
      labels(`метка ${q(l.name)} старого вида \`вид:имя\``, api(`переименовать метку ${q(l.name)} → ${q(old.name)} (задачи сохранят её)`, { op: "UpdateLabel", input: { id: l.id, ...to } }));
      continue;
    }
    const issues = s.labelIssues[l.id] ?? [];
    labels(`метка ${q(l.name)} старого вида, метка ${q(old.name)} уже есть`, {
      kind: "confirm",
      text: `слить метку ${q(l.name)} в ${q(old.name)}: ${issues.length ? `${nums(issues)} получат ${q(old.name)}, ` : ""}старая удаляется`,
      mutations: [...issues.map((i) => ({ op: "AddLabels", input: { labelableId: i.id, labelIds: [into.id] } })), { op: "DeleteLabel", input: { id: l.id } }],
    });
  }
  for (const l of s.labels) {
    if (legacyDecision(l.name)) continue;
    const kinds = labelKinds(l.description);
    const w = want.get(l.name);
    if (!w) {
      if (kinds) orphans.push({ label: l, kinds });
      continue;
    }
    const to = decisionLabel(l.name, w);
    if (!kinds) {
      labels(`метка ${q(l.name)} — не метка решения, а решение ${l.name} есть в основной ветке`, { kind: "confirm", text: `сделать ${q(l.name)} меткой решения: цвет ${to.color}, описание ${q(to.description)}`, mutations: [{ op: "UpdateLabel", input: { id: l.id, color: to.color, description: to.description } }] });
      continue;
    }
    const recolor = l.color.toLowerCase() !== to.color.toLowerCase();
    if (!recolor && (l.description === to.description || unsure(kinds))) continue;
    const text = recolor ? `метка ${q(l.name)} цвета ${l.color}, а не ${to.color}` : `метка ${q(l.name)}: в описании не те виды решения`;
    labels(text, api(`${recolor ? "перекрасить" : "переписать описание"} метки ${q(l.name)}: ${to.color}, ${q(to.description)}`, { op: "UpdateLabel", input: { id: l.id, color: to.color, description: to.description } }));
  }
  const unlabeled = [...want.keys()].filter((n) => !taken.has(n));
  const sure = orphans.filter((o) => !unsure(o.kinds));
  for (const { label: l } of sure.filter((o) => o.label.open.total)) {
    const more = l.open.total - l.open.numbers.length;
    labels.note(`новое решение ${q(l.name)}: в основной ветке ещё нет, метка на открытых задачах ${l.open.numbers.map((n) => `#${n}`).join(", ")}${more > 0 ? ` и ещё ${more}` : ""}`);
  }
  const live = sure.filter((o) => !o.label.open.total);
  const paired = new Set<string>();
  for (const kind of DECISION_KINDS) {
    const os = live.filter((o) => o.kinds.includes(kind) && !paired.has(o.label.id));
    const ms = unlabeled.filter((n) => want.get(n)!.includes(kind) && !paired.has(n));
    if (os.length !== 1 || ms.length !== 1) continue;
    const o = os[0]!.label;
    const to = decisionLabel(ms[0]!, want.get(ms[0]!)!);
    paired.add(o.id).add(to.name);
    labels(`метка ${q(o.name)} без решения, решение ${to.name} без метки`, { kind: "confirm", text: `переименовать метку ${q(o.name)} → ${q(to.name)} (задачи сохранят её)`, mutations: [{ op: "UpdateLabel", input: { id: o.id, ...to } }] });
  }
  for (const { label: o } of live.filter((x) => !paired.has(x.label.id))) {
    labels(`метка ${q(o.name)} без решения в основной ветке, открытых задач с ней нет`, { kind: "confirm", text: `удалить метку ${q(o.name)}`, mutations: [{ op: "DeleteLabel", input: { id: o.id } }] });
  }
  const fresh = unlabeled.filter((n) => !paired.has(n)).map((n) => decisionLabel(n, want.get(n)!));
  if (fresh.length) {
    labels(`решения без метки: ${fresh.map((x) => x.name).join(", ")}`, api(`создать метки ${fresh.map((x) => q(x.name)).join(", ")}`, ...fresh.map((x) => ({ op: "CreateLabel", input: { repositoryId: s.repo.id, ...x } }))));
  }

  merge();
  return checks;
}

/** Ruleset `RULESET`: основная ветка, strict, обязательные чеки, обход — admin (прямой push владельца). */
function rulesetInput(contexts: string[]): Record<string, unknown> {
  return {
    name: RULESET,
    target: "BRANCH",
    enforcement: "ACTIVE",
    conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: { requiredStatusChecks: contexts.map((context) => ({ context })), strictRequiredStatusChecksPolicy: true } } }],
    bypassActors: [{ repositoryRoleDatabaseId: ADMIN_ROLE, bypassMode: "ALWAYS" }],
  };
}

/**
 * Мерж: правило канона «подъехал чужой PR — rebase» и «мерж только при зелёных чеках» держит GitHub, а не память
 * агента. Обязательные — чеки, зелёные на каждом из последних влитых PR; чек, которого нет у свежей головы (последний
 * влитый PR, открытые с завершёнными чеками), держал бы PR вечно — он из списка уходит, а не попадает в него.
 * Чужое правило со strict и чеками не дублируется.
 */
function analyzeMerge(m: Merge, repositoryId: string, merge: ((text: string, ...steps: Step[]) => void) & { skip: (why: string) => void }): void {
  if (m.unavailable) return merge.skip(`правила ветки недоступны: ${m.unavailable}`);
  const fresh = [...m.merged.slice(-1), ...m.open];
  const gone = (c: string) => fresh.find((h) => !(c in h.checks));
  const stable = Object.keys(m.merged[0]?.checks ?? {})
    .filter((c) => m.merged.every((h) => h.checks[c] === "success") && !gone(c))
    .sort();
  const enforced = m.rules.some((r) => r.strict && r.contexts.length);
  const list = (cs: string[]) => cs.map(q).join(", ");
  const none = `у последних влитых PR нет общего зелёного чека — обязательным делать нечего, strict без чеков не действует`;
  const own = m.own;
  if (!own) {
    if (enforced) return;
    if (!stable.length) return merge.skip(none);
    const text = `создать ruleset ${q(RULESET)} на ${m.branch}: strict, обязательные ${list(stable)}, обход — admin`;
    const step: Step = { kind: "api", text, mutations: [{ op: "CreateRuleset", input: { sourceId: repositoryId, ...rulesetInput(stable) } }] };
    const half = m.rules.find((r) => r.contexts.length && !r.strict) ?? m.rules.find((r) => r.strict);
    return merge(half ? (half.strict ? `${half.source}: strict без обязательных чеков не действует` : `${half.source}: strict выключен — отставшую ветку можно влить`) : `нет правила: отставшую ветку и ветку с красным чеком можно влить`, step);
  }
  const want = [...new Set([...own.contexts.filter((c) => !gone(c)), ...stable])].sort();
  const step: Step = { kind: "api", text: `ruleset ${q(RULESET)}: основная ветка, strict, обязательные ${list(want) || "—"}, обход — admin`, mutations: [{ op: "UpdateRuleset", input: { repositoryRulesetId: own.id, ...rulesetInput(want) } }] };
  const why: string[] = [];
  if (own.enforcement !== "ACTIVE") why.push(`ruleset ${q(RULESET)} — ${own.enforcement}, не действует`);
  if (!own.include.includes("~DEFAULT_BRANCH")) why.push(`ruleset ${q(RULESET)} не на основной ветке: ${own.include.join(", ") || "—"}`);
  if (!own.strict) why.push(`ruleset ${q(RULESET)}: strict выключен — отставшую ветку можно влить`);
  if (!own.bypassAdmin) why.push(`ruleset ${q(RULESET)}: admin не может обойти — прямой push в ${m.branch} невозможен`);
  for (const c of own.contexts.filter((x) => gone(x))) why.push(`обязательный ${q(c)} не пришёл на PR #${gone(c)!.number} — PR ждал бы его вечно`);
  const add = stable.filter((c) => !own.contexts.includes(c));
  if (add.length) why.push(`не обязательны зелёные на последних ${m.merged.length} влитых PR: ${list(add)}`);
  for (const w of why) merge(w, step);
  if (!why.length && !enforced && !want.length) merge.skip(none);
}

// ----------------------------------------------------------------------------
// Команды
// ----------------------------------------------------------------------------

function header(io: Io, s: State): void {
  io.out(`Проект ${s.repo.nameWithOwner}: ${s.project ? s.project.url : "нет"}`);
}

function report(io: Io, s: State, checks: Check[]): boolean {
  for (const c of checks) {
    if (c.skip) {
      io.out(`➖ ${c.title} — ${c.skip}`);
      continue;
    }
    io.out(`${c.problems.length ? "❌" : "✅"} ${c.title}`);
    for (const pr of c.problems) io.out(`   · ${pr.text}`);
    for (const n of c.notes) io.out(`   ○ ${n}`);
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
      // у нескольких расхождений бывает один шаг (правка ruleset целиком) — он делается один раз
      if (tried.has(st.text)) continue;
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
  /** Milestone задачи и число открытых задач в нём (включая эту, если открыта). */
  milestone: { id: string; number: number; title: string; open: number } | null;
  /** PR, закрывающие задачу («Closes #N»), включая закрытые: влит ли, голова и база. */
  prs: { number: number; state: string; merged: boolean; head: string; base: string }[];
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
    milestone: i.milestone ? { id: i.milestone.id, number: i.milestone.number, title: i.milestone.title, open: i.milestone.issues?.totalCount ?? 0 } : null,
    prs: (i.closedByPullRequestsReferences?.nodes ?? []).map((p: Any) => ({ number: p.number, state: p.state ?? "", merged: Boolean(p.merged), head: p.headRefName ?? "", base: p.baseRefName ?? "main" })),
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
  /** Метки: решение по имени или новое решение `вид:имя` (нет метки — создаётся с цветом вида), обычные — существующие. */
  labels?: string[];
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
  const wanted = [...new Set(o.labels ?? [])];
  const repoLabels = wanted.length ? loadLabels(io, slug) : [];
  const has = (n: string) => repoLabels.find((x) => x.name === n);
  // решение по имени — из основной ветки; `вид:имя` — и новое, которого там ещё нет
  const decisions = wanted.some((l) => legacyDecision(l) || !has(l)) ? loadDecisions(io, slug) : null;
  const inMain = decisions ? decisionsByName(decisions) : new Map<string, DecisionKind[]>();
  const plan = wanted.map((l) => {
    const dec = legacyDecision(l);
    const name = dec?.name ?? l;
    const label = has(name);
    const main = inMain.get(name) ?? [];
    const kinds = dec && !main.includes(dec.kind) ? [...main, dec.kind] : main;
    if (!label && !kinds.length) {
      throw new GhError(`метки ${q(l)} в репозитории нет, решения ${l} в основной ветке тоже; новое решение — вид:имя (${DECISION_KINDS.map((k) => `${k}:${l}`).join(", ")})`);
    }
    return { name, label, kinds, decision: dec !== null || (label ? labelKinds(label.description) !== null : true), fresh: dec && !main.includes(dec.kind) ? `${name} — новое решение: ${decisionPath(dec.kind, name)} в основной ветке ещё нет` : null };
  });

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
  if (plan.length) {
    const ids: string[] = [];
    for (const x of plan) {
      let id = x.label?.id;
      if (!id) {
        id = mutate(io, { op: "CreateLabel", input: { repositoryId: ctx.repo.id, ...decisionLabel(x.name, x.kinds) } }).createLabel.label.id as string;
        done.push(`создана метка ${q(x.name)}`);
      }
      ids.push(id);
    }
    input.labelIds = [...((input.labelIds as string[] | undefined) ?? []), ...ids];
    // решение появится в PR этой задачи — метка говорит об этом, а не падает
    done.push(`метки: ${plan.map((x) => x.name).join(", ")}`, ...plan.flatMap((x) => (x.fresh ? [x.fresh] : [])));
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
  // эпик копит метки решений подзадач
  const decided = plan.filter((x) => x.decision).map((x) => x.name);
  if (epic && decided.length) {
    const all = loadLabels(io, slug);
    const line = addLabels(io, epic, decided, all);
    if (line) done.push(`эпик #${epic.number}: ${line}`);
  }
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
// Закрытие задачи одной командой
// ----------------------------------------------------------------------------

/**
 * Ритуал закрытия после мержа PR — факт, Status «Готово», эпик, milestone, уборка влитой ветки — одним вызовом:
 * сессия делала его по шагу на ход на самом большом контексте. Актуализация блока (пять проверок канона) —
 * не здесь: её делает субагент со свежим контекстом, команда лишь называет это следующим шагом.
 */
export function cmdTaskClose(io: Io, slug: string, number: number, o: { git: boolean }): number {
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  const linked = issue.prs.filter((p) => p.merged);
  const closedNoPr = !issue.prs.length && issue.state === "CLOSED" && issue.stateReason === "COMPLETED";
  // GitHub бывает часами не связывает влитый PR с задачей: задача открыта, влитых в связи нет — ищем PR задачи сами
  const found = !linked.length && issue.state === "OPEN" ? unlinkedPrs(io, slug, number) : null;
  const fresh = (found?.prs ?? []).filter((p) => !issue.prs.some((x) => x.number === p.number));
  const unlinked = fresh.filter((p) => p.merged);
  const merged = linked.length ? linked : unlinked;
  if (!merged.length && !closedNoPr) {
    const prs = [...issue.prs, ...fresh].map((p) => `#${p.number} ${p.state === "OPEN" ? "открыт" : "закрыт без мержа"}`).join(", ");
    const what = prs ? `PR ${prs}` : `задача ${issue.state === "OPEN" ? "открыта" : "закрыта без выполнения"}, влитого PR нет`;
    const checked = found ? `; проверены связь PR с задачей, ветка <type>/${number}-<slug> и «Closes #${number}» в теле последних ${RECENT_PRS} PR в ${found.base}` : "";
    throw new GhError(`#${number} закрывать рано: ${what}${checked} — close после мержа PR или закрытия задачи`);
  }
  const wasOpen = issue.state === "OPEN";
  if (wasOpen) {
    // без связи задача не видит своего PR — комментарий его называет
    if (unlinked.length) mutate(io, { op: "AddComment", input: { subjectId: issue.id, body: `Закрыта по PR ${unlinked.map((p) => `#${p.number}`).join(", ")}: GitHub не связал PR с задачей` } });
    mutate(io, { op: "CloseIssue", input: { issueId: issue.id, stateReason: "COMPLETED" } });
    io.out(
      unlinked.length
        ? `+ #${number} закрыта по PR ${unlinked.map((p) => `#${p.number} (${p.why})`).join(", ")}: GitHub не связал PR с задачей`
        : `+ #${number} закрыта: PR ${merged.map((p) => `#${p.number}`).join(", ")} влит`,
    );
  }
  runFact(io, slug, number);
  const item = ensureItem(io, ctx, issue);
  setStatus(io, ctx, item.id, DONE);
  io.out(`+ #${number}: ${STATUS} ${q(DONE)}${item.added ? " (добавлена в проект)" : ""}`);
  closeMilestone(io, slug, issue, wasOpen);
  if (issue.parent) {
    const epic = loadIssue(io, slug, issue.parent.number);
    const open = epic.subIssues.filter((x) => x.state === "OPEN" && x.number !== number).length;
    if (epic.state === "OPEN" && epic.subIssues.length && !open) {
      mutate(io, { op: "CloseIssue", input: { issueId: epic.id, stateReason: "COMPLETED" } });
      setStatus(io, ctx, ensureItem(io, ctx, epic).id, DONE);
      io.out(`+ эпик #${epic.number} закрыт и в ${q(DONE)}: все подзадачи закрыты`);
      closeMilestone(io, slug, epic, true);
    } else if (epic.state === "OPEN") io.out(`○ эпик #${epic.number}: открытых подзадач ${open}`);
  }
  if (o.git) cleanupBranch(io, slug, number, merged[0] ?? null);
  io.out(`Дальше: актуализация блока — субагентом со свежим контекстом (задача #${number}${issue.parent ? `, эпик #${issue.parent.number}` : ""}), пять проверок — reference.md скилла github, «Актуализация блока при закрытии задачи».`);
  return 0;
}

/** Ветка задачи по канону — `<type>/<N>-<slug>`, с префиксом области или без. */
const isTaskBranch = (branch: string, number: number) => new RegExp(`(^|/)[a-z]+/${number}-`).test(branch);

/**
 * PR задачи, с которыми GitHub её не связал: среди последних открытых и влитых PR основной ветки — ветка задачи или
 * «Closes #N» в теле (как `pr labels` до появления связи). `why` — по чему найден.
 */
function unlinkedPrs(io: Io, slug: string, number: number): { base: string; prs: (Issue["prs"][number] & { why: string })[] } {
  const [owner, name] = slug.split("/");
  const r = graphql(io, Q.RecentPrs, { owner, name })?.repository;
  const base: string = r?.defaultBranchRef?.name ?? "main";
  const prs: (Issue["prs"][number] & { why: string })[] = [];
  for (const p of r?.pullRequests?.nodes ?? []) {
    if (p.baseRefName !== base) continue;
    const head: string = p.headRefName ?? "";
    const why = isTaskBranch(head, number) ? `ветка ${head}` : closingInBody(p.body ?? "").includes(number) ? `«Closes #${number}» в теле` : null;
    if (why) prs.push({ number: p.number, state: p.state ?? "", merged: Boolean(p.merged), head, base, why });
  }
  return { base, prs };
}

/** Факт — скрипт est рядом со скиллом (`../est/scripts/est.ts`: так лежат копия в проекте, `~/.agents/skills` и клон). */
function runFact(io: Io, slug: string, number: number): void {
  const est = io.env.AI_DEV_EST ?? path.resolve(import.meta.dir, "../../est/scripts/est.ts");
  if (!existsSync(est)) return io.out(`○ факт недоступен: est не установлен (${est}) — est fact ${number} --write после установки`);
  const r = (io.run ?? realRun)("bun", [est, "fact", String(number), "--repo", slug, "--write"], io.cwd);
  for (const line of r.stdout.split("\n")) if (line.trim() && !line.startsWith("<!--")) io.out(line);
  if (r.status !== 0) io.out(`! est fact: ${r.stderr.trim().split("\n").filter(Boolean).pop() ?? `код ${r.status}`}`);
}

/** Мутации milestone в GraphQL нет — REST. wasOpen — задача была открыта при чтении: в счёте открытых она есть. */
function closeMilestone(io: Io, slug: string, issue: Issue, wasOpen: boolean): void {
  const m = issue.milestone;
  if (!m) return;
  const open = m.open - (wasOpen ? 1 : 0);
  if (open > 0) return io.out(`○ milestone ${q(m.title)}: открытых задач ${open}`);
  io.gh(["api", "-X", "PATCH", `repos/${slug}/milestones/${m.number}`, "-f", "state=closed"]);
  io.out(`+ milestone ${q(m.title)} закрыт: открытых задач не осталось`);
}

/**
 * Влитое — долой (SKILL.md, «Git, PR и мерж — механика», пункт «Сразу после мержа PR»): чекаут с ветки задачи на
 * origin/<base> detached, локальная и
 * удалённая ветка удаляются. «Влито» — PR merged, без PR — `git cherry`; не влита, чужая или не тот чекаут — не трогаем.
 */
function cleanupBranch(io: Io, slug: string, number: number, pr: { head: string; base: string } | null): void {
  const git = (...args: string[]) => (io.run ?? realRun)("git", args, io.cwd);
  const remote = git("remote", "get-url", "origin");
  if (remote.status !== 0 || !remote.stdout.includes(slug)) return io.out(`○ ветки не трогаю: текущий каталог — не чекаут ${slug}`);
  const base = pr?.base || "main";
  const current = git("branch", "--show-current").stdout.trim();
  const isTask = (b: string) => b === pr?.head || isTaskBranch(b, number);
  const branch = current && isTask(current) ? current : (pr?.head ?? "");
  if (!branch) return io.out("○ ветка задачи не найдена — ветки не трогаю");
  git("fetch", "--prune", "origin");
  const local = git("branch", "--list", branch).stdout.trim() !== "";
  const cherry = pr || !local ? null : git("cherry", `origin/${base}`, branch);
  if (cherry && (cherry.status !== 0 || cherry.stdout.split("\n").some((l) => l.startsWith("+")))) return io.out(`○ ветка ${branch} не влита в origin/${base} — не тронута`);
  if (current === branch) {
    const sw = git("switch", "--detach", `origin/${base}`);
    if (sw.status !== 0) return io.out(`! git switch --detach origin/${base}: ${sw.stderr.trim()}`);
    io.out(`+ чекаут — на origin/${base} (detached)`);
  }
  if (local) {
    const d = git("branch", "-D", branch);
    io.out(d.status === 0 ? `+ локальная ветка ${branch} удалена` : `! git branch -D ${branch}: ${d.stderr.trim()}`);
  }
  if (git("ls-remote", "--heads", "origin", branch).stdout.trim()) {
    const d = git("push", "origin", "--delete", branch);
    io.out(d.status === 0 ? `+ удалённая ветка ${branch} удалена` : `! git push origin --delete ${branch}: ${d.stderr.trim()}`);
  } else io.out(`○ удалённой ветки ${branch} уже нет`);
  const top = git("rev-parse", "--show-toplevel").stdout.trim();
  const common = git("rev-parse", "--git-common-dir").stdout.trim();
  if (top && common && path.resolve(io.cwd ?? process.cwd(), common) !== path.join(top, ".git")) io.out(`Дальше: worktree ${top} убрать из главного чекаута: git worktree remove ${top}`);
}

// ----------------------------------------------------------------------------
// Метки решений по PR
// ----------------------------------------------------------------------------

/** Метки, которых у задачи нет, — одной мутацией; вернёт их через запятую (нечего добавлять — пусто). */
function addLabels(io: Io, issue: Pick<Issue, "id" | "labels">, names: string[], all: Label[]): string {
  const missing = names.filter((n) => !issue.labels.includes(n));
  if (!missing.length) return "";
  mutate(io, { op: "AddLabels", input: { labelableId: issue.id, labelIds: missing.map((n) => all.find((l) => l.name === n)!.id) } });
  issue.labels.push(...missing);
  return missing.join(", ");
}

/** Изменённый файл PR (`PullRequestChangedFile`): вид правки и число строк. */
export interface PrFile {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
}

/**
 * Механическая правка решение не меняет: файл удалён, переименован без правки содержимого или это `exceptions.ts`
 * папки решения (храповик исключений). Метку решения она не даёт — иначе при массовых правках задача получает метки
 * решений, которых не меняла.
 */
function mechanical(f: PrFile): boolean {
  if (f.changeType === "DELETED") return true;
  if (f.changeType === "RENAMED" && f.additions === 0 && f.deletions === 0) return true;
  const parts = f.path.split("/");
  return parts[0] === "tests" && parts.length === 4 && parts[3] === "exceptions.ts";
}

/**
 * Решения, которые трогает дифф: папка дерева спеки — само решение, файл кода — модуль модели с самым длинным
 * подходящим каталогом (вложенный модуль точнее объемлющего). `tests/lib` и файлы вне модулей — не решения.
 * `changed` — имя решения → его виды в диффе, хотя бы один файл решения правлен по содержимому; `mechanical` — решения,
 * тронутые только механической правкой. Имена по алфавиту.
 */
export function decisionsOfFiles(files: PrFile[], modules: Record<string, string[]>): { changed: Map<string, DecisionKind[]>; mechanical: string[] } {
  const out = new Map<string, { kinds: Set<DecisionKind>; changed: boolean }>();
  const add = (name: string, kind: DecisionKind, f: PrFile) => {
    const d = out.get(name) ?? { kinds: new Set(), changed: false };
    d.kinds.add(kind);
    d.changed ||= !mechanical(f);
    out.set(name, d);
  };
  const byDir = Object.fromEntries(DECISION_KINDS.map((k) => [DECISIONS[k].dir, k])) as Record<string, DecisionKind>;
  for (const f of files) {
    const parts = f.path.split("/");
    if (parts[0] === "tests") {
      const kind = byDir[parts[1] ?? ""];
      if (kind && parts.length > 3) add(parts[2]!, kind, f);
      continue;
    }
    let best: [string, number] | null = null;
    for (const [m, dirs] of Object.entries(modules)) {
      for (const d of dirs) if ((f.path === d || f.path.startsWith(d + "/")) && (!best || d.length > best[1])) best = [m, d.length];
    }
    if (best) add(best[0], "architecture", f);
  }
  const names = [...out.keys()].sort();
  return {
    changed: new Map(names.filter((n) => out.get(n)!.changed).map((n) => [n, DECISION_KINDS.filter((k) => out.get(n)!.kinds.has(k))])),
    mechanical: names.filter((n) => !out.get(n)!.changed),
  };
}

/**
 * Задачи, которые закрывает PR, по телу — как их понимает GitHub: ключевое слово (close, fix, resolve в любой форме)
 * перед каждым `#N`; «Closes #1, #2» закрывает только #1.
 */
function closingInBody(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) if (!out.includes(Number(m[1]))) out.push(Number(m[1]));
  return out;
}

export function cmdPrLabels(io: Io, slug: string, number: number): number {
  const [owner, name] = slug.split("/") as [string, string];
  let head: Any = null;
  const files = pages<PrFile>((after) => {
    const pr = graphql(io, Q.PrChange, { owner, name, number, after })?.repository?.pullRequest;
    if (!pr) throw new GhError(`PR #${number} в ${slug} нет`);
    head ??= pr;
    return pr.files;
  });
  let closes: number[] = (head.closingIssuesReferences?.nodes ?? []).map((x: Any) => x.number);
  // сразу после создания PR GitHub ещё не связал его с задачей — те же ключевые слова в теле
  if (!closes.length) closes = closingInBody(head.body ?? "");
  if (!closes.length) throw new GhError(`в PR #${number} нет «Closes #N» — метки ставить некуда`);
  // модули — из головы PR: PR может добавить модуль или перенести его каталог
  const model = graphql(io, Q.ModelAt, { owner, name, expression: `${head.headRefOid}:${MODEL_PATH}` })?.repository?.object;
  let modules: Record<string, string[]> = {};
  if (model) {
    const m = modelModules(model.text ?? "");
    if (typeof m === "string") io.err(`предупреждение: модель ${MODEL_PATH} головы PR не загружается — модули не учтены: ${m}`);
    else modules = m;
  }
  const { changed: decided, mechanical: skipped } = decisionsOfFiles(files, modules);
  const want = [...decided.keys()];
  io.out(`PR #${number} → ${closes.map((n) => `#${n}`).join(", ")}: ${want.join(", ") || "решений в диффе нет"}`);
  for (const l of skipped) io.out(`○ ${l} — только механическая правка (удаление, переименование без правки, exceptions.ts): метка не ставится`);
  if (!want.length) return 0;

  const all = loadLabels(io, slug);
  const fresh = want.filter((l) => !all.some((x) => x.name === l));
  const repoId = fresh.length ? loadRepo(io, slug).id : "";
  for (const l of fresh) {
    const label = decisionLabel(l, decided.get(l)!);
    const created = mutate(io, { op: "CreateLabel", input: { repositoryId: repoId, ...label } }).createLabel.label;
    all.push({ id: created.id, ...label, open: { total: 0, numbers: [] } });
    io.out(`+ создана метка ${q(l)}`);
  }
  const isDecision = (n: string) => legacyDecision(n) !== null || labelKinds(all.find((x) => x.name === n)?.description) !== null;
  const epics = new Map<number, Issue>();
  for (const n of closes) {
    const issue = loadIssue(io, slug, n);
    const added = addLabels(io, issue, want, all);
    if (added) io.out(`+ #${n}: ${added}`);
    // прежние метки не снимаем: задача могла трогать решение и другим PR
    for (const l of issue.labels.filter((x) => isDecision(x) && !want.includes(x))) io.out(`= #${n}: ${l} — решения нет в диффе PR, метка не снята`);
    if (issue.parent && !epics.has(issue.parent.number)) epics.set(issue.parent.number, loadIssue(io, slug, issue.parent.number));
  }
  for (const epic of epics.values()) {
    const added = addLabels(io, epic, want, all);
    if (added) io.out(`+ эпик #${epic.number}: ${added}`);
  }
  return 0;
}

// ----------------------------------------------------------------------------
// Очередь мержа
// ----------------------------------------------------------------------------

interface QueuePr {
  number: number;
  title: string;
  head: string;
  draft: boolean;
  /** Коммитов основной ветки, которых нет в ветке PR; `null` — ветки PR нет. */
  behind: number | null;
  /** Сводный статус CI головы PR; `null` — чеков ещё нет. */
  ci: string | null;
}

/** Почему PR очередь не держит; держит — null. Чеков ещё нет — держит: CI вот-вот начнётся. */
function outOfQueue(p: QueuePr, base: string): string | null {
  if (p.draft) return "черновик";
  if (p.behind === null) return "ветки нет";
  if (p.behind > 0) return `отстаёт от ${base} на ${p.behind}`;
  if (p.ci === "FAILURE" || p.ci === "ERROR") return "CI красный";
  return null;
}
const ciText = (ci: string | null) => (ci === "SUCCESS" ? "CI зелёный, ждёт мержа" : ci === null ? "чеков ещё нет" : "CI идёт");

/**
 * Голова очереди мержа — открытый PR в основную ветку, который от неё не отстаёт и у которого CI зелёный или идёт;
 * из нескольких — меньший номер. Своя ветка вне очереди (отстаёт, красная, PR ещё нет) — впереди все PR очереди.
 * Код 0 — голова, 1 — не голова.
 */
export function cmdPrQueue(io: Io, slug: string, who: { number: number } | { head: string }): number {
  const [owner, name] = slug.split("/") as [string, string];
  const base: string | undefined = graphql(io, Q.DefaultBranch, { owner, name })?.repository?.defaultBranchRef?.name;
  if (!base) throw new GhError(`у ${slug} нет основной ветки`);
  const prs: QueuePr[] = (graphql(io, Q.MergeQueue, { owner, name, base })?.repository?.pullRequests?.nodes ?? [])
    .filter(Boolean)
    .map((p: Any) => ({
      number: p.number,
      title: p.title,
      head: p.headRefName,
      draft: !!p.isDraft,
      // сравнение невозможно (ветка в форке) — считаем актуальной: лучше подождать, чем гонять CI впустую
      behind: p.headRef ? (p.headRef.compare?.aheadBy ?? 0) : null,
      ci: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    }))
    .sort((a: QueuePr, b: QueuePr) => a.number - b.number);
  const own = "number" in who ? prs.find((p) => p.number === who.number) : prs.find((p) => p.head === who.head);
  if ("number" in who && !own) throw new GhError(`PR #${who.number} — не открытый PR в ${base} репозитория ${slug}`);

  io.out(`Очередь мержа ${slug} → ${base}`);
  const holds = (p: QueuePr) => outOfQueue(p, base) === null;
  const ownHolds = !!own && holds(own);
  const others = prs.filter((p) => p !== own);
  for (const p of others) {
    const why = outOfQueue(p, base);
    if (why) io.out(`○ #${p.number} — ${why}, очередь не держит`);
  }
  const branch = "head" in who ? who.head : "";
  const me = own ? `#${own.number}` : `ветка ${branch}`;
  if (!own) io.out(`у ветки ${branch} ещё нет PR`);
  const ahead = others.filter((p) => holds(p) && (!ownHolds || p.number < own!.number));
  if (ahead.length) {
    io.out(`⚠ ${me} — не голова очереди: впереди ${ahead.map((p) => `#${p.number} ${q(p.title)} (${ciText(p.ci)})`).join(", ")}`);
    io.out(`  ребейз — локально, push — после их мержа: голова напишет «влит, твоя очередь»`);
    return 1;
  }
  const state = own && !ownHolds ? ` (сейчас: ${outOfQueue(own, base)})` : "";
  io.out(`✅ ${me} — голова очереди: ребейз на ${base}, push, CI и мерж — твои${state}`);
  const next = others.filter(holds);
  if (next.length) io.out(`  за тобой: ${nums(next)} — после мержа напиши им «влит, твоя очередь»`);
  return 0;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `github — проект и задачи GitHub репозитория по канону AGENTS.md

  github project check [--repo owner/repo]
  github project fix   [--repo owner/repo] [--confirm] [--template owner/N | none]
  github task new      --title "…" [--body "…" | --body-file F] [--type Задача|Баг|Эпик] [--epic N]
                       [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low]
                       [--labels <решение>,<вид>:<новое решение>,<метка>] [--repo owner/repo]
  github task status   <N> <Бэклог|В работе|Готово> [--repo owner/repo]
  github task drop     <N> [--duplicate-of M] [--repo owner/repo]
  github task close    <N> [--no-git] [--repo owner/repo]
  github pr labels     <N> [--repo owner/repo]
  github pr queue      [<N> | --head <ветка>] [--repo owner/repo]

check — пункты ✅/❌, код 0 — всё по канону, 1 — есть ❌; метки решений — по дереву спеки основной ветки,
        метка нового решения на открытой задаче — строка ○, не ❌.
fix   — исправляет через API; шаги UI печатает со ссылками; удаление и переименование в проекте
        с задачами и настройки организации — только с --confirm (после «да» пользователя).
        Проекта нет — привязывает одноимённый, иначе копирует эталон (${DEFAULT_TEMPLATE}), иначе создаёт.
task  — задача по канону; new печатает созданное и следующий шаг (оценка через est).
task close — после мержа PR (или закрытия без PR) одним вызовом: факт (est fact --write), Status «Готово»,
        эпик и milestone, влитая ветка долой (--no-git — без git); актуализация блока — субагентом.
pr labels — метки решений по диффу PR задачам из «Closes #N» и их эпикам; прежние не снимает; решение, тронутое
            только механически (удаление, переименование без правки, exceptions.ts), — строка ○, без метки.
pr queue  — голова ли PR (по умолчанию — PR текущей ветки) в очереди мержа основной ветки: код 0 — голова,
            push, CI и мерж — твои; 1 — не голова, впереди названы PR; ребейз — локально, push — после их мержа.`;

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

function currentBranch(): string {
  const r = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" });
  const b = (r.stdout ?? "").trim();
  if (r.status !== 0 || !b) throw new GhError("не удалось определить текущую ветку (detached HEAD?); укажите номер PR или --head <ветка>");
  return b;
}

export function main(argv: string[], io: Io): number {
  try {
    const [group, cmd, ...rest] = argv;
    if (!group || group === "-h" || group === "--help") {
      io.out(USAGE);
      return group ? 0 : 2;
    }
    const known: Record<string, string[]> = { project: ["check", "fix"], task: ["new", "status", "drop", "close"], pr: ["labels", "queue"] };
    if (!known[group]?.includes(cmd ?? "")) {
      io.err(`неизвестная команда «${argv.slice(0, 2).join(" ")}»; ожидается project check|fix, task new|status|drop|close или pr labels|queue`);
      return 2;
    }
    if (io.env.CLAUDE_CODE_REMOTE === "true" && group === "task" && cmd === "close") {
      const n = /^#?(\d+)$/.exec(rest.find((a) => !a.startsWith("--")) ?? "")?.[1] ?? "<N>";
      io.err(`облачная сессия: task close ей недоступен — GitHub Projects в облаке нет (docs/cloud-sessions.md). Факт — комментарий «Факт (облако)» печатает est fact ${n}; «Готово» поставит workflow проекта «Item closed»; ветка и контейнер облака временные, убирать нечего.`);
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
    if (group === "pr") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { repo: { type: "string" }, head: { type: "string" } } });
      if (positionals.length > 1) throw new GhError(`лишние аргументы: ${positionals.slice(1).join(" ")}`);
      const m = /^#?(\d+)$/.exec((positionals[0] ?? "").trim());
      if (cmd === "queue") {
        if (positionals.length && !m) throw new GhError(`pr queue: ожидается номер PR, а не «${positionals[0]}»`);
        if (m && values.head) throw new GhError("номер PR или --head, не оба");
        return cmdPrQueue(io, repoOf(values.repo), m ? { number: Number(m[1]) } : { head: values.head ?? currentBranch() });
      }
      if (values.head) throw new GhError("--head — только у pr queue");
      if (!m) throw new GhError(`pr labels: ожидается номер PR, а не «${positionals[0] ?? ""}»`);
      return cmdPrLabels(io, repoOf(values.repo), Number(m[1]));
    }
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
          labels: { type: "string" },
          "no-git": { type: "boolean", default: false },
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
        const labels = (values.labels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return cmdTaskNew(io, slug, { title: values.title, body, type: values.type!, epic, milestone: values.milestone, blockedBy, priority: values.priority, labels });
      }
      const number = issueNumber(positionals[0], `task ${cmd}`);
      if (cmd === "status") return cmdTaskStatus(io, slug, number, positionals.slice(1).join(" "));
      if (positionals.length > 1) throw new GhError(`лишние аргументы: ${positionals.slice(1).join(" ")}`);
      if (cmd === "close") return cmdTaskClose(io, slug, number, { git: !values["no-git"] });
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
