import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { fakeGh, type GhArtifact, ghRun, type GhRun, gitRepo, runScript, tmpDir, writeTree } from "../../lib/spec.ts";

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
    expect(r.stderr).toContain("published");
  });

  it("повтор из того же коммита — без нового коммита", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    const again = publish();
    expect(again.code).toBe(0);
    expect(again.stderr).toBe("spec-publish: no changes — origin/spec already matches docs/spec\n");
    git(work, "fetch", "-q", "origin", "spec");
    expect(remoteLog().split("\n")).toHaveLength(1);
  });

  it("изменение — новый коммит поверх, история публикаций сохраняется", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    repo.commit({ "src.ts": "x\n" }, "next");
    docs({ "README.md": "# v2\n" });
    expect(publish().code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    expect(remoteLog().split("\n")).toHaveLength(2);
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
  });

  // мерж, не менявший спеку: без подтверждения `Source:` отставал бы от main, и spec-diff называл бы это пропуском публикации
  it("то же содержимое из нового коммита — коммит с тем же деревом и новым Source: ветка называет последний проверенный main", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    const first = git(work, "rev-parse", "origin/spec");
    const next = repo.commit({ "src.ts": "x\n" }, "next");
    const r = publish();
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`spec-publish: no changes — origin/spec confirmed for ${next.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec^")).toBe(first);
    expect(git(work, "rev-parse", "origin/spec^{tree}")).toBe(git(work, "rev-parse", `${first}^{tree}`));
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${next}`);
  });

  it("удалённая страница исчезает из ветки", () => {
    docs({ "README.md": "# v1\n", "capabilities/old.md": "# old\n" });
    publish();
    docs({ "README.md": "# v1\n" });
    publish();
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "ls-tree", "-r", "--name-only", "origin/spec")).toBe("README.md");
  });

  // публикации на мерж PR приходят не по порядку мержей: job раннего PR может дождаться своего прогона позже
  it("в ветке spec публикация из более нового коммита — старая поверх не публикуется: код 0, «already newer», ветка не меняется", () => {
    const old = git(work, "rev-parse", "HEAD");
    const fresh = repo.commit({ "src.ts": "x\n" }, "next");
    docs({ "README.md": "# v2\n" });
    expect(publish("--source", fresh).code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    const published = git(work, "rev-parse", "origin/spec");
    docs({ "README.md": "# v1\n" });
    const r = publish("--source", old);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`spec-publish: skipped — origin/spec already newer: published from ${fresh.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(published);
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
  });

  // сторож от перекоррекции: подтверждение того же содержимого не уводит `Source:` назад
  it("то же содержимое из коммита старше опубликованного — «already newer», Source: назад не уходит", () => {
    const old = git(work, "rev-parse", "HEAD");
    const fresh = repo.commit({ "src.ts": "x\n" }, "next");
    docs({ "README.md": "# v1\n" });
    expect(publish("--source", fresh).code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    const published = git(work, "rev-parse", "origin/spec");
    const r = publish("--source", old);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`spec-publish: skipped — origin/spec already newer: published from ${fresh.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(published);
  });

  // вариант с CI на main: checkout без истории — прежнего коммита main, из которого опубликовано, в клоне нет
  it("исходник опубликованного локально неизвестен (мелкий клон) — публикуется, как раньше", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    const next = repo.commit({ "src.ts": "x\n" }, "next");
    git(work, "push", "-q", "origin", "main");
    const shallow = path.join(dir, "shallow");
    git(dir, "clone", "-q", "--depth", "1", `file://${path.join(dir, "remote.git")}`, shallow);
    expect(git(shallow, "rev-list", "--count", "HEAD")).toBe("1");
    writeTree(shallow, { "docs/spec/README.md": "# v2\n" });
    const r = runScript("spec-publish", [], shallow);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("published");
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${next}`);
  });

  it("то же содержимое из нового коммита в мелком клоне — Source: обновляется и там", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    const next = repo.commit({ "src.ts": "x\n" }, "next");
    git(work, "push", "-q", "origin", "main");
    const shallow = path.join(dir, "shallow");
    git(dir, "clone", "-q", "--depth", "1", `file://${path.join(dir, "remote.git")}`, shallow);
    writeTree(shallow, { "docs/spec/README.md": "# v1\n" });
    const r = runScript("spec-publish", [], shallow);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`spec-publish: no changes — origin/spec confirmed for ${next.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(remoteLog().split("\n")).toHaveLength(2);
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${next}`);
  });
});

