import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const FILE = "tests/capabilities/billing/billing.test.ts";

/** Тест capability проекта: обёртки границ в тестовой сборке зовут trace, сценарий — sequence. */
function run(body: string) {
  rmSync(path.join(dir, ".spec-meta"), { recursive: true, force: true });
  writeTree(dir, {
    [FILE]: `import { it } from "bun:test";
import { sequence, trace } from ${JSON.stringify(path.join(SCRIPTS, "harness.ts"))};
${body}`,
  });
  const r = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

function records() {
  const d = path.join(dir, ".spec-meta");
  return readdirSync(d).flatMap((f) => readFileSync(path.join(d, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
}

const ORDER = `{ order: ["app → db: резерв", "app → stripe: списание", "mail → resend: письмо"] }`;

/**
 * Взаимодействие частей системы в сценарии — сиквенс-схема из трассы теста, а не рисунок: обёртки на границах модели
 * (точка входа, адаптер внешней системы, клиент хранилища, вызов другого контейнера) пишут вызовы по порядку, пока
 * идёт сценарий. Порядок, который сам — решение, сценарий объявляет, и трасса с ним сверяется.
 */
describe("Сценарий capability — сиквенс-схема из трассы вызовов на границах модели", () => {
  it("sequence пишет вызовы на границах по порядку в метаданные прогона, trace вне сценария — ничего", () => {
    const r = run(`trace("app", "db", "вне сценария");
sequence(it, "заказ оплачивается", async () => {
  trace("app", "db", "резерв");
  await Promise.resolve();
  trace("app", "stripe", "списание");
  trace("mail", "resend", "письмо");
}, { id: "payment" });
`);
    expect(r.code).toBe(0);
    expect(records()).toEqual([
      {
        file: FILE,
        test: "заказ оплачивается",
        id: "payment",
        sequence: [
          { from: "app", to: "db", message: "резерв" },
          { from: "app", to: "stripe", message: "списание" },
          { from: "mail", to: "resend", message: "письмо" },
        ],
      },
    ]);
  });

  it("вызов внутри участника в трассу не попадает — перестановка внутри модуля схему не меняет", () => {
    expect(run(`sequence(it, "s", () => { trace("app", "app", "посчитать"); trace("app", "db", "резерв"); trace("app", "app", "проверить"); trace("app", "stripe", "списание"); });`).code).toBe(0);
    const before = records()[0].sequence;
    expect(run(`sequence(it, "s", () => { trace("app", "db", "резерв"); trace("app", "app", "проверить"); trace("app", "app", "посчитать"); trace("app", "stripe", "списание"); });`).code).toBe(0);
    expect(records()[0].sequence).toEqual(before);
    expect(before).toEqual([{ from: "app", to: "db", message: "резерв" }, { from: "app", to: "stripe", message: "списание" }]);
  });

  it("нарушенный объявленный порядок валит тест, соблюдённый — зелёный", () => {
    const ok = run(`sequence(it, "по порядку", () => {
  trace("app", "db", "резерв"); trace("app", "cache", "прочитать"); trace("app", "stripe", "списание"); trace("mail", "resend", "письмо");
}, ${ORDER});`);
    expect(ok.code).toBe(0);
    const bad = run(`sequence(it, "списание раньше резерва", () => {
  trace("app", "stripe", "списание"); trace("app", "db", "резерв"); trace("mail", "resend", "письмо");
}, ${ORDER});`);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("порядок сценария «списание раньше резерва» нарушен: нет «app → stripe: списание» после «app → db: резерв»");
  });

  it("участник не из модели — тест падает: схема говорит на языке модели", () => {
    const model = `{ modules: { app: { path: "src", purpose: "приложение" } }, externals: { stripe: { purpose: "платежи", adapter: "app" } }, containers: { db: { purpose: "база" } } }`;
    const r = run(`sequence(it, "в модели", () => { trace("app", "db", "резерв"); trace("app", "stripe", "списание"); }, { model: ${model} });
sequence(it, "не в модели", () => { trace("app", "paypal", "списание"); }, { model: ${model} });
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("(pass) в модели");
    expect(r.out).toContain("(fail) не в модели");
    expect(r.out).toContain("участник paypal — не элемент модели");
  });
});
