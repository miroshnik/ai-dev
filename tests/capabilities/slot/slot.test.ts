import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { elves, sandbox } from "../../lib/elves.ts";
import { exitOf, SPAWN_TIMEOUT, unprivileged, unprivilegedOwns } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SLOT = fileURLToPath(new URL("../../../skills/slot/scripts/slot.ts", import.meta.url));
/** Установщик Elves — бинарь `elves` пакета. */
const ELVES = fileURLToPath(new URL("../../../bin/elves.ts", import.meta.url));
/** Шим очереди тонкого проекта: скрипт package.json подключает его перед командой. */
const SHIM = ".agents/slot.sh";
/** Начало скрипта package.json после установки флоу: его shell подключает шим, затем идёт команда. */
const SCRIPT = `. ${SHIM} && `;
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;

let dir: string;
let cleanup: () => void;
/** `node_modules/.bin` проекта: там `elves` пакета, `npm run` и `bun run` дают его скрипту на PATH. */
let bin: string;
let config: string;
let tmp: string;
let running: ChildProcess[];
/** Каталоги, закрытые тестом на запись: открываются до уборки, иначе её не удалить. */
let locked: string[];
/** Текст шима — какой ставит установщик в тонкий проект: один раз на файл. */
let shim: string;
/**
 * `slot` идёт от непривилегированного пользователя — в тестах песочницы: под root права не запрещают запись, и
 * закрытый каталог очереди не был бы закрыт (#598).
 */
let sandboxed = false;

beforeAll(() => {
  const sb = sandbox();
  try {
    expect(elves(sb, ["install"]).code).toBe(0);
    shim = readFileSync(path.join(sb.proj, SHIM), "utf8");
  } finally {
    sb.cleanup();
  }
});

beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  config = path.join(dir, "config");
  tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  running = [];
  locked = [];
  // тонкий проект: шим установщика и elves пакета из devDependencies — slot.ts этого клона
  bin = path.join(dir, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(ELVES, path.join(bin, "elves"));
  mkdirSync(path.join(dir, ".agents"));
  writeFileSync(path.join(dir, SHIM), shim);
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
 * очередь машины; прогон самого теста может идти в CI, внутри слота, в Claude Code или скриптом `bun run` — не в счёт.
 */
function envOf(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ELVES_CONFIG_DIR: config, TMPDIR: tmp, ...extra };
  for (const k of ["CI", "ELVES_SLOT", "ELVES_SLOT_CPUS", "AI_DEV_SLOT", "AI_DEV_SLOT_CPUS", "AI_DEV_CONFIG_DIR", "CLAUDE_TMPDIR", "npm_lifecycle_script", "npm_lifecycle_event"]) if (!(k in extra)) delete env[k];
  return env;
}

/** Каталог без записи — как каталог конфигурации в песочнице агента: читать можно, писать нельзя. */
function lock(d: string) {
  mkdirSync(d, { recursive: true });
  if (sandboxed) unprivilegedOwns(dir);
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
  /** Процесс вышел, и его stdout и stderr закрыты — их не держит и никто из его потомков. */
  closed: () => boolean;
}

/** `bun slot.ts …args` — от непривилегированного пользователя в тестах песочницы (`sandboxed`). */
const slot = (args: string[]): [string, string[]] => (sandboxed ? unprivileged("bun", [SLOT, ...args]) : ["bun", [SLOT, ...args]]);
/** `slot` фоном: своя группа процессов — тест убивает её целиком. */
const start = (args: string[], extra: Record<string, string> = {}) => track(spawn(...slot(args), { cwd: dir, env: envOf(extra), detached: true }));
/** Окружение скрипта package.json: `node_modules/.bin` проекта первым на PATH, как у `npm run`. */
const scriptEnv = (extra: Record<string, string> = {}) => envOf({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra });
/** Скрипт package.json фоном: shell, как у `npm run`, подключает шим и идёт командой. */
const startScript = (cmd: string, extra: Record<string, string> = {}) => track(spawn("sh", ["-c", SCRIPT + cmd], { cwd: dir, env: scriptEnv(extra), detached: true }));