// `git` — обёртка: перед N-м пушем выполняет push-N из своего каталога, если он есть (параллельная публикация или
// сбой хостинга), затем настоящий git; after-push-N — сразу после удавшегося N-го пуша (следующая публикация)
const FAKE_GIT = `#!/usr/bin/env bash
if [ "$1" = push ]; then
  n=$(( $(cat "$FAKE_GIT/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_GIT/n"
  [ -f "$FAKE_GIT/push-$n" ] && . "$FAKE_GIT/push-$n"
  if [ -f "$FAKE_GIT/after-push-$n" ]; then "$REAL_GIT" "$@" || exit; . "$FAKE_GIT/after-push-$n"; exit 0; fi
fi
exec "$REAL_GIT" "$@"
`;
const OUTAGE = `echo "remote: Internal Server Error" >&2; echo "fatal: the remote end hung up unexpectedly" >&2; exit 1\n`;
const race = (commit: string) => `"$REAL_GIT" push -q origin ${commit}:refs/heads/spec\n`;
/** Следующая публикация: дерево tree из source — коммит поверх только что запушенной головы ветки spec. */
const following = (tree: string, source: string) =>
  `"$REAL_GIT" fetch -q origin spec && c=$(GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@localhost GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@localhost "$REAL_GIT" commit-tree ${tree} -p FETCH_HEAD -m "spec: next" -m "Source: ${source}") && "$REAL_GIT" push -q origin "$c:refs/heads/spec"\n`;

/** spec-publish, у которого вокруг пушей случается то, что в pushes (по порядку пушей): строка — до пуша, after — после. */
function publishAmid(pushes: (string | { after: string })[], ...args: string[]) {
  const bin = path.join(dir, "bin");
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), FAKE_GIT);
  chmodSync(path.join(bin, "git"), 0o755);
  pushes.forEach((sh, i) => writeFileSync(path.join(bin, typeof sh === "string" ? `push-${i + 1}` : `after-push-${i + 1}`), typeof sh === "string" ? sh : sh.after));
  return runScript("spec-publish", ["--interval", "0", ...args], work, { PATH: `${bin}:${process.env.PATH}`, FAKE_GIT: bin, REAL_GIT: Bun.which("git")! });
}

/** Коммит параллельной публикации из source: его собирает настоящий spec-publish, ветка на «GitHub» затем возвращается назад. */
function parallel(source: string, pages: Record<string, string>): string {
  git(work, "fetch", "-q", "origin", "spec");
  const before = git(work, "rev-parse", "origin/spec");
  docs(pages);
  expect(publish("--source", source).code).toBe(0);
  git(work, "fetch", "-q", "origin", "spec");
  const commit = git(work, "rev-parse", "origin/spec");
  git(work, "push", "-q", "--force", "origin", `${before}:refs/heads/spec`);
  return commit;
}

/**
 * Пуш отклоняется, когда ветку между fetch и push сдвинула другая публикация (прогоны на мерж завершаются не по
 * порядку мержей), или при сбое хостинга. Красный job публикации на `main` при этом ложный: повтор перечитывает
 * ветку и решает заново — поверх собранного из потомка не публикует, иначе коммитит поверх новой головы.
 */
