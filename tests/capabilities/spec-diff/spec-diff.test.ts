import { rmSync, writeFileSync } from "node:fs";
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

// ветка spec как её пишет spec-publish: корень — docs/spec, в сообщении — Source: <sha исходника>
function publishSpec(source: string, tests: object[]) {
  repo.git("checkout", "-q", "--orphan", "spec");
  repo.git("rm", "-rq", "--cached", ".");
  writeTree(dir, { "tests.json": JSON.stringify(tests) });
  repo.git("add", "tests.json");
  repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `spec: ${source.slice(0, 12)}\n\nSource: ${source}\n`);
  repo.git("checkout", "-q", "-f", "main");
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
 * именем под другим describe — в любом файле папки; тест с тем же телом — в том же файле, даже если сменились и
 * describe, и имя. Порог высокий: спрятать снятое требование под видом переименования хуже, чем показать
 * переименование как удаление и добавление.
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

  // так выглядит перевод названий в утверждения с перекладкой по разделам: проверка та же, слова другие
  it("тест с новыми describe и it и тем же телом — переименование", () => {
    const base = repo.commit({ [BILLING]: ts(`describe("Счета", () => { it("total", () => { expect(total([1, 2])).toBe(3); }); });`) });
    repo.commit({ [BILLING]: ts(`describe("Сумма счёта", () => {\n  it("складывает позиции", () => {\n    expect(total([1, 2])).toBe(3);\n  });\n});`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Изменены (1):**\n\n- `tests/capabilities/billing` · ~~Счета › total~~ → Сумма счёта › складывает позиции\n");
    expect(out).toContain("**Удалены:** нет.");
  });

  it("одинаковое тело у нескольких тестов файла — не переименование, а удалён и добавлен", () => {
    const check = "{ expect(ok()).toBe(true); }";
    const base = repo.commit({ [BILLING]: ts(`it("a", () => ${check}); it("b", () => ${check});`) });
    repo.commit({ [BILLING]: ts(`describe("Раздел", () => { it("первое утверждение", () => ${check}); it("второе утверждение", () => ${check}); });`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Удалены (2):**");
    expect(out).toContain("**Изменены:** нет.");
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
 * Название, которое не вычислить без прогона (шаблон с подстановкой, переменная), в списки не идёт: с названием из
 * отчёта оно не совпало бы. Но тест не пропадает молча — место и выражение строкой в stderr; с `--report` он виден
 * под настоящим названием. Файл, который не разобрать, — так же, с местом ошибки.
 */
describe("Тест, которого не видно статически, назван в stderr — не пропадает молча", () => {
  it("название, которое не вычислить статически (шаблон с подстановкой, переменная), — строкой в stderr с местом, один раз на базу и голову", () => {
    const dynamic = "it(`ставка ${rate}%`, () => {});";
    const base = repo.commit({ [BILLING]: ts(`${dynamic}\nit("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`${dynamic}\nit("x", () => {}); it("y", () => {});`) });
    const r = diffFrom(base);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("**Добавлены (1):**\n\n- `tests/capabilities/billing` · y");
    expect(r.stderr.split("\n").filter((l) => l.includes("не вычислить"))).toEqual([
      `spec-diff: ${base}: ${BILLING}:2: название it не вычислить статически (\`ставка \${rate}%\`) — теста нет в списке`,
    ]);
  });

  it("файл теста, который не разобрать, spec-diff называет в stderr с местом ошибки", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {`) });
    expect(diffFrom(base).stderr).toContain(`spec-diff: HEAD: ${BILLING}: не разобран: Unexpected token (3:0)`);
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

  // сценарии в задачах пишут цитатой со знаком после неё — «…»; — и тест того же названия не находился (#196)
  it("сценарий в кавычках-ёлочках с точкой с запятой после них совпадает с тестом того же названия", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    const tests = ["выставляется за месяц", "черновик удаляется", "оплата картой", "в валюте", "метка `billing` ставится"].map((n) => `it(${JSON.stringify(n)}, () => {});`).join(" ");
    const issue = "## Сценарии\n\n- «выставляется за месяц»;\n- «черновик удаляется».\n- \"оплата картой\",\n- `в валюте`\n- «метка `billing` ставится»\n";
    repo.commit({ [BILLING]: ts(`it("x", () => {}); ${tests}`), "issue.md": issue });
    const out = diffFrom(base, "--scenarios", "issue.md").stdout;
    expect(out).toContain("- ✅ «выставляется за месяц»; — `tests/capabilities/billing` · выставляется за месяц");
    expect(out).toContain("- ✅ «черновик удаляется». — `tests/capabilities/billing` · черновик удаляется");
    expect(out).toContain('- ✅ "оплата картой", — `tests/capabilities/billing` · оплата картой');
    expect(out).toContain("- ✅ `в валюте` — `tests/capabilities/billing` · в валюте");
    expect(out).toContain("- ✅ «метка `billing` ставится» — `tests/capabilities/billing` · метка `billing` ставится");
    expect(out).not.toContain("Тесты сверх сценариев");
  });

  it("в задаче нет раздела «## Сценарии» — сверка говорит об этом, а не молчит", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); it("новое", () => {});`), "issue.md": "## Контекст\n\nбез сценариев\n" });
    expect(diffFrom(base, "--scenarios", "issue.md").stdout).toContain("### Сценарии задачи\n\nВ задаче нет раздела «## Сценарии» — сверять не с чем.");
  });
});

/**
 * Стандарт «реестр + инвариант» называет соглашение в `describe` («каждая мутация пишет аудит»), а тесты внутри
 * порождает харнесс по элементам реестра. Сценарий такого стандарта — название `describe`: он сверяется с ним по
 * исходникам, без прогона, и держится проверкой харнесса, а не одним тестом.
 */
describe("Сценарий стандарта «реестр + инвариант» — describe проверки харнесса", () => {
  const STD = "tests/standards/audit/audit.test.ts";
  const audit = (registry: string) =>
    ts(
      `import { examples, invariant } from "../../../harness.ts";\n` +
        `describe("каждая мутация пишет аудит", () => { invariant(it, { registry: "${registry}", items, name: (m) => m + " пишет аудит" }); });\n` +
        `describe("Логи", () => { describe("console запрещён", () => { examples(it, { rule: "no-console", bad: [] }); }); });`,
    );
  const ISSUE = "## Сценарии\n\n- Каждая мутация пишет аудит.\n- Логи › console запрещён\n";
  const AUDIT_LINE = "- ✅ Каждая мутация пишет аудит. — `tests/standards/audit` · каждая мутация пишет аудит — проверка харнесса: реестр «мутации»";

  it("сценарий совпадает с describe, в котором вызван invariant", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [STD]: audit("мутации"), "issue.md": ISSUE });
    const out = diffFrom(base, "--scenarios", "issue.md").stdout;
    expect(out).toContain(
      [
        "### Сценарии задачи (2)",
        "",
        AUDIT_LINE,
        "- ✅ Логи › console запрещён — `tests/standards/audit` · Логи › console запрещён — проверка харнесса: правило no-console",
      ].join("\n"),
    );
    expect(out).not.toContain("Тесты сверх сценариев");
    const j = JSON.parse(diffFrom(base, "--scenarios", "issue.md", "--json").stdout);
    expect(j.scenarios[0]).toEqual({
      scenario: "Каждая мутация пишет аудит.",
      test: null,
      harness: { folder: "tests/standards/audit", describes: ["каждая мутация пишет аудит"], checks: ["реестр «мутации»"] },
    });
  });

  // CI передаёт отчёт всегда, а ветки spec в новом проекте ещё нет: тестов харнесса дифф не видит, сценарий — видит
  it("сценарий стандарта сверяется без отчёта раннера", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [STD]: audit("мутации"), "issue.md": ISSUE });
    writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [STD]: [[["каждая мутация пишет аудит"], "a пишет аудит"]] }));
    for (const args of [[], ["--report", "r.json", "--spec-branch", "spec"]]) {
      const out = diffFrom(base, ...args, "--scenarios", "issue.md").stdout;
      expect(out).toContain(AUDIT_LINE);
      expect(out).not.toContain("❌");
    }
  });

  it("тесты, порождённые проверкой харнесса, — тесты её сценария, а не сверх сценариев", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    publishSpec(base, [{ path: BILLING, describes: [], name: "x" }]);
    repo.commit({ [STD]: audit("мутации") + `describe("каждая мутация пишет аудит", () => { it("журнал хранится год", () => {}); });\n`, "issue.md": ISSUE });
    const names: [string[], string][] = [
      [["каждая мутация пишет аудит"], "a пишет аудит"],
      [["каждая мутация пишет аудит"], "реестр «мутации» не пуст"],
      [["каждая мутация пишет аудит"], "журнал хранится год"],
      [["Логи", "console запрещён"], "нельзя: console.log"],
    ];
    writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [STD]: names }));
    const out = diffFrom(base, "--report", "r.json", "--spec-branch", "spec", "--scenarios", "issue.md").stdout;
    expect(out).toContain("**Добавлены (4):**");
    expect(out).toContain(AUDIT_LINE);
    // тест, написанный руками, — своё требование, даже внутри describe проверки
    expect(out).toContain("**Тесты сверх сценариев (1):**\n\n- `tests/standards/audit` · каждая мутация пишет аудит › журнал хранится год");
  });

  // как с тестами: сценарий закрывает то, что PR добавил или переименовал, а не то, что уже было
  it("describe проверки харнесса, которого PR не менял, сценария не закрывает; сменился реестр — закрывает", () => {
    const base = repo.commit({ [STD]: audit("мутации") });
    repo.commit({ [STD]: audit("мутации") + "// проверка элемента строже\n", "issue.md": ISSUE });
    expect(diffFrom(base, "--scenarios", "issue.md").stdout).toContain("- ❌ Каждая мутация пишет аудит. — теста нет");
    repo.commit({ [STD]: audit("мутации и команды") });
    expect(diffFrom(base, "--scenarios", "issue.md").stdout).toContain("- ✅ Каждая мутация пишет аудит. — `tests/standards/audit` · каждая мутация пишет аудит — проверка харнесса: реестр «мутации и команды»");
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

  it("исключение файлом в exceptions/: добавленное и снятое", () => {
    const DIR = "tests/standards/audit/exceptions";
    const one = (item: string, issue: number, reason: string, rule?: string) => JSON.stringify({ item, ...(rule ? { rule } : {}), issue, reason }) + "\n";
    const base = repo.commit({ [`${DIR}/a.json`]: one("a", 1, "r1"), [`${DIR}/c.json`]: one("c", 3, "r3") });
    repo.commit({ [`${DIR}/a.json`]: null, [`${DIR}/audit--b.json`]: one("b", 2, "r2", "audit") });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Исключения — снято (1):**\n\n- `tests/standards/audit` · a (#1) — r1\n");
    expect(out).toContain("**Исключения — добавлено (1):**\n\n- `tests/standards/audit` · b (audit, #2) — r2\n");
  });

  // перенос spec-exceptions — не снятие и не добавление: то же исключение в другом файле
  it("перенос exceptions.ts в каталог — раздела «Исключения» нет", () => {
    const base = repo.commit({ "tests/standards/audit/exceptions.ts": 'export default [{ item: "a", issue: 1, reason: "r1" }];\n' });
    repo.commit({ "tests/standards/audit/exceptions.ts": null, "tests/standards/audit/exceptions/a.json": JSON.stringify({ item: "a", issue: 1, reason: "r1" }) + "\n" });
    expect(diffFrom(base).stdout).not.toContain("**Исключения");
  });

  // прежний файл подпапки — исключения папки решения (правило exceptionFile): перенос в её каталог — то же исключение
  it("перенос exceptions.ts подпапки в каталог папки решения — раздела «Исключения» нет", () => {
    const base = repo.commit({ "tests/standards/audit/sub/exceptions.ts": 'export default [{ item: "a", issue: 1, reason: "r1" }];\n' });
    repo.commit({ "tests/standards/audit/sub/exceptions.ts": null, "tests/standards/audit/exceptions/a.json": JSON.stringify({ item: "a", issue: 1, reason: "r1" }) + "\n" });
    expect(diffFrom(base).stdout).not.toContain("**Исключения");
  });

  // файл не на месте исключением не читается — харнесс на нём падает, а в теле PR его нет
  it("файл исключения не на месте — каталог в подпапке, не JSON — в разделе «Исключения» не показан", () => {
    const base = repo.commit({ "tests/standards/audit/exceptions/a.json": JSON.stringify({ item: "a", issue: 1, reason: "r1" }) + "\n" });
    repo.commit({
      "tests/standards/audit/sub/exceptions/b.json": JSON.stringify({ item: "b", issue: 2, reason: "r2" }) + "\n",
      "tests/standards/audit/exceptions/c.txt": JSON.stringify({ item: "c", issue: 3, reason: "r3" }) + "\n",
    });
    expect(diffFrom(base).stdout).not.toContain("**Исключения");
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

  it("снятое исключение названия из папки решения — в разделе «Исключения»", () => {
    const FOLDER = "tests/capabilities/billing/names.exceptions.ts";
    const base = repo.commit({ [FOLDER]: names([{ file: BILLING, name: "returns 201", issue: 7, reason: "переписать" }]) });
    repo.commit({ [FOLDER]: names([]) });
    expect(diffFrom(base).stdout).toContain(`**Исключения — снято (1):**\n\n- \`tests/capabilities/billing\` · «returns 201» в \`${BILLING}\` (#7) — переписать\n`);
  });

  it("spec-diff: исключение названия файлом в `names.exceptions/` — добавленное и снятое", () => {
    const DIR = "tests/capabilities/billing/names.exceptions";
    const one = (name: string, issue: number) => JSON.stringify({ file: BILLING, name, issue, reason: "переписать" }, null, 2) + "\n";
    const base = repo.commit({ [`${DIR}/returns-201.json`]: one("returns 201", 7), [`${DIR}/returns-404.json`]: one("returns 404", 7) });
    repo.commit({ [`${DIR}/returns-201.json`]: null, [`${DIR}/createInvoice.json`]: one("createInvoice", 8) });
    const out = diffFrom(base).stdout;
    expect(out).toContain(`**Исключения — снято (1):**\n\n- \`tests/capabilities/billing\` · «returns 201» в \`${BILLING}\` (#7) — переписать\n`);
    expect(out).toContain(`**Исключения — добавлено (1):**\n\n- \`tests/capabilities/billing\` · «createInvoice» в \`${BILLING}\` (#8) — переписать\n`);
  });

  // перенос spec-exceptions — то же исключение в другом файле, не снятие и не добавление
  it("перенос `names.exceptions.ts` в каталог — раздела «Исключения» нет", () => {
    const FOLDER = "tests/capabilities/billing/names.exceptions.ts";
    const x = { file: BILLING, name: "returns 201", issue: 7, reason: "переписать" };
    const base = repo.commit({ [FOLDER]: names([x]) });
    repo.commit({ [FOLDER]: null, "tests/capabilities/billing/names.exceptions/returns-201.json": JSON.stringify(x, null, 2) + "\n" });
    expect(diffFrom(base).stdout).not.toContain("**Исключения");
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

  it("добавленная строка с «eslint-disable» в литерале — раздела «Исключения» нет", () => {
    const base = repo.commit({ "src/a.ts": "export const a = 1;\n" });
    repo.commit({ "src/a.ts": 'export const a = 1;\nexport const fixture = "// eslint-disable-next-line no-console -- #5 отладка";\n' });
    expect(diffFrom(base).stdout).not.toContain("Исключения");
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

  it("реестр и правило в комментарии или строке spec-diff проверкой не считает", () => {
    const STD = "tests/standards/audit/audit.test.ts";
    const base = repo.commit({ [STD]: ts(`it("x", () => {});`) });
    repo.commit({
      [STD]: ts(
        `it("x", () => {});\n// invariant(it, { registry: "мутации" })\n/* examples(it, { rule: "no-console" }) */\n` +
          `const fixture = 'invariant(it, { registry: "мутации" }); examples(it, { rule: "no-console" });';\n` +
          "const tpl = `examples(it, { rule: \"eqeqeq\" })`;",
      ),
    });
    expect(diffFrom(base).stdout).not.toContain("Проверки харнесса");
  });

  it("значение с подстановкой `${…}` — не литерал: реестр не назван, как сейчас", () => {
    const STD = "tests/standards/audit/audit.test.ts";
    const base = repo.commit({ [STD]: ts(`it("x", () => {});`) });
    repo.commit({ [STD]: ts('it("x", () => {});\ninvariant(it, { registry: `мутации ${kind}`, items: [] });\nh.examples(it, { "rule": "no-" + "console", bad: [] });') });
    const out = diffFrom(base).stdout;
    expect(out).not.toContain("мутации");
    // сложение строк известно без прогона, ключ в кавычках и вызов через объект — те же опции
    expect(out).toContain("**Проверки харнесса — добавлено (1):**\n\n- `tests/standards/audit` · правило no-console\n");
  });

  it("`rule` инварианта (соглашение папки) правилом линтера не считается", () => {
    const STD = "tests/standards/audit/audit.test.ts";
    const base = repo.commit({ [STD]: ts(`it("x", () => {});`) });
    repo.commit({ [STD]: ts(`it("x", () => {});\ninvariant(it, { rule: "audit", registry: "формы", items: [] });`) });
    const out = diffFrom(base).stdout;
    expect(out).toContain("**Проверки харнесса — добавлено (1):**\n\n- `tests/standards/audit` · реестр «формы»\n");
    expect(out).not.toContain("правило audit");
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
    expect(r.stdout).toContain(`\n\n_Тесты харнесса — по отчёту; база — ветка spec (исходник ${base.slice(0, 12)})._\n`);
  });

  // публикация на мерж отставшего PR пропускается: ближайшая публикация-предок — до чужих PR, влитых после неё
  it("публикация в ветке spec старше базы диффа — под «База» названы оба коммита и сказано, что в списках возможны тесты уже влитых PR", () => {
    const published = repo.commit({ [STD]: registry });
    publishSpec(published, [t("a пишет аудит")]);
    const base = repo.commit({ [STD]: registry + "// чужой PR добавил b, его публикация пропущена\n" });
    repo.commit({ [STD]: registry + "// реестр сменился\n" });
    report(["a пишет аудит", "b пишет аудит", "c пишет аудит"]);
    const note = `_Тесты харнесса — по отчёту; база — ветка spec (исходник ${published.slice(0, 12)} старше базы диффа ${base.slice(0, 12)}: в списках возможны тесты PR, влитых между ними)._`;
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`_База: \`${base} (merge-base)\`._\n\n${note}\n`);
    // база — имя ветки, а не SHA: сравнивается коммит, а не написание
    repo.git("branch", "base", base);
    expect(diffFrom("base", "--no-merge-base", "--report", "r.json", "--spec-branch", "spec").stdout).toContain(note);
  });

  // ветку spec пишет сам spec-publish: мерж без изменений спеки он подтверждает новым `Source:` — иначе строка о
  // разрыве шла бы после каждого такого мержа и настоящий пропуск публикации в ней бы не читался
  it("мерж не менял спеку, публикация подтверждена — под «База» разрыва нет", () => {
    const origin = tmpDir();
    try {
      repo.git("init", "-q", "--bare", origin.dir);
      repo.git("remote", "add", "origin", origin.dir);
      repo.commit({ [STD]: registry, ".gitignore": "docs/spec/\n" });
      writeTree(dir, { "docs/spec/tests.json": JSON.stringify([t("a пишет аудит")]) });
      expect(runScript("spec-publish", [], dir).code).toBe(0);
      const base = repo.commit({ "src/app.ts": "export const a = 1;\n" }, "мерж без изменений спеки");
      expect(runScript("spec-publish", [], dir).code).toBe(0);
      repo.commit({ [STD]: registry + "// реестр сменился\n" });
      report(["a пишет аудит", "c пишет аудит"]);
      const r = diffFrom(base, "--report", "r.json", "--spec-branch", "origin/spec");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`_База: \`${base} (merge-base)\`._\n\n_Тесты харнесса — по отчёту; база — ветка origin/spec (исходник ${base.slice(0, 12)})._\n`);
      expect(r.stdout).toContain("**Добавлены (1):**\n\n- `tests/standards/audit` · c пишет аудит");
    } finally {
      origin.cleanup();
    }
  });

  // `Source:` разбирают два скрипта — spec-publish (гард «уже новее») и spec-diff: выражение у них одно (speclib)
  it("в репозитории с SHA-256 публикация находится по Source: из 64 знаков", () => {
    rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    repo.git("init", "-q", "-b", "main", "--object-format=sha256");
    const base = repo.commit({ [STD]: registry });
    expect(base).toHaveLength(64);
    publishSpec(base, [t("a пишет аудит")]);
    repo.commit({ [STD]: registry + "// реестр сменился\n" });
    report(["a пишет аудит", "c пишет аудит"]);
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`\n\n_Тесты харнесса — по отчёту; база — ветка spec (исходник ${base.slice(0, 12)})._\n`);
    expect(r.stdout).toContain("**Добавлены (1):**\n\n- `tests/standards/audit` · c пишет аудит");
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

  it("в сводке по папкам видно, сколько тестов порождено харнессом", () => {
    const base = repo.commit({ [STD]: registry });
    publishSpec(base, [t("a пишет аудит")]);
    repo.commit({ [STD]: registry + 'it("журнал хранится год", () => { expect(1).toBe(1); });\n' });
    report(["a пишет аудит", "b пишет аудит", "журнал хранится год"]);
    const r = diffFrom(base, "--report", "r.json", "--spec-branch", "spec", "--limit", "1");
    expect(r.stdout).toContain("| Папка | Удалены | Изменены | Добавлены | Из них харнесса |");
    expect(r.stdout).toContain("| `tests/standards/audit` | 0 | 0 | 2 | 1 |");
  });
});

/**
 * Перенос спеки даёт тысячи названий: в теле PR — сводка по папкам, полный список — в summary джоба CI (`--full`).
 * Порог — по числу тестов в списках, `--limit`; разделы решений (модель, исключения, проверки) выше порога — число
 * на папку или файл.
 */
describe("Большой PR — сводка по папкам, полный список — в summary джоба", () => {
  const MATH = "tests/capabilities/math/sum.test.ts";

  it("дифф выше порога — сводка по папкам, а не список названий", () => {
    const base = repo.commit({ [MATH]: ts(`describe("Сумма", () => { it("складывает", () => {}); });`) });
    repo.commit({
      [MATH]: ts(`describe("Сумма", () => { it("складывает числа", () => {}); });`),
      [BILLING]: ts(`it("выставляется", () => {}); it("отправляется", () => {}); it("оплачивается", () => {});`),
    });
    const out = diffFrom(base, "--limit", "3").stdout;
    expect(out).toContain("**Сводка по папкам** — 4 теста, больше порога 3: полный список — `spec-diff --full` (в CI — summary джоба).");
    expect(out).toContain(
      ["| Папка | Удалены | Изменены | Добавлены |", "|---|--:|--:|--:|", "| `tests/capabilities/billing` | 0 | 0 | 3 |", "| `tests/capabilities/math` | 0 | 1 | 0 |", "| **Всего** | 0 | 1 | 3 |"].join("\n"),
    );
    expect(out).not.toContain("выставляется");
    expect(out).not.toContain("складывает");
  });

  it("удалённые при сводке — списком: снятое требование видно поимённо", () => {
    const base = repo.commit({ [BILLING]: ts(`it("снято", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("выставляется", () => {}); it("отправляется", () => {}); it("оплачивается", () => {});`) });
    const out = diffFrom(base, "--limit", "3").stdout;
    expect(out).toContain("**Удалены (1):**\n\n- `tests/capabilities/billing` · снято\n");
    expect(out).toContain("| `tests/capabilities/billing` | 1 | 0 | 3 |");
    expect(out).not.toContain("выставляется");
  });

  it("удалённых больше порога — сводкой и они", () => {
    const base = repo.commit({ [BILLING]: ts(`it("первое", () => {}); it("второе", () => {}); it("третье", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    const out = diffFrom(base, "--limit", "2").stdout;
    expect(out).toContain("| `tests/capabilities/billing` | 3 | 0 | 1 |");
    expect(out).not.toContain("первое");
  });

  it("--full — полный список при любом размере", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    repo.commit({ [BILLING]: ts(`it("x", () => {}); it("выставляется", () => {}); it("отправляется", () => {});`) });
    const out = diffFrom(base, "--limit", "1", "--full").stdout;
    expect(out).not.toContain("Сводка по папкам");
    expect(out).toContain("**Добавлены (2):**\n\n- `tests/capabilities/billing` · выставляется\n- `tests/capabilities/billing` · отправляется");
  });

  it("решения выше порога — число на папку, а не список", () => {
    const NAMES = "tests/standards/spec-names/exceptions.ts";
    const list = ["a", "b", "c"].map((name) => ({ file: BILLING, name, issue: 7, reason: "переписать" }));
    const base = repo.commit({ [NAMES]: `export default ${JSON.stringify(list)};\n` });
    repo.commit({ [NAMES]: "export default [];\n" });
    const out = diffFrom(base, "--limit", "2").stdout;
    expect(out).toContain("**Исключения — снято (3), сводкой:**\n\n- `tests/standards/spec-names` — 3\n");
    expect(out).not.toContain("«a»");
  });

  it("порог — целое число больше нуля, иначе ошибка запуска", () => {
    const base = repo.commit({ [BILLING]: ts(`it("x", () => {});`) });
    const r = diffFrom(base, "--limit", "много");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--limit");
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
