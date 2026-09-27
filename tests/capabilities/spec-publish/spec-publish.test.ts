/**
 * Скрипт `spec-publish` скилла `spec`: после мержа в `main` CI публикует сгенерированную документацию `docs/spec` в
 * отдельную ветку `spec`, а не коммитит её в `main`.
 *
 * `docs/spec` — производная копия тестов: в `main` параллельные PR конфликтовали бы в сгенерированных страницах и
 * оглавлении. Ветка `spec` читается в GitHub и агентом (`git show origin/spec:README.md`), каждая публикация помнит
 * SHA `main`, из которого собрана, и CI проверяет, что опубликовано ровно то, что собрано.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
