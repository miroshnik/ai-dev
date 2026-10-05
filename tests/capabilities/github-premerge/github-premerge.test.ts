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

// Проект: реестр items.txt и проверка «реестр + инвариант» — каждая ссылка из uses*.txt есть в реестре, как у
// стандартов проекта, тест на ссылку; test:spec — она. Lockfile bun — зависимости ставятся `bun install`.
const CHECK = `fail=0
for u in $(cat uses*.txt 2>/dev/null); do
  grep -qx "$u" items.txt || { echo "(fail) реестр > ссылка $u есть в реестре [0.0$u ms]" >&2; fail=1; }
done
echo "(pass) реестр"
exit $fail
`;
const PKG = (scripts: Record<string, string> = { "test:spec": "sh check.sh" }) => JSON.stringify({ name: "x", private: true, scripts }, null, 2) + "\n";
// typecheck проекта — как tsc без TTY: каждый вызов из calls.txt объявлен в exports.txt, иначе ошибка компилятора с
// позицией вызова; стандарты (test:spec) о вызовах не знают
const TSC = `n=0; fail=0
while read c; do
  n=$((n+1))
  grep -qx "$c" exports.txt || { echo "src/calls.ts($n,1): error TS2304: Cannot find name '$c'."; fail=1; }
done < calls.txt
exit $fail
`;
const TYPED = { "package.json": PKG({ typecheck: "sh tc.sh", "test:spec": "sh check.sh" }), "tc.sh": TSC, "exports.txt": "commentsIn\nother\n", "calls.txt": "other\n" };

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

const MAIN_SHA = "c0ffee1" + "0".repeat(33);

interface MainChecks {
  runs?: { id?: number; name: string; status?: string; conclusion: string | null }[];
  statuses?: { context: string; state: string }[];
}

/**
 * `gh` — внешний край: PR, check suites его головы, последнее событие основной ветки, чеки последнего коммита main и
 * поиск открытого бага «main красный» (REST).
 */
function fakeGh(
  head: string,
  { suites = [CI], moved = "2026-10-02T09:30:00Z", state = "open", activity, main = {}, bugs = [], body = "", owner = "User" }: { suites?: string[]; moved?: string | null; state?: string; activity?: string; main?: MainChecks; bugs?: { number: number; title: string }[]; body?: string; owner?: string } = {},
) {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const url = args[1] ?? "";
    calls.push(url);
    if (args[0] !== "api") throw new Error(`fake gh: неожиданный вызов gh ${args.join(" ")}`);
    if (url === `repos/${SLUG}/pulls/${PR}`) return JSON.stringify({ id: 1, number: PR, state, merged: state !== "open", body, head: { sha: head, ref: "feat/7-x" }, base: { ref: "main", repo: { owner: { type: owner } } } });
    if (url.startsWith(`repos/${SLUG}/commits/main/check-runs`)) {
      const runs = (main.runs ?? []).map((r, i) => ({ id: r.id ?? i + 1, name: r.name, status: r.status ?? "completed", conclusion: r.conclusion }));
      return JSON.stringify({ total_count: runs.length, check_runs: runs });
    }
    if (url === `repos/${SLUG}/commits/main/status`) return JSON.stringify({ sha: MAIN_SHA, state: "pending", statuses: main.statuses ?? [] });
    if (url.startsWith("search/issues?")) return JSON.stringify({ total_count: bugs.length, items: bugs.map((b) => ({ ...b, state: "open" })) });
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

  it("скриптов typecheck и test:spec нет — строка ○, вливать можно", () => {
    const p = project({ pr: { "uses.txt": "a\n" }, mainAfter: { "items.txt": "a\nb\nc\n" }, files: { "package.json": PKG({ test: "sh check.sh" }) } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ быстрых проверок нет: в package.json слияния нет скриптов typecheck и test:spec — шаг пропущен");
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
      expect([cmds.install?.join(" ") ?? null, cmds.run("test:spec").join(" ")]).toEqual([install, run]);
    }
  });
});

/**
 * Семантический конфликт двух PR, влитых почти одновременно, ловит typecheck за секунды, а стандарты — нет (#292):
 * PR убрал функцию, а влитый после его CI коммит `main` её позвал — `test:spec` на слиянии зелёный, `main` упал на
 * typecheck. Поэтому на слиянии — быстрые проверки по порядку CI: `typecheck`, затем `test:spec`, какие есть в
 * `package.json`; до первой красной.
 */
