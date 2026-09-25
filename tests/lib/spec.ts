/**
 * Хелперы для тестов скилла spec: запуск скриптов через bun, временные каталоги, git-репозитории.
 * Не спека — в документацию не попадает.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = fileURLToPath(new URL("../../skills/spec/scripts/", import.meta.url));

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Запустить spec-doc / spec-diff как пользователь: `bun <скрипт>.ts …` или `node <скрипт>.ts …` (CI проекта без Bun). */
export function runScript(name: "spec-doc" | "spec-diff", args: string[], cwd: string, runtime: "bun" | "node" = "bun"): Run {
  const r = spawnSync(runtime, [path.join(SCRIPTS, name + ".ts"), ...args], { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Временный каталог; убирается в afterEach через возвращённый cleanup. */
export function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "spec-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Git-репозиторий во временном каталоге; commit пишет файлы (null — удалить) и возвращает SHA. */
export function gitRepo(dir: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  return {
    git,
    commit(files: Record<string, string | null>, message = "step"): string {
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) rmSync(path.join(dir, rel), { force: true });
        else writeTree(dir, { [rel]: content });
      }
      git("add", "-A");
      // автор и подпись — флагами, а не тремя git config: меньше сабпроцессов на тест
      git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}

/** Отчёт Vitest/Jest из краткого описания: файл → [describes…, имя, статус?]. */
export function vitestReport(root: string, files: Record<string, [string[], string, string?][]>): string {
  return JSON.stringify({
    numTotalTests: 0,
    testResults: Object.entries(files).map(([file, tests]) => ({
      name: path.join(root, file),
      status: "passed",
      assertionResults: tests.map(([ancestorTitles, title, status]) => ({
        ancestorTitles,
        title,
        fullName: [...ancestorTitles, title].join(" "),
        status: status ?? "passed",
        failureMessages: [],
      })),
    })),
  });
}
