#!/usr/bin/env bun
/**
 * slot — a queue for heavy runs on the machine (the slot skill): a command goes when one of SLOTS slots is free, the rest
 * wait in arrival order and print whom they wait for. Parallel agent sessions ran the full check at once, each runner on
 * all cores, and the runs hit timeouts (tests/capabilities/slot).
 *
 * A slot is a ticket file `<time>-<pid>` in `slots/` of the personal configuration directory: the name sets the order, the
 * PID tells whether the owner is alive. A dead process, even one killed without cleanup, has its ticket ignored and removed
 * by the first one to see it: there are no locks to remove by hand. The command gets ELVES_SLOT_CPUS: all slots together
 * take half of the cores.
 *
 * An agent's sandbox doesn't let the configuration be written: the ticket goes to `elves/slots` of the temp directory
 * (Claude Code's sandbox gives all sessions of the user one TMPDIR), and the queue is read from all places at once — runs
 * inside and outside the sandbox wait for each other. No place takes the ticket — one warning line and the command runs
 * without the queue.
 *
 * No queue in CI (the machine is given to the run) and inside a slot (ELVES_SLOT): a script that calls another script
 * through the queue would otherwise wait for itself.
 *
 * The flow's former name (#545): a project whose copy `update` hasn't brought yet runs the slot of an earlier release —
 * it queues in its own place of the temp directory (FORMER_TEMP), exports only the queue variables under the former name
 * (FORMER_ENV), and its runner configs and `turbo.json` pass those. So the queue is read from the former temp place too,
 * the queue variables go under both names, and either name marks a nested call.
 *
 * A package.json script takes its slot with `--for <shell PID>` (the project's shim `.agents/slot.sh` runs `elves slot
 * --for $$`): the ticket carries the script's shell, not this process, and the queue variables are printed for the shell
 * to export — the command runs as a plain command of the script, visible to tools that read package.json (knip).
 *
 * Runs under Bun (`bun slot.ts`), only node: APIs. A project without a copy of the flow runs it from its package as
 * `elves slot` (bin/elves.ts imports `main` and `HELP`): the queue starts only when this file is the entry point.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `--help`, `-h` as the first argument — the rest go to the command (tests/standards/cli-help): synopsis, what, examples;
 * `elves slot` prints it under its name.
 */
