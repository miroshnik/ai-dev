import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { descSize } from "../../../skills/est/scripts/est.ts";
import { main, realRun } from "../../../skills/github/scripts/github.ts";
import type { Io } from "../../../skills/github/scripts/github.ts";
import { asOrg, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { githubOrigin, gitRepo, tmpDir } from "../../lib/spec.ts";

// модель архитектуры скилл читает отдельным процессом bun
setDefaultTimeout(SPAWN_TIMEOUT);

// Ответы GitHub — записанные с проекта ai-dev, `gh` подменён: мутации меняют запись так, как это сделал бы GitHub
const REC: Recording = JSON.parse(readFileSync(new URL("../../lib/github-ai-dev.json", import.meta.url), "utf8"));
const REPO = "miroshnik/ai-dev";
const ORG = "acme/ai-dev";

let pauses = 0;
/** Вызов скрипта task-env (снятие стеков задачи в `task close`) — подпроцесс bun, как est. */
const isTaskEnv = (args: string[]) => args.some((a) => /skills\/task-env\/scripts\/task-env\.ts$/.test(a));
/** Аргументы вызова task-env без пути к скрипту: флаги bun и команда. */
const taskEnvArgs = (args: string[]) => args.filter((a) => !isTaskEnv([a]));
// est — подпроцесс bun (внешний край): по умолчанию молчит и ничего не пишет, git — настоящий; тесты est подменяют его сами
const silentEst = (cmd: string, args: string[], cwd?: string) => (cmd === "bun" ? { status: 0, stdout: "", stderr: "" } : realRun(cmd, args, cwd));
function task(f: FakeGitHub, args: string[], repo = REPO, io: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["task", ...args, "--repo", repo], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, sleep: () => void pauses++, run: silentEst, ...io });
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
  it("подзадача эпика: заголовок с префиксом эпика, в проекте в Бэклог, sub-issue, blocked by, следующий шаг — сумма оценок эпика", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт задач", "--body", "Что сделать", "--epic", "45", "--blocked-by", "#49"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateIssue")).toEqual([{ repositoryId: f.repo.id, title: "GitHub · Экспорт задач", body: "Что сделать", projectV2Ids: [f.project().id], parentIssueId: f.issue(45).id }]);
    expect(statusSet(f)).toEqual([[50, "Бэклог"]]);
    expect(byOp(f, "AddBlockedBy")).toEqual([{ issueId: f.issue(50).id, blockingIssueId: f.issue(49).id }]);
    expect(r.out.split("\n")).toEqual([
      "Created #50 GitHub · Экспорт задач — https://github.com/miroshnik/ai-dev/issues/50",
      "+ project «ai-dev»: Status «Бэклог»",
      "+ subtask of epic #45",
      "+ blocked by #49",
      "Next: «Оценка, ч» of epic #45 — recompute as the sum of its subtasks' estimates.",
    ]);
  });

  it("заголовок уже с префиксом эпика — префикс не удваивается", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "GitHub · Экспорт задач", "--epic", "45"]);
    expect(byOp(f, "CreateIssue")[0].title).toBe("GitHub · Экспорт задач");
  });

  it("закрытый блокер пропускается — он уже не блокирует", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--blocked-by", "46,49"]);
    expect(byOp(f, "AddBlockedBy").map((m) => m.blockingIssueId)).toEqual([f.issue(49).id]);
    expect(r.out).toContain("+ #46 is closed — doesn't block, skipped");
  });

  it("тело задачи — из файла --body-file", () => {
    const f = new FakeGitHub(REC);
    const file = new URL("../../lib/github-ai-dev.json", import.meta.url).pathname;
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body-file", file]);
    expect(byOp(f, "CreateIssue")[0].body).toBe(readFileSync(file, "utf8"));
  });

  // в личном аккаунте типов issue нет — эпик помечается меткой epic, это единственное исключение
  it("эпик в личном аккаунте — метка epic вместо типа; эпик не оценивается", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"]);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([f.taskContext.label.id]);
    expect(byOp(f, "CreateIssue")[0]).not.toHaveProperty("issueTypeId");
    expect(r.out).toContain("+ label «epic» — the type in a personal account");
    expect(r.out).toContain("Next: an epic isn't estimated — its «Оценка, ч» is the sum of its subtasks' estimates.");
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
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--milestone", "GitHub · 1 · Проект"]);
    expect(byOp(f, "CreateIssue")[0].milestoneId).toBe(m.id);
    expect(r.out).toContain("+ milestone «GitHub · 1 · Проект»");
  });

  // заведённую задачу сессия с закреплённой задачей сама не возьмёт (`task status` откажет) — вывод сразу называет, куда её нести
  it("в сессии с закреплённой задачей «Next:» называет новую сессию и первый промпт #M", () => {
    const f = new FakeGitHub(REC);
    const io = inSession(scratch());
    expect(task(f, ["new", "--branch-type", "feat", "--title", "Импорт"], REPO, io).out).not.toContain("the session runs");
    task(f, ["status", "49", "В работе"], REPO, io);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").at(-1)).toBe("Next: the session runs miroshnik/ai-dev#49 — #51 in a new session, first prompt: #51.");
  });

  describe("ошибка до создания — задача не заводится наполовину", () => {
    const refused = (f: FakeGitHub, args: string[], message: string, repo = REPO) => {
      const r = task(f, ["new", "--branch-type", "feat", ...args], repo); // тип ветки верный — отказ из-за другого аргумента
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
      expect(f.mutations).toEqual([]);
    };

    it("--epic указывает не на эпик", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--epic", "47"], "#47 is not an epic (no epic label)"));
    it("эпик закрыт", () => {
      const f = new FakeGitHub(REC);
      f.closed(45);
      refused(f, ["--title", "Экспорт", "--epic", "45"], "epic #45 is closed");
    });
    it("открытого milestone с таким названием нет", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--milestone", "Нет такого"], "no open milestone «Нет такого»"));
    it("открытая задача с тем же заголовком уже есть — дубль не заводится", () => {
      const f = new FakeGitHub(REC);
      refused(f, ["--title", f.issue(49).title], "an open task with this title already exists: #49");
    });
    it("в личном аккаунте --priority — приоритет там не ведём", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--priority", "High"], "a personal account has no issue fields"));
    it("блокера нет в репозитории", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--blocked-by", "999"], "no issue #999 in miroshnik/ai-dev"));
    it("проекта нет — сначала project fix", () => {
      const f = new FakeGitHub(REC);
      f.unlinkAll();
      refused(f, ["--title", "Экспорт"], "no project is linked to miroshnik/ai-dev — github project fix first");
    });
  });
});

/**
 * Оценку ставит сам `task new` — как `task close` пишет факт: агент скилл est для оценки не открывает и ничего не
 * выбирает. Ручной подбор аналогов и поправки шли до 10 минут (#381), а точнее механики не были: аналоги подбирает
 * скрипт, а по мере закрытия задач их факты сами становятся аналогами следующих оценок.
 */
describe("task new ставит оценку сам — по аналогам, которые подбирает скрипт", () => {
  const ESTIMATE = "Оценка: 0.5 ч, ≈ 20 млн токенов, ≈ $8 (тип feat, доверие A; прогноз по фактам аналогов). Аналоги (подбор скриптом): #12 (факт 0.4 ч); #14 (факт 0.5 ч); #20 (факт 1 ч). Поправка: ×1.";
  const STDOUT = `== miroshnik/ai-dev#50: Экспорт\ncurrent «Оценка, ч»: —; status: Бэклог\ncomment:\n${ESTIMATE}\n<!-- est {"v": 2, "h": 0.5} -->\n«Estimate» comment created, field «Оценка, ч» = 0.5\n`;
  const est =
    (calls: string[][], r: { status: number; stdout?: string; stderr?: string } = { status: 0, stdout: STDOUT }) =>
    (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });

  it("задача с --branch-type — сразу est estimate <N> --type <тип ветки> --write; вывод est — в выводе task new, без маркера", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(3)).toEqual(["estimate", "50", "--repo", REPO, "--type", "feat", "--write"]);
    expect(calls[0]!.slice(0, 2)).toEqual(["bun", "--no-env-file"]);
    expect(calls[0]![2]).toMatch(/skills\/est\/scripts\/est\.ts$/);
    expect(r.out).toContain(ESTIMATE);
    expect(r.out).toContain("«Estimate» comment created, field «Оценка, ч» = 0.5");
    expect(r.out).not.toContain("<!--");
    expect(r.out).not.toContain("est estimate");
  });

  it("баг без --branch-type — оценка с типом fix: ветка бага — fix/<N>-…", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    expect(task(f, ["new", "--title", "Экспорт падает", "--type", "Баг"], REPO, { run: est(calls) }).code).toBe(0);
    expect(calls[0]!.slice(3)).toEqual(["estimate", "50", "--repo", REPO, "--type", "fix", "--write"]);
  });

  it("эпик не оценивается: est не зовётся, «Next:» — оценка эпика есть сумма оценок подзадач", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("Next: an epic isn't estimated — its «Оценка, ч» is the sum of its subtasks' estimates.");
  });

  it("задача без --branch-type — ошибка до создания: тип ветки нужен оценке", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--branch-type is required for a task: feat, fix, docs, refactor, perf, test, chore, ci, build, research — the type of its branch and of its estimate");
    expect(f.mutations).toEqual([]);
  });

  it("тип ветки не из списка — ошибка до создания", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feature"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--branch-type: feat, fix, docs, refactor, perf, test, chore, ci, build, research");
    expect(f.mutations).toEqual([]);
  });

  it("эпик с --branch-type — ошибка до создания: у эпика нет ветки и своей оценки", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик", "--branch-type", "feat"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("an epic has no branch and isn't estimated — --branch-type is for a task or a bug");
    expect(f.mutations).toEqual([]);
  });

  it("est не установлен рядом — задача заведена, «○ no estimate: est is not installed», код 0", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], REPO, { run: est(calls), env: { AI_DEV_EST: "/nowhere/est.ts" } });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("○ no estimate: est is not installed (/nowhere/est.ts)");
    expect(statusSet(f)).toEqual([[50, "Бэклог"]]);
  });

  it("est упал — задача заведена, его ошибка строкой «! est estimate», код 0", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], REPO, { run: est([], { status: 1, stderr: "warning: x\nerror: GitHub is unavailable\n" }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("! est estimate: error: GitHub is unavailable");
    expect(statusSet(f)).toEqual([[50, "Бэклог"]]);
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
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "billing,audit"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" }]);
    const billing = f.labels.find((l) => l.name === "billing")!;
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([billing.id, audit.id]);
    expect(issueLabels(f, 50)).toEqual(["billing", "audit"]);
    expect(r.out).toContain("+ created label «billing»");
    expect(r.out).toContain("+ labels: billing, audit");
  });

  it("новое решение — `вид:имя`: метка с именем, строка называет решение новым", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "capability:export"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "export", color: CAP, description: "Решение: tests/capabilities/export" }]);
    expect(issueLabels(f, 50)).toEqual(["export"]);
    expect(r.out).toContain("+ export — new decision: tests/capabilities/export is not in the default branch yet");
  });

  it("метка не решения, которой нет в репозитории, — ошибка до создания задачи", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "capability:export,срочно"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no label «срочно» in the repository");
    expect(r.err).toContain("a new decision — kind:name");
    expect(byOp(f, "CreateIssue")).toEqual([]);
    expect(byOp(f, "CreateLabel")).toEqual([]);
  });

  it("task new --epic — метки решений задачи добавляются эпику", () => {
    const f = new FakeGitHub(REC);
    f.tree.capabilities = ["billing"];
    f.label("срочно", "B60205");
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--labels", "billing,срочно"]);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 45)).toEqual(["epic", "billing"]);
    expect(r.out).toContain("+ epic #45: billing");
  });

  // метка-разрез (описание «Разрез: …») — разрез задач проекта, а не метка решения, хотя имя у них одно (#343)
  it("метка-разрез с именем решения: `вид:имя` — ошибка до создания, по имени — обычная метка задачи, эпику не передаётся", () => {
    const f = new FakeGitHub(REC);
    f.tree.model = `export default { modules: { api: { path: "apps/api" } } };\n`;
    const api = f.label("api", "C5DEF5", "Разрез: приложения — API-сервер");
    const refused = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "architecture:api"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("label «api» is slice «приложения», not a decision label: decision api isn't labeled; the slice label — --labels api");
    expect(f.mutations).toEqual([]);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--labels", "api"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([api.id]);
    expect(issueLabels(f, 45)).toEqual(["epic"]);
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
    expect(r.out).toContain("+ created label «billing»");
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
    expect(r.out).toContain("= #49: old — the decision is not in the PR diff, the label stays");
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
    expect(r.out).toContain("○ billing — only a mechanical edit");
  });

  it("правка только `exceptions.ts` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    f.prs[120] = { files: [{ path: "tests/standards/audit/exceptions.ts", changeType: "MODIFIED", additions: 0, deletions: 4 }], closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("PR #120 → #49: no decisions in the diff");
    expect(r.out).toContain("○ audit — only a mechanical edit");
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
    expect(r.out).toContain("○ audit — only a mechanical edit");
  });

  // исключений названий больше нет (#447): удаление оставшегося каталога в папке каждого решения — не правка решений
  it("`pr labels`: удаление оставшихся файлов `names.exceptions/` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("billing", CAP, "Решение: tests/capabilities/billing");
    const files = [{ path: "tests/capabilities/billing/names.exceptions/returns-201.json", changeType: "DELETED", additions: 0, deletions: 6 }];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("○ billing — only a mechanical edit");
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
    expect(r.out).toContain("○ domain — only a mechanical edit");
    expect(r.out).toContain("○ legacy — only a mechanical edit");
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
    expect(r.out).toContain("+ epic #45: billing");
  });

  // модуль web модели и метка-разрез web команды — одно имя, разный смысл: метка решения модулю не нужна (#343)
  it("модуль модели в диффе, его имя у метки-разреза — строка ○, метка-разрез задаче и эпику не ставится", () => {
    const f = new FakeGitHub(REC);
    f.label("web", "C5DEF5", "Разрез: приложения");
    f.prs[120] = { files: ["src/domain/invoice.ts", "src/web/page.tsx"], closes: [47], head: HEAD, model: MODEL };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 47)).toEqual(["domain"]);
    expect(issueLabels(f, 45)).toEqual(["epic", "domain"]);
    expect(r.out).toContain("PR #120 → #47: domain");
    expect(r.out).toContain("○ web — label «web» is slice «приложения», not a decision label: not set");
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
    expect(r.err).toContain("PR #120 has no «Closes #N»");
    expect(f.mutations).toEqual([]);
  });
});

