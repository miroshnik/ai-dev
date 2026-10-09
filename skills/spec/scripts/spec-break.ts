#!/usr/bin/env bun
/**
 * spec-break — a check by breaking: can the check fail. Applies an edit to the project's source, runs the test command,
 * expects red and always rolls the edit back; prints ✅ (failed) / ❌ (didn't fail) for each break. The agent picks the
 * break for one check — this is a proof, not mutation testing.
 *
 *   bun spec-break.ts --file <file> --find <fragment> --replace <replacement> [--name <name>] [--no-baseline] -- <test command…>
 *   bun spec-break.ts --plan breaks.json [--no-baseline] [-- <test command…>]
 *   bun spec-break.ts --restore
 *
 * A plan is JSON `[{ name, file, find, replace, cmd? }]`: `cmd` — a string for `sh -c`, without it — the command after
 * `--`. The `find` fragment occurs in the file exactly once. Each break is a separate run: the first red test in a serial
 * group hides the rest. Before the breaks — a baseline run of each command: red even without a break, ✅ would prove
 * nothing — code 2 (`--no-baseline` skips it).
 *
 * Rollback: after the run; on SIGINT, SIGTERM, SIGHUP the test command is killed together with its processes and the
 * file is restored. For an abort with no chance of rollback (kill -9, a closed session) a journal is written before the
 * break (`.git/spec-break.json`, outside git — `.spec-break.json`), and the next run or `--restore` restores the file
 * from it; the file was edited after the abort — the journal doesn't touch it, code 2. Codes: 0 — failed on every break,
 * 1 — there is a ❌, 2 — a call error, a red baseline run, the journal not applied.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = [
  "spec-break.ts --file <файл> --find <фрагмент> --replace <замена> [--name <название>] [--no-baseline] -- <команда теста…>",
  "spec-break.ts --plan breaks.json [--no-baseline] [-- <команда теста…>]",
  "spec-break.ts --restore",
].join("\n");

interface Break {
  name: string;
  file: string;
  find: string;
  replace: string;
  cmd?: string;
}

/** The test command: argv after `--` or a plan string for `sh -c`. */
type Command = string[];

/** A record of an applied break: by it the next run restores the file if the rollback didn't happen. */
interface Journal {
  name: string;
  file: string;
  original: string;
  broken: string;
}

class Failure extends Error {}

function journalPath(): string {
  const r = spawnSync("git", ["rev-parse", "--git-path", "spec-break.json"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : path.resolve(".spec-break.json");
}

/** Restore the file from the journal of an aborted run; no journal — nothing. The file was edited after the break — leave it. */
function restoreJournal(journal: string): void {
  if (!existsSync(journal)) return;
  const j = JSON.parse(readFileSync(journal, "utf8")) as Journal;
  const rel = path.relative(process.cwd(), j.file) || j.file;
  const now = existsSync(j.file) ? readFileSync(j.file, "utf8") : null;
  if (now === j.original) {
    rmSync(journal);
    return;
  }
  if (now !== j.broken) {
    throw new Failure(`${rel} изменён после поломки «${j.name}» — журнал ${journal} не применён: сверь файл руками и удали журнал`);
  }
  writeFileSync(j.file, j.original);
  rmSync(journal);
  console.log(`spec-break: вернул ${rel} после оборванного прогона (поломка «${j.name}»)`);
}

/** The break is applicable: the file exists, the fragment occurs in it exactly once. */
function check(b: Break): void {
  if (!existsSync(b.file)) throw new Failure(`поломка «${b.name}»: файла ${b.file} нет`);
  const n = readFileSync(b.file, "utf8").split(b.find).length - 1;
  if (n === 0) throw new Failure(`поломка «${b.name}»: «${b.find}» в ${b.file} не найден`);
  if (n > 1) throw new Failure(`поломка «${b.name}»: «${b.find}» в ${b.file} встречается ${n} раза — сделай фрагмент длиннее`);
}

let child: ReturnType<typeof spawn> | null = null;
let applied: { journal: string; j: Journal } | null = null;

/** Roll the applied break back: the file to its original state, the journal away. */
function undo(): void {
  if (!applied) return;
  writeFileSync(applied.j.file, applied.j.original);
  rmSync(applied.journal, { force: true });
  applied = null;
}

/** Run the command in its own process group (a signal goes to the whole group); the exit code and the output tail. */
function run(cmd: Command): Promise<{ code: number; tail: string }> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const p = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child = p;
    const keep = (d: Buffer) => {
      out.push(d.toString("utf8"));
      if (out.length > 200) out.splice(0, out.length - 200);
    };
    p.stdout!.on("data", keep);
    p.stderr!.on("data", keep);
    p.on("error", (e) => {
      child = null;
      reject(new Failure(`команда теста не запустилась: ${cmd.join(" ")}: ${e.message}`));
    });
    p.on("close", (code, signal) => {
      child = null;
      resolve({ code: code ?? (signal ? 128 : 1), tail: out.join("").split("\n").slice(-20).join("\n") });
    });
  });
}

