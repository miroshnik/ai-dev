/**
 * Хелперы для тестов установщика Elves: песочница с HOME и проектом, запуск `bin/elves.ts`, пакет Elves с
 * правками, снимок дерева. Не спека — в документацию не попадает.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo, tmpDir, writeTree } from "./spec.ts";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const BIN = path.join(REPO, "bin/elves.ts");

export interface Sandbox {
  tmp: string;
  home: string;
  proj: string;
  /** каталог PATH песочницы */
  bin: string;
  env: Record<string, string>;
  cleanup: () => void;
}

/**
 * HOME и git-проект во временном каталоге. PATH — только bun прогона, git и sh: агенты на машине определяются по
 * каталогам в HOME, а не по тому, что стоит у раннера; bunx в PATH нет — его даёт тест, которому он нужен
 * (bunxServesPackages). ELVES_REPO — пустой репозиторий: установщик из пакета ищет релизы в нём, а не на GitHub, и
 * тест не зависит от сети и настоящих релизов (#145); тест с релизами даёт своё зеркало. TMPDIR — каталог песочницы:
 * временные каталоги установщика (история для списка изменений `update`) — в нём, а не в системном /tmp, куда песочница
 * агента не пускает. BUN_JSC_useJIT — из окружения прогона: дочерний bun на macOS — без JIT
 * (tests/standards/spawn-no-jit). Кеш транспиляции bun выключен: bun кладёт его в HOME (`~/Library/Caches/bun`), а
 * тесты сверяют HOME песочницы снимком — это машина, где установщик пишет только своё.
 */
export function sandbox(): Sandbox {
  const { dir: tmp, cleanup } = tmpDir();
  const home = path.join(tmp, "home");
  const proj = path.join(tmp, "proj");
  const bin = path.join(tmp, "bin");
  for (const d of [home, proj, bin]) mkdirSync(d);
  execFileSync("git", ["init", "-q"], { cwd: proj });
  const noReleases = path.join(tmp, "no-releases.git");
  execFileSync("git", ["init", "-q", "--bare", noReleases]);
  const cmds = ["git", "sh"];
  const found = execFileSync("sh", ["-c", `for c in ${cmds.join(" ")}; do command -v "$c"; done`], { encoding: "utf8" }).trim().split("\n");
  cmds.forEach((cmd, i) => symlinkSync(found[i]!, path.join(bin, cmd)));
  symlinkSync(process.execPath, path.join(bin, "bun"));
  const env: Record<string, string> = { HOME: home, PATH: bin, TMPDIR: tmp, ELVES_REPO: noReleases, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  if (process.env.BUN_JSC_useJIT) env.BUN_JSC_useJIT = process.env.BUN_JSC_useJIT;
  return { tmp, home, proj, bin, env, cleanup };
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `bun <bin> …args` в песочнице; по умолчанию — установщик этого клона из каталога проекта; input — на stdin. */
export function elves(sb: Sandbox, args: string[], opts: { cwd?: string; bin?: string; env?: Record<string, string>; input?: string } = {}): Run {
  const r = spawnSync(process.execPath, [opts.bin ?? BIN, ...args], { cwd: opts.cwd ?? sb.proj, env: { ...sb.env, ...opts.env }, encoding: "utf8", input: opts.input });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Пакет Elves в dir — те же файлы, что публикует package.json (`files`), из этого клона с правками (null — удалить
 * файл или каталог); git-репозиторий на main с одним коммитом.
 */
export function elvesPackage(dir: string, edits: Record<string, string | null> = {}) {
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  for (const rel of ["package.json", "bin", "AGENTS.md", "claude", "skills"]) cpSync(path.join(REPO, rel), path.join(dir, rel), { recursive: true });
  for (const f of readdirSync(path.join(REPO, "docs")).filter((n) => n.endsWith(".md"))) cpSync(path.join(REPO, "docs", f), path.join(dir, "docs", f));
  for (const [rel, content] of Object.entries(edits)) {
    if (content === null) rmSync(path.join(dir, rel), { recursive: true, force: true });
    else writeTree(dir, { [rel]: content });
  }
  const repo = gitRepo(dir);
  const sha = repo.commit({});
  return { dir, bin: path.join(dir, "bin/elves.ts"), sha, repo };
}

export type ElvesPackage = ReturnType<typeof elvesPackage>;

/** Копия пакета вместе с `.git` в dir — без процессов git: пакет собирается один раз на файл теста. */
export function copyPackage(pkg: ElvesPackage, dir: string): ElvesPackage {
  cpSync(pkg.dir, dir, { recursive: true });
  return { dir, bin: path.join(dir, "bin/elves.ts"), sha: pkg.sha, repo: gitRepo(dir, { init: false }) };
}

/**
 * Пакет Elves, как его кладёт bunx по `github:miroshnik/elves[#<sha>]`: файлы src без `.git` — в
 * `<dir>/node_modules/elves`, спецификатор — в `<dir>/package.json`: с SHA — пакет, поставленный по SHA (релиз),
 * без SHA (sha null) — пакет из main, пускатель. Установщик в нём — не клон. name — имя зависимости: `elves` — по
 * имени репозитория, `@miroshnik/elves` — по имени пакета, в `node_modules/@miroshnik/elves`. Возвращает его bin.
 */
export function bunxPackage(dir: string, src: string, sha: string | null, name = "elves"): string {
  const pkg = path.join(dir, "node_modules", name);
  cpSync(src, pkg, { recursive: true, filter: (p) => path.basename(p) !== ".git" });
  const spec = `github:miroshnik/elves${sha ? `#${sha}` : ""}`;
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { [name]: spec } }, null, 2) + "\n");
  return path.join(pkg, "bin/elves.ts");
}

