import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { main, projectCommands, realRun } from "../../../skills/github/scripts/github.ts";
import type { Io, RunResult } from "../../../skills/github/scripts/github.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, tmpDir } from "../../lib/spec.ts";

// git и test:spec — настоящие процессы во временном репозитории
setDefaultTimeout(SPAWN_TIMEOUT);

const SLUG = "miroshnik/ai-dev";
const PR = 7;
const CI = "2026-10-02T10:00:00Z";

const temp: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of temp.splice(0)) cleanup();
});
function scratch(): string {
  const { dir, cleanup } = tmpDir();
  temp.push(cleanup);
  return dir;
}

// Проект: реестр items.txt и проверка «реестр + инвариант» — каждая ссылка из uses.txt есть в реестре, как у
// стандартов проекта; test:spec — она. Lockfile bun — зависимости ставятся `bun install`.
const CHECK = `for u in $(cat uses.txt 2>/dev/null); do
  grep -qx "$u" items.txt || { echo "(fail) реестр > ссылка $u есть в реестре" >&2; exit 1; }
done
echo "(pass) реестр"
`;
const PKG = (scripts: Record<string, string> = { "test:spec": "sh check.sh" }) => JSON.stringify({ name: "x", private: true, scripts }, null, 2) + "\n";

/**
 * Чекаут сессии на ветке PR и origin — bare-репозиторий с путём вида …/miroshnik/ai-dev.git. Голова PR лежит в
 * `refs/pull/<N>/head`, как на GitHub; `mainAfter` — коммит, влитый в main после CI PR.
 */
function project({ pr, mainAfter, files = {} }: { pr: Record<string, string | null>; mainAfter?: Record<string, string | null>; files?: Record<string, string | null> }) {
  const dir = scratch();
  const origin = path.join(dir, `${SLUG}.git`);
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const repo = gitRepo(work);
  repo.commit({ "package.json": PKG(), "bun.lock": "{}\n", "check.sh": CHECK, "items.txt": "a\nb\n", ...files }, "init");
  repo.git("remote", "add", "origin", origin);
  repo.git("push", "-q", "origin", "main");
  repo.git("switch", "-q", "-c", "feat/7-x");
  const head = repo.commit(pr, "pr");
  repo.git("push", "-q", "origin", `HEAD:refs/pull/${PR}/head`);
  if (mainAfter) {
    repo.git("switch", "-q", "main");
    repo.commit(mainAfter, "main after CI");
    repo.git("push", "-q", "origin", "main");
    repo.git("switch", "-q", "feat/7-x");
  }
  return { work, head, git: repo.git };
}