export const HELP = `slot '<command>' [arguments…]
slot --for <PID>

Runs the command through sh, the arguments appended to its end, as with npm run; waits while two heavy runs are going on
the machine, then runs with ELVES_SLOT_CPUS — a quarter of the cores. --for — takes a slot for the shell <PID> of a
package.json script, held until the shell exits, and prints the export of ELVES_SLOT, ELVES_SLOT_CPUS for it — the
project's shim runs it: ". .agents/slot.sh && <command>". No queue in CI and inside a slot. The exit code is the
command's; with --for — 0, nothing printed without the queue.

Examples:
  slot 'vitest run'
  slot 'bun test' tests/standards
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
/**
 * The queue variables under the flow's former name, exported next to ours for one transition: runner configs and
 * `turbo.json` of projects read and pass `AI_DEV_SLOT_CPUS` and `AI_DEV_SLOT` until they are renamed, and the slot of an
 * earlier release marks a nested call with `AI_DEV_SLOT` only.
 */
const FORMER_ENV = { ELVES_SLOT: "AI_DEV_SLOT", ELVES_SLOT_CPUS: "AI_DEV_SLOT_CPUS" } as const;
/** The temp directory's place of the slot of an earlier release (FORMER_ENV): its tickets are read, ours aren't written there. */
const FORMER_TEMP = "ai-dev";

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

/**
 * Where tickets live, in the order a ticket is written: the personal configuration, then the temp directory — an agent's
 * sandbox doesn't let the configuration be written, while its TMPDIR is shared by the sandbox's sessions; Claude Code
 * passes its sandbox's temp directory as CLAUDE_TMPDIR outside the sandbox too, so runs outside wait for runs inside.
 * The personal configuration directory — the same expression in all scripts (tests/standards/config-dir).
 */
function places() {
  const config = process.env.ELVES_CONFIG_DIR || process.env.AI_DEV_CONFIG_DIR || [path.join(os.homedir(), ".config", "elves"), path.join(os.homedir(), ".config", "ai-dev")].find((d) => existsSync(d)) || path.join(os.homedir(), ".config", "elves");
  const temps = [os.tmpdir(), process.env.CLAUDE_TMPDIR].filter((d): d is string => !!d);
  return [...new Set([config, ...temps.map((d) => path.join(d, "elves"))].map((d) => path.join(path.resolve(d), "slots")))];
}

/** Places the queue is read from: ours and the temp places of the slot of an earlier release (FORMER_TEMP). */
function readPlaces(dirs: string[]) {
  const former = [os.tmpdir(), process.env.CLAUDE_TMPDIR].filter((d): d is string => !!d).map((d) => path.join(path.resolve(d), FORMER_TEMP, "slots"));
  return [...new Set([...dirs, ...former])];
}

/** Live tickets of all places in arrival order; tickets of dead processes are removed where the directory can be written. */
function queue(dirs: string[]): Ticket[] {
  const out: Ticket[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // no one has queued here yet
    }
    for (const name of names) {
      const pid = Number(/^\d+-(\d+)$/.exec(name)?.[1]);
      if (!pid) continue;
      if (!alive(pid)) {
        try {
          rmSync(path.join(dir, name), { force: true });
        } catch {
          /* a sandbox can't write here: the ticket just doesn't count, a run outside the sandbox removes it */
        }
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
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** A path under the home directory — from `~`. */
function tilde(p: string) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Who holds the slot: the directory, the command and how long it has been running. */
function holder(t: Ticket) {
  const cwd = t.cwd ? tilde(t.cwd) : "?";
  const cmd = (t.cmd ?? "?").replace(/\s+/g, " ");
  return `${cwd}: ${cmd.length > 80 ? cmd.slice(0, 79) + "…" : cmd}${t.since ? ` (${duration(Date.now() - t.since)})` : ""}`;
}

/**
 * The command of the package.json script that sourced the shim, for whoever waits for its slot: npm and bun give the
 * script's text in npm_lifecycle_script — without the shim's prefix (`. .agents/slot.sh &&`, a copy's slot.sh of an
 * earlier install) it is the command; otherwise the script's name.
 */
function scriptCommand() {
  const text = process.env.npm_lifecycle_script;
  return text ? text.replace(/^\.\s+\S*slot\.sh\s*&&\s*/, "") : process.env.npm_lifecycle_event;
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

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "-h" || first === "--help") return process.stdout.write(HELP), 0;
  if (!first) return process.stderr.write(HELP), 2;
  // --for: the slot is the shell's — it holds the ticket, gets the variables and runs the command itself
  const shell = first === "--for" ? Number(rest[0]) : 0;
  if (first === "--for" && !(rest.length === 1 && Number.isInteger(shell) && shell > 0 && alive(shell))) {
    return process.stderr.write(`slot: --for takes the PID of a running shell, got ${rest.join(" ") || "nothing"}\n${HELP}`), 2;
  }
  const command = [first, ...rest.map(quote)].join(" ");
  // without the queue the command goes at once; a script's shell has nothing to export
  const free = () => (shell ? 0 : run(command, {}));
  const ci = process.env.CI && !/^(0|false)$/i.test(process.env.CI);
  if (ci || process.env.ELVES_SLOT || process.env[FORMER_ENV.ELVES_SLOT]) return free();

  const dirs = places();
  const read = readPlaces(dirs);
  const name = `${String(Date.now()).padStart(15, "0")}-${shell || process.pid}`;
  let file = "";
  const enqueue = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ cwd: process.cwd(), cmd: shell ? scriptCommand() : command, since: Date.now() }));
  };
  const refused: string[] = [];
  for (const dir of dirs) {
    file = path.join(dir, name);
    try {
      enqueue();
      break;
    } catch (e) {
      refused.push(`${tilde(dir)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
      file = "";
    }
  }
  if (!file) {
    process.stderr.write(`slot: running without the queue — no place takes the ticket: ${refused.join(", ")}\n`);
    return free();
  }
  // the shell's ticket stays when we exit with its slot: the queue removes it when the shell is gone
  let held = false;
  const drop = () => {
    if (!held) rmSync(file, { force: true });
  };
  process.on("exit", drop);
  // while waiting, a signal removes the ticket and exits; in a slot, signals go to the command (run)
  const quit = (s: NodeJS.Signals) => (drop(), process.exit(128 + os.constants.signals[s]));
  for (const s of SIGNALS) process.on(s, quit);

  const t0 = Date.now();
  let confirmed = false;
  let told = "";
  let toldAt = 0;
  for (;;) {
    // the shell is gone while waiting (killed) — its ticket would be put back forever
    if (shell && !alive(shell)) return 1;
    let q = queue(read);
    let i = q.findIndex((t) => t.name === name);
    if (i < 0) {
      enqueue(); // the ticket was removed from outside (the directory cleaned by hand) — the same place in the queue
      q = queue(read);
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
      process.stderr.write(`slot: waiting for the machine queue — running ${holders.map(holder).join("; ")}${ahead ? `; ${ahead} more ahead` : ""}\n`);
      [told, toldAt] = [who, Date.now()];
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
  for (const s of SIGNALS) process.off(s, quit);
  if (told) process.stderr.write(`slot: waited ${duration(Date.now() - t0)}\n`);
  const own = { ELVES_SLOT: name, ELVES_SLOT_CPUS: String(CPUS) };
  const env = { ...own, ...Object.fromEntries(Object.entries(own).map(([k, v]) => [FORMER_ENV[k as keyof typeof own], v])) };
  if (shell) {
    held = true;
    process.stdout.write(`export ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
    return 0;
  }
  const code = await run(command, env);
  drop();
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
