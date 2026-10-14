#!/usr/bin/env bun
/**
 * github — the repository's GitHub project and tasks by the canon (AGENTS.md, "Task tracking"; the full rules are in
 * reference.md next to SKILL.md: types, decision labels, epics, the project, milestones, epic refresh).
 *
 * Subcommands:
 *   github project check — a check against the canon, item by item ✅/❌
 *   github project fix   — bring it to the canon: API, UI steps with links, deleting and renaming — with --confirm
 *   github task new      — a task in one command: type or label, project and Backlog, Priority, epic, blocked by,
 *                          milestone, decision labels (the decision's name, the kind by color) and the estimate (est)
 *   github task status   — Status in the project (and the epic's "In progress" once its first subtask is taken);
 *                          "In progress" pins the task to the session — another task in the same session is refused
 *   github task drop     — close without doing it and remove from the project
 *   github task actualize — after the merge, in parallel with the deploy: the epic-refresh subagent's assignment
 *                          (or "not needed")
 *   github task close    — after the merge and the deploy: the actual, "Done", the epic and the milestone, the task's
 *                          stacks (task-env) and the merged branch removed
 *   github pr labels     — decision labels for the task from "Closes #N" by the PR diff, for its epic — the union
 *   github pr premerge   — before the merge: the default branch moved after the PR's CI — typecheck and test:spec on
 *                          the merge with it
 *
 * Runs on Bun (`bun github.ts …`), only `node:` APIs + the `gh` CLI. Check and fix are one function, `analyze`: each
 * discrepancy carries its own fix step, so `check` and `fix` don't diverge.
 * Decision labels are checked against the spec tree of the default branch; the architecture model is read by a
 * separate process of the same runtime (`modelModules`). Merging into the default branch — the `ai-dev` ruleset:
 * required checks, green on the last merged PRs; the merge method — rebase only (a repository setting, REST).
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import locale from "./locale.ts";
import type { Names } from "./locale.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ----------------------------------------------------------------------------
// Canon
// ----------------------------------------------------------------------------

/**
 * Canon names in the project language (`locales/<language>.json`, the `locale.ts` module): views, Status options,
 * fields, issue types, label markers, sections, comments. The language is the one of the project of the `io.cwd`
 * directory, `main` sets it; parsing — by the names of any dictionary language (`locale.every`).
 */
let N: Names = locale.names(locale.projectLanguage());

const canonViews = () => [
  { name: N.views.board, layout: "BOARD_LAYOUT" },
  { name: N.views.table, layout: "TABLE_LAYOUT" },
  { name: N.views.roadmap, layout: "ROADMAP_LAYOUT" },
];
export const STATUS = "Status";
const statusOptions = () => [N.status.backlog, N.status.inProgress, N.status.done];
const numberFields = () => [N.fields.estimate, N.fields.actual, N.fields.tokens, N.fields.cost];
const issueTypes = () => [N.issueTypes.task, N.issueTypes.bug, N.issueTypes.epic];
export const PRIORITY = "Priority";
/** Priority options from the most urgent; a new task gets Medium, an epic — no lower than its most urgent subtask. */
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"] as const;
export const DEFAULT_PRIORITY = "Medium";
/** A personal account has no issue types — an epic is marked with a label, the only exception. */
export const EPIC_LABEL = "epic";
const epicLabel = () => ({ name: EPIC_LABEL, color: "8250DF", description: N.labels.epicDescription });
/**
 * Decision labels: the name is the decision's name (a spec tree folder or a model module), the kind is the color.
 * Decisions of different kinds with one name are one label: the color of the senior kind (the order here), all of them
 * in the description. For architecture a decision is the rule `tests/architecture/<name>` or a module of the model
 * `tests/architecture/model.ts`.
 */
export const DECISIONS = {
  capability: { dir: "capabilities", color: "0E8A16" },
  standard: { dir: "standards", color: "1D76DB" },
  // not FBCA04: the "questions" label has it, and a decision label's kind shows only by color
  architecture: { dir: "architecture", color: "D93F0B" },
} as const;
export type DecisionKind = keyof typeof DECISIONS;
const DECISION_KINDS = Object.keys(DECISIONS) as DecisionKind[];
const MODEL_PATH = "tests/architecture/model.ts";
export const WORKFLOW_ADDED = "Item added to project";
export const WORKFLOW_CLOSED = "Item closed";
export const WORKFLOW_AUTO_ADD = "Auto-add to project";
/** The template: a new project is its copy (views, fields, configured workflows except auto-add). */
export const DEFAULT_TEMPLATE = "miroshnik/6";
/**
 * The default-branch ruleset that fix sets: GitHub doesn't let a branch with a red required check be merged. It doesn't
 * require the branch to be up to date (strict is off): the next PR's CI shows that two green PRs are incompatible.
 */
export const RULESET = "ai-dev";
/** A required check is green on each of this many last merged PRs with checks. */
export const STABLE_PRS = 10;
/** The repository admin role (`repositoryRoleDatabaseId`) bypasses the ruleset: direct push, `gh pr merge --admin`. */
const ADMIN_ROLE = 5;

/**
 * Status options of a new project and names in the dictionary's other languages → the name in the project language:
 * renaming with the same id keeps the tasks' values and the target of the "Item closed" workflow (replacing all the
 * options gives new ids).
 */
function statusAliases(): Record<string, string> {
  const out: Record<string, string> = { todo: N.status.backlog, "to do": N.status.backlog, doing: N.status.inProgress };
  for (const n of locale.everyNames()) {
    out[n.status.backlog.toLowerCase()] = N.status.backlog;
    out[n.status.inProgress.toLowerCase()] = N.status.inProgress;
    out[n.status.done.toLowerCase()] = N.status.done;
  }
  return out;
}
/** Issue types in any dictionary language (and `task`, `bug`, `epic`) → the type in the project language. */
function typeAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of locale.everyNames()) {
    out[n.issueTypes.task.toLowerCase()] = N.issueTypes.task;
    out[n.issueTypes.bug.toLowerCase()] = N.issueTypes.bug;
    out[n.issueTypes.epic.toLowerCase()] = N.issueTypes.epic;
  }
  return out;
}
/** Project fields in any dictionary language → the field in the project language. */
function fieldAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of locale.everyNames()) {
    out[n.fields.estimate] = N.fields.estimate;
    out[n.fields.actual] = N.fields.actual;
    out[n.fields.tokens] = N.fields.tokens;
    out[n.fields.cost] = N.fields.cost;
  }
  return out;
}
// Built-in project fields; custom ones are everything else (TEXT, NUMBER, DATE, SINGLE_SELECT, ITERATION…).
const BUILTIN_FIELDS = new Set(["TITLE", "ASSIGNEES", "LABELS", "LINKED_PULL_REQUESTS", "MILESTONE", "REPOSITORY", "REVIEWERS", "PARENT_ISSUE", "SUB_ISSUES_PROGRESS", "CREATED", "UPDATED", "CLOSED", "TRACKS", "TRACKED_BY", "ISSUE_TYPE"]);
const NOT_DONE_REASONS = new Set(["NOT_PLANNED", "DUPLICATE"]);

// ----------------------------------------------------------------------------
// Model
// ----------------------------------------------------------------------------

export interface Io {
  /** `gh` with arguments and stdin → stdout; an error is an exception. An external edge: replaced in tests. */
  gh: (args: string[], stdin?: string) => string;
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** A pause before re-reading (GitHub doesn't show additions right away); in tests — no waiting. */
  sleep?: (ms: number) => void;
  /** A subprocess (`est`, `git` of `task close`) — an external edge: replaced in tests. */
  run?: (cmd: string, args: string[], cwd?: string) => RunResult;
  /**
   * The project checkout: its language (`.agents/ai-dev.json`) is the language of names, `task close` runs its git
   * steps in it; the current directory by default.
   */
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
  /** The workflow address in the UI uses it, not number: `<project>/workflows/<fullDatabaseId>`. */
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
  /** Open tasks with the label: how many in total and the numbers of the first OPEN_SHOWN. */
  open: { total: number; numbers: number[] };
}
/** Default-branch decisions by kind; the model didn't load — the reason, and then `architecture` has no modules. */
export interface Decisions {
  names: Record<DecisionKind, string[]>;
  modelError: string | null;
}
/** A PR head's check: green, still running, or otherwise (red, skipped, cancelled). */
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
/** Merging into the default branch: its active rules with required checks and the checks of PR heads into it. */
export interface Merge {
  branch: string;
  /** Branch rules are unavailable on the plan (a private repository on Free) — the reason from GitHub. */
  unavailable: string | null;
  /** Active rules with required checks: a ruleset of any level and classic branch protection. */
  rules: { source: string; contexts: string[] }[];
  /** Our own ruleset — this repository's `RULESET`, in any state. */
  own: Ruleset | null;
  /** The last `STABLE_PRS` merged PRs with checks, oldest to newest. */
  merged: Head[];
  /** Open PRs whose checks have all finished: a check they don't have won't come. */
  open: Head[];
  /** Allowed PR merge methods (a repository setting): merge commit, squash, rebase. */
  methods: { merge: boolean; squash: boolean; rebase: boolean };
}
export interface State {
  repo: { id: string; name: string; nameWithOwner: string; owner: Owner; linked: ProjectRef[] };
  project: Project | null;
  openIssues: { id: string; number: number }[];
  labels: Label[];
  /** Tasks of old `kind:name` labels that merge into an already taken name: by label id. */
  labelIssues: Record<string, { id: string; number: number }[]>;
  decisions: Decisions;
  /** An empty repository (no default branch) — null. */
  merge: Merge | null;
}

interface Mutation {
  op: string;
  input: Record<string, unknown>;
}
/**
 * A fix step: `api` — fix does it; `confirm` — only with --confirm (deleting, renaming, the organization);
 * `ui` — by hand via the link. `sticky` — a UI step stays in the list even when fix has already removed the symptom.
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
  /** Not a discrepancy but the state of things (a new decision's label): an `○` line, the item stays ✅. */
  notes: string[];
  /** The item doesn't apply (plan, no checks): a `➖` line with the reason instead of ✅/❌. */
  skip?: string;
}

export class GhError extends Error {}

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const REF = "id number title url closed";
/** Numbers of the label's open tasks in the "new decision" line; the rest as a count. */
const OPEN_SHOWN = 10;
/**
 * How many recent PRs task close looks at when the PR isn't linked to the task: it's called right after the merge, so
 * the PR is among them.
 */
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
      subIssues(first: 100) { nodes { number state title } }
      milestone { id number title issues(states: OPEN) { totalCount } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number state merged headRefName baseRefName } }
      projectItems(first: 20) { nodes { id project { id } status: fieldValueByName(name: "${STATUS}") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
      issueFieldValues(first: 20) { nodes { __typename ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } } } }
    }
  }
}`,
  TaskContext: `query TaskContext($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    label(name: "${EPIC_LABEL}") { id }
    milestones(first: 100, states: OPEN) { nodes { id title } }
  }
}`,
  // HEAD is the default branch: labels are checked against what's already merged
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
  // Ref.rules — the rules of active rulesets (of the repository and the organization) that GitHub applies to the branch
  MergeRules: `query MergeRules($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    isPrivate mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    defaultBranchRef {
      name
      branchProtectionRule { requiredStatusCheckContexts }
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
  // The task's PR that GitHub didn't link to it (task close): the latest open and merged ones, newest first
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

// Mutations take one $input parameter: input has only the given keys (GitHub reads null in input as "erase").
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

/**
 * REST mutations — what GraphQL lacks: the repository's merge settings (`UpdateRepositoryInput` doesn't know them).
 * Input — `repo` and the request fields; `gh api -F` sends true/false as booleans.
 */
const REST: Record<string, (input: Record<string, unknown>) => string[]> = {
  UpdateRepository: ({ repo, ...fields }) => ["api", "-X", "PATCH", `repos/${repo}`, ...Object.entries(fields).flatMap(([k, v]) => ["-F", `${k}=${v}`])],
};

function mutationQuery(op: string): string {
  const spec = M[op];
  if (!spec) throw new GhError(`unknown mutation ${op}`);
  const [field, inputType, select] = spec;
  return `mutation ${op}($input: ${inputType}!) { ${field}(input: $input) { ${select} } }`;
}

/** A GraphQL query; partial data with errors — a warning, but for a mutation (strict) an error: no result received. */
export function graphql(io: Io, query: string, variables: Record<string, unknown>, strict = false): Any {
  const out = io.gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api graphql: the response is not JSON: ${out.slice(0, 200)}`);
  }
  const errors: string[] = (res.errors ?? []).map((e: Any) => e.message ?? String(e));
  if (errors.length && (!res.data || strict)) throw new GhError(`GraphQL: ${errors.join("; ")}`);
  if (errors.length) io.err(`GraphQL warning: ${errors.join("; ")}`);
  return res.data;
}

function mutate(io: Io, m: Mutation): Any {
  const rest = REST[m.op];
  return rest ? restCall(io, rest(m.input)) : graphql(io, mutationQuery(m.op), { input: m.input }, true);
}

/** A REST request; an error response (realGh returns JSON even with a code ≠ 0) is an exception with its message. */
function restCall(io: Io, args: string[]): Any {
  // `-X PATCH repos/…` or GET `repos/…`
  const what = args.slice(1).filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
  const out = io.gh(args);
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`${what}: the response is not JSON: ${out.slice(0, 200)}`);
  }
  if (res?.message && res.id === undefined) throw new GhError(`${what}: ${res.message}`);
  return res;
}

/** The real `gh`: an exit code ≠ 0 is an exception with stderr. */
export function realGh(args: string[], stdin?: string): string {
  const r = spawnSync("gh", args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new GhError("gh command not found; the gh CLI must be installed");
    throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.error.message}`);
  }
  // gh api graphql exits with 1 on GraphQL errors, but the JSON with errors is in stdout — let graphql() parse it
  if (r.status !== 0 && !r.stdout.trim().startsWith("{")) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || "").trim().slice(0, 500)}`);
  return r.stdout;
}

// ----------------------------------------------------------------------------
// Reading the state
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
  if (!r) throw new GhError(`repository ${slug} not found or no access`);
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

/** The repository's project: a linked one titled with the repository name, otherwise the first open linked one. */
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

/** A PR head's checks by name; a rerun of the same check is green if any of its runs is green. */
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

/** A private repository on Free: GraphQL silently returns empty rules, REST — 403 "Upgrade to GitHub Pro…". */
function rulesetsUnavailable(io: Io, slug: string): string | null {
  const out = io.gh(["api", `repos/${slug}/rulesets`]);
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api repos/${slug}/rulesets: the response is not JSON: ${out.slice(0, 200)}`);
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
    return sc ? [{ source: `ruleset ${q(x.repositoryRuleset?.name ?? "?")}`, contexts: sc.contexts }] : [];
  });
  if (bp?.requiredStatusCheckContexts?.length) rules.push({ source: "branch protection", contexts: bp.requiredStatusCheckContexts });
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
    methods: { merge: !!r.mergeCommitAllowed, squash: !!r.squashMergeAllowed, rebase: !!r.rebaseMergeAllowed },
  };
}

