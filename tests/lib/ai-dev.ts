/**
 * Хелперы для тестов установщика ai-dev: песочница с HOME и проектом, запуск `bin/ai-dev.mjs`, пакет ai-dev с
 * правками, снимок дерева. Не спека — в документацию не попадает.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo, tmpDir, writeTree } from "./spec.ts";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const BIN = path.join(REPO, "bin/ai-dev.mjs");

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
 * HOME и git-проект во временном каталоге. PATH — только node, git, npm, npx и sh: агенты на машине определяются по
 * каталогам в HOME, а не по тому, что стоит у раннера. AI_DEV_REPO — пустой репозиторий: установщик из пакета ищет
 * релизы в нём, а не на GitHub, и тест не зависит от сети и настоящих релизов (#145); тест с релизами даёт своё зеркало.
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
  const cmds = ["node", "git", "npm", "npx", "sh"];
  const found = execFileSync("sh", ["-c", `for c in ${cmds.join(" ")}; do command -v "$c"; done`], { encoding: "utf8" }).trim().split("\n");
  cmds.forEach((cmd, i) => symlinkSync(found[i]!, path.join(bin, cmd)));
  return { tmp, home, proj, bin, env: { HOME: home, PATH: bin, AI_DEV_REPO: noReleases }, cleanup };
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `node <bin> …args` в песочнице; по умолчанию — установщик этого клона из каталога проекта. */
export function aiDev(sb: Sandbox, args: string[], opts: { cwd?: string; bin?: string; env?: Record<string, string> } = {}): Run {
  const r = spawnSync("node", [opts.bin ?? BIN, ...args], { cwd: opts.cwd ?? sb.proj, env: { ...sb.env, ...opts.env }, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Пакет ai-dev в dir — те же файлы, что публикует package.json (`files`), из этого клона с правками (null — удалить
 * файл или каталог); git-репозиторий на main с одним коммитом.
 */
export function aiDevPackage(dir: string, edits: Record<string, string | null> = {}) {
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  for (const rel of ["package.json", "bin", "AGENTS.md", "claude", "skills"]) cpSync(path.join(REPO, rel), path.join(dir, rel), { recursive: true });
  for (const f of readdirSync(path.join(REPO, "docs")).filter((n) => n.endsWith(".md"))) cpSync(path.join(REPO, "docs", f), path.join(dir, "docs", f));
  for (const [rel, content] of Object.entries(edits)) {
    if (content === null) rmSync(path.join(dir, rel), { recursive: true, force: true });
    else writeTree(dir, { [rel]: content });
  }
  const repo = gitRepo(dir);
  const sha = repo.commit({});
  return { dir, bin: path.join(dir, "bin/ai-dev.mjs"), sha, repo };
}

export type AiDevPackage = ReturnType<typeof aiDevPackage>;

/** Копия пакета вместе с `.git` в dir — без процессов git: пакет собирается один раз на файл теста. */
export function copyPackage(pkg: AiDevPackage, dir: string): AiDevPackage {
  cpSync(pkg.dir, dir, { recursive: true });
  return { dir, bin: path.join(dir, "bin/ai-dev.mjs"), sha: pkg.sha, repo: gitRepo(dir, { init: false }) };
}

/**
 * Пакет ai-dev, как его кладёт npx по `github:miroshnik/ai-dev[#<sha>]`: файлы src без `.git` — в
 * `<dir>/node_modules/ai-dev`, коммит — в `resolved` lock-файла npm. Установщик в нём — не клон. Возвращает его bin.
 */
export function npxPackage(dir: string, src: string, sha: string): string {
  const pkg = path.join(dir, "node_modules/ai-dev");
  cpSync(src, pkg, { recursive: true, filter: (p) => path.basename(p) !== ".git" });
  const resolved = `git+ssh://git@github.com/miroshnik/ai-dev.git#${sha}`;
  writeFileSync(path.join(dir, "node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/ai-dev": { resolved } } }));
  return path.join(pkg, "bin/ai-dev.mjs");
}

/**
 * npx песочницы отдаёт пакеты из dir (npxPackage): `github:miroshnik/ai-dev#<sha>` — `<dir>/<sha>`, без `#` —
 * `<dir>/main`; аргументы после пакета — установщику.
 */
export function npxServesPackages(sb: Sandbox, dir: string) {
  rmSync(path.join(sb.bin, "npx"), { force: true });
  const script = [
    "#!/bin/sh",
    'while [ "$#" -gt 0 ]; do case "$1" in github:*) spec="$1"; shift; break ;; *) shift ;; esac; done',
    'case "$spec" in *#*) pkg="${spec#*#}" ;; *) pkg=main ;; esac',
    `exec node "${dir}/$pkg/node_modules/ai-dev/bin/ai-dev.mjs" "$@"`,
  ].join("\n");
  writeFileSync(path.join(sb.bin, "npx"), script + "\n", { mode: 0o755 });
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