/** `gh` — внешний край: PR, check suites его головы и последнее событие основной ветки (REST). */
function fakeGh(head: string, { suites = [CI], moved = "2026-10-02T09:30:00Z", state = "open", activity }: { suites?: string[]; moved?: string | null; state?: string; activity?: string } = {}) {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const url = args[1] ?? "";
    calls.push(url);
    if (args[0] !== "api") throw new Error(`fake gh: неожиданный вызов gh ${args.join(" ")}`);
    if (url === `repos/${SLUG}/pulls/${PR}`) return JSON.stringify({ id: 1, number: PR, state, merged: state !== "open", head: { sha: head, ref: "feat/7-x" }, base: { ref: "main" } });
    if (url.startsWith(`repos/${SLUG}/commits/${head}/check-suites`)) return JSON.stringify({ total_count: suites.length, check_suites: suites.map((t, i) => ({ id: i + 1, created_at: t })) });
    if (url.startsWith(`repos/${SLUG}/activity?`)) {
      if (activity) return JSON.stringify({ message: activity, status: "404" });
      return JSON.stringify(moved ? [{ id: 1, ref: "refs/heads/main", timestamp: moved, activity_type: "pr_merge" }] : []);
    }
    throw new Error(`fake gh: неожиданный вызов gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

/** Процессы: git и test:spec — настоящие, установка зависимостей — подменена; на test:spec снимок дерева слияния. */
function processes() {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const seen: Record<string, string | null>[] = [];
  const run = (cmd: string, args: string[], cwd?: string): RunResult => {
    calls.push({ cmd, args, cwd });
    if (cmd === "bun" && args[0] === "install") return { status: 0, stdout: "", stderr: "" };
    if (cmd === "bun" && args[0] === "run") seen.push(Object.fromEntries(["items.txt", "uses.txt"].map((f) => [f, existsSync(path.join(cwd!, f)) ? readFileSync(path.join(cwd!, f), "utf8") : null])));
    return realRun(cmd, args, cwd);
  };
  return { run, calls, seen };
}

function premerge(gh: (args: string[]) => string, cwd: string, run = processes().run) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, run, cwd };
  const code = main(["pr", "premerge", String(PR), "--repo", SLUG], io);
  return { code, out: out.join("\n"), err: err.join("\n"), last: out[out.length - 1] ?? "" };
}

const worktrees = (work: string) => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: work, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree "));

describe("pr premerge: main не ушёл после зелёного CI — CI проверил это слияние", () => {
  it("main не ушёл после зелёного CI — слияние не собирается, вливать можно", () => {
    const p = project({ pr: { "uses.txt": "b\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head).gh, p.work, proc.run);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([`✅ вливать: main не двигался после CI PR #${PR} (CI с ${CI}, последнее движение main — 2026-10-02T09:30:00Z) — CI проверил это слияние`]);
    expect(proc.calls).toEqual([]);
  });

  /** Merge-ref GitHub строит до события, по которому создаётся check suite: мерж в main в эту минуту мог в него не попасть. */
  it("движение main за минуту до CI считается уходом: merge-ref строится раньше check suite", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const r = premerge(fakeGh(p.head, { moved: "2026-10-02T09:59:30Z" }).gh, p.work);
    expect(r.out).toContain(`main ушёл после CI PR #${PR} (CI с ${CI}, main — 2026-10-02T09:59:30Z) — проверяю слияние с origin/main`);
    expect(r.out).toContain("test:spec");
  });

  it("чеков у головы PR нет — слияние проверяется: что проверил CI, неизвестно", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const r = premerge(fakeGh(p.head, { suites: [] }).gh, p.work);
    expect(r.out).toContain(`чеков у головы PR #${PR} нет — что проверил CI, неизвестно: проверяю слияние с origin/main`);
    expect(r.code).toBe(0);
    expect(r.last).toBe("✅ вливать: test:spec зелёный на слиянии с origin/main");
  });

  it("движение main не прочитано — слияние проверяется", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const r = premerge(fakeGh(p.head, { activity: "Not Found" }).gh, p.work);
    expect(r.out).toContain("○ движение main не прочитано");
    expect(r.out).toContain("проверяю слияние с origin/main");
    expect(r.code).toBe(0);
  });

  it("CI считается с самого раннего check suite головы PR", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const r = premerge(fakeGh(p.head, { suites: ["2026-10-02T10:30:00Z", CI], moved: "2026-10-02T10:10:00Z" }).gh, p.work);
    expect(r.out).toContain(`main ушёл после CI PR #${PR} (CI с ${CI}, main — 2026-10-02T10:10:00Z)`);
  });
});