describe("В организации задача получает тип issue и Priority, эпик — не ниже подзадачи", () => {
  const org = () => new FakeGitHub(asOrg(REC));

  it("тип issue организации и Priority Medium по умолчанию — в той же мутации, что и задача", () => {
    const f = org();
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"], ORG);
    expect(byOp(f, "CreateIssue")[0]).toMatchObject({ issueTypeId: "IT_1", issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_medium" }] });
    expect(r.out).toContain("+ type «Задача»");
    expect(r.out).toContain("+ Priority «Medium»");
  });

  it("подзадача срочнее эпика — Priority эпика поднимается до неё; не срочнее — эпик не трогается", () => {
    const f = org();
    f.setPriority(45, "Low");
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--priority", "High"], ORG);
    expect(byOp(f, "SetIssueField")).toEqual([{ issueId: f.issue(45).id, issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_high" }] }]);
    expect(r.out).toContain("+ Priority of epic #45: Low → High");
    task(f, ["new", "--branch-type", "feat", "--title", "Импорт", "--epic", "45", "--priority", "Medium"], ORG);
    expect(byOp(f, "SetIssueField")).toHaveLength(1);
  });

  it("выключенный тип или чужое значение Priority — ошибка до создания", () => {
    const f = org();
    f.repo.owner.issueTypes.nodes.find((t: { name: string }) => t.name === "Баг").isEnabled = false;
    expect(task(f, ["new", "--title", "Экспорт", "--type", "Баг"], ORG).err).toContain("the organization has no enabled type «Баг» — github project fix");
    expect(task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--priority", "P1"], ORG).err).toContain("--priority: Urgent, High, Medium, Low");
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
    expect(r.out).toContain("+ epic #45: Status «В работе» — the first subtask is taken");
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
    expect(r.out).toContain("+ #49: Status «Бэклог» (added to the project)");
  });

  it("последняя подзадача закрыта и в Готово — подсказка закрыть эпик", () => {
    const f = new FakeGitHub(REC);
    f.closed(47);
    const r = task(f, ["status", "47", "Готово"]);
    expect(r.out).toContain("Next: all subtasks of epic #45 are closed — close the epic and set it to «Готово».");
  });

  it("статус не из канона — ошибка, ничего не меняется", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "47", "Сделано"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("status: Бэклог, В работе, Готово");
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
    expect(r.err).toBe(`error: the session runs miroshnik/ai-dev#49; #42 — in a new session, first prompt: #42 (pin: ${pinFile(config)} — a mistaken one is removed by a human)`);
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
    expect(r.err).toContain("the session runs miroshnik/ai-dev#49; #49 — in a new session, first prompt: #49");
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
  it("CLAUDE_CODE_SESSION_ID нет — статус ставится, строка «session not recognized», файла нет", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const io = { env: { AI_DEV_CONFIG_DIR: config } };
    const r = task(f, ["status", "49", "В работе"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ session not recognized (no CLAUDE_CODE_SESSION_ID) — the task isn't pinned");
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
    expect(r.err).toContain(`pin: ${pinFile(legacy)}`);
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
    expect(r.out).toContain("+ #49 closed: duplicate of #42");
  });

  it("подзадача эпика — подсказка пересчитать оценку эпика", () => {
    const f = new FakeGitHub(REC);
    expect(task(f, ["drop", "47"]).out).toContain("Next: «Оценка, ч» of epic #45 — recompute as the sum of the remaining subtasks.");
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
    expect(r.err).toContain("#46 is closed as completed — drop is only for tasks not done");
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
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[50, "Бэклог"]]);
    expect(r.out).toContain("+ project «ai-dev»: Status «Бэклог»");
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
    expect(r.out).not.toContain("added to the project");
  });

  it("элемент так и не виден — понятная ошибка с тем, что повторить, а не падение", () => {
    const f = new FakeGitHub(REC);
    f.issueRefLag[49] = 100;
    const r = task(f, ["status", "49", "В работе"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 is already in the project, but its item isn't visible — retry: github task status 49");
  });
});

/**
 * Закрытие после мержа шло фазами друг за другом: деплой, `task close`, актуализация блока субагентом, — медиана 8,5 мин
 * и 12 ходов на пиковом контексте, больше половины — ходы модели: прочитать справочник, собрать задание субагенту.
 * Актуализация от деплоя не зависит и идёт параллельно с ним, а задание печатает скрипт: агенту не нужен справочник.
 * Нет эпика или открытых задач в нём — актуализировать нечего, субагент не нужен.
 */
describe("task actualize печатает задание субагенту актуализации блока", () => {
  const REFERENCE = readFileSync(new URL("../../../skills/github/reference.md", import.meta.url), "utf8");
  // пять проверок канона — список между «Five checks:» и «What was fixed» в справочнике
  const CHECKS = /Five checks:\n\n([\s\S]*?)\n\nWhat was fixed/.exec(REFERENCE)?.[1] ?? "";

  it("скрипт печатает готовое задание субагенту актуализации: задача, эпик, открытые задачи эпика, пять проверок", () => {
    const f = new FakeGitHub(REC);
    f.prs[77] = { files: [], closes: [46], head: "feat/46-project-check", base: "main", model: null, merged: true };
    const r = task(f, ["actualize", "46"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    // номер задачи — после слова «Задача»: est привязывает работу субагента к задаче, эпик после «эпик» — нет
    expect(lines[0]).toBe("Задача #46 (эпик #45): актуализация блока после мержа — открытые задачи эпика привести в соответствие с выкаченным.");
    expect(lines).toContain("Репозиторий miroshnik/ai-dev. Выкачено: #46 «GitHub · Проект по канону — github project check и fix», PR #77 (`gh pr view 77`, `gh pr diff 77`).");
    expect(lines).toContain("Эпик #45 «GitHub · Скилл github: проект и задачи по канону одной командой». Открытые задачи эпика — его подзадачи (sub-issues), а не список в описании эпика:");
    expect(lines).toContain("- #47 «GitHub · Задача одной командой — github task»");
    expect(CHECKS.match(/^\d\. \*\*/gm)).toHaveLength(5);
    expect(r.out).toContain(CHECKS);
    expect(r.out).toContain("#46, эпик #45 и их milestone не закрывать — это сделает task close после тебя");
    expect(r.out).toContain("Что поправил — одной строкой в комментарии к эпику #45");
    expect(f.mutations).toEqual([]);
  });

  it("у задачи без эпика скрипт пишет, что актуализация не нужна", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["actualize", "49"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("○ refresh not needed: #49 has no epic. Next: task close 49 — after the deploy, where the merge deploys.");
  });

  it("в эпике нет открытых задач, кроме этой, — скрипт пишет, что актуализация не нужна", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["actualize", "47"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("○ refresh not needed: epic #45 has no open tasks besides #47. Next: task close 47 — after the deploy, where the merge deploys.");
  });

  it("задачи эпика в задании — его подзадачи (sub-issues): список задач в описании эпика туда не попадает", () => {
    const f = new FakeGitHub(REC);
    f.issue(45).body = "## План\n\n- #48 «GitHub · Старая задача из плана»\n- #49 «GitHub · Задача без эпика»";
    const r = task(f, ["actualize", "46"]);
    expect(r.out).toContain("- #47 «GitHub · Задача одной командой — github task»");
    expect(r.out).not.toContain("#48");
    expect(r.out).not.toContain("#49");
  });

  it("новая открытая подзадача эпика попадает в задание", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт счетов", "--epic", "45"]);
    const r = task(f, ["actualize", "47"]);
    expect(r.out).toContain("- #50 «GitHub · Экспорт счетов»");
    expect(r.out).not.toContain("- #47 ");
  });
});

/**
 * После мержа PR сессия делала ещё ≈21 ход на пиковом контексте — факт, статус, milestone, уборка ветки. `task close`
 * сворачивает это в один вызов; актуализацию блока до него делает субагент со свежим контекстом.
 */
describe("task close закрывает задачу одной командой", () => {
  const FACT = "Факт: 0.25 ч активных в Claude Code (оценка 0.25 ч, ×1.00). 1 сессия, 2 промпта, стена 0.3 ч, покрытие full. PR #77; 1 коммит, дифф 12 строк.";
  // est — подпроцесс (внешний край): в тестах подменяется, его вывод печатается как есть; снятие стеков task-env молчит,
  // git — настоящий
  const est =
    (calls: string[][], r: { status: number; stdout?: string; stderr?: string } = { status: 0, stdout: FACT + "\nкомментарий «Факт» создан\n" }) =>
    (cmd: string, args: string[], cwd?: string) =>
      cmd !== "bun"
        ? realRun(cmd, args, cwd)
        : isTaskEnv(args)
          ? { status: 0, stdout: "", stderr: "" }
          : (calls.push([cmd, ...args]), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
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
    expect(calls[0]!.slice(0, 2)).toEqual(["bun", "--no-env-file"]);
    expect(calls[0]![2]).toMatch(/skills\/est\/scripts\/est\.ts$/);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
    expect(r.out).toContain("+ #49 closed: PR #77 merged");
    expect(r.out).toContain(FACT);
    expect(r.out).toContain("+ #49: Status «Готово»");
    // у задачи нет эпика — актуализировать нечего, следующий шаг — конец сессии
    expect(r.out.split("\n").at(-1)).toStartWith("Next: the last line of the answer is one of three");
  });

  /**
   * Актуализация блока идёт до `task close`, параллельно с деплоем: close о ней только напоминает — и только там, где
   * в эпике есть открытые задачи, с командой, которая печатает задание субагенту.
   */
  it("в эпике есть открытые задачи — последняя строка напоминает об актуализации командой task actualize", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 46);
    const last = task(f, ["close", "46", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toStartWith("Next: the epic refresh, if it didn't happen before close — a subagent with the task actualize 46 assignment; then the last line of the answer is one of three");
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
    expect(last).toContain(
      "Next: the last line of the answer is one of three: «Всё сделано. Сессию можно закрывать.»; " +
        "the owner has something to decide — «Всё сделано, но есть вопросы: …» with the questions themselves, without «Всё сделано. Сессию можно закрывать.»; " +
        "something remains — «Осталось: …».",
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
    expect(last).toContain("In auto mode after «Всё сделано. Сессию можно закрывать.» — archive the session where the agent has the tool; after the other two lines — don't.");
  });

  /**
   * «Есть вопросы» без вопроса — шум: наблюдение, срок, предупреждение владелец читает в отчёте, решать ему нечего.
   * Такая сессия заканчивает как обычно и в режиме auto архивирует себя.
   */
  it("последняя строка вывода не считает вопросом информацию без решения: строка и архивация — как у «всё сделано»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain("Information without a decision (an observation, a deadline, a warning) isn't a question: the line and archiving are as with «Всё сделано. Сессию можно закрывать.»");
  });

  it("PR открыт или закрыт без мержа — ошибка до изменений, ничего не тронуто", () => {
    const f = new FakeGitHub(REC);
    f.prs[78] = { files: [], closes: [49], head: "fix/49-x", model: null, merged: false, state: "OPEN" };
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("PR #78 open");
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
    expect(r.out).toContain("+ #49 closed by PR #77 (branch fix/49-x): GitHub didn't link the PR to the task");
  });

  it("связи нет, влитый PR с «Closes #N» в теле — задача закрыта по нему", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f, { head: "export-invoices", body: "Экспорт счетов.\n\nCloses #49" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment").map((c) => c.body)).toEqual(["Закрыта по PR #77: GitHub не связал PR с задачей"]);
    expect(r.out).toContain("+ #49 closed by PR #77 («Closes #49» in the body): GitHub didn't link the PR to the task");
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
    expect(r.err).toContain("#49 is too early to close: the task is open, no merged PR");
    expect(r.err).toContain("checked: the PR–task link, the branch <type>/49-<slug> and «Closes #49» in the body of the last 50 PRs into main");
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("связи нет, PR задачи по ветке открыт — отказ, ничего не тронуто", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f, { merged: false, state: "OPEN" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 is too early to close: PR #77 open");
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

  it("est не установлен рядом — «actual unavailable: est is not installed», остальное сделано", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls), env: { AI_DEV_EST: "/nowhere/est.ts" } });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("○ actual unavailable: est is not installed");
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("est упал — его ошибка строкой «!», остальное сделано", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([], { status: 1, stderr: "EstError: the repository has no paths in the registry\n" }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("! est fact: EstError: the repository has no paths in the registry");
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("последняя подзадача — эпик закрыт и в «Готово»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const r = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) });
    expect(byOp(f, "CloseIssue").map((m) => m.issueId)).toEqual([f.issue(47).id, f.issue(45).id]);
    expect(statusSet(f)).toEqual([[47, "Готово"], [45, "Готово"]]);
    expect(r.out).toContain("+ epic #45 closed and in «Готово»: all subtasks are closed");
  });

  it("есть открытые подзадачи — эпик не трогается", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 46);
    const r = task(f, ["close", "46", "--no-git"], REPO, { run: est([]) });
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(statusSet(f)).toEqual([[46, "Готово"]]);
    expect(r.out).toContain("○ epic #45: open subtasks 1");
  });

  it("последняя открытая задача milestone — milestone закрыт", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("Релиз 2026-10");
    f.issueMilestones[49] = m.id;
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(f.closedMilestones).toEqual([m.number]);
    expect(r.out).toContain("+ milestone «Релиз 2026-10» closed: no open tasks left");
  });

  it("в milestone остались открытые задачи — не закрыт", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("Релиз 2026-10");
    f.issueMilestones[49] = m.id;
    f.issueMilestones[42] = m.id;
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(f.closedMilestones).toEqual([]);
    expect(r.out).toContain("○ milestone «Релиз 2026-10»: open tasks 1");
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

// репозиторий задачи: bare origin с путём вида …/<slug>.git — для скрипта репозиторий GitHub slug, чекаут на ветке задачи
function checkout(branch: string, { merged = true, slug = REPO } = {}) {
  const { dir, cleanup } = tmpDir();
  const origin = path.join(dir, `${slug}.git`);
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const repo = gitRepo(work);
  // чекаут ai-dev: язык проекта — русский, как у записанного проекта GitHub
  repo.commit({ "README.md": "x\n", ".agents/ai-dev.json": '{ "language": "ru" }\n' }, "init");
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
// git — настоящий во временном репозитории, его origin — репозиторий GitHub; est — подменён
const noEst = githubOrigin((cmd: string, args: string[], cwd?: string) =>
  cmd !== "bun" ? realRun(cmd, args, cwd) : { status: 0, stdout: isTaskEnv(args) ? "" : "Факт: …\n", stderr: "" },
);

/** Влитое убирается по правилу «влитое удаляю целиком» (скилл github, «Git, PRs and merging — mechanics»): чекаут — на origin/main, ветка — долой локально и на хостинге. */
describe("task close убирает влитое", () => {
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
      expect(r.out).toContain("+ checkout — on origin/main (detached)");
      expect(r.out).toContain("+ local branch fix/49-x deleted");
      expect(r.out).toContain("+ remote branch fix/49-x deleted");
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
      expect(r.out).toContain("+ remote branch fix/49-x deleted");
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
      expect(r.out).toContain("○ branch fix/49-x is not merged into origin/main — left alone");
      expect(git(work, "branch", "--show-current")).toBe("fix/49-x");
      expect(git(origin, "branch", "--list", "fix/49-x")).toContain("fix/49-x");
    } finally {
      cleanup();
    }
  });

  /** Имя проекта стеков — из `origin` чекаута (task-env): из чужого чекаута сняли бы стеки другого проекта. */
  it("текущий каталог — не чекаут репозитория задачи: ветки и стеки задачи не трогаются", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const calls: string[][] = [];
      const run = (cmd: string, args: string[], cwd?: string) => (isTaskEnv(args) && calls.push(args), noEst(cmd, args, cwd));
      const r = task(f, ["close", "49"], REPO, { run, cwd: dir });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ branches and task stacks left alone: the current directory is not a checkout of miroshnik/ai-dev");
      expect(calls).toEqual([]);
    } finally {
      cleanup();
    }
  });

  /** Чекаут узнаётся равенством owner/repo из origin (стандарт origin-repo), не подстрокой URL. */
  it("task close из чекаута репозитория с тем же префиксом имени (ai-dev-tools при ai-dev) — не чекаут задачи: ни стеки, ни ветки не трогаются", () => {
    const { work, origin, cleanup } = checkout("fix/49-x", { slug: "miroshnik/ai-dev-tools" });
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const calls: string[][] = [];
      const run = (cmd: string, args: string[], cwd?: string) => (isTaskEnv(args) && calls.push(args), noEst(cmd, args, cwd));
      const r = task(f, ["close", "49"], REPO, { run, cwd: work });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ branches and task stacks left alone: the current directory is not a checkout of miroshnik/ai-dev");
      expect(calls).toEqual([]);
      expect(git(work, "branch", "--show-current")).toBe("fix/49-x");
      expect(git(origin, "branch", "--list", "fix/49-x")).toContain("fix/49-x");
    } finally {
      cleanup();
    }
  });

  it("регистр owner/repo в origin не важен: из чекаута Miroshnik/AI-Dev task close убирает ветку и снимает стеки задачи", () => {
    const { work, origin, cleanup } = checkout("fix/49-x", { slug: "Miroshnik/AI-Dev" });
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const calls: string[][] = [];
      const run = (cmd: string, args: string[], cwd?: string) => (isTaskEnv(args) && calls.push(taskEnvArgs(args)), noEst(cmd, args, cwd));
      const r = task(f, ["close", "49"], REPO, { run, cwd: work });
      expect(r.code).toBe(0);
      expect(calls).toEqual([["--no-env-file", "down", "49"]]);
      expect(git(work, "branch", "--list", "fix/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "fix/49-x")).toBe("");
    } finally {
      cleanup();
    }
  });
});

/**
 * Стек задачи (скилл task-env, эпик #392) живёт, пока его не снимут: `task close` снимает стеки задачи — dev и e2e с
 * томами — командой `task-env down <N>` в чекауте задачи. Что снято и что нет, печатает task-env; ошибка снятия
 * закрытие не валит — стек, который не сняли, найдёт `task-env prune`.
 */
describe("task close снимает стеки задачи", () => {
  type Answer = { status: number; stdout?: string; stderr?: string };
  /** task-env — подпроцесс bun (внешний край): ответ подменён, вызовы записаны; git — настоящий, est — молчит. */
  const taskEnv = (calls: { args: string[]; cwd?: string }[], r: Answer) => (cmd: string, args: string[], cwd?: string) =>
    cmd === "bun" && isTaskEnv(args) ? (calls.push({ args: taskEnvArgs(args), cwd }), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }) : noEst(cmd, args, cwd);
  const DOWN = "+ stack ai-dev-49: down, with its volumes\n+ stack ai-dev-49-e2e: down, with its volumes\n";
  const merged = (f: FakeGitHub) => (f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true });

  function close(args: string[], answer: Answer, env: Record<string, string> = {}) {
    const { work, cleanup } = checkout("fix/49-x");
    temp.push(cleanup);
    const f = new FakeGitHub(REC);
    merged(f);
    const calls: { args: string[]; cwd?: string }[] = [];
    const r = task(f, ["close", "49", ...args], REPO, { run: taskEnv(calls, answer), cwd: work, env });
    return { ...r, f, work, calls };
  }

  it("task close снимает стеки закрытой задачи вместе с томами — командой task-env down <N> в чекауте задачи", () => {
    const r = close([], { status: 0, stdout: DOWN });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ args: ["--no-env-file", "down", "49"], cwd: r.work }]);
    expect(r.out).toContain(DOWN.trimEnd());
    expect(statusSet(r.f)).toEqual([[49, "Готово"]]);
  });

  it("ошибка снятия выводится строкой и не мешает закрытию задачи", () => {
    const failed = "! stack ai-dev-49: not removed — permission denied while trying to connect to the docker API";
    const reported = close([], { status: 2, stdout: failed + "\n" });
    expect(reported.code).toBe(0);
    expect(reported.out).toContain(failed);
    expect(statusSet(reported.f)).toEqual([[49, "Готово"]]);
    expect(reported.out).toContain("+ local branch fix/49-x deleted");
    // task-env упал, ничего не сказав в stdout, — его ошибка строкой «!»
    const crashed = close([], { status: 1, stderr: "error: Cannot find module 'node:fs'\n" });
    expect(crashed.code).toBe(0);
    expect(crashed.out).toContain("! task-env down: error: Cannot find module 'node:fs'");
    expect(statusSet(crashed.f)).toEqual([[49, "Готово"]]);
  });

  it("--no-git стеки снимает: флаг — про ветки", () => {
    const r = close(["--no-git"], { status: 0, stdout: DOWN });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ args: ["--no-env-file", "down", "49"], cwd: r.work }]);
    expect(git(r.work, "branch", "--show-current")).toBe("fix/49-x");
  });

  it("task-env не установлен рядом — строка ○, остальное сделано", () => {
    const r = close([], { status: 0, stdout: DOWN }, { AI_DEV_TASK_ENV: "/nowhere/task-env.ts" });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("○ task stacks: task-env is not installed (/nowhere/task-env.ts)");
    expect(statusSet(r.f)).toEqual([[49, "Готово"]]);
  });
});

