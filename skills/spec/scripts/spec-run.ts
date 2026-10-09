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
 *   bun spec-run.ts --tree <hash> [--timeout 1800] [--interval 15]
 *
 * Codes: 0 — found or publishing skipped, 1 — the run didn't finish by the ceiling, 2 — a call error (arguments, gh).
 * Runs on Bun or Node ≥ 22.18, no dependencies; needs `gh` with a token (in Actions — `GH_TOKEN`, `actions: read`).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const USAGE = "spec-run.ts --tree <hash> [--timeout 1800] [--interval 15]";

interface Artifact {
  name: string;
  expired: boolean;
  workflow_run: { id: number; repository_id: number; head_repository_id: number } | null;
}

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
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

/**
 * Runs with a live artifact of the tree. Only this repository's runs count: a PR run from a fork can upload an artifact
 * with any name too. The outcome — a separate request for the run: the artifact is uploaded mid-run and doesn't prove a
 * green outcome.
 */
function runs(artifact: string): Run[] {
  const { artifacts } = api<{ artifacts: Artifact[] }>(`repos/{owner}/{repo}/actions/artifacts?name=${artifact}`);
  const own = artifacts.filter((a) => !a.expired && a.workflow_run && a.workflow_run.head_repository_id === a.workflow_run.repository_id);
  // a rerun uploads the artifact again under the same run id
  const ids = [...new Set(own.map((a) => a.workflow_run!.id))];
  return ids.map((id) => api<Run>(`repos/{owner}/{repo}/actions/runs/${id}`));
}

const seconds = (name: string, value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Fail(`--${name}: нужно число секунд, а не «${value}»\n${USAGE}`, 2);
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
          timeout: { type: "string", default: "1800" },
          interval: { type: "string", default: "15" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (e) {
      throw new Fail(`${(e as Error).message}\n${USAGE}`, 2);
    }
    const v = opts.values;
    if (v.help) {
      console.error(USAGE);
      return 0;
    }
    if (!v.tree) throw new Fail(`нужен --tree <hash>\n${USAGE}`, 2);
    if (!/^[0-9a-f]{40,64}$/.test(v.tree)) throw new Fail(`--tree: нужен полный хеш дерева (git rev-parse 'HEAD^{tree}'), а не «${v.tree}»\n${USAGE}`, 2);
    const timeout = seconds("timeout", v.timeout);
    const interval = seconds("interval", v.interval);
    const artifact = `docs-spec-${v.tree}`;
    const at = `дерево main ${v.tree.slice(0, 12)}`;
    const deadline = Date.now() + timeout * 1000;
    let said = "";
    for (;;) {
      const all = runs(artifact);
      // the listing is newest first: of several green runs the latest is taken
      const ok = all.find((r) => r.status === "completed" && r.conclusion === "success");
      if (ok) {
        console.error(`spec-run: ${at}: прогон ${ok.id} успешен — ${ok.html_url}`);
        process.stdout.write(`${ok.id}\n`);
        return 0;
      }
      const going = all.filter((r) => r.status !== "completed");
      if (!going.length) {
        // not an error: a PR that fell behind was merged — no run checked such a main, the spec branch waits for the next merge
        const why = all.length ? all.map((r) => `${r.id} ${r.conclusion} ${r.html_url}`).join(", ") : `артефакта ${artifact} нет`;
        console.error(`spec-run: ${at} не проверено целиком — публикация пропущена: ${why}`);
        return 0;
      }
      if (Date.now() >= deadline) throw new Fail(`${at}: прогон ${going.map((r) => r.id).join(", ")} не завершился за ${timeout} с`, 1);
      const now = `${at}: прогон ${going.map((r) => `${r.id} ${r.status}`).join(", ")} — ждём`;
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
