import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, runScript, SCRIPTS, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  gitRepo(dir);
  writeTree(dir, { [SUM]: ORIGINAL, [OTHER]: "export const b = 1;\n" });
});
afterEach(() => cleanup());

const SUM = "src/sum.ts";
const OTHER = "src/other.ts";
const ORIGINAL = "export const sum = (a: number, b: number) => a + b;\n";
// «тест» проекта: зелёный, пока в sum.ts сложение, красный после поломки
const CHECK = ["sh", "-c", `grep -q "a + b" ${SUM}`];
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
const journal = () => path.join(dir, ".git", "spec-break.json");
const breakRun = (...args: string[]) => runScript("spec-break", args, dir);

/** Прогон, оборванный сигналом: команда теста пишет свой pid и ждёт, пока её не убьют. */
async function interrupted(signal: NodeJS.Signals): Promise<number | null> {
  const cmd = `echo $$ > child.pid; exec sleep 30`;
  const p = spawn("bun", [path.join(SCRIPTS, "spec-break.ts"), "--no-baseline", "--file", SUM, "--find", "a + b", "--replace", "a - b", "--", "sh", "-c", cmd], {
    cwd: dir,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => p.on("exit", (code) => resolve(code)));
  // ждём реального события — поломка применена и команда запущена, — а не паузы
  for (let i = 0; i < 400 && !existsSync(path.join(dir, "child.pid")); i++) await Bun.sleep(25);
  expect(read(SUM)).toContain("a - b");
  p.kill(signal);
  const code = await exited;
  // kill -9 не даёт скрипту убрать команду теста — убираем сами, чтобы не оставлять процесс
  try {
    process.kill(Number(read("child.pid").trim()), "SIGKILL");
  } catch {
    /* уже завершилась */
  }
  return code;
}

/**
 * Поломку применяют к исходнику проекта: оставленная, она уйдёт в коммит. Откат — всегда: после прогона, по сигналу
 * и после обрыва без шанса на откат (kill -9, закрытая сессия) — тогда файл возвращает следующий запуск по журналу в
 * `.git`.
 */
describe("Поломка всегда откатывается: файл возвращается в исходный вид, что бы ни случилось с прогоном", () => {
  it("откатывается, даже если прогон прерван", async () => {
    const code = await interrupted("SIGTERM");
    expect(code).not.toBe(0);
    expect(read(SUM)).toBe(ORIGINAL);
    expect(existsSync(journal())).toBe(false);
  });

  it("обрыв без отката — следующий запуск возвращает файл по журналу", async () => {
    await interrupted("SIGKILL");
    expect(read(SUM)).toContain("a - b");
    const r = breakRun("--restore");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`вернул ${SUM}`);
    expect(read(SUM)).toBe(ORIGINAL);
    expect(existsSync(journal())).toBe(false);
  });

  it("файл правили после обрыва — журнал правку не затирает и говорит об этом", async () => {
    await interrupted("SIGKILL");
    writeFileSync(path.join(dir, SUM), "// правка руками\n");
    const r = breakRun("--restore");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`${SUM} изменён после поломки`);
    expect(read(SUM)).toBe("// правка руками\n");
  });
});

/**
 * Поломку выбирает агент под одну проверку: результат — доказательство, что проверка умеет упасть, а не метрика
 * «убитых мутантов». Каждая поломка — отдельный прогон: первый красный тест в serial-группе прячет остальные.
 */
describe("Отчёт — умеет ли проверка упасть от каждой поломки", () => {
  it("тест, который от неё не падает, — ❌ с названием поломки", () => {
    const r = breakRun("--file", OTHER, "--find", "= 1", "--replace", "= 2", "--name", "b стал двойкой", "--", ...CHECK);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`❌ не упал: b стал двойкой (${OTHER})`);
    expect(read(OTHER)).toBe("export const b = 1;\n");
  });

  it("пачка — отчёт по каждой, файлы в исходном виде", () => {
    const plan = [
      { name: "вычитание вместо сложения", file: SUM, find: "a + b", replace: "a - b" },
      { name: "сложение с единицей", file: SUM, find: "a + b", replace: "a + b + 1" },
      { name: "b стал двойкой", file: OTHER, find: "= 1", replace: "= 2" },
    ];
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
    // команда пишет, сколько поломок видит в прогоне: по одной на прогон, базовый — без поломок
    const count = `n=0; grep -q "a + b;" ${SUM} || n=$((n+1)); grep -q "= 1" ${OTHER} || n=$((n+1)); echo $n >> runs.log; grep -q "a + b;" ${SUM}`;
    const r = breakRun("--plan", "plan.json", "--", "sh", "-c", count);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✅ упал: вычитание вместо сложения (${SUM})`);
    expect(r.stdout).toContain(`✅ упал: сложение с единицей (${SUM})`);
    expect(r.stdout).toContain(`❌ не упал: b стал двойкой (${OTHER})`);
    expect(r.stdout).toContain("итог: 2 из 3 поломок уронили проверку");
    expect(read("runs.log")).toBe("0\n1\n1\n1\n");
    expect([read(SUM), read(OTHER)]).toEqual([ORIGINAL, "export const b = 1;\n"]);
  });

  it("прогон красный и без поломки — ошибка, поломки не применяются", () => {
    const r = breakRun("--file", SUM, "--find", "a + b", "--replace", "a - b", "--", "sh", "-c", `echo run >> runs.log; exit 1`);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("прогон красный и без поломки");
    expect(read("runs.log")).toBe("run\n");
    expect(read(SUM)).toBe(ORIGINAL);
  });

  it("фрагмент не найден или встречается не один раз — ошибка до прогона", () => {
    writeTree(dir, { [OTHER]: "export const b = 1;\nexport const c = 1;\n" });
    const missing = breakRun("--file", SUM, "--find", "a * b", "--replace", "a / b", "--", "sh", "-c", "echo run >> runs.log");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain(`«a * b» в ${SUM} не найден`);
    const twice = breakRun("--file", OTHER, "--find", "= 1", "--replace", "= 2", "--", "sh", "-c", "echo run >> runs.log");
    expect(twice.code).toBe(2);
    expect(twice.stderr).toContain(`«= 1» в ${OTHER} встречается 2 раза`);
    expect(existsSync(path.join(dir, "runs.log"))).toBe(false);
  });
});
