import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, SCRIPTS, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

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
 * Зачем — описание `<папка>.md` рядом с тестами, что умеет — разделы из `describe`, чем проверено — тесты,
 * свёрнутые под разделом: доказательства не заслоняют рассказ.
 */
describe("Страница capability, правила архитектуры или стандарта — рассказ: зачем, что умеет, чем проверено", () => {
  it("описание `<папка>.md` — абзацы под заголовком, первый — описание в оглавлении", () => {
    writeTree(dir, {
      "tests/capabilities/billing/billing.md": "Биллинг: счета клиентам\nза месяц.\n\nВторой абзац — только на странице.\n",
      [MAIN]: `import { describe, it } from "bun:test";\n${BODY}`,
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

  // `<name>.e2e.ts` по алфавиту раньше `<name>.test.ts`: без тай-брейка e2e открывал бы страницу раньше юнитов (#191)
  it("при `<name>.e2e.ts` и `<name>.test.ts` страницу решения открывают утверждения юнит-теста", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[["Возврат"], "деньги возвращаются"]],
        "tests/capabilities/billing/billing.e2e.ts": [[["Оплата"], "картой в браузере"]],
        [MAIN]: [[["Счета"], "выставляется"], [["Оплата"], "полная"]],
      }),
      "--stdout",
    );
    const at = (s: string) => r.stdout.indexOf(s);
    expect(at("#### Счета")).toBeLessThan(at("#### Оплата"));
    expect(at("#### Оплата")).toBeLessThan(at("#### Возврат"));
    // e2e главного имени — следом за юнитами, раньше остальных файлов папки
    expect(at("полная")).toBeLessThan(at("картой в браузере"));
    expect(at("картой в браузере")).toBeLessThan(at("деньги возвращаются"));
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

  // Одно правило для всех видов вместо «у стандарта — rule.test.ts»: главный файл находится по имени папки (#72)
  it("у правила архитектуры и стандарта — так же: описание из `<папка>.md`, тесты главного файла `<name>.test.ts` первыми", () => {
    writeTree(dir, {
      "tests/standards/audit/audit.md": "Каждая мутация пишет аудит.\n",
      "tests/standards/audit/examples.test.ts": `import { it } from "bun:test";\nit("пример", () => {});\n`,
      "tests/standards/audit/audit.test.ts": `import { it } from "bun:test";\nit("правило", () => {});\n`,
      "tests/architecture/layers/layers.md": "Домен не знает об инфраструктуре.\n",
      "tests/architecture/layers/cases.test.ts": `import { it } from "bun:test";\nit("инфраструктура импортирует домен", () => {});\n`,
      "tests/architecture/layers/layers.test.ts": `import { it } from "bun:test";\nit("домен не импортирует инфраструктуру", () => {});\n`,
    });
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/standards/audit/examples.test.ts": [[[], "пример"]],
        "tests/standards/audit/audit.test.ts": [[[], "правило"]],
        "tests/architecture/layers/cases.test.ts": [[[], "инфраструктура импортирует домен"]],
        "tests/architecture/layers/layers.test.ts": [[[], "домен не импортирует инфраструктуру"]],
      }),
      "--stdout",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### audit\n\nКаждая мутация пишет аудит.\n\n<details><summary>✅ 2 теста</summary>\n\n- ✅ правило\n- ✅ пример\n");
    expect(r.stdout).toContain(
      "### layers\n\nДомен не знает об инфраструктуре.\n\n<details><summary>✅ 2 теста</summary>\n\n- ✅ домен не импортирует инфраструктуру\n- ✅ инфраструктура импортирует домен\n",
    );
  });

  it("`rule.test.ts` больше не главный файл — spec-doc просит переименовать в `<name>.test.ts`, --strict — код 1", () => {
    writeTree(dir, {
      "tests/standards/audit/audit.md": "Каждая мутация пишет аудит.\n",
      "tests/standards/audit/rule.test.ts": `import { it } from "bun:test";\nit("правило", () => {});\n`,
    });
    const report = vitestReport(dir, { "tests/standards/audit/rule.test.ts": [[[], "правило"]] });
    const r = doc("r.json", report, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("главный файл папки — audit.test.ts, а не rule.test.ts — переименуй: tests/standards/audit/rule.test.ts");
    expect(doc("r.json", report, "--stdout", "--strict").code).toBe(1);
  });
});

