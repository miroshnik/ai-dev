/**
 * Фейковый `gh` для тестов скилла github: чтения GraphQL — из записанных ответов GitHub, мутации меняют эти
 * ответы так, как это сделал бы GitHub. `gh` — внешний край, поэтому подменяется он, а не модули скилла.
 * Не спека — в документацию не попадает.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type Recording = Record<string, Any>;

/** Ключ записи: операция и переменные без курсора страницы, ключи по алфавиту. */
export function keyOf(op: string, variables: Record<string, unknown>): string {
  const vars = Object.fromEntries(Object.entries(variables).filter(([k]) => k !== "after").sort(([a], [b]) => a.localeCompare(b)));
  return `${op} ${JSON.stringify(vars)}`;
}

export function opOf(query: string): { kind: string; op: string } {
  const m = /^\s*(query|mutation)\s+(\w+)/.exec(query);
  if (!m) throw new Error(`fake gh: запрос без имени операции: ${query.slice(0, 80)}`);
  return { kind: m[1]!, op: m[2]! };
}

export class FakeGitHub {
  rec: Recording;
  mutations: { op: string; input: Any }[] = [];
  /** Операция → текст ошибки GraphQL: мутация падает, как без прав у токена. */
  failing: Record<string, string> = {};
  private seq = 0;

  constructor(recording: Recording) {
    this.rec = structuredClone(recording);
  }