/** Tasks of old labels whose name is taken (by another label or an old label earlier in the list) — fix merges them. */
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
 * Architecture model modules and their directories: the model text goes to a temporary file, `modules` is printed by
 * a separate process of the same runtime (Bun strips types; the model doesn't need the spec skill's `import type`).
 * Didn't load — the reason as a string.
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
    const r = spawnSync(process.execPath, ["--no-env-file", path.join(dir, "modules.mjs")], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return ((r.stderr || r.error?.message || "").trim().split("\n").find((l) => /error/i.test(l)) ?? "the process exited with an error").trim().slice(0, 200);
    return JSON.parse(r.stdout) as Record<string, string[]>;
  } catch (e) {
    return (e as Error).message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Default-branch decisions: spec tree folders by kind, and model modules for architecture. */
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

/**
 * `capability:billing` → the decision's kind and name; anything else — null. An old-form label or the kind of a new
 * decision in `--labels`.
 */
export function legacyDecision(label: string): { kind: DecisionKind; name: string } | null {
  const i = label.indexOf(":");
  const kind = label.slice(0, i) as DecisionKind;
  return i > 0 && DECISION_KINDS.includes(kind) && label.length > i + 1 ? { kind, name: label.slice(i + 1) } : null;
}

/**
 * A decision label is marked by its description `<marker> <paths>`: a regular label's color may match, and so may its
 * name. The marker is written in the project language and recognized in any dictionary language: fix rewrites a
 * description in another language rather than taking the label for a regular one.
 */
const decisionMark = () => `${N.labelMarkers.decision} `;
const decisionPath = (kind: DecisionKind, name: string) => (kind === "architecture" ? locale.fill(N.labelMarkers.architecturePath, { name }) : `tests/${DECISIONS[kind].dir}/${name}`);
/** The marker of any dictionary language the description starts with; none — null. */
const markOf = (description: string | null | undefined, marks: string[]) => marks.map((m) => `${m} `).find((m) => description?.startsWith(m)) ?? null;

/**
 * A decision label: the senior kind's color, the paths of all kinds in the description; GitHub won't accept one longer
 * than 100 characters — then the kinds.
 */
export function decisionLabel(name: string, kinds: DecisionKind[]): { name: string; color: string; description: string } {
  const ks = DECISION_KINDS.filter((k) => kinds.includes(k));
  const full = decisionMark() + ks.map((k) => decisionPath(k, name)).join("; ");
  return { name, color: DECISIONS[ks[0]!].color, description: full.length <= 100 ? full : decisionMark() + ks.join(", ") };
}

/** A decision label's kinds — by its description; a regular label — null. */
export function labelKinds(description: string | null | undefined): DecisionKind[] | null {
  const mark = markOf(description, locale.every((n) => n.labelMarkers.decision));
  if (!mark) return null;
  const parts = description!.slice(mark.length).split(/; |, /);
  return DECISION_KINDS.filter((k) => parts.some((p) => p === k || p.startsWith(`tests/${DECISIONS[k].dir}`)));
}

/**
 * A slice label is marked by its description `<slice marker> <slice>[ — note]` (the marker is `labelMarkers.slice` of
 * any dictionary language): a slice of the project's tasks (apps, teams), not a decision, though its name may match a
 * model module. The slice lives with the label, not in `.agents/ai-dev.json`: `install` and `update` rewrite the
 * install manifest, and `check` reads everything through the API.
 */
function labelDimension(description: string | null | undefined): string | null {
  const mark = markOf(description, locale.every((n) => n.labelMarkers.slice));
  if (!mark) return null;
  return description!.slice(mark.length).split(" — ")[0]!.trim() || null;
}

/** Default-branch decisions by name: name → its kinds (the senior one first). */
function decisionsByName(d: Decisions): Map<string, DecisionKind[]> {
  const out = new Map<string, DecisionKind[]>();
  for (const k of DECISION_KINDS) for (const n of d.names[k]) out.set(n, [...(out.get(n) ?? []), k]);
  return out;
}

function loadProject(io: Io, id: string, withItems = true): Project {
  const p = graphql(io, Q.ProjectState, { id }).node;
  if (!p) throw new GhError(`project ${id} not found or no access (needs the project scope: gh auth refresh -s project)`);
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
// Checking against the canon
// ----------------------------------------------------------------------------

const nums = (xs: { number: number }[]) => xs.map((x) => `#${x.number}`).join(", ");
const q = (s: string) => `«${s}»`;

/** All discrepancies with the canon by item; each has fix steps. No project — only the linking item. */
export function analyze(s: State): Check[] {
  const p = s.project;
  const checks: Check[] = [];
  const add = (key: string, title: string) => {
    const c: Check = { key, title, problems: [], notes: [] };
    checks.push(c);
    return Object.assign((text: string, ...steps: Step[]) => c.problems.push({ text, steps }), { note: (text: string) => c.notes.push(text), skip: (why: string) => void (c.skip = why) });
  };

  const link = add("link", `Project linked to the repository and named ${q(s.repo.name)}`);
  // the default-branch rule and the merge method don't depend on the project
  const merge = () => {
    if (!s.merge) return;
    analyzeMerge(s.merge, s.repo.id, add("merge", `Merge into ${s.merge.branch} — only with green required checks`));
    analyzeMethod(s.merge, s.repo.nameWithOwner, add("method", `PR merge method — rebase only`));
  };
  if (!p) {
    link("no open project is linked to the repository", { kind: "api", text: `find, copy from the template or create project ${q(s.repo.name)} and link it to ${s.repo.nameWithOwner}` });
    merge();
    return checks;
  }
  const used = p.items.length > 0;
  const guarded = (text: string, ...mutations: Mutation[]): Step => ({ kind: used ? "confirm" : "api", text, mutations });
  const api = (text: string, ...mutations: Mutation[]): Step => ({ kind: "api", text, mutations });
  const ui = (text: string, url: string): Step => ({ kind: "ui", text, url });

  if (p.title !== s.repo.name) link(`title ${q(p.title)}`, guarded(`rename project ${q(p.title)} → ${q(s.repo.name)}`, { op: "RenameProject", input: { projectId: p.id, title: s.repo.name } }));
  for (const other of s.repo.linked.filter((x) => x.id !== p.id)) {
    link(`another project is linked: ${q(other.title)} (${other.url})`, { kind: "confirm", text: `unlink project ${q(other.title)} from the repository`, mutations: [{ op: "UnlinkProject", input: { projectId: other.id, repositoryId: s.repo.id } }] });
  }

  // Views: by name; missing — rename an extra one of the same layout or create one; extra ones — delete.
  const views = add("views", `Views ${canonViews().map((v) => q(v.name)).join(", ")} — the right layout, no filter, no others`);
  const canonNames = new Set<string>(canonViews().map((v) => v.name));
  const spare = p.views.filter((v) => !canonNames.has(v.name));
  for (const c of canonViews()) {
    const v = p.views.find((x) => x.name === c.name);
    if (!v) {
      const cand = spare.find((x) => x.layout === c.layout);
      if (cand) {
        spare.splice(spare.indexOf(cand), 1);
        views(`missing ${q(c.name)}`, guarded(`rename view ${q(cand.name)} → ${q(c.name)}`, { op: "UpdateView", input: { viewId: cand.id, name: c.name } }));
      } else {
        views(`missing ${q(c.name)}`, api(`create view ${q(c.name)} (${c.layout})`, { op: "CreateView", input: { projectId: p.id, name: c.name, layout: c.layout } }));
      }
      continue;
    }
    if (v.layout !== c.layout) views(`${q(c.name)} — ${v.layout}`, api(`${q(c.name)}: layout ${c.layout}`, { op: "UpdateView", input: { viewId: v.id, layout: c.layout } }));
    if (v.filter) views(`${q(c.name)} has filter ${q(v.filter)}`, api(`${q(c.name)}: remove filter ${q(v.filter)}`, { op: "UpdateView", input: { viewId: v.id, filter: "" } }));
    if (c.layout === "BOARD_LAYOUT" && v.layout === c.layout && v.columnsBy[0] !== STATUS) {
      views(`${q(c.name)} columns not by Status`, ui(`${q(c.name)}: View options → Column by → Status → Save`, `${p.url}/views/${v.number}`));
    }
  }
  for (const v of spare) views(`extra ${q(v.name)}`, guarded(`delete view ${q(v.name)}`, { op: "DeleteView", input: { viewId: v.id } }));

  // Status: options by name or by a known English name — with the same id; missing ones — new.
  const status = add("status", `${STATUS}: ${statusOptions().join(" → ")}`);
  const sf = p.fields.find((f) => f.name === STATUS && f.options);
  if (!sf) {
    status(`no ${STATUS} field`, api(`create field ${STATUS}`, { op: "CreateField", input: { projectId: p.id, dataType: "SINGLE_SELECT", name: STATUS, singleSelectOptions: statusOptions().map((name) => ({ name, color: "GRAY", description: "" })) } }));
  } else if (sf.options!.map((o) => o.name).join("\n") !== statusOptions().join("\n")) {
    const left = [...sf.options!];
    const take = (pred: (o: Option) => boolean) => {
      const i = left.findIndex(pred);
      return i < 0 ? null : left.splice(i, 1)[0]!;
    };
    const aliases = statusAliases();
    const next = statusOptions().map((name) => {
      const o = take((x) => x.name === name) ?? take((x) => aliases[x.name.toLowerCase()] === name);
      return o ? { id: o.id, name, color: o.color, description: o.description ?? "" } : { name, color: "GRAY", description: "" };
    });
    const drop = left.length ? `; delete ${left.map((o) => q(o.name)).join(", ")}` : "";
    status(`options: ${sf.options!.map((o) => o.name).join(", ") || "none"}`, guarded(`${STATUS}: ${statusOptions().join(", ")} (rename the existing ones keeping the id${drop})`, { op: "UpdateField", input: { fieldId: sf.id, singleSelectOptions: next } }));
  }

  // Fields: four numeric ones; a field in another dictionary language is renamed with the same id (the tasks' values are
  // kept); no custom fields beyond the canon; in an organization Priority is an issue field.
  const fields = add("fields", `Fields ${numberFields().map(q).join(", ")} (Number), no other custom ones`);
  const fieldAlias = fieldAliases();
  const renamed = new Set<Field>();
  for (const name of numberFields()) {
    const f = p.fields.find((x) => x.name === name);
    const create: Mutation = { op: "CreateField", input: { projectId: p.id, dataType: "NUMBER", name } };
    const other = f ? undefined : p.fields.find((x) => x.dataType === "NUMBER" && !renamed.has(x) && fieldAlias[x.name] === name);
    if (other) {
      renamed.add(other);
      fields(`missing ${q(name)}`, guarded(`rename field ${q(other.name)} → ${q(name)} (task values are kept)`, { op: "UpdateField", input: { fieldId: other.id, name } }));
    } else if (!f) fields(`missing ${q(name)}`, api(`create field ${q(name)} (Number)`, create));
    else if (f.dataType !== "NUMBER") fields(`${q(name)} — ${f.dataType}`, { kind: "confirm", text: `recreate field ${q(name)} as Number (the field's values will be lost)`, mutations: [{ op: "DeleteField", input: { fieldId: f.id } }, create] });
  }
  const orgPriority = s.repo.owner.org ? s.repo.owner.issueFields.find((f) => f.name === PRIORITY) : undefined;
  const isCanon = (f: Field) => BUILTIN_FIELDS.has(f.dataType) || f.name === STATUS || numberFields().includes(f.name) || (s.repo.owner.org && f.isIssueField && f.name === PRIORITY);
  const ownPriority = p.fields.find((f) => f.name === PRIORITY && !f.isIssueField);
  for (const f of p.fields.filter((x) => !isCanon(x) && x !== ownPriority && !renamed.has(x))) {
    fields(`extra ${q(f.name)} (${f.dataType}${f.isIssueField ? ", issue field" : ""})`, guarded(`delete field ${q(f.name)}`, { op: "DeleteField", input: { fieldId: f.id } }));
  }
  if (ownPriority && !s.repo.owner.org) fields(`extra ${q(PRIORITY)} — a personal account keeps no priority`, guarded(`delete field ${q(PRIORITY)}`, { op: "DeleteField", input: { fieldId: ownPriority.id } }));

  if (s.repo.owner.org) {
    const org = s.repo.owner.login;
    const prio = add("priority", `${PRIORITY} — the organization's issue field in the project, ${q(N.views.table)} and ${q(N.views.board)} are sorted by it`);
    const connected = p.fields.some((f) => f.isIssueField && f.name === PRIORITY);
    if (!connected) {
      const connect: Mutation[] = orgPriority ? [{ op: "AddIssueField", input: { projectId: p.id, issueFieldId: orgPriority.id } }] : [];
      if (ownPriority) {
        prio(`own project field ${q(PRIORITY)} instead of the issue field`, { kind: "confirm", text: `delete the own field ${q(PRIORITY)} and connect the issue field ${PRIORITY}`, mutations: [{ op: "DeleteField", input: { fieldId: ownPriority.id } }, ...connect] });
      } else if (orgPriority) {
        prio(`issue field ${PRIORITY} not connected`, api(`connect the issue field ${PRIORITY}`, ...connect));
      }
      if (!orgPriority) prio(`the organization has no issue field ${PRIORITY}`, ui(`create the issue field ${PRIORITY} (single select: Urgent, High, Medium, Low), then fix again`, `https://github.com/organizations/${org}/settings/issue-fields`));
    }
    for (const name of [N.views.table, N.views.board]) {
      const v = p.views.find((x) => x.name === name);
      if (v && v.sortBy[0] !== PRIORITY) prio(`${q(name)} not sorted by ${PRIORITY}`, ui(`${q(name)}: View options → Sort by → ${PRIORITY} → Save`, `${p.url}/views/${v.number}`));
    }

    const types = add("types", `Issue types of the organization: ${issueTypes().join(", ")} — and only these`);
    const t = s.repo.owner.issueTypes;
    const url = `https://github.com/organizations/${org}/settings/issue-types`;
    const claimed = new Set<string>();
    const aliases = typeAliases();
    for (const name of issueTypes()) {
      const exact = t.find((x) => x.name === name);
      if (exact) {
        claimed.add(exact.id);
        if (!exact.isEnabled) types(`${q(name)} disabled`, { kind: "confirm", text: `enable type ${q(name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: exact.id, isEnabled: true } }] });
        continue;
      }
      const alias = t.find((x) => !claimed.has(x.id) && aliases[x.name.toLowerCase()] === name);
      if (alias) {
        claimed.add(alias.id);
        types(`missing ${q(name)}`, { kind: "confirm", text: `rename type ${q(alias.name)} → ${q(name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: alias.id, name, isEnabled: true } }] });
      } else {
        types(`missing ${q(name)}`, { kind: "confirm", text: `create type ${q(name)}`, url, mutations: [{ op: "CreateIssueType", input: { ownerId: s.repo.owner.id, name, isEnabled: true, color: name === N.issueTypes.epic ? "PURPLE" : name === N.issueTypes.bug ? "RED" : "GRAY" } }] });
      }
    }
    for (const x of t.filter((x) => x.isEnabled && !claimed.has(x.id))) {
      types(`extra ${q(x.name)}`, { kind: "confirm", text: `disable type ${q(x.name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: x.id, isEnabled: false } }] });
    }
  }

  // Workflows: the API doesn't turn them on or show the target — only the UI. An unconfigured one isn't in the list.
  const wf = add("workflows", `Workflows ${[WORKFLOW_ADDED, WORKFLOW_CLOSED, WORKFLOW_AUTO_ADD].map(q).join(", ")} are on`);
  const how: Record<string, string> = {
    [WORKFLOW_ADDED]: `Edit → Set value → ${STATUS}: ${N.status.backlog}`,
    [WORKFLOW_CLOSED]: `Edit → Set value → ${STATUS}: ${N.status.done}`,
    // is:open — otherwise an updated closed task (not planned too) comes back into the project
    [WORKFLOW_AUTO_ADD]: `Edit → repository ${s.repo.name}, filter is:issue is:open (Enter)`,
  };
  for (const name of [WORKFLOW_ADDED, WORKFLOW_CLOSED, WORKFLOW_AUTO_ADD]) {
    const w = p.workflows.find((x) => x.name === name);
    if (w?.enabled) continue;
    // an unconfigured workflow isn't in the API — a link to the list, it's in the menu on the left there
    wf(`${q(name)} ${w ? "disabled" : "not configured"}`, ui(`${q(name)}: ${how[name]} → Save and turn on workflow`, `${p.url}/workflows${w ? `/${w.fullDatabaseId}` : ""}`));
  }

  // Tasks: statuses by the canon. Closed ones not in "Done" — a symptom of "Item closed" on a deleted Status option.
  const opt = (name: string) => sf?.options?.find((o) => o.name === name)?.id;
  const setStatus = (it: Item, name: string): Mutation => ({ op: "SetItemStatus", input: { projectId: p.id, itemId: it.id, fieldId: sf!.id, value: { singleSelectOptionId: opt(name) } } });
  const statusReady = !!(opt(N.status.backlog) && opt(N.status.done));
  const closedAdd = add("closed", `Closed tasks — in ${q(N.status.done)}, closed without being done — outside the project`);
  const issues = p.items.filter((it) => it.issue);
  // "Done" in another dictionary language is the same option: the Status item renames it, no need to move tasks
  const doneAlias = statusAliases();
  const notDone = issues.filter((it) => it.issue!.state === "CLOSED" && !NOT_DONE_REASONS.has(it.issue!.stateReason ?? "") && doneAlias[(it.status ?? "").toLowerCase()] !== N.status.done);
  if (notDone.length) {
    const steps: Step[] = [];
    if (statusReady) steps.push(api(`${STATUS} ${q(N.status.done)}: ${nums(notDone.map((it) => it.issue!))}`, ...notDone.map((it) => setStatus(it, N.status.done))));
    const closed = p.workflows.find((x) => x.name === WORKFLOW_CLOSED);
    // fix sets the statuses itself, and the workflow's target isn't visible from the API — check it in the UI, even
    // when the symptom is gone
    if (closed?.enabled) steps.push({ ...ui(`${q(WORKFLOW_CLOSED)}: check Set value → ${STATUS}: ${N.status.done}, otherwise Edit → ${N.status.done} → Save`, `${p.url}/workflows/${closed.fullDatabaseId}`), sticky: true });
    closedAdd(`not in ${q(N.status.done)}: ${nums(notDone.map((it) => it.issue!))}`, ...steps);
  }
  const dropped = issues.filter((it) => it.issue!.state === "CLOSED" && NOT_DONE_REASONS.has(it.issue!.stateReason ?? ""));
  if (dropped.length) closedAdd(`closed without being done, but in the project: ${nums(dropped.map((it) => it.issue!))}`, api(`remove from the project ${nums(dropped.map((it) => it.issue!))}`, ...dropped.map((it) => ({ op: "DeleteItem", input: { projectId: p.id, itemId: it.id } }))));

  const open = add("open", `Open tasks of the repository — in the project, with ${STATUS}`);
  const inProject = new Set(issues.map((it) => it.issue!.id));
  const missing = s.openIssues.filter((i) => !inProject.has(i.id));
  if (missing.length) open(`not in the project: ${nums(missing)}`, api(`add to the project ${nums(missing)}`, ...missing.map((i) => ({ op: "AddItem", input: { projectId: p.id, contentId: i.id } }))));
  const noStatus = issues.filter((it) => it.issue!.state === "OPEN" && !it.status);
  if (noStatus.length) open(`without ${STATUS}: ${nums(noStatus.map((it) => it.issue!))}`, ...(statusReady ? [api(`${STATUS} ${q(N.status.backlog)}: ${nums(noStatus.map((it) => it.issue!))}`, ...noStatus.map((it) => setStatus(it, N.status.backlog)))] : []));

  // Decision labels: by the spec tree and the model of the default branch. Deleting, renaming by a guess, merging, making
  // a regular label a decision one — only with --confirm: the label is on tasks. One extra and one missing of the same
  // kind — a renamed folder, not two decisions. The old form `kind:name` → name — fix does it itself, decision or not:
  // tasks keep the label, there's no guess. A label without a decision on an open task is a new decision (task new sets
  // it before the PR): an ○ line, not deleted and not renamed by a guess — that would take it away from the task. A
  // slice label with a decision's name is a different slice of tasks: an ○ line, fix doesn't touch it, and the decision
  // stays without a label (the name is taken).
  const labels = add("labels", "Decision labels — the decision's name, the kind by color; by the spec tree and the model of the default branch");
  const d = s.decisions;
  if (d.modelError) labels(`model ${MODEL_PATH} doesn't load — module labels aren't checked: ${d.modelError}`);
  const want = decisionsByName(d);
  // the model wasn't read — it's unknown which modules exist: architecture labels aren't deleted or re-described
  const unsure = (kinds: DecisionKind[]) => !!d.modelError && kinds.includes("architecture");
  const taken = new Map(s.labels.filter((l) => !legacyDecision(l.name)).map((l) => [l.name, l]));
  const orphans: { label: Label; kinds: DecisionKind[] }[] = [];
  const dimensions = new Map<string, string[]>();
  for (const l of s.labels) {
    const old = legacyDecision(l.name);
    if (!old) continue;
    const to = decisionLabel(old.name, want.get(old.name) ?? [old.kind]);
    const into = taken.get(old.name);
    if (!into) {
      taken.set(old.name, { ...l, ...to });
      labels(`label ${q(l.name)} of the old form \`kind:name\``, api(`rename label ${q(l.name)} → ${q(old.name)} (tasks keep it)`, { op: "UpdateLabel", input: { id: l.id, ...to } }));
      continue;
    }
    const issues = s.labelIssues[l.id] ?? [];
    labels(`label ${q(l.name)} of the old form, label ${q(old.name)} already exists`, {
      kind: "confirm",
      text: `merge label ${q(l.name)} into ${q(old.name)}: ${issues.length ? `${nums(issues)} get ${q(old.name)}, ` : ""}the old one is deleted`,
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
    const dim = labelDimension(l.description);
    if (dim) {
      dimensions.set(dim, [...(dimensions.get(dim) ?? []), l.name]);
      continue;
    }
    const to = decisionLabel(l.name, w);
    if (!kinds) {
      labels(`label ${q(l.name)} isn't a decision label, but decision ${l.name} is in the default branch`, { kind: "confirm", text: `make ${q(l.name)} a decision label: color ${to.color}, description ${q(to.description)}`, mutations: [{ op: "UpdateLabel", input: { id: l.id, color: to.color, description: to.description } }] });
      continue;
    }
    const recolor = l.color.toLowerCase() !== to.color.toLowerCase();
    if (!recolor && (l.description === to.description || unsure(kinds))) continue;
    const text = recolor ? `label ${q(l.name)} is colored ${l.color}, not ${to.color}` : `label ${q(l.name)}: wrong decision kinds in the description`;
    labels(text, api(`${recolor ? "recolor" : "rewrite the description of"} label ${q(l.name)}: ${to.color}, ${q(to.description)}`, { op: "UpdateLabel", input: { id: l.id, color: to.color, description: to.description } }));
  }
  for (const [dim, names] of dimensions) {
    labels.note(`slice ${q(dim)}: labels ${names.map(q).join(", ")} aren't decision labels, decisions of the same name aren't labeled`);
  }
  const unlabeled = [...want.keys()].filter((n) => !taken.has(n));
  const sure = orphans.filter((o) => !unsure(o.kinds));
  for (const { label: l } of sure.filter((o) => o.label.open.total)) {
    const more = l.open.total - l.open.numbers.length;
    labels.note(`new decision ${q(l.name)}: not in the default branch yet, the label is on open tasks ${l.open.numbers.map((n) => `#${n}`).join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
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
    labels(`label ${q(o.name)} without a decision, decision ${to.name} without a label`, { kind: "confirm", text: `rename label ${q(o.name)} → ${q(to.name)} (tasks keep it)`, mutations: [{ op: "UpdateLabel", input: { id: o.id, ...to } }] });
  }
  for (const { label: o } of live.filter((x) => !paired.has(x.label.id))) {
    labels(`label ${q(o.name)} without a decision in the default branch, no open tasks have it`, { kind: "confirm", text: `delete label ${q(o.name)}`, mutations: [{ op: "DeleteLabel", input: { id: o.id } }] });
  }
  const fresh = unlabeled.filter((n) => !paired.has(n)).map((n) => decisionLabel(n, want.get(n)!));
  if (fresh.length) {
    labels(`decisions without a label: ${fresh.map((x) => x.name).join(", ")}`, api(`create labels ${fresh.map((x) => q(x.name)).join(", ")}`, ...fresh.map((x) => ({ op: "CreateLabel", input: { repositoryId: s.repo.id, ...x } }))));
  }

  merge();
  return checks;
}

/**
 * The `RULESET` ruleset: the default branch, required checks without strict (the field is mandatory in the API),
 * bypass — admin (the owner's direct push).
 */
function rulesetInput(contexts: string[]): Record<string, unknown> {
  return {
    name: RULESET,
    target: "BRANCH",
    enforcement: "ACTIVE",
    conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: { requiredStatusChecks: contexts.map((context) => ({ context })), strictRequiredStatusChecksPolicy: false } } }],
    bypassActors: [{ repositoryRoleDatabaseId: ADMIN_ROLE, bypassMode: "ALWAYS" }],
  };
}

/**
 * Merge: the canon rule "merge only with green checks" is held by GitHub, not by the agent's memory. Required checks
 * are those green on each of the last merged PRs; a check missing from a fresh head (the last merged PR, open ones with
 * finished checks) would hold the PR forever — it leaves the list rather than gets into it. Someone else's rule with
 * checks isn't duplicated; our own ruleset with strict is fixed: GitHub must merge a branch that fell behind.
 */
function analyzeMerge(m: Merge, repositoryId: string, merge: ((text: string, ...steps: Step[]) => void) & { skip: (why: string) => void }): void {
  if (m.unavailable) return merge.skip(`branch rules are unavailable: ${m.unavailable}`);
  const fresh = [...m.merged.slice(-1), ...m.open];
  const gone = (c: string) => fresh.find((h) => !(c in h.checks));
  const stable = Object.keys(m.merged[0]?.checks ?? {})
    .filter((c) => m.merged.every((h) => h.checks[c] === "success") && !gone(c))
    .sort();
  const enforced = m.rules.some((r) => r.contexts.length);
  const list = (cs: string[]) => cs.map(q).join(", ");
  const none = `the last merged PRs have no common green check — nothing to make required`;
  const own = m.own;
  if (!own) {
    if (enforced) return;
    if (!stable.length) return merge.skip(none);
    const text = `create ruleset ${q(RULESET)} on ${m.branch}: required ${list(stable)}, bypass — admin`;
    const step: Step = { kind: "api", text, mutations: [{ op: "CreateRuleset", input: { sourceId: repositoryId, ...rulesetInput(stable) } }] };
    return merge(`no rule with required checks: a branch with a red check can be merged`, step);
  }
  const want = [...new Set([...own.contexts.filter((c) => !gone(c)), ...stable])].sort();
  const step: Step = { kind: "api", text: `ruleset ${q(RULESET)}: default branch, required ${list(want) || "—"}, bypass — admin`, mutations: [{ op: "UpdateRuleset", input: { repositoryRulesetId: own.id, ...rulesetInput(want) } }] };
  const why: string[] = [];
  if (own.enforcement !== "ACTIVE") why.push(`ruleset ${q(RULESET)} — ${own.enforcement}, not in effect`);
  if (!own.include.includes("~DEFAULT_BRANCH")) why.push(`ruleset ${q(RULESET)} is not on the default branch: ${own.include.join(", ") || "—"}`);
  if (own.strict) why.push(`ruleset ${q(RULESET)}: strict is on — GitHub won't merge a branch that fell behind`);
  if (!own.bypassAdmin) why.push(`ruleset ${q(RULESET)}: admin can't bypass — no direct push to ${m.branch}`);
  for (const c of own.contexts.filter((x) => gone(x))) why.push(`required ${q(c)} didn't come to PR #${gone(c)!.number} — the PR would wait for it forever`);
  const add = stable.filter((c) => !own.contexts.includes(c));
  if (add.length) why.push(`green on the last ${m.merged.length} merged PRs, but not required: ${list(add)}`);
  for (const w of why) merge(w, step);
  if (!why.length && !enforced && !want.length) merge.skip(none);
}

/**
 * The merge method is rebase only (the canon, "PR"): the merge rule is the same for all repositories —
 * `gh pr merge <N> --rebase`, the branch's own commits go into the default branch. The repository setting keeps the
 * rule constant: a PR can't be merged another way, and rebase isn't turned off. All causes — one request.
 */
function analyzeMethod(m: Merge, slug: string, method: (text: string, ...steps: Step[]) => void): void {
  const step: Step = {
    kind: "api",
    text: "keep only rebase: turn off merge commit and squash, turn on rebase",
    url: `https://github.com/${slug}/settings`,
    mutations: [{ op: "UpdateRepository", input: { repo: slug, allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true } }],
  };
  if (!m.methods.rebase) method("rebase is off — GitHub will refuse gh pr merge --rebase", step);
  if (m.methods.merge) method("merge commit is allowed", step);
  if (m.methods.squash) method("squash is allowed", step);
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

function header(io: Io, s: State): void {
  io.out(`Project ${s.repo.nameWithOwner}: ${s.project ? s.project.url : "none"}`);
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
  if (s.project && !s.repo.owner.org) io.out(`➖ ${PRIORITY} and issue types — a personal account has none`);
  return checks.every((c) => !c.problems.length);
}

export function cmdCheck(io: Io, slug: string): number {
  const s = loadState(io, slug);
  header(io, s);
  return report(io, s, analyze(s)) ? 0 : 1;
}

/** No project: link the owner's project of the same name, otherwise copy the template, otherwise create one. */
function ensureProject(io: Io, s: State, template: string | null): string {
  const found = graphql(io, Q.OwnerProjects, { login: s.repo.owner.login, query: s.repo.name })?.repositoryOwner?.projectsV2?.nodes ?? [];
  const same = found.find((p: Any) => p && p.title === s.repo.name && !p.closed);
  const link = (p: ProjectRef) => mutate(io, { op: "LinkProject", input: { projectId: p.id, repositoryId: s.repo.id } });
  if (same) {
    link(same);
    return `linked project ${q(same.title)} (${same.url})`;
  }
  if (template) {
    const [login, number] = template.split("/");
    let tpl: Any = null;
    try {
      tpl = graphql(io, Q.TemplateProject, { login, number: Number(number) })?.repositoryOwner?.projectV2 ?? null;
    } catch (e) {
      io.err(`template ${template} is unavailable: ${(e as Error).message}`);
    }
    if (tpl) {
      const copy = mutate(io, { op: "CopyProject", input: { projectId: tpl.id, ownerId: s.repo.owner.id, title: s.repo.name, includeDraftIssues: false } }).copyProjectV2.projectV2;
      link(copy);
      return `project ${q(s.repo.name)} — a copy of template ${template} (${copy.url}), linked`;
    }
    io.err(`template ${template} not found — the project is created from scratch`);
  }
  const created = mutate(io, { op: "CreateProject", input: { ownerId: s.repo.owner.id, title: s.repo.name, repositoryId: s.repo.id } }).createProjectV2.projectV2;
  return `created project ${q(s.repo.name)} (${created.url}), linked`;
}

export function cmdFix(io: Io, slug: string, opts: { confirm: boolean; template: string | null }): number {
  const done: string[] = [];
  const failed: string[] = [];
  const tried = new Set<string>();
  const sticky: Step[] = [];
  let s = loadState(io, slug);
  // Rounds: a step may open the next one (a new Status field → the tasks' statuses); a step isn't done twice.
  for (let round = 0; round < 5; round++) {
    if (!s.project) {
      try {
        done.push(ensureProject(io, s, opts.template));
      } catch (e) {
        failed.push(`project: ${(e as Error).message}`);
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
      // several discrepancies may share one step (editing the whole ruleset) — it's done once
      if (tried.has(st.text)) continue;
      tried.add(st.text);
      try {
        for (const m of st.mutations!) mutate(io, m);
        done.push(st.text);
      } catch (e) {
        failed.push(`${st.text}: ${(e as Error).message}${st.url ? ` — in the UI: ${st.url}` : ""}`);
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
    io.out("UI steps — in the session's browser, without a browser — for the user; then check again:");
    ui.forEach((st, i) => io.out(`${i + 1}. ${st.text} — ${st.url}`));
  }
  if (confirm.length) {
    io.out("Confirmation needed from the user — then fix --confirm:");
    confirm.forEach((st, i) => io.out(`${i + 1}. ${st.text}${st.url ? ` (or in the UI: ${st.url})` : ""}`));
  }
  io.out("Summary:");
  const ok = report(io, s, checks);
  return ok && !failed.length && !ui.length && !confirm.length ? 0 : 1;
}

// ----------------------------------------------------------------------------
// Tasks
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
  subIssues: { number: number; state: string; title: string }[];
  /** The task's milestone and the number of open tasks in it (including this one if it's open). */
  milestone: { id: string; number: number; title: string; open: number } | null;
  /** PRs that close the task ("Closes #N"), closed ones included: whether merged, head and base. */
  prs: { number: number; state: string; merged: boolean; head: string; base: string }[];
  items: { id: string; projectId: string; status: string | null }[];
  priority: string | null;
}

function loadIssue(io: Io, slug: string, number: number): Issue {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueRef, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
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

/**
 * The repository and its project with Status by the canon: without them a task can't be created by the canon — run
 * project fix first. If the Status options are not in the project language but in another dictionary language (the
 * script wasn't called from the project checkout; the language changed and there was no fix yet), the task is handled
 * in the board's language: `project check` checks the language, not every command.
 */
function taskContext(io: Io, slug: string): TaskCtx {
  const repo = loadRepo(io, slug);
  const main = mainProject(repo);
  if (!main) throw new GhError(`no project is linked to ${slug} — github project fix first`);
  const project = loadProject(io, main.id, false);
  const status = project.fields.find((f) => f.name === STATUS && f.options);
  const onBoard = (n: Names) => !!status && [n.status.backlog, n.status.inProgress, n.status.done].every((name) => status.options!.some((o) => o.name === name));
  const board = onBoard(N) ? N : locale.everyNames().find(onBoard);
  if (!status || !board) throw new GhError(`the project's ${STATUS} is not per the canon — github project fix first`);
  N = board;
  return { slug, repo, project, status };
}

const isEpic = (i: Issue, org: boolean) => (org ? locale.every((n) => n.issueTypes.epic).includes(i.type ?? "") : i.labels.includes(EPIC_LABEL));
const itemIn = (ctx: TaskCtx, i: Pick<Issue, "items">) => i.items.find((it) => it.projectId === ctx.project.id) ?? null;

function setStatus(io: Io, ctx: TaskCtx, itemId: string, name: string): void {
  const optionId = ctx.status.options!.find((o) => o.name === name)!.id;
  mutate(io, { op: "SetItemStatus", input: { projectId: ctx.project.id, itemId, fieldId: ctx.status.id, value: { singleSelectOptionId: optionId } } });
}

/**
 * The task's item in the project; none — add it. The project may have added the task itself (projectV2Ids in
 * createIssue, auto-add) while reading doesn't show it yet: addProjectV2ItemById then answers "Content already
 * exists" — re-read after a pause.
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
  throw new GhError(`#${i.number} is already in the project, but its item isn't visible — retry: github task status ${i.number} <status>`);
}

/**
 * The personal configuration directory — `AI_DEV_CONFIG_DIR`, otherwise `~/.config/ai-dev`: one expression for all
 * scripts (the ai-dev `config-dir` standard) rather than a shared module — the skill works without its neighbor. est
 * moves the old `~/.claude/est` into the directory only while the directory doesn't exist (est.ts, `ensureConfigDir`):
 * creating it here first would leave est without its registry and prices. Before the move the configuration is the
 * old directory: the pins move along with it.
 */
function configDir(env: Io["env"]): string {
  const home = env.HOME || os.homedir();
  const dir = env.AI_DEV_CONFIG_DIR || path.join(home, ".config", "ai-dev");
  if (existsSync(dir)) return dir;
  const legacy = path.join(home, ".claude", "est");
  // lstat: a symlink in place of the old directory — the move has already happened
  return lstatSync(legacy, { throwIfNoEntry: false })?.isDirectory() ? legacy : dir;
}

/** The session pin file — `<config directory>/sessions/<session id>`; the session isn't identified — null. */
function pinFile(io: Io): string | null {
  const id = io.env.CLAUDE_CODE_SESSION_ID;
  return id ? path.join(configDir(io.env), "sessions", id) : null;
}

/** The task pinned to the session (`owner/repo#N`); no pin or the session isn't identified — null. */
function pinnedTask(io: Io): string | null {
  const file = pinFile(io);
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/**
 * A session runs one task: the first one taken "In progress" is pinned to the session, another is refused before any
 * change. The key is the session id (a subagent has the same one, /clear changes it), not the checkout: session
 * worktrees are reused. No command removes the pin — a human removes a mistaken one by deleting the file.
 */
function pinTask(io: Io, slug: string, number: number): void {
  const file = pinFile(io);
  if (!file) return io.out("○ session not recognized (no CLAUDE_CODE_SESSION_ID) — the task isn't pinned");
  const task = `${slug}#${number}`;
  const created = (f: string, text: string) => {
    try {
      writeFileSync(f, text, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as Any)?.code !== "EEXIST") throw e;
      return false;
    }
  };
  mkdirSync(path.dirname(file), { recursive: true });
  // the configuration directory may be a personal git checkout (AI_DEV_PRIVATE) — pins aren't committed into it
  created(path.join(path.dirname(file), ".gitignore"), "*\n");
  if (created(file, `${task}\n`)) return;
  const held = readFileSync(file, "utf8").trim();
  if (held !== task) throw new GhError(`the session runs ${held}; #${number} — in a new session, first prompt: #${number} (pin: ${file} — a mistaken one is removed by a human)`);
}

/** The epic prefix — the part of the title before " · ": the titles of the epic and all its subtasks start with it. */
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
  /**
   * Labels: a decision by name or a new decision `kind:name` (no label — it's created with the kind's color), regular
   * ones — existing.
   */
  labels?: string[];
  /** The branch type (feat, fix, …) — also the estimate's type; a bug without it is fix, an epic has none. */
  branchType?: string;
}

/**
 * The task description skeleton without `--body` — canon sections in the project language: scenarios (an epic has
 * none — it has no code) and questions.
 */
export const taskTemplate = (type: string): string =>
  type === N.issueTypes.epic ? `${N.sections.questions}\n` : `${N.sections.scenarios}\n\n${N.sections.questions}\n`;

export function cmdTaskNew(io: Io, slug: string, task: NewTask): number {
  const [owner, name] = slug.split("/");
  const ctx = taskContext(io, slug);
  const org = ctx.repo.owner.org;

  // All checks come before creating: a task mustn't appear half-made. The type — a name in any dictionary language.
  const type = typeAliases()[task.type.toLowerCase()];
  if (!type) throw new GhError(`--type: ${issueTypes().join(", ")}`);
  // the estimate needs the branch type: a bug's branch is fix/<N>-…, an epic has no branch and no estimate of its own
  const branchType = task.branchType?.trim().toLowerCase() || (type === N.issueTypes.bug ? "fix" : "");
  if (type === N.issueTypes.epic) {
    if (branchType) throw new GhError("an epic has no branch and isn't estimated — --branch-type is for a task or a bug");
  } else if (!branchType) throw new GhError(`--branch-type is required for a task: ${TASK_TYPES.join(", ")} — the type of its branch and of its estimate`);
  else if (!TASK_TYPES.includes(branchType)) throw new GhError(`--branch-type: ${TASK_TYPES.join(", ")}`);
  const o = { ...task, type, body: task.body.trim() ? task.body : taskTemplate(type) };
  const issueType = org ? ctx.repo.owner.issueTypes.find((t) => t.name === o.type && t.isEnabled) : undefined;
  if (org && !issueType) throw new GhError(`the organization has no enabled type ${q(o.type)} — github project fix`);
  if (!org && o.priority) throw new GhError("a personal account has no issue fields — no priority is kept, --priority isn't needed");
  let priority: { fieldId: string; optionId: string; name: string } | null = null;
  if (org) {
    const f = ctx.repo.owner.issueFields.find((x) => x.name === PRIORITY);
    if (!f) throw new GhError(`the organization has no issue field ${PRIORITY} — github project fix`);
    const want = o.priority ?? DEFAULT_PRIORITY;
    const opt = f.options.find((x) => x.name === want);
    if (!opt) throw new GhError(`--priority: ${f.options.map((x) => x.name).join(", ")}`);
    priority = { fieldId: f.id, optionId: opt.id, name: want };
  }
  let title = o.title.trim();
  const epic = o.epic === undefined ? null : loadIssue(io, slug, o.epic);
  if (epic) {
    if (!isEpic(epic, org)) throw new GhError(`#${epic.number} is not an epic (${org ? `the type is not ${q(N.issueTypes.epic)}` : `no ${EPIC_LABEL} label`})`);
    if (epic.state !== "OPEN") throw new GhError(`epic #${epic.number} is closed`);
    const prefix = epicPrefix(epic.title);
    if (prefix && !title.startsWith(`${prefix} · `)) title = `${prefix} · ${title}`;
  }
  const blockers = o.blockedBy.map((n) => loadIssue(io, slug, n));
  const needCtx = !!o.milestone || (!org && o.type === N.issueTypes.epic);
  const repoCtx = needCtx ? graphql(io, Q.TaskContext, { owner, name }).repository : null;
  const milestone = o.milestone ? (repoCtx.milestones.nodes as { id: string; title: string }[]).find((m) => m.title === o.milestone) : undefined;
  if (o.milestone && !milestone) throw new GhError(`no open milestone ${q(o.milestone)}`);
  const dup = (graphql(io, Q.IssueSearch, { q: `repo:${slug} is:issue is:open in:title "${title.replaceAll('"', "")}"` }).search.nodes as Any[]).find((x) => x?.title === title);
  if (dup) throw new GhError(`an open task with this title already exists: #${dup.number}`);
  const wanted = [...new Set(o.labels ?? [])];
  const repoLabels = wanted.length ? loadLabels(io, slug) : [];
  const has = (n: string) => repoLabels.find((x) => x.name === n);
  // a decision by name comes from the default branch; `kind:name` — also a new one that isn't there yet
  const decisions = wanted.some((l) => legacyDecision(l) || !has(l)) ? loadDecisions(io, slug) : null;
  const inMain = decisions ? decisionsByName(decisions) : new Map<string, DecisionKind[]>();
  const plan = wanted.map((l) => {
    const dec = legacyDecision(l);
    const name = dec?.name ?? l;
    const label = has(name);
    const main = inMain.get(name) ?? [];
    const kinds = dec && !main.includes(dec.kind) ? [...main, dec.kind] : main;
    const dim = dec && label ? labelDimension(label.description) : null;
    if (dim) throw new GhError(`label ${q(name)} is slice ${q(dim)}, not a decision label: decision ${name} isn't labeled; the slice label — --labels ${name}`);
    if (!label && !kinds.length) {
      throw new GhError(`no label ${q(l)} in the repository and no decision ${l} in the default branch; a new decision — kind:name (${DECISION_KINDS.map((k) => `${k}:${l}`).join(", ")})`);
    }
    return { name, label, kinds, decision: dec !== null || (label ? labelKinds(label.description) !== null : true), fresh: dec && !main.includes(dec.kind) ? `${name} — new decision: ${decisionPath(dec.kind, name)} is not in the default branch yet` : null };
  });

  const done: string[] = [];
  const input: Record<string, unknown> = { repositoryId: ctx.repo.id, title, body: o.body, projectV2Ids: [ctx.project.id] };
  if (issueType) {
    input.issueTypeId = issueType.id;
    done.push(`type ${q(o.type)}`);
  }
  if (!org && o.type === N.issueTypes.epic) {
    let labelId: string | undefined = repoCtx.label?.id;
    if (!labelId) {
      labelId = mutate(io, { op: "CreateLabel", input: { repositoryId: ctx.repo.id, ...epicLabel() } }).createLabel.label.id as string;
      done.push(`created label ${q(EPIC_LABEL)}`);
    }
    input.labelIds = [labelId];
    done.push(`label ${q(EPIC_LABEL)} — the type in a personal account`);
  }
  if (plan.length) {
    const ids: string[] = [];
    for (const x of plan) {
      let id = x.label?.id;
      if (!id) {
        id = mutate(io, { op: "CreateLabel", input: { repositoryId: ctx.repo.id, ...decisionLabel(x.name, x.kinds) } }).createLabel.label.id as string;
        done.push(`created label ${q(x.name)}`);
      }
      ids.push(id);
    }
    input.labelIds = [...((input.labelIds as string[] | undefined) ?? []), ...ids];
    // the decision will appear in this task's PR — the label says so instead of failing
    done.push(`labels: ${plan.map((x) => x.name).join(", ")}`, ...plan.flatMap((x) => (x.fresh ? [x.fresh] : [])));
  }
  if (milestone) input.milestoneId = milestone.id;
  if (epic) input.parentIssueId = epic.id;
  if (priority) input.issueFields = [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }];
  const created = mutate(io, { op: "CreateIssue", input }).createIssue.issue;

  // We set Status ourselves, without waiting for the "Item added to project" workflow.
  const listed = (created.projectItems?.nodes ?? []).map((it: Any) => ({ id: it.id, projectId: it.project.id, status: null }));
  const item = ensureItem(io, ctx, { id: created.id, number: created.number, items: listed }).id;
  setStatus(io, ctx, item, N.status.backlog);
  done.push(`project ${q(ctx.project.title)}: ${STATUS} ${q(N.status.backlog)}`);
  if (priority) done.push(`${PRIORITY} ${q(priority.name)}`);
  if (epic) done.push(`subtask of epic #${epic.number}`);
  for (const b of blockers) {
    if (b.state !== "OPEN") {
      done.push(`#${b.number} is closed — doesn't block, skipped`);
      continue;
    }
    mutate(io, { op: "AddBlockedBy", input: { issueId: created.id, blockingIssueId: b.id } });
    done.push(`blocked by #${b.number}`);
  }
  if (milestone) done.push(`milestone ${q(milestone.title)}`);
  // the epic accumulates its subtasks' decision labels
  const decided = plan.filter((x) => x.decision).map((x) => x.name);
  if (epic && decided.length) {
    const all = loadLabels(io, slug);
    const line = addLabels(io, epic, decided, all);
    if (line) done.push(`epic #${epic.number}: ${line}`);
  }
  // the epic — no lower than its most urgent open subtask
  if (epic && priority) {
    const rank = (p: string | null) => (p === null ? PRIORITIES.length : (PRIORITIES as readonly string[]).indexOf(p));
    if (rank(priority.name) < rank(epic.priority)) {
      mutate(io, { op: "SetIssueField", input: { issueId: epic.id, issueFields: [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }] } });
      done.push(`${PRIORITY} of epic #${epic.number}: ${epic.priority ?? "—"} → ${priority.name}`);
    }
  }

  io.out(`Created #${created.number} ${created.title} — ${created.url}`);
  for (const d of done) io.out(`+ ${d}`);
  if (o.type === N.issueTypes.epic) io.out(`Next: an epic isn't estimated — its ${q(N.fields.estimate)} is the sum of its subtasks' estimates.`);
  else {
    runEstimate(io, slug, created.number, branchType);
    if (epic) io.out(`Next: ${q(N.fields.estimate)} of epic #${epic.number} — recompute as the sum of its subtasks' estimates.`);
  }
  // a session with a pinned task won't take a new one into work (pinTask)
  const held = pinnedTask(io);
  if (held) io.out(`Next: the session runs ${held} — #${created.number} in a new session, first prompt: #${created.number}.`);
  return 0;
}

export function cmdTaskStatus(io: Io, slug: string, number: number, name: string, branch?: string): number {
  // status: a name in any dictionary language; checked before reading the project; the option is in the board's language
  if (!statusAliases()[name.toLowerCase()]) throw new GhError(`status: ${statusOptions().join(", ")}`);
  if (branch !== undefined && statusAliases()[name.toLowerCase()] !== N.status.inProgress) throw new GhError(`--branch — only with ${q(N.status.inProgress)}: the branch is renamed when the task is taken into work`);
  if (branch !== undefined && (taskBranch(branch)?.issue !== number || !TASK_SLUG_RE.test(branch))) {
    throw new GhError(`--branch ${q(branch)}: expected a branch of #${number} by the canon — [<area>/]<type>/${number}-<slug>, type ${TASK_TYPES.join("|")}, slug — Latin kebab-case`);
  }
  const ctx = taskContext(io, slug);
  const status = statusAliases()[name.toLowerCase()]!;
  const issue = loadIssue(io, slug, number);
  const epicTask = isEpic(issue, ctx.repo.owner.org);
  if (branch !== undefined && epicTask) throw new GhError(`--branch: #${number} is an epic — an epic has no branch`);
  // an epic isn't pinned: its session plans and hands out work, and the first subtask also sets the epic "In progress"
  if (status === N.status.inProgress && !epicTask) pinTask(io, slug, number);
  const item = ensureItem(io, ctx, issue);
  setStatus(io, ctx, item.id, status);
  io.out(`+ #${issue.number}: ${STATUS} ${q(status)}${item.added ? " (added to the project)" : ""}`);
  const code = branch === undefined || renameBranch(io, slug, branch) ? 0 : 1;
  if (!issue.parent) return code;
  const epic = loadIssue(io, slug, issue.parent.number);
  const epicStatus = itemIn(ctx, epic)?.status ?? null;
  if (status === N.status.inProgress && epic.state === "OPEN" && (epicStatus === null || epicStatus === N.status.backlog)) {
    setStatus(io, ctx, ensureItem(io, ctx, epic).id, N.status.inProgress);
    io.out(`+ epic #${epic.number}: ${STATUS} ${q(N.status.inProgress)} — the first subtask is taken`);
  }
  if (status === N.status.inProgress && epic.state === "CLOSED") io.out(`Next: epic #${epic.number} is closed, but a subtask is in work again — reopen it (and its milestone, if closed).`);
  if (status === N.status.done && epic.state === "OPEN" && epic.subIssues.length && epic.subIssues.every((x) => x.state === "CLOSED")) {
    io.out(`Next: all subtasks of epic #${epic.number} are closed — close the epic and set it to ${q(N.status.done)}.`);
  }
  return code;
}

export function cmdTaskDrop(io: Io, slug: string, number: number, duplicateOf?: number): number {
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  if (issue.state === "CLOSED" && issue.stateReason === "COMPLETED") throw new GhError(`#${number} is closed as completed — drop is only for tasks not done`);
  const dup = duplicateOf === undefined ? null : loadIssue(io, slug, duplicateOf);
  if (issue.state === "OPEN") {
    mutate(io, { op: "CloseIssue", input: { issueId: issue.id, stateReason: dup ? "DUPLICATE" : "NOT_PLANNED", ...(dup ? { duplicateIssueId: dup.id } : {}) } });
    io.out(`+ #${number} closed: ${dup ? `duplicate of #${dup.number}` : "not planned"}`);
  }
  // "Item closed" would put a task closed without doing it into "Done" — it has no place in the project
  const item = itemIn(ctx, issue);
  if (item) {
    mutate(io, { op: "DeleteItem", input: { projectId: ctx.project.id, itemId: item.id } });
    io.out(`+ #${number} removed from project ${q(ctx.project.title)}`);
  }
  if (issue.parent) io.out(`Next: ${q(N.fields.estimate)} of epic #${issue.parent.number} — recompute as the sum of the remaining subtasks.`);
  return 0;
}

// ----------------------------------------------------------------------------
// Closing a task in one command
// ----------------------------------------------------------------------------

/**
 * The five epic-refresh checks — from the skill's reference.md, the one place of the canon: the list between
 * "Five checks:" and "What was fixed".
 */
function actualizeChecks(): string {
  const file = path.resolve(import.meta.dir, "../reference.md");
  const m = existsSync(file) ? /Five checks:\n\n([\s\S]*?)\n\nWhat was fixed/.exec(readFileSync(file, "utf8")) : null;
  if (!m) throw new GhError(`the five epic-refresh checks not found in ${file}: expected a list between «Five checks:» and «What was fixed»`);
  return m[1]!;
}

/**
 * The assignment for the epic-refresh subagent — right after the merge, in parallel with the deploy: the refresh
 * doesn't depend on the deploy. A session at peak context doesn't assemble the assignment or read the reference — the
 * command prints it whole: the task and its PR, the epic, its open tasks, the five checks. No epic or no open tasks in
 * it — a "not needed" line. The assignment is in the project language (the `actualize` keys), the five checks — quoted
 * from reference.md as is. The first word is `subagentPrompt.task` and the number ("Task #N"): est uses it to tie the
 * subagent's work to the task.
 */
export function cmdTaskActualize(io: Io, slug: string, number: number): number {
  const issue = loadIssue(io, slug, number);
  const later = `Next: task close ${number} — after the deploy, where the merge deploys.`;
  if (!issue.parent) return io.out(`○ refresh not needed: #${number} has no epic. ${later}`), 0;
  const epic = loadIssue(io, slug, issue.parent.number);
  const open = epic.subIssues.filter((x) => x.state === "OPEN" && x.number !== number);
  if (!open.length) return io.out(`○ refresh not needed: epic #${epic.number} has no open tasks besides #${number}. ${later}`), 0;
  const checks = actualizeChecks();
  const linked = issue.prs.filter((p) => p.merged);
  const prs = linked.length ? linked : unlinkedPrs(io, slug, number).prs.filter((p) => p.merged);
  const shipped = prs.length
    ? locale.fill(N.actualize.prs, { list: prs.map((p) => `#${p.number} (\`gh pr view ${p.number}\`, \`gh pr diff ${p.number}\`)`).join(", ") })
    : locale.fill(N.actualize.noPr, { command: `\`git log origin/main --grep '#${number}'\`` });
  const vars = { task: N.subagentPrompt.task, epicWord: N.subagentPrompt.epic, number, epic: epic.number, repo: slug };
  for (const line of [
    locale.fill(N.actualize.lead, vars),
    locale.fill(N.actualize.shipped, { ...vars, title: issue.title, shipped }),
    locale.fill(N.actualize.epic, { ...vars, title: epic.title }),
    ...open.map((x) => locale.fill(N.actualize.openTask, { number: x.number, title: x.title })),
    "",
    N.actualize.checks,
    "",
    checks,
    "",
    locale.fill(N.actualize.scope, { ...vars, questions: N.sections.questions, script: `bun --no-env-file ${import.meta.path}` }),
    locale.fill(N.actualize.comment, vars),
    N.actualize.answer,
  ])
    io.out(line);
  return 0;
}

/**
 * The closing ritual after a PR merge — the actual, Status "Done", the epic, the milestone, taking down the task's
 * stacks, cleaning up the merged branch — in one call: the session did it one step per turn at its largest context.
 * The epic refresh (the canon's five checks) isn't here: it runs before close, in parallel with the deploy, by a
 * subagent with the `task actualize` assignment; close only reminds of it where the epic has open tasks — and names the
 * three lines, one of which ends the session's answer, and archiving the session in auto mode — except a session with
 * questions for the owner.
 */
export function cmdTaskClose(io: Io, slug: string, number: number, o: { git: boolean }): number {
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  const linked = issue.prs.filter((p) => p.merged);
  const closedNoPr = !issue.prs.length && issue.state === "CLOSED" && issue.stateReason === "COMPLETED";
  // GitHub may not link a merged PR to the task for hours: the task is open, no merged PR among the linked ones — we
  // look for the task's PR ourselves
  const found = !linked.length && issue.state === "OPEN" ? unlinkedPrs(io, slug, number) : null;
  const fresh = (found?.prs ?? []).filter((p) => !issue.prs.some((x) => x.number === p.number));
  const unlinked = fresh.filter((p) => p.merged);
  const merged = linked.length ? linked : unlinked;
  if (!merged.length && !closedNoPr) {
    const prs = [...issue.prs, ...fresh].map((p) => `#${p.number} ${p.state === "OPEN" ? "open" : "closed without a merge"}`).join(", ");
    const what = prs ? `PR ${prs}` : `the task is ${issue.state === "OPEN" ? "open" : "closed without being done"}, no merged PR`;
    const checked = found ? `; checked: the PR–task link, the branch <type>/${number}-<slug> and «Closes #${number}» in the body of the last ${RECENT_PRS} PRs into ${found.base}` : "";
    throw new GhError(`#${number} is too early to close: ${what}${checked} — close after the PR is merged or the task is closed`);
  }
  const wasOpen = issue.state === "OPEN";
  if (wasOpen) {
    // without the link the task doesn't see its PR — a comment names it
    if (unlinked.length) mutate(io, { op: "AddComment", input: { subjectId: issue.id, body: locale.fill(N.comments.closedByPr, { prs: unlinked.map((p) => `#${p.number}`).join(", ") }) } });
    mutate(io, { op: "CloseIssue", input: { issueId: issue.id, stateReason: "COMPLETED" } });
    io.out(
      unlinked.length
        ? `+ #${number} closed by PR ${unlinked.map((p) => `#${p.number} (${p.why})`).join(", ")}: GitHub didn't link the PR to the task`
        : `+ #${number} closed: PR ${merged.map((p) => `#${p.number}`).join(", ")} merged`,
    );
  }
  runFact(io, slug, number);
  const item = ensureItem(io, ctx, issue);
  setStatus(io, ctx, item.id, N.status.done);
  io.out(`+ #${number}: ${STATUS} ${q(N.status.done)}${item.added ? " (added to the project)" : ""}`);
  closeMilestone(io, slug, issue, wasOpen);
  let open = 0; // the epic's open tasks other than this one: if there are any, a subagent refreshes the epic
  if (issue.parent) {
    const epic = loadIssue(io, slug, issue.parent.number);
    open = epic.subIssues.filter((x) => x.state === "OPEN" && x.number !== number).length;
    if (epic.state === "OPEN" && epic.subIssues.length && !open) {
      mutate(io, { op: "CloseIssue", input: { issueId: epic.id, stateReason: "COMPLETED" } });
      setStatus(io, ctx, ensureItem(io, ctx, epic).id, N.status.done);
      io.out(`+ epic #${epic.number} closed and in ${q(N.status.done)}: all subtasks are closed`);
      closeMilestone(io, slug, epic, true);
    } else if (epic.state === "OPEN") io.out(`○ epic #${epic.number}: open subtasks ${open}`);
  }
  // stacks of task-env and branches are named by the checkout's origin: from someone else's checkout — another project's
  if (!checkoutOf(originUrl(io), slug)) io.out(`○ ${o.git ? "branches and task stacks" : "task stacks"} left alone: the current directory is not a checkout of ${slug}`);
  else {
    takeDownStacks(io, number);
    if (o.git) cleanupBranch(io, slug, number, merged[0] ?? null);
  }
  // three lines — in the project language: dashboard parses them
  io.out(
    `Next: ${open ? `the epic refresh, if it didn't happen before close — a subagent with the task actualize ${number} assignment; then ` : ""}` +
      `the last line of the answer is one of three: ${q(N.lastLine.done)}; ` +
      `the owner has something to decide — ${q(`${N.lastLine.questions} …`)} with the questions themselves, without ${q(N.lastLine.done)}; ` +
      `something remains — ${q(`${N.lastLine.remaining} …`)}. ` +
      // the command doesn't read the mode (auto) or the session's background tasks: the session knows them, the step is spelled out in words
      `In auto mode after ${q(N.lastLine.done)} — archive the session where the agent has the tool, ` +
      `first stopping its own background tasks still running (a wait, a watcher over its output, a subagent): a live one blocks archiving; ` +
      `after the other two lines — don't. ` +
      `Information without a decision (an observation, a deadline, a warning) isn't a question: the line and archiving are as with ${q(N.lastLine.done)}`,
  );
  return 0;
}

/**
 * What a resumed session restarts: a background wait (ci-wait) dies with the app's process — at a restart four sessions
 * lost their waits in one minute, and the owner wrote "continue" 17 times (#433). The SessionStart hook runs this
 * command: the task pinned to the session (its repository is in the pin, not in the checkout) and its PRs name the
 * wait — an open PR's checks; a merged PR of an open task — the deploy and `task close`. The PR GitHub didn't link — by
 * the task branch, as in `task close`. No pin — no line and no request: the session has no task. Read-only.
 */
export function cmdTaskResume(io: Io): number {
  const pin = pinnedTask(io);
  if (!pin) return 0;
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pin);
  if (!m) throw new GhError(`the session pin ${pinFile(io)} — expected owner/repo#N, not «${pin}»`);
  const [slug, number] = [m[1]!, Number(m[2])];
  const task = `session task ${slug}#${number}`;
  const issue = loadIssue(io, slug, number);
  if (issue.state !== "OPEN") return io.out(`○ ${task} is closed — no wait to restart`), 0;
  const live = (prs: Issue["prs"]) => prs.filter((p) => p.state === "OPEN" || p.merged);
  const prs = live(issue.prs).length ? live(issue.prs) : live(unlinkedPrs(io, slug, number).prs);
  const open = prs.filter((p) => p.state === "OPEN");
  // the task isn't done while a PR of it is open: a follow-up fix after a merge waits for its own checks
  for (const p of open) io.out(`Session task ${slug}#${number}: PR #${p.number} is open — a background wait dies with the app's process; restart it as a background command: bash ${WAIT_CI} pr ${p.number}`);
  const merged = prs.filter((p) => p.merged).sort((a, b) => b.number - a.number)[0];
  if (!open.length && merged)
    io.out(
      `Session task ${slug}#${number}: PR #${merged.number} is merged, the task is open — where the merge deploys, the deploy wait as a background command: bash ${WAIT_CI} merged ${merged.number}; ` +
        `then close the task: bun --no-env-file ${import.meta.path} task close ${number}`,
    );
  if (!prs.length) io.out(`○ ${task}: no PR — no wait to restart`);
  return 0;
}

// canon task types — a copy of EST_TYPES and BRANCH_CONV_RE from skills/est/scripts/est.ts (and in skills/task-env/scripts/task-env.ts):
// there's no shared module (a skill is installed alone), the tests/standards/task-branch standard keeps the parsing identical
const TASK_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"];
const TASK_BRANCH_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + TASK_TYPES.join("|") + ")/(\\d{1,6})-", "iu");

/** A task branch by the canon — `[<area>/]<type>/<N>-<slug>`: the type (lowercased) and the number, otherwise null. */
export function taskBranch(branch: string): { type: string; issue: number } | null {
  const m = TASK_BRANCH_RE.exec(branch);
  return m ? { type: m[1]!.toLowerCase(), issue: parseInt(m[2]!, 10) } : null;
}
const isTaskBranch = (branch: string, number: number) => taskBranch(branch)?.issue === number;
/** The slug of a branch `task status --branch` creates: Latin kebab-case after `<N>-` (AGENTS.md, "Session and branch"). */
const TASK_SLUG_RE = /\/\d{1,6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Attempts to write the shared `.git/config` while another checkout's git holds its lock: 20 with 0.5 s between — ~10 s. */
const CONFIG_LOCK_TRIES = 20;
const CONFIG_LOCK_PAUSE_MS = 500;
const CONFIG_LOCKED = /could not lock config file (.+)$/m;

/**
 * The worktree tool's branch (`claude/<slug>-<hash>`) becomes the task branch — `task status N "In progress" --branch`.
 * `git branch -m` renames the ref, then the branch's section in `.git/config` (upstream): the config is shared by all
 * worktrees of the repository, another checkout's git holds its lock — the ref is renamed, the section is not, code 128,
 * and a repeated `git branch -m` no longer finds the old name (#438). So the step that failed on the lock is repeated —
 * the whole rename or, once the ref is renamed, `git config --rename-section`; still locked — the command that finishes
 * it, the lock isn't removed: another process holds it. A branch already on origin (main, a pushed one) is renamed
 * together with its PR, by hand — left alone. Returns false when something is left undone.
 */
function renameBranch(io: Io, slug: string, target: string): boolean {
  const git = (...args: string[]) => (io.run ?? realRun)("git", args, io.cwd);
  const has = (ref: string) => git("rev-parse", "--verify", "--quiet", ref).status === 0;
  if (!checkoutOf(originUrl(io), slug)) return (io.out(`○ branch left alone: the current directory is not a checkout of ${slug}`), true);
  const current = git("branch", "--show-current").stdout.trim();
  if (!current) {
    const base = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").stdout.trim() || "origin/main";
    return (io.out(`○ branch left alone: HEAD is detached — a task branch from a fresh ${base}: git fetch origin && git switch -c ${target} ${base} --no-track`), true);
  }
  if (current === target) return (io.out(`= branch ${target}`), true);
  if (has(`refs/remotes/origin/${current}`)) return (io.out(`○ branch ${current} is already on origin — left alone: a pushed branch is renamed together with its PR, by hand`), true);
  let renamed = false;
  let lock = "";
  for (let k = 0; k < CONFIG_LOCK_TRIES; k++) {
    if (k) (io.sleep ?? pause)(CONFIG_LOCK_PAUSE_MS);
    const args = renamed ? ["config", "--rename-section", `branch.${current}`, `branch.${target}`] : ["branch", "-m", current, target];
    const r = git(...args);
    // a branch without a section (no upstream) — nothing to rename in the config
    if (r.status === 0 || (renamed && /no such section/.test(r.stderr))) {
      return (io.out(`+ branch ${current} → ${target}${k ? ` (.git/config was locked: ${k} retries)` : ""}`), true);
    }
    const locked = CONFIG_LOCKED.exec(r.stderr);
    if (!locked) return (io.out(`! git ${args.join(" ")}: ${r.stderr.trim().split("\n").filter(Boolean).pop() ?? `code ${r.status}`}`), false);
    lock = `${path.resolve(io.cwd ?? process.cwd(), locked[1]!.trim())}.lock`;
    renamed ||= !has(`refs/heads/${current}`) && has(`refs/heads/${target}`);
  }
  let age = "";
  try {
    age = ` (${Math.round((Date.now() - statSync(lock).mtimeMs) / 1000)} s)`;
  } catch {
    // released right after the last attempt — the command below finishes the rename anyway
  }
  const what = renamed ? `renamed to ${target}, its section in .git/config is not` : `${current} is not renamed`;
  const finish = renamed ? `git config --rename-section branch.${current} branch.${target}` : `git branch -m ${current} ${target}`;
  io.out(`! branch ${what}: ${lock} is held by another git process${age} — not removed; finish: ${finish}`);
  return false;
}

/**
 * The task's PRs that GitHub didn't link to it: among the latest open and merged PRs into the default branch — the
 * task's branch or "Closes #N" in the body (as `pr labels` does before the link appears). `why` — what it was found by.
 */
function unlinkedPrs(io: Io, slug: string, number: number): { base: string; prs: (Issue["prs"][number] & { why: string })[] } {
  const [owner, name] = slug.split("/");
  const r = graphql(io, Q.RecentPrs, { owner, name })?.repository;
  const base: string = r?.defaultBranchRef?.name ?? "main";
  const prs: (Issue["prs"][number] & { why: string })[] = [];
  for (const p of r?.pullRequests?.nodes ?? []) {
    if (p.baseRefName !== base) continue;
    const head: string = p.headRefName ?? "";
    const why = isTaskBranch(head, number) ? `branch ${head}` : closingInBody(p.body ?? "").includes(number) ? `«Closes #${number}» in the body` : null;
    if (why) prs.push({ number: p.number, state: p.state ?? "", merged: Boolean(p.merged), head, base, why });
  }
  return { base, prs };
}

/**
 * The est script next to the skill (`../est/scripts/est.ts`: the project copy, `~/.agents/skills` and the clone are
 * laid out this way).
 */
const estScript = (io: Io) => io.env.AI_DEV_EST ?? path.resolve(import.meta.dir, "../../est/scripts/est.ts");

/** The origin URL of the current directory's checkout; not a checkout or no origin — "". */
function originUrl(io: Io): string {
  const remote = (io.run ?? realRun)("git", ["remote", "get-url", "origin"], io.cwd);
  return remote.status === 0 ? remote.stdout : "";
}

/** The task-env script next to the skill — laid out like est (`../task-env/scripts/task-env.ts`). */
const taskEnvScript = (io: Io) => io.env.AI_DEV_TASK_ENV ?? path.resolve(import.meta.dir, "../../task-env/scripts/task-env.ts");

/**
 * The task's stacks (task-env, epic #392) live until someone takes them down — `task close` does: `task-env down <N>`
 * in the checkout takes the dev and e2e stacks down with their volumes and prints a line per stack (`+`, `○`, `!`) —
 * printed as is; it failed without a line — its error as a `!` line. A failure doesn't stop the close: a stack left
 * behind is found by `task-env prune`. Docker doesn't work in the Claude Code sandbox — task close is an unsandboxed
 * call (SKILL.md).
 */
function takeDownStacks(io: Io, number: number): void {
  const script = taskEnvScript(io);
  if (!existsSync(script)) return io.out(`○ task stacks: task-env is not installed (${script})`);
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "down", String(number)], io.cwd);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  for (const line of lines) io.out(line);
  if (r.status !== 0 && !lines.length) io.out(`! task-env down: ${r.stderr.trim().split("\n").filter(Boolean).pop() ?? `code ${r.status}`}`);
}

/** est with arguments: its output without the marker is printed as is, a failure — its last error line as a `!` line. */
function runEst(io: Io, est: string, args: string[]): void {
  const r = (io.run ?? realRun)("bun", ["--no-env-file", est, ...args], io.cwd);
  for (const line of r.stdout.split("\n")) if (line.trim() && !line.startsWith("<!--")) io.out(line);
  if (r.status !== 0) io.out(`! est ${args[0]}: ${r.stderr.trim().split("\n").filter(Boolean).pop() ?? `code ${r.status}`}`);
}

/** The actual — `task close`. */
function runFact(io: Io, slug: string, number: number): void {
  const est = estScript(io);
  if (!existsSync(est)) return io.out(`○ actual unavailable: est is not installed (${est}) — est fact ${number} --write after installing it`);
  runEst(io, est, ["fact", String(number), "--repo", slug, "--write"]);
}

/**
 * The estimate — `task new`, like the actual in `task close`: the script picks the analogs, the agent has no step of
 * its own. Fewer than two analogs in the repository — est prints "No estimate" and the task stays without one.
 */
function runEstimate(io: Io, slug: string, number: number, type: string): void {
  const est = estScript(io);
  if (!existsSync(est)) return io.out(`○ no estimate: est is not installed (${est})`);
  runEst(io, est, ["estimate", String(number), "--repo", slug, "--type", type, "--write"]);
}

/** GraphQL has no milestone mutation — REST. wasOpen — the task was open when read: the open count includes it. */
function closeMilestone(io: Io, slug: string, issue: Issue, wasOpen: boolean): void {
  const m = issue.milestone;
  if (!m) return;
  const open = m.open - (wasOpen ? 1 : 0);
  if (open > 0) return io.out(`○ milestone ${q(m.title)}: open tasks ${open}`);
  io.gh(["api", "-X", "PATCH", `repos/${slug}/milestones/${m.number}`, "-f", "state=closed"]);
  io.out(`+ milestone ${q(m.title)} closed: no open tasks left`);
}

/**
 * Merged branches go away (SKILL.md, "Git, PRs and merging — mechanics", the "Right after a PR merge" item): the
 * checkout moves from the task branch to origin/<base> detached, the local and remote branches are deleted. "Merged" —
 * the PR is merged, without a PR — `git cherry`; not merged or someone else's — left alone. That the directory is the
 * repository's checkout, the caller checks.
 */
function cleanupBranch(io: Io, slug: string, number: number, pr: { head: string; base: string } | null): void {
  const git = (...args: string[]) => (io.run ?? realRun)("git", args, io.cwd);
  const base = pr?.base || "main";
  const current = git("branch", "--show-current").stdout.trim();
  const isTask = (b: string) => b === pr?.head || isTaskBranch(b, number);
  const branch = current && isTask(current) ? current : (pr?.head ?? "");
  if (!branch) return io.out("○ the task branch not found — branches left alone");
  git("fetch", "--prune", "origin");
  const local = git("branch", "--list", branch).stdout.trim() !== "";
  const cherry = pr || !local ? null : git("cherry", `origin/${base}`, branch);
  if (cherry && (cherry.status !== 0 || cherry.stdout.split("\n").some((l) => l.startsWith("+")))) return io.out(`○ branch ${branch} is not merged into origin/${base} — left alone`);
  if (current === branch) {
    const sw = git("switch", "--detach", `origin/${base}`);
    if (sw.status !== 0) return io.out(`! git switch --detach origin/${base}: ${sw.stderr.trim()}`);
    io.out(`+ checkout — on origin/${base} (detached)`);
  }
  if (local) {
    const d = git("branch", "-D", branch);
    io.out(d.status === 0 ? `+ local branch ${branch} deleted` : `! git branch -D ${branch}: ${d.stderr.trim()}`);
  }
  if (git("ls-remote", "--heads", "origin", branch).stdout.trim()) {
    const d = git("push", "origin", "--delete", branch);
    io.out(d.status === 0 ? `+ remote branch ${branch} deleted` : `! git push origin --delete ${branch}: ${d.stderr.trim()}`);
  } else io.out(`○ remote branch ${branch} is already gone`);
  const top = git("rev-parse", "--show-toplevel").stdout.trim();
  const common = git("rev-parse", "--git-common-dir").stdout.trim();
  if (top && common && path.resolve(io.cwd ?? process.cwd(), common) !== path.join(top, ".git")) io.out(`Next: remove worktree ${top} from the main checkout: git worktree remove ${top}`);
}

// ----------------------------------------------------------------------------
// Decision labels by PR
// ----------------------------------------------------------------------------

/** The labels the task doesn't have — in one mutation; returns them comma-separated (nothing to add — empty). */
function addLabels(io: Io, issue: Pick<Issue, "id" | "labels">, names: string[], all: Label[]): string {
  const missing = names.filter((n) => !issue.labels.includes(n));
  if (!missing.length) return "";
  mutate(io, { op: "AddLabels", input: { labelableId: issue.id, labelIds: missing.map((n) => all.find((l) => l.name === n)!.id) } });
  issue.labels.push(...missing);
  return missing.join(", ");
}

/** A changed PR file (`PullRequestChangedFile`): the kind of change and the line counts. */
export interface PrFile {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
}

// the former exceptions format — an array in one file: the harness's exceptions.ts, spec-doc's names.exceptions.ts
const LEGACY_EXCEPTIONS = /^(names\.)?exceptions\.(ts|mts|js|mjs|json)$/;

/**
 * Which decision folder's exceptions file is it? A copy of the spec skill's `exceptionFile` rule (`speclib.ts`):
 * skills are installed one by one, an import between them would break github without spec; the
 * `tests/standards/exception-files` standard checks both copies against one table. The `exceptions/`
 * (`names.exceptions/`) directory of a `tests/<kind>/<name>` folder, a `.json` file — the folder's exception; another
 * file in the directory and a directory in a subfolder — an error; `exceptions.*` (`names.exceptions.*`) in a folder
 * or a subfolder — the former format; outside decision folders and hidden ones — null.
 */
export function exceptionFile(p: string): { folder: string; dir: string; legacy: boolean; error?: string } | null {
  const parts = p.split("/");
  if (parts[0] !== "tests" || parts.length < 4 || !DECISION_KINDS.some((k) => DECISIONS[k].dir === parts[1])) return null;
  const folder = parts.slice(0, 3).join("/");
  const inner = parts.slice(3);
  if (inner.some((s) => s.startsWith("."))) return null;
  const at = inner.findIndex((s, i) => (i < inner.length - 1 ? s === "exceptions" || s === "names.exceptions" : LEGACY_EXCEPTIONS.test(s)));
  if (at < 0) return null;
  if (at === inner.length - 1) return { folder, dir: inner[at]!.startsWith("names.") ? "names.exceptions" : "exceptions", legacy: true };
  const dir = inner[at]!;
  if (at > 0) return { folder, dir, legacy: false, error: "the exceptions directory is in a subfolder" };
  if (inner.length > 2 || !p.endsWith(".json")) return { folder, dir, legacy: false, error: "an exception is not a .json file" };
  return { folder, dir, legacy: false };
}

/**
 * A mechanical edit doesn't change a decision: the file is deleted, renamed without content changes, or it's an
 * exceptions file of a decision folder that spec reads as an exception (`exceptionFile` without an error): a file in
 * `exceptions/`, the former `exceptions.ts` (the exceptions ratchet), a name exception in `names.exceptions/`
 * (spec-doc). It gives no decision label — otherwise with mass edits a task gets labels of decisions it didn't change.
 */
function mechanical(f: PrFile): boolean {
  if (f.changeType === "DELETED") return true;
  if (f.changeType === "RENAMED" && f.additions === 0 && f.deletions === 0) return true;
  const x = exceptionFile(f.path);
  return !!x && !x.error;
}

/**
 * Decisions the diff touches: a spec tree folder is the decision itself, a code file — the model module with the
 * longest matching directory (a nested module is more precise than the enclosing one). `tests/lib` and files outside
 * modules aren't decisions. `changed` — decision name → its kinds in the diff, at least one of the decision's files
 * edited in content; `mechanical` — decisions touched only by a mechanical edit. Names in alphabetical order.
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
 * Tasks the PR closes, by its body — as GitHub understands them: a keyword (close, fix, resolve in any form) before
 * each `#N`; "Closes #1, #2" closes only #1.
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
    if (!pr) throw new GhError(`no PR #${number} in ${slug}`);
    head ??= pr;
    return pr.files;
  });
  let closes: number[] = (head.closingIssuesReferences?.nodes ?? []).map((x: Any) => x.number);
  // right after the PR is created GitHub hasn't linked it to the task yet — the same keywords in the body
  if (!closes.length) closes = closingInBody(head.body ?? "");
  if (!closes.length) throw new GhError(`PR #${number} has no «Closes #N» — nowhere to put the labels`);
  // modules come from the PR head: the PR may add a module or move its directory
  const model = graphql(io, Q.ModelAt, { owner, name, expression: `${head.headRefOid}:${MODEL_PATH}` })?.repository?.object;
  let modules: Record<string, string[]> = {};
  if (model) {
    const m = modelModules(model.text ?? "");
    if (typeof m === "string") io.err(`warning: model ${MODEL_PATH} of the PR head doesn't load — modules not counted: ${m}`);
    else modules = m;
  }
  const { changed: decided, mechanical: skipped } = decisionsOfFiles(files, modules);
  const all = decided.size ? loadLabels(io, slug) : [];
  // a slice label with a decision's name is a different slice of tasks: it isn't set as a decision label
  const dimensions = all.flatMap((l) => {
    const dim = decided.has(l.name) ? labelDimension(l.description) : null;
    return dim ? [{ name: l.name, dim }] : [];
  });
  const want = [...decided.keys()].filter((n) => !dimensions.some((x) => x.name === n));
  io.out(`PR #${number} → ${closes.map((n) => `#${n}`).join(", ")}: ${want.join(", ") || "no decisions in the diff"}`);
  for (const l of skipped) io.out(`○ ${l} — only a mechanical edit (a deletion, a rename without changes, exceptions): no label`);
  for (const x of dimensions) io.out(`○ ${x.name} — label ${q(x.name)} is slice ${q(x.dim)}, not a decision label: not set`);
  if (!want.length) return 0;

  const fresh = want.filter((l) => !all.some((x) => x.name === l));
  const repoId = fresh.length ? loadRepo(io, slug).id : "";
  for (const l of fresh) {
    const label = decisionLabel(l, decided.get(l)!);
    const created = mutate(io, { op: "CreateLabel", input: { repositoryId: repoId, ...label } }).createLabel.label;
    all.push({ id: created.id, ...label, open: { total: 0, numbers: [] } });
    io.out(`+ created label ${q(l)}`);
  }
  const isDecision = (n: string) => legacyDecision(n) !== null || labelKinds(all.find((x) => x.name === n)?.description) !== null;
  const epics = new Map<number, Issue>();
  for (const n of closes) {
    const issue = loadIssue(io, slug, n);
    const added = addLabels(io, issue, want, all);
    if (added) io.out(`+ #${n}: ${added}`);
    // earlier labels aren't removed: the task may have touched the decision in another PR too
    for (const l of issue.labels.filter((x) => isDecision(x) && !want.includes(x))) io.out(`= #${n}: ${l} — the decision is not in the PR diff, the label stays`);
    if (issue.parent && !epics.has(issue.parent.number)) epics.set(issue.parent.number, loadIssue(io, slug, issue.parent.number));
  }
  for (const epic of epics.values()) {
    const added = addLabels(io, epic, want, all);
    if (added) io.out(`+ epic #${epic.number}: ${added}`);
  }
  return 0;
}

// ----------------------------------------------------------------------------
// Checking the merge before merging
// ----------------------------------------------------------------------------

/**
 * The project's fast checks — these `package.json` scripts, those that exist, in CI order: types (a semantic conflict
 * of two PRs, seconds), then standards and architecture — minutes, not the whole `test`.
 */
export const PREMERGE_SCRIPTS = ["typecheck", "test:spec"];
/**
 * GitHub builds the merge-ref before the event that creates the check suite: main moving within this minute counts as
 * having moved.
 */
const MERGE_REF_SLACK_MS = 60_000;
const LOCKFILES: [file: string, pm: string][] = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]];
const INSTALL: Record<string, string[]> = { bun: ["bun", "install", "--frozen-lockfile"], pnpm: ["pnpm", "install", "--frozen-lockfile"], yarn: ["yarn", "install", "--frozen-lockfile"], npm: ["npm", "ci"] };
/**
 * Failure lines: a test — bun `(fail)`, Vitest `FAIL` and `×`, Jest `●`, Playwright `✘`; a compiler error —
 * `error TS2304:`.
 */