function track(proc: ChildProcess): Queued {
  running.push(proc);
  let out = "";
  let err = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (err += d));
  const done = new Promise<number | string>((resolve) => proc.on("exit", (code, signal) => resolve(code ?? `сигнал ${signal}`)));
  let closed = false;
  proc.on("close", () => (closed = true));
  return { out: () => out, err: () => err, proc, done, closed: () => closed };
}

/** Команда, которая идёт, пока тест её не отпустит: `started-<имя>` — началась, `release-<имя>` — закончить. */
const holding = (name: string) => `touch started-${name}; while [ ! -f release-${name} ]; do sleep 0.02; done`;
/** Команда в слоте до отпускания. */
const hold = (name: string, extra: Record<string, string> = {}) => start([holding(name)], extra);
/** Скрипт package.json в слоте до отпускания. */
const holdScript = (name: string, extra: Record<string, string> = {}) => startScript(holding(name), extra);
const started = (name: string) => existsSync(path.join(dir, `started-${name}`));
const release = (name: string) => writeFileSync(path.join(dir, `release-${name}`), "");

async function until(cond: () => boolean, what: string) {
  for (const t0 = Date.now(); !cond(); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error(`не дождался: ${what}`);
}

/** Ждёт в очереди: напечатал, что ждёт. */
const waiting = (q: Queued, name: string) => until(() => q.err().includes("slot: waiting for the machine queue"), `${name} ждёт в очереди; stderr: ${q.err()}`);

/** Синхронный `slot`; таймаут — чтобы зависание в очереди упало с объяснением, а не таймаутом теста. */
function run(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(...slot(args), { cwd: dir, env: envOf(extra), encoding: "utf8", timeout: PATIENCE });
}

/** Синхронный скрипт package.json: `sh -c` с шимом перед командой. */
function runScript(cmd: string, extra: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", SCRIPT + cmd], { cwd: dir, env: scriptEnv(extra), encoding: "utf8", timeout: PATIENCE });
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
  it("команда получает четверть ядер в ELVES_SLOT_CPUS", () => {
    const r = run(['echo "$ELVES_SLOT_CPUS"']);
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

  /**
   * `elves slot '<команда>'` — прямой вызов из `node_modules/.bin` (#556) и обёртка скрипта на Yarn 2+ (#558): команда
   * идёт в процессе `elves`, и Bun, подгрузи он env-файлы рабочего каталога, отдал бы их ключи команде. Шебанг bin
   * запускает Bun с `--no-env-file` (tests/standards/no-env-file, #592).
   */
  it("elves slot '<команда>' из node_modules/.bin не отдаёт команде ключи env-файлов рабочего каталога", () => {
    writeFileSync(path.join(dir, ".env"), "ELVES_DOTENV=dotenv\n");
    writeFileSync(path.join(dir, ".env.local"), "ELVES_LEAK=prod-key\n");
    const probe = `echo "[$ELVES_DOTENV|$ELVES_LEAK]"`;
    // без NODE_ENV, как в терминале: под bun test он `test`, и `.env.local` Bun не берёт
    const bare = (env: NodeJS.ProcessEnv) => (delete env.NODE_ENV, env);
    const direct = spawnSync(path.join(bin, "elves"), ["slot", probe], { cwd: dir, env: bare(envOf()), encoding: "utf8", timeout: PATIENCE });
    const script = spawnSync("sh", ["-c", `elves slot '${probe}'`], { cwd: dir, env: bare(scriptEnv()), encoding: "utf8", timeout: PATIENCE });
    for (const r of [direct, script]) expect({ code: exitOf(r), stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: "[|]\n", stderr: "" });
  });
});

/**
 * Скрипт package.json не отдаёт команду slot строкой: его shell подключает шим `.agents/slot.sh`, тот зовёт `elves slot
 * --for $$` пакета проекта — слот на этот shell — и экспортирует переменные очереди, а команда остаётся обычной командой
 * скрипта — её видят инструменты, читающие package.json (knip, tests/capabilities/install). Шим и `elves` на PATH — как
 * в тонком проекте (#585).
 */
describe("Скрипт package.json берёт слот своим shell, команда остаётся командой скрипта", () => {
  it("скрипты стоят в общей очереди: слот держит shell скрипта, подключившего шим, пока тот не вышел", async () => {
    const [a, b] = [holdScript("a"), holdScript("b")];
    await until(() => started("a") && started("b"), "два скрипта стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    expect(started("c")).toBe(false);
    release("a");
    expect(await a.done).toBe(0);
    await until(() => started("c"), "третья стартовала после первого скрипта");
    for (const n of ["b", "c"]) release(n);
    expect([await b.done, await c.done]).toEqual([0, 0]);
  });

  it("команда скрипта получает четверть ядер и слот своего shell; вложенный скрипт идёт сразу", async () => {
    hold("a");
    await until(() => started("a"), "один слот занят");
    // скрипт занимает второй слот: вложенный без отметки «уже в слоте» ждал бы его вечно
    const r = runScript(`echo "$ELVES_SLOT_CPUS|$ELVES_SLOT|$$" && sh -c '${SCRIPT}echo inner'`);
    expect(exitOf(r)).toBe(0);
    const [cpus, slot, shell] = r.stdout.split("\n")[0]!.split("|");
    expect(cpus).toBe(String(Math.max(1, Math.floor(os.availableParallelism() / 4))));
    expect(slot).toMatch(new RegExp(`^\\d+-${shell}$`));
    expect(r.stdout.split("\n")[1]).toBe("inner");
    release("a");
  });

  // slot прошлого релиза — в проекте, копию которого update ещё не принёс: его вложенный вызов, конфиги раннеров и
  // turbo.json проекта знают только прежние имена переменных
  it("slot экспортирует ELVES_SLOT, ELVES_SLOT_CPUS и AI_DEV_SLOT, AI_DEV_SLOT_CPUS; вложенный вызов только с AI_DEV_SLOT своего слота не ждёт", async () => {
    hold("a");
    await until(() => started("a"), "один слот занят");
    const r = runScript(`echo "$ELVES_SLOT|$ELVES_SLOT_CPUS|$AI_DEV_SLOT|$AI_DEV_SLOT_CPUS" && sh -c 'unset ELVES_SLOT ELVES_SLOT_CPUS; ${SCRIPT}echo inner'`);
    expect(exitOf(r)).toBe(0);
    const [slot, cpus, formerSlot, formerCpus] = r.stdout.split("\n")[0]!.split("|");
    expect(slot).toMatch(/^\d+-\d+$/);
    expect(cpus).toBe(String(Math.max(1, Math.floor(os.availableParallelism() / 4))));
    expect([formerSlot, formerCpus]).toEqual([slot, cpus]);
    expect(r.stdout.split("\n")[1]).toBe("inner");
    release("a");
  });

  it("ожидающий видит команду скрипта, а не шим", async () => {
    holdScript("a", { npm_lifecycle_script: SCRIPT + holding("a") });
    hold("b");
    await until(() => started("a") && started("b"), "оба слота заняты");
    const c = hold("c");
    await waiting(c, "третья");
    expect(c.err()).toContain(`: ${holding("a")}`);
    expect(c.err()).not.toContain("slot.sh");
    for (const n of ["a", "b", "c"]) release(n);
    expect(await c.done).toBe(0);
  });

  it("в CI скрипт идёт сразу, без очереди и её переменных", async () => {
    hold("a");
    hold("b");
    await until(() => started("a") && started("b"), "оба слота заняты");
    const r = runScript('echo "ci[$ELVES_SLOT_CPUS]"', { CI: "true" });
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toBe("ci[]\n");
    for (const n of ["a", "b"]) release(n);
  });

  // elves пакета на PATH, а bun его шебанга — нет: elves падает с кодом 127
  it("elves не запустился — скрипт падает с его кодом, команда не идёт", () => {
    const sh = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
    const r = spawnSync(sh, ["-c", `${SCRIPT}echo ran`], { cwd: dir, env: envOf({ PATH: bin }), encoding: "utf8", timeout: PATIENCE });
    expect(exitOf(r)).toBe(127);
    expect(r.stdout).toBe("");
  });

  it("shell скрипта убит, пока ждал, — его slot выходит, а не ждёт за мёртвого", async () => {
    hold("a");
    hold("b");
    await until(() => started("a") && started("b"), "оба слота заняты");
    const w = holdScript("c");
    await waiting(w, "скрипт");
    // убит только shell: elves шима, который ждёт слот, остаётся сиротой; stderr скрипта держит и он — поток закрыт,
    // когда вышел и elves
    process.kill(w.proc.pid!, "SIGKILL");
    await until(w.closed, "elves шима вышел после убитого shell");
    expect(started("c")).toBe(false);
    expect(w.out()).toBe("");
    for (const n of ["a", "b"]) release(n);
  });

  /**
   * Проект без копии флоу берёт slot из пакета `@miroshnik/elves` в devDependencies: шим скрипта зовёт `elves slot --for
   * $$` — тот же slot.ts пакета, та же очередь и те же переменные (#556).
   */
  it("elves slot --for печатает экспорт очереди, как slot.ts", () => {
    const shells = [spawn("sleep", ["60"], { detached: true }), spawn("sleep", ["60"], { detached: true })] as const;
    running.push(...shells);
    const [a, b] = shells.map((s) => s.pid!);
    const viaElves = spawnSync("bun", ["--no-env-file", ELVES, "slot", "--for", String(a)], { cwd: dir, env: envOf(), encoding: "utf8", timeout: PATIENCE });
    const viaSlot = run(["--for", String(b)]);
    expect({ code: exitOf(viaElves), stderr: viaElves.stderr }).toEqual({ code: 0, stderr: "" });
    expect(exitOf(viaSlot)).toBe(0);
    expect(viaElves.stdout).toMatch(new RegExp(`^export ELVES_SLOT=\\d+-${a} ELVES_SLOT_CPUS=\\d+ `));
    const shape = (out: string, pid: number) => out.replaceAll(`-${pid}`, "-<shell>").replace(/=\d{15}-/g, "=<time>-");
    expect(shape(viaElves.stdout, a!)).toBe(shape(viaSlot.stdout, b!));
  });

  it("--for без PID живого процесса — код 2 с объяснением", () => {
    for (const args of [["--for"], ["--for", "0"], ["--for", "x"]]) {
      const r = run(args);
      expect(exitOf(r)).toBe(2);
      expect(r.stderr).toContain("--for takes the PID of a running shell");
    }
  });
});

describe("Без очереди — там, где она лишняя или ждала бы сама себя", () => {
  it("в CI команда идёт сразу, без очереди", async () => {
    hold("a");
    hold("b");
    await until(() => started("a") && started("b"), "оба слота заняты");
    const r = run(['echo "ci[$ELVES_SLOT_CPUS]"'], { CI: "true" });
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
  beforeEach(() => ((sandboxed = true), unprivilegedOwns(dir)));
  afterEach(() => (sandboxed = false));

  it("без записи в каталог конфигурации очередь идёт через временный каталог", async () => {
    lock(path.join(config, "slots"));
    const [a, b] = [hold("a"), hold("b")];
    await until(() => started("a") && started("b"), "две первые команды стартовали");
    const c = hold("c");
    await waiting(c, "третья");
    expect(readdirSync(path.join(tmp, "elves", "slots"))).toHaveLength(3);
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
    expect(readdirSync(path.join(tmp, "elves", "slots"))).toHaveLength(1);
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

  // slot прошлого релиза в песочнице кладёт билет в ai-dev/slots временного каталога
  it("очередь видит билеты slot прошлого релиза в ai-dev/slots временного каталога", async () => {
    const former = path.join(tmp, "ai-dev", "slots");
    mkdirSync(former, { recursive: true });
    const sleeper = spawn("sleep", ["60"], { detached: true });
    running.push(sleeper);
    for (const pid of [process.pid, sleeper.pid!]) writeFileSync(path.join(former, `${String(Date.now()).padStart(15, "0")}-${pid}`), JSON.stringify({ cwd: dir, cmd: "bun test" }));
    const c = hold("c");
    await waiting(c, "команда за билетами прежнего slot");
    expect(started("c")).toBe(false);
    process.kill(sleeper.pid!, "SIGKILL");
    await until(() => started("c"), "команда стартовала после убитого прежнего прогона");
    release("c");
    expect(await c.done).toBe(0);
  });

  it("очереди нет — одна строка предупреждения, команда идёт без неё", () => {
    lock(path.join(config, "slots"));
    lock(path.join(tmp, "elves", "slots"));
    const r = run(['echo "ran[$ELVES_SLOT_CPUS]"; exit 3']);
    expect(exitOf(r)).toBe(3);
    expect(r.stdout).toBe("ran[]\n");
    expect(r.stderr).toMatch(/^slot: [^\n]*without the queue[^\n]*\n$/);
  });
});
