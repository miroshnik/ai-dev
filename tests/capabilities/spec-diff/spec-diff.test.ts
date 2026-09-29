import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, runScript, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
let repo: ReturnType<typeof gitRepo>;
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  repo = gitRepo(dir);
});
afterEach(() => cleanup());

const ts = (body: string) => `import { describe, it } from "bun:test";\n${body}\n`;
const BILLING = "tests/capabilities/billing/invoice.test.ts";

function diffFrom(base: string, ...args: string[]) {
  return runScript("spec-diff", ["--base", base, ...args], dir);
}

describe("Снятые требования — первыми, потом изменённые и добавленные", () => {
  it("удалённые идут первыми, потом изменённые, потом добавленные", () => {
    const base = repo.commit({
      [BILLING]: ts(`describe("Счета", () => { it("снято", () => {}); it("выставляется счёт", () => {}); });`),
    });
    repo.commit({
      [BILLING]: ts(`describe("Счета", () => { it("выставляется счёт за месяц", () => {}); it("новое", () => {}); });`),
    });
    const r = diffFrom(base);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("## Спека (тесты)");
    expect(r.stdout).toContain("**Удалены (1):**\n\n- `tests/capabilities/billing` · Счета › снято");
    expect(r.stdout).toContain("**Изменены (1):**\n\n- `tests/capabilities/billing` · Счета › ~~выставляется счёт~~ → выставляется счёт за месяц");
    expect(r.stdout).toContain("**Добавлены (1):**\n\n- `tests/capabilities/billing` · Счета › новое");
    const order = ["Удалены", "Изменены", "Добавлены"].map((w) => r.stdout.indexOf(w));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("без изменений — «Тесты не менялись»", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ "src/app.ts": "export const a = 1;\n" });
    expect(diffFrom(base).stdout).toContain("Тесты не менялись.");
  });

  it("`<` в названиях вне code span экранируется — GitHub не съест `<type>` в теле PR", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); describe("<type>/N", () => { it("маркер <!-- est --> и \`<x>\`", () => {}); });`) });
    expect(diffFrom(base).stdout).toContain("- `tests/capabilities/billing` · \\<type>/N › маркер \\<!-- est --> и `<x>`\n");
  });

  it("пустой список — «нет», а не пропуск раздела", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); it("y", () => {});`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Удалены:** нет.");
    expect(out).toContain("**Изменены:** нет.");
    expect(out).toContain("**Добавлены (1):**");
  });
});

/**
 * Переименованный тест ищется только в том же файле и том же describe (похожесть имени ≥ 0,6); тест с тем же
 * именем под другим describe — в любом файле папки. Порог высокий: спрятать снятое требование под видом
 * переименования хуже, чем показать переименование как удаление и добавление.
 */