const FAILED_LINE = /^\s*(\(fail\)|FAIL\s|×|✗|✘|●\s)|\berror TS\d+:/;
/**
 * A `bun check` error under an agent (`CLAUDECODE=1`) — a block `<error file="a.ts" line="3" column="5" code="TS2304">`
 * with the text on the next line; it is brought to a tsc line without a TTY, `a.ts(3,5): error TS2304: …`.
 */
const BUN_CHECK_ERROR = /<error file="([^"]+)" line="(\d+)" column="(\d+)" code="(TS\d+)">\n([^\n]*)/g;
const asTsc = (out: string) => out.replace(BUN_CHECK_ERROR, "$1($2,$3): error $4: $5");

/**
 * The project's commands in a directory: the package manager — `packageManager` in package.json, otherwise by the
 * lockfile; dependencies are installed from the lockfile without changing it, no lockfile — no install.
 */
export function projectCommands(dir: string): { install: string[] | null; run: (script: string) => string[] } {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const lock = LOCKFILES.find(([f]) => existsSync(path.join(dir, f)));
  const pm = /^(bun|pnpm|yarn|npm)@/.exec(pkg.packageManager ?? "")?.[1] ?? lock?.[1] ?? "npm";
  return { install: lock ? INSTALL[pm]! : null, run: (script) => [pm, "run", script] };
}