/**
 * Отчёты раннеров комментариев не несут — прозу `spec-doc` берёт из `<папка>.md` и JSDoc у `describe` и `it` тем же
 * сканером, что `spec-diff`. Причины решений и отвергнутое — в `<папка>.md`; устройство теста и ссылки на задачи —
 * `//`, для читателя кода.
 */
describe("В документацию идёт только проза для читателя спеки", () => {
  // Шапки всех файлов подряд давали лоскутное одеяло заметок разработчику вместо рассказа (#63); теперь рассказ —
  // в <папка>.md (#91), а шапка любого файла — второй источник, который никто не сверяет
  it("шапка файла теста в документацию не идёт — spec-doc просит перенести её в `<папка>.md`, --strict — код 1", () => {
    writeTree(dir, {
      "tests/capabilities/billing/billing.md": "Биллинг: счета клиентам.\n",
      "tests/capabilities/billing/a.test.ts": `/** Заметка разработчику: здесь чистая функция. */\nimport { it } from "bun:test";\nit("a", () => {});\n`,
      [MAIN]: `/** Старая шапка. */\nimport { it } from "bun:test";\nit("b", () => {});\n`,
    });
    const report = vitestReport(dir, { "tests/capabilities/billing/a.test.ts": [[[], "a"]], [MAIN]: [[[], "b"]] });
    const r = doc("r.json", report, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### billing\n\nБиллинг: счета клиентам.\n\n<details>");
    expect(r.stdout).not.toContain("Заметка разработчику");
    expect(r.stdout).not.toContain("Старая шапка");
    expect(r.stderr).toContain("шапка файла в документацию не идёт — перенеси в tests/capabilities/billing/billing.md: tests/capabilities/billing/a.test.ts");
    expect(r.stderr).toContain(`перенеси в tests/capabilities/billing/billing.md: ${MAIN}`);
    expect(doc("r.json", report, "--stdout", "--strict").code).toBe(1);
  });

  it("нет `<папка>.md` — страница без вступления, spec-doc называет файл описания, --strict — код 1", () => {
    writeTree(dir, { [MAIN]: `import { describe, it } from "bun:test";\n${BODY}` });
    const r = doc("r.json", billing(), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("### billing\n\n#### Счета");
    expect(r.stderr).toContain("нет описания tests/capabilities/billing/billing.md — зачем, причина, отвергнутое");
    expect(doc("r.json", billing(), "--stdout", "--strict").code).toBe(1);
  });

  it("заголовки в `<папка>.md` — под заголовком папки: в общем документе сдвигаются на его уровень", () => {
    writeTree(dir, {
      "tests/capabilities/billing/billing.md": "Биллинг.\n\n## Почему месяц\n\nТак считает бухгалтерия.\n",
      [MAIN]: `import { describe, it } from "bun:test";\n${BODY}`,
    });
    expect(doc("r.json", billing(), "--stdout").stdout).toContain("### billing\n\nБиллинг.\n\n#### Почему месяц\n\nТак считает бухгалтерия.\n\n#### Счета");
    doc("r.json", billing());
    expect(read("docs/spec/capabilities/billing.md")).toContain("# billing\n\nБиллинг.\n\n## Почему месяц\n\nТак считает бухгалтерия.\n\n## Счета");
  });

  it("`//`-комментарий, блочные теги JSDoc и JSDoc, отделённый от вызова кодом, в документацию не попадают", () => {
    writeTree(dir, {
      "tests/capabilities/billing/billing.md": "Биллинг.\n",
      [MAIN]: `// комментарий файла
import { describe, it } from "bun:test";
// комментарий describe
/**
 * Счёт — документ на оплату.
 *
 * @see #12
 */
describe("Счета", () => {
  /** про константу */
  const x = 1;
  it("выставляется за месяц", () => {});
  it("черновик удаляется", () => {});
});
`,
    });
    const out = doc("r.json", billing(), "--stdout").stdout;
    expect(out).toContain("### billing\n\nБиллинг.\n\n#### Счета\n\nСчёт — документ на оплату.\n\n<details><summary>✅ 2 теста</summary>\n\n- ✅ выставляется за месяц\n- ✅ черновик удаляется");
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
  // сверку spec-claims локально часто не запускают, и её отчёта нет; в CI он обязан быть — иначе тесты молча выпадут
  it("отчёта нет — локально предупреждение, в CI ошибка", () => {
    writeFileSync(path.join(dir, "r.json"), billing());
    const run = (ci: string) =>
      spawnSync("bun", [path.join(SCRIPTS, "spec-doc.ts"), "r.json", ".spec-claims.xml", "--root", dir, "--stdout"], { cwd: dir, encoding: "utf8", env: { ...process.env, CI: ci } });
    const local = run("");
    expect(local.status).toBe(0);
    expect(local.stderr).toContain("отчёта .spec-claims.xml нет");
    expect(local.stdout).toContain("выставляется за месяц");
    const ci = run("true");
    expect(ci.status).toBe(2);
    expect(ci.stderr).toContain("отчёта .spec-claims.xml нет");
  });

  it("Vitest: абсолютный путь с другой машины приводится по сегменту /tests/", () => {
    const r = doc("r.json", vitestReport("/home/runner/work/repo/repo", { "tests/standards/audit/audit.test.ts": [[["Аудит"], "каждая мутация пишет запись"]] }), "--stdout");
    expect(r.stdout).toContain("## Каким правилам подчиняется код\n\n### audit\n\n#### Аудит\n\n");
    expect(r.stdout).not.toContain("Вне дерева");
  });

  // перед PR e2e ради сверки названий не прогоняют (#191); форма отчёта — вывод `playwright test --list --reporter=json`:
  // пути от rootDir конфига, у тестов нет результатов, статус skipped
  it("Playwright `--list` без прогона: названия e2e сверяются вместе с юнитами, --strict ловит не-утверждение", () => {
    writeFileSync(path.join(dir, "r.json"), billing());
    const list = (title: string, projectName: string) => ({ title, tests: [{ projectName, results: [], status: "skipped", annotations: [] }] });
    const e2e = {
      title: "Вход",
      file: "capabilities/billing/billing.e2e.ts",
      specs: ["chromium", "firefox"].flatMap((p) => [list("через форму", p), list("loginForm", p)]),
    };
    const report = { config: { rootDir: path.join(dir, "tests") }, suites: [{ title: e2e.file, file: e2e.file, specs: [], suites: [e2e] }] };
    const r = doc(".spec-playwright.json", JSON.stringify(report), "r.json", "--stdout", "--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("название — не утверждение по-русски: «loginForm» (tests/capabilities/billing/billing.e2e.ts)");
    expect(r.stdout).toContain("#### Вход");
    expect(r.stdout).toContain("- ⏭️ через форму — пропущен (2 варианта)");
    expect(r.stdout.indexOf("выставляется за месяц")).toBeLessThan(r.stdout.indexOf("через форму"));
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
 * Соглашение видно, а не только проверено: метаданные прогона харнесса (`.spec-meta/`) дают странице стандарта код
 * примеров и долг — исключения с задачей и причиной.
 */
describe("Страница стандарта показывает примеры и исключения", () => {
  const STD = "tests/standards/no-console/no-console.test.ts";
  const meta = (...records: object[]) => ({ ".spec-meta/1.jsonl": records.map((r) => JSON.stringify({ file: STD, ...r })).join("\n") + "\n" });

  it("пример «нельзя» и «можно» — путь и код под строкой теста", () => {
    writeTree(dir, {
      "tests/standards/no-console/no-console.md": "Домен не пишет в консоль.\n",
      ...meta(
        { test: "нельзя: console.log в домене", path: "src/domain/a.ts", code: "console.log(1);" },
        { test: "можно: логгер в домене", path: "src/domain/b.tsx", code: "log(1);\nlog(2);" },
      ),
    });
    const r = doc("r.json", vitestReport(dir, { [STD]: [[[], "нельзя: console.log в домене"], [[], "можно: логгер в домене"]] }), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("- ✅ нельзя: console.log в домене\n  `src/domain/a.ts`\n  ```ts\n  console.log(1);\n  ```\n");
    expect(r.stdout).toContain("- ✅ можно: логгер в домене\n  `src/domain/b.tsx`\n  ```tsx\n  log(1);\n  log(2);\n  ```\n");
  });

  it("исключение — задача и причина под строкой теста; снятое исключение пропадает вместе с тестом", () => {
    writeTree(dir, {
      "tests/standards/no-console/no-console.md": "Домен не пишет в консоль.\n",
      ...meta(
        { test: "исключение: importLegacy (#12)", issue: 12, reason: "импорт старых данных — аудит в #12" },
        { test: "исключение: removed (#13)", issue: 13, reason: "снято" },
      ),
    });
    const r = doc("r.json", vitestReport(dir, { [STD]: [[[], "исключение: importLegacy (#12)"]] }), "--stdout");
    expect(r.stdout).toContain("- ✅ исключение: importLegacy (#12)\n  > #12 — импорт старых данных — аудит в #12\n");
    expect(r.stdout).not.toContain("снято");
  });

  it("элемент вне охвата — причина под строкой теста", () => {
    writeTree(dir, {
      "tests/standards/no-console/no-console.md": "Домен не пишет в консоль.\n",
      ...meta({ test: "вне охвата: login", reason: "форма входа — аудит пишет сервис авторизации" }),
    });
    const r = doc("r.json", vitestReport(dir, { [STD]: [[[], "вне охвата: login"]] }), "--stdout");
    expect(r.stdout).toContain("- ✅ вне охвата: login\n  > форма входа — аудит пишет сервис авторизации\n");
  });

  it("без метаданных прогона — страница без кода примеров, не ошибка", () => {
    writeTree(dir, { "tests/standards/no-console/no-console.md": "Домен не пишет в консоль.\n" });
    const r = doc("r.json", vitestReport(dir, { [STD]: [[[], "нельзя: console.log в домене"]] }), "--stdout", "--strict");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("- ✅ нельзя: console.log в домене\n\n</details>");
  });
});

/**
 * Структура спеки — правило для всех проектов, поэтому её проверяет сама сборка документации: `--strict` в CI
 * валит PR, а без него то же видно в stderr.
 */
describe("Нарушение структуры спеки видно при сборке, --strict — код 1", () => {
  it("папка без главного файла `<папка>.test.ts` — spec-doc называет, где его ждёт", () => {
    writeTree(dir, {
      "tests/capabilities/billing/billing.md": "Биллинг.\n",
      "tests/capabilities/billing/vat.test.ts": `import { it } from "bun:test";\nit("НДС считается", () => {});\n`,
    });
    const report = vitestReport(dir, { "tests/capabilities/billing/vat.test.ts": [[[], "НДС считается"]] });
    const r = doc("r.json", report, "--stdout");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("нет главного файла tests/capabilities/billing/billing.test.ts — его describe открывают страницу");
    expect(doc("r.json", report, "--stdout", "--strict").code).toBe(1);
  });

  // Название — требование; идентификатор или английская фраза не говорят читателю спеки, что система делает
  it("название describe или it без русских слов — идентификатор, имя функции или файла — spec-doc называет его и файл", () => {
    writeTree(dir, { "tests/capabilities/billing/billing.md": "Биллинг.\n" });
    const report = vitestReport(dir, {
      [MAIN]: [
        [["createInvoice"], "returns 201"],
        [["createInvoice"], "счёт `createInvoice()` в `invoice.ts` создаётся по заказу"],
        [["Счета"], "snake_case_name"],
      ],
    });
    const r = doc("r.json", report, "--stdout");
    expect(r.stderr).toContain(`название — не утверждение по-русски: «createInvoice» (${MAIN})`);
    expect(r.stderr).toContain(`название — не утверждение по-русски: «returns 201» (${MAIN})`);
    expect(r.stderr).toContain(`название — не утверждение по-русски: «snake_case_name» (${MAIN})`);
    expect(r.stderr).not.toContain("«счёт");
    expect(r.stderr).not.toContain("«Счета»");
    expect(doc("r.json", report, "--stdout", "--strict").code).toBe(1);
  });
});

/**
 * `tests/lib` — фабрики и хелперы, не спека. Тест вне `capabilities/<name>`, `architecture/<name>` и
 * `standards/<name>` — без дома: это сигнал перенести, а не ошибка разбора.
 */
describe("Оглавление: что делает система, из чего состоит, каким правилам подчиняется код и что без дома", () => {
  const report = () =>
    vitestReport(dir, {
      "tests/capabilities/billing/a.test.ts": [[[], "в дереве"]],
      "tests/lib/factories.test.ts": [[[], "фабрика"]],
      "src/utils/sum.test.ts": [[["sum"], "складывает"]],
      "tests/capabilities/stray.test.ts": [[[], "без папки"]],
      "tests/architecture/overview.test.ts": [[[], "без папки"]],
    });

  it("capability — в «Что делает система», правило архитектуры — в «Из чего состоит», стандарт — в «Каким правилам подчиняется код»", () => {
    doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[[], "x"]],
        "tests/architecture/layers/layers.test.ts": [[[], "z"]],
        "tests/standards/audit/audit.test.ts": [[[], "y"]],
      }),
    );
    expect(read("docs/spec/README.md")).toContain(
      "## Что делает система\n\n- [billing](capabilities/billing.md)\n\n## Из чего состоит\n\n- [layers](architecture/layers.md)\n\n## Каким правилам подчиняется код\n\n- [audit](standards/audit.md)\n",
    );
  });

  it("tests/lib пропускается, тесты вне дерева — в раздел «Вне дерева»", () => {
    const r = doc("r.json", report(), "--stdout");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("фабрика");
    expect(r.stdout).toContain("## Вне дерева");
    expect(r.stdout).toContain("- `src/utils/sum.test.ts` — 1 тест");
    expect(r.stdout).toContain("- `tests/capabilities/stray.test.ts` — 1 тест");
    expect(r.stdout).toContain("- `tests/architecture/overview.test.ts` — 1 тест");
    expect(r.stderr).toContain("вне дерева: 3 в 3 файлах");
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
  it("пишет README.md и страницу на папку — capabilities/, architecture/, standards/ — с маркером", () => {
    const r = doc(
      "r.json",
      vitestReport(dir, {
        "tests/capabilities/billing/a.test.ts": [[["Счета"], "выставляется"]],
        "tests/architecture/layers/layers.test.ts": [[[], "домен не импортирует инфраструктуру"]],
        "tests/standards/audit/audit.test.ts": [[[], "каждая мутация пишет аудит"]],
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
    expect(read("docs/spec/architecture/layers.md")).toStartWith("<!-- spec-doc:");
    expect(read("docs/spec/architecture/layers.md")).toContain("# layers\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ домен не импортирует инфраструктуру");
    expect(read("docs/spec/standards/audit.md")).toContain("# audit\n\n<details><summary>✅ 1 тест</summary>\n\n- ✅ каждая мутация пишет аудит");
  });

  it("рядом с README — tests.json: все тесты дерева для spec-diff", () => {
    doc(
      "r.json",
      vitestReport(dir, {
        "tests/standards/audit/audit.test.ts": [[[], "b пишет аудит"], [[], "a пишет аудит"]],
        "tests/capabilities/billing/billing.test.ts": [[["Счета"], "выставляется"]],
        "tests/lib/f.test.ts": [[[], "фабрика"]],
      }),
    );
    expect(JSON.parse(read("docs/spec/tests.json"))).toEqual([
      { path: "tests/capabilities/billing/billing.test.ts", describes: ["Счета"], name: "выставляется" },
      { path: "tests/standards/audit/audit.test.ts", describes: [], name: "a пишет аудит" },
      { path: "tests/standards/audit/audit.test.ts", describes: [], name: "b пишет аудит" },
    ]);
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
