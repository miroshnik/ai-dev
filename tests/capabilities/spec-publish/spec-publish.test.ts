import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, runScript, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
let work: string;
let repo: ReturnType<typeof gitRepo>;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// рабочий клон и «GitHub» — голый репозиторий рядом; main уже запушен, ветки spec ещё нет
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  const remote = path.join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  work = path.join(dir, "work");
  mkdirSync(work);
  repo = gitRepo(work);
  repo.commit({ "README.md": "# проект\n", ".gitignore": "docs/spec/\n" }, "init");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
});
afterEach(() => cleanup());

const docs = (pages: Record<string, string>) => {
  rmSync(path.join(work, "docs/spec"), { recursive: true, force: true });
  writeTree(work, Object.fromEntries(Object.entries(pages).map(([k, v]) => [`docs/spec/${k}`, v])));
};
const publish = (...args: string[]) => runScript("spec-publish", args, work);
const remoteLog = () => git(work, "log", "--format=%s", "origin/spec");

describe("Документация публикуется в ветку spec, а не коммитится в main", () => {
  it("корень ветки spec — содержимое docs/spec, в сообщении — SHA main, из которого собрано; main не меняется", () => {
    docs({ "README.md": "# Спецификация\n", "capabilities/billing.md": "# billing\n" });
    const main = git(work, "rev-parse", "HEAD");
    const r = publish();
    expect(r.code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "ls-tree", "-r", "--name-only", "origin/spec").split("\n")).toEqual(["README.md", "capabilities/billing.md"]);
    expect(git(work, "show", "origin/spec:capabilities/billing.md")).toBe("# billing");
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${main}`);
    expect(git(work, "rev-parse", "HEAD")).toBe(main);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(r.stderr).toContain("опубликовано");
  });

  it("повтор без изменений — без нового коммита; изменение — новый коммит поверх, история публикаций сохраняется", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    const again = publish();
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("без изменений");
    git(work, "fetch", "-q", "origin", "spec");
    expect(remoteLog().split("\n")).toHaveLength(1);
    repo.commit({ "src.ts": "x\n" }, "next");
    docs({ "README.md": "# v2\n" });
    expect(publish().code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    expect(remoteLog().split("\n")).toHaveLength(2);
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
  });

  it("удалённая страница исчезает из ветки", () => {
    docs({ "README.md": "# v1\n", "capabilities/old.md": "# old\n" });
    publish();
    docs({ "README.md": "# v1\n" });
    publish();
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "ls-tree", "-r", "--name-only", "origin/spec")).toBe("README.md");
  });
});

/** Проверяю то, что дошло до читателя: ветка на «GitHub», а не свой вывод. */
describe("--check сверяет опубликованное с собранным", () => {
  it("ветка совпадает с docs/spec — код 0; отстала или её нет — код 1 и что не совпало", () => {
    docs({ "README.md": "# v1\n" });
    const none = publish("--check");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("ветки spec на origin нет");
    publish();
    expect(publish("--check").code).toBe(0);
    docs({ "README.md": "# v2\n" });
    const stale = publish("--check");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("отличается: README.md");
  });

  it("нет каталога docs/spec — код 2 и подсказка собрать его spec-doc", () => {
    const r = publish();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("spec-doc");
  });
});

const HEAD = "4f1c0de2a9b8e7d6c5b4a3928170f6e5d4c3b2a1";

// `gh` — внешний край, подменяется он: ответы `gh run list` — массивы JSON в runs.json, по одному на опрос, последний
// повторяется; вызовы — в calls. Выдача с фильтром по статусу отстаёт, как у GitHub: прогонов в ней ещё нет.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH/calls"
[ "$1 $2" = "run list" ] || { echo "fake gh: $*" >&2; exit 1; }
case " $* " in *" --status "*) echo '[]'; exit 0 ;; esac
n=$(cat "$FAKE_GH/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_GH/n"
jq -c --argjson n "$n" '.[$n] // .[-1]' "$FAKE_GH/runs.json"
`;

interface GhRun { databaseId: number; status: string; conclusion: string | null; url: string }
const ghRun = (databaseId: number, status: string, conclusion: string | null = null): GhRun => ({ databaseId, status, conclusion, url: `https://github.test/runs/${databaseId}` });

/** Шаг workflow публикации на мерж PR: прогон CI головы PR по ответам `gh` на каждый опрос. */
function findRun(polls: GhRun[][], ...args: string[]) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "runs.json"), JSON.stringify(polls));
  const r = runScript("spec-run", ["--workflow", "ci.yml", "--commit", HEAD, "--interval", "0", ...args], work, "bun", { PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin });
  const log = path.join(bin, "calls");
  return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

/**
 * Без CI на `main` `docs/spec` берётся из артефакта прогона CI головы PR (`ci.md`, «Без CI на main»). Выдача
 * `gh run list --status success` отстаёт от завершения прогона на минуты: публикация сразу после мержа его не видела и
 * падала, ветка `spec` отставала до следующего мержа. Поэтому прогон ищется без фильтра по статусу, по его исходу.
 */
describe("Без CI на main прогон CI головы PR находится по исходу, а не по отстающему списку", () => {
  it("прогон CI головы PR находится, даже если список прогонов по статусу отстаёт", () => {
    const r = findRun([[ghRun(41, "completed", "success")]], "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls).toEqual([`run list --workflow ci.yml --commit ${HEAD} --json databaseId,status,conclusion,url`]);
    expect(r.stderr).toContain("https://github.test/runs/41");
  });

  it("из нескольких прогонов на голове PR берётся успешный", () => {
    const r = findRun([[ghRun(43, "completed", "cancelled"), ghRun(42, "completed", "success"), ghRun(41, "completed", "failure")]], "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([0, "42\n"]);
  });

  it("прогон CI головы PR ещё идёт — публикация ждёт его завершения", () => {
    const r = findRun([[], [ghRun(41, "queued")], [ghRun(41, "in_progress")], [ghRun(41, "completed", "success")]], "--timeout", "60");
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls).toHaveLength(4);
    expect(r.stderr).toContain("прогон ci.yml на 4f1c0de2a9b8: 41 in_progress — ждём");
  });

  it("прогон CI головы PR завершился неуспешно — ошибка с исходом прогона, без ожидания", () => {
    const r = findRun([[ghRun(41, "completed", "failure")]], "--timeout", "5");
    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.calls).toHaveLength(1);
    expect(r.stderr).toContain("завершился неуспешно — публиковать нечего: 41 failure https://github.test/runs/41");
  });

  it("прогона CI на голове PR нет — ошибка по потолку ожидания", () => {
    const r = findRun([[]], "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toContain("нет прогона ci.yml на 4f1c0de2a9b8 за 0 с — публиковать нечего");
  });
});