  gh = (args: string[], stdin?: string): string => {
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`fake gh: неожиданный вызов gh ${args.join(" ")}`);
    const { query, variables } = JSON.parse(stdin ?? "{}");
    const { kind, op } = opOf(query);
    if (kind === "mutation") {
      this.mutations.push({ op, input: variables.input });
      if (this.failing[op]) return JSON.stringify({ data: null, errors: [{ message: this.failing[op] }] });
      const handler = (this.handlers as Any)[op];
      if (!handler) throw new Error(`fake gh: мутация ${op} не поддержана`);
      return JSON.stringify({ data: handler(variables.input) });
    }
    const key = keyOf(op, variables);
    if (!(key in this.rec)) throw new Error(`fake gh: нет записи ${key}`);
    return JSON.stringify(this.rec[key]);
  };

  // --- доступ к записанному состоянию ---

  private find(prefix: string): Any {
    const key = Object.keys(this.rec).find((k) => k.startsWith(prefix + " "));
    if (!key) throw new Error(`fake gh: нет записи ${prefix}`);
    return this.rec[key];
  }
  get repo(): Any {
    return this.find("RepoState").data.repository;
  }
  get openIssues(): Any[] {
    return this.find("RepoIssues").data.repository.issues.nodes;
  }
  /** Проект, привязанный к репозиторию первым (или по id). */
  project(id?: string): Any {
    const pid = id ?? this.repo.projectsV2.nodes[0]?.id;
    const r = this.rec[keyOf("ProjectState", { id: pid })];
    if (!r) throw new Error(`fake gh: нет проекта ${pid}`);
    return r.data.node;
  }
  items(id?: string): Any[] {
    const pid = id ?? this.project().id;
    return this.rec[keyOf("ProjectItems", { id: pid })].data.node.items.nodes;
  }
  view(name: string): Any {
    return this.project().views.nodes.find((v: Any) => v.name === name);
  }
  field(name: string): Any {
    return this.project().fields.nodes.find((f: Any) => f.name === name);
  }
  item(number: number): Any {
    return this.items().find((it: Any) => it.content?.number === number);
  }
  workflow(name: string): Any {
    return this.project().workflows.nodes.find((w: Any) => w.name === name);
  }
  enableWorkflow(name: string): void {
    const wf = this.project().workflows.nodes;
    const w = wf.find((x: Any) => x.name === name);
    if (w) w.enabled = true;
    else wf.push({ id: this.id("PWF"), number: wf.length + 1, name, enabled: true });
  }

  // --- новый проект, как его создаёт GitHub ---

  private id(prefix: string): string {
    return `${prefix}_fake${++this.seq}`;
  }
  private url(number: number): string {
    const o = this.repo.owner;
    return `https://github.com/${o.__typename === "Organization" ? "orgs" : "users"}/${o.login}/projects/${number}`;
  }
  private register(node: Any, items: Any[] = []): void {
    this.rec[keyOf("ProjectState", { id: node.id })] = { data: { node } };
    this.rec[keyOf("ProjectItems", { id: node.id })] = { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items } } } };
  }
  private ref(p: Any): Any {
    return { id: p.id, number: p.number, title: p.title, url: p.url, closed: p.closed };
  }
  /** Проект, который GitHub создаёт с нуля: Status Todo / In Progress / Done, одно представление View 1. */
  newProject(title: string): Any {
    const number = 100 + this.seq;
    const builtin = ["Title:TITLE", "Assignees:ASSIGNEES", "Labels:LABELS", "Linked pull requests:LINKED_PULL_REQUESTS", "Milestone:MILESTONE", "Repository:REPOSITORY", "Reviewers:REVIEWERS", "Parent issue:PARENT_ISSUE", "Sub-issues progress:SUB_ISSUES_PROGRESS"];
    const node = {
      id: this.id("PVT"),
      number,
      title,
      url: this.url(number),
      closed: false,
      views: { nodes: [{ id: this.id("PVTV"), number: 1, name: "View 1", layout: "TABLE_LAYOUT", filter: null, sortByFields: { nodes: [] }, verticalGroupByFields: { nodes: [] } }] },
      fields: {
        nodes: [
          ...builtin.map((s) => ({ __typename: "ProjectV2Field", id: this.id("PVTF"), name: s.split(":")[0], dataType: s.split(":")[1], isIssueField: false })),
          { __typename: "ProjectV2SingleSelectField", id: this.id("PVTSSF"), name: "Status", dataType: "SINGLE_SELECT", isIssueField: false, options: ["Todo:GREEN", "In Progress:YELLOW", "Done:PURPLE"].map((s) => ({ id: this.id("opt"), name: s.split(":")[0], color: s.split(":")[1], description: "" })) },
        ],
      },
      workflows: { nodes: ["Item closed", "Pull request merged", "Auto-close issue"].map((name, i) => ({ id: this.id("PWF"), number: i + 1, name, enabled: true })) },
    };
    this.register(node);
    return node;
  }
  /** Проект владельца, не привязанный к репозиторию: его найдёт поиск по названию. */
  ownerProject(title: string): Any {
    const node = this.newProject(title);
    const key = keyOf("OwnerProjects", { login: this.repo.owner.login, query: this.repo.name });
    this.rec[key] = { data: { repositoryOwner: { projectsV2: { nodes: [this.ref(node)] } } } };
    return node;
  }
  /** Отвязать все проекты от репозитория и убрать одноимённые у владельца. */
  unlinkAll(): void {
    this.repo.projectsV2.nodes = [];
    this.rec[keyOf("OwnerProjects", { login: this.repo.owner.login, query: this.repo.name })] = { data: { repositoryOwner: { projectsV2: { nodes: [] } } } };
  }

  private statusName(p: Any, optionId: string): string {
    return p.fields.nodes.find((f: Any) => f.name === "Status").options.find((o: Any) => o.id === optionId).name;
  }

  private handlers = {
    LinkProject: ({ projectId }: Any) => {
      this.repo.projectsV2.nodes.push(this.ref(this.project(projectId)));
      return { linkProjectV2ToRepository: { repository: { id: this.repo.id } } };
    },
    UnlinkProject: ({ projectId }: Any) => {
      this.repo.projectsV2.nodes = this.repo.projectsV2.nodes.filter((p: Any) => p.id !== projectId);
      return { unlinkProjectV2FromRepository: { repository: { id: this.repo.id } } };
    },
    // Копия переносит представления, поля и настроенные workflow, кроме auto-add; задачи — нет.
    CopyProject: ({ projectId, title }: Any) => {
      const tpl = structuredClone(this.project(projectId));
      const number = 100 + this.seq;
      const node = { ...tpl, id: this.id("PVT"), number, title, url: this.url(number) };
      node.workflows.nodes = node.workflows.nodes.filter((w: Any) => w.name !== "Auto-add to project");
      this.register(node);
      return { copyProjectV2: { projectV2: this.ref(node) } };
    },
    CreateProject: ({ title, repositoryId }: Any) => {
      const node = this.newProject(title);
      if (repositoryId) this.repo.projectsV2.nodes.push(this.ref(node));
      return { createProjectV2: { projectV2: this.ref(node) } };
    },
    RenameProject: ({ projectId, title }: Any) => {
      this.project(projectId).title = title;
      for (const p of this.repo.projectsV2.nodes) if (p.id === projectId) p.title = title;
      return { updateProjectV2: { projectV2: { id: projectId } } };
    },
    CreateView: ({ projectId, name, layout }: Any) => {
      const views = this.project(projectId).views.nodes;
      const number = Math.max(0, ...views.map((v: Any) => v.number)) + 1;
      // доска, созданная через API, — колонки по Status
      views.push({ id: this.id("PVTV"), number, name, layout, filter: null, sortByFields: { nodes: [] }, verticalGroupByFields: { nodes: layout === "BOARD_LAYOUT" ? [{ name: "Status" }] : [] } });
      return { createProjectV2View: { projectV2View: { id: views.at(-1).id } } };
    },
    UpdateView: ({ viewId, ...patch }: Any) => {
      const v = this.allViews().find((x: Any) => x.id === viewId);
      Object.assign(v, patch);
      return { updateProjectV2View: { projectV2View: { id: viewId } } };
    },
    DeleteView: ({ viewId }: Any) => {
      for (const p of this.allProjects()) p.views.nodes = p.views.nodes.filter((v: Any) => v.id !== viewId);
      return { deleteProjectV2View: { clientMutationId: null } };
    },
    CreateField: ({ projectId, dataType, name, singleSelectOptions }: Any) => {
      const f: Any = { __typename: dataType === "SINGLE_SELECT" ? "ProjectV2SingleSelectField" : "ProjectV2Field", id: this.id("PVTF"), name, dataType, isIssueField: false };
      if (singleSelectOptions) f.options = singleSelectOptions.map((o: Any) => ({ id: this.id("opt"), ...o }));
      this.project(projectId).fields.nodes.push(f);
      return { createProjectV2Field: { clientMutationId: null } };
    },
    // Вариант с id переименовывается и сохраняет значения задач; без id — новый вариант.
    UpdateField: ({ fieldId, singleSelectOptions }: Any) => {
      const f = this.allProjects().flatMap((p) => p.fields.nodes).find((x: Any) => x.id === fieldId);
      f.options = singleSelectOptions.map((o: Any) => ({ ...o, id: o.id ?? this.id("opt") }));
      return { updateProjectV2Field: { clientMutationId: null } };
    },
    DeleteField: ({ fieldId }: Any) => {
      for (const p of this.allProjects()) p.fields.nodes = p.fields.nodes.filter((f: Any) => f.id !== fieldId);
      return { deleteProjectV2Field: { clientMutationId: null } };
    },
    AddIssueField: ({ projectId, issueFieldId }: Any) => {
      const src = this.repo.owner.issueFields.nodes.find((f: Any) => f.id === issueFieldId);
      this.project(projectId).fields.nodes.push({ __typename: "ProjectV2SingleSelectField", id: this.id("PVTSSF"), name: src.name, dataType: "SINGLE_SELECT", isIssueField: true, options: [] });
      return { createProjectV2IssueField: { clientMutationId: null } };
    },
    SetItemStatus: ({ projectId, itemId, value }: Any) => {
      const it = this.items(projectId).find((x: Any) => x.id === itemId);
      it.status = { name: this.statusName(this.project(projectId), value.singleSelectOptionId) };
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } };
    },
    // Задачу, добавленную в проект, «Item added to project» сразу ставит в Бэклог — если он включён.
    AddItem: ({ projectId, contentId }: Any) => {
      const issue = this.openIssues.find((i: Any) => i.id === contentId);
      const added = this.project(projectId).workflows.nodes.some((w: Any) => w.name === "Item added to project" && w.enabled);
      const it = { id: this.id("PVTI"), content: { __typename: "Issue", id: issue.id, number: issue.number, state: "OPEN", stateReason: null }, status: added ? { name: "Бэклог" } : null };
      this.items(projectId).push(it);
      return { addProjectV2ItemById: { item: { id: it.id } } };
    },
    DeleteItem: ({ projectId, itemId }: Any) => {
      const nodes = this.items(projectId);
      nodes.splice(nodes.findIndex((x: Any) => x.id === itemId), 1);
      return { deleteProjectV2Item: { deletedItemId: itemId } };
    },
    CreateIssueType: ({ name, isEnabled }: Any) => {
      this.repo.owner.issueTypes.nodes.push({ id: this.id("IT"), name, isEnabled });
      return { createIssueType: { issueType: { id: "x" } } };
    },
    UpdateIssueType: ({ issueTypeId, ...patch }: Any) => {
      Object.assign(this.repo.owner.issueTypes.nodes.find((t: Any) => t.id === issueTypeId), patch);
      return { updateIssueType: { issueType: { id: issueTypeId } } };
    },
  };

  private allProjects(): Any[] {
    return Object.entries(this.rec)
      .filter(([k]) => k.startsWith("ProjectState "))
      .map(([, v]) => v.data.node);
  }
  private allViews(): Any[] {
    return this.allProjects().flatMap((p) => p.views.nodes);
  }
}

/** Запись того же репозитория, но в организации (вымышленной): Priority — поле issue, типы issue. */
export function asOrg(rec: Recording, org = "acme"): Recording {
  const login = Object.values(rec).find((r: Any) => r?.data?.repository?.owner)?.data.repository.owner.login;
  const json = JSON.stringify(rec).replaceAll(`github.com/users/${login}/`, `github.com/orgs/${org}/`).replaceAll(`"${login}`, `"${org}`).replaceAll(`\\"${login}\\"`, `\\"${org}\\"`);
  const out: Recording = JSON.parse(json);
  const repoKey = Object.keys(out).find((k) => k.startsWith("RepoState "))!;
  out[repoKey].data.repository.owner = {
    __typename: "Organization",
    id: "O_fake",
    login: org,
    issueTypes: { nodes: [{ id: "IT_1", name: "Задача", isEnabled: true }, { id: "IT_2", name: "Баг", isEnabled: true }, { id: "IT_3", name: "Feature", isEnabled: false }, { id: "IT_4", name: "Эпик", isEnabled: true }] },
    issueFields: { nodes: [{ __typename: "IssueFieldSingleSelect", id: "IFSS_priority", name: "Priority" }] },
  };
  return out;
}
