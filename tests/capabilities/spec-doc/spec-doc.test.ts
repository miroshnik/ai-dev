/**
 * Скрипт `spec-doc` скилла `spec`: документация `docs/spec` из тестов — страница на capability и стандарт,
 * которая читается рассказом: зачем, что умеет, чем проверено.
 *
 * Требование существует, пока есть проверяющий его тест, поэтому документацию о поведении не пишут руками: её
 * собирают из отчётов раннеров и JSDoc тестов, и с тестами она не расходится. `docs/spec` коммитится вместе с
 * PR, CI проверяет, что она не отстала.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

function doc(reportName: string, content: string, ...args: string[]) {
  writeFileSync(path.join(dir, reportName), content);
  return runScript("spec-doc", [reportName, "--root", dir, ...args], dir);
}

const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
// главный файл папки billing — в нём рассказ capability
const MAIN = "tests/capabilities/billing/billing.test.ts";
const BODY = `describe("Счета", () => { it("выставляется за месяц", () => {}); it("черновик удаляется", () => {}); });\n`;
const billing = () => vitestReport(dir, { [MAIN]: [[["Счета"], "выставляется за месяц"], [["Счета"], "черновик удаляется"]] });

/**
 * Зачем — шапка главного файла папки, что умеет — разделы из `describe`, чем проверено — тесты, свёрнутые под
 * разделом: доказательства не заслоняют рассказ.
 */