function onSignal(signal: NodeJS.Signals): void {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* the group has already exited */
    }
  }
  const file = applied && path.relative(process.cwd(), applied.j.file);
  undo();
  console.error(`spec-break: прервано (${signal})${file ? ` — ${file} возвращён` : ""}`);
  process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
}

const label = (cmd: Command) => (cmd[0] === "sh" && cmd[1] === "-c" ? cmd[2]! : cmd.join(" "));

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        name: { type: "string" },
        plan: { type: "string" },
        restore: { type: "boolean", default: false },
        "no-baseline": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-break: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = opts.values;
  if (v.help) {
    console.error(USAGE);
    return 0;
  }
  const journal = journalPath();
  try {
    restoreJournal(journal);
    if (v.restore) return 0;

    const fallback: Command = opts.positionals;
    let breaks: Break[];
    if (v.plan) {
      breaks = JSON.parse(readFileSync(v.plan, "utf8")) as Break[];
      if (!Array.isArray(breaks) || !breaks.length) throw new Failure(`план ${v.plan} — непустой массив [{ name, file, find, replace, cmd? }]`);
    } else if (v.file && v.find !== undefined && v.replace !== undefined) {
      breaks = [{ name: v.name ?? `${v.find} → ${v.replace}`, file: v.file, find: v.find, replace: v.replace }];
    } else {
      throw new Failure(`нужна поломка: --file, --find и --replace или --plan\n${USAGE}`);
    }
    const cmdOf = (b: Break): Command => (b.cmd ? ["sh", "-c", b.cmd] : fallback);
    for (const b of breaks) {
      if (!cmdOf(b).length) throw new Failure(`поломка «${b.name}»: нет команды теста — после -- или в cmd плана`);
      check(b);
    }

    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, onSignal);

    if (!v["no-baseline"]) {
      const cmds = new Map(breaks.map((b) => [JSON.stringify(cmdOf(b)), cmdOf(b)]));
      for (const cmd of cmds.values()) {
        const r = await run(cmd);
        if (r.code !== 0) throw new Failure(`прогон красный и без поломки — поломки не применены: ${label(cmd)} (код ${r.code})\n${r.tail}`);
      }
    }

    let caught = 0;
    for (const b of breaks) {
      const original = readFileSync(b.file, "utf8");
      const j: Journal = { name: b.name, file: path.resolve(b.file), original, broken: original.replace(b.find, () => b.replace) };
      // the journal goes before the edit: if aborted after it, the next run finds what to restore
      writeFileSync(journal, JSON.stringify(j));
      applied = { journal, j };
      writeFileSync(j.file, j.broken);
      let r: { code: number };
      try {
        r = await run(cmdOf(b));
      } finally {
        undo();
      }
      if (r.code !== 0) {
        caught++;
        console.log(`✅ упал: ${b.name} (${b.file})`);
      } else {
        console.log(`❌ не упал: ${b.name} (${b.file}) — проверка эту поломку не ловит`);
      }
    }
    console.log(`итог: ${caught} из ${breaks.length} поломок уронили проверку; файлы в исходном виде`);
    return caught === breaks.length ? 0 : 1;
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    console.error(`spec-break: ${e.message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