/**
 * Задачи — на языке проекта (`language` в `.agents/ai-dev.json` чекаута, канон, «Language»): каркас описания, статусы,
 * тип, задание субагенту и комментарии пишутся названиями словаря `skills/github/locales/<язык>.json`, а разбирается
 * название любого его языка. Доска не на языке проекта (скрипт позван не из чекаута, язык сменили без fix) — задача
 * ведётся на языке доски: язык сверяет `project check`.
 */
describe("Задачи — на языке проекта из .agents/ai-dev.json чекаута", () => {
  /** Чекаут проекта с манифестом (null — без манифеста). */
  function checkoutWith(manifest: string | null): string {
    const dir = scratch();
    mkdirSync(path.join(dir, ".git"));
    if (manifest !== null) {
      mkdirSync(path.join(dir, ".agents"));
      writeFileSync(path.join(dir, ".agents/ai-dev.json"), manifest);
    }
    return dir;
  }
  const EN = '{ "language": "en" }\n';
  /** Доска проекта ai-dev на английском — как после project fix в проекте на en. */
  function englishBoard(f: FakeGitHub): FakeGitHub {
    const ru: Record<string, string> = { Бэклог: "Backlog", "В работе": "In progress", Готово: "Done" };
    for (const o of f.field("Status").options) o.name = ru[o.name];
    for (const it of f.items()) if (it.status) it.status = { name: ru[it.status.name] };
    return f;
  }

  it("проект на en: task new пишет раздел ## Questions, est его читает", () => {
    const f = englishBoard(new FakeGitHub(REC));
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Export"], REPO, { cwd: checkoutWith(EN) });
    expect(r.code).toBe(0);
    const body: string = byOp(f, "CreateIssue")[0].body;
    expect(body).toBe("## Scenarios\n\n## Questions\n");
    expect(statusSet(f)).toEqual([[50, "Backlog"]]);
    expect(r.out).toContain("+ project «ai-dev»: Status «Backlog»");
    // est находит раздел: ответ, дописанный в нём после оценки, в размер описания не идёт
    expect(descSize(`${body}1. ✅ Format? **Answer:** PDF.\n`)).toBe(descSize(`${body}1. Format?\n`));
  });

  it("эпик без --body — каркас только с разделом вопросов: эпик без кода, сценариев у него нет", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--title", "Экспорт", "--type", "Эпик"]);
    expect(byOp(f, "CreateIssue")[0].body).toBe("## Вопросы\n");
  });

  it("манифест без поля language — каркас на русском, как раньше", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"], REPO, { cwd: checkoutWith('{ "auto": true }\n') });
    expect(byOp(f, "CreateIssue")[0].body).toBe("## Сценарии\n\n## Вопросы\n");
  });

  it("тело дано — пишется как есть, без каркаса", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body", "Что сделать"]);
    expect(byOp(f, "CreateIssue")[0].body).toBe("Что сделать");
  });

  it("тип и статус — название любого языка словаря: --type Epic и task status Done в проекте на русском", () => {
    const f = new FakeGitHub(REC);
    expect(task(f, ["new", "--title", "Экспорт", "--type", "Epic"]).out).toContain("+ label «epic» — the type in a personal account");
    task(f, ["status", "47", "Done"]);
    expect(statusSet(f).at(-1)).toEqual([47, "Готово"]);
  });

  it("доска на русском, а скрипт позван из каталога без манифеста (en) — задача ведётся на языке доски", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "47", "В работе"], REPO, { cwd: checkoutWith(null) });
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[47, "В работе"]]);
  });

  it("задание субагенту в проекте на en начинается с «Task #N (epic #M)» — по нему est привязывает работу к задаче", () => {
    const f = englishBoard(new FakeGitHub(REC));
    f.prs[77] = { files: [], closes: [46], head: "feat/46-project-check", base: "main", model: null, merged: true };
    const lines = task(f, ["actualize", "46"], REPO, { cwd: checkoutWith(EN) }).out.split("\n");
    expect(lines[0]).toBe("Task #46 (epic #45): epic refresh after the merge — bring the epic's open tasks in line with what shipped.");
    expect(lines).toContain("Epic #45 «GitHub · Скилл github: проект и задачи по канону одной командой». The epic's open tasks — its sub-issues, not a list in the epic's description:");
    expect(lines.at(-1)).toBe("Answer — fixes one per line with task numbers and questions to the owner, if any; otherwise «The block is current».");
  });

  it("проект на en: комментарий о PR, с которым GitHub не связал задачу, — по-английски", () => {
    const f = englishBoard(new FakeGitHub(REC));
    f.prs[77] = { files: [], closes: [], head: "fix/49-x", base: "main", model: null, merged: true };
    const noEst = () => ({ status: 0, stdout: "Actual: …\n", stderr: "" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: noEst, cwd: checkoutWith(EN) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment").map((c) => c.body)).toEqual(["Closed by PR #77: GitHub didn't link the PR to the task"]);
    expect(statusSet(f)).toEqual([[49, "Done"]]);
    expect(r.out.split("\n").at(-1)).toContain("«All done. The session can be closed.»");
  });
});
