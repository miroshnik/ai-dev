import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SLOT = fileURLToPath(new URL("../../../skills/slot/scripts/slot.ts", import.meta.url));
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;

let dir: string;
let cleanup: () => void;
let config: string;
let tmp: string;
let running: ChildProcess[];
/** Каталоги, закрытые тестом на запись: открываются до уборки, иначе её не удалить. */
let locked: string[];

beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  config = path.join(dir, "config");
  tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  running = [];
  locked = [];
});
afterEach(() => {
  for (const d of locked) chmodSync(d, 0o755);
  for (const p of running) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    try {
      process.kill(-p.pid!, "SIGKILL");
    } catch (e) {
      // отпущенная команда уже вышла, а событие exit до теста ещё не дошло: группы нет — убирать нечего; macOS на группу
      // из одних неубранных зомби отвечает EPERM, а не ESRCH
      if (!["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code!)) throw e;
    }
  }
  cleanup();
});

/**
 * Окружение slot: своя очередь в каталоге теста — и в конфигурации, и во временных каталогах, иначе тест встал бы в
 * очередь машины; прогон самого теста может идти в CI, внутри слота или в Claude Code — не в счёт.
 */
function envOf(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, AI_DEV_CONFIG_DIR: config, TMPDIR: tmp, ...extra };
  for (const k of ["CI", "AI_DEV_SLOT", "AI_DEV_SLOT_CPUS", "CLAUDE_TMPDIR"]) if (!(k in extra)) delete env[k];
  return env;
}

/** Каталог без записи — как каталог конфигурации в песочнице агента: читать можно, писать нельзя. */
function lock(d: string) {
  mkdirSync(d, { recursive: true });
  chmodSync(d, 0o555);
  locked.push(d);
}
function unlock(d: string) {
  chmodSync(d, 0o755);
  locked = locked.filter((x) => x !== d);
}

interface Queued {
  out: () => string;
  err: () => string;
  proc: ChildProcess;
  done: Promise<number | string>;
}

/** `slot` фоном: своя группа процессов — тест убивает её целиком. */
function start(args: string[], extra: Record<string, string> = {}): Queued {
  const proc = spawn("bun", [SLOT, ...args], { cwd: dir, env: envOf(extra), detached: true });
  running.push(proc);
  let out = "";
  let err = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (err += d));
  const done = new Promise<number | string>((resolve) => proc.on("exit", (code, signal) => resolve(code ?? `сигнал ${signal}`)));
  return { out: () => out, err: () => err, proc, done };
}

/** Команда в слоте, которая идёт, пока тест её не отпустит: `started-<имя>` — началась, `release-<имя>` — закончить. */
const hold = (name: string, extra: Record<string, string> = {}) =>
  start([`touch started-${name}; while [ ! -f release-${name} ]; do sleep 0.02; done`], extra);
const started = (name: string) => existsSync(path.join(dir, `started-${name}`));
const release = (name: string) => writeFileSync(path.join(dir, `release-${name}`), "");

