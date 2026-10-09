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

  it("повтор из того же коммита — без нового коммита", () => {
    docs({ "README.md": "# v1\n" });
    expect(publish().code).toBe(0);
    const again = publish();
    expect(again.code).toBe(0);
    expect(again.stderr).toBe("spec-publish: без изменений — origin/spec уже совпадает с docs/spec\n");
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
    expect(r.stderr).toBe(`spec-publish: без изменений — origin/spec подтверждена для ${next.slice(0, 12)}\n`);
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
  it("в ветке spec публикация из более нового коммита — старая поверх не публикуется: код 0, «уже новее», ветка не меняется", () => {
    const old = git(work, "rev-parse", "HEAD");
    const fresh = repo.commit({ "src.ts": "x\n" }, "next");
    docs({ "README.md": "# v2\n" });
    expect(publish("--source", fresh).code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    const published = git(work, "rev-parse", "origin/spec");
    docs({ "README.md": "# v1\n" });
    const r = publish("--source", old);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`spec-publish: пропуск — origin/spec уже новее: опубликовано из ${fresh.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(published);
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
  });

  // сторож от перекоррекции: подтверждение того же содержимого не уводит `Source:` назад
  it("то же содержимое из коммита старше опубликованного — «уже новее», Source: назад не уходит", () => {
    const old = git(work, "rev-parse", "HEAD");
    const fresh = repo.commit({ "src.ts": "x\n" }, "next");
    docs({ "README.md": "# v1\n" });
    expect(publish("--source", fresh).code).toBe(0);
    git(work, "fetch", "-q", "origin", "spec");
    const published = git(work, "rev-parse", "origin/spec");
    const r = publish("--source", old);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`spec-publish: пропуск — origin/spec уже новее: опубликовано из ${fresh.slice(0, 12)}\n`);
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
    expect(r.stderr).toContain("опубликовано");
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
    expect(r.stderr).toBe(`spec-publish: без изменений — origin/spec подтверждена для ${next.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(remoteLog().split("\n")).toHaveLength(2);
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${next}`);
  });
});

// `git` — обёртка: перед N-м пушем выполняет push-N из своего каталога, если он есть (параллельная публикация или
// сбой хостинга), затем настоящий git
const FAKE_GIT = `#!/usr/bin/env bash
if [ "$1" = push ]; then
  n=$(( $(cat "$FAKE_GIT/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_GIT/n"
  [ -f "$FAKE_GIT/push-$n" ] && . "$FAKE_GIT/push-$n"
fi
exec "$REAL_GIT" "$@"
`;
const OUTAGE = `echo "remote: Internal Server Error" >&2; echo "fatal: the remote end hung up unexpectedly" >&2; exit 1\n`;
const race = (commit: string) => `"$REAL_GIT" push -q origin ${commit}:refs/heads/spec\n`;

/** spec-publish, у которого перед пушами случается то, что в pushes (по порядку пушей). */
function publishAmid(pushes: string[], ...args: string[]) {
  const bin = path.join(dir, "bin");
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), FAKE_GIT);
  chmodSync(path.join(bin, "git"), 0o755);
  pushes.forEach((sh, i) => writeFileSync(path.join(bin, `push-${i + 1}`), sh));
  return runScript("spec-publish", ["--interval", "0", ...args], work, "bun", { PATH: `${bin}:${process.env.PATH}`, FAKE_GIT: bin, REAL_GIT: Bun.which("git")! });
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
    expect(r.stderr).toContain("spec-publish: пуш в origin/spec отклонён (попытка 1 из 3): ");
    expect(r.stderr).toContain("[rejected]");
    expect(r.stderr).toContain("опубликовано docs/spec → origin/spec");
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "show", "origin/spec:README.md")).toBe("# v2");
    expect(git(work, "rev-parse", "origin/spec^")).toBe(other);
    expect(git(work, "log", "-1", "--format=%B", "origin/spec")).toContain(`Source: ${second}`);
  });

  it("после перечитывания ветка уже собрана из потомка — пропуск «уже новее», код 0, ветка не меняется", () => {
    const other = parallel(second, { "README.md": "# v2\n" });
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([race(other)], "--source", first);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("spec-publish: пуш в origin/spec отклонён (попытка 1 из 3): ");
    expect(r.stderr).toEndWith(`spec-publish: пропуск — origin/spec уже новее: опубликовано из ${second.slice(0, 12)}\n`);
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(other);
  });

  it("отказ без сдвига ветки (сбой хостинга) — пауза и повтор; в логе причина из stderr git push", () => {
    docs({ "README.md": "# v1\n" });
    const r = publishAmid([OUTAGE]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      "spec-publish: пуш в origin/spec отклонён (попытка 1 из 3): remote: Internal Server Error; fatal: the remote end hung up unexpectedly — перечитываю ветку, повтор через 0 с\n",
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
      "spec-publish: пуш в origin/spec отклонён (попытка 2 из 2): remote: Internal Server Error; fatal: the remote end hung up unexpectedly\n",
    );
    git(work, "fetch", "-q", "origin", "spec");
    expect(git(work, "rev-parse", "origin/spec")).toBe(published);
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

const TREE = "7b3e9a1c5d2f4068b1a2c3d4e5f60718293a4b5c";
const OTHER_TREE = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
// id репозитория проекта; у прогона PR из форка head_repository_id — id форка
const REPO = 1001;
const FORK = 2002;

// `gh` — внешний край, подменяется он. Два вызова `gh api` (REST GitHub Actions): артефакты репозитория с фильтром по
// имени — из artifacts.json; прогон по id — из runs.json, `{ id: [ответ на каждый опрос…] }`, последний повторяется.
// Вызовы — в calls.
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

interface Artifact { id: number; name: string; expired: boolean; workflow_run: { id: number; repository_id: number; head_repository_id: number } }
const artifact = (run: number, over: { tree?: string; expired?: boolean; from?: number } = {}): Artifact => ({
  id: 9000 + run,
  name: `docs-spec-${over.tree ?? TREE}`,
  expired: over.expired ?? false,
  workflow_run: { id: run, repository_id: REPO, head_repository_id: over.from ?? REPO },
});

interface WorkflowRun { id: number; status: string; conclusion: string | null; html_url: string }
const workflowRun = (id: number, status: string, conclusion: string | null = null): WorkflowRun => ({ id, status, conclusion, html_url: `https://github.test/runs/${id}` });
const done = (id: number, conclusion = "success") => workflowRun(id, "completed", conclusion);

/** Шаг workflow публикации на мерж PR: прогон, проверивший дерево мержа, по ответам `gh api`. */
function findRun(github: { artifacts: Artifact[]; runs?: Record<number, WorkflowRun[]> }, ...args: string[]) {
  const bin = path.join(dir, "bin");
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "artifacts.json"), JSON.stringify(github.artifacts));
  writeFileSync(path.join(bin, "runs.json"), JSON.stringify(github.runs ?? {}));
  const r = runScript("spec-run", ["--tree", TREE, "--interval", "0", ...args], work, "bun", { PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin });
  const log = path.join(bin, "calls");
  return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

/**
 * Без CI на `main` `docs/spec` берётся из артефакта прогона PR (`ci.md`, «No CI on `main`»). Прогон PR проверяет
 * merge-ref — дерево, каким `main` станет после мержа, — и называет артефакт по этому дереву. У коммита мержа дерево
 * то же, только если между стартом прогона и мержем в `main` ничего не влили: тогда `main` проверен целиком, и
 * публикуется ровно собранное из него. У отставшего PR такого артефакта нет: публикация из его прогона откатила бы
 * ветку `spec` — в ней не стало бы страниц PR, влитого раньше, — поэтому она пропускается, а не падает.
 */
describe("Без CI на main публикуется только дерево, которое целиком проверил зелёный прогон", () => {
  const ARTIFACTS = `api repos/{owner}/{repo}/actions/artifacts?name=docs-spec-${TREE}`;
  const SKIPPED = `spec-run: дерево main ${TREE.slice(0, 12)} не проверено целиком — публикация пропущена: `;

  it("артефакт дерева мержа выложил зелёный прогон этого репозитория — id прогона в stdout", () => {
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [done(41)] } }, "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls).toEqual([ARTIFACTS, "api repos/{owner}/{repo}/actions/runs/41"]);
    expect(r.stderr).toContain("https://github.test/runs/41");
  });

  it("артефакта с деревом мержа нет или он истёк — код 0, stdout пуст, «дерево main не проверено целиком — публикация пропущена»", () => {
    for (const artifacts of [[], [artifact(40, { tree: OTHER_TREE })], [artifact(41, { expired: true })]]) {
      const r = findRun({ artifacts, runs: { 40: [done(40)], 41: [done(41)] } }, "--timeout", "60");
      expect([r.code, r.stdout]).toEqual([0, ""]);
      expect(r.stderr).toBe(`${SKIPPED}артефакта docs-spec-${TREE} нет\n`);
      expect(r.calls).toEqual([ARTIFACTS]);
    }
  });

  // артефакт с любым именем может выложить и прогон PR из форка: его содержимое — не проверенное дерево main
  it("артефакт выложил прогон форка — не считается, публикация пропущена", () => {
    const r = findRun({ artifacts: [artifact(41, { from: FORK })], runs: { 41: [done(41)] } }, "--timeout", "60");
    expect([r.code, r.stdout]).toEqual([0, ""]);
    expect(r.stderr).toBe(`${SKIPPED}артефакта docs-spec-${TREE} нет\n`);
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
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [workflowRun(41, "queued"), workflowRun(41, "in_progress"), done(41)] } }, "--timeout", "60");
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls.filter((c) => c.endsWith("/runs/41"))).toHaveLength(3);
    expect(r.stderr).toContain(`дерево main ${TREE.slice(0, 12)}: прогон 41 in_progress — ждём`);
  });

  it("прогон с артефактом не завершился к потолку ожидания — ошибка, код 1", () => {
    const r = findRun({ artifacts: [artifact(41)], runs: { 41: [workflowRun(41, "in_progress")] } }, "--timeout", "0");
    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toContain(`дерево main ${TREE.slice(0, 12)}: прогон 41 не завершился за 0 с`);
  });
});
