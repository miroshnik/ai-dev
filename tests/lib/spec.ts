/**
 * Хелперы для тестов скилла spec: запуск скриптов через bun, временные каталоги, git-репозитории.
 * Не спека — в документацию не попадает.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = fileURLToPath(new URL("../../skills/spec/scripts/", import.meta.url));

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Запустить spec-doc / spec-diff как пользователь: `bun <скрипт>.ts …`;
 * `env` — поверх окружения прогона (заглушка `gh` в PATH).
 */
export function runScript(
  name: "spec-doc" | "spec-diff" | "spec-publish" | "spec-run" | "spec-shard" | "spec-claims" | "spec-break" | "spec-exceptions",
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Run {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name + ".ts"), ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// `gh` для spec-run — внешний край, подменяется он. Два вызова `gh api` (REST GitHub Actions): артефакты репозитория с
// фильтром по имени — из artifacts.json; прогон по id — из runs.json, `{ id: [ответ на каждый опрос…] }`, последний
// повторяется. Вызовы — в calls.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH/calls"
[ "$1" = api ] || { echo "fake gh: $*" >&2; exit 1; }
case "$2" in
  "repos/{owner}/{repo}/actions/artifacts?name="*)
    jq -c --arg name "\${2#*name=}" '[.[] | select(.name == $name)] | { total_count: length, artifacts: . }' "$FAKE_GH/artifacts.json" ;;
  "repos/{owner}/{repo}/actions/runs/"*)
    id="\${2##*/}"; n=$(cat "$FAKE_GH/n-$id" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_GH/n-$id"
    jq -ce --arg id "$id" --argjson n "$n" '.[$id] | (.[$n] // .[-1])' "$FAKE_GH/runs.json" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

/** Артефакт в ответе `gh api …/actions/artifacts`: у прогона PR из форка head_repository_id — id форка. */
export interface GhArtifact {
  id: number;
  name: string;
  expired: boolean;
  workflow_run: { id: number; repository_id: number; head_repository_id: number };
}

/** Прогон в ответе `gh api …/actions/runs/<id>`. */
export interface GhRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export const ghRun = (id: number, status: string, conclusion: string | null = null): GhRun => ({ id, status, conclusion, html_url: `https://github.test/runs/${id}` });

/** Заглушка `gh` в каталоге `bin` с ответами `github`: окружение запуска скрипта и вызовы `gh` после него. */
export function fakeGh(bin: string, github: { artifacts: GhArtifact[]; runs?: Record<number, GhRun[]> }) {
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "artifacts.json"), JSON.stringify(github.artifacts));
  writeFileSync(path.join(bin, "runs.json"), JSON.stringify(github.runs ?? {}));
  const log = path.join(bin, "calls");
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin },
    calls: (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
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

/**
 * Язык временного проекта — `.agents/elves.json` с полем `language`, как его ставит установка: скрипты spec пишут
 * на нём. Без манифеста проект — `en`.
 */
export function setLanguage(dir: string, language: string): void {
  writeTree(dir, { ".agents/elves.json": JSON.stringify({ language }) + "\n" });
}

/** Git-репозиторий во временном каталоге (init: false — уже готовый); commit пишет файлы (null — удалить) и возвращает SHA. */
export function gitRepo(dir: string, { init = true } = {}) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  if (init) git("init", "-q", "-b", "main");
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

/**
 * `origin` тестового чекаута — локальный bare-репозиторий `…/<owner>/<repo>.git`; для скрипта он — `owner/repo` на
 * GitHub (стандарт origin-repo): `git remote get-url origin` отвечает `git@github.com:<owner>/<repo>.git`, остальной
 * git — настоящий. `insteadOf` не подходит: `get-url` его раскрывает.
 */
export function githubOrigin<R extends { status: number | null; stdout: string }>(run: (cmd: string, args: string[], cwd?: string) => R) {
  return (cmd: string, args: string[], cwd?: string): R => {
    const r = run(cmd, args, cwd);
    if (cmd !== "git" || args.join(" ") !== "remote get-url origin" || r.status !== 0) return r;
    const m = /([^/\s]+)\/([^/\s]+)\.git\s*$/.exec(r.stdout);
    return m ? { ...r, stdout: `git@github.com:${m[1]}/${m[2]}.git\n` } : r;
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
