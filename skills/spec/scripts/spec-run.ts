#!/usr/bin/env bun
/**
 * spec-run — the green run that checked the merge commit's tree, for publishing the spec on a PR merge (without CI on
 * main): the run id goes to stdout, `gh run download` downloads the artifact `docs-spec-<tree hash>` from it. A PR run
 * checks the merge-ref and names the artifact by its tree; the merge commit has the same tree only if nothing was merged
 * into main between the run's start and the merge — then main is checked as a whole. A PR that fell behind was merged —
 * there is no such artifact, and publishing is skipped: from its head's run it would roll the spec branch back (the pages
 * of a PR merged earlier would vanish from it).
 *
 * Among this repository's runs with an unexpired artifact of the tree: a green one exists — it (the newest); one is
 * running — polling until its outcome, not finished by the ceiling — an error; otherwise (no artifact, expired, from a
 * fork, the run isn't green) — skip: code 0, stdout empty, the reason in a stderr line.
 *
 * `--artifact <name>` — for spec-shard: the newest green run of this repository with an unexpired artifact of that name
 * (the `spec` job's reports — durations of the last green run). Without waiting: a run in progress isn't green yet, the
 * previous green one does. In Actions (`GITHUB_RUN_ID`) — green by the start of the current run's first attempt: every
 * shard of the run gets one answer whenever it reaches the step, a re-run of failed shards too. None — code 0, stdout
 * empty, the reason in stderr: the shards are split by count.
 *
 *   bun spec-run.ts --tree <hash> [--timeout 1800] [--interval 15]
 *   bun spec-run.ts --artifact <name>
 *
 * Codes: 0 — found or publishing skipped, 1 — the run didn't finish by the ceiling, 2 — a call error (arguments, gh).
 * Runs under Bun, no dependencies; needs `gh` with a token (in Actions — `GH_TOKEN`, `actions: read`).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const USAGE = "spec-run --tree <hash> [--timeout 1800] [--interval 15]\nspec-run --artifact <name>";
/** `--help`, `-h` (tests/standards/cli-help): the synopsis, what it does and examples. */
const HELP = `${USAGE}

The green run that checked the merge commit's tree: its id to stdout, for gh run download of docs-spec-<tree hash>; no
such run — skip: code 0, stdout empty, the reason in stderr. Code 1 — the run didn't finish by the ceiling, 2 — a call
error. --artifact — the newest green run with an unexpired artifact of that name, without waiting (for spec-shard); in
Actions (GITHUB_RUN_ID) — green by the start of this run's first attempt: one answer for all of its shards.

Examples:
  spec-run --tree "$(git rev-parse 'HEAD^{tree}')"
  spec-run --artifact spec-reports`;

interface Artifact {
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run: { id: number; repository_id: number; head_repository_id: number } | null;
}

/** A run (`runs/<id>` — its latest attempt) or one attempt of it (`runs/<id>/attempts/<k>`). */
interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_attempt?: number;
  run_started_at?: string;
  /** a completed attempt isn't updated any more: its finish */
  updated_at?: string;
}

class Fail extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function api<T>(endpoint: string): T {
  try {
    return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as T;
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Fail(`gh api ${endpoint}: ${stderr || (e as Error).message.split("\n")[0]}`, 2);
  }
}

const time = (iso: string | undefined): number => Date.parse(iso ?? "");

/**
 * Ids of the runs with a live artifact, newest first. Only this repository's runs count: a PR run from a fork can upload
 * an artifact with any name too. `before` — only artifacts uploaded by then: a run finished by a moment uploaded its
 * artifact before it. A page of 100: newer artifacts keep coming while a run lasts, an older source stays on it.
 */
function runIds(artifact: string, before?: number): number[] {
  const { artifacts } = api<{ artifacts: Artifact[] }>(`repos/{owner}/{repo}/actions/artifacts?name=${encodeURIComponent(artifact)}&per_page=100`);
  const own = artifacts.filter(
    (a) => !a.expired && a.workflow_run && a.workflow_run.head_repository_id === a.workflow_run.repository_id && !(time(a.created_at) > (before ?? Infinity)),
  );
  // a rerun uploads the artifact again under the same run id
  return [...new Set(own.map((a) => a.workflow_run!.id))];
}

/** The outcome — a separate request for the run: the artifact is uploaded mid-run and doesn't prove a green outcome. */
const runOf = (id: number): Run => api<Run>(`repos/{owner}/{repo}/actions/runs/${id}`);

/** The moment the shards' source is fixed at (`--artifact`) and the run it belongs to. */
interface Anchor {
  run: string;
  at: number;
  iso: string;
}

/**
 * The start of the current run's first attempt (`GITHUB_RUN_ID` in Actions). The newest green run "now" depends on when
 * a shard reaches the step: a run that finished between two shards' requests gave them different layouts, and files ran
 * in two shards or in none. By a fixed moment every shard gets one answer. The first attempt, not the current one: a
 * re-run of failed jobs keeps the passed shards of the first attempt with their layout. Outside Actions — none.
 */
