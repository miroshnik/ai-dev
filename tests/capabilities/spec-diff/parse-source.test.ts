import { describe, expect, it } from "bun:test";

import { codeOnly } from "../../../skills/spec/scripts/harness.ts";
import { parseJs } from "../../../skills/spec/scripts/speclib.ts";

const names = (src: string) => parseJs("tests/capabilities/x/a.test.ts", src).map((t) => [...t.describes, t.name].join(" › "));

/**
 * Парсер TypeScript — зависимость, прогон — минуты, поэтому имя теста — строковый литерал первым аргументом
 * `describe` / `it` / `test`. Динамическое имя видно с плейсхолдером (`it.each`) или не видно вовсе.
 */
describe("Названия берутся из исходников сканером — без прогона и без парсера", () => {
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

  it("шаблонная строка с подстановкой сохраняется как есть, экранирование снимается", () => {
    const src = "it(`ставка ${rate}%`, () => {}); it('it\\'s', () => {});";
    expect(names(src)).toEqual(["ставка ${rate}%", "it's"]);
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
    // исходник и он же глазами харнесса: комментарии — пробелами; шаблон с `${…}` — строка целиком
    const hard: [string, string][] = [
      ["f(); /* c */ /[`]/.test(y);", "f();         /[`]/.test(y);"],
      ["const t = `${/* c */ /[`]/.source}`;", "const t = `${/* c */ /[`]/.source}`;"],
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