describe("Изменён — только очевидное переименование, иначе удалён и добавлен", () => {
  it("непохожее имя в том же describe — удалён и добавлен, не переименование", () => {
    const base = repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("удаляет черновик", () => {}); });`) });
    repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("отправляет письмо бухгалтеру", () => {}); });`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Удалены (1):**");
    expect(out).toContain("**Добавлены (1):**");
    expect(out).toContain("**Изменены:** нет.");
  });

  it("переименован describe — изменён, старый describe зачёркнут", () => {
    const base = repo.commit({ [BILLING]: ts(`describe("Счёт", () => { it("выставляется", () => {}); });`) });
    repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("выставляется", () => {}); });`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Изменены (1):**\n\n- `tests/capabilities/billing` · ~~Счёт~~ → Счета › выставляется");
    expect(out).toContain("**Удалены:** нет.");
  });

  // Так выглядит перекладка теста в раздел-возможность главного файла: юнит и e2e одной возможности — под одним describe (#63)
  it("тот же тест под другим describe в другом файле папки — изменён: переехал в другой раздел", () => {
    const base = repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("выставляется", () => {}); });`) });
    repo.commit({ [BILLING]: null, "tests/capabilities/billing/billing.test.ts": ts(`describe("Счёт выставляется сам", () => { it("выставляется", () => {}); });`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Изменены (1):**\n\n- `tests/capabilities/billing` · ~~Счета~~ → Счёт выставляется сам › выставляется");
    expect(out).toContain("**Удалены:** нет.");
  });

  it("переименование в другом файле — не изменение, а удалён и добавлен", () => {
    const base = repo.commit({ [BILLING]: ts(`it("выставляется счёт", () => {});`) });
    repo.commit({ [BILLING]: null, "tests/capabilities/billing/other.test.ts": ts(`it("выставляется счёт за месяц", () => {});`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Удалены (1):**");
    expect(out).toContain("**Добавлены (1):**");
  });
});

/**
 * Файл в идентичность не входит: единица спеки — папка capability, тесты внутри неё можно перекладывать между
 * файлами.
 */
describe("Тест — это папка, цепочка describe и имя: перекладка между файлами папки — не изменение", () => {
  it("перенос между файлами одной папки — не изменение", () => {
    const base = repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("выставляется", () => {}); });`) });
    repo.commit({ [BILLING]: null, "tests/capabilities/billing/moved.test.ts": ts(`describe("Счета", () => { it("выставляется", () => {}); });`) });
    expect(diffFrom(base).stdout).toContain("Тесты не менялись.");
  });

  it("перенос в другую capability — удалён и добавлен", () => {
    const base = repo.commit({ [BILLING]: ts(`it("выставляется", () => {});`) });
    repo.commit({ [BILLING]: null, "tests/capabilities/invoicing/a.test.ts": ts(`it("выставляется", () => {});`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("- `tests/capabilities/billing` · выставляется");
    expect(out).toContain("- `tests/capabilities/invoicing` · выставляется");
  });

  it("тест в tests/, но вне capabilities, architecture и standards — помечен «вне дерева»", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({
      "tests/unit/a.test.ts": ts(`it("сирота", () => {});`),
      "tests/architecture/layers/layers.test.ts": ts(`it("домен не импортирует инфраструктуру", () => {});`),
    });
    const out = diffFrom(base).stdout;
    expect(out).toContain("- `tests/unit` · сирота ⚠️ вне дерева");
    expect(out).toContain("- `tests/architecture/layers` · домен не импортирует инфраструктуру\n");
  });
});

/**
 * По умолчанию база — merge-base с базовой веткой, как дифф PR на GitHub: чужие тесты, влитые в `main` после
 * ветвления, не выглядят удалёнными.
 */
describe("Сравнение — с тем, что меняет PR, как дифф на GitHub", () => {
  it("merge-base: тест, добавленный в main после ветвления, не считается удалённым", () => {
    repo.commit({ [BILLING]: ts(`it("общий", () => {});`) });
    repo.git("switch", "-q", "-c", "feature");
    repo.commit({ [BILLING]: ts(`it("общий", () => {}); it("из ветки", () => {});`) });
    repo.git("switch", "-q", "main");
    repo.commit({ "tests/capabilities/other/b.test.ts": ts(`it("из main", () => {});`) });
    repo.git("switch", "-q", "feature");
    const out = diffFrom("main").stdout;
    expect(out).toContain("**Добавлены (1):**\n\n- `tests/capabilities/billing` · из ветки");
    expect(out).toContain("**Удалены:** нет.");
    expect(out).toContain("_База: `main (merge-base)`._");
  });

  it("--no-merge-base сравнивает с веткой как есть", () => {
    repo.commit({ [BILLING]: ts(`it("общий", () => {});`) });
    repo.git("switch", "-q", "-c", "feature");
    repo.commit({ "src/a.ts": "" });
    repo.git("switch", "-q", "main");
    repo.commit({ "tests/capabilities/other/b.test.ts": ts(`it("из main", () => {});`) });
    repo.git("switch", "-q", "feature");
    expect(diffFrom("main", "--no-merge-base").stdout).toContain("**Удалены (1):**\n\n- `tests/capabilities/other` · из main");
  });

  it("--worktree видит незакоммиченные и неотслеживаемые тесты", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    writeTree(dir, { [BILLING]: ts(`it("x", () => {}); it("черновик", () => {});`), "src/new.test.ts": ts(`it("вне", () => {});`) });
    const out = diffFrom(base, "--worktree").stdout;
    expect(out).toContain("**Добавлены (1):**\n\n- `tests/capabilities/billing` · черновик");
    expect(out).toContain("**Вне дерева `tests/`** изменены файлы тестов: `src/new.test.ts`.");
  });

  it("нет такой ревизии — код 2 и подсказка про fetch", () => {
    repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    const r = diffFrom("origin/nowhere");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("git fetch origin");
  });
});

describe("Изменённые тесты вне дерева видны по имени файла", () => {
  it("изменённый файл теста вне tests/ перечисляется по имени", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ "src/sum.test.ts": ts(`it("складывает", () => {});`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Вне дерева `tests/`** изменены файлы тестов: `src/sum.test.ts`.");
    expect(out).not.toContain("складывает");
  });

  it("tests/lib не участвует", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ "tests/lib/factory.test.ts": ts(`it("фабрика", () => {});`) });
    expect(diffFrom(base).stdout).toContain("Тесты не менялись.");
  });
});

/**
 * Проект, который переходит на тест-спек, переносит тесты в дерево: на базе их в `tests/` нет, и без сопоставления
 * каждый выглядел бы новым требованием, а PR с тысячами тестов не влез бы в тело PR. Тест, который на базе жил в
 * файле вне дерева и там исчез, а в дереве появился с той же цепочкой describe и именем, — перенесён.
 */
describe("Переезд тестов в дерево — сводкой по папкам, а не тысячами «добавлен»", () => {
  const SUM = ts(`describe("Сумма", () => { it("складывает", () => {}); it("вычитает", () => {}); });`);

  it("тест с тем же describe и именем из файла вне дерева — перенесён, а не добавлен; сводка по папкам", () => {
    const base = repo.commit({ "src/sum.test.ts": SUM, "e2e/login.spec.ts": ts(`it("входит", () => {});`) });
    repo.commit({
      "src/sum.test.ts": null,
      "e2e/login.spec.ts": null,
      "tests/capabilities/math/sum.test.ts": SUM,
      "tests/capabilities/auth/login.e2e.ts": ts(`it("входит", () => {});`),
    });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Добавлены:** нет.");
    expect(out).toContain(
      "**Перенесены в дерево (3):** названия те же, что вне `tests/` на базе; из 2 файлов.\n\n" +
        "- `tests/capabilities/auth` — 1 тест из 1 файла\n" +
        "- `tests/capabilities/math` — 2 теста из 1 файла\n",
    );
    expect(out).not.toContain("складывает");
    expect(out).not.toContain("Вне дерева");
  });

  it("тест, переименованный при переносе, — добавлен, а файл-источник — в списке вне дерева", () => {
    const base = repo.commit({ "src/sum.test.ts": SUM });
    repo.commit({
      "src/sum.test.ts": null,
      "tests/capabilities/math/sum.test.ts": ts(`describe("Сумма", () => { it("складывает", () => {}); it("вычитает числа", () => {}); });`),
    });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Перенесены в дерево (1):**");
    expect(out).toContain("**Добавлены (1):**\n\n- `tests/capabilities/math` · Сумма › вычитает числа");
    expect(out).toContain("**Вне дерева `tests/`** изменены файлы тестов: `src/sum.test.ts`.");
  });

  it("одинаковые тесты двух файлов, перенесённые в одну папку, — оба перенесены, файлы не по имени", () => {
    const same = ts(`describe("Расстояние", () => { it("пустое остаётся пустым", () => {}); });`);
    const base = repo.commit({ "src/a.test.ts": same, "src/b.test.ts": same });
    repo.commit({ "src/a.test.ts": null, "src/b.test.ts": null, "tests/capabilities/api/a.test.ts": same, "tests/capabilities/api/b.test.ts": same });
    const out = diffFrom(base).stdout;
    expect(out).toContain("- `tests/capabilities/api` — 2 теста из 2 файлов");
    expect(out).toContain("**Добавлены:** нет.");
    expect(out).not.toContain("Вне дерева");
  });

  // Сторож от перекоррекции: сопоставление берёт только тесты, исчезнувшие из файла вне дерева, иначе копия
  // спряталась бы под видом переноса.
  it("тест, оставшийся и вне дерева, — копия: в дереве он добавлен", () => {
    const base = repo.commit({ "src/sum.test.ts": SUM });
    repo.commit({ "src/sum.test.ts": SUM + "// тронут\n", "tests/capabilities/math/sum.test.ts": SUM });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Добавлены (2):**");
    expect(out).not.toContain("Перенесены");
    expect(out).toContain("**Вне дерева `tests/`** изменены файлы тестов: `src/sum.test.ts`.");
  });

  it("--worktree: перенос до коммита тоже сворачивается", () => {
    const base = repo.commit({ "src/sum.test.ts": SUM });
    repo.git("rm", "-q", "src/sum.test.ts");
    writeTree(dir, { "tests/capabilities/math/sum.test.ts": SUM });
    const out = diffFrom(base, "--worktree").stdout;
    expect(out).toContain("**Перенесены в дерево (2):**");
    expect(out).toContain("**Добавлены:** нет.");
    expect(out).not.toContain("Вне дерева");
  });
});

/**
 * Требования согласуют до кода: в задаче — раздел «## Сценарии» с будущими названиями тестов. PR сверяет их со своими
 * новыми тестами — что из обещанного сделано, что нет, и какие тесты появились сверх плана.
 */
describe("Сценарии задачи сверяются с тестами PR", () => {
  const ISSUE = [
    "## Контекст",
    "",
    "Счета.",
    "",
    "## Сценарии",
    "",
    "- выставляется за месяц",
    "- [ ] Счета › черновик удаляется.",
    "1. оплата картой",
    "",
    "## Вопросы",
    "",
    "- не сценарий",
    "",
  ].join("\n");

  it("сценарий, ставший тестом, — ✅ с папкой и названием; без теста — ❌; тест сверх сценариев — отдельным списком", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({
      [BILLING]: ts(`it("x", () => {}); describe("Счета", () => { it("выставляется за месяц", () => {}); it("черновик удаляется", () => {}); it("в валюте", () => {}); });`),
      "issue.md": ISSUE,
    });
    const out = diffFrom(base, "--scenarios", "issue.md").stdout;
    expect(out).toContain(
      [
        "### Сценарии задачи (3)",
        "",
        "- ✅ выставляется за месяц — `tests/capabilities/billing` · Счета › выставляется за месяц",
        "- ✅ Счета › черновик удаляется. — `tests/capabilities/billing` · Счета › черновик удаляется",
        "- ❌ оплата картой — теста нет",
        "",
        "**Тесты сверх сценариев (1):**",
        "",
        "- `tests/capabilities/billing` · Счета › в валюте",
      ].join("\n"),
    );
    expect(out).not.toContain("не сценарий");
  });

  // Сценарий пишут при создании задачи, тест — позже: регистр и точка в конце не должны ломать сверку
  it("сценарий совпадает с названием it или цепочкой «describe › it» — без учёта регистра и точки в конце", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); describe("Счета", () => { it("Выставляется за месяц", () => {}); });`), "issue.md": "## Сценарии\n\n- выставляется за месяц.\n" });
    expect(diffFrom(base, "--scenarios", "issue.md").stdout).toContain("- ✅ выставляется за месяц. — `tests/capabilities/billing` · Счета › Выставляется за месяц");
  });

  it("в задаче нет раздела «## Сценарии» — сверка говорит об этом, а не молчит", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); it("новое", () => {});`), "issue.md": "## Контекст\n\nбез сценариев\n" });
    expect(diffFrom(base, "--scenarios", "issue.md").stdout).toContain("### Сценарии задачи\n\nВ задаче нет раздела «## Сценарии» — сверять не с чем.");
  });
});

/**
 * Не каждое решение — название теста: модель архитектуры, исключения и реестры проверок живут в данных и в вызовах
 * харнесса. Их изменение — тоже изменение спеки, и ревьюер видит его в том же разделе PR.
 */
describe("Решения вне названий тестов — модель, исключения, проверки харнесса — видны в дельте спеки", () => {
  const MODEL = "tests/architecture/model.ts";
  const model = (modules: object) => `export default ${JSON.stringify({ modules })};\n`;

  it("модуль, зависимость и пакет модели архитектуры: добавленные и снятые", () => {
    const base = repo.commit({
      [MODEL]: model({ domain: { path: "src/domain", purpose: "x" }, infra: { path: "src/infra", purpose: "y", dependsOn: ["domain"], packages: ["pg"] } }),
    });
    repo.commit({
      [MODEL]: model({
        domain: { path: "src/domain", purpose: "x" },
        infra: { path: "src/infra", purpose: "y", packages: ["pg", "redis"] },
        ui: { path: "src/ui", purpose: "z", dependsOn: ["domain"] },
      }),
    });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Модель архитектуры — снято (1):**\n\n- зависимость infra → domain\n");
    expect(out).toContain("**Модель архитектуры — добавлено (3):**\n\n- модуль ui\n- зависимость ui → domain\n- пакет redis модуля infra\n");
  });

  it("исключение из exceptions.ts и отключение линта в коде: добавленные и снятые", () => {
    const EXC = "tests/standards/audit/exceptions.ts";
    const base = repo.commit({
      [EXC]: 'export default [{ item: "a", issue: 1, reason: "r1" }];\n',
      "src/a.ts": "// eslint-disable-next-line no-console -- #5 старое\nconsole.log(1);\n",
    });
    repo.commit({
      [EXC]: 'export default [{ item: "b", issue: 2, reason: "r2" }];\n',
      "src/a.ts": "console.log(1);\n",
      "src/b.ts": "// eslint-disable-next-line eqeqeq -- #6 новое\na == b;\n",
    });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Исключения — снято (2):**\n\n- `src/a.ts` · no-console — #5 старое\n- `tests/standards/audit` · a (#1) — r1\n");
    expect(out).toContain("**Исключения — добавлено (2):**\n\n- `src/b.ts` · eqeqeq — #6 новое\n- `tests/standards/audit` · b (#2) — r2\n");
  });

  // исключения названий пишет spec-doc --names-baseline, и схема у них другая — { file, name }, а не { item }
  const NAMES = "tests/standards/spec-names/exceptions.ts";
  const names = (list: object[]) => `export default ${JSON.stringify(list)};\n`;

  it("снятое исключение названия — с файлом теста и названием, без «undefined»", () => {
    const base = repo.commit({ [NAMES]: names([{ file: BILLING, name: "invoice total", issue: 7, reason: "переписать" }]) });
    repo.commit({ [NAMES]: names([]) });
    const out = diffFrom(base).stdout;
    expect(out).not.toContain("undefined");
    expect(out).toContain(`**Исключения — снято (1):**\n\n- \`tests/standards/spec-names\` · «invoice total» в \`${BILLING}\` (#7) — переписать\n`);
  });

  // у исключений baseline одна задача и одна причина на всех: разницу даёт только название
  it("снято N исключений названий — в разделе N строк", () => {
    const base = repo.commit({ [NAMES]: names(["a", "b", "c"].map((name) => ({ file: BILLING, name, issue: 7, reason: "переписать" }))) });
    repo.commit({ [NAMES]: names([]) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Исключения — снято (3):**");
    expect(out.match(/^- `tests\/standards\/spec-names` · /gm)).toHaveLength(3);
  });

  it("исключения одного элемента из разных соглашений папки — разные строки", () => {
    const EXC = "tests/standards/audit/exceptions.ts";
    const base = repo.commit({ [EXC]: names(["audit", "cancel"].map((rule) => ({ item: "a", issue: 1, reason: "r", rule }))) });
    repo.commit({ [EXC]: names([]) });
    expect(diffFrom(base).stdout).toContain("**Исключения — снято (2):**\n\n- `tests/standards/audit` · a (audit, #1) — r\n- `tests/standards/audit` · a (cancel, #1) — r\n");
  });

  it("снято одно из двух одинаковых отключений линта в файле — в разделе одна строка", () => {
    const off = "// eslint-disable-next-line no-console -- #5 отладка\nconsole.log(1);\n";
    const base = repo.commit({ "src/a.ts": off + off });
    repo.commit({ "src/a.ts": off + "export {};\n" });
    expect(diffFrom(base).stdout).toContain("**Исключения — снято (1):**\n\n- `src/a.ts` · no-console — #5 отладка\n");
  });

  it("реестр invariant и правило examples: добавленные и снятые", () => {
    const STD = "tests/standards/audit/audit.test.ts";
    const src = (registry: string, rule: string) =>
      ts(`it("x", () => {});\ninvariant(it, { registry: "${registry}", items: [] });\nexamples(it, { rule: "${rule}", bad: [] });`);
    const base = repo.commit({ [STD]: src("мутации", "no-console") });
    // значение с подстановкой — не литерал: реестр вычисляется, статически его не назвать
    repo.commit({ [STD]: src("мутации и команды", "eqeqeq") + 'examples(it, { rule: `${dynamic}`, bad: [] });\n' });
    const out = diffFrom(base).stdout;
    expect(out).not.toContain("${dynamic}");
    expect(out).toContain("**Проверки харнесса — снято (2):**\n\n- `tests/standards/audit` · правило no-console\n- `tests/standards/audit` · реестр «мутации»\n");
    expect(out).toContain("**Проверки харнесса — добавлено (2):**\n\n- `tests/standards/audit` · правило eqeqeq\n- `tests/standards/audit` · реестр «мутации и команды»\n");
  });

  it("без изменений модели, исключений и проверок — разделов нет", () => {
    const base = repo.commit({ [MODEL]: model({ domain: { path: "src/domain", purpose: "x" } }), [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); it("y", () => {});`) });
    const out = diffFrom(base).stdout;
    expect(out).not.toContain("Модель архитектуры");
    expect(out).not.toContain("Исключения");
    expect(out).not.toContain("Проверки харнесса");
  });
});

/**
 * Тесты, которые порождает харнесс (по элементу реестра, «не пуст», нарушитель, исключения), в исходниках не названы
 * — их видит только отчёт раннера. База для них — `tests.json` ветки `spec`, собранный из отчёта на SHA мержа.
 */
describe("Тесты харнесса — в диффе спеки: названия по отчёту, база — ветка spec", () => {
  const STD = "tests/standards/audit/audit.test.ts";
  const registry = ts(`import { invariant } from "../../../harness.ts";\ninvariant(it, { registry: "мутации", items, name: (m) => m + " пишет аудит" });`);
  const t = (name: string) => ({ path: STD, describes: [] as string[], name });

  // ветка spec как её пишет spec-publish: корень — docs/spec, в сообщении — Source: <sha исходника>
  function publishSpec(source: string, tests: object[]) {
    repo.git("checkout", "-q", "--orphan", "spec");
    repo.git("rm", "-rq", "--cached", ".");
    writeTree(dir, { "tests.json": JSON.stringify(tests) });
    repo.git("add", "tests.json");
    repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `spec: ${source.slice(0, 12)}\n\nSource: ${source}\n`);
    repo.git("checkout", "-q", "-f", "main");
  }
  const report = (names: string[]) => writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [STD]: names.map((n) => [[], n] as [string[], string]) }));

  it("тесты, которые порождает харнесс, видны в диффе спеки — новый элемент реестра добавлен, снятый удалён", () => {
    const base = repo.commit({ [STD]: registry });
    publishSpec(base, [t("a пишет аудит"), t("b пишет аудит")]);
    repo.commit({ [STD]: registry + "// реестр сменился\n" });
    report(["a пишет аудит", "импорт платежей из банка"]);
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("**Удалены (1):**\n\n- `tests/standards/audit` · b пишет аудит");
    expect(r.stdout).toContain("**Добавлены (1):**\n\n- `tests/standards/audit` · импорт платежей из банка");
  });

  it("перевод примеров на реестр не выглядит в диффе спеки как одни удаления", () => {
    const base = repo.commit({ [STD]: ts(`it("a пишет аудит", () => {});\nit("b пишет аудит", () => {});`) });
    publishSpec(base, [t("a пишет аудит"), t("b пишет аудит")]);
    repo.commit({ [STD]: registry });
    report(["a пишет аудит", "b пишет аудит", "реестр «мутации» не пуст", "нарушитель не проходит: без аудита"]);
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec");
    expect(r.stdout).toContain("**Удалены:** нет.");
    expect(r.stdout).toContain("**Добавлены (2):**");
    expect(r.stdout).toContain("нарушитель не проходит: без аудита");
  });

  // setup-проекты Playwright в tests/lib отчёт называет, а tests.json ветки spec — нет: без фильтра каждый PR
  // «добавлял» бы их заново
  it("служебные тесты tests/lib из отчёта — не спека и в дифф не попадают", () => {
    const base = repo.commit({ [STD]: registry });
    publishSpec(base, [t("a пишет аудит")]);
    repo.commit({ [STD]: registry + "// реестр сменился\n" });
    writeFileSync(
      path.join(dir, "r.json"),
      vitestReport(dir, { [STD]: [[[], "a пишет аудит"]], "tests/lib/e2e/auth.setup.ts": [[[], "authenticate"]] }),
    );
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Тесты не менялись.");
  });

  it("без базы в ветке spec — дифф по исходникам, и это сказано", () => {
    const base = repo.commit({ [STD]: ts(`it("a пишет аудит", () => {});`) });
    repo.commit({ [STD]: registry });
    report(["a пишет аудит"]);
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("в ветке spec нет tests.json для базы — дифф по исходникам, тестов харнесса в нём не видно");
    expect(r.stdout).toContain("**Удалены (1):**");
  });
});

describe("--json — то же для машины", () => {
  it("перенесённые — с исходным и новым путём", () => {
    const base = repo.commit({ "src/sum.test.ts": ts(`describe("Сумма", () => { it("складывает", () => {}); });`) });
    repo.commit({ "src/sum.test.ts": null, "tests/capabilities/math/sum.test.ts": ts(`describe("Сумма", () => { it("складывает", () => {}); });`) });
    const j = JSON.parse(diffFrom(base, "--json").stdout);
    expect(j.moved).toEqual([
      { from: "src/sum.test.ts", file: "tests/capabilities/math/sum.test.ts", folder: "tests/capabilities/math", describes: ["Сумма"], name: "складывает" },
    ]);
    expect(j.added).toEqual([]);
    expect(j.out_of_tree_files).toEqual([]);
  });

  it("машинный формат с тремя списками и файлами вне дерева", () => {
    const base = repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("старое", () => {}); });`) });
    repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("новое", () => {}); });`), "src/a.test.ts": ts(`it("вне", () => {});`) });
    const r = diffFrom(base, "--json");
    const j = JSON.parse(r.stdout);
    expect(j.removed).toEqual([{ file: BILLING, folder: "tests/capabilities/billing", describes: ["Счета"], name: "старое" }]);
    expect(j.added[0].name).toBe("новое");
    expect(j.changed).toEqual([]);
    expect(j.out_of_tree_files).toEqual(["src/a.test.ts"]);
  });
});
