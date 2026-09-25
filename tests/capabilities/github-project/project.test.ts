/**
 * Скилл `github`, `project check` и `project fix`: проект GitHub репозитория сверяется с каноном `AGENTS.md` по
 * пунктам ✅/❌ и доводится до него.
 *
 * Сверка и исправление — одна функция: каждое расхождение несёт свой шаг, поэтому `check` и `fix` не расходятся.
 * Что умеет API, `fix` делает сам; чего в API нет (workflow, сортировка, колонки доски) — шаг UI со ссылкой;
 * удаление и переименование в проекте с задачами и настройки организации — только с `--confirm`. Ответы GitHub —
 * записанные с проекта ai-dev (`ai-dev.json`), `gh` подменён: мутации меняют запись так, как это сделал бы GitHub.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

import { main } from "../../../skills/github/scripts/github.ts";
import { asOrg, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";

const REC: Recording = JSON.parse(readFileSync(new URL("./ai-dev.json", import.meta.url), "utf8"));
const REPO = "miroshnik/ai-dev";
const PROJECT_URL = "https://github.com/users/miroshnik/projects/6";

function run(fake: FakeGitHub, args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { gh: fake.gh, out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const check = (fake: FakeGitHub, repo = REPO) => run(fake, ["project", "check", "--repo", repo]);
const fix = (fake: FakeGitHub, opts: { repo?: string; confirm?: boolean } = {}) =>
  run(fake, ["project", "fix", "--repo", opts.repo ?? REPO, ...(opts.confirm ? ["--confirm"] : [])]);

/** Пункты сверки: первое слово заголовка → ✅ или ❌ (после «Итог:», если он есть). */
function marks(out: string): Record<string, string> {
  const tail = out.includes("Итог:") ? out.slice(out.indexOf("Итог:")) : out;
  return Object.fromEntries([...tail.matchAll(/^(✅|❌) (\S+)/gmu)].map((m) => [m[2]!.replace(/:$/, ""), m[1]!]));
}
const ops = (fake: FakeGitHub) => fake.mutations.map((m) => m.op);
const byOp = (fake: FakeGitHub, op: string) => fake.mutations.filter((m) => m.op === op).map((m) => m.input);

function fake(rec: Recording = REC): FakeGitHub {
  return new FakeGitHub(rec);
}
/** Проект, у которого в UI не настраивали «Item added to project» и «Auto-add to project» — как ai-dev до fix. */
function unconfigured(f: FakeGitHub = fake()): FakeGitHub {
  for (const name of ["Item added to project", "Auto-add to project"]) f.unconfigure(name);
  return f;
}
const wfUrl = (f: FakeGitHub, name: string) => `${f.project().url}/workflows/${f.workflow(name).fullDatabaseId}`;