/**
 * bunx песочницы отдаёт пакеты из dir (bunxPackage): `github:miroshnik/elves#<sha>` — `<dir>/<sha>`, без `#` —
 * `<dir>/main`; флаги bunx до пакета пропускает, аргументы после пакета — установщику, под bun прогона.
 */
export function bunxServesPackages(sb: Sandbox, dir: string) {
  rmSync(path.join(sb.bin, "bunx"), { force: true });
  const script = [
    "#!/bin/sh",
    'while [ "$#" -gt 0 ]; do case "$1" in github:*) spec="$1"; shift; break ;; *) shift ;; esac; done',
    'case "$spec" in *#*) pkg="${spec#*#}" ;; *) pkg=main ;; esac',
    `exec "${process.execPath}" "${dir}/$pkg/node_modules/elves/bin/elves.ts" "$@"`,
  ].join("\n");
  writeFileSync(path.join(sb.bin, "bunx"), script + "\n", { mode: 0o755 });
}

/**
 * Установка прошлого релиза — до переименования флоу в Elves (#545) — из свежей установки в root (проект или HOME):
 * то же содержимое под прежними именами, как его писал тогдашний установщик, — манифест `.agents/ai-dev.json`, канон
 * `.agents/ai-dev/`, симлинки правил `.claude/rules/ai-dev.md` и `ai-dev-claude.md` в него, блоки `ai-dev:begin` …
 * `ai-dev:end` в AGENTS.md и .gitignore с путями прежних имён.
 */
export function toFormer(root: string) {
  const at = (rel: string) => path.join(root, rel);
  const exists = (rel: string) => lstatSync(at(rel), { throwIfNoEntry: false }) !== undefined;
  for (const [from, to] of [
    [".agents/elves.json", ".agents/ai-dev.json"],
    [".agents/elves", ".agents/ai-dev"],
  ] as const) {
    if (exists(from)) renameSync(at(from), at(to));
  }
  for (const [from, to] of [
    ["elves.md", "ai-dev.md"],
    ["elves-claude.md", "ai-dev-claude.md"],
  ] as const) {
    const rel = `.claude/rules/${from}`;
    if (!exists(rel)) continue;
    const target = readlinkSync(at(rel)).replace(".agents/elves/", ".agents/ai-dev/");
    rmSync(at(rel));
    symlinkSync(target, at(`.claude/rules/${to}`));
  }
  for (const rel of ["AGENTS.md", ".gitignore"]) {
    if (!exists(rel)) continue;
    const text = readFileSync(at(rel), "utf8");
    writeFileSync(at(rel), text.replace(/\belves:(begin|end)\b/g, "ai-dev:$1").replace(/\.agents\/elves\b/g, ".agents/ai-dev").replace(/rules\/elves\b/g, "rules/ai-dev"));
  }
}

/** Дерево каталога: путь → содержимое файла или «-> цель» симлинка; в `.git` не заходит. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) (out[`${rel}/`] = ""), walk(p);
      else out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}
