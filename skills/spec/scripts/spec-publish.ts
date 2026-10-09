#!/usr/bin/env bun
/**
 * spec-publish — publishing the generated documentation (docs/spec) to a separate branch (spec): the branch root is the
 * directory's contents, the commit message names the SHA it was built from. The documentation isn't committed to main:
 * it is a derived copy of the tests, and parallel PRs would conflict in its pages and table of contents.
 *
 * The working copy and HEAD aren't touched: the tree is built in a temporary index, the commit — `git commit-tree` on top
 * of the published one, the push — `<commit>:refs/heads/<branch>`. The same source — no new commit; the same contents
 * from a new source — a commit with the same tree and a new `Source:` (the branch names the last checked main); the
 * published `Source:` is a descendant of the new source — "already newer", the branch isn't touched. A rejected push (the
 * branch moved by a parallel publish, a hosting failure) — a pause of `--interval` × the attempt number, the branch is
 * re-read and the decision is made again, up to `--attempts` attempts. After the push the branch is read from the remote
 * and compared with the directory — exactly what was built is published. `--check` — comparison only.
 *
 *   bun spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--attempts 3] [--interval 5] [--check] [--root DIR]
 *
 * Codes: 0 — published, matches or already newer, 1 — the branch differs from the directory (or doesn't exist) with
 * --check, the push was rejected on all attempts, 2 — a call error (no directory, not git). Runs on Bun or Node ≥ 22.18,
 * no dependencies.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { sourceOf } from "./speclib.ts";

const USAGE =
  "spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--attempts 3] [--interval 5] [--check] [--root DIR]";

// a publish commit without a configured git user (CI) — in the name of the GitHub Actions bot
const BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };

class Fail extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function git(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}

function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** The directory's tree as a git object: a temporary index, --work-tree = the directory; the repository's .gitignore doesn't interfere (-f). */
function treeOf(root: string, dir: string): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "spec-publish-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    // cwd is the directory itself: index paths from its root; git-dir is the repository's (in a worktree — its own, objects shared)
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    git(dir, ["--git-dir", gitDir, "--work-tree", dir, "add", "-A", "-f", "."], env);
    return git(dir, ["--git-dir", gitDir, "write-tree"], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The branch's published commit on the remote (after fetch) or null if there is no branch. */
function remoteHead(root: string, remote: string, branch: string): string | null {
  if (!tryGit(root, ["ls-remote", "--exit-code", "--heads", remote, branch])) return null;
  git(root, ["fetch", "-q", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  return git(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
}

/** Paths by which the branch's tree differs from the directory's tree. */
function diffPaths(root: string, a: string, b: string): string[] {
  const out = git(root, ["diff-tree", "-r", "--name-only", "--no-commit-id", a, b]);
  return out ? out.split("\n") : [];
}

/** Why git refused: the last stderr lines without hints — the first error line names only the command. */
function reason(e: unknown): string {
  const stderr = String((e as { stderr?: unknown }).stderr ?? "");
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:"));
  return lines.length ? lines.slice(-3).join("; ") : (e as Error).message.split("\n")[0]!;
}

function count(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Fail(`--${name}: ожидается целое ≥ ${min}, получено «${value}»`, 2);
  return n;
}

function identity(root: string): Record<string, string> {
  const name = tryGit(root, ["config", "user.name"]) || BOT.name;
  const email = tryGit(root, ["config", "user.email"]) || BOT.email;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        dir: { type: "string", default: path.join("docs", "spec") },
        branch: { type: "string", default: "spec" },
        remote: { type: "string", default: "origin" },
        source: { type: "string" },
        attempts: { type: "string", default: "3" },
        interval: { type: "string", default: "5" },
        check: { type: "boolean", default: false },
        root: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-publish: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = opts.values;
  if (v.help) {
    console.error(USAGE);
    return 0;
  }
  try {
    const root = v.root ? path.resolve(v.root) : git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const dir = path.resolve(root, v.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Fail(`нет каталога ${v.dir} — сначала собрать документацию: spec-doc <отчёт> --out ${v.dir}`, 2);
    }
    const attempts = count("attempts", v.attempts, 1);
    const interval = count("interval", v.interval, 0);
    const tree = treeOf(root, dir);

    if (v.check) {
      const head = remoteHead(root, v.remote, v.branch);
      if (!head) throw new Fail(`ветки ${v.branch} на ${v.remote} нет — документация не опубликована`, 1);
      const published = git(root, ["rev-parse", `${head}^{tree}`]);
      if (published !== tree) throw new Fail(`${v.remote}/${v.branch} отличается: ${diffPaths(root, published, tree).join(", ")}`, 1);
      console.error(`spec-publish: ${v.remote}/${v.branch} совпадает с ${v.dir}`);
      return 0;
    }

    const source = v.source ?? git(root, ["rev-parse", "HEAD"]);
    const sha = tryGit(root, ["rev-parse", "--verify", "-q", `${source}^{commit}`]);
    const message = `spec: ${source.slice(0, 12)}\n\nSource: ${source}\n`;
    let same = false;
    let commit = "";
    // a push is rejected when the branch moved between fetch and push or on a hosting failure: each attempt re-reads the
    // branch and decides again — after a move it may turn out to be built from a descendant
    for (let attempt = 1; ; attempt++) {
      const head = remoteHead(root, v.remote, v.branch);
      const published = head ? git(root, ["rev-parse", `${head}^{tree}`]) : null;
      // publishes don't arrive in merge order (main runs are parallel): an old one isn't published on top of one built
      // from a descendant. Comparing needs history: in a shallow clone the published source is unknown — it is published
      const was = head ? sourceOf(git(root, ["log", "-1", "--format=%B", head])) : undefined;
      if (was && sha && sha !== was && tryGit(root, ["merge-base", "--is-ancestor", sha, was]) !== null) {
        console.error(`spec-publish: пропуск — ${v.remote}/${v.branch} уже новее: опубликовано из ${was.slice(0, 12)}`);
        return 0;
      }
      same = published === tree;
      if (same && (sha ?? source) === was) {
        console.error(`spec-publish: без изменений — ${v.remote}/${v.branch} уже совпадает с ${v.dir}`);
        return 0;
      }
      // the same tree from a new source is a commit too: `Source:` names the last checked main, and spec-diff sees a gap
      // with the diff base only after a skipped publish, not after every merge without spec changes
      commit = git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], identity(root));
      try {
        git(root, ["push", "-q", v.remote, `${commit}:refs/heads/${v.branch}`]);
        break;
      } catch (e) {
        const rejected = `пуш в ${v.remote}/${v.branch} отклонён (попытка ${attempt} из ${attempts}): ${reason(e)}`;
        if (attempt >= attempts) throw new Fail(rejected, 1);
        console.error(`spec-publish: ${rejected} — перечитываю ветку, повтор через ${interval * attempt} с`);
        await new Promise((resolve) => setTimeout(resolve, interval * attempt * 1000));
      }
    }
    // check what reached the reader: the branch on the remote, not our own commit
    const after = remoteHead(root, v.remote, v.branch);
    if (!after || git(root, ["rev-parse", `${after}^{tree}`]) !== tree) throw new Fail(`после пуша ${v.remote}/${v.branch} не совпадает с ${v.dir}`, 1);
    if (same) console.error(`spec-publish: без изменений — ${v.remote}/${v.branch} подтверждена для ${source.slice(0, 12)}`);
    else console.error(`spec-publish: опубликовано ${v.dir} → ${v.remote}/${v.branch} ${commit.slice(0, 12)} (из ${source.slice(0, 12)})`);
    return 0;
  } catch (e) {
    if (e instanceof Fail) {
      console.error(`spec-publish: ${e.message}`);
      return e.code;
    }
    console.error(`spec-publish: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
