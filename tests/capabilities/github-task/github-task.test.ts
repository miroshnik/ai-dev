import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { main, realRun } from "../../../skills/github/scripts/github.ts";
import type { Io } from "../../../skills/github/scripts/github.ts";
import { asOrg, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, tmpDir } from "../../lib/spec.ts";

// модель архитектуры скилл читает отдельным процессом bun
setDefaultTimeout(SPAWN_TIMEOUT);

// Ответы GitHub — записанные с проекта ai-dev, `gh` подменён: мутации меняют запись так, как это сделал бы GitHub
const REC: Recording = JSON.parse(readFileSync(new URL("../../lib/github-ai-dev.json", import.meta.url), "utf8"));
const REPO = "miroshnik/ai-dev";
const ORG = "acme/ai-dev";

let pauses = 0;
function task(f: FakeGitHub, args: string[], repo = REPO, io: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["task", ...args, "--repo", repo], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, sleep: () => void pauses++, ...io });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const byOp = (f: FakeGitHub, op: string) => f.mutations.filter((m) => m.op === op).map((m) => m.input);
const optionId = (f: FakeGitHub, name: string) => f.field("Status").options.find((o: { name: string }) => o.name === name).id;
const statusSet = (f: FakeGitHub) => byOp(f, "SetItemStatus").map((m) => [f.items().find((it) => it.id === m.itemId)?.content.number, f.field("Status").options.find((o: { id: string }) => o.id === m.value.singleSelectOptionId).name]);

// Сессия агента: её id и каталог конфигурации скрипт берёт из окружения; каталог в тестах — временный
const SESSION = "0b1f6c1e-7a52-4f0e-9d3a-2c4e8a9b5d10";
const temp: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of temp.splice(0)) cleanup();
});
function scratch(): string {
  const { dir, cleanup } = tmpDir();
  temp.push(cleanup);
  return dir;
}
const inSession = (config: string, id = SESSION): Partial<Io> => ({ env: { CLAUDE_CODE_SESSION_ID: id, AI_DEV_CONFIG_DIR: config } });
const pinFile = (config: string, id = SESSION) => path.join(config, "sessions", id);
const pinned = (config: string, id = SESSION) => readFileSync(pinFile(config, id), "utf8").trim();