describe("Страница capability — рассказ: зачем, что умеет, чем проверено", () => {
  it("шапка главного файла `<name>.test.ts` — абзацы под заголовком, первый — описание в оглавлении", () => {
    writeTree(dir, {
      [MAIN]: `/**\n * Биллинг: счета клиентам\n * за месяц.\n *\n * Второй абзац — только на странице.\n */\nimport { describe, it } from "bun:test";\n${BODY}`,
    });
    const r = doc("r.json", billing());
    expect(r.code).toBe(0);
    expect(read("docs/spec/capabilities/billing.md")).toContain(
      "# billing\n\nБиллинг: счета клиентам\nза месяц.\n\nВторой абзац — только на странице.\n\n## Счета\n\n",
    );
    expect(read("docs/spec/README.md")).toContain("- [billing](capabilities/billing.md) — Биллинг: счета клиентам за месяц.\n");
  });

  it("describe — раздел с прозой из JSDoc, вложенный describe — на уровень глубже", () => {
    writeTree(dir, {
      [MAIN]: `import { describe, it } from "bun:test";
/** Счёт — документ на оплату. */
describe("Счета", () => {
  describe("за неполный месяц", () => { it("пропорционально дням", () => {}); });
});
`,
    });
    const r = doc("r.json", vitestReport(dir, { [MAIN]: [[["Счета", "за неполный месяц"], "пропорционально дням"]] }), "--stdout");
    expect(r.stdout).toContain(
      "### billing\n\n#### Счета\n\nСчёт — документ на оплату.\n\n##### за неполный месяц\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ пропорционально дням\n\n</details>",
    );
  });

  it("тесты раздела свёрнуты под счётчиком, JSDoc теста — цитата под его строкой", () => {
    writeTree(dir, {
      [MAIN]: `import { describe, it } from "bun:test";
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
    const r = doc("r.json", billing(), "--stdout");
    expect(r.stdout).toContain(
      "#### Счета\n\n<details><summary>✅ 2 теста</summary>\n\n- ✅ выставляется за месяц\n  > Месяц — календарный.\n  >\n  > Неполный — пропорционально дням.\n- ✅ черновик удаляется\n\n</details>\n",
    );
  });

  it("есть падающие или пропущенные — они в строке-заголовке, и блок раскрыт", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        [MAIN]: [
          [["Счета"], "выставляется"],
          [["Счета"], "в валюте #12", "skipped"],
          [["Счета"], "с НДС", "failed"],
          [["Оплата"], "картой"],
          [["Оплата"], "потом", "todo"],
        ],
      }),
      "--stdout",
    );
    expect(r.stdout).toContain("#### Счета\n\n<details open><summary>❌ 3 теста, 1 пропущен, 1 падает</summary>\n\n");
    expect(r.stdout).toContain("#### Оплата\n\n<details open><summary>⏭️ 2 теста, 1 пропущен</summary>\n\n");
  });

  it("тест без describe — сразу под заголовком capability", () => {
    const r = doc("r.json", vitestReport(dir, { [MAIN]: [[[], "верхний"]] }), "--stdout");
    expect(r.stdout).toContain("### billing\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ верхний\n\n</details>");
  });

  // Порядок рассказа задаёт автор главного файла; алфавит путей ставил бы первой случайную частность
  it("разделы — в порядке главного файла, остальные файлы — следом по пути", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[["Возврат"], "деньги возвращаются"], [["Оплата"], "частичная"]],
        [MAIN]: [[["Счета"], "выставляется"], [["Оплата"], "полная"]],
      }),
      "--stdout",
    );
    const at = (s: string) => r.stdout.indexOf(s);
    expect(at("#### Счета")).toBeLessThan(at("#### Оплата"));
    expect(at("#### Оплата")).toBeLessThan(at("#### Возврат"));
    expect(at("полная")).toBeLessThan(at("частичная"));
    expect(r.stdout.match(/#### Оплата/g)).toHaveLength(1);
  });

  it("один describe из нескольких файлов — один раздел, файлы по порядку путей", () => {
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

  it("у стандарта главный файл — rule.test.ts: его шапка и его тесты первыми", () => {
    writeTree(dir, {
      "tests/standards/audit/examples.test.ts": `/** Примеры. */\nimport { it } from "bun:test";\nit("пример", () => {});\n`,
      "tests/standards/audit/rule.test.ts": `/** Каждая мутация пишет аудит. */\nimport { it } from "bun:test";\nit("правило", () => {});\n`,
    });
    const r = doc(
      "r.json",
      vitestReport(dir, { "tests/standards/audit/examples.test.ts": [[[], "пример"]], "tests/standards/audit/rule.test.ts": [[[], "правило"]] }),
      "--stdout",
    );
    expect(r.stdout).toContain("### audit\n\nКаждая мутация пишет аудит.\n\n<details><summary>✅ 2 теста</summary>\n\n- ✅ правило\n- ✅ пример\n");
    expect(r.stdout).not.toContain("Примеры.");
  });
});

/**
 * Отчёты раннеров комментариев не несут — прозу `spec-doc` берёт из исходников тестов тем же сканером, что
 * `spec-diff`. JSDoc — для читателя спеки; причины решений, устройство теста и ссылки на задачи — `//`, для
 * читателя кода.
 */
describe("В документацию идёт только проза для читателя спеки", () => {
  // Шапки всех файлов подряд давали лоскутное одеяло заметок разработчику вместо рассказа (#63)
  it("шапка не в главном файле папки в документацию не идёт — spec-doc называет файл, --strict — код 1", () => {
    writeTree(dir, {
      "tests/capabilities/billing/a.test.ts": `/** Заметка разработчику: здесь чистая функция. */\nimport { it } from "bun:test";\nit("a", () => {});\n`,
      [MAIN]: `/** Биллинг: счета клиентам. */\nimport { it } from "bun:test";\nit("b", () => {});\n`,
    });
    const report = vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "a"]], [MAIN]: [[[], "b"]] });
    const r = doc("r.json", report, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### billing\n\nБиллинг: счета клиентам.\n\n<details>");
    expect(r.stdout).not.toContain("Заметка разработчику");
    expect(r.stderr).toContain("шапка вне главного файла billing.* — в документацию не идёт: tests/capabilities/billing/a.test.ts");
    expect(doc("r.json", report, "--stdout", "--strict").code).toBe(1);
  });

  it("`//`-комментарий, блочные теги JSDoc и JSDoc, отделённый от вызова кодом, в документацию не попадают", () => {
    writeTree(dir, {
      [MAIN]: `/**
 * Биллинг.
 *
 * @see #12
 */
// комментарий файла
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
    const out = doc("r.json", billing(), "--stdout").stdout;
    expect(out).toContain("### billing\n\nБиллинг.\n\n#### Счета\n\n<details><summary>✅ 2 теста</summary>\n\n- ✅ выставляется за месяц\n- ✅ черновик удаляется");
    expect(out).not.toContain("комментарий");
    expect(out).not.toContain("про константу");
    expect(out).not.toContain("@see");
  });

  it("JSDoc вплотную к describe в файле без импортов — проза describe, а не capability", () => {
    writeTree(dir, { [MAIN]: `/** Счёт — документ на оплату. */\n${BODY}` });
    const r = doc("r.json", billing(), "--stdout");
    expect(r.stdout).toContain("### billing\n\n#### Счета\n\nСчёт — документ на оплату.\n\n<details>");
  });

  it("нет исходника (отчёт с другой машины) — документация без прозы, не ошибка", () => {
    const r = doc("r.json", billing(), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### billing\n\n#### Счета\n\n<details><summary>✅ 2 теста</summary>");
  });
});

describe("Пропущенный и падающий тест видны — на странице и в оглавлении", () => {
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

  it("в оглавлении у capability — только счётчики пропущенных и падающих, общего числа тестов нет", () => {
    doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[[], "ок"], [[], "потом", "todo"], [[], "сломан", "failed"]],
        "tests/capabilities/login/a.test.ts": [[[], "ок"]],
      }),
    );
    const readme = read("docs/spec/README.md");
    expect(readme).toContain("- [billing](capabilities/billing.md) — 1 пропущен, 1 падает\n");
    expect(readme).toContain("- [login](capabilities/login.md)\n");
  });
});

describe("Отчёты Vitest, Playwright и bun test — в любом сочетании", () => {
  it("Vitest: абсолютный путь с другой машины приводится по сегменту /tests/", () => {
    const r = doc("r.json", vitestReport("/home/runner/work/repo/repo", { "tests/standards/audit/rule.test.ts": [[["Аудит"], "каждая мутация пишет запись"]] }), "--stdout");
    expect(r.stdout).toContain("## Как построена\n\n### audit\n\n#### Аудит\n\n");
    expect(r.stdout).not.toContain("Вне дерева");
  });

  it("Playwright: проекты сворачиваются в одну строку, причина skip — из аннотации, худший статус побеждает", () => {
    const report = JSON.stringify({
      config: { rootDir: dir },
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
    const r = doc("pw.json", report, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### login");
    expect(r.stdout).toContain("- ✅ по паролю");
    expect(r.stdout).toContain("- ⏭️ по SSO — пропущен: #7 нет стенда");
    expect(r.stdout).toContain("- ❌ с капчей — падает");
    expect(r.stdout.match(/по паролю/g)).toHaveLength(1);
  });

  it("bun test: describe — вложенные testsuite JUnit, todo и skip различаются", () => {
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
    const r = doc("bun.xml", xml, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "### probe\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ верхний без describe\n\n</details>\n\n#### Внешний\n\n" +
        "<details><summary>✅ 1 тест</summary>\n\n- ✅ на первом уровне\n\n</details>\n\n##### Внутренний\n\n" +
        "<details open><summary>❌ 4 теста, 2 пропущено, 1 падает</summary>\n\n" +
        "- ✅ глубокий\n- ⏭️ пропущенный #12 — пропущен\n- 📝 потом — todo\n- ❌ test_не питон [1] — падает\n\n</details>",
    );
    expect(r.stdout).not.toContain("Вне дерева");
  });

  it("одинаковый тест из двух отчётов — одна строка с худшим статусом", () => {
    writeFileSync(path.join(dir, "a.json"), vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "общий"]] }));
    writeFileSync(path.join(dir, "b.json"), vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "общий", "failed"]] }));
    const r = runScript("spec-doc", ["a.json", "b.json", "--root", dir, "--stdout"], dir);
    expect(r.stdout.match(/общий/g)).toHaveLength(1);
    expect(r.stdout).toContain("- ❌ общий — падает");
  });

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

/**
 * `tests/lib` — фабрики и хелперы, не спека. Тест вне `capabilities/<name>` и `standards/<name>` — без дома:
 * это сигнал перенести, а не ошибка разбора.
 */
describe("Оглавление: что делает система, как построена и что без дома", () => {
  const report = () =>
    vitestReport(dir, {
      "tests/capabilities/billing/a.test.ts": [[[], "в дереве"]],
      "tests/lib/factories.test.ts": [[[], "фабрика"]],
      "src/utils/sum.test.ts": [[["sum"], "складывает"]],
      "tests/capabilities/stray.test.ts": [[[], "без папки"]],
    });

  it("capability — в «Что делает система», стандарт — в «Как построена»", () => {
    doc("r.json", vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "x"]], "tests/standards/audit/rule.test.ts": [[[], "y"]] }));
    const readme = read("docs/spec/README.md");
    expect(readme).toContain("## Что делает система\n\n- [billing](capabilities/billing.md)\n");
    expect(readme).toContain("## Как построена\n\n- [audit](standards/audit.md)\n");
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
describe("docs/spec обновляется сам и не трогает рукописное", () => {
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
    const readme = read("docs/spec/README.md");
    expect(readme.startsWith("<!-- spec-doc:")).toBe(true);
    expect(readme).toContain("## Вне дерева\n\n");
    expect(readme).toContain("- `src/x.test.ts` — 1 тест");
    expect(read("docs/spec/capabilities/billing.md")).toStartWith("<!-- spec-doc:");
    expect(read("docs/spec/capabilities/billing.md")).toContain("# billing\n\n## Счета\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ выставляется");
    expect(read("docs/spec/standards/audit.md")).toContain("# audit\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ каждая мутация пишет аудит");
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

/** Название теста — текст, а не разметка: его куски не должны пропадать при показе на GitHub. */
describe("Названия — текст, а не разметка", () => {
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
