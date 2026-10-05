import { describe, expect, it } from "bun:test";

import { codeOnly } from "../../../skills/spec/scripts/harness.ts";
import { parseJs, scanJs } from "../../../skills/spec/scripts/speclib.ts";

const names = (src: string) => parseJs("tests/capabilities/x/a.test.ts", src).map((t) => [...t.describes, t.name].join(" › "));

/**
 * Прогон — минуты, поэтому имя теста берётся из исходника: строка, известная без прогона (литерал, шаблон без
 * подстановок), первым аргументом `describe` / `it` / `test`. Динамическое имя видно с плейсхолдером (`it.each`) или
 * строкой в stderr. Исходник разбирает парсер TypeScript — `@babel/parser` файлом в скилле, без зависимостей: свой
 * лексер угадывал, где регулярка, шаблон и аргумент типа, и терял тесты молча.
 */
describe("Названия берутся из исходников парсером — без прогона", () => {
  it("вложенные describe дают цепочку, объект опций перед колбэком не считается телом", () => {
    const src = `describe("Счета", { timeout: 1 }, () => {
      describe("за месяц", () => { it("выставляется", () => {}); });
      test("итог", async () => {});
    });
    it("снаружи", () => {});`;
    expect(names(src)).toEqual(["Счета › за месяц › выставляется", "Счета › итог", "снаружи"]);
  });

  it("test.describe Playwright и модификаторы skip/only/serial/todo/fixme", () => {
    const src = `test.describe.serial("Вход", () => {
      test.skip("по SSO", async () => {});
      test.only("по паролю", async () => {});
      test.fixme("с капчей", async () => {});
    });
    it.todo("потом");
    describe.skip("выключено", () => { it("внутри", () => {}); });`;
    expect(names(src)).toEqual(["Вход › по SSO", "Вход › по паролю", "Вход › с капчей", "потом", "выключено › внутри"]);
  });

  it("it.each и describe.each — имя второго вызова с плейсхолдером", () => {
    const src = `describe.each([["a"], ["b"]])("набор %s", (x) => {
      it.each([[1, 2], [3, 4]])("сумма %i + %i", () => {});
      test.for([1, 2])("для %s", () => {});
    });`;
    expect(names(src)).toEqual(["набор %s › сумма %i + %i", "набор %s › для %s"]);
  });

  // после `each` шёл `<…>`, а не `(`: тест с аргументом типа пропадал из spec-diff, его JSDoc — из spec-doc (#275)
  it("it.each<T>, describe.each<T>, test.for<T> и test<T> с аргументом типа сканер находит, JSDoc такого теста — его проза", () => {
    const src = `describe.each<[string]>([["a"]])("набор %s", () => {
      /** Проза суммы. */
      it.each<Array<Map<string, number>>>([])("сумма %s", () => {});
      test.for <{ f: (x: number) => void; s: ">" | "<" }> ([])("для %s", () => {});
      it.each([1])<number>("второй вызов %s", () => {});
    });
    test<Ctx>("с контекстом", () => {});`;
    expect(names(src)).toEqual(["набор %s › сумма %s", "набор %s › для %s", "набор %s › второй вызов %s", "с контекстом"]);
    expect(scanJs("tests/capabilities/x/a.test.ts", src).docs.tests.get(JSON.stringify(["набор %s", "сумма %s"]))).toBe("Проза суммы.");
  });

  // сторож от перекоррекции: `<` без пары до `)` или `;` — сравнение, иначе `>` в теле закрыл бы «аргумент типа» и съел тест
  it("сравнение с именем `it` / `test` (`it < max`) вызовом с аргументом типа не считается", () => {
    const src = 'if (it < max) it("а", () => expect(n > (0)).toBe(true));\nconst ok = test < 3; it("б", () => expect(n > (0)).toBe(true));';
    expect(names(src)).toEqual(["а", "б"]);
  });

  it("комментарии и строки не считаются вызовами", () => {
    const src = `// it("в комментарии", () => {});
    /* describe("в блоке", () => {}); */
    const s = 'it("в строке")';
    const t = \`describe("в шаблоне \${'x'}")\`;
    it("настоящий", () => { const brace = "}"; });`;
    expect(names(src)).toEqual(["настоящий"]);
  });

  it("test.step, test.use, beforeEach и test.fail() без имени — не тесты", () => {
    const src = `test.beforeEach(async () => {});
    test.use({ locale: "ru" });
    test("шаг", async () => { await test.step("открыть", async () => {}); test.fail(); });
    it(dynamicName, () => {});`;
    expect(names(src)).toEqual(["шаг"]);
  });

  it("экранирование в названии снимается, шаблон без подстановок и сложение строк — название", () => {
    const src = "it('it\\'s', () => {}); it(\"неразрывный\\u00a0пробел\", () => {}); it(`шаблон`, () => {}); it(\"сло\" + `жение`, () => {});";
    expect(names(src)).toEqual(["it's", "неразрывный\u00a0пробел", "шаблон", "сложение"]);
  });

  it("название, которое не вычислить (шаблон с подстановкой, переменная), сканер отдаёт местом и выражением, а не тестом", () => {
    const src = 'it(`ставка ${rate}%`, () => {});\n/** Проза. */\ndescribe(title, () => { it("внутри", () => {}); });\nit("видимый", () => {});';
    const scan = scanJs("tests/capabilities/x/a.test.ts", src);
    expect(scan.tests.map((t) => t.name)).toEqual(["видимый"]);
    expect(scan.unnamed).toEqual([
      { line: 1, kind: "it", name: "`ставка ${rate}%`", doc: "" },
      { line: 3, kind: "describe", name: "title", doc: "Проза." },
    ]);
  });

  it("условный `test.skip(условие, \"причина\")` и `test.fail()` Playwright — не тесты и не невычислимые названия", () => {
    const src = 'test("вход", async ({ browserName }) => { test.skip(browserName === "webkit", "нет поддержки"); test.fail(); });';
    const scan = scanJs("tests/capabilities/x/a.test.ts", src);
    expect([scan.tests.map((t) => t.name), scan.unnamed]).toEqual([["вход"], []]);
  });

  it("it.skipIf / it.runIf и it.each с таблицей-шаблоном — имя второго вызова", () => {
    const src = 'it.skipIf(ci)("локально", () => {});\ndescribe.runIf(db)("с базой", () => { it("пишет", () => {}); });\nit.each`a | b\n${1} | ${2}`("табл $a", () => {});';
    expect(names(src)).toEqual(["локально", "с базой › пишет", "табл $a"]);
  });

  // лексер угадывал, где регулярка и где JSX, и терял тесты молча (#267, #269, #271, #275): парсер не угадывает (#277)
  it("названия тестов и их JSDoc сканер берёт из AST: регулярки, шаблонные строки, комментарии, неразрывные пробелы и аргументы типа тест не теряют", () => {
    const ts = [
      "if (ok) /[`]/.test(s);",
      'it("после условия", () => {});',
      "while (i--) /`/.exec(s);",
      "label: {}\n/`/.test(s);",
      "const id = <T,>(x: T) => x; const cfg = {} satisfies Cfg;",
      "@sealed class Fixture { constructor(@inject() private x: X) {} accessor n = 1; }",
      "/** Проза. */",
      'it.each<Array<[string]>>([["a"]])("с аргументом типа %s", () => {});',
      'describe("набор", () => { /** Проза вложенного. */ it(\"вложенный\", () => { const t = `${/* } */ "`"}`; }); });',
    ].join("\n");
    expect(names(ts)).toEqual(["после условия", "с аргументом типа %s", "набор › вложенный"]);
    const { docs } = scanJs("tests/capabilities/x/a.test.ts", ts);
    expect([docs.tests.get(JSON.stringify(["с аргументом типа %s"])), docs.tests.get(JSON.stringify(["набор", "вложенный"]))]).toEqual(["Проза.", "Проза вложенного."]);
    const tsx = 'const view = <p title="//x">it\'s // не комментарий {"`"}</p>;\nit("после JSX", () => {});';
    expect(parseJs("tests/capabilities/x/a.test.tsx", tsx).map((t) => t.name)).toEqual(["после JSX"]);
  });

  it("исходник, который не разобрать, — ошибка с местом, а не пустой список тестов", () => {
    expect(() => parseJs("tests/capabilities/x/a.test.ts", 'it("а", () => {\n')).toThrow(/^не разобран: .*\(2:0\)/);
  });

  it("текст JSX с `//` и комментарий в `${…}` харнесс видит как парсер: первое — код, второе — комментарий", () => {
    const src = 'const v = <a href="//x">// текст</a>;\nconst t = `${/* c */ 1}`;\n';
    expect(codeOnly(src, "src/view.tsx")).toBe('const v = <a href="//x">// текст</a>;\nconst t = `${        1}`;\n');
  });

  it("xit / xdescribe / fit Jest и suite / context Mocha", () => {
    const src = `xdescribe("выкл", () => { fit("фокус", () => {}); xit("пропуск", () => {}); });
    suite("набор", () => { context("контекст", () => { it("пример", () => {}); }); });`;
    expect(names(src)).toEqual(["выкл › фокус", "выкл › пропуск", "набор › контекст › пример"]);
  });

  // обратная кавычка в регулярке открывала шаблонную строку до следующей — тесты файла пропадали молча (#267)
  it("название теста в файле с регуляркой, содержащей обратную кавычку, сканер находит", () => {
    const src = [
      "const tick = /[`'\"]/;",
      'it("после регулярки с кавычками", () => {});',
      'const wrap = `${s.replace(/[}`]/g, "")}`; it("после шаблона с регуляркой", () => {});',
      "if (/[/]\\/`/.test(s)) skip();",
      'it("регулярка в теле", () => { expect(s.replace(/`/g, "")).toBe(""); });',
      "function f() { return /`/; }",
      'describe("после return", () => { it("вложенный", () => {}); });',
    ].join("\n");
    expect(names(src)).toEqual(["после регулярки с кавычками", "после шаблона с регуляркой", "регулярка в теле", "после return › вложенный"]);
    const body = parseJs("tests/capabilities/x/a.test.ts", src).find((t) => t.name === "регулярка в теле")!.body;
    expect(body).toBe(',()=>{expect(s.replace(/`/g,"")).toBe("");}');
  });

  // символ перед `/` брался из комментария: регулярка после него — «деление», кавычка в ней открывала шаблон (#269)
  it("регулярку с обратной кавычкой после строчного комментария сканер пропускает", () => {
    const src = ["f();", "// проверка", "/[`]/.test(x);", 'it("а", () => {});'].join("\n");
    expect(names(src)).toEqual(["а"]);
  });

  it("регулярку после блочного комментария в аргументах сканер пропускает", () => {
    const src = ["g(a, /* c */ /[`]/);", 'it("б", () => { h(/* c */ /[`)]/); });', 'it("в", () => {});'].join("\n");
    expect(names(src)).toEqual(["б", "в"]);
    const body = parseJs("tests/capabilities/x/a.test.ts", src).find((t) => t.name === "б")!.body;
    expect(body).toBe(",()=>{h(/*c*//[`)]/);}");
  });

  // пробел сканер считал своим списком: NBSP и `\f` — значащий символ, регулярка после них — «деление» (#271)
  it("регулярку после NBSP или `\\f` сканер пропускает", () => {
    for (const space of [" ", "\f"]) expect(names(`const ok = x =${space}/[\`]/.test(y);\nit("а", () => {});`)).toEqual(["а"]);
  });

  // обход кода был скопирован в сканер и харнесс и расходился в пробелах и шебанге (#271)
  it("на трудных исходниках (комментарий перед регуляркой, комментарий в `${…}`, NBSP, `\\f`, BOM, шебанг) сканер названий и харнесс одинаково видят, где код", () => {
    // исходник и он же глазами харнесса: комментарии — пробелами, и в `${…}` шаблона тоже
    const hard: [string, string][] = [
      ["f(); /* c */ /[`]/.test(y);", "f();         /[`]/.test(y);"],
      ["const t = `${/* c */ /[`]/.source}`;", "const t = `${        /[`]/.source}`;"],
      ["const ok = x = /[`]/.test(y);", "const ok = x = /[`]/.test(y);"],
      ["const ok = x =\f/[`]/.test(y);", "const ok = x =\f/[`]/.test(y);"],
      ["﻿/[`]/.test(y);", "﻿/[`]/.test(y);"],
      ["#!/usr/bin/env bun\n/[`]/.test(y);", "                  \n/[`]/.test(y);"],
    ];
    const tail = '\nit("код", () => {}); // it("комментарий", () => {});\n';
    const tailCode = '\nit("код", () => {});                                \n';
    for (const [head, code] of hard) {
      expect([head, names(head + tail)]).toEqual([head, ["код"]]);
      expect([head, codeOnly(head + tail)]).toEqual([head, code + tailCode]);
    }
  });

  // сторож от перекоррекции: `/` после имени, `)`, `]` и числа — деление, иначе до второго `/` строки всё — «регулярка»
  it("деление (`a / b / c`) регуляркой не считается", () => {
    const src = [
      'const half = total / 2; it("после имени", () => {}); const quarter = total / 4;',
      'const mean = (a + b) / 2; it("после скобки", () => {}); const r = (a) / 4;',
      'const first = arr[0] / 2; it("после индекса", () => {}); const s = arr[1] / 4;',
      'const n = 10 / 2; it("после числа", () => {}); const m = 3 / 4;',
    ].join("\n");
    expect(names(src)).toEqual(["после имени", "после скобки", "после индекса", "после числа"]);
  });

  it("describe с колбэком-переменной не открывает вложенность", () => {
    const src = `describe("без тела", suiteFn);
    it("верхний", () => {});`;
    expect(names(src)).toEqual(["верхний"]);
  });
});