describe("task new заводит задачу со всем сразу", () => {
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
      "Дальше: оценка — одним вызовом скилла est: est estimate 50 --type <тип ветки> --write (аналоги подбирает скрипт); «Оценка, ч» эпика #45 — пересчитать суммой подзадач.",
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

  // заведённую задачу сессия с закреплённой задачей сама не возьмёт (`task status` откажет) — вывод сразу называет, куда её нести
  it("в сессии с закреплённой задачей «Дальше:» называет новую сессию и первый промпт #M", () => {
    const f = new FakeGitHub(REC);
    const io = inSession(scratch());
    expect(task(f, ["new", "--title", "Импорт"], REPO, io).out).not.toContain("сессия ведёт");
    task(f, ["status", "49", "В работе"], REPO, io);
    const r = task(f, ["new", "--title", "Экспорт"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").slice(-2)).toEqual([
      "Дальше: оценка — одним вызовом скилла est: est estimate 51 --type <тип ветки> --write (аналоги подбирает скрипт).",
      "Дальше: сессия ведёт miroshnik/ai-dev#49 — #51 в новой сессии, первый промпт: #51.",
    ]);
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

const issueLabels = (f: FakeGitHub, n: number) => f.issue(n).labels.nodes.map((l: { name: string }) => l.name);

const CAP = "0E8A16";

/** Метка решения ставится при создании: по ней задачу находят из спеки, а `est` — аналоги по тому же решению. */
describe("task new ставит метки решений — по имени решения, новое решение — `вид:имя`", () => {
  it("--labels ставит метки решений по имени; метки нет — создаётся с цветом вида", () => {
    const f = new FakeGitHub(REC);
    Object.assign(f.tree, { capabilities: ["billing"], standards: ["audit"] });
    const audit = f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    const r = task(f, ["new", "--title", "Экспорт", "--labels", "billing,audit"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" }]);
    const billing = f.labels.find((l) => l.name === "billing")!;
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([billing.id, audit.id]);
    expect(issueLabels(f, 50)).toEqual(["billing", "audit"]);
    expect(r.out).toContain("+ создана метка «billing»");
    expect(r.out).toContain("+ метки: billing, audit");
  });

  it("новое решение — `вид:имя`: метка с именем, строка называет решение новым", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--labels", "capability:export"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "export", color: CAP, description: "Решение: tests/capabilities/export" }]);
    expect(issueLabels(f, 50)).toEqual(["export"]);
    expect(r.out).toContain("+ export — новое решение: tests/capabilities/export в основной ветке ещё нет");
  });

  it("метка не решения, которой нет в репозитории, — ошибка до создания задачи", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--labels", "capability:export,срочно"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("метки «срочно» в репозитории нет");
    expect(r.err).toContain("новое решение — вид:имя");
    expect(byOp(f, "CreateIssue")).toEqual([]);
    expect(byOp(f, "CreateLabel")).toEqual([]);
  });

  it("task new --epic — метки решений задачи добавляются эпику", () => {
    const f = new FakeGitHub(REC);
    f.tree.capabilities = ["billing"];
    f.label("срочно", "B60205");
    const r = task(f, ["new", "--title", "Экспорт", "--epic", "45", "--labels", "billing,срочно"]);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 45)).toEqual(["epic", "billing"]);
    expect(r.out).toContain("+ эпик #45: billing");
  });
});

const HEAD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
// модель в голове PR: модуль web — весь src, domain — его подкаталог и ещё один каталог
const MODEL = `export default { modules: {
  web: { path: "src", purpose: "приложение" },
  domain: { path: ["src/domain", "lib/domain"], purpose: "правила" },
} };
`;
function prLabels(f: FakeGitHub, number: number) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["pr", "labels", String(number), "--repo", REPO], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/**
 * Метки решений задачи ставит её PR: какие папки спеки и модули модели он меняет, те решения задача и трогала.
 * Эпик копит метки подзадач — по нему видно, каких решений касается вся большая задача.
 */
describe("pr labels ставит задаче метки решений по диффу PR, эпику — объединение", () => {
  it("задача из «Closes #N» получает метки решений по папкам спеки в диффе PR", () => {
    const f = new FakeGitHub(REC);
    f.label("billing", CAP, "Решение: tests/capabilities/billing");
    f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    const files = ["tests/capabilities/billing/billing.test.ts", "tests/capabilities/billing/billing.md", "tests/standards/audit/eslint.ts", "tests/lib/fake.ts", "README.md"];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["audit", "billing"]);
    expect(r.out).toContain("+ #49: audit, billing");
  });

  it("изменённый код — метка модуля модели из головы PR, путь модуля — самый длинный подходящий", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["src/domain/invoice.ts", "src/web/page.tsx", "lib/domain/money.ts", "docs/readme.md"], closes: [49], head: HEAD, model: MODEL };
    expect(prLabels(f, 120).code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["domain", "web"]);
  });

  it("метки решения нет в репозитории — создаётся с цветом вида", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" }]);
    expect(r.out).toContain("+ создана метка «billing»");
  });

  it("прежняя метка решения, которого нет в диффе, — не снимается, строка в выводе", () => {
    const f = new FakeGitHub(REC);
    f.label("old", CAP, "Решение: tests/capabilities/old");
    f.label("срочно", "B60205");
    f.labelIssue(49, "old");
    f.labelIssue(49, "срочно");
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 49)).toEqual(["old", "срочно", "billing"]);
    expect(r.out).toContain("= #49: old — решения нет в диффе PR, метка не снята");
    expect(r.out).not.toContain("= #49: срочно");
  });

  // механическая правка решение не меняет: её метка — шум, который в проекте с массовыми правками чистят руками (#192)
  it("переименование файла в папке решения не даёт метку этого решения", () => {
    const f = new FakeGitHub(REC);
    const files = [
      { path: "tests/capabilities/billing/invoice.test.ts", changeType: "RENAMED", additions: 0, deletions: 0 },
      { path: "tests/capabilities/export/export.test.ts", changeType: "RENAMED", additions: 3, deletions: 1 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["export"]);
    expect(r.out).toContain("PR #120 → #49: export");
    expect(r.out).toContain("○ billing — только механическая правка");
  });

  it("правка только `exceptions.ts` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    f.prs[120] = { files: [{ path: "tests/standards/audit/exceptions.ts", changeType: "MODIFIED", additions: 0, deletions: 4 }], closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("PR #120 → #49: решений в диффе нет");
    expect(r.out).toContain("○ audit — только механическая правка");
  });

  it("правка только файлов `exceptions/` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    const files = [
      { path: "tests/standards/audit/exceptions/importLegacy.json", changeType: "DELETED", additions: 0, deletions: 5 },
      { path: "tests/standards/audit/exceptions/createInvoice.json", changeType: "ADDED", additions: 5, deletions: 0 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("○ audit — только механическая правка");
  });

  // baseline исключений названий кладёт файл в папку каждого решения с долгом — метки всем им были бы шумом
  it("`pr labels`: правка только файлов `names.exceptions/` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("billing", CAP, "Решение: tests/capabilities/billing");
    const files = [{ path: "tests/capabilities/billing/names.exceptions/returns-201.json", changeType: "ADDED", additions: 6, deletions: 0 }];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("○ billing — только механическая правка");
  });

  it("удалённые файлы не дают метку ни решению, ни модулю модели", () => {
    const f = new FakeGitHub(REC);
    const files = [
      { path: "tests/capabilities/legacy/legacy.test.ts", changeType: "DELETED", additions: 0, deletions: 40 },
      { path: "src/domain/old.ts", changeType: "DELETED", additions: 0, deletions: 12 },
      { path: "src/web/page.tsx", changeType: "MODIFIED", additions: 2, deletions: 2 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: MODEL };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 49)).toEqual(["web"]);
    expect(r.out).toContain("○ domain — только механическая правка");
    expect(r.out).toContain("○ legacy — только механическая правка");
  });

  // сторож от перекоррекции: механический файл не отменяет содержательную правку решения
  it("механическая правка рядом с содержательной в той же папке — метка решения ставится", () => {
    const f = new FakeGitHub(REC);
    const files = [
      { path: "tests/capabilities/billing/billing.test.ts", changeType: "MODIFIED", additions: 5, deletions: 0 },
      { path: "tests/capabilities/billing/exceptions.ts", changeType: "MODIFIED", additions: 1, deletions: 0 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 49)).toEqual(["billing"]);
    expect(r.out).not.toContain("○ billing");
  });

  it("эпик задачи получает метки подзадачи — объединение", () => {
    const f = new FakeGitHub(REC);
    f.label("est", CAP, "Решение: tests/capabilities/est");
    f.labelIssue(45, "est");
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts", "tests/capabilities/est/est.test.ts"], closes: [47], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 47)).toEqual(["billing", "est"]);
    expect(issueLabels(f, 45)).toEqual(["epic", "est", "billing"]);
    expect(r.out).toContain("+ эпик #45: billing");
  });

  // GitHub связывает PR с задачей не сразу после создания: pr labels зовут как раз тогда (#164)
  it("связь PR с задачей ещё не появилась — задачи берутся из «Closes #N» в теле PR", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [], body: "Экспорт счетов.\n\nCloses #49, fixes #47, #45", head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["billing"]);
    expect(issueLabels(f, 47)).toEqual(["billing"]);
    // «, #45» без ключевого слова GitHub не закрывает: задачи PR — только #49 и #47 (#45 — их эпик)
    expect(r.out).toContain("PR #120 → #49, #47: billing");
  });

  it("PR без «Closes #N» — ошибка, ничего не меняется", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(2);
    expect(r.err).toContain("в PR #120 нет «Closes #N»");
    expect(f.mutations).toEqual([]);
  });
});