async function until(cond: () => boolean, what: string) {
  for (const t0 = Date.now(); !cond(); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error(`не дождался: ${what}`);
}

/** Ждёт в очереди: напечатал, что ждёт. */
const waiting = (q: Queued, name: string) => until(() => q.err().includes("slot: waiting for the machine queue"), `${name} ждёт в очереди; stderr: ${q.err()}`);

/** Синхронный `slot`; таймаут — чтобы зависание в очереди упало с объяснением, а не таймаутом теста. */
function run(args: string[], extra: Record<string, string> = {}, runtime = "bun") {
  return spawnSync(runtime, [SLOT, ...args], { cwd: dir, env: envOf(extra), encoding: "utf8", timeout: PATIENCE });
}

describe("Тяжёлые прогоны машины идут очередью: два одновременно, остальные — по порядку прихода", () => {
  it("третья команда ждёт, пока идут две, и стартует, когда одна закончилась", async () => {
    const [a, b] = [hold("a"), hold("b")];
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    expect(started("c")).toBe(false);
    release("a");
    expect(await a.done).toBe(0);
    await until(() => started("c"), "третья стартовала после первой");
    release("b");
    release("c");
    expect([await b.done, await c.done]).toEqual([0, 0]);
  });

  it("очередь — по порядку прихода", async () => {
    hold("a");
    const b = hold("b");
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    const d = hold("d");
    await waiting(d, "четвёртая");
    release("b");
    await b.done;
    await until(() => started("c") || started("d"), "освободившийся слот занят");
    expect(started("c")).toBe(true);
    expect(started("d")).toBe(false);
    release("a");
    await until(() => started("d"), "четвёртая стартовала после второго освободившегося слота");
    for (const n of ["c", "d"]) release(n);
    expect(await d.done).toBe(0);
  });

  it("слот процесса, убитого без уборки, освобождается", async () => {
    const [a, b] = [hold("a"), hold("b")];
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    process.kill(-a.proc.pid!, "SIGKILL");
    await until(() => started("c"), "третья стартовала после убитой первой");
    for (const n of ["b", "c"]) release(n);
    expect([await b.done, await c.done]).toEqual([0, 0]);
    // свои билеты живые снимают сами, билет убитого убрала очередь
    expect(readdirSync(path.join(config, "slots"))).toEqual([]);
  });

  it("ожидающая команда печатает, кого ждёт", async () => {
    hold("a");
    hold("b");
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    expect(c.err()).toContain("started-a");
    expect(c.err()).toContain("started-b");
    expect(c.err()).toContain(path.basename(dir));
    for (const n of ["a", "b", "c"]) release(n);
    expect(await c.done).toBe(0);
    expect(c.err()).toContain("slot: waited ");
  });
});

describe("Команда в слоте — как без него, с долей ядер для раннера", () => {
  it("команда получает четверть ядер в AI_DEV_SLOT_CPUS", () => {
    const r = run(['echo "$AI_DEV_SLOT_CPUS"']);
    expect(exitOf(r)).toBe(0);
    expect(r.stdout.trim()).toBe(String(Math.max(1, Math.floor(os.availableParallelism() / 4))));
  });

  it("аргументы дописываются в конец команды, как у npm run", () => {
    const r = run(["printf '%s|'", "a b", "it's", "$HOME"]);
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toBe("a b|it's|$HOME|");
  });

  it("код выхода — код команды", () => {
    expect(exitOf(run(["exit 3"]))).toBe(3);
  });

  /** Скрипт package.json проекта на Node зовёт slot через node (≥ 22.18): типы стираются, предупреждений нет. */
  it("под Node без Bun — то же, что под Bun", () => {
    const r = run(['echo "$AI_DEV_SLOT_CPUS"'], {}, "node");
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toBe(run(['echo "$AI_DEV_SLOT_CPUS"']).stdout);
    expect(r.stderr).toBe("");
  });
});

describe("Без очереди — там, где она лишняя или ждала бы сама себя", () => {
  it("в CI команда идёт сразу, без очереди", async () => {
    hold("a");
    hold("b");
    await until(() => started("a") && started("b"), "оба слота заняты");
    const r = run(['echo "ci[$AI_DEV_SLOT_CPUS]"'], { CI: "true" });
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toBe("ci[]\n");
    for (const n of ["a", "b"]) release(n);
  });

  it("вложенный вызов внутри слота идёт сразу", async () => {
    hold("a");
    await until(() => started("a"), "один слот занят");
    const r = run([`bun '${SLOT}' 'echo inner'`]);
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toBe("inner\n");
    release("a");
  });
});

describe("Песочница агента не роняет очередь", () => {
  it("без записи в каталог конфигурации очередь идёт через временный каталог", async () => {
    lock(path.join(config, "slots"));
    const [a, b] = [hold("a"), hold("b")];
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    expect(readdirSync(path.join(tmp, "ai-dev", "slots"))).toHaveLength(3);
    release("a");
    expect(await a.done).toBe(0);
    await until(() => started("c"), "третья стартовала после первой");
    for (const n of ["b", "c"]) release(n);
    expect([await b.done, await c.done]).toEqual([0, 0]);
  });

  it("прогон в песочнице ждёт прогоны вне её, мёртвый билет вне песочницы ему не мешает", async () => {
    const [a, b] = [hold("a"), hold("b")];
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    lock(path.join(config, "slots"));
    const c = hold("c");
    await waiting(c, "третья в песочнице");
    expect(readdirSync(path.join(tmp, "ai-dev", "slots"))).toHaveLength(1);
    // билет убитой первой остаётся в каталоге, который песочнице не убрать
    process.kill(-a.proc.pid!, "SIGKILL");
    await until(() => started("c"), "третья стартовала после убитой первой");
    unlock(path.join(config, "slots"));
    for (const n of ["b", "c"]) release(n);
    expect([await b.done, await c.done]).toEqual([0, 0]);
  });

  it("прогон Claude Code вне песочницы ждёт прогоны в ней", async () => {
    lock(path.join(config, "slots"));
    const [a, b] = [hold("a"), hold("b")];
    await until(() => started("a") && started("b"), "две первые команды в песочнице стартовали");
    unlock(path.join(config, "slots"));
    // вне песочницы временный каталог свой, а временный каталог Claude Code — тот же, что у песочницы
    const outside = path.join(dir, "outside");
    mkdirSync(outside);
    const c = hold("c", { TMPDIR: outside, CLAUDE_TMPDIR: tmp });
    await waiting(c, "третья вне песочницы");
    expect(readdirSync(path.join(config, "slots"))).toHaveLength(1);
    release("a");
    expect(await a.done).toBe(0);
    await until(() => started("c"), "третья стартовала после первой");
    for (const n of ["b", "c"]) release(n);
    expect([await b.done, await c.done]).toEqual([0, 0]);
  });

  it("очереди нет — одна строка предупреждения, команда идёт без неё", () => {
    lock(path.join(config, "slots"));
    lock(path.join(tmp, "ai-dev", "slots"));
    const r = run(['echo "ran[$AI_DEV_SLOT_CPUS]"; exit 3']);
    expect(exitOf(r)).toBe(3);
    expect(r.stdout).toBe("ran[]\n");
    expect(r.stderr).toMatch(/^slot: [^\n]*without the queue[^\n]*\n$/);
  });
});
