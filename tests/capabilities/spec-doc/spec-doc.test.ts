/**
 * Скрипт `spec-doc` скилла `spec`: документация `docs/spec` из отчётов раннеров — дерево `tests/`, названия
 * тестов и их JSDoc.
 *
 * Требование существует, пока есть проверяющий его тест, поэтому документацию о поведении не пишут руками: её
 * собирают из тестов, и разойтись с ними она не может. `docs/spec` коммитится вместе с PR, CI проверяет, что
 * она не отстала.
 */
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
  });

  it("тест без describe идёт сразу под заголовком capability, без строки с разделом, путём и счётчиком", () => {
    const r = doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "верхний"]] }), "--stdout");
    expect(r.stdout).toContain("### billing\n\n- ✅ верхний");
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

/** Название теста — текст, а не разметка: его куски не должны пропадать при показе на GitHub. */
describe("Названия в markdown", () => {
  it("`<` вне code span экранируется — `<type>` и `<!-- … -->` не пропадают как HTML, в code span — как есть", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, { "tests/capabilities/est/a.test.ts": [[["<type>/N-slug"], "маркер <!-- est {…} --> читается, `<x>` — как есть"]] }),
      "--stdout",
    );
    expect(r.stdout).toContain("#### \\<type>/N-slug\n");
    expect(r.stdout).toContain("- ✅ маркер \\<!-- est {…} --> читается, `<x>` — как есть\n");
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

/**
 * `tests/lib` — фабрики и хелперы, не спека. Тест вне `capabilities/<name>` и `standards/<name>` — без дома:
 * это сигнал перенести, а не ошибка разбора.
 */
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

/**
 * Маркер в первой строке отличает сгенерированный файл от рукописного: свои устаревшие файлы скрипт удаляет,
 * чужие не трогает.
 */
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
    expect(readme).toContain("## Что делает система\n\n- [billing](capabilities/billing.md)\n");
    expect(readme).toContain("## Как построена\n\n- [audit](standards/audit.md)\n");
    expect(readme).toContain("## Вне дерева\n\n");
    expect(readme).toContain("- `src/x.test.ts` — 1 тест");
    const billing = readFileSync(path.join(dir, "docs/spec/capabilities/billing.md"), "utf8");
    expect(billing).toContain("# billing\n\n## Счета\n\n- ✅ выставляется");
    expect(readFileSync(path.join(dir, "docs/spec/standards/audit.md"), "utf8")).toContain("# audit\n\n- ✅ каждая мутация пишет аудит");
  });

  it("в индексе у capability — только счётчики пропущенных и падающих, общего числа тестов нет", () => {
    doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[[], "ок"], [[], "потом", "todo"], [[], "сломан", "failed"]],
        "tests/capabilities/login/a.test.ts": [[[], "ок"]],
      }),
    );
    const readme = readFileSync(path.join(dir, "docs/spec/README.md"), "utf8");
    expect(readme).toContain("- [billing](capabilities/billing.md) — 1 пропущен, 1 падает\n");
    expect(readme).toContain("- [login](capabilities/login.md)\n");
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
    expect(r.stdout).toContain("### probe\n\n- ✅ верхний без describe\n\n#### Внешний\n\n- ✅ на первом уровне\n\n##### Внутренний\n\n- ✅ глубокий\n- ⏭️ пропущенный #12 — пропущен\n- 📝 потом — todo\n- ❌ test_не питон [1] — падает");
    expect(r.stdout).not.toContain("Вне дерева");
  });
});

/**
 * Отчёты раннеров комментариев не несут — прозу `spec-doc` берёт из исходников тестов тем же сканером, что
 * `spec-diff`. В документацию идёт только JSDoc; `//` — комментарий для читателя кода.
 */