describe("check — сверка с каноном по пунктам", () => {
  it("проект ai-dev как записан — все пункты ✅, код 0; в личном аккаунте Priority и типы issue не проверяются", () => {
    const r = check(fake());
    expect(r.code).toBe(0);
    expect(r.out).toStartWith(`Проект ${REPO}: ${PROJECT_URL}`);
    expect(marks(r.out)).toEqual({ Проект: "✅", Представления: "✅", Status: "✅", Поля: "✅", Workflow: "✅", Закрытые: "✅", Открытые: "✅" });
    expect(r.out).toContain("➖ Priority и типы issue — в личном аккаунте их нет");
  });

  // ненастроенного workflow в API нет вовсе — у нового проекта в списке только «Item closed» и два про PR
  it("workflow «Item added to project» и «Auto-add to project» не настраивали — ❌ «не настроен», код 1", () => {
    const r = check(unconfigured());
    expect(r.code).toBe(1);
    expect(marks(r.out)).toMatchObject({ Workflow: "❌", Закрытые: "✅" });
    expect(r.out).toContain("· «Item added to project» не настроен");
    expect(r.out).toContain("· «Auto-add to project» не настроен");
  });

  // выключенный workflow есть в списке с enabled: false — ссылка ведёт прямо на него
  it("выключенный «Item closed» — ❌ «выключен», отличается от ненастроенного", () => {
    const f = fake();
    f.workflow("Item closed").enabled = false;
    const r = check(f);
    expect(marks(r.out).Workflow).toBe("❌");
    expect(r.out).toMatch(/^   · «Item closed» выключен$/m);
    expect(fix(f).out).toContain(`«Item closed»: Edit → Set value → Status: Готово → Save and turn on workflow — ${wfUrl(f, "Item closed")}`);
  });

  // фильтр вроде iteration:@current без поля Iteration молча прячет задачи с доски
  it("фильтр, чужой вид, доска не по Status и лишнее представление — ❌ представлений с каждой причиной", () => {
    const f = fake();
    f.view("Доска").filter = "iteration:@current";
    f.view("Доска").verticalGroupByFields.nodes = [];
    f.view("Роадмэп").layout = "TABLE_LAYOUT";
    f.project().views.nodes.push({ ...structuredClone(f.view("Таблица")), id: "PVTV_extra", number: 9, name: "Мои задачи" });
    const r = check(f);
    expect(marks(r.out).Представления).toBe("❌");
    expect(r.out).toContain("· у «Доска» фильтр «iteration:@current»");
    expect(r.out).toContain("· колонки «Доска» не по Status");
    expect(r.out).toContain("· «Роадмэп» — TABLE_LAYOUT");
    expect(r.out).toContain("· лишнее «Мои задачи»");
  });

  it("чужие варианты Status, недостающее числовое поле и своё поле сверх канона — ❌", () => {
    const f = fake();
    f.field("Status").options[0].name = "Todo";
    f.project().fields.nodes = f.project().fields.nodes.filter((x: { name: string }) => x.name !== "Токены, млн");
    f.project().fields.nodes.push({ __typename: "ProjectV2IterationField", id: "PVTIF_1", name: "Iteration", dataType: "ITERATION" });
    const r = check(f);
    expect(marks(r.out)).toMatchObject({ Status: "❌", Поля: "❌" });
    expect(r.out).toContain("· варианты: Todo, В работе, Готово");
    expect(r.out).toContain("· нет «Токены, млн»");
    expect(r.out).toContain("· лишнее «Iteration» (ITERATION)");
  });

  it("закрытая не в Готово, закрытая без выполнения в проекте, открытая вне проекта и без Status — ❌", () => {
    const f = fake();
    f.item(1).status = { name: "В работе" };
    f.item(3).content.stateReason = "NOT_PLANNED";
    f.item(3).status = { name: "В работе" };
    f.items().splice(f.items().indexOf(f.item(47)), 1);
    f.item(42).status = null;
    const r = check(f);
    expect(marks(r.out)).toMatchObject({ Закрытые: "❌", Открытые: "❌" });
    expect(r.out).toMatch(/^   · не в «Готово»: #1$/m); // закрытая без выполнения в «Готово» не нужна — её убирают
    expect(r.out).toContain("· закрыты без выполнения, но в проекте: #3");
    expect(r.out).toContain("· не в проекте: #47");
    expect(r.out).toContain("· без Status: #42");
  });

  it("к репозиторию не привязан проект — единственный пункт ❌, остальное без проекта не проверить", () => {
    const f = fake();
    f.unlinkAll();
    const r = check(f);
    expect(r.code).toBe(1);
    expect(r.out).toStartWith(`Проект ${REPO}: нет`);
    expect(marks(r.out)).toEqual({ Проект: "❌" });
  });

  it("облачная сессия — объяснение и код 2, а не сбой gh на Projects v2", () => {
    const r = run(fake(), ["project", "check", "--repo", REPO], { CLAUDE_CODE_REMOTE: "true" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("облачная сессия");
    expect(r.out).toBe("");
  });
});

describe("fix — довести до канона", () => {
  it("исправимое через API исправляет сам и сверяет заново: все ✅, код 0", () => {
    const f = fake();
    f.view("Доска").filter = "iteration:@current";
    f.project().views.nodes = f.project().views.nodes.filter((v: { name: string }) => v.name !== "Роадмэп");
    f.project().fields.nodes = f.project().fields.nodes.filter((x: { name: string }) => x.name !== "Токены, млн");
    f.item(3).content.stateReason = "NOT_PLANNED";
    f.items().splice(f.items().indexOf(f.item(47)), 1);
    f.item(42).status = null;
    const r = fix(f);
    expect(r.code).toBe(0);
    expect(Object.values(marks(r.out))).not.toContain("❌");
    expect(byOp(f, "UpdateView")).toEqual([{ viewId: f.view("Доска").id, filter: "" }]);
    expect(byOp(f, "CreateView")).toEqual([{ projectId: f.project().id, name: "Роадмэп", layout: "ROADMAP_LAYOUT" }]);
    expect(byOp(f, "CreateField")).toEqual([{ projectId: f.project().id, dataType: "NUMBER", name: "Токены, млн" }]);
    expect(byOp(f, "DeleteItem").map((i) => i.itemId)).toEqual([REC_ITEM(3)]);
    expect(byOp(f, "AddItem").map((i) => i.contentId)).toEqual([openIssueId(47)]);
    expect(f.item(42).status).toEqual({ name: "Бэклог" });
    expect(r.out).toContain("+ «Доска»: снять фильтр «iteration:@current»");
    expect(r.out).not.toContain("Шаги в UI");
  });

  it("закрытая задача не в Готово — ставит Готово и просит проверить цель «Item closed» в UI", () => {
    const f = fake();
    f.item(1).status = { name: "В работе" };
    const r = fix(f);
    expect(f.item(1).status).toEqual({ name: "Готово" });
    expect(marks(r.out).Закрытые).toBe("✅");
    expect(r.out).toContain(`«Item closed»: проверить Set value → Status: Готово, иначе Edit → Готово → Save — ${wfUrl(f, "Item closed")}`);
    expect(r.code).toBe(1);
  });

  it("ненастроенные workflow — шаги UI со ссылкой на список workflow проекта, API их не включает", () => {
    const f = unconfigured();
    const r = fix(f);
    expect(r.code).toBe(1);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("Шаги в UI — браузером сессии, без браузера — пользователю; затем снова check:");
    expect(r.out).toMatch(new RegExp(`^1\\. «Item added to project»: Edit → Set value → Status: Бэклог → Save and turn on workflow — ${PROJECT_URL}/workflows$`, "m"));
    expect(r.out).toMatch(new RegExp(`^2\\. «Auto-add to project»: Edit → репозиторий ai-dev, фильтр is:issue is:open \\(Enter\\) → Save and turn on workflow — ${PROJECT_URL}/workflows$`, "m"));
  });

  it("доска не по Status — шаг UI со ссылкой на представление", () => {
    const f = fake();
    f.view("Доска").verticalGroupByFields.nodes = [];
    const r = fix(f);
    expect(r.out).toContain(`«Доска»: View options → Column by → Status → Save — ${PROJECT_URL}/views/${f.view("Доска").number}`);
  });

  it("в проекте с задачами удаление и переименование — только с --confirm, до него списком на подтверждение", () => {
    const f = fake();
    f.project().title = "AI dev";
    f.repo.projectsV2.nodes[0].title = "AI dev";
    f.project().views.nodes.push({ ...structuredClone(f.view("Таблица")), id: "PVTV_extra", number: 9, name: "Мои задачи" });
    f.project().fields.nodes.push({ __typename: "ProjectV2IterationField", id: "PVTIF_1", name: "Iteration", dataType: "ITERATION" });
    const doneId = f.field("Status").options[2].id;
    f.field("Status").options[2].name = "Done";

    const before = fix(f);
    expect(before.code).toBe(1);
    expect(f.mutations).toEqual([]);
    expect(before.out).toContain("Нужно подтверждение пользователя — затем fix --confirm:");
    for (const s of ["переименовать проект «AI dev» → «ai-dev»", "удалить представление «Мои задачи»", "удалить поле «Iteration»", "Status: Бэклог, В работе, Готово (существующие переименовать с тем же id)"]) {
      expect(before.out).toContain(s);
    }

    const after = fix(f, { confirm: true });
    expect(ops(f).sort()).toEqual(["DeleteField", "DeleteView", "RenameProject", "UpdateField"]);
    expect(byOp(f, "UpdateField")[0].singleSelectOptions[2]).toEqual({ id: doneId, name: "Готово", color: "PURPLE", description: "" });
    expect(after.code).toBe(0);
    expect(Object.values(marks(after.out))).not.toContain("❌");
  });

  it("проекта нет — привязывает одноимённый проект владельца, а не заводит новый", () => {
    const f = fake();
    f.unlinkAll();
    const own = f.ownerProject("ai-dev");
    const r = fix(f);
    expect(byOp(f, "LinkProject")).toEqual([{ projectId: own.id, repositoryId: f.repo.id }]);
    expect(ops(f)).not.toContain("CopyProject");
    expect(ops(f)).not.toContain("CreateProject");
    expect(r.out).toContain(`+ привязан проект «ai-dev» (${own.url})`);
  });

  it("проекта нет — копирует эталон под владельца репозитория и привязывает; из шагов остаётся только auto-add", () => {
    const f = fake(); // эталон: все workflow настроены, auto-add копия не переносит
    const template = f.project();
    f.unlinkAll();
    const r = fix(f);
    expect(byOp(f, "CopyProject")).toEqual([{ projectId: template.id, ownerId: f.repo.owner.id, title: "ai-dev", includeDraftIssues: false }]);
    const copy = f.project();
    expect(copy.id).not.toBe(template.id);
    expect(byOp(f, "AddItem").map((i) => i.contentId)).toEqual(f.openIssues.map((i: { id: string }) => i.id));
    expect(marks(r.out)).toMatchObject({ Проект: "✅", Представления: "✅", Status: "✅", Поля: "✅", Workflow: "❌", Открытые: "✅" });
    expect(r.out).toContain(`1. «Auto-add to project»: Edit → репозиторий ai-dev, фильтр is:issue is:open (Enter) → Save and turn on workflow — ${copy.url}/workflows`);
    expect(r.out).not.toContain("2. ");
  });

  it("эталон недоступен — создаёт проект с нуля: варианты Status переименовывает с теми же id, View 1 → Таблица", () => {
    const f = fake();
    f.unlinkAll();
    f.rec['TemplateProject {"login":"miroshnik","number":6}'] = { data: { repositoryOwner: { projectV2: null } }, errors: [{ message: "Could not resolve to a ProjectV2 with the number 6." }] };
    const r = fix(f);
    expect(ops(f)[0]).toBe("CreateProject");
    expect(r.err).toContain("эталон miroshnik/6 не найден — проект создаётся с нуля");
    const created = f.project();
    const status = created.fields.nodes.find((x: { name: string }) => x.name === "Status");
    expect(byOp(f, "UpdateField")[0].singleSelectOptions.map((o: { id: string; name: string }) => [o.name, o.id])).toEqual(status.options.map((o: { id: string; name: string }) => [o.name, o.id]));
    expect(status.options.map((o: { name: string }) => o.name)).toEqual(["Бэклог", "В работе", "Готово"]);
    expect(byOp(f, "UpdateView")).toEqual([{ viewId: created.views.nodes[0].id, name: "Таблица" }]);
    expect(byOp(f, "CreateView").map((v) => v.name)).toEqual(["Доска", "Роадмэп"]);
    expect(byOp(f, "CreateField").map((v) => v.name)).toEqual(["Оценка, ч", "Факт, ч", "Токены, млн", "Стоимость, $"]);
    expect(marks(r.out)).toMatchObject({ Проект: "✅", Представления: "✅", Status: "✅", Поля: "✅", Workflow: "❌", Открытые: "✅" });
  });
});

describe("Организация: Priority и типы issue", () => {
  const ORG = "acme/ai-dev";
  const ORG_URL = "https://github.com/orgs/acme/projects/6";
  const org = () => fake(asOrg(REC));

  it("поле issue Priority не подключено — fix подключает; Таблица и Доска не по Priority — шаги UI", () => {
    const f = org();
    const r0 = check(f, ORG);
    expect(marks(r0.out)).toMatchObject({ Priority: "❌", Типы: "✅" });
    expect(r0.out).toContain("· поле issue Priority не подключено");
    expect(r0.out).not.toContain("➖");
    const r = fix(f, { repo: ORG });
    expect(byOp(f, "AddIssueField")).toEqual([{ projectId: f.project().id, issueFieldId: "IFSS_priority" }]);
    expect(r.out).toContain(`«Таблица»: View options → Sort by → Priority → Save — ${ORG_URL}/views/${f.view("Таблица").number}`);
    expect(r.out).toContain(`«Доска»: View options → Sort by → Priority → Save — ${ORG_URL}/views/${f.view("Доска").number}`);
    for (const name of ["Таблица", "Доска"]) f.view(name).sortByFields.nodes = [{ direction: "ASC", field: { name: "Priority" } }];
    expect(check(f, ORG).code).toBe(0);
  });

  it("другое поле issue организации в проекте — лишнее, как своё поле", () => {
    const f = org();
    f.project().fields.nodes.push({ __typename: "ProjectV2SingleSelectField", id: "PVTSSF_effort", name: "Effort", dataType: "SINGLE_SELECT", isIssueField: true, options: [] });
    const r = check(f, ORG);
    expect(marks(r.out).Поля).toBe("❌");
    expect(r.out).toContain("· лишнее «Effort» (SINGLE_SELECT, поле issue)");
  });

  it("своё поле проекта Priority вместо поля issue — замена только с --confirm", () => {
    const f = org();
    f.project().fields.nodes.push({ __typename: "ProjectV2SingleSelectField", id: "PVTSSF_own", name: "Priority", dataType: "SINGLE_SELECT", isIssueField: false, options: [] });
    expect(check(f, ORG).out).toContain("· своё поле проекта «Priority» вместо поля issue");
    fix(f, { repo: ORG });
    expect(ops(f)).toEqual([]);
    fix(f, { repo: ORG, confirm: true });
    expect(ops(f)).toEqual(["DeleteField", "AddIssueField"]);
    expect(f.project().fields.nodes.filter((x: { name: string }) => x.name === "Priority").map((x: { isIssueField: boolean }) => x.isIssueField)).toEqual([true]);
  });

  it("типы Task, Bug, Feature — переименовать, создать Эпик, выключить лишний; всё — только с --confirm", () => {
    const f = org();
    f.repo.owner.issueTypes.nodes = [{ id: "IT_t", name: "Task", isEnabled: true }, { id: "IT_b", name: "Bug", isEnabled: true }, { id: "IT_f", name: "Feature", isEnabled: true }];
    const r0 = check(f, ORG);
    expect(marks(r0.out).Типы).toBe("❌");
    expect(r0.out).toContain("· лишний «Feature»");
    fix(f, { repo: ORG });
    expect(ops(f).filter((o) => o.includes("IssueType"))).toEqual([]);
    const r = fix(f, { repo: ORG, confirm: true });
    expect(byOp(f, "UpdateIssueType")).toEqual([
      { issueTypeId: "IT_t", name: "Задача", isEnabled: true },
      { issueTypeId: "IT_b", name: "Баг", isEnabled: true },
      { issueTypeId: "IT_f", isEnabled: false },
    ]);
    expect(byOp(f, "CreateIssueType")).toEqual([{ ownerId: f.repo.owner.id, name: "Эпик", isEnabled: true, color: "PURPLE" }]);
    expect(marks(r.out).Типы).toBe("✅");
  });

  it("нет прав на настройку организации — строка «!» с ошибкой и ссылкой на UI, код 1, остальное сделано", () => {
    const f = org();
    f.repo.owner.issueTypes.nodes.find((t: { name: string }) => t.name === "Эпик").isEnabled = false;
    f.failing.UpdateIssueType = "Resource not accessible by integration";
    const r = fix(f, { repo: ORG, confirm: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("! включить тип «Эпик»: GraphQL: Resource not accessible by integration — в UI: https://github.com/organizations/acme/settings/issue-types");
    expect(ops(f)).toContain("AddIssueField");
  });
});

function REC_ITEM(n: number): string {
  const items = Object.entries(REC).find(([k]) => k.startsWith("ProjectItems "))![1].data.node.items.nodes;
  return items.find((it: { content: { number: number } }) => it.content.number === n).id;
}
function openIssueId(n: number): string {
  const issues = Object.entries(REC).find(([k]) => k.startsWith("RepoIssues "))![1].data.repository.issues.nodes;
  return issues.find((i: { number: number }) => i.number === n).id;
}