describe("pr premerge: main ушёл — быстрые проверки на слиянии со свежим main", () => {
  const AFTER = "2026-10-02T10:20:00Z";

  it("main ушёл — test:spec идёт на слиянии головы PR со свежим main во временном worktree, worktree убран", () => {
    // после CI PR в main влит новый элемент реестра; PR ссылается на старый
    const p = project({ pr: { "uses.txt": "a\n" }, mainAfter: { "items.txt": "a\nb\nc\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(0);
    expect(proc.seen).toEqual([{ "items.txt": "a\nb\nc\n", "uses.txt": "a\n" }]);
    const spec = proc.calls.find((c) => c.cmd === "bun" && c.args[0] === "run")!;
    expect(spec.args).toEqual(["run", "test:spec"]);
    expect(spec.cwd).not.toBe(p.work);
    expect(existsSync(spec.cwd!)).toBe(false);
    expect(worktrees(p.work)).toHaveLength(1);
    expect(p.git("branch", "--show-current")).toBe("feat/7-x");
    expect(r.out).toContain(`+ слияние ${p.head.slice(0, 7)} с origin/main ${p.git("rev-parse", "--short=7", "origin/main")} — без конфликтов`);
    expect(r.last).toBe("✅ вливать: test:spec зелёный на слиянии с origin/main");
  });

  it("зависимости ставятся по lockfile слияния до test:spec", () => {
    const p = project({ pr: { "uses.txt": "a\n" }, mainAfter: { "items.txt": "a\nb\nc\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    const steps = proc.calls.filter((c) => c.cmd !== "git").map((c) => [c.cmd, ...c.args].join(" "));
    expect(steps).toEqual(["bun install --frozen-lockfile", "bun run test:spec"]);
    expect(new Set(proc.calls.filter((c) => c.cmd !== "git").map((c) => c.cwd)).size).toBe(1);
    expect(r.out).toContain("+ зависимости: bun install --frozen-lockfile");
  });

  /** Поломка из замера #211: PR зелёный против старого main ссылается на элемент, который main убрал после его CI. */
  it("красный test:spec на слиянии — не вливать (код 1), вывод называет упавший тест", () => {
    const p = project({ pr: { "uses.txt": "b\n" }, mainAfter: { "items.txt": "a\n" } });
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain("  (fail) реестр > ссылка b есть в реестре");
    expect(r.last).toBe("❌ не вливать: test:spec красный на слиянии с origin/main — чинить корень в PR: rebase на origin/main, правка, push --force-with-lease, снова ci-wait");
    expect(worktrees(p.work)).toHaveLength(1);
  });

  it("слияние с текстовым конфликтом — не вливать (код 1), конфликтные файлы и подсказка rebase", () => {
    const p = project({ pr: { "items.txt": "a\nb\nd\n" }, mainAfter: { "items.txt": "a\nb\nc\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(1);
    expect(r.last).toBe("❌ не вливать: конфликт слияния с origin/main — items.txt; rebase на origin/main, push --force-with-lease, снова ci-wait");
    expect(proc.calls.filter((c) => c.cmd !== "git")).toEqual([]);
    expect(worktrees(p.work)).toHaveLength(1);
  });

  it("скрипта test:spec нет — строка ○, вливать можно", () => {
    const p = project({ pr: { "uses.txt": "a\n" }, mainAfter: { "items.txt": "a\nb\nc\n" }, files: { "package.json": PKG({ test: "sh check.sh" }) } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ быстрых проверок нет: в package.json слияния нет скрипта test:spec — шаг пропущен");
    expect(r.last).toBe("✅ вливать: слияние с origin/main без конфликтов");
    expect(proc.calls.filter((c) => c.cmd !== "git")).toEqual([]);
  });

  it("менеджер пакетов — по packageManager, иначе по lockfile; lockfile нет — без установки", () => {
    const cases: [Record<string, string>, string | null, string][] = [
      [{ "pnpm-lock.yaml": "" }, "pnpm install --frozen-lockfile", "pnpm run test:spec"],
      [{ "package-lock.json": "{}" }, "npm ci", "npm run test:spec"],
      [{ "yarn.lock": "" }, "yarn install --frozen-lockfile", "yarn run test:spec"],
      [{ "bun.lockb": "" }, "bun install --frozen-lockfile", "bun run test:spec"],
      [{ "package.json": JSON.stringify({ packageManager: "pnpm@10.1.0" }), "package-lock.json": "{}" }, "pnpm install --frozen-lockfile", "pnpm run test:spec"],
      [{}, null, "npm run test:spec"],
    ];
    for (const [files, install, run] of cases) {
      const dir = scratch();
      writeFileSync(path.join(dir, "package.json"), "{}");
      for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
      const cmds = projectCommands(dir);
      expect([cmds.install?.join(" ") ?? null, cmds.run.join(" ")]).toEqual([install, run]);
    }
  });
});

describe("pr premerge: проверить нельзя — ошибка, не «вливать»", () => {
  it("не чекаут репозитория PR — ошибка (код 2)", () => {
    const r = premerge(fakeGh("0".repeat(40), { moved: "2026-10-02T10:20:00Z" }).gh, scratch());
    expect(r.code).toBe(2);
    expect(r.err).toContain(`ошибка: проверка слияния — из чекаута ${SLUG}`);
  });

  it("PR не открыт — ошибка (код 2)", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const r = premerge(fakeGh(p.head, { state: "closed" }).gh, p.work);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`ошибка: PR #${PR} не открыт — вливать нечего`);
  });
});