describe("В организации задача получает тип issue и Priority, эпик — не ниже подзадачи", () => {
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

describe("task status двигает задачу по доске, эпик — следом", () => {
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

/**
 * Сессия ведёт одну задачу: по сессии `est` считает факт, а вторая задача в той же сессии отдаёт своё время первой.
 * Правило прозой не держалось, поэтому первая задача «В работе» закрепляется за сессией файлом
 * `<каталог конфигурации>/sessions/<CLAUDE_CODE_SESSION_ID>`, другой задаче скрипт отказывает до изменений. Закрепление
 * не снимает ни одна команда: ошибочное убирает человек, удалив файл.
 */
describe("task status берёт в работу одну задачу на сессию", () => {
  it("первая задача «В работе» закрепляется за сессией — файл sessions/<id сессии> в каталоге конфигурации называет owner/repo#N", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const r = task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(pinned(config)).toBe("miroshnik/ai-dev#49");
  });

  it("другая задача «В работе» в той же сессии — отказ (код 2) до изменений: закреплённая задача, первый промпт новой сессии и файл закрепления — одной строкой", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    const r = task(f, ["status", "42", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(2);
    expect(r.err).toBe(`ошибка: сессия ведёт miroshnik/ai-dev#49; #42 — в новой сессии, первый промпт: #42 (закрепление: ${pinFile(config)} — ошибочное снимает человек)`);
    expect(r.out).toBe("");
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(f.mutations).toHaveLength(1);
    expect(pinned(config)).toBe("miroshnik/ai-dev#49");
  });

  it("та же задача «В работе» повторно — без отказа", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    const r = task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"], [49, "В работе"]]);
  });

  it("задача с тем же номером в другом репозитории — другая задача: отказ", () => {
    const config = scratch();
    task(new FakeGitHub(REC), ["status", "49", "В работе"], REPO, inSession(config));
    const other = new FakeGitHub(asOrg(REC));
    const r = task(other, ["status", "49", "В работе"], ORG, inSession(config));
    expect(r.code).toBe(2);
    expect(r.err).toContain("сессия ведёт miroshnik/ai-dev#49; #49 — в новой сессии, первый промпт: #49");
    expect(other.mutations).toEqual([]);
  });

  // сессия эпика планирует и раздаёт подзадачи, а статус эпику ставит и сама команда — с первой подзадачей
  it("эпик не закрепляется — после него сессия берёт подзадачу", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    expect(task(f, ["status", "45", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(existsSync(pinFile(config))).toBe(false);
    expect(task(f, ["status", "47", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(pinned(config)).toBe("miroshnik/ai-dev#47");
  });

  it("«Бэклог» и «Готово» другой задаче — без отказа: закрепляет только «В работе»", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(task(f, ["status", "42", "Бэклог"], REPO, inSession(config)).code).toBe(0);
    expect(task(f, ["status", "42", "Готово"], REPO, inSession(config)).code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"], [42, "Бэклог"], [42, "Готово"]]);
    expect(pinned(config)).toBe("miroshnik/ai-dev#49");
  });

  it("закрепление не снимают ни «Готово», ни task close — другая задача после них всё равно отказ", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const io = inSession(config);
    task(f, ["status", "49", "В работе"], REPO, io);
    expect(task(f, ["status", "49", "Готово"], REPO, io).code).toBe(0);
    expect(task(f, ["status", "42", "В работе"], REPO, io).code).toBe(2);
    f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
    expect(task(f, ["close", "49", "--no-git"], REPO, { ...io, run: () => ({ status: 0, stdout: "Факт: …\n", stderr: "" }) }).code).toBe(0);
    expect(task(f, ["status", "42", "В работе"], REPO, io).code).toBe(2);
    expect(pinned(config)).toBe("miroshnik/ai-dev#49");
  });

  // ключ — id сессии, а не чекаут и не машина: параллельные сессии делят каталог конфигурации
  it("другая сессия с тем же каталогом конфигурации берёт другую задачу без отказа", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const neighbour = "7d9e2a44-1c3b-4e6f-8a70-5b2c9d1e3f08";
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(task(f, ["status", "42", "В работе"], REPO, inSession(config, neighbour)).code).toBe(0);
    expect(pinned(config)).toBe("miroshnik/ai-dev#49");
    expect(pinned(config, neighbour)).toBe("miroshnik/ai-dev#42");
  });

  // id сессии даёт Bash-инструмент Claude Code; у другого агента его нет — статус важнее гарда
  it("CLAUDE_CODE_SESSION_ID нет — статус ставится, строка «сессия не опознана», файла нет", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const io = { env: { AI_DEV_CONFIG_DIR: config } };
    const r = task(f, ["status", "49", "В работе"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ сессия не опознана (нет CLAUDE_CODE_SESSION_ID) — задача не закреплена");
    expect(task(f, ["status", "42", "В работе"], REPO, io).code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"], [42, "В работе"]]);
    expect(existsSync(path.join(config, "sessions"))).toBe(false);
  });

  /**
   * `est` переносит старый `~/.claude/est` в каталог конфигурации, только пока того нет: создай его гард первым — `est`
   * молча останется без реестра и цен. Пока переноса не было, каталог конфигурации и есть старый — закрепление ложится
   * в него и переедет вместе с ним.
   */
  it("каталога конфигурации ещё нет, а старый ~/.claude/est на месте — закрепление ложится в него: перенос est не сорван", () => {
    const f = new FakeGitHub(REC);
    const home = scratch();
    const legacy = path.join(home, ".claude", "est");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "repos.json"), "{}\n");
    const io = { env: { CLAUDE_CODE_SESSION_ID: SESSION, HOME: home } };
    expect(task(f, ["status", "49", "В работе"], REPO, io).code).toBe(0);
    expect(existsSync(path.join(home, ".config", "ai-dev"))).toBe(false);
    expect(pinned(legacy)).toBe("miroshnik/ai-dev#49");
    const r = task(f, ["status", "42", "В работе"], REPO, io);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`закрепление: ${pinFile(legacy)}`);
  });

  // каталог конфигурации бывает симлинком на личный чекаут (AI_DEV_PRIVATE при install -g)
  it("каталог конфигурации — чекаут git: закрепления в него не коммитятся — sessions/ закрыт своим .gitignore", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const repo = gitRepo(config);
    repo.commit({ "repos.json": "{}\n" }, "init");
    expect(task(f, ["status", "49", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(existsSync(pinFile(config))).toBe(true);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

describe("task drop закрывает без выполнения и убирает из проекта", () => {
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

/**
 * GitHub добавляет задачу в проект не мгновенно для чтения: ответ createIssue и чтение задачи могут ещё не показывать
 * элемент, а повторное добавление отвечает «Content already exists». Статус всё равно ставится — по элементу, который
 * станет виден после короткой паузы.
 */
describe("Статус ставится, даже если проект ещё не показал задачу", () => {
  it("createIssue ещё не показывает элемент, добавление — «уже есть»: task new всё равно ставит Бэклог", () => {
    const f = new FakeGitHub(REC);
    f.createIssueHidesItems = true;
    const r = task(f, ["new", "--title", "Экспорт"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[50, "Бэклог"]]);
    expect(r.out).toContain("+ проект «ai-dev»: Status «Бэклог»");
  });

  it("задачу проект уже добавил, а чтение её ещё не показывает: task status перечитывает с паузой и ставит статус", () => {
    const f = new FakeGitHub(REC);
    f.issueRefLag[49] = 2; // не видно при первом чтении и при первом перечитывании после «уже есть»
    pauses = 0;
    const r = task(f, ["status", "49", "В работе"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(pauses).toBe(2);
    expect(r.out).toContain("+ #49: Status «В работе»");
    expect(r.out).not.toContain("добавлена в проект");
  });

  it("элемент так и не виден — понятная ошибка с тем, что повторить, а не падение", () => {
    const f = new FakeGitHub(REC);
    f.issueRefLag[49] = 100;
    const r = task(f, ["status", "49", "В работе"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 уже в проекте, но элемент не виден — повторить: github task status 49");
  });
});

/**
 * После мержа PR сессия делала ещё ≈21 ход на пиковом контексте — факт, статус, milestone, уборка ветки. `task close`
 * сворачивает это в один вызов; актуализацию блока делает субагент со свежим контекстом.
 */
describe("task close закрывает задачу одной командой", () => {
  const FACT = "Факт: 0.25 ч активных в Claude Code (оценка 0.25 ч, ×1.00). 1 сессия, 2 промпта, стена 0.3 ч, покрытие full. PR #77; 1 коммит, дифф 12 строк.";
  // est — подпроцесс (внешний край): в тестах подменяется, его вывод печатается как есть
  const est =
    (calls: string[][], r: { status: number; stdout?: string; stderr?: string } = { status: 0, stdout: FACT + "\nкомментарий «Факт» создан\n" }) =>
    (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  const mergedPr = (f: FakeGitHub, closes: number, head = `fix/${closes}-x`) => (f.prs[77] = { files: [], closes: [closes], head, base: "main", model: null, merged: true });

  it("PR задачи влит: задача закрыта, факт записан est, Status «Готово» — в выводе всё сделанное и следующий шаг", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "COMPLETED" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(-5)).toEqual(["fact", "49", "--repo", REPO, "--write"]);
    expect(calls[0]![1]).toMatch(/skills\/est\/scripts\/est\.ts$/);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
    expect(r.out).toContain("+ #49 закрыта: PR #77 влит");
    expect(r.out).toContain(FACT);
    expect(r.out).toContain("+ #49: Status «Готово»");
    expect(r.out).toContain("Дальше: актуализация блока — субагентом со свежим контекстом (задача #49)");
  });

  /**
   * Параллельных сессий много, и по хвосту каждой надо видеть, закончила она или чего-то ждёт. Подсказка приходит с
   * выводом `task close`: сессия на пиковом контексте, и канон от неё дальше всего. Исходов три: работа сделана, а
   * владельцу есть что решать — «Сессию можно закрывать» читалось бы как «решать нечего», и вопросы терялись.
   */
  it("последняя строка вывода называет три исхода конца сессии: всё сделано, всё сделано, но есть вопросы, осталось", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain("Дальше: актуализация блока — субагентом со свежим контекстом (задача #47, эпик #45)");
    expect(last).toContain(
      "после неё — последней строкой ответа одна из трёх: «Всё сделано. Сессию можно закрывать.»; " +
        "владельцу есть что решать — «Всё сделано, но есть вопросы: …» с самими вопросами, без «Сессию можно закрывать»; " +
        "что-то осталось — «Осталось: …».",
    );
  });

  /**
   * В режиме auto сессия ведёт задачу целиком без спроса, и закрыть её — последний шаг, оставшийся человеку: после
   * строки «Всё сделано. Сессию можно закрывать.» сессия архивирует себя сама. Архивная сессия уходит из списка, и
   * вопросы в её последнем ответе владелец уже не прочтёт — после двух других строк архивации нет. Манифест команда
   * не читает — называет условие словами.
   */
  it("последняя строка вывода называет архивацию сессии в режиме auto — только после «Всё сделано. Сессию можно закрывать.»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain("В режиме auto после «Всё сделано. Сессию можно закрывать.» — архивация сессии, где у агента есть инструмент; после двух других строк — нет.");
  });

  /**
   * «Есть вопросы» без вопроса — шум: наблюдение, срок, предупреждение владелец читает в отчёте, решать ему нечего.
   * Такая сессия заканчивает как обычно и в режиме auto архивирует себя.
   */
  it("последняя строка вывода не считает вопросом информацию без решения: строка и архивация — как у «всё сделано»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain("Информация без решения (наблюдение, срок, предупреждение) — не вопрос: строка и архивация — как у «Всё сделано. Сессию можно закрывать.»");
  });

  it("PR открыт или закрыт без мержа — ошибка до изменений, ничего не тронуто", () => {
    const f = new FakeGitHub(REC);
    f.prs[78] = { files: [], closes: [49], head: "fix/49-x", model: null, merged: false, state: "OPEN" };
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("PR #78 открыт");
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  // PR задачи, с которым GitHub её не связал: closedByPullRequestsReferences пуст, задача открыта
  const unlinkedPr = (f: FakeGitHub, pr: Partial<FakeGitHub["prs"][number]> = {}) => (f.prs[77] = { files: [], closes: [], head: "fix/49-x", base: "main", model: null, merged: true, ...pr });

  /**
   * GitHub бывает часами не связывает влитый PR с задачей по «Closes #N»: задача сама не закрывается, связи нет. PR
   * задачи тогда — среди последних PR основной ветки: по ветке `<type>/<N>-<slug>` или «Closes #N» в теле.
   */
  it("связи PR с задачей нет, влитый PR задачи найден по ветке — задача закрыта с комментарием о PR", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment")).toEqual([{ subjectId: f.issue(49).id, body: "Закрыта по PR #77: GitHub не связал PR с задачей" }]);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "COMPLETED" }]);
    expect(calls).toHaveLength(1);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
    expect(r.out).toContain("+ #49 закрыта по PR #77 (ветка fix/49-x): GitHub не связал PR с задачей");
  });

  it("связи нет, влитый PR с «Closes #N» в теле — задача закрыта по нему", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f, { head: "export-invoices", body: "Экспорт счетов.\n\nCloses #49" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment").map((c) => c.body)).toEqual(["Закрыта по PR #77: GitHub не связал PR с задачей"]);
    expect(r.out).toContain("+ #49 закрыта по PR #77 («Closes #49» в теле): GitHub не связал PR с задачей");
  });

  it("связи нет и влитого PR задачи нет — отказ с перечнем проверенного", () => {
    const f = new FakeGitHub(REC);
    // чужие PR: ветка задачи с тем же хвостом номера, её «Closes», упоминание без ключевого слова, мерж не в основную ветку
    f.prs[70] = { files: [], closes: [], head: "fix/149-x", body: "Closes #149", model: null, merged: true };
    f.prs[71] = { files: [], closes: [], head: "docs/readme", body: "См. #49", model: null, merged: true };
    f.prs[72] = { files: [], closes: [], head: "fix/49-x", base: "release", model: null, merged: true };
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 закрывать рано: задача открыта, влитого PR нет");
    expect(r.err).toContain("проверены связь PR с задачей, ветка <type>/49-<slug> и «Closes #49» в теле последних 50 PR в main");
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("связи нет, PR задачи по ветке открыт — отказ, ничего не тронуто", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f, { merged: false, state: "OPEN" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 закрывать рано: PR #77 открыт");
    expect(f.mutations).toEqual([]);
  });

  it("задача закрыта без PR — факт и «Готово», задачу повторно не закрывает", () => {
    const f = new FakeGitHub(REC);
    f.closed(49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("est не установлен рядом — «факт недоступен: est не установлен», остальное сделано", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls), env: { AI_DEV_EST: "/nowhere/est.ts" } });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("○ факт недоступен: est не установлен");
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("est упал — его ошибка строкой «!», остальное сделано", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([], { status: 1, stderr: "EstError: у репозитория нет paths в реестре\n" }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("! est fact: EstError: у репозитория нет paths в реестре");
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("последняя подзадача — эпик закрыт и в «Готово»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const r = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) });
    expect(byOp(f, "CloseIssue").map((m) => m.issueId)).toEqual([f.issue(47).id, f.issue(45).id]);
    expect(statusSet(f)).toEqual([[47, "Готово"], [45, "Готово"]]);
    expect(r.out).toContain("+ эпик #45 закрыт и в «Готово»: все подзадачи закрыты");
  });

  it("есть открытые подзадачи — эпик не трогается", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 46);
    const r = task(f, ["close", "46", "--no-git"], REPO, { run: est([]) });
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(statusSet(f)).toEqual([[46, "Готово"]]);
    expect(r.out).toContain("○ эпик #45: открытых подзадач 1");
  });

  it("последняя открытая задача milestone — milestone закрыт", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("Релиз 2026-10");
    f.issueMilestones[49] = m.id;
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(f.closedMilestones).toEqual([m.number]);
    expect(r.out).toContain("+ milestone «Релиз 2026-10» закрыт: открытых задач не осталось");
  });

  it("в milestone остались открытые задачи — не закрыт", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("Релиз 2026-10");
    f.issueMilestones[49] = m.id;
    f.issueMilestones[42] = m.id;
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(f.closedMilestones).toEqual([]);
    expect(r.out).toContain("○ milestone «Релиз 2026-10»: открытых задач 1");
  });

  it("облачная сессия — объяснение со ссылкой на docs/cloud-sessions.md, код 2, без мутаций", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const r = task(f, ["close", "49"], REPO, { env: { CLAUDE_CODE_REMOTE: "true" } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("docs/cloud-sessions.md");
    expect(r.err).toContain("est fact 49");
    expect(f.mutations).toEqual([]);
  });
});

/** Влитое убирается по правилу «влитое удаляю целиком» (скилл github, «Git, PR и мерж — механика»): чекаут — на origin/main, ветка — долой локально и на хостинге. */
describe("task close убирает влитое", () => {
  // репозиторий задачи: bare origin с путём вида …/miroshnik/ai-dev.git, чекаут на ветке задачи
  function checkout(branch: string, { merged = true } = {}) {
    const { dir, cleanup } = tmpDir();
    const origin = path.join(dir, "miroshnik/ai-dev.git");
    mkdirSync(path.dirname(origin), { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const work = path.join(dir, "work");
    mkdirSync(work);
    const repo = gitRepo(work);
    repo.commit({ "README.md": "x\n" }, "init");
    repo.git("remote", "add", "origin", origin);
    repo.git("push", "-q", "-u", "origin", "main");
    repo.git("switch", "-q", "-c", branch);
    repo.commit({ "a.txt": "a\n" }, "work");
    repo.git("push", "-q", "-u", "origin", branch);
    if (merged) {
      repo.git("switch", "-q", "main");
      repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "merge", "-q", "--no-ff", "-m", "merge", branch);
      repo.git("push", "-q", "origin", "main");
      repo.git("switch", "-q", branch);
    }
    return { work, origin, cleanup };
  }
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  // git — настоящий во временном репозитории, est — подменён
  const noEst = (cmd: string, args: string[], cwd?: string) => (cmd === "bun" ? { status: 0, stdout: "Факт: …\n", stderr: "" } : realRun(cmd, args, cwd));

  it("чекаут на ветке задачи, PR влит: после close — detach на origin/main, локальной и удалённой ветки нет", () => {
    const { work, origin, cleanup } = checkout("fix/49-x");
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(git(work, "branch", "--show-current")).toBe("");
      expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
      expect(git(work, "branch", "--list", "fix/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "fix/49-x")).toBe("");
      expect(r.out).toContain("+ чекаут — на origin/main (detached)");
      expect(r.out).toContain("+ локальная ветка fix/49-x удалена");
      expect(r.out).toContain("+ удалённая ветка fix/49-x удалена");
    } finally {
      cleanup();
    }
  });

  it("связи PR с задачей нет, влитый PR найден по ветке — ветка убрана", () => {
    const { work, origin, cleanup } = checkout("fix/49-x");
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [], head: "fix/49-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(git(work, "branch", "--list", "fix/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "fix/49-x")).toBe("");
      expect(r.out).toContain("+ удалённая ветка fix/49-x удалена");
    } finally {
      cleanup();
    }
  });

  it("ветка не влита — не тронута, строка ○", () => {
    const { work, origin, cleanup } = checkout("fix/49-x", { merged: false });
    try {
      const f = new FakeGitHub(REC);
      f.closed(49);
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ ветка fix/49-x не влита в origin/main — не тронута");
      expect(git(work, "branch", "--show-current")).toBe("fix/49-x");
      expect(git(origin, "branch", "--list", "fix/49-x")).toContain("fix/49-x");
    } finally {
      cleanup();
    }
  });

  it("текущий каталог — не чекаут репозитория задачи: ветки не трогаются", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: dir });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ ветки не трогаю: текущий каталог — не чекаут miroshnik/ai-dev");
    } finally {
      cleanup();
    }
  });
});