function anchor(): Anchor | null {
  const run = process.env.GITHUB_RUN_ID;
  if (!run) return null;
  const first = api<Run>(`repos/{owner}/{repo}/actions/runs/${run}/attempts/1`);
  const at = time(first.run_started_at);
  if (Number.isNaN(at)) throw new Fail(`run ${run}: attempt 1 has no run_started_at`, 2);
  return { run, at, iso: first.run_started_at! };
}

/**
 * The run as it was at `at`: its latest attempt started by then. A re-run of the run started later doesn't change the
 * answer — the previous attempts are asked; null — the run started later.
 */
function asOf(id: number, at: number): Run | null {
  let run = runOf(id);
  for (let k = (run.run_attempt ?? 1) - 1; time(run.run_started_at) > at; k--) {
    if (k < 1) return null;
    run = api<Run>(`repos/{owner}/{repo}/actions/runs/${id}/attempts/${k}`);
  }
  return run;
}

/** Green by the moment `at` (none — now): succeeded and finished by then, a later finish counts as unfinished. */
const greenBy = (run: Run, at?: number): boolean =>
  run.status === "completed" && run.conclusion === "success" && !(at !== undefined && time(run.updated_at) > at);

/** The run's state for the "no green run" line: its outcome, or status, and whether it finished after the moment. */
function stateOf(run: Run, at?: number): string {
  const late = at !== undefined && run.status === "completed" && time(run.updated_at) > at;
  return `${run.id} ${run.conclusion ?? run.status}${late ? " (finished later)" : ""} ${run.html_url}`;
}

/**
 * The newest green run with the artifact (`--artifact`): runs are asked newest first, up to the first green one. In
 * Actions — as of the start of the current run (`anchor`).
 */
function latest(artifact: string): number {
  const by = anchor();
  const at = by?.at;
  const when = by ? ` before run ${by.run} started (${by.iso})` : "";
  const asked: string[] = [];
  for (const id of runIds(artifact, at)) {
    const run = at === undefined ? runOf(id) : asOf(id, at);
    if (!run) {
      asked.push(`${id} started later`);
      continue;
    }
    if (greenBy(run, at)) {
      console.error(`spec-run: artifact ${artifact}: run ${run.id} succeeded${when} — ${run.html_url}`);
      process.stdout.write(`${run.id}\n`);
      return 0;
    }
    asked.push(stateOf(run, at));
  }
  const why = asked.length ? asked.join(", ") : `no artifact ${artifact}`;
  console.error(`spec-run: artifact ${artifact}: no green run${when} — ${why}`);
  return 0;
}

const seconds = (name: string, value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Fail(`--${name}: a number of seconds is needed, not «${value}»\n${USAGE}`, 2);
  return n;
};

export async function main(argv: string[]): Promise<number> {
  try {
    let opts;
    try {
      opts = parseArgs({
        args: argv,
        options: {
          tree: { type: "string" },
          artifact: { type: "string" },
          timeout: { type: "string", default: "1800" },
          interval: { type: "string", default: "15" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (e) {
      throw new Fail(`${(e as Error).message}\n${USAGE}`, 2);
    }
    const v = opts.values;
    if (v.help) return console.log(HELP), 0;
    if (v.tree && v.artifact) throw new Fail(`--tree and --artifact don't go together\n${USAGE}`, 2);
    if (v.artifact) return latest(v.artifact);
    if (!v.tree) throw new Fail(`--tree <hash> or --artifact <name> is required\n${USAGE}`, 2);
    if (!/^[0-9a-f]{40,64}$/.test(v.tree)) throw new Fail(`--tree: a full tree hash is needed (git rev-parse 'HEAD^{tree}'), not «${v.tree}»\n${USAGE}`, 2);
    const timeout = seconds("timeout", v.timeout);
    const interval = seconds("interval", v.interval);
    const artifact = `docs-spec-${v.tree}`;
    const at = `main tree ${v.tree.slice(0, 12)}`;
    const deadline = Date.now() + timeout * 1000;
    let said = "";
    for (;;) {
      const all = runIds(artifact).map(runOf);
      // the listing is newest first: of several green runs the latest is taken
      const ok = all.find((r) => r.status === "completed" && r.conclusion === "success");
      if (ok) {
        console.error(`spec-run: ${at}: run ${ok.id} succeeded — ${ok.html_url}`);
        process.stdout.write(`${ok.id}\n`);
        return 0;
      }
      const going = all.filter((r) => r.status !== "completed");
      if (!going.length) {
        // not an error: a PR that fell behind was merged — no run checked such a main, the spec branch waits for the next merge
        const why = all.length ? all.map((r) => `${r.id} ${r.conclusion} ${r.html_url}`).join(", ") : `no artifact ${artifact}`;
        console.error(`spec-run: ${at} not fully checked — publishing skipped: ${why}`);
        return 0;
      }
      if (Date.now() >= deadline) throw new Fail(`${at}: run ${going.map((r) => r.id).join(", ")} didn't finish in ${timeout} s`, 1);
      const now = `${at}: run ${going.map((r) => `${r.id} ${r.status}`).join(", ")} — waiting`;
      // only a change of state goes to the log, not a line on every poll
      if (now !== said) console.error(`spec-run: ${(said = now)}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval * 1000, Math.max(0, deadline - Date.now()))));
    }
  } catch (e) {
    console.error(`spec-run: ${(e as Error).message}`);
    return e instanceof Fail ? e.code : 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
