import { readFileSync } from "node:fs";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { main } from "../../../skills/github/scripts/github.ts";
import { asOrg, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

// модель архитектуры скилл читает отдельным процессом bun
setDefaultTimeout(SPAWN_TIMEOUT);

// Ответы GitHub — записанные с проекта ai-dev, `gh` подменён: мутации меняют запись так, как это сделал бы GitHub
const REC: Recording = JSON.parse(readFileSync(new URL("../../lib/github-ai-dev.json", import.meta.url), "utf8"));
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

describe("check показывает каждое расхождение с каноном отдельным пунктом", () => {
  it("проект ai-dev как записан — все пункты ✅, код 0; в личном аккаунте Priority и типы issue не проверяются", () => {
    const r = check(fake());
    expect(r.code).toBe(0);
    expect(r.out).toStartWith(`Проект ${REPO}: ${PROJECT_URL}`);
    expect(marks(r.out)).toEqual({ Проект: "✅", Представления: "✅", Status: "✅", Поля: "✅", Workflow: "✅", Закрытые: "✅", Открытые: "✅", Метки: "✅", Мерж: "✅", Способ: "✅" });
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

  it("к репозиторию не привязан проект — из пунктов проекта только этот ❌, остальные без проекта не проверить; правило основной ветки и способ мержа сверяются", () => {
    const f = fake();
    f.unlinkAll();
    const r = check(f);
    expect(r.code).toBe(1);
    expect(r.out).toStartWith(`Проект ${REPO}: нет`);
    expect(marks(r.out)).toEqual({ Проект: "❌", Мерж: "✅", Способ: "✅" });
  });

  it("облачная сессия — объяснение и код 2, а не сбой gh на Projects v2", () => {
    const r = run(fake(), ["project", "check", "--repo", REPO], { CLAUDE_CODE_REMOTE: "true" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("облачная сессия");
    expect(r.out).toBe("");
  });
});

describe("fix доводит проект до канона: через API — сам, остальное — шагом UI или после подтверждения", () => {
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

describe("В организации сверяются ещё поле Priority и типы issue", () => {
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

// модель архитектуры, как её пишет проект: тип — только `import type`, его путь в проекте не нужен
const MODEL = `import type { Model } from "../../.agents/skills/spec/scripts/architecture.ts";

export default { modules: { domain: { path: "src/domain", purpose: "правила" } } } satisfies Model;
`;
const labelNames = (f: FakeGitHub) => f.labels.map((l) => l.name).sort();
const CAP = "0E8A16";
const STD = "1D76DB";
const ARCH = "D93F0B";
const issueLabels = (f: FakeGitHub, n: number) => f.issue(n).labels.nodes.map((l: { name: string }) => l.name);

/**
 * Метка решения связывает задачу с решением: capability, стандартом, правилом или модулем архитектуры. Имя метки —
 * имя решения, вид виден по цвету. Набор меток сверяется с деревом спеки и моделью основной ветки: метка без
 * решения путает историю задач, решение без метки — задачи по нему не найти.
 */
describe("Метки решений — имя решения без вида, вид — цветом; набор сверяется с деревом спеки и моделью в основной ветке", () => {
  it("решение в main без метки — ❌, fix создаёт метку с именем решения и цветом вида", () => {
    const f = fake();
    Object.assign(f.tree, { capabilities: ["billing"], standards: ["audit"], architecture: ["boundaries"], model: MODEL });
    const r = check(f);
    expect(r.code).toBe(1);
    expect(marks(r.out).Метки).toBe("❌");
    expect(r.out).toContain("· решения без метки: billing, audit, boundaries, domain");
    const x = fix(f);
    expect(byOp(f, "CreateLabel")).toEqual([
      { repositoryId: f.repo.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" },
      { repositoryId: f.repo.id, name: "audit", color: STD, description: "Решение: tests/standards/audit" },
      { repositoryId: f.repo.id, name: "boundaries", color: ARCH, description: "Решение: tests/architecture — правило или модуль boundaries" },
      { repositoryId: f.repo.id, name: "domain", color: ARCH, description: "Решение: tests/architecture — правило или модуль domain" },
    ]);
    expect(marks(x.out).Метки).toBe("✅");
  });

  /** Совпавшие имена — обычно одна тема (модуль billing делает capability billing): по одной метке их и ищут. */
  it("одно имя у решений разных видов — одна метка цвета старшего вида, в описании оба пути", () => {
    const f = fake();
    Object.assign(f.tree, { capabilities: ["domain"], model: MODEL });
    fix(f);
    expect(byOp(f, "CreateLabel")).toEqual([
      { repositoryId: f.repo.id, name: "domain", color: CAP, description: "Решение: tests/capabilities/domain; tests/architecture — правило или модуль domain" },
    ]);
    expect(marks(check(f).out).Метки).toBe("✅");
  });

  it("описание длиннее 100 символов GitHub не примет — в нём только виды решения", () => {
    const f = fake();
    Object.assign(f.tree, { capabilities: ["domain"], standards: ["domain"], model: MODEL });
    fix(f);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "domain", color: CAP, description: "Решение: capability, standard, architecture" }]);
    expect(marks(check(f).out).Метки).toBe("✅");
  });

  it("у метки решения появился второй вид — fix дописывает его в описание", () => {
    const f = fake();
    Object.assign(f.tree, { capabilities: ["domain"], model: MODEL });
    const l = f.label("domain", ARCH, "Решение: tests/architecture — правило или модуль domain");
    expect(check(f).out).toContain(`· метка «domain» цвета ${ARCH}, а не ${CAP}`);
    fix(f);
    expect(byOp(f, "UpdateLabel")).toEqual([{ id: l.id, color: CAP, description: "Решение: tests/capabilities/domain; tests/architecture — правило или модуль domain" }]);
  });

  it("метка решения без папки или модуля в main — ❌, удаляется только с --confirm", () => {
    const f = fake();
    f.tree.capabilities = ["billing"];
    f.label("billing", CAP, "Решение: tests/capabilities/billing");
    f.label("old", CAP, "Решение: tests/capabilities/old");
    f.label("gone", STD, "Решение: tests/standards/gone");
    f.label("вопросы", "FBCA04");
    expect(check(f).out).toContain("· метка «old» без решения в основной ветке");
    const r = fix(f);
    expect(ops(f)).not.toContain("DeleteLabel");
    expect(r.out).toContain("удалить метку «gone»");
    const x = fix(f, { confirm: true });
    expect(labelNames(f)).toEqual(["billing", "вопросы"]);
    expect(marks(x.out).Метки).toBe("✅");
  });

  /**
   * `task new --labels standard:quarter-format` ставит задаче метку решения, которого в основной ветке ещё нет:
   * решение придёт с PR задачи. Пока задача открыта, метка — не лишняя, а новое решение.
   */
  it("метка нового решения на открытой задаче — не ❌, а строка «новое решение» с номерами открытых задач; fix её не удаляет", () => {
    const f = fake();
    f.label("quarter-format", STD, "Решение: tests/standards/quarter-format");
    f.labelIssue(49, "quarter-format");
    f.labelIssue(46, "quarter-format");
    const r = check(f);
    expect(r.code).toBe(0);
    expect(marks(r.out).Метки).toBe("✅");
    expect(r.out).toContain("○ новое решение «quarter-format»: в основной ветке ещё нет, метка на открытых задачах #49");
    fix(f, { confirm: true });
    expect(ops(f)).not.toContain("DeleteLabel");
    expect(issueLabels(f, 49)).toContain("quarter-format");
  });

  it("метка без решения только на закрытых задачах — ❌, удаляется с --confirm", () => {
    const f = fake();
    f.label("quarter-format", STD, "Решение: tests/standards/quarter-format");
    f.labelIssue(49, "quarter-format");
    f.labelIssue(46, "quarter-format");
    f.closed(49);
    const r = check(f);
    expect(marks(r.out).Метки).toBe("❌");
    expect(r.out).toContain("· метка «quarter-format» без решения в основной ветке, открытых задач с ней нет");
    expect(r.out).not.toContain("новое решение");
    fix(f, { confirm: true });
    expect(labelNames(f)).not.toContain("quarter-format");
    expect(issueLabels(f, 46)).not.toContain("quarter-format");
  });

  /** Метка открытой задачи — её новое решение, а не переименованная папка: переименовать её — отнять у задачи. */
  it("метка нового решения не переименовывается в решение без метки того же вида — тому fix создаёт свою", () => {
    const f = fake();
    f.tree.standards = ["audit"];
    f.label("quarter-format", STD, "Решение: tests/standards/quarter-format");
    f.labelIssue(49, "quarter-format");
    const r = fix(f, { confirm: true });
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "audit", color: STD, description: "Решение: tests/standards/audit" }]);
    expect(ops(f)).not.toContain("UpdateLabel");
    expect(labelNames(f)).toEqual(["audit", "quarter-format"]);
    expect(marks(r.out).Метки).toBe("✅");
  });

  it("папку решения переименовали — метка переименовывается с --confirm, задачи сохраняют её", () => {
    const f = fake();
    f.tree.capabilities = ["invoicing"];
    const old = f.label("billing", CAP, "Решение: tests/capabilities/billing");
    // открытая задача с меткой сделала бы её новым решением — переименовывают метку только закрытых задач
    f.labelIssue(46, "billing");
    const r = fix(f);
    expect(ops(f)).not.toContain("CreateLabel");
    expect(r.out).toContain("переименовать метку «billing» → «invoicing» (задачи сохранят её)");
    fix(f, { confirm: true });
    expect(byOp(f, "UpdateLabel")).toEqual([{ id: old.id, name: "invoicing", color: CAP, description: "Решение: tests/capabilities/invoicing" }]);
    expect(ops(f)).not.toContain("CreateLabel");
    expect(issueLabels(f, 46)).toContain("invoicing");
  });

  it("метка решения чужого цвета — fix перекрашивает в цвет вида", () => {
    const f = fake();
    f.tree.standards = ["audit"];
    const l = f.label("audit", "ededed", "Решение: tests/standards/audit");
    expect(check(f).out).toContain(`· метка «audit» цвета ededed, а не ${STD}`);
    fix(f);
    expect(byOp(f, "UpdateLabel")).toEqual([{ id: l.id, color: STD, description: "Решение: tests/standards/audit" }]);
  });

  it("модель не загружается — метки модулей не сверяются и не удаляются, check называет причину", () => {
    const f = fake();
    Object.assign(f.tree, { architecture: ["boundaries"], model: "export default {\n" });
    f.label("boundaries", ARCH, "Решение: tests/architecture — правило или модуль boundaries");
    f.label("domain", ARCH, "Решение: tests/architecture — правило или модуль domain");
    const r = check(f);
    expect(marks(r.out).Метки).toBe("❌");
    expect(r.out).toContain("· модель tests/architecture/model.ts не загружается — метки модулей не сверяются");
    fix(f, { confirm: true });
    expect(ops(f)).not.toContain("DeleteLabel");
    expect(labelNames(f)).toEqual(["boundaries", "domain"]);
  });

  it("метка старого вида `вид:имя` — fix переименовывает её в имя без --confirm, задачи сохраняют её", () => {
    const f = fake();
    Object.assign(f.tree, { capabilities: ["billing"], model: MODEL });
    const billing = f.label("capability:billing", CAP);
    const domain = f.label("architecture:domain", "FBCA04");
    f.labelIssue(49, "capability:billing");
    expect(check(f).out).toContain("· метка «capability:billing» старого вида `вид:имя`");
    const r = fix(f);
    expect(r.out).toContain("+ переименовать метку «capability:billing» → «billing» (задачи сохранят её)");
    expect(byOp(f, "UpdateLabel")).toEqual([
      { id: billing.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" },
      { id: domain.id, name: "domain", color: ARCH, description: "Решение: tests/architecture — правило или модуль domain" },
    ]);
    expect(issueLabels(f, 49)).toContain("billing");
    expect(marks(r.out).Метки).toBe("✅");
  });

  /** Старая метка нового решения — та же старая метка: имя не зависит от того, влито ли решение. */
  it("метка старого вида `вид:имя` без решения в main — fix так же переименовывает её в имя, задачи сохраняют её", () => {
    const f = fake();
    const old = f.label("standard:quarter-format", STD);
    f.labelIssue(49, "standard:quarter-format");
    expect(check(f).out).toContain("· метка «standard:quarter-format» старого вида `вид:имя`");
    const r = fix(f);
    expect(r.out).toContain("+ переименовать метку «standard:quarter-format» → «quarter-format» (задачи сохранят её)");
    expect(byOp(f, "UpdateLabel")).toEqual([{ id: old.id, name: "quarter-format", color: STD, description: "Решение: tests/standards/quarter-format" }]);
    expect(issueLabels(f, 49)).toContain("quarter-format");
    expect(marks(r.out).Метки).toBe("✅");
  });

  it("старая метка, чьё имя уже занято, — сливается с --confirm: задачи получают метку с именем, старая удаляется", () => {
    const f = fake();
    Object.assign(f.tree, { capabilities: ["audit"], standards: ["audit"] });
    f.label("capability:audit", CAP);
    f.label("standard:audit", STD);
    f.labelIssue(49, "capability:audit");
    f.labelIssue(47, "standard:audit");
    const r = fix(f);
    expect(r.out).toContain("слить метку «standard:audit» в «audit»: #47 получат «audit», старая удаляется");
    expect(ops(f)).not.toContain("DeleteLabel");
    expect(issueLabels(f, 47)).toEqual(["standard:audit"]);
    const x = fix(f, { confirm: true });
    expect(labelNames(f)).toEqual(["audit"]);
    expect(f.labels[0]!.description).toBe("Решение: tests/capabilities/audit; tests/standards/audit");
    expect(issueLabels(f, 47)).toEqual(["audit"]);
    expect(issueLabels(f, 49)).toEqual(["audit"]);
    expect(marks(x.out).Метки).toBe("✅");
  });

  /** Обычная метка с чужим смыслом уже стоит на задачах: стать меткой решения она может только по решению человека. */
  it("обычная метка с именем решения — ❌, меткой решения становится только с --confirm", () => {
    const f = fake();
    f.tree.capabilities = ["documentation"];
    const l = f.label("documentation", "0075ca", "Improvements or additions to documentation");
    expect(check(f).out).toContain("· метка «documentation» — не метка решения, а решение documentation есть в основной ветке");
    fix(f);
    expect(ops(f)).not.toContain("CreateLabel");
    expect(ops(f)).not.toContain("UpdateLabel");
    fix(f, { confirm: true });
    expect(byOp(f, "UpdateLabel")).toEqual([{ id: l.id, color: CAP, description: "Решение: tests/capabilities/documentation" }]);
  });

  /**
   * Метки `web`, `api`, `admin` команды режут задачи по приложениям, а модули модели названы так же: это другой разрез
   * задач, а не метки решений, и в метку решения превращать их владелец не хочет. Признак разреза — описание метки
   * (#343), как `Решение: …` у метки решения. Отвергнуто: список разрезов в `.agents/ai-dev.json` — манифест установки
   * `install` и `update` пишут заново, а `check` читает всё через API основной ветки.
   */
  it("метка-разрез (описание «Разрез: …») с именем решения — строка ○ с разрезом, пункт ✅; fix её не трогает", () => {
    const f = fake();
    Object.assign(f.tree, { model: `export default { modules: { web: { path: "apps/web" }, api: { path: "apps/api" }, domain: { path: "src/domain" } } };\n` });
    f.label("api", "C5DEF5", "Разрез: приложения — API-сервер");
    f.label("web", "C5DEF5", "Разрез: приложения");
    f.label("domain", ARCH, "Решение: tests/architecture — правило или модуль domain");
    const r = check(f);
    expect(r.code).toBe(0);
    expect(marks(r.out).Метки).toBe("✅");
    expect(r.out).toContain("○ разрез «приложения»: метки «api», «web» — не метки решений, одноимённые решения меткой не отмечаются");
    fix(f, { confirm: true });
    expect(f.mutations.filter((m) => /Label/.test(m.op))).toEqual([]);
  });
});

/**
 * Правило канона «мерж только при зелёных чеках» держит GitHub: ветку с красным обязательным чеком он не вливает.
 * Обязательны чеки, зелёные на каждом из последних влитых PR. Актуальной ветки правило не требует: strict в своём
 * ruleset выключен, а несовместимость двух зелёных PR покажет CI следующего PR.
 */
describe("Мерж в основную ветку — только с зелёными обязательными чеками", () => {
  const MERGE = "Мерж в main — только с зелёными обязательными чеками";
  const NO_RULE = "· нет правила с обязательными чеками: ветку с красным чеком можно влить";
  function bare(f: FakeGitHub = fake()): FakeGitHub {
    f.merge.rulesets = [];
    return f;
  }

  it("правила нет — ❌; fix ставит ruleset «ai-dev»: основная ветка, без strict, обязательные — зелёные на всех последних влитых PR, обход — admin", () => {
    const f = bare();
    const r = check(f);
    expect(r.code).toBe(1);
    expect(marks(r.out).Мерж).toBe("❌");
    expect(r.out).toContain(NO_RULE);
    const x = fix(f);
    expect(x.code).toBe(0);
    // spec-publish на PR пропускается — не зелёный, в обязательные не идёт
    expect(byOp(f, "CreateRuleset")).toEqual([
      {
        sourceId: f.repo.id,
        name: "ai-dev",
        target: "BRANCH",
        enforcement: "ACTIVE",
        conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: { requiredStatusChecks: [{ context: "tests" }], strictRequiredStatusChecksPolicy: false } } }],
        bypassActors: [{ repositoryRoleDatabaseId: 5, bypassMode: "ALWAYS" }],
      },
    ]);
    expect(x.out).toContain("+ создать ruleset «ai-dev» на main: обязательные «tests», обход — admin");
    expect(marks(x.out).Мерж).toBe("✅");
  });

  it("чужое правило без обязательных чеков — ❌; fix его не правит, а ставит свой ruleset", () => {
    const f = bare();
    f.merge.protection = { strict: true, contexts: [] };
    expect(check(f).out).toContain(NO_RULE);
    const g = bare();
    const release = g.ruleset({ name: "release", strict: true, contexts: [] });
    expect(check(g).out).toContain(NO_RULE);
    fix(g);
    expect(ops(g)).toEqual(["CreateRuleset"]);
    expect(release).toMatchObject({ enforcement: "ACTIVE", strict: true, contexts: [] });
    expect(marks(check(g).out).Мерж).toBe("✅");
  });

  it("чужое правило с обязательными чеками — ✅, со strict или без; свой ruleset не дублирует", () => {
    for (const strict of [true, false]) {
      const f = bare();
      f.ruleset({ name: "main-policy", org: true, strict, contexts: ["build"] });
      expect(marks(check(f).out).Мерж).toBe("✅");
      fix(f);
      expect(ops(f)).toEqual([]);
      // классическая защита ветки — такое же правило
      const g = bare();
      g.merge.protection = { strict, contexts: ["tests"] };
      expect(marks(check(g).out).Мерж).toBe("✅");
      fix(g);
      expect(ops(g)).toEqual([]);
    }
  });

  it("свой ruleset выключен, со strict или без обхода admin — ❌ по каждой причине; fix правит всё одной правкой", () => {
    const f = fake();
    Object.assign(f.merge.rulesets[0]!, { enforcement: "DISABLED", strict: true, admin: false });
    const r = check(f);
    expect(marks(r.out).Мерж).toBe("❌");
    expect(r.out).toContain("· ruleset «ai-dev» — DISABLED, не действует");
    expect(r.out).toContain("· ruleset «ai-dev»: strict включён — отставшую ветку GitHub не вольёт");
    expect(r.out).toContain("· ruleset «ai-dev»: admin не может обойти — прямой push в main невозможен");
    const x = fix(f);
    expect(ops(f)).toEqual(["UpdateRuleset"]);
    expect(x.out).toContain("+ ruleset «ai-dev»: основная ветка, обязательные «tests», обход — admin");
    expect(f.merge.rulesets[0]).toMatchObject({ enforcement: "ACTIVE", strict: false, admin: true, contexts: ["tests"] });
    expect(marks(check(f).out).Мерж).toBe("✅");
    // ruleset, поставленный прежним fix: действует, с обходом, но со strict — единственная причина
    const g = fake();
    g.merge.rulesets[0]!.strict = true;
    const only = check(g);
    expect(only.code).toBe(1);
    expect(only.out.split("\n").filter((l) => l.startsWith("   · "))).toEqual(["   · ruleset «ai-dev»: strict включён — отставшую ветку GitHub не вольёт"]);
    fix(g);
    expect(byOp(g, "UpdateRuleset").map((u) => u.rules[0].parameters.requiredStatusChecks.strictRequiredStatusChecksPolicy)).toEqual([false]);
    expect(check(g).code).toBe(0);
  });

  it("у влитых PR нет общего зелёного чека — ➖: обязательным делать нечего", () => {
    const f = bare();
    f.merge.merged = [
      { number: 1, checks: { build: "SUCCESS" } },
      { number: 2, checks: { test: "SUCCESS" } },
    ];
    const r = check(f);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`➖ ${MERGE} — у последних влитых PR нет общего зелёного чека — обязательным делать нечего`);
    expect(r.out).not.toContain("strict");
  });

  // job e2e убрали: на открытом PR с завершёнными чеками его нет, а ruleset его всё ещё требует
  it("обязательный чек не пришёл на открытый PR с завершёнными чеками — ❌, PR ждал бы его вечно; fix убирает его и добавляет новый стабильный", () => {
    const f = fake();
    f.merge.rulesets[0]!.contexts = ["e2e", "tests"];
    for (const pr of f.merge.merged) pr.checks = { tests: "SUCCESS", e2e: "SUCCESS", lint: "SUCCESS" };
    f.merge.open = [
      { number: 140, checks: { tests: "SUCCESS", lint: "FAILURE" } },
      // чеки ещё идут — отсутствие e2e и lint у такой головы ничего не значит
      { number: 141, checks: { tests: "IN_PROGRESS" } },
    ];
    const r = check(f);
    expect(marks(r.out).Мерж).toBe("❌");
    expect(r.out).toContain("· обязательный «e2e» не пришёл на PR #140 — PR ждал бы его вечно");
    expect(r.out).toContain("· не обязательны зелёные на последних 10 влитых PR: «lint»");
    fix(f);
    expect(byOp(f, "UpdateRuleset").map((u) => u.rules[0].parameters.requiredStatusChecks.requiredStatusChecks)).toEqual([[{ context: "lint" }, { context: "tests" }]]);
    expect(marks(check(f).out).Мерж).toBe("✅");
  });

  it("приватный репозиторий на Free — ➖ с причиной от GitHub, а не ❌; fix ничего не ставит", () => {
    const f = bare();
    Object.assign(f.merge, { private: true, upgrade: true });
    const r = check(f);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`➖ ${MERGE} — правила ветки недоступны: Upgrade to GitHub Pro or make this repository public to enable this feature.`);
    fix(f);
    expect(ops(f)).toEqual([]);
  });
});

