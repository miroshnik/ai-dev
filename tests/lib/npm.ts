/**
 * Пакет Elves в npm, как его публикует CI по тегу релиза: копия файлов пакета (`elvesPackage`), в ней `elves pack <тег>`,
 * затем `npm pack` — tarball; проект ставит его `bun install` из devDependencies, как из реестра. Собирается один раз
 * на прогон (сборка и упаковка — пара секунд), каталог убирается при выходе процесса. Не спека.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { elvesPackage, REPO } from "./elves.ts";
import { writeTree } from "./spec.ts";

/** Тег релиза, из которого собран пакет тестов, и его версия в npm. */
export const PACK_TAG = "v2026.10.15.1";
export const PACK_VERSION = "2026.1015.1";

let base: string | undefined;
let tarball: string | undefined;

/** Общий каталог пакета и проектов прогона: кеши npm и bun — в нём, а не в HOME (песочница агента туда не пускает). */
function root(): string {
  if (base) return base;
  const dir = (base = mkdtempSync(path.join(os.tmpdir(), "elves-npm-")));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Процесс с проверкой: упал — ошибка с его выводом, а не молчаливый пустой результат. */
function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: код ${r.status ?? r.signal ?? r.error?.message}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** Tarball пакета `@miroshnik/elves` релиза PACK_TAG: `elves pack` в копии пакета и `npm pack`. */
export function npmTarball(): string {
  if (tarball) return tarball;
  const dir = root();
  const pkg = elvesPackage(path.join(dir, "package"));
  run(process.execPath, ["--no-env-file", pkg.bin, "pack", PACK_TAG], pkg.dir);
  const out = path.join(dir, "tarball");
  mkdirSync(out);
  const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", out], pkg.dir, { npm_config_cache: path.join(dir, "npm-cache"), npm_config_update_notifier: "false" })) as { filename: string }[];
  return (tarball = path.join(out, info!.filename));
}

/**
 * Проект без копии флоу: package.json с пакетом в devDependencies и файлы, затем `bun install` — пакет из tarball, как
 * из реестра; `vitest` — ссылкой на Vitest Elves (своего node_modules у временного проекта нет). Возвращает каталог.
 */
export function packageProject(name: string, files: Record<string, string> = {}, pkg: Record<string, unknown> = {}): string {
  const from = npmTarball();
  const dir = path.join(root(), "projects", name);
  rmSync(dir, { recursive: true, force: true });
  writeTree(dir, { "package.json": JSON.stringify({ name, private: true, ...pkg, devDependencies: { "@miroshnik/elves": `file:${from}` } }, null, 2) + "\n", ...files });
  run(process.execPath, ["install"], dir, { BUN_INSTALL_CACHE_DIR: path.join(root(), "bun-cache") });
  for (const dep of ["vitest", "@playwright/test", "playwright", "playwright-core"]) {
    const at = path.join(dir, "node_modules", dep);
    mkdirSync(path.dirname(at), { recursive: true });
    symlinkSync(path.join(REPO, "node_modules", dep), at);
  }
  return dir;
}