const tail = (r: RunResult, n = 20) => `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim()).slice(-n);
/**
 * A failure line without the run time (bun `[1.2ms]`, Vitest `12ms`) and the compiler error position (`a.ts(3,5):` —
 * tsc without a TTY; a PR edit higher up in the file shifts it) — one failure on the merge and on main.
 */
const failure = (l: string) => l.trim().replace(/\s*\[[\d.]+\s*m?s\]$/, "").replace(/\s+[\d.]+\s*m?s$/, "").replace(/^(\S+?)\(\d+,\d+\)(?=:)/, "$1");

/**
 * Waiting for the bug to close — the ci-wait script next to it (`../ci-wait`: the project copy, `~/.agents/skills` and
 * the clone are laid out this way).
 */
const WAIT_CI = path.resolve(import.meta.dir, "../../ci-wait/scripts/wait-ci.sh");
// a red check outcome: cancelled (a rerun, a new commit) and waiting for a human's decision aren't red
const RED_RUN = new Set(["failure", "timed_out", "startup_failure"]);
const RED_STATUS = new Set(["failure", "error"]);

/** Red checks of the default branch's last commit — check-runs (the last run of each name) and hosting statuses. */
function redChecksOf(io: Io, slug: string, base: string): { sha: string; names: string[] } {
  const ref = encodeURIComponent(base);
  const latest = new Map<string, Any>();
  for (const r of restCall(io, ["api", `repos/${slug}/commits/${ref}/check-runs?per_page=100`]).check_runs ?? []) {
    if (!latest.has(r.name) || latest.get(r.name).id < r.id) latest.set(r.name, r);
  }
  const status = restCall(io, ["api", `repos/${slug}/commits/${ref}/status`]);
  const names = [
    ...[...latest.values()].filter((r) => r.status === "completed" && RED_RUN.has(r.conclusion)).map((r) => r.name as string),
    ...(status.statuses ?? []).filter((x: Any) => RED_STATUS.has(x.state)).map((x: Any) => x.context as string),
  ];
  return { sha: String(status.sha ?? ""), names: [...new Set(names)].sort() };
}

/**
 * Title prefixes of a bug about a red default branch — `mainRed.title` of each dictionary language, the project
 * language first.
 */
const mainRedPrefixes = (base: string) => [...new Set([N, ...locale.everyNames()].map((n) => locale.fill(n.mainRed.title, { base })))];

/**
 * Open bugs about a red default branch — the title "<base> is red…" in any dictionary language (a search for each),
 * by number: the search lags, and a duplicate happens.
 */
function mainBugsOf(io: Io, slug: string, base: string): { number: number; title: string }[] {
  const prefixes = mainRedPrefixes(base);
  const found = new Map<number, Any>();
  for (const prefix of prefixes) {
    const q = `repo:${slug} is:issue is:open in:title "${prefix}"`;
    for (const i of restCall(io, ["api", `search/issues?q=${encodeURIComponent(q)}&per_page=20`]).items ?? []) found.set(i.number, i);
  }
  return [...found.values()].filter((i) => !i.pull_request && prefixes.some((p) => String(i.title).startsWith(p))).sort((a, b) => a.number - b.number);
}

/**
 * The bug title "<base> is red…" names the check — the whole name after the prefix, not part of another one: `test`
 * isn't found in "test:spec", nor `main` in the prefix.
 */
function bugNames(base: string, title: string, check: string): boolean {
  const prefix = mainRedPrefixes(base).find((p) => title.startsWith(p)) ?? "";
  return new RegExp(`(?:^|[\\s,«"(])${locale.escapeRe(check)}(?=$|[\\s,;»")])`, "u").test(title.slice(prefix.length));
}

/**
 * Before merging a green PR: main moved after its CI — the PR head merged with a fresh main in a temporary worktree and
 * the fast checks (`typecheck`, then `test:spec`, as in CI); didn't move — the CI checked exactly this merge. GitHub
 * doesn't keep what the CI checked (the merge-ref is rebuilt), so by time: the head's earliest check suite against the
 * last event of the default branch (REST: the GraphQL quota is shared by all sessions). The unknown is checked. A red
 * main isn't this PR: a red check on main's last commit or a merge red by the same thing as bare main. Code 0 —
 * merge, 1 — don't merge (the PR breaks it), 3 — main is red.
 */
export function cmdPrPremerge(io: Io, slug: string, number: number): number {
  const pr = restCall(io, ["api", `repos/${slug}/pulls/${number}`]);
  if (pr.state !== "open") throw new GhError(`PR #${number} is not open — nothing to merge`);
  const head: string = pr.head.sha;
  const base: string = pr.base.ref;
  const closes = closingInBody(pr.body ?? "");

  /**
   * A red main: don't merge and don't fix it in your PR — one bug for everyone, the others wait for it to close.
   * `red` — the failed checks (or the script), `what` — how to name them in the bug title. A PR that closes this bug is
   * the fix: null, the check goes as usual.
   */
  const mainRed = (lead: string, why: string, red: string[], what: (names: string[]) => string, say = what): number | null => {
    let bugs: { number: number; title: string }[] = [];
    try {
      bugs = mainBugsOf(io, slug, base);
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      io.out(`○ open bug on red ${base} not found by search: ${e.message}`);
    }
    // the fix is a PR that closes any of the open bugs, without matching the failed check (unlike the wait below): one
    // red main is named sometimes by the script (test:spec on bare main), sometimes by a CI check — matching would
    // keep the fix from merging
    const fix = bugs.find((b) => closes.includes(b.number));
    if (fix) {
      io.out(`○ ${base} is red — ${why}; the PR closes bug #${fix.number} about it — checking the PR as usual`);
      return null;
    }
    io.out(lead);
    // wait for a bug whose title names the failed check (unlike the fix above): a bug about another check won't make
    // main green
    const named = (b: { title: string }) => red.some((n) => bugNames(base, b.title, n));
    for (const b of bugs.filter((b) => !named(b))) io.out(`○ #${b.number} «${b.title}» — about another check: don't wait`);
    const wait = (n: string) => `wait for it to close — bash ${WAIT_CI} issue ${n} as a background command, then pr premerge ${number} again`;
    const bug = bugs.find(named);
    if (bug) io.out(`bug on red ${base} — #${bug.number} «${bug.title}»: ${wait(String(bug.number))}`);
    const unnamed = red.filter((n) => !bugs.some((b) => bugNames(base, b.title, n)));
    if (unnamed.length) {
      const priority = pr.base?.repo?.owner?.type === "Organization" ? " --priority Urgent" : "";
      const title = `${locale.fill(N.mainRed.title, { base })}: ${what(unnamed)}`;
      io.out(`no bug on red ${base} about ${say(unnamed)} — find an open one on the failed test or file one (label — the failed test's decision) and give a chip: bun --no-env-file ${import.meta.path} task new --type ${N.issueTypes.bug}${priority} --title ${JSON.stringify(title)}; ${wait("<N>")}`);
    }
    io.out(`⛔ don't merge: ${base} is red, not this PR — don't fix it in your PR`);
    return 3;
  };

  try {
    const red = redChecksOf(io, slug, base);
    if (red.names.length) {
      const checks = (names: string[]) => `${names.length > 1 ? "checks" : "check"} ${names.join(", ")}`;
      // in the bug title — in the project language
      const titled = (names: string[]) => locale.fill(names.length > 1 ? N.mainRed.checks : N.mainRed.check, { names: names.join(", ") });
      const why = `${checks(red.names)} of the last commit of ${base} (${red.sha.slice(0, 7)})`;
      const code = mainRed(`${base} is red: ${why}`, why, red.names, titled, checks);
      if (code !== null) return code;
    }
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    io.out(`○ checks of the last commit of ${base} not read (${e.message}) — whether ${base} is red is unknown from the checks`);
  }

  const suites: string[] = (restCall(io, ["api", `repos/${slug}/commits/${head}/check-suites?per_page=100`]).check_suites ?? []).map((s: Any) => s.created_at).filter(Boolean);
  const ci = suites.sort()[0];
  let moved: string | null = null;
  let unread: string | null = null;
  try {
    moved = restCall(io, ["api", `repos/${slug}/activity?ref=${encodeURIComponent(`refs/heads/${base}`)}&per_page=1`])[0]?.timestamp ?? null;
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    unread = e.message;
  }
  const check = `checking the merge with origin/${base}`;
  if (!ci) io.out(`the head of PR #${number} has no checks — what CI checked is unknown: ${check}`);
  else if (unread) io.out(`○ movement of ${base} not read (${unread}) — ${check}`);
  else if (!moved || Date.parse(moved) <= Date.parse(ci) - MERGE_REF_SLACK_MS) {
    io.out(`✅ merge: ${base} hasn't moved since the CI of PR #${number} (CI since ${ci}, last movement of ${base} — ${moved ?? "none"}) — CI checked this merge`);
    return 0;
  } else io.out(`${base} moved after the CI of PR #${number} (CI since ${ci}, ${base} — ${moved}) — ${check}`);

  const run = io.run ?? realRun;
  const git = (cwd: string | undefined, ...args: string[]) => run("git", args, cwd);
  if (!checkoutOf(originUrl(io), slug)) throw new GhError(`the merge check runs from a checkout of ${slug}: the current directory is not one`);
  for (const ref of [base, `refs/pull/${number}/head`]) {
    const f = git(io.cwd, "fetch", "-q", "origin", ref);
    if (f.status !== 0) throw new GhError(`git fetch origin ${ref}: ${f.stderr.trim()}`);
  }
  if (git(io.cwd, "cat-file", "-e", `${head}^{commit}`).status !== 0) throw new GhError(`PR head ${head} not fetched from origin — was the PR updated? ci-wait again`);

  const dirs: string[] = [];
  /** A temporary worktree at origin/<base>: always removed. */
  const worktree = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-dev-premerge-"));
    dirs.push(dir);
    const add = git(io.cwd, "worktree", "add", "-q", "--detach", dir, `origin/${base}`);
    if (add.status !== 0) throw new GhError(`git worktree add: ${add.stderr.trim()}`);
    return dir;
  };
  const ON_MERGE = "on the merge";
  type Red = { script: string; cmd: string; result: RunResult; failed: string[] };
  /**
   * The tree's fast checks (`scripts` — those that exist) with dependencies from its lockfile, up to the first red one;
   * none — null.
   */
  const checks = (dir: string, where: string, scripts: string[]): { ran: string[]; red: Red | null } | null => {
    const pkg = path.join(dir, "package.json");
    const defined = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {}) : {};
    const present = scripts.filter((s) => defined[s]);
    if (!present.length) return null;
    const cmds = projectCommands(dir);
    if (cmds.install) {
      const r = run(cmds.install[0]!, cmds.install.slice(1), dir);
      if (r.status !== 0) throw new GhError(`installing dependencies ${where} failed (${cmds.install.join(" ")}): ${tail(r, 5).join(" / ")}`);
      io.out(`+ dependencies${where === ON_MERGE ? "" : ` ${where}`}: ${cmds.install.join(" ")}`);
    }
    const ran: string[] = [];
    for (const script of present) {
      const cmd = cmds.run(script);
      const result = run(cmd[0]!, cmd.slice(1), dir);
      ran.push(script);
      if (result.status === 0) continue;
      const failed = [...new Set(asTsc(`${result.stdout}\n${result.stderr}`).split("\n").filter((l) => FAILED_LINE.test(l)).map((l) => l.trim()))];
      return { ran, red: { script, cmd: cmd.join(" "), result, failed } };
    }
    return { ran, red: null };
  };
  const breaks = (script: string) => `❌ don't merge: ${script} is red on the merge with origin/${base} — fix the root cause in the PR: rebase onto origin/${base}, edit, push --force-with-lease, ci-wait again`;
  try {
    const dir = worktree();
    const short = (ref: string) => git(dir, "rev-parse", "--short=7", ref).stdout.trim();
    // like GitHub's merge-ref; a rebase merge without conflicts gives the same tree. A temporary merge doesn't need the
    // project's hooks
    const merge = git(dir, "-c", "user.name=ai-dev", "-c", "user.email=ai-dev@localhost", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "--no-verify", "--no-edit", head);
    if (merge.status !== 0) {
      const files = git(dir, "diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
      if (!files.length) throw new GhError(`git merge: ${merge.stderr.trim()}`);
      io.out(`❌ don't merge: a merge conflict with origin/${base} — ${files.join(", ")}; rebase onto origin/${base}, push --force-with-lease, ci-wait again`);
      return 1;
    }
    io.out(`+ merge of ${head.slice(0, 7)} with origin/${base} ${short("HEAD^1")} — no conflicts`);
    const merged = checks(dir, ON_MERGE, PREMERGE_SCRIPTS);
    if (!merged) {
      io.out(`○ no fast checks: the merge's package.json has no ${PREMERGE_SCRIPTS.join(" or ")} scripts — step skipped`);
      io.out(`✅ merge: the merge with origin/${base} has no conflicts`);
      return 0;
    }
    const red = merged.red;
    if (!red) {
      io.out(`✅ merge: ${merged.ran.join(" and ")} ${merged.ran.length > 1 ? "are" : "is"} green on the merge with origin/${base}`);
      return 0;
    }
    io.out(`${red.cmd} failed:`);
    for (const l of (red.failed.length ? red.failed.slice(0, 20) : tail(red.result))) io.out(`  ${l.trim()}`);

    // a red merge — is bare main red by the same thing: then it's not this PR that breaks it
    io.out(`checking bare origin/${base}: is it red by itself`);
    const bare = checks(worktree(), `on origin/${base}`, [red.script])?.red;
    if (!bare) {
      io.out(breaks(red.script));
      return 1;
    }
    const onMain = new Set(bare.failed.map(failure));
    const own = red.failed.filter((l) => !onMain.has(failure(l)));
    // can't tell what failed — can't tell them apart: main is red, after its fix premerge checks the PR again
    if (own.length && bare.failed.length) {
      io.out(`${base} is red by itself, the PR breaks beyond it:`);
      for (const l of own.slice(0, 20)) io.out(`  ${l}`);
      io.out(breaks(red.script));
      return 1;
    }
    const why = `${red.script} is red on bare origin/${base} too, with the same failures`;
    const code = mainRed(`${base} is red by itself: ${why}`, why, [red.script], (names) => names.join(", "));
    if (code !== null) return code;
    io.out(breaks(red.script));
    return 1;
  } finally {
    for (const dir of dirs) {
      git(io.cwd, "worktree", "remove", "--force", dir);
      rmSync(dir, { recursive: true, force: true });
    }
    git(io.cwd, "worktree", "prune");
  }
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const USAGE = `github — the repository's GitHub project and tasks by the AGENTS.md canon

  github project check [--repo owner/repo]
  github project fix   [--repo owner/repo] [--confirm] [--template owner/N | none]
  github task new      --title "…" --branch-type <type> [--body "…" | --body-file F] [--type Task|Bug|Epic] [--epic N]
                       [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low]
                       [--labels <decision>,<kind>:<new decision>,<label>] [--repo owner/repo]
  github task status   <N> <Backlog|In progress|Done> [--branch <type>/<N>-<slug>] [--repo owner/repo]
  github task drop     <N> [--duplicate-of M] [--repo owner/repo]
  github task actualize <N> [--repo owner/repo]
  github task close    <N> [--no-git] [--repo owner/repo]
  github task resume
  github pr labels     <N> [--repo owner/repo]
  github pr premerge   <N> [--repo owner/repo]

check — items ✅/❌, code 0 — everything per the canon, 1 — there are ❌; decision labels — by the default branch's
        spec tree, a new decision's label on an open task and a slice label («Slice: …») with a decision's name — an ○ line, not ❌.
fix   — fixes via the API; prints UI steps with links; deleting and renaming in a project with tasks
        and organization settings — only with --confirm (after the user's "yes").
        No project — links the one of the same name, otherwise copies the template (${DEFAULT_TEMPLATE}), otherwise creates one.
task  — a task by the canon; new sets the estimate itself (est estimate --write with --branch-type: feat, fix, …;
        a bug without it is fix, an epic isn't estimated) and prints what was created and the next step.
task status — In progress pins the task to the session (file sessions/<CLAUDE_CODE_SESSION_ID> in ~/.config/ai-dev):
        another task in the same session — a refusal (code 2), it needs a new session; a human removes the pin.
        --branch — the worktree tool's branch becomes the task branch (git branch -m with its .git/config section);
        a .git/config locked by another checkout — retried ~10 s, then a ! line with the command that finishes it (code 1).
task actualize — right after the merge, in parallel with the deploy: prints the assignment for the epic-refresh subagent
        (the task, the epic, its open tasks, the five checks); no epic or no open tasks in it — "refresh not needed".
task resume — the SessionStart hook runs it: the wait to restart for the task pinned to the session — an open PR's checks,
        a merged PR of an open task — the deploy and task close; no pin — nothing (code 0).
task close — after the PR merge and the deploy (or a close without a PR) in one call: the actual (est fact --write),
        Status Done, the epic and the milestone, the task's stacks taken down with their volumes (task-env down), the
        merged branch removed (--no-git — without git). Docker and gh don't work in an agent's sandbox — run it outside.
pr labels — decision labels from the PR diff for the tasks from «Closes #N» and their epics; doesn't remove earlier ones;
            a decision touched only mechanically (a deletion, a rename without changes, exceptions) and a decision
            with a slice label's name — an ○ line, no label.
pr premerge — before gh pr merge, after ci-wait PASS: the default branch moved after the PR's CI — the PR head merged
            with it in a temporary worktree and ${PREMERGE_SCRIPTS.join(", then ")} from package.json (those that exist, as in CI);
            code 0 — merge, 1 — don't merge (red, conflict), 2 — couldn't check, 3 — main is red by itself (the same
            check on bare main, a red check on its last commit): don't merge, one bug for it — wait for it to close.`;

const issueNumber = (s: string | undefined, what: string): number => {
  const m = /^#?(\d+)$/.exec((s ?? "").trim());
  if (!m) throw new GhError(`${what}: expected an issue number, not «${s ?? ""}»`);
  return Number(m[1]);
};

// The checkout's GitHub repository by its origin — a copy of originRepo from skills/est/scripts/est.ts and skills/task-env/scripts/task-env.ts:
// there's no shared module (a skill is installed alone), the tests/standards/origin-repo standard keeps the parsing identical
const ORIGIN_RE = /^(?:[a-z][a-z\d+.-]*:\/\/(?:[^@/\s]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|(?:[^@/\s:]+@)?(?:ssh\.)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/repo` of a GitHub origin URL (host github.com or ssh.github.com, any case, with a port), otherwise null. */
export function originRepo(url: string): string | null {
  const m = ORIGIN_RE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A checkout with this origin URL is a checkout of `repo` (owner/name): the parsed origin equals it — GitHub ignores case. */
export function checkoutOf(origin: string, repo: string): boolean {
  return originRepo(origin)?.toLowerCase() === repo.toLowerCase();
}

function detectRepo(): string {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const repo = r.status === 0 ? originRepo(r.stdout ?? "") : null;
  if (!repo) throw new GhError("couldn't determine the repository from git remote origin; pass --repo owner/repo");
  return repo;
}

export function main(argv: string[], io: Io): number {
  N = locale.names(locale.projectLanguage(io.cwd ?? process.cwd()));
  try {
    const [group, cmd, ...rest] = argv;
    if (!group || group === "-h" || group === "--help") {
      io.out(USAGE);
      return group ? 0 : 2;
    }
    const known: Record<string, string[]> = { project: ["check", "fix"], task: ["new", "status", "drop", "actualize", "close", "resume"], pr: ["labels", "premerge"] };
    if (!known[group]?.includes(cmd ?? "")) {
      io.err(`unknown command «${argv.slice(0, 2).join(" ")}»; expected project check|fix, task new|status|drop|actualize|close|resume or pr labels|premerge`);
      return 2;
    }
    if (io.env.CLAUDE_CODE_REMOTE === "true" && group === "task" && cmd === "close") {
      const n = /^#?(\d+)$/.exec(rest.find((a) => !a.startsWith("--")) ?? "")?.[1] ?? "<N>";
      io.err(`cloud session: task close is unavailable to it — no GitHub Projects in the cloud (docs/cloud-sessions.md). The actual — the ${q(N.est.cloud.actual.replace(/:$/, ""))} comment printed by est fact ${n}; ${q(N.status.done)} is set by the project's workflow ${q(WORKFLOW_CLOSED)}; the cloud's branch and container are temporary, nothing to clean up.`);
      return 2;
    }
    if (io.env.CLAUDE_CODE_REMOTE === "true") {
      io.err("cloud session: GitHub Projects are unavailable to it (Projects v2 — 403, docs/cloud-sessions.md) — a local session checks and fixes the project");
      return 2;
    }
    const repoOf = (v: string | undefined) => {
      const slug = v ?? detectRepo();
      if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new GhError(`invalid --repo «${slug}», expected owner/repo`);
      return slug;
    };
    if (group === "pr") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { repo: { type: "string" } } });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      const m = /^#?(\d+)$/.exec((positionals[0] ?? "").trim());
      if (!m) throw new GhError(`pr ${cmd}: expected a PR number, not «${positionals[0] ?? ""}»`);
      return (cmd === "premerge" ? cmdPrPremerge : cmdPrLabels)(io, repoOf(values.repo), Number(m[1]));
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
          type: { type: "string" },
          epic: { type: "string" },
          milestone: { type: "string" },
          "blocked-by": { type: "string" },
          priority: { type: "string" },
          "duplicate-of": { type: "string" },
          labels: { type: "string" },
          "branch-type": { type: "string" },
          branch: { type: "string" },
          "no-git": { type: "boolean", default: false },
        },
      });
      // the task and its repository — from the session pin: the hook runs it from any directory
      if (cmd === "resume") {
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")} — task resume takes the task from the session pin`);
        return cmdTaskResume(io);
      }
      const slug = repoOf(values.repo);
      if (cmd === "new") {
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")}`);
        if (!values.title?.trim()) throw new GhError("--title is required");
        if (values.body !== undefined && values["body-file"]) throw new GhError("--body or --body-file, not both");
        const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : (values.body ?? "");
        const blockedBy = (values["blocked-by"] ?? "").split(",").filter((x) => x.trim()).map((x) => issueNumber(x, "--blocked-by"));
        const epic = values.epic === undefined ? undefined : issueNumber(values.epic, "--epic");
        const labels = (values.labels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return cmdTaskNew(io, slug, { title: values.title, body, type: values.type ?? N.issueTypes.task, epic, milestone: values.milestone, blockedBy, priority: values.priority, labels, branchType: values["branch-type"] });
      }
      const number = issueNumber(positionals[0], `task ${cmd}`);
      if (cmd === "status") return cmdTaskStatus(io, slug, number, positionals.slice(1).join(" "), values.branch);
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      if (cmd === "close") return cmdTaskClose(io, slug, number, { git: !values["no-git"] });
      if (cmd === "actualize") return cmdTaskActualize(io, slug, number);
      return cmdTaskDrop(io, slug, number, values["duplicate-of"] === undefined ? undefined : issueNumber(values["duplicate-of"], "--duplicate-of"));
    }
    const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, confirm: { type: "boolean", default: false }, template: { type: "string", default: DEFAULT_TEMPLATE } } });
    const slug = repoOf(values.repo);
    const template = values.template === "none" ? null : values.template!;
    if (template && !/^[\w.-]+\/\d+$/.test(template)) throw new GhError(`invalid --template «${template}», expected owner/N or none`);
    return cmd === "check" ? cmdCheck(io, slug) : cmdFix(io, slug, { confirm: values.confirm!, template });
  } catch (e) {
    if (e instanceof GhError || (e as Any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      io.err(`error: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), { gh: realGh, out: (l) => console.log(l), err: (l) => console.error(l), env: process.env });
}
