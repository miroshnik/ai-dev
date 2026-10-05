import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
let running: ChildProcess[];

beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  config = path.join(dir, "config");
  running = [];
});
afterEach(() => {
  for (const p of running) if (p.exitCode === null && p.signalCode === null) process.kill(-p.pid!, "SIGKILL");
  cleanup();
});

/** Окружение slot: своя очередь в каталоге теста; прогон самого теста может идти в CI или внутри слота — не в счёт. */
function envOf(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, AI_DEV_CONFIG_DIR: config, ...extra };
  for (const k of ["CI", "AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"]) if (!(k in extra)) delete env[k];
  return env;
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
const hold = (name: string) => start([`touch started-${name}; while [ ! -f release-${name} ]; do sleep 0.02; done`]);
const started = (name: string) => existsSync(path.join(dir, `started-${name}`));
const release = (name: string) => writeFileSync(path.join(dir, `release-${name}`), "");

async function until(cond: () => boolean, what: string) {
  for (const t0 = Date.now(); !cond(); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error(`не дождался: ${what}`);
}

/** Ждёт в очереди: напечатал, что ждёт. */
const waiting = (q: Queued, name: string) => until(() => q.err().includes("жду"), `${name} ждёт в очереди; stderr: ${q.err()}`);

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
    expect(c.err()).toContain("дождался");
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