describe("pr premerge: typecheck на слиянии со свежим main — до test:spec, как в CI", () => {
  const AFTER = "2026-10-02T10:20:00Z";
  const steps = (proc: ReturnType<typeof processes>) => proc.calls.filter((c) => c.cmd !== "git").map((c) => [c.cmd, ...c.args].join(" "));

  it("слияние с красным typecheck premerge не вливает и называет ошибку компилятора", () => {
    // PR убрал commentsIn, main после CI PR его позвал; test:spec слияния зелёный — реестр не тронут
    const p = project({ files: TYPED, pr: { "exports.txt": "other\n" }, mainAfter: { "calls.txt": "other\ncommentsIn\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bun run typecheck упал:\n  src/calls.ts(2,1): error TS2304: Cannot find name 'commentsIn'.");
    expect(r.last).toBe("❌ не вливать: typecheck красный на слиянии с origin/main — чинить корень в PR: rebase на origin/main, правка, push --force-with-lease, снова ci-wait");
    // test:spec после красного typecheck не идёт, голый main проверяется тем, что упало
    expect(steps(proc)).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun install --frozen-lockfile", "bun run typecheck"]);
    expect(worktrees(p.work)).toHaveLength(1);
  });

  it("typecheck идёт на слиянии до test:spec, оба зелёные — вливать можно", () => {
    const p = project({ files: TYPED, pr: { "calls.txt": "other\ncommentsIn\n" }, mainAfter: { "uses.txt": "a\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(0);
    expect(steps(proc)).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun run test:spec"]);
    expect(r.last).toBe("✅ вливать: typecheck и test:spec зелёные на слиянии с origin/main");
  });

  it("без скрипта typecheck в package.json premerge проверяет одним test:spec", () => {
    const p = project({ pr: { "uses.txt": "a\n" }, mainAfter: { "items.txt": "a\nb\nc\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(0);
    expect(steps(proc)).toEqual(["bun install --frozen-lockfile", "bun run test:spec"]);
    expect(r.last).toBe("✅ вливать: test:spec зелёный на слиянии с origin/main");
  });
});

const WAIT = path.resolve(import.meta.dir, "../../../skills/ci-wait/scripts/wait-ci.sh");
const GITHUB = path.resolve(import.meta.dir, "../../../skills/github/scripts/github.ts");
const MAIN_RED = "⛔ не вливать: main красный, не этот PR — в своём PR не чинить";

/**
 * Красный `main` видели только следующие PR: каждая сессия чинила его в своём PR или ждала вслепую, а владелец
 * рассылал «не пушить» (#282). `premerge` отличает «мой PR ломает» от «`main` уже красный»: слияние красное —
 * упавшая проверка ещё и на голом `main`; красная там тем же — отдельный исход, код 3. Красный чек последнего коммита
 * `main` (деплой, смоук) — тот же исход. Сессия не вливает и в своём PR не чинит: один баг «main красный…» на всех,
 * `premerge` называет открытый или команду завести, остальные ждут его закрытия. PR, который этот баг закрывает, — починка:
 * красный `main` его не останавливает.
 */
describe("pr premerge: main красный — не этот PR: не вливать и не чинить в своём PR", () => {
  const AFTER = "2026-10-02T10:20:00Z";

  it("красный test:spec и на слиянии PR, и на голом main — premerge выходит отдельным кодом «main красный», а не «PR ломает»", () => {
    // после CI PR main сам сломал реестр; PR его не трогает
    const p = project({ pr: { "other.txt": "x\n" }, mainAfter: { "uses.txt": "z\n" } });
    const proc = processes();
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work, proc.run);
    expect(r.code).toBe(3);
    expect(proc.seen).toEqual([
      { "items.txt": "a\nb\n", "uses.txt": "z\n" },
      { "items.txt": "a\nb\n", "uses.txt": "z\n" },
    ]);
    expect(r.out).toContain("main красный и сам: test:spec красный и на голом origin/main тем же");
    expect(r.last).toBe(MAIN_RED);
    expect(worktrees(p.work)).toHaveLength(1);
  });

  it("красный typecheck и на слиянии, и на голом main тем же — код 3; ошибки компилятора сверяются без позиции", () => {
    // после CI PR main сам позвал необъявленное; PR дописал вызов выше — на слиянии та же ошибка строкой ниже
    const p = project({ files: { ...TYPED, "calls.txt": "other\nother\nother\n" }, pr: { "calls.txt": "commentsIn\nother\nother\nother\n" }, mainAfter: { "calls.txt": "other\nother\nother\nmissing\n" } });
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work);
    expect(r.out).toContain("  src/calls.ts(5,1): error TS2304: Cannot find name 'missing'.");
    expect(r.code).toBe(3);
    expect(r.out).toContain("main красный и сам: typecheck красный и на голом origin/main тем же");
    expect(r.out).toContain(`--title "main красный: typecheck"`);
    expect(r.last).toBe(MAIN_RED);
  });

  it("main красный на typecheck, а PR ломает ещё своё — код 1, вывод называет ошибки компилятора PR", () => {
    const p = project({ files: { ...TYPED, "calls.txt": "other\nother\nother\n" }, pr: { "calls.txt": "gone\nother\nother\nother\n" }, mainAfter: { "calls.txt": "other\nother\nother\nmissing\n" } });
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain("main красный и сам, PR ломает сверх него:\n  src/calls.ts(1,1): error TS2304: Cannot find name 'gone'.\n❌ не вливать: typecheck красный");
  });

  it("main красный, а PR ломает ещё своё — код 1, вывод называет тесты, которые ломает PR", () => {
    const p = project({ pr: { "uses-pr.txt": "q\n" }, mainAfter: { "uses.txt": "z\n" } });
    const r = premerge(fakeGh(p.head, { moved: AFTER }).gh, p.work);
    expect(r.code).toBe(1);
    expect(r.out).toContain("main красный и сам, PR ломает сверх него:\n  (fail) реестр > ссылка q есть в реестре");
    expect(r.out).not.toContain("сверх него:\n  (fail) реестр > ссылка z");
    expect(r.last).toStartWith("❌ не вливать: test:spec красный на слиянии с origin/main");
  });

  it("красный чек последнего коммита main — premerge не вливает и называет чек", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const proc = processes();
    const main: MainChecks = {
      runs: [
        { id: 1, name: "deploy", conclusion: "failure" },
        { id: 2, name: "tests", conclusion: "failure" },
        { id: 3, name: "tests", conclusion: "success" }, // перезапуск позеленел — чек не красный
        { id: 4, name: "smoke", status: "in_progress", conclusion: null },
      ],
      statuses: [{ context: "preview", state: "error" }, { context: "lint", state: "success" }],
    };
    const r = premerge(fakeGh(p.head, { main }).gh, p.work, proc.run);
    expect(r.code).toBe(3);
    expect(r.out).toContain("main красный: чеки deploy, preview последнего коммита main (c0ffee1)");
    expect(r.last).toBe(MAIN_RED);
    expect(proc.calls).toEqual([]);
  });

  it("открытый баг «main красный…» — premerge называет его и команду ожидания; бага нет — команду завести", () => {
    const p = project({ pr: { "uses.txt": "a\n" } });
    const main: MainChecks = { runs: [{ name: "deploy", conclusion: "timed_out" }] };
    const found = premerge(fakeGh(p.head, { main, bugs: [{ number: 41, title: "main красный: чек deploy" }] }).gh, p.work);
    expect(found.out).toContain(`баг на красный main — #41 «main красный: чек deploy»: ждать его закрытия — bash ${WAIT} issue 41 фоновой командой, затем снова pr premerge ${PR}`);
    const none = fakeGh(p.head, { main, owner: "Organization" });
    const r = premerge(none.gh, p.work);
    expect(none.calls.find((c) => c.startsWith("search/issues?"))).toBe(`search/issues?q=${encodeURIComponent(`repo:${SLUG} is:issue is:open in:title "main красный"`)}&per_page=20`);
    expect(r.out).toContain(`бага на красный main нет — заведи (метка — решение упавшего теста) и дай чип: bun ${GITHUB} task new --type Баг --priority Urgent --title "main красный: чек deploy"; ждать его закрытия — bash ${WAIT} issue <N> фоновой командой, затем снова pr premerge ${PR}`);
    expect(r.code).toBe(3);
  });

  it("PR закрывает открытый баг «main красный…» — красный main его не останавливает: это починка", () => {
    // поиск отстаёт — бывает и дубль: починка закрывает не обязательно первый
    const bugs = [
      { number: 40, title: "main красный: чек deploy" },
      { number: 41, title: "main красный: test:spec" },
    ];
    const fix = project({ pr: { "uses.txt": "a\n" } });
    const main: MainChecks = { runs: [{ name: "deploy", conclusion: "failure" }] };
    const r = premerge(fakeGh(fix.head, { main, bugs, body: "Чиню деплой.\n\nCloses #41" }).gh, fix.work);
    expect(r.out).toContain("○ main красный — чек deploy последнего коммита main (c0ffee1); PR закрывает баг #41 на него — проверяю PR как обычно");
    expect(r.code).toBe(0);
    // починка, которая не чинит: красное слияние — её, код 1
    const p = project({ pr: { "other.txt": "x\n" }, mainAfter: { "uses.txt": "z\n" } });
    const red = premerge(fakeGh(p.head, { moved: AFTER, bugs, body: "Fixes #41" }).gh, p.work);
    expect(red.code).toBe(1);
    expect(red.last).toStartWith("❌ не вливать: test:spec красный на слиянии с origin/main");
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
