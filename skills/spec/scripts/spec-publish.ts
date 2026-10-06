#!/usr/bin/env bun
/**
 * spec-publish — публикация сгенерированной документации (docs/spec) в отдельную ветку (spec): корень ветки —
 * содержимое каталога, в сообщении коммита — SHA, из которого собрано. В main документация не коммитится: это
 * производная копия тестов, и параллельные PR конфликтовали бы в её страницах и оглавлении.
 *
 * Рабочая копия и HEAD не трогаются: дерево собирается во временном индексе, коммит — `git commit-tree` поверх
 * опубликованного, пуш — `<коммит>:refs/heads/<ветка>`. Тот же исходник — без нового коммита; то же содержимое из
 * нового исходника — коммит с тем же деревом и новым `Source:` (ветка называет последний проверенный main); `Source:`
 * опубликованного — потомок нового исходника — «уже новее», ветка не трогается. Отклонённый пуш (ветку сдвинула
 * параллельная публикация, сбой хостинга) — пауза `--interval` × номер попытки, ветка перечитывается, и решение
 * принимается заново, до `--attempts` попыток. После пуша ветка читается с remote и сверяется с каталогом —
 * опубликовано ровно собранное. `--check` — только сверка.
 *
 *   bun spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--attempts 3] [--interval 5] [--check] [--root DIR]
 *
 * Коды: 0 — опубликовано, совпадает или уже новее, 1 — ветка отличается от каталога (или её нет) при --check, пуш отклонён
 * на всех попытках, 2 — ошибка вызова (нет каталога, не git). Запуск — Bun или Node ≥ 22.18, без зависимостей.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { sourceOf } from "./speclib.ts";

const USAGE =
  "spec-publish.ts [--dir docs/spec] [--branch spec] [--remote origin] [--source <sha>] [--attempts 3] [--interval 5] [--check] [--root DIR]";

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

/** Причина отказа git: последние строки stderr без подсказок — первая строка ошибки называет только команду. */
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
    // пуш отклоняют ветка, сдвинутая между fetch и push, и сбой хостинга: каждая попытка перечитывает ветку и решает
    // заново — после сдвига она может оказаться собранной из потомка
    for (let attempt = 1; ; attempt++) {
      const head = remoteHead(root, v.remote, v.branch);
      const published = head ? git(root, ["rev-parse", `${head}^{tree}`]) : null;
      // публикации приходят не по порядку мержей (прогоны main параллельны): поверх собранного из потомка старое не
      // публикуется. Сравнить можно только при истории: в мелком клоне опубликованный исходник неизвестен — публикуется
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
      // то же дерево из нового исходника — тоже коммит: `Source:` называет последний проверенный main, и spec-diff видит
      // разрыв с базой диффа только после пропущенной публикации, а не после каждого мержа без изменений спеки
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
  process.exitCode = await main(process.argv.slice(2));
}
