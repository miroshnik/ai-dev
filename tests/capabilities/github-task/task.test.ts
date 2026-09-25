/**
 * Скилл `github`, `task new`, `task status` и `task drop`: задача по канону `AGENTS.md` одной командой — тип или
 * метка, проект и `Бэклог`, `Priority`, эпик, blocked by, milestone; статус с эпиком; закрытие без выполнения.
 *
 * Всё проверяется до создания: задача не появляется наполовину. Ответы GitHub — записанные с проекта ai-dev
 * (`tests/lib/github-ai-dev.json`), `gh` подменён: мутации меняют запись так, как это сделал бы GitHub.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

import { main } from "../../../skills/github/scripts/github.ts";
import { asOrg, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";

const REC: Recording = JSON.parse(readFileSync(new URL("../../lib/github-ai-dev.json", import.meta.url), "utf8"));
const REPO = "miroshnik/ai-dev";
const ORG = "acme/ai-dev";

function task(f: FakeGitHub, args: string[], repo = REPO) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["task", ...args, "--repo", repo], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const byOp = (f: FakeGitHub, op: string) => f.mutations.filter((m) => m.op === op).map((m) => m.input);
const optionId = (f: FakeGitHub, name: string) => f.field("Status").options.find((o: { name: string }) => o.name === name).id;
const statusSet = (f: FakeGitHub) => byOp(f, "SetItemStatus").map((m) => [f.items().find((it) => it.id === m.itemId)?.content.number, f.field("Status").options.find((o: { id: string }) => o.id === m.value.singleSelectOptionId).name]);

describe("task new — задача одной командой", () => {
  it("подзадача эпика: заголовок с префиксом эпика, в проекте в Бэклог, sub-issue, blocked by, следующий шаг — оценка", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт задач", "--body", "Что сделать", "--epic", "45", "--blocked-by", "#49"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateIssue")).toEqual([{ repositoryId: f.repo.id, title: "GitHub · Экспорт задач", body: "Что сделать", projectV2Ids: [f.project().id], parentIssueId: f.issue(45).id }]);
    expect(statusSet(f)).toEqual([[50, "Бэклог"]]);
    expect(byOp(f, "AddBlockedBy")).toEqual([{ issueId: f.issue(50).id, blockingIssueId: f.issue(49).id }]);
    expect(r.out.split("\n")).toEqual([
      "Создана #50 GitHub · Экспорт задач — https://github.com/miroshnik/ai-dev/issues/50",
      "+ проект «ai-dev»: Status «Бэклог»",
      "+ подзадача эпика #45",
      "+ blocked by #49",
      "Дальше: оценка — скилл est (est estimate 50 --type <тип ветки> --analogs …); «Оценка, ч» эпика #45 — пересчитать суммой подзадач.",
    ]);
  });

  it("заголовок уже с префиксом эпика — префикс не удваивается", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--title", "GitHub · Экспорт задач", "--epic", "45"]);
    expect(byOp(f, "CreateIssue")[0].title).toBe("GitHub · Экспорт задач");
  });

  it("закрытый блокер пропускается — он уже не блокирует", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--blocked-by", "46,49"]);
    expect(byOp(f, "AddBlockedBy").map((m) => m.blockingIssueId)).toEqual([f.issue(49).id]);
    expect(r.out).toContain("+ #46 закрыта — не блокирует, пропущена");
  });

  it("тело задачи — из файла --body-file", () => {
    const f = new FakeGitHub(REC);
    const file = new URL("../../lib/github-ai-dev.json", import.meta.url).pathname;
    task(f, ["new", "--title", "Экспорт", "--body-file", file]);
    expect(byOp(f, "CreateIssue")[0].body).toBe(readFileSync(file, "utf8"));
  });

  // в личном аккаунте типов issue нет — эпик помечается меткой epic, это единственное исключение
  it("эпик в личном аккаунте — метка epic вместо типа; эпик не оценивается", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"]);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([f.taskContext.label.id]);
    expect(byOp(f, "CreateIssue")[0]).not.toHaveProperty("issueTypeId");
    expect(r.out).toContain("+ метка «epic» — тип в личном аккаунте");
    expect(r.out).toContain("Дальше: эпик не оценивается — его «Оценка, ч» = сумма оценок подзадач.");
  });

  it("метки epic в репозитории нет — создаёт её и ставит", () => {
    const f = new FakeGitHub(REC);
    f.taskContext.label = null;
    task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"]);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "epic", color: "8250DF", description: "Эпик: большая задача с подзадачами" }]);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([f.taskContext.label.id]);
  });

  it("задача и баг в личном аккаунте — без типа и без меток", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--title", "Экспорт", "--type", "Баг"]);
    expect(byOp(f, "CreateIssue").map((m) => Object.keys(m).sort())).toEqual([["body", "projectV2Ids", "repositoryId", "title"]]);
  });

  it("milestone — по названию среди открытых", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("GitHub · 1 · Проект");
    const r = task(f, ["new", "--title", "Экспорт", "--milestone", "GitHub · 1 · Проект"]);
    expect(byOp(f, "CreateIssue")[0].milestoneId).toBe(m.id);
    expect(r.out).toContain("+ milestone «GitHub · 1 · Проект»");
  });

  describe("ошибка до создания — задача не заводится наполовину", () => {
    const refused = (f: FakeGitHub, args: string[], message: string, repo = REPO) => {
      const r = task(f, ["new", ...args], repo);
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
      expect(f.mutations).toEqual([]);
    };

    it("--epic указывает не на эпик", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--epic", "47"], "#47 — не эпик (нет метки epic)"));
    it("эпик закрыт", () => {
      const f = new FakeGitHub(REC);
      f.closed(45);
      refused(f, ["--title", "Экспорт", "--epic", "45"], "эпик #45 закрыт");
    });
    it("открытого milestone с таким названием нет", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--milestone", "Нет такого"], "открытого milestone «Нет такого» нет"));
    it("открытая задача с тем же заголовком уже есть — дубль не заводится", () => {
      const f = new FakeGitHub(REC);
      refused(f, ["--title", f.issue(49).title], "открытая задача с таким заголовком уже есть: #49");
    });
    it("в личном аккаунте --priority — приоритет там не ведём", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--priority", "High"], "в личном аккаунте полей issue нет"));
    it("блокера нет в репозитории", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--blocked-by", "999"], "задачи #999 в miroshnik/ai-dev нет"));
    it("проекта нет — сначала project fix", () => {
      const f = new FakeGitHub(REC);
      f.unlinkAll();
      refused(f, ["--title", "Экспорт"], "не привязан проект — сначала github project fix");
    });
  });
});

describe("task new в организации: тип issue и Priority", () => {
  const org = () => new FakeGitHub(asOrg(REC));

  it("тип issue организации и Priority Medium по умолчанию — в той же мутации, что и задача", () => {
    const f = org();
    const r = task(f, ["new", "--title", "Экспорт"], ORG);
    expect(byOp(f, "CreateIssue")[0]).toMatchObject({ issueTypeId: "IT_1", issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_medium" }] });
    expect(r.out).toContain("+ тип «Задача»");
    expect(r.out).toContain("+ Priority «Medium»");
  });

  it("подзадача срочнее эпика — Priority эпика поднимается до неё; не срочнее — эпик не трогается", () => {
    const f = org();
    f.setPriority(45, "Low");
    const r = task(f, ["new", "--title", "Экспорт", "--epic", "45", "--priority", "High"], ORG);
    expect(byOp(f, "SetIssueField")).toEqual([{ issueId: f.issue(45).id, issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_high" }] }]);
    expect(r.out).toContain("+ Priority эпика #45: Low → High");
    task(f, ["new", "--title", "Импорт", "--epic", "45", "--priority", "Medium"], ORG);
    expect(byOp(f, "SetIssueField")).toHaveLength(1);
  });

  it("выключенный тип или чужое значение Priority — ошибка до создания", () => {
    const f = org();
    f.repo.owner.issueTypes.nodes.find((t: { name: string }) => t.name === "Баг").isEnabled = false;
    expect(task(f, ["new", "--title", "Экспорт", "--type", "Баг"], ORG).err).toContain("в организации нет включённого типа «Баг» — github project fix");
    expect(task(f, ["new", "--title", "Экспорт", "--priority", "P1"], ORG).err).toContain("--priority: Urgent, High, Medium, Low");
    expect(f.mutations).toEqual([]);
  });
});

describe("task status — Status в проекте", () => {
  it("подзадача «В работе» — эпик из Бэклог тоже «В работе»: взята первая подзадача", () => {
    const f = new FakeGitHub(REC);
    f.status(45, "Бэклог");
    const r = task(f, ["status", "47", "В работе"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[47, "В работе"], [45, "В работе"]]);
    expect(r.out).toContain("+ эпик #45: Status «В работе» — взята первая подзадача");
  });

  it("эпик уже в работе — не трогается", () => {
    const f = new FakeGitHub(REC);
    f.status(45, "В работе");
    task(f, ["status", "47", "В работе"]);
    expect(statusSet(f)).toEqual([[47, "В работе"]]);
  });

  it("задача вне проекта — добавляется и получает статус", () => {
    const f = new FakeGitHub(REC);
    f.items().splice(f.items().indexOf(f.item(49)), 1);
    const r = task(f, ["status", "#49", "Бэклог"]);
    expect(byOp(f, "AddItem")).toEqual([{ projectId: f.project().id, contentId: f.issue(49).id }]);
    expect(r.out).toContain("+ #49: Status «Бэклог» (добавлена в проект)");
  });

  it("последняя подзадача закрыта и в Готово — подсказка закрыть эпик", () => {
    const f = new FakeGitHub(REC);
    f.closed(47);
    const r = task(f, ["status", "47", "Готово"]);
    expect(r.out).toContain("Дальше: все подзадачи эпика #45 закрыты — закрыть эпик и поставить ему «Готово».");
  });

  it("статус не из канона — ошибка, ничего не меняется", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "47", "Done"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("статус: Бэклог, В работе, Готово");
    expect(f.mutations).toEqual([]);
  });
});

describe("task drop — закрыть без выполнения", () => {
  // закрытую без выполнения «Item closed» запишет в «Готово» — поэтому её убирают из проекта
  it("закрывает как not planned и убирает из проекта", () => {
    const f = new FakeGitHub(REC);
    const itemId = f.item(49).id;
    const r = task(f, ["drop", "49"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "NOT_PLANNED" }]);
    expect(byOp(f, "DeleteItem")).toEqual([{ projectId: f.project().id, itemId }]);
    expect(f.item(49)).toBeUndefined();
  });

  it("--duplicate-of — закрывает как дубль со ссылкой на оригинал", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["drop", "49", "--duplicate-of", "42"]);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "DUPLICATE", duplicateIssueId: f.issue(42).id }]);
    expect(r.out).toContain("+ #49 закрыта: дубль #42");
  });

  it("подзадача эпика — подсказка пересчитать оценку эпика", () => {
    const f = new FakeGitHub(REC);
    expect(task(f, ["drop", "47"]).out).toContain("Дальше: «Оценка, ч» эпика #45 — пересчитать суммой оставшихся подзадач.");
  });

  it("уже закрыта без выполнения, но в проекте — только убирает из проекта", () => {
    const f = new FakeGitHub(REC);
    f.closed(49, "NOT_PLANNED");
    task(f, ["drop", "49"]);
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(byOp(f, "DeleteItem")).toHaveLength(1);
  });

  it("выполненную задачу не трогает — ошибка", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["drop", "46"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("#46 закрыта как выполненная — drop только для невыполненных");
    expect(f.mutations).toEqual([]);
  });
});
