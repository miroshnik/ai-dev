#!/usr/bin/env bun
/**
 * slot — a queue for heavy runs on the machine (the slot skill): a command goes when one of SLOTS slots is free, the rest
 * wait in arrival order and print whom they wait for. Parallel agent sessions ran the full check at once, each runner on
 * all cores, and the runs hit timeouts (tests/capabilities/slot).
 *
 * A slot is a ticket file `<time>-<pid>` in `slots/` of the personal configuration directory: the name sets the order, the
 * PID tells whether the owner is alive. A dead process, even one killed without cleanup, has its ticket ignored and removed
 * by the first one to see it: there are no locks to remove by hand. The command gets AI_DEV_SLOT_CPUS: all slots together
 * take half of the cores.
 *
 * No queue in CI (the machine is given to the run) and inside a slot (AI_DEV_SLOT): a script that calls another script
 * through the queue would otherwise wait for itself.
 *
 * Only node: APIs: a project's package.json script calls it both through node (≥ 22.18) and through bun.
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

/** Heavy runs on the machine at once. */
const SLOTS = 2;
/** Runner workers per slot: all slots together get half of the cores, the other half is for the human, the app and the agents. */
const CPUS = Math.max(1, Math.floor(os.availableParallelism() / 2 / SLOTS));
/** How often a waiting process looks at the queue, ms: a directory of a few files is read in microseconds. */
const POLL = 250;
/**
 * Pause before confirming "I am among the first SLOTS", ms: the ticket time is taken before the file is written, and a
 * ticket with an earlier time may not have reached the disk yet when the queue was read.
 */
const SETTLE = 50;
/** A waiting process reminds whom it waits for once per this many ms, even if the queue hasn't moved. */
const REMIND = 60_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Ticket {
  name: string;
  cwd?: string;
  cmd?: string;
  since?: number;
}

/** An argument for sh: a plain word as is, anything else in single quotes. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** Whether the process is alive: signal 0 only checks; EPERM — alive, but someone else's. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Live tickets in arrival order; tickets of dead processes are removed. */
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
      /* the ticket was just created and is still empty */
    }
    out.push({ ...info, name });
  }
  return out;
}

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} с` : `${Math.floor(ms / 60_000)} мин ${Math.round((ms % 60_000) / 1000)} с`);

/** Who holds the slot: the directory, the command and how long it has been running. */
function holder(t: Ticket) {
  const home = os.homedir();
  const cwd = t.cwd?.startsWith(home + path.sep) ? `~${t.cwd.slice(home.length)}` : (t.cwd ?? "?");
  const cmd = (t.cmd ?? "?").replace(/\s+/g, " ");
  return `${cwd}: ${cmd.length > 80 ? cmd.slice(0, 79) + "…" : cmd}${t.since ? ` (${duration(Date.now() - t.since)})` : ""}`;
}

/** The command through sh with the environment on top of our own; signals go to it. Exit code — its code, killed by a signal — 128 + number. */
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
  // while waiting, a signal removes the ticket and exits; in a slot, signals go to the command (run)
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
      enqueue(); // the ticket was removed from outside (the directory cleaned by hand) — the same place in the queue
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
