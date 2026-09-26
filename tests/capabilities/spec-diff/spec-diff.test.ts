/**
 * Скрипт `spec-diff` скилла `spec`: ревьюер PR видит, какие требования PR снимает, меняет и добавляет, —
 * раздел «Спека (тесты)» для тела PR с названиями тестов.
 *
 * Дифф тестов — дифф требований: удалённый тест — снятое требование, и оно не должно пройти незамеченным среди
 * сотен строк кода. Названия берутся статическим разбором исходников на двух ревизиях — без прогона тестов, за
 * секунды и в CI без установки зависимостей.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { gitRepo, runScript, tmpDir, writeTree } from "../../lib/spec.ts";

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

  it("тест в tests/, но вне capabilities/standards — помечен «вне дерева»", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ "tests/unit/a.test.ts": ts(`it("сирота", () => {});`) });
    expect(diffFrom(base).stdout).toContain("- `tests/unit` · сирота ⚠️ вне дерева");
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
