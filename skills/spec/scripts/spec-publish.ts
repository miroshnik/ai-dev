#!/usr/bin/env bun
/**
 * spec-publish — публикация сгенерированной документации (docs/spec) в отдельную ветку (spec): корень ветки —
 * содержимое каталога, в сообщении коммита — SHA, из которого собрано. В main документация не коммитится: это
 * производная копия тестов, и параллельные PR конфликтовали бы в её страницах и оглавлении.
 *
 * Рабочая копия и HEAD не трогаются: дерево собирается во временном индексе, коммит — `git commit-tree` поверх
 * опубликованного, пуш — `<коммит>:refs/heads/<ветка>`. Тот же исходник — без нового коммита; то же содержимое из
 * нового исходника — коммит с тем же деревом и новым `Source:` (ветка называет последний проверенный main); `Source:`
 * опубликованного — потомок нового исходника — «уже новее», ветка не трогается. После пуша ветка читается с remote и
 * сверяется с каталогом — опубликовано ровно собранное. `--check` — только сверка.
 *
 *   bun spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--check] [--root DIR]
 *
 * Коды: 0 — опубликовано, совпадает или уже новее, 1 — ветка отличается от каталога (или её нет) при --check, пуш отклонён,
 * 2 — ошибка вызова (нет каталога, не git). Запуск — Bun или Node ≥ 22.18, без зависимостей.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = "spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--check] [--root DIR]";

// коммит публикации без настроенного git user (CI) — от имени бота GitHub Actions
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

/** Дерево каталога как объект git: временный индекс, --work-tree = каталог; .gitignore репозитория не мешает (-f). */
function treeOf(root: string, dir: string): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "spec-publish-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    // cwd — сам каталог: пути индекса от его корня; git-dir — репозитория (в worktree — свой, объекты общие)
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    git(dir, ["--git-dir", gitDir, "--work-tree", dir, "add", "-A", "-f", "."], env);
    return git(dir, ["--git-dir", gitDir, "write-tree"], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Опубликованный коммит ветки на remote (после fetch) или null, если ветки нет. */
function remoteHead(root: string, remote: string, branch: string): string | null {
  if (!tryGit(root, ["ls-remote", "--exit-code", "--heads", remote, branch])) return null;
  git(root, ["fetch", "-q", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  return git(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
}

/** Пути, которыми дерево ветки отличается от дерева каталога. */
function diffPaths(root: string, a: string, b: string): string[] {
  const out = git(root, ["diff-tree", "-r", "--name-only", "--no-commit-id", a, b]);
  return out ? out.split("\n") : [];
}

function identity(root: string): Record<string, string> {
  const name = tryGit(root, ["config", "user.name"]) || BOT.name;
  const email = tryGit(root, ["config", "user.email"]) || BOT.email;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

export function main(argv: string[]): number {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        dir: { type: "string", default: path.join("docs", "spec") },
        branch: { type: "string", default: "spec" },
        remote: { type: "string", default: "origin" },
        source: { type: "string" },
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
    const tree = treeOf(root, dir);
    const head = remoteHead(root, v.remote, v.branch);
    const published = head ? git(root, ["rev-parse", `${head}^{tree}`]) : null;

    if (v.check) {
      if (!head) throw new Fail(`ветки ${v.branch} на ${v.remote} нет — документация не опубликована`, 1);
      if (published !== tree) throw new Fail(`${v.remote}/${v.branch} отличается: ${diffPaths(root, published!, tree).join(", ")}`, 1);
      console.error(`spec-publish: ${v.remote}/${v.branch} совпадает с ${v.dir}`);
      return 0;
    }

    const source = v.source ?? git(root, ["rev-parse", "HEAD"]);
    // публикации приходят не по порядку мержей: поверх собранного из потомка старое не публикуется. Сравнить можно
    // только при истории: в мелком клоне (CI на main) опубликованный исходник неизвестен — публикуется, как всегда
    const was = head ? /^Source: ([0-9a-f]{40,64})$/m.exec(git(root, ["log", "-1", "--format=%B", head]))?.[1] : undefined;
    const sha = tryGit(root, ["rev-parse", "--verify", "-q", `${source}^{commit}`]);
    if (was && sha && sha !== was && tryGit(root, ["merge-base", "--is-ancestor", sha, was]) !== null) {
      console.error(`spec-publish: пропуск — ${v.remote}/${v.branch} уже новее: опубликовано из ${was.slice(0, 12)}`);
      return 0;
    }
    const same = published === tree;
    if (same && (sha ?? source) === was) {
      console.error(`spec-publish: без изменений — ${v.remote}/${v.branch} уже совпадает с ${v.dir}`);
      return 0;
    }
    // то же дерево из нового исходника — тоже коммит: `Source:` называет последний проверенный main, и spec-diff видит
    // разрыв с базой диффа только после пропущенной публикации, а не после каждого мержа без изменений спеки
    const message = `spec: ${source.slice(0, 12)}\n\nSource: ${source}\n`;
    const commit = git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], identity(root));
    try {
      git(root, ["push", "-q", v.remote, `${commit}:refs/heads/${v.branch}`]);
    } catch (e) {
      throw new Fail(`пуш в ${v.remote}/${v.branch} отклонён (ветку обновили параллельно?): ${(e as Error).message.split("\n")[0]}`, 1);
    }
    // проверяю то, что дошло до читателя: ветку на remote, а не свой коммит
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
  process.exitCode = main(process.argv.slice(2));
}