describe("Отклонённый пуш — повтор поверх новой головы, а не падение", () => {
  let first: string;
  let second: string;
  beforeEach(() => {
    docs({ "README.md": "# v0\n" });
    expect(publish().code).toBe(0);
    first = repo.commit({ "a.ts": "a\n" }, "first");
    second = repo.commit({ "b.ts": "b\n" }, "second");
  });

  it("ветку сдвинула публикация из предка — повтор поверх новой головы: код 0, она — родитель публикации", () => {
    const other = parallel(first, { "README.md": "# v1\n" });
    docs({ "README.md": "# v2\n" });
    const r = publishAmid([race(other)], "--source", second);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("spec-publish: push to origin/spec rejected (attempt 1 of 3): ");
    expect(r.stderr).toContain("[rejected]");
    expect(r.stderr).toContain("published docs/spec → origin/spec");
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
    expect(git(work, "rev-parse", "origin/spec^")).toBe(other);
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${second}`);
  });

  it("после перечитывания ветка уже собрана из потомка — пропуск «already newer», код 0, ветка не меняется", () => {
    const other = parallel(second, { "README.md": "# v2\n" });
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([race(other)], "--source", first);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("spec-publish: push to origin/spec rejected (attempt 1 of 3): ");
    expect(r.stderr).toEndWith(`spec-publish: skipped — origin/spec already newer: published from ${second.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(other);
  });

  it("отказ без сдвига ветки (сбой хостинга) — пауза и повтор; в логе причина из stderr git push", () => {
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([OUTAGE]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      "spec-publish: push to origin/spec rejected (attempt 1 of 3): remote: Internal Server Error; fatal: the remote end hung up unexpectedly — re-reading the branch, retrying in 0 s\n",
    );
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v1");
    expect(remoteLog().split("\n")).toHaveLength(2);
  });

  it("попытки исчерпаны — код 1 с причиной из stderr git push, ветка не меняется", () => {
    git(work, "fetch", "-q", "origin", "spec");
    const published = git(work, "rev-parse", "origin/spec");
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([OUTAGE, OUTAGE], "--attempts", "2");
    expect(r.code).toBe(1);
    expect(r.stderr).toEndWith(
      "spec-publish: push to origin/spec rejected (attempt 2 of 2): remote: Internal Server Error; fatal: the remote end hung up unexpectedly\n",
    );
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(published);
  });
});

/**
 * Сверка после пуша читает ветку с «GitHub»: между пушем и чтением поверх могла лечь следующая публикация (прогоны на
 * мерж параллельны), и сверка дерева с каталогом давала ложное «не совпадает», код 1. Наш коммит в истории ветки —
 * опубликован: поверх него — только публикация не старше, более старая пропускается «already newer».
 */
describe("Следующая публикация поверх нашей до сверки — не расхождение", () => {
  let first: string;
  let second: string;
  beforeEach(() => {
    docs({ "README.md": "# v0\n" });
    expect(publish().code).toBe(0);
    first = repo.commit({ "a.ts": "a\n" }, "first");
    second = repo.commit({ "b.ts": "b\n" }, "second");
  });

  it("пуш прошёл, а до сверки поверх легла следующая публикация — код 0, наш коммит в истории ветки", () => {
    const next = git(work, "rev-parse", `${parallel(second, { "README.md": "# v2\n" })}^{tree}`);
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([{ after: following(next, second) }], "--source", first);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("spec-publish: published docs/spec → origin/spec ");
    expect(r.stderr).toMatch(/spec-publish: origin\/spec has moved on since — a later publish on top: [0-9a-f]{12}\n$/);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
    expect(git(work, "show", "origin/spec^:README.md")).toBe("# v1");
    expect(git(work, "log", "-1", "--format=%B", "origin/spec^")).toContain(`Source: ${first}`);
  });

  it("после пуша в ветке нет нашего коммита — код 1: опубликовано не то, что собрано", () => {
    const other = parallel(second, { "README.md": "# v2\n" });
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([{ after: `"$REAL_GIT" push -q --force origin ${other}:refs/heads/spec\n` }], "--source", first);
    expect(r.code).toBe(1);
    expect(r.stderr).toEndWith("spec-publish: after the push origin/spec doesn't match docs/spec\n");
  });
});

/** Проверяю то, что дошло до читателя: ветка на «GitHub», а не свой вывод. */
describe("--check сверяет опубликованное с собранным", () => {
  it("ветка совпадает с docs/spec — код 0; отстала или её нет — код 1 и что не совпало", () => {
    docs({ "README.md": "# v1\n" });
    const none = publish("--check");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no branch spec on origin");
    publish();
    expect(publish("--check").code).toBe(0);
    docs({ "README.md": "# v2\n" });
    const stale = publish("--check");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("differs: README.md");
  });

  it("нет каталога docs/spec — код 2 и подсказка собрать его spec-doc", () => {
    const r = publish();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("spec-doc");
  });
});

const TREE = "7b3e9a1c5d2f4068b1a2c3d4e5f60718293a4b5c";
const OTHER_TREE = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
// id репозитория проекта; у прогона PR из форка head_repository_id — id форка
const REPO = 1001;
const FORK = 2002;

const artifact = (run: number, over: { tree?: string; expired?: boolean; from?: number } = {}): GhArtifact => ({
  id: 9000 + run,
  name: `docs-spec-${over.tree ?? TREE}`,
  expired: over.expired ?? false,
  workflow_run: { id: run, repository_id: REPO, head_repository_id: over.from ?? REPO },
});

const done = (id: number, conclusion = "success") => ghRun(id, "completed", conclusion);

/** Шаг workflow публикации на мерж PR: прогон, проверивший дерево мержа, по ответам `gh api`. */
function findRun(github: { artifacts: GhArtifact[]; runs?: Record<number, GhRun[]> }, ...args: string[]) {
  const gh = fakeGh(path.join(dir, "bin"), github);
  const r = runScript("spec-run", ["--tree", TREE, "--interval", "0", ...args], work, gh.env);
  return { ...r, calls: gh.calls() };
}

/**
 * Без CI на `main` `docs/spec` берётся из артефакта прогона PR (`ci.md`, «No CI on `main`»). Прогон PR проверяет
 * merge-ref — дерево, каким `main` станет после мержа, — и называет артефакт по этому дереву. У коммита мержа дерево
 * то же, только если между стартом прогона и мержем в `main` ничего не влили: тогда `main` проверен целиком, и
 * публикуется ровно собранное из него. У отставшего PR такого артефакта нет: публикация из его прогона откатила бы
 * ветку `spec` — в ней не стало бы страниц PR, влитого раньше, — поэтому она пропускается, а не падает.
 */
describe("Без CI на main публикуется только дерево, которое целиком проверил зелёный прогон", () => {
  const ARTIFACTS = `api repos/{owner}/{repo}/actions/artifacts?name=docs-spec-${TREE}&per_page=100`;
  const SKIPPED = `spec-run: main tree ${TREE.slice(0, 12)} not fully checked — publishing skipped: `;

  it("артефакт дерева мержа выложил зелёный прогон этого репозитория — id прогона в stdout", () => {
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [done(41)] } }, "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls).toEqual([ARTIFACTS, "api repos/{owner}/{repo}/actions/runs/41"]);
    expect(r.stderr).toContain("https://github.test/runs/41");
  });

  it("артефакта с деревом мержа нет или он истёк — код 0, stdout пуст, «main tree … not fully checked — publishing skipped»", () => {
    for (const artifacts of [[], [artifact(40, { tree: OTHER_TREE })], [artifact(41, { expired: true })]]) {
      const r = findRun({ artifacts, runs: { 40: [done(40)], 41: [done(41)] } }, "--timeout", "60");
      expect([r.code, r.stdout]).toEqual([0, ""]);
      expect(r.stderr).toBe(`${SKIPPED}no artifact docs-spec-${TREE}\n`);
      expect(r.calls).toEqual([ARTIFACTS]);
    }
  });

  // артефакт с любым именем может выложить и прогон PR из форка: его содержимое — не проверенное дерево main
  it("артефакт выложил прогон форка — не считается, публикация пропущена", () => {
    const r = findRun({ artifacts: [artifact(41, { from: FORK })], runs: { 41: [done(41)] } }, "--timeout", "60");
    expect([r.code, r.stdout]).toEqual([0, ""]);
    expect(r.stderr).toBe(`${SKIPPED}no artifact docs-spec-${TREE}\n`);
    expect(r.calls).toEqual([ARTIFACTS]);
  });

  // артефакт выкладывается посреди прогона: его наличие зелёный прогон не доказывает
  it("прогон с артефактом завершился неуспешно — публикация пропущена, в сообщении исход прогона", () => {
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [done(41, "failure")] } }, "--timeout", "60");
    expect([r.code, r.stdout]).toEqual([0, ""]);
    expect(r.stderr).toBe(`${SKIPPED}41 failure https://github.test/runs/41\n`);
    expect(r.calls).toHaveLength(2);
  });

  it("из нескольких прогонов одного дерева берётся зелёный", () => {
    const runs = { 43: [done(43, "cancelled")], 42: [done(42)], 41: [done(41, "failure")] };
    const r = findRun({ artifacts: [artifact(43), artifact(42), artifact(41)], runs }, "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([0, "42\n"]);
  });

  it("прогон с артефактом ещё идёт — публикация ждёт его завершения", () => {
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [ghRun(41, "queued"), ghRun(41, "in_progress"), done(41)] } }, "--timeout", "60");
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls.filter((c) => c.endsWith("/runs/41"))).toHaveLength(3);
    expect(r.stderr).toContain(`main tree ${TREE.slice(0, 12)}: run 41 in_progress — waiting`);
  });

  it("прогон с артефактом не завершился к потолку ожидания — ошибка, код 1", () => {
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [ghRun(41, "in_progress")] } }, "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toContain(`main tree ${TREE.slice(0, 12)}: run 41 didn't finish in 0 s`);
  });
});
