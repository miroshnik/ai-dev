import { describe, expect, it } from "bun:test";

import { parseJs } from "../../../skills/spec/scripts/speclib.ts";

const names = (src: string) => parseJs("tests/capabilities/x/a.test.ts", src).map((t) => [...t.describes, t.name].join(" › "));

/**
 * Сканер вместо парсера — без зависимостей и без прогона: имя теста — строковый литерал первым аргументом
 * `describe` / `it` / `test`. Динамическое имя видно с плейсхолдером (`it.each`) или не видно вовсе.
 */
describe("Сканер TS/JS", () => {
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

  it("describe с колбэком-переменной не открывает вложенность", () => {
    const src = `describe("без тела", suiteFn);
    it("верхний", () => {});`;
    expect(names(src)).toEqual(["верхний"]);
  });
});
