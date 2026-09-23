import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runScript, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

function doc(reportName: string, content: string, ...args: string[]) {
  writeFileSync(path.join(dir, reportName), content);
  return runScript("spec-doc", [reportName, "--root", dir, ...args], dir);
}

describe("Отчёт Vitest", () => {
  it("describe становится подзаголовком, тест — строкой с ✅", () => {
    const r = doc("r.json", vitestReport(dir, { "tests/capabilities/billing/invoice.test.ts": [[["Счета"], "выставляется счёт за месяц"]] }), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("## Что делает система");
    expect(r.stdout).toContain("### billing");
    expect(r.stdout).toContain("#### Счета");
    expect(r.stdout).toContain("- ✅ выставляется счёт за месяц");
  });

  it("вложенный describe — заголовок на уровень глубже", () => {
    const r = doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[["Счета", "за неполный месяц"], "пропорционально дням"]] }), "--stdout");
    expect(r.stdout).toContain("#### Счета\n\n##### за неполный месяц\n\n- ✅ пропорционально дням");
  });

  it("пропущенный, упавший и todo помечены своим статусом", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [
          [[], "пропущен #12", "skipped"],
          [[], "падает", "failed"],
          [[], "потом", "todo"],
          [[], "ожидает", "pending"],
        ],
      }),
      "--stdout",
    );
    expect(r.stdout).toContain("- ⏭️ пропущен #12 — пропущен");
    expect(r.stdout).toContain("- ❌ падает — падает");
    expect(r.stdout).toContain("- 📝 потом — todo");
    expect(r.stdout).toContain("- ⏭️ ожидает — пропущен");
    expect(r.stdout).toContain("4 теста, 3 пропущено, 1 падает");
  });

  it("тест без describe идёт сразу под заголовком capability", () => {
    const r = doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "верхний"]] }), "--stdout");
    expect(r.stdout).toContain("`tests/capabilities/billing` · 1 тест\n\n- ✅ верхний");
  });

  it("абсолютный путь с другой машины приводится по сегменту /tests/", () => {
    const r = doc("r.json", vitestReport("/home/runner/work/repo/repo", { "tests/standards/audit/rule.test.ts": [[["Аудит"], "каждая мутация пишет запись"]] }), "--stdout");
    expect(r.stdout).toContain("## Как построена\n\n### audit");
    expect(r.stdout).not.toContain("Вне дерева");
  });

  it("описания из двух файлов одной capability сливаются в одно дерево", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/b.test.ts": [[["Счета"], "второй"]],
        "tests/capabilities/billing/a.test.ts": [[["Счета"], "первый"]],
      }),
      "--stdout",
    );
    expect(r.stdout.match(/#### Счета/g)).toHaveLength(1);
    expect(r.stdout.indexOf("первый")).toBeLessThan(r.stdout.indexOf("второй"));
  });
});

describe("Отчёт Playwright", () => {
  const report = (rootDir: string) =>
    JSON.stringify({
      config: { rootDir },
      suites: [
        {
          title: "tests/capabilities/login/login.e2e.ts",
          file: "tests/capabilities/login/login.e2e.ts",
          specs: [],
          suites: [
            {
              title: "Вход",
              file: "tests/capabilities/login/login.e2e.ts",
              specs: [
                { title: "по паролю", tests: [{ status: "expected", annotations: [] }, { status: "flaky", annotations: [] }] },
                {
                  title: "по SSO",
                  tests: [
                    { status: "skipped", annotations: [{ type: "skip", description: "#7 нет стенда" }] },
                    { status: "skipped", annotations: [{ type: "skip", description: "#7 нет стенда" }] },
                  ],
                },
                { title: "с капчей", tests: [{ status: "expected", annotations: [] }, { status: "unexpected", annotations: [] }] },
              ],
              suites: [],
            },
          ],
        },
      ],
    });

  it("причина skip — из аннотации, проекты сворачиваются в одну строку, худший статус побеждает", () => {
    const r = doc("pw.json", report(dir), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### login");
    expect(r.stdout).toContain("- ✅ по паролю");
    expect(r.stdout).toContain("- ⏭️ по SSO — пропущен: #7 нет стенда");
    expect(r.stdout).toContain("- ❌ с капчей — падает");
    expect(r.stdout.match(/по паролю/g)).toHaveLength(1);
  });
});

describe("Дерево tests/", () => {
  const report = () =>
    vitestReport(dir, {
      "tests/capabilities/billing/a.test.ts": [[[], "в дереве"]],
      "tests/lib/factories.test.ts": [[[], "фабрика"]],
      "src/utils/sum.test.ts": [[["sum"], "складывает"]],
      "tests/capabilities/stray.test.ts": [[[], "без папки"]],
    });

  it("tests/lib пропускается, тесты вне дерева — в раздел «Вне дерева»", () => {
    const r = doc("r.json", report(), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("фабрика");
    expect(r.stdout).toContain("## Вне дерева");
    expect(r.stdout).toContain("- `src/utils/sum.test.ts` — 1 тест");
    expect(r.stdout).toContain("- `tests/capabilities/stray.test.ts` — 1 тест");
    expect(r.stderr).toContain("вне дерева: 2 в 2 файлах");
  });

  it("--strict возвращает 1 при тестах вне дерева, без него — 0", () => {
    expect(doc("r.json", report(), "--stdout").code).toBe(0);
    expect(doc("r.json", report(), "--stdout", "--strict").code).toBe(1);
  });

  it("без тестов вне дерева раздела нет", () => {
    const r = doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "в дереве"]] }), "--stdout");
    expect(r.stdout).not.toContain("Вне дерева");
  });
});

