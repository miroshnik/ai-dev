/**
 * Фейковый реестр npm для тестов установки в проект: пакет `@miroshnik/elves` нужных версий — tarball из одного
 * package.json или из файлов пакета, — его отдаёт сервер отдельным процессом (registry-server.ts). Менеджер пакетов проекта ходит в него по
 * `npm_config_registry` — переменной npm, её читает и bun. Сеть и настоящий реестр тестам не нужны. Не спека.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tmpDir, writeTree } from "./spec.ts";

const SERVER = fileURLToPath(new URL("registry-server.ts", import.meta.url));

export interface Registry {
  /** адрес реестра */
  url: string;
  /** окружение менеджера пакетов: реестр — этот */
  env: Record<string, string>;
  stop(): void;
}

/**
 * Реестр с пакетом `@miroshnik/elves` версий versions; адрес — когда сервер слушает порт. pkg — файлы пакета
 * (elvesPackage) с версией в его package.json: bin пакета из реестра запускается — bunx и менеджером пакетов проекта;
 * без pkg — один package.json.
 */
export async function npmRegistry(versions: string[], pkg?: string): Promise<Registry> {
  const { dir, cleanup } = tmpDir();
  const files = path.join(dir, "files");
  mkdirSync(files);
  for (const version of versions) {
    const src = path.join(dir, "src", version);
    if (pkg) {
      cpSync(pkg, path.join(src, "package"), { recursive: true, filter: (p) => path.basename(p) !== ".git" });
      const json = path.join(src, "package/package.json");
      writeFileSync(json, JSON.stringify({ ...JSON.parse(readFileSync(json, "utf8")), version }, null, 2) + "\n");
      cpSync(json, path.join(files, `${version}.json`));
    } else writeTree(src, { "package/package.json": JSON.stringify({ name: "@miroshnik/elves", version }, null, 2) + "\n" });
    execFileSync("tar", ["-czf", path.join(files, `${version}.tgz`), "-C", src, "package"]);
  }
  const proc = Bun.spawn([process.execPath, "--no-env-file", SERVER, files], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`реестр не запустился: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = /^PORT (\d+)/.exec(out)?.[1];
  if (!port) throw new Error(`реестр не назвал порт: ${out}`);
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    env: { npm_config_registry: url },
    stop() {
      proc.kill();
      cleanup();
    },
  };
}