/**
 * Мерж — только rebase (канон, «PR»): правило мержа одно для всех репозиториев — `gh pr merge <N> --rebase`, и
 * настройка репозитория держит его постоянным: другим способом PR не влить. Настройки мержа GraphQL не меняет — fix
 * шлёт один запрос REST.
 */
describe("Способ мержа — только rebase", () => {
  const STEP = "оставить только rebase: выключить merge commit и squash, включить rebase";

  it("разрешены merge commit или squash, выключен rebase — ❌ по каждой причине; fix оставляет только rebase одним запросом REST", () => {
    const f = fake();
    f.merge.methods = { merge: true, squash: true, rebase: false };
    const r = check(f);
    expect(r.code).toBe(1);
    expect(marks(r.out).Способ).toBe("❌");
    expect(r.out).toContain("· rebase выключен — gh pr merge --rebase GitHub отклонит");
    expect(r.out).toContain("· разрешён merge commit");
    expect(r.out).toContain("· разрешён squash");
    const x = fix(f);
    expect(x.code).toBe(0);
    expect(byOp(f, "UpdateRepository")).toEqual([{ allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true }]);
    expect(x.out).toContain(`+ ${STEP}`);
    expect(f.merge.methods).toEqual({ merge: false, squash: false, rebase: true });
    expect(marks(x.out).Способ).toBe("✅");
    // одна причина — тот же запрос
    const g = fake();
    g.merge.methods.squash = true;
    expect(check(g).out.split("\n").filter((l) => l.startsWith("   · "))).toEqual(["   · разрешён squash"]);
    fix(g);
    expect(ops(g)).toEqual(["UpdateRepository"]);
  });

  it("настройки мержа не меняются (нет прав admin) — fix пишет строку ! с ответом GitHub и ссылкой на настройки, пункт остаётся ❌", () => {
    const f = fake();
    f.merge.methods.merge = true;
    f.failing.UpdateRepository = "Must have admin rights to Repository.";
    const x = fix(f);
    expect(x.code).toBe(1);
    expect(x.out).toContain(`! ${STEP}: PATCH repos/${REPO}: Must have admin rights to Repository. — в UI: https://github.com/${REPO}/settings`);
    expect(marks(x.out).Способ).toBe("❌");
    expect(f.merge.methods.merge).toBe(true);
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
