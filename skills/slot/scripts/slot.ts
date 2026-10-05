#!/usr/bin/env bun
/**
 * slot — очередь тяжёлых прогонов на машине (скилл slot): команда идёт, когда свободен один из SLOTS слотов, остальные
 * ждут по порядку прихода и печатают, кого ждут. Параллельные сессии агентов гоняли полную проверку разом, каждый
 * раннер — на все ядра, и прогоны упирались в таймауты (tests/capabilities/slot).
 *
 * Слот — файл-билет `<время>-<pid>` в `slots/` каталога личной конфигурации: имя задаёт порядок, PID — жив ли
 * владелец. Процесс умер, даже убитый без уборки, — его билет не в счёт и убирается первым, кто его увидит: замков,
 * которые снимают руками, нет. Команде — AI_DEV_SLOT_CPUS: все слоты вместе берут половину ядер.
 *
 * Без очереди: в CI (машина отдана прогону) и внутри слота (AI_DEV_SLOT) — скрипт, который зовёт другой скрипт из
 * очереди, иначе ждал бы сам себя.
 *
 * Только node:-API: скрипт package.json проекта зовёт его и через node (≥ 22.18), и через bun.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE = `Использование: slot '<команда>' [аргументы…]

  slot '<команда>' [аргументы…]   команда — через sh, аргументы — в её конец, как у npm run; ждёт, пока идут два
                                  тяжёлых прогона машины, затем идёт с AI_DEV_SLOT_CPUS — четвертью ядер
Без очереди — в CI и внутри слота. Код выхода — код команды.
`;

/** Тяжёлых прогонов на машине одновременно. */
const SLOTS = 2;
/** Воркеров раннеру в слоте: все слоты вместе — половина ядер, вторая — человеку, приложению и самим агентам. */
const CPUS = Math.max(1, Math.floor(os.availableParallelism() / 2 / SLOTS));
/** Как часто ожидающий смотрит очередь, мс: каталог из нескольких файлов читается за микросекунды. */
const POLL = 250;
/**
 * Пауза перед подтверждением «я в первых SLOTS», мс: время билета берётся до записи файла, и билет с более ранним
 * временем мог ещё не лечь на диск, когда очередь читали.
 */
const SETTLE = 50;
/** Ожидающий напоминает, кого ждёт, раз в столько мс, даже если очередь не двигалась. */
const REMIND = 60_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Ticket {
  name: string;
  cwd?: string;
  cmd?: string;
  since?: number;
}

/** Аргумент в sh: простое слово — как есть, остальное — в одинарных кавычках. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** Жив ли процесс: сигнал 0 только проверяет; EPERM — жив, но чужой. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Живые билеты по порядку прихода; билеты умерших процессов убираются. */
function queue(dir: string): Ticket[] {
  const out: Ticket[] = [];
  for (const name of readdirSync(dir).sort()) {
    const pid = Number(/^\d+-(\d+)$/.exec(name)?.[1]);
    if (!pid) continue;
    if (!alive(pid)) {
      rmSync(path.join(dir, name), { force: true });
      continue;
    }
    let info = {};
    try {
      info = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      /* билет только создан и ещё пуст */
    }
    out.push({ ...info, name });
  }
  return out;
}

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} с` : `${Math.floor(ms / 60_000)} мин ${Math.round((ms % 60_000) / 1000)} с`);

/** Кто держит слот: каталог, команда и сколько идёт. */
function holder(t: Ticket) {
  const home = os.homedir();
  const cwd = t.cwd?.startsWith(home + path.sep) ? `~${t.cwd.slice(home.length)}` : (t.cwd ?? "?");
  const cmd = (t.cmd ?? "?").replace(/\s+/g, " ");
  return `${cwd}: ${cmd.length > 80 ? cmd.slice(0, 79) + "…" : cmd}${t.since ? ` (${duration(Date.now() - t.since)})` : ""}`;
}

/** Команда через sh с окружением поверх своего; сигналы — ей. Код выхода — её код, убита сигналом — 128 + номер. */
function run(command: string, env: Record<string, string>) {
  return new Promise<number>((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit", env: { ...process.env, ...env } });
    for (const s of SIGNALS) process.on(s, () => child.kill(s));
    child.on("error", (e) => {
      process.stderr.write(`slot: ${e.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? 128 + (signal ? os.constants.signals[signal] : 0)));
  });
}

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "-h" || first === "--help") return process.stdout.write(USAGE), 0;
  if (!first) return process.stderr.write(USAGE), 2;
  const command = [first, ...rest.map(quote)].join(" ");
  const ci = process.env.CI && !/^(0|false)$/i.test(process.env.CI);
  if (ci || process.env.AI_DEV_SLOT) return run(command, {});

  const dir = path.join(process.env.AI_DEV_CONFIG_DIR || path.join(os.homedir(), ".config", "ai-dev"), "slots");
  const name = `${String(Date.now()).padStart(15, "0")}-${process.pid}`;
  const file = path.join(dir, name);
  const enqueue = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ cwd: process.cwd(), cmd: command, since: Date.now() }));
  };
  const drop = () => rmSync(file, { force: true });
  process.on("exit", drop);
  // пока ждём — сигнал снимает билет и завершает; в слоте сигналы уходят команде (run)
  const quit = (s: NodeJS.Signals) => (drop(), process.exit(128 + os.constants.signals[s]));
  for (const s of SIGNALS) process.on(s, quit);
  enqueue();

  const t0 = Date.now();
  let confirmed = false;
  let told = "";
  let toldAt = 0;
  for (;;) {
    let q = queue(dir);
    let i = q.findIndex((t) => t.name === name);
    if (i < 0) {
      enqueue(); // билет убрали снаружи (каталог очищен руками) — то же место в очереди
      q = queue(dir);
      i = q.findIndex((t) => t.name === name);
    }
    if (i >= 0 && i < SLOTS) {
      if (confirmed) break;
      confirmed = true;
      await new Promise((r) => setTimeout(r, SETTLE));
      continue;
    }
    confirmed = false;
    const holders = q.slice(0, SLOTS);
    const who = holders.map((t) => t.name).join(" ");
    if (who !== told || Date.now() - toldAt >= REMIND) {
      const ahead = i - SLOTS;
      process.stderr.write(`slot: жду очередь машины — идут ${holders.map(holder).join("; ")}${ahead ? `; впереди ещё ${ahead}` : ""}\n`);
      [told, toldAt] = [who, Date.now()];
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
  for (const s of SIGNALS) process.off(s, quit);
  if (told) process.stderr.write(`slot: дождался за ${duration(Date.now() - t0)}\n`);
  const code = await run(command, { AI_DEV_SLOT: name, AI_DEV_SLOT_CPUS: String(CPUS) });
  drop();
  return code;
}

process.exit(await main(process.argv.slice(2)));