describe("Файлы в docs/spec", () => {
  it("пишет README.md, capabilities/<name>.md и standards/<name>.md с маркером", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[["Счета"], "выставляется"]],
        "tests/standards/audit/rule.test.ts": [[[], "каждая мутация пишет аудит"]],
        "src/x.test.ts": [[[], "вне"]],
      }),
    );
    expect(r.code).toBe(0);
    const readme = readFileSync(path.join(dir, "docs/spec/README.md"), "utf8");
    expect(readme.startsWith("<!-- spec-doc:")).toBe(true);
    expect(readme).toContain("- [billing](capabilities/billing.md) — 1 тест");
    expect(readme).toContain("- [audit](standards/audit.md) — 1 тест");
    expect(readme).toContain("## Вне дерева\n\n");
    expect(readme).toContain("- `src/x.test.ts` — 1 тест");
    const billing = readFileSync(path.join(dir, "docs/spec/capabilities/billing.md"), "utf8");
    expect(billing).toContain("# billing\n\nЧто делает система · `tests/capabilities/billing` · 1 тест\n\n## Счета\n\n- ✅ выставляется");
    expect(readFileSync(path.join(dir, "docs/spec/standards/audit.md"), "utf8")).toContain("Как построена · `tests/standards/audit`");
  });

  it("удаляет свой устаревший файл и не трогает чужой", () => {
    writeTree(dir, {
      "docs/spec/capabilities/old.md": "<!-- spec-doc: сгенерировано из названий тестов, руками не править -->\n# old\n",
      "docs/spec/capabilities/manual.md": "# рукописный\n",
    });
    const r = doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "x"]] }));
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, "docs/spec/capabilities/old.md"))).toBe(false);
    expect(existsSync(path.join(dir, "docs/spec/capabilities/manual.md"))).toBe(true);
    expect(r.stderr).toContain("удалён устаревший");
  });

  it("--out задаёт каталог", () => {
    doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "x"]] }), "--out", "spec-out");
    expect(existsSync(path.join(dir, "spec-out/README.md"))).toBe(true);
  });
});

describe("Несколько отчётов", () => {
  it("одинаковый тест из двух отчётов — одна строка с худшим статусом", () => {
    writeFileSync(path.join(dir, "a.json"), vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "общий"]] }));
    writeFileSync(path.join(dir, "b.json"), vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "общий", "failed"]] }));
    const r = runScript("spec-doc", ["a.json", "b.json", "--root", dir, "--stdout"], dir);
    expect(r.stdout.match(/общий/g)).toHaveLength(1);
    expect(r.stdout).toContain("- ❌ общий — падает");
  });
});

describe("Ошибки", () => {
  it("неизвестный формат — код 2 и сообщение", () => {
    const r = doc("r.json", JSON.stringify({ foo: 1 }), "--stdout");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("неизвестный формат");
  });

  it("без отчётов — код 2 и подсказка", () => {
    const r = runScript("spec-doc", [], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("spec-doc.ts report.json");
  });
});

describe("Отчёт JUnit bun test", () => {
  const file = "tests/capabilities/probe/probe.test.ts";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6">
  <testsuite name="${file}" file="${file}" tests="6">
    <testcase name="верхний без describe" classname="" file="${file}" line="2" />
    <testsuite name="Внешний" file="${file}" line="3" tests="5">
      <testsuite name="Внутренний" file="${file}" line="4" tests="4">
        <testcase name="глубокий" classname="Внутренний &gt; Внешний" file="${file}" line="5" />
        <testcase name="пропущенный #12" classname="Внутренний &gt; Внешний" file="${file}" line="6">
          <skipped />
        </testcase>
        <testcase name="потом" classname="Внутренний &gt; Внешний" file="${file}" line="7">
          <skipped message="TODO" />
        </testcase>
        <testcase name="test_не питон [1]" classname="Внутренний &gt; Внешний" file="${file}" line="8">
          <failure message="x">trace</failure>
        </testcase>
      </testsuite>
      <testcase name="на первом уровне" classname="Внешний" file="${file}" line="9" />
    </testsuite>
  </testsuite>
</testsuites>`;

  it("describe — вложенные testsuite, todo и skip различаются", () => {
    const r = doc("bun.xml", xml, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### probe\n\nЧто делает система · `tests/capabilities/probe` · 6 тестов, 2 пропущено, 1 падает\n\n- ✅ верхний без describe\n\n#### Внешний\n\n- ✅ на первом уровне\n\n##### Внутренний\n\n- ✅ глубокий\n- ⏭️ пропущенный #12 — пропущен\n- 📝 потом — todo\n- ❌ test_не питон [1] — падает");
    expect(r.stdout).not.toContain("Вне дерева");
  });
});