describe("Проза из JSDoc", () => {
  const BILLING = "tests/capabilities/billing/invoice.test.ts";
  const report = () => vitestReport(dir, { [BILLING]: [[["Счета"], "выставляется за месяц"], [["Счета"], "черновик удаляется"]] });
  const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
  const body = `describe("Счета", () => { it("выставляется за месяц", () => {}); it("черновик удаляется", () => {}); });\n`;

  it("JSDoc в начале файла — абзацы под заголовком capability, первый — описание в индексе; теги не идут", () => {
    writeTree(dir, {
      [BILLING]: `/**\n * Биллинг: счета клиентам\n * за месяц.\n *\n * Второй абзац — только в файле capability.\n *\n * @see #12\n */\nimport { describe, it } from "bun:test";\n${body}`,
    });
    const r = doc("r.json", report());
    expect(r.code).toBe(0);
    expect(read("docs/spec/capabilities/billing.md")).toContain(
      "# billing\n\nБиллинг: счета клиентам\nза месяц.\n\nВторой абзац — только в файле capability.\n\n## Счета\n\n- ✅ выставляется за месяц",
    );
    expect(read("docs/spec/README.md")).toContain("- [billing](capabilities/billing.md) — Биллинг: счета клиентам за месяц.\n");
    expect(read("docs/spec/capabilities/billing.md")).not.toContain("@see");
  });

  it("JSDoc перед describe — абзац под подзаголовком, перед it — цитата под строкой теста", () => {
    writeTree(dir, {
      [BILLING]: `import { describe, it } from "bun:test";
/** Счёт — документ на оплату. */
describe("Счета", () => {
  /**
   * Месяц — календарный.
   *
   * Неполный — пропорционально дням.
   */
  it("выставляется за месяц", () => {});
  it("черновик удаляется", () => {});
});
`,
    });
    const r = doc("r.json", report(), "--stdout");
    expect(r.stdout).toContain(
      "#### Счета\n\nСчёт — документ на оплату.\n\n- ✅ выставляется за месяц\n  > Месяц — календарный.\n  >\n  > Неполный — пропорционально дням.\n- ✅ черновик удаляется\n",
    );
  });

  it("`//`-комментарий и JSDoc, отделённый от вызова кодом, в документацию не попадают", () => {
    writeTree(dir, {
      [BILLING]: `// комментарий файла
import { describe, it } from "bun:test";
// комментарий describe
describe("Счета", () => {
  /** про константу */
  const x = 1;
  it("выставляется за месяц", () => {});
  it("черновик удаляется", () => {});
});
`,
    });
    const out = doc("r.json", report(), "--stdout").stdout;
    expect(out).toContain("#### Счета\n\n- ✅ выставляется за месяц\n- ✅ черновик удаляется");
    expect(out).not.toContain("комментарий");
    expect(out).not.toContain("про константу");
  });

  it("JSDoc вплотную к describe в файле без импортов — проза describe, а не capability", () => {
    writeTree(dir, { [BILLING]: `/** Счёт — документ на оплату. */\n${body}` });
    const r = doc("r.json", report(), "--stdout");
    expect(r.stdout).toContain("### billing\n\n#### Счета\n\nСчёт — документ на оплату.\n\n- ✅ выставляется за месяц");
  });

  it("описание capability из двух файлов — абзацы по порядку путей, в индексе — первый", () => {
    writeTree(dir, {
      "tests/capabilities/billing/b.test.ts": `/** Второй файл. */\nimport { it } from "bun:test";\nit("b", () => {});\n`,
      "tests/capabilities/billing/a.test.ts": `/** Первый файл. */\nimport { it } from "bun:test";\nit("a", () => {});\n`,
    });
    doc("r.json", vitestReport(dir, { "tests/capabilities/billing/b.test.ts": [[[], "b"]], "tests/capabilities/billing/a.test.ts": [[[], "a"]] }));
    expect(read("docs/spec/capabilities/billing.md")).toContain("# billing\n\nПервый файл.\n\nВторой файл.\n\n- ✅ a\n- ✅ b");
    expect(read("docs/spec/README.md")).toContain("- [billing](capabilities/billing.md) — Первый файл.\n");
  });

  it("нет исходника (отчёт с другой машины) — документация без прозы, не ошибка", () => {
    const r = doc("r.json", report(), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### billing\n\n#### Счета\n\n- ✅ выставляется за месяц");
  });
});
