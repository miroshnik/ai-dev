import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { REPO } from "../../lib/elves.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { fakeGh, type GhArtifact, ghRun, type GhRun, runScript, tmpDir, writeTree } from "../../lib/spec.ts";
import { documentsOf, readFragmentFile } from "../../lib/yaml-fragments.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

/** Файлы прогона — список по строке на путь; возвращает имя файла списка. */
function list(files: string[], name = "list.txt"): string {
  writeTree(dir, { [name]: files.join("\n") + "\n" });
  return name;
}

// пути в отчёте — абсолютные чужой машины: артефакт прошлого прогона CI
const CI = "/home/runner/work/app/app";

/** Отчёт Vitest прошлого прогона: файл → длительность, с. */
function vitestReport(seconds: Record<string, number>, name = "report.json"): string {
  const testResults = Object.entries(seconds).map(([file, s]) => ({
    name: `${CI}/${file}`,
    startTime: 1_000_000,
    endTime: 1_000_000 + s * 1000,
    assertionResults: [{ ancestorTitles: [], title: "работает", status: "passed", duration: s * 1000 }],
  }));
  writeTree(dir, { [name]: JSON.stringify({ testResults }) });
  return name;
}

/** JUnit bun test прошлого прогона: файл → длительность, с; пути — от корня проекта, как их пишет bun test. */
function bunReport(seconds: Record<string, number>, name = "report.xml"): string {
  const suites = Object.entries(seconds).map(
    ([file, s]) => `  <testsuite name="${file}" file="${file}" tests="1" time="${s}">\n    <testcase name="работает" time="${s}" file="${file}" line="3" />\n  </testsuite>\n`,
  );
  writeTree(dir, { [name]: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n${suites.join("")}</testsuites>\n` });
  return name;
}

/** Шард k из n: код, фильтры из stdout, stderr. */
function shard(k: number, n: number, ...args: string[]) {
  const r = runScript("spec-shard", ["--shard", `${k}/${n}`, ...args], dir);
  return { ...r, filters: r.stdout.split("\n").filter(Boolean) };
}
const shards = (n: number, ...args: string[]) => Array.from({ length: n }, (_, i) => shard(i + 1, n, ...args));

const HEAVY = "tests/capabilities/video";
const LIGHT = "tests/capabilities/login";

// подряд по пути: первый шард — a, b, c (60 с), второй — d и оба тяжёлых (210 с)
const SECONDS = {
  [`${HEAVY}/encode.test.ts`]: 100,
  [`${HEAVY}/transcode.test.ts`]: 90,
  [`${LIGHT}/a.test.ts`]: 20,
  [`${LIGHT}/b.test.ts`]: 20,
  [`${LIGHT}/c.test.ts`]: 20,
  [`${LIGHT}/d.test.ts`]: 20,
};

/**
 * Флаг раннера `--shard` на время не смотрит: Playwright делит сьют подряд по числу тестов, Vitest — по хешу пути, и
 * тяжёлые тесты одной папки достаются одному шарду. Раскладка `spec-shard` жадная: файлы от самого долгого — в самый
 * лёгкий шард, по длительностям из отчётов прошлого зелёного прогона.
 */
describe("Шард CI получает файлы по длительностям прошлого прогона, а не по числу тестов", () => {
  it("шард получает файлы по длительностям прошлого прогона, а не подряд по пути", () => {
    const [one, two] = shards(2, "--runner", "vitest", "--list", list(Object.keys(SECONDS)), "--report", vitestReport(SECONDS));
    expect(one!.filters).toEqual([`${LIGHT}/b.test.ts`, `${LIGHT}/d.test.ts`, `${HEAVY}/encode.test.ts`]);
    expect(two!.filters).toEqual([`${LIGHT}/a.test.ts`, `${LIGHT}/c.test.ts`, `${HEAVY}/transcode.test.ts`]);
    expect(one!.stderr).toContain("shard 1/2 — 3 of 6 files, 140 s of 270 s by the last green run");
    expect(two!.stderr).toContain("shard 2/2 — 3 of 6 files, 130 s of 270 s by the last green run");
    expect([one!.code, two!.code]).toEqual([0, 0]);
  });

  it("каждый тестовый файл попадает ровно в один шард", () => {
    const files = Array.from({ length: 25 }, (_, i) => `tests/capabilities/f${String(i).padStart(2, "0")}/f.test.ts`);
    // пять файлов без замера — новые
    const seconds = Object.fromEntries(files.slice(5).map((f, i) => [f, ((i * 7) % 13) + 1]));
    const got = shards(4, "--runner", "vitest", "--list", list(files), "--report", vitestReport(seconds)).flatMap((s) => s.filters);
    expect(got.sort()).toEqual(files);
  });

  it("файл без замера получает среднюю длительность и попадает в шард", () => {
    const report = vitestReport({ [`${LIGHT}/a.test.ts`]: 40, [`${LIGHT}/b.test.ts`]: 20, [`${LIGHT}/c.test.ts`]: 20 });
    // new — новый, весит среднее ≈27 с: a (40) — в первый шард, new — во второй, b — к new, c — к a; без веса new ушёл бы к a
    const files = [`${LIGHT}/a.test.ts`, `${LIGHT}/b.test.ts`, `${LIGHT}/c.test.ts`, `${LIGHT}/new.test.ts`];
    const [one, two] = shards(2, "--runner", "vitest", "--list", list(files), "--report", report);
    expect(one!.filters).toEqual([`${LIGHT}/a.test.ts`, `${LIGHT}/c.test.ts`]);
    expect(two!.filters).toEqual([`${LIGHT}/b.test.ts`, `${LIGHT}/new.test.ts`]);
    expect(two!.stderr).toContain("1 without a measurement — the mean, 27 s");
  });

  it("без отчёта прошлого прогона файлы делятся поровну по числу", () => {
    const files = Array.from({ length: 7 }, (_, i) => `${LIGHT}/${i}.test.ts`);
    for (const report of [["--report", ".spec-last/.spec-report.json"], []]) {
      const got = shards(3, "--runner", "vitest", "--list", list(files), ...report);
      expect(got.map((s) => s.filters.length)).toEqual([3, 2, 2]);
      expect(got.map((s) => s.code)).toEqual([0, 0, 0]);
      expect(got[0]!.stderr).toContain("no durations of the last green run — the files are split equally by count; shard 1/3 — 3 of 7 files");
      if (report.length) expect(got[0]!.stderr).toContain("no report .spec-last/.spec-report.json — no durations from it");
    }
  });

  it("длительности файлов читаются из отчётов Vitest, Playwright и bun test", () => {
    const vitest = `${CI}/tests/capabilities/import/archive.test.ts`;
    writeTree(dir, {
      // Vitest: файл — от старта первого теста до конца последнего (50 с), не сумма тестов (40 с): хуки между ними тоже время
      "vitest.json": JSON.stringify({
        testResults: [{ name: vitest, startTime: 5_000, endTime: 55_000, assertionResults: [{ duration: 30_000 }, { duration: 10_000 }] }],
      }),
      // Jest и Vitest без времён файла — сумма тестов
      "jest.json": JSON.stringify({ testResults: [{ name: vitest, assertionResults: [{ duration: 30_000 }, { duration: 5_000 }] }] }),
      // Playwright: все результаты тестов файла — проекты и повтор, вложенный describe тоже (10 + 15 + 20 + 5 с)
      "playwright.json": JSON.stringify({
        config: { rootDir: `${CI}/tests` },
        suites: [
          {
            title: "capabilities/checkout/checkout.e2e.ts",
            file: "capabilities/checkout/checkout.e2e.ts",
            specs: [{ title: "оплата", tests: [{ projectName: "chromium", results: [{ duration: 10_000 }, { duration: 15_000 }] }, { projectName: "firefox", results: [{ duration: 20_000 }] }] }],
            suites: [{ title: "корзина", specs: [{ title: "пуста", tests: [{ projectName: "chromium", results: [{ duration: 5_000 }] }] }] }],
          },
        ],
      }),
      // bun test: time набора файла, вложенный describe его не удваивает
      "bun.xml":
        '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="2" time="42.1">\n' +
        '  <testsuite name="tests/capabilities/cli/cli.test.ts" file="tests/capabilities/cli/cli.test.ts" tests="2" time="42">\n' +
        '    <testsuite name="запуск" file="tests/capabilities/cli/cli.test.ts" line="3" tests="1" time="40">\n' +
        '      <testcase name="печатает справку" time="40" file="tests/capabilities/cli/cli.test.ts" line="4" />\n' +
        "    </testsuite>\n" +
        '    <testcase name="выходит с кодом 0" time="2" file="tests/capabilities/cli/cli.test.ts" line="9" />\n' +
        "  </testsuite>\n</testsuites>\n",
    });
    for (const [report, file, seconds] of [
      ["vitest.json", "tests/capabilities/import/archive.test.ts", 50],
      ["jest.json", "tests/capabilities/import/archive.test.ts", 35],
      ["playwright.json", "tests/capabilities/checkout/checkout.e2e.ts", 50],
      ["bun.xml", "tests/capabilities/cli/cli.test.ts", 42],
    ] as const) {
      const r = shard(1, 1, "--runner", "vitest", "--list", list([file]), "--report", report);
      expect([report, r.code, r.stderr]).toEqual([report, 0, `spec-shard: shard 1/1 — 1 of 1 files, ${seconds} s of ${seconds} s by the last green run\n`]);
    }
  });

  it("`--runner bun` отдаёт файлы шарда путями по длительностям из JUnit bun test", () => {
    const files = list(Object.keys(SECONDS));
    const bun = shards(2, "--runner", "bun", "--list", files, "--report", bunReport(SECONDS));
    expect(bun[0]!.filters).toEqual([`./${LIGHT}/b.test.ts`, `./${LIGHT}/d.test.ts`, `./${HEAVY}/encode.test.ts`]);
    expect(bun.map((s) => [s.code, s.stderr])).toEqual([
      [0, "spec-shard: shard 1/2 — 3 of 6 files, 140 s of 270 s by the last green run\n"],
      [0, "spec-shard: shard 2/2 — 3 of 6 files, 130 s of 270 s by the last green run\n"],
    ]);
    // раскладка — та же, что у vitest по тем же длительностям; фильтр — тот же путь от корня, с ./
    const vitest = shards(2, "--runner", "vitest", "--list", files, "--report", vitestReport(SECONDS));
    expect(bun.map((s) => s.filters)).toEqual(vitest.map((s) => s.filters.map((f) => `./${f}`)));
  });

  it("одни и те же входные данные дают одни и те же шарды", () => {
    const files = Array.from({ length: 12 }, (_, i) => `tests/capabilities/c${i % 4}/f${i}.test.ts`);
    // равные длительности — ничьи решает путь, а не порядок списка
    const report = vitestReport(Object.fromEntries(files.map((f, i) => [f, i % 3 ? 10 : 25])));
    const run = (listName: string) => shards(3, "--runner", "playwright", "--list", listName, "--report", report).map((s) => s.stdout);
    const first = run(list(files));
    expect(run(list(files))).toEqual(first);
    expect(run(list([...files].reverse(), "reversed.txt"))).toEqual(first);
  });

  it("список файлов — из vitest list --filesOnly --json, абсолютные пути — от корня", () => {
    const root = realpathSync(dir);
    writeTree(dir, { "files.json": JSON.stringify([{ file: `${root}/${LIGHT}/b.test.ts` }, { file: `${root}/${LIGHT}/a.test.ts`, projectName: "unit" }]) });
    const r = shard(1, 1, "--runner", "vitest", "--list", "files.json");
    expect([r.code, r.filters]).toEqual([0, [`${LIGHT}/a.test.ts`, `${LIGHT}/b.test.ts`]]);
  });

  it("шард вне 1…n, неизвестный раннер или нет списка — ошибка вызова, код 2", () => {
    const files = list([`${LIGHT}/a.test.ts`]);
    for (const args of [
      ["--shard", "4/3", "--runner", "vitest", "--list", files],
      ["--shard", "1/2", "--runner", "jest", "--list", files],
      ["--shard", "1/2", "--runner", "vitest"],
    ]) {
      const r = runScript("spec-shard", args, dir);
      expect([args.join(" "), r.code, r.stdout]).toEqual([args.join(" "), 2, ""]);
    }
  });
});

// Playwright — из devDependencies Elves: во временном проекте своего node_modules нет, он — ссылка на node_modules Elves
const PLAYWRIGHT = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")), "cli.js");

/**
 * Тесты проекта Playwright: вход — проект-зависимость, остальные тесты зависят от него. `e2e/a.spec.ts` — начало пути
 * `e2e/a.spec.tsx` и конец пути `e2e/sub/e2e/a.spec.ts`.
 */
const E2E = ["e2e/a.spec.ts", "e2e/a.spec.tsx", "e2e/sub/e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"];

function playwrightProject(): void {
  writeTree(dir, {
    "package.json": JSON.stringify({ name: "app" }),
    "playwright.config.ts":
      'export default { testDir: "e2e", projects: [{ name: "setup", testMatch: /.*\\.setup\\.ts/ }, { name: "app", testMatch: /.*\\.spec\\.ts/, dependencies: ["setup"] }] };\n',
    ...Object.fromEntries(["e2e/auth.setup.ts", ...E2E].map((f) => [f, `import { test } from "@playwright/test";\n\ntest("${f}", () => {});\n`])),
  });
  symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
}

/** `playwright test --list --reporter=json [фильтры]` в проекте — в файл `out`: файлы по проектам. */
function playwrightList(out: string, filters: string[] = []): Record<string, string[]> {
  out = path.join(dir, out);
  const env = { ...process.env, PWTEST_CACHE_DIR: path.join(dir, ".playwright-cache"), PLAYWRIGHT_JSON_OUTPUT_NAME: out, CI: "1" };
  const r = spawnSync("node", [PLAYWRIGHT, "test", "--list", "--reporter=json", ...filters], { cwd: dir, encoding: "utf8", env });
  expect([exitOf(r), r.stderr]).toEqual([0, ""]);
  type Suite = { file: string; specs: { tests: { projectName: string }[] }[] };
  const report = JSON.parse(readFileSync(out, "utf8")) as { suites: Suite[] };
  const byProject: Record<string, string[]> = {};
  for (const s of report.suites)
    for (const project of new Set(s.specs.flatMap((spec) => spec.tests.map((t) => t.projectName)))) (byProject[project] ??= []).push(`e2e/${s.file}`);
  return byProject;
}

/** Шарды проекта Playwright настоящим раннером: список — его, фильтры — spec-shard, состав шарда — снова его список. */
function playwrightShards(n: number): Record<string, string[]>[] {
  playwrightProject();
  playwrightList(".spec-files.json");
  return Array.from({ length: n }, (_, i) => playwrightList(`shard-${i + 1}.json`, shard(i + 1, n, "--runner", "playwright", "--list", ".spec-files.json").filters));
}

/** Файлы, которые прогнал настоящий `bun test` во временном проекте по фильтрам, — по его JUnit. */
function bunRan(filters: string[]): string[] {
  const out = path.join(dir, ".bun-ran.xml");
  const r = spawnSync(process.execPath, ["test", ...filters, "--reporter=junit", `--reporter-outfile=${out}`], { cwd: dir, encoding: "utf8" });
  expect([filters.join(" "), exitOf(r)]).toEqual([filters.join(" "), 0]);
  const xml = readFileSync(out, "utf8");
  rmSync(out);
  return [...new Set([...xml.matchAll(/<testcase [^>]*\bfile="([^"]+)"/g)].map((m) => m[1]!))].sort();
}

describe("Фильтры шарда — ровно его файлы", () => {
  /**
   * Файлы шарда раннер получает фильтрами: Vitest берёт файл, путь которого содержит фильтр, Playwright проверяет
   * регулярное выражение по абсолютному пути. Путь, который входит в другой путь, взял бы чужой файл — тот прошёл бы в
   * двух шардах или ни в одном.
   */
  it("фильтр шарда не захватывает файлы чужого шарда: путь, который входит в другой путь, экранирован", () => {
    // Playwright — настоящим раннером: фильтр e2e/a.spec.ts без экранирования взял бы и e2e/a.spec.tsx чужого шарда, а
    // e2e/sub/e2e/a.spec.ts он берёт и экранированным — тот идёт в его шард
    const got = playwrightShards(3).map((s) => s.app ?? []);
    expect(got.flat().sort()).toEqual([...E2E].sort());
    expect(got.find((s) => s.includes("e2e/a.spec.ts"))).toContain("e2e/sub/e2e/a.spec.ts");
    expect(got.find((s) => s.includes("e2e/a.spec.ts"))).not.toContain("e2e/a.spec.tsx");

    // Vitest: подстрока пути без учёта регистра; корень проекта Vitest (packages/web) — любой общий каталог двух путей
    const files = [
      "tests/a.test.ts",
      "packages/web/tests/a.test.ts",
      "tests/d.test.ts",
      "tests/d.test.tsx",
      "packages/web/tests/x.test.ts",
      "packages/web/tests/sub/tests/x.test.ts",
      "tests/b.test.ts",
      "tests/c.test.ts",
    ];
    const vitest = shards(4, "--runner", "vitest", "--list", list(files)).map((s) => s.filters);
    const shardOf = (f: string) => vitest.findIndex((s) => s.includes(f));
    for (const [a, b] of [
      ["tests/a.test.ts", "packages/web/tests/a.test.ts"],
      ["tests/d.test.ts", "tests/d.test.tsx"],
      ["packages/web/tests/x.test.ts", "packages/web/tests/sub/tests/x.test.ts"],
    ] as const)
      expect([a, shardOf(b)]).toEqual([a, shardOf(a)]);
    for (const [i, own] of vitest.entries())
      for (const other of vitest.filter((_, j) => j !== i).flat()) expect(own.filter((f) => other.toLowerCase().includes(f.toLowerCase()))).toEqual([]);
  });

  /**
   * bun test берёт файл, путь которого от текущего каталога содержит фильтр, с учётом регистра, — а фильтр с `./` берёт
   * как путь файла: ровно его. Поэтому фильтр bun — путь с `./`, и склеивать файлы в один шард не нужно.
   */
  it("bun test берёт по фильтрам шарда ровно его файлы: фильтр — путь с `./`, а не подстрока пути", () => {
    // без ./ фильтр tests/a.test.ts взял бы и packages/web/tests/a.test.ts, а tests/d.test.ts — и tests/d.test.tsx
    const files = ["tests/a.test.ts", "packages/web/tests/a.test.ts", "tests/d.test.ts", "tests/d.test.tsx", "tests/b.test.ts"];
    writeTree(dir, Object.fromEntries(files.map((f) => [f, `import { test } from "bun:test";\n\ntest("${f}", () => {});\n`])));
    // шардов столько же, сколько файлов: у каждого шарда — один файл
    const got = shards(files.length, "--runner", "bun", "--list", list(files));
    expect(got.map((s) => s.filters.length)).toEqual(files.map(() => 1));
    expect(got.filter((s) => s.stderr.includes("one shard for"))).toEqual([]);
    expect(got.map((s) => bunRan(s.filters))).toEqual(got.map((s) => s.filters.map((f) => f.replace(/^\.\//, ""))));
  });

  /** Вход перед тестами — проект-зависимость: раннер добавляет его в шард без фильтров, его файл в фильтрах не нужен. */
  it("проект-зависимость Playwright (вход перед тестами) идёт в каждом шарде", () => {
    const got = playwrightShards(3);
    expect(got.map((s) => s.setup)).toEqual([["e2e/auth.setup.ts"], ["e2e/auth.setup.ts"], ["e2e/auth.setup.ts"]]);
    expect(got.every((s) => (s.app ?? []).length > 0)).toBe(true);
  });
});

// id репозитория проекта; у прогона PR из форка head_repository_id — id форка
const REPO_ID = 1001;
const FORK = 2002;
/** Время дня прогонов: минута `m` после 13:00 UTC, как его пишет GitHub. */
const at = (m: number) => `2026-10-15T13:${String(m).padStart(2, "0")}:00Z`;
/** Отчёты прогона `run`, выложенные на минуте `uploaded`. */
const reports = (run: number, over: { expired?: boolean; from?: number; uploaded?: number } = {}): GhArtifact => ({
  id: 9000 + run,
  name: "spec-reports",
  expired: over.expired ?? false,
  created_at: at(over.uploaded ?? 9),
  workflow_run: { id: run, repository_id: REPO_ID, head_repository_id: over.from ?? REPO_ID },
});
/** Попытка `n` прогона: начата на минуте `started`, обновлена последний раз (завершённая — закончена) на `updated`. */
const attempt = (id: number, status: string, conclusion: string | null, started: number, updated = started, n = 1) =>
  ghRun(id, status, conclusion, { run_attempt: n, run_started_at: at(started), updated_at: at(updated) });
/** Завершённый прогон: начат на минуте 5, закончен на `finished`. */
const done = (id: number, conclusion = "success", finished = 10) => attempt(id, "completed", conclusion, 5, finished);

// текущий прогон, чьи шарды спрашивают источник: его первая попытка начата на минуте 20
const RUN = 50;
const STARTED = at(20);
const FIRST = { [`${RUN}/1`]: attempt(RUN, "in_progress", null, 20) };
const IN_ACTIONS = { GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: "1" };

type Github = { artifacts: GhArtifact[]; runs?: Record<number, GhRun[]>; attempts?: Record<string, GhRun> };

/** Шаг шарда: последний зелёный прогон с отчётами по ответам `gh api`; `env` — переменные Actions (по умолчанию — шаг прогона RUN). */
function lastGreen(github: Github, env: Record<string, string> = IN_ACTIONS, ...args: string[]) {
  const gh = fakeGh(path.join(dir, "bin"), { attempts: FIRST, ...github });
  // переменные Actions самого прогона тестов до скрипта не доходят: их задаёт тест
  const r = runScript("spec-run", ["--artifact", "spec-reports", ...args], dir, { ...gh.env, GITHUB_RUN_ID: "", GITHUB_RUN_ATTEMPT: "", ...env });
  return { ...r, calls: gh.calls() };
}

const ARTIFACTS = "api repos/{owner}/{repo}/actions/artifacts?name=spec-reports&per_page=100";
const START = `api repos/{owner}/{repo}/actions/runs/${RUN}/attempts/1`;
const runCalls = (...ids: number[]) => ids.map((id) => `api repos/{owner}/{repo}/actions/runs/${id}`);

/**
 * Отчёты прошлого прогона — артефакт `spec-reports` джоба `spec`: слитые отчёты раннеров. Он выкладывается, только
 * когда тесты прошли, но исход прогона доказывает отдельный запрос: `spec-run --artifact` берёт новейший прогон этого
 * репозитория с исходом `success` и не ждёт идущий — до его исхода берётся прошлый зелёный.
 */
describe("Длительности — из отчётов последнего зелёного прогона", () => {
  it("последний зелёный прогон с отчётами — id в stdout: идущий и красный пропускаются, прогоны старше не спрашиваются", () => {
    const runs = { 43: [attempt(43, "in_progress", null, 8)], 42: [done(42, "failure")], 41: [done(41)], 40: [done(40)] };
    const r = lastGreen({ artifacts: [reports(43), reports(42), reports(41), reports(40)], runs });
    expect([r.code, r.stdout]).toEqual([0, "41\n"]);
    expect(r.calls).toEqual([START, ARTIFACTS, ...runCalls(43, 42, 41)]);
    expect(r.stderr).toBe(`spec-run: artifact spec-reports: run 41 succeeded before run ${RUN} started (${STARTED}) — https://github.test/runs/41\n`);
  });

  it("зелёного прогона с отчётами нет — код 0, stdout пуст, причина в stderr: шарды делятся по числу", () => {
    const why = `spec-run: artifact spec-reports: no green run before run ${RUN} started (${STARTED}) — `;
    const none = lastGreen({ artifacts: [] });
    expect([none.code, none.stdout, none.stderr]).toEqual([0, "", `${why}no artifact spec-reports\n`]);
    const red = lastGreen({ artifacts: [reports(42)], runs: { 42: [done(42, "failure")] } });
    expect([red.code, red.stdout, red.stderr]).toEqual([0, "", `${why}42 failure https://github.test/runs/42\n`]);
    const late = lastGreen({ artifacts: [reports(43, { uploaded: 19 })], runs: { 43: [attempt(43, "completed", "success", 12, 31)] } });
    expect([late.code, late.stdout, late.stderr]).toEqual([0, "", `${why}43 success (finished later) https://github.test/runs/43\n`]);
  });

  // артефакт с любым именем может выложить и прогон PR из форка
  it("отчёты прогона из форка и истёкшие не берутся", () => {
    const r = lastGreen({ artifacts: [reports(42, { from: FORK }), reports(41, { expired: true })], runs: { 41: [done(41)], 42: [done(42)] } });
    expect([r.code, r.stdout, r.calls]).toEqual([0, "", [START, ARTIFACTS]]);
  });

  it("вне Actions (без GITHUB_RUN_ID) — новейший прогон, зелёный на момент вызова", () => {
    const runs = { 42: [attempt(42, "completed", "success", 45, 55)], 41: [done(41)] };
    const r = lastGreen({ artifacts: [reports(42, { uploaded: 50 }), reports(41)], runs }, {});
    expect([r.code, r.stdout, r.calls]).toEqual([0, "42\n", [ARTIFACTS, ...runCalls(42)]]);
    expect(r.stderr).toBe("spec-run: artifact spec-reports: run 42 succeeded — https://github.test/runs/42\n");
  });

  it("--tree и --artifact вместе — ошибка вызова, код 2", () => {
    const r = lastGreen({ artifacts: [] }, IN_ACTIONS, "--tree", "7b3e9a1c5d2f4068b1a2c3d4e5f60718293a4b5c");
    expect([r.code, r.stdout, r.calls]).toEqual([2, "", []]);
  });
});

/**
 * «Новейший зелёный прогон» — не постоянная: между запросами шардов одного прогона может завершиться зелёным прогон
 * другого PR. Шарды тогда раскладывают файлы по разным отчётам, раскладки расходятся: одни файлы идут в двух шардах,
 * другие — ни в одном, и CI зелёный без них — в проекте с тремя шардами e2e так пропало 22 файла из 101. Поэтому в
 * Actions источник — новейший прогон, зелёный к началу первой попытки текущего (`GITHUB_RUN_ID`): ответ один, когда бы
 * шард ни дошёл до шага. Сбой запроса — красный шаг: шард, разложенный по числу рядом с шардами по длительностям,
 * терял бы файлы так же.
 */
describe("Шарды одного прогона берут длительности из одного прогона", () => {
  it("прогон, завершившийся после старта текущего, не берётся: два шарда, между запросами которых он позеленел, получают один источник", () => {
    // 44 выложил отчёты после старта; 43 — до старта, а завершился между запросами шардов
    const artifacts = [reports(44, { uploaded: 28 }), reports(43, { uploaded: 19 }), reports(41)];
    const runs = (r43: GhRun) => ({ 44: [attempt(44, "completed", "success", 21, 29)], 43: [r43], 41: [done(41)] });
    const early = lastGreen({ artifacts, runs: runs(attempt(43, "in_progress", null, 12)) });
    const late = lastGreen({ artifacts, runs: runs(attempt(43, "completed", "success", 12, 31)) });
    expect([early.stdout, late.stdout]).toEqual(["41\n", "41\n"]);
    // отчёты, выложенные после старта, не спрашиваются: их прогон не мог завершиться раньше
    expect(late.calls).toEqual([START, ARTIFACTS, ...runCalls(43, 41)]);
  });

  it("повтор упавших шардов (попытка 2) берёт источник первой попытки: прошедшие шарды первой попытки не перекладываются", () => {
    const attempts = { [`${RUN}/1`]: attempt(RUN, "completed", "failure", 20, 40), [`${RUN}/2`]: attempt(RUN, "in_progress", null, 60, 60, 2) };
    const runs = { 45: [attempt(45, "completed", "success", 42, 55)], 41: [done(41)] };
    const r = lastGreen({ artifacts: [reports(45, { uploaded: 50 }), reports(41)], runs, attempts }, { ...IN_ACTIONS, GITHUB_RUN_ATTEMPT: "2" });
    expect([r.code, r.stdout, r.calls]).toEqual([0, "41\n", [START, ARTIFACTS, ...runCalls(41)]]);
  });

  it("перезапуск прогона-источника не меняет ответ: прогон берётся по попытке, начатой до старта текущего", () => {
    // перезапуск начат посреди раскладки — в счёт идёт первая попытка, зелёная к старту
    const rerun = { 41: [attempt(41, "in_progress", null, 32, 32, 2)] };
    const later = lastGreen({ artifacts: [reports(41)], runs: rerun, attempts: { ...FIRST, "41/1": done(41) } });
    expect([later.stdout, later.calls]).toEqual(["41\n", [START, ARTIFACTS, ...runCalls(41), "api repos/{owner}/{repo}/actions/runs/41/attempts/1"]]);
    // перезапуск начат до старта — к старту прогон шёл, берётся прошлый зелёный
    const before = lastGreen({ artifacts: [reports(41), reports(40)], runs: { 41: [attempt(41, "in_progress", null, 15, 15, 2)], 40: [done(40)] } });
    expect(before.stdout).toBe("40\n");
  });

  it("сбой запроса старта прогона — код 2, stdout пуст: шаг шарда падает, а не делит файлы по числу", () => {
    const r = lastGreen({ artifacts: [reports(41)], runs: { 41: [done(41)] }, attempts: {} });
    expect([r.code, r.stdout, r.calls]).toEqual([2, "", [START]]);
  });
});

/** Шаги джоба с матрицей шардов из шаблона CI (`ci.md`). */
function templateSteps(job: "unit" | "e2e") {
  const [doc] = documentsOf("skills/spec/ci.md", readFragmentFile("skills/spec/ci.md"));
  const workflow = Bun.YAML.parse(doc!.text) as { jobs: Record<string, { steps: { run?: string; "continue-on-error"?: unknown }[] }> };
  return workflow.jobs[job]!.steps;
}

/** Вызов spec-shard в шаге шаблона — скрипт пакета проекта (`node_modules/.bin/elves spec-shard`, #559). */
const SHARD_CALL = /\belves spec-shard\b/;

/** Шаг `run` шарда из шаблона CI (`ci.md`): джоб с матрицей шардов, шаг, который зовёт spec-shard. */
function shardStep(job: "unit" | "e2e"): string {
  const runs = templateSteps(job).map((s) => s.run ?? "");
  expect(runs.filter((r) => /--shard[= ]\$\{\{ matrix\.shard/.test(r) && !SHARD_CALL.test(r))).toEqual([]);
  return runs.find((r) => SHARD_CALL.test(r))!;
}

// pnpm — заглушка: листинг раннера отдаёт готовый список, запуск раннера пишет в runs аргументы, по строке на каждый
const FAKE_PNPM = `#!/usr/bin/env bash
if [[ " $* " == *" list "* || " $* " == *" --list "* ]]; then
  for a in "$@"; do [[ "$a" == --json=* ]] && cp "$FAKE_PNPM/list.json" "\${a#--json=}"; done
  [ -z "$PLAYWRIGHT_JSON_OUTPUT_NAME" ] || cp "$FAKE_PNPM/list.json" "$PLAYWRIGHT_JSON_OUTPUT_NAME"
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_PNPM/runs"
`;

/**
 * Шаг шарда k из n шаблона в проекте с пакетом Elves: `node_modules/.bin/elves` — bin этого клона, как его кладёт
 * `bun install`; аргументы раннера — строки файла `runs`, который пишет его запуск (null — раннер не запускался);
 * `bin` — первым в PATH.
 */
function runStep(step: string, k: number, n: number, runs: string, bin = path.join(dir, "bin")): string[] | null {
  const elves = path.join(dir, "node_modules/.bin/elves");
  if (!existsSync(elves)) {
    mkdirSync(path.dirname(elves), { recursive: true });
    symlinkSync(path.join(REPO, "bin/elves.ts"), elves);
  }
  const script = step.replaceAll("${{ matrix.shard }}", String(k)).replaceAll("${{ strategy.job-total }}", String(n));
  const env = { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, FAKE_PNPM: bin };
  // bash -e — оболочка шага run в GitHub Actions
  const r = spawnSync("bash", ["-e", "-c", script], { cwd: dir, encoding: "utf8", env });
  expect([exitOf(r), r.stderr.includes("spec-shard: ")]).toEqual([0, true]);
  if (!existsSync(runs)) return null;
  const args = readFileSync(runs, "utf8").split("\n").slice(0, -1);
  rmSync(runs);
  return args;
}

/** Шаг шарда джоба шаблона с заглушкой pnpm: её листинг — `listing`. */
function pnpmStep(job: "unit" | "e2e", k: number, n: number, listing: unknown): string[] | null {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeTree(bin, { pnpm: FAKE_PNPM, "list.json": JSON.stringify(listing) });
  chmodSync(path.join(bin, "pnpm"), 0o755);
  return runStep(shardStep(job), k, n, path.join(bin, "runs"), bin);
}

/** Шаг шарда из фрагмента шаблона для проекта на bun test (`ci.md`, «A project on bun test»): шаг, который зовёт spec-shard. */
function bunShardStep(): string {
  const doc = documentsOf("skills/spec/ci.md", readFragmentFile("skills/spec/ci.md")).find((d) => d.text.includes("--runner bun"))!;
  const runs = (Bun.YAML.parse(doc.text) as { run?: string }[]).map((s) => s.run ?? "");
  expect(runs.filter((r) => /--shard[= ]\$\{\{ matrix\.shard/.test(r) && !SHARD_CALL.test(r))).toEqual([]);
  return runs.find((r) => SHARD_CALL.test(r))!;
}

describe("Шаблон CI передаёт раннеру файлы шарда, а не --shard", () => {
  it("шаг шарда Vitest передаёт раннеру файлы spec-shard; шард без файлов раннер не запускает", () => {
    const root = realpathSync(dir);
    const files = [`${root}/${LIGHT}/a b.test.ts`, `${root}/${LIGHT}/c.test.ts`];
    const got = [1, 2, 3].map((k) => pnpmStep("unit", k, 3, files.map((file) => ({ file }))));
    const flags = (k: number) => ["--reporter=default", "--reporter=blob", `--outputFile.blob=vitest-blob/${k}.json`];
    // путь с пробелом — один аргумент
    expect(got).toEqual([["test", `${LIGHT}/a b.test.ts`, ...flags(1)], ["test", `${LIGHT}/c.test.ts`, ...flags(2)], null]);
  });

  it("шаг шарда Playwright передаёт раннеру фильтры spec-shard", () => {
    const listing = { config: { rootDir: `${realpathSync(dir)}/e2e` }, suites: [{ file: "a.spec.ts", specs: [] }, { file: "b.spec.ts", specs: [] }] };
    const got = [1, 2].map((k) => pnpmStep("e2e", k, 2, listing));
    const run = (filter: string) => ["exec", "playwright", "test", filter, "--reporter=dot,blob"];
    expect(got).toEqual([run("/(^|\\/)e2e\\/a\\.spec\\.ts$/"), run("/(^|\\/)e2e\\/b\\.spec\\.ts$/")]);
  });

  it("шаг шарда bun test передаёт раннеру пути spec-shard из списка git", () => {
    // проект на bun test: скрипт test пишет свои аргументы; список — файлы теста в git, стандарты и не тесты — мимо
    const files = [`${LIGHT}/a b.test.ts`, `${LIGHT}/c.test.ts`, "tests/standards/naming/naming.test.ts", `${LIGHT}/fixtures.ts`];
    writeTree(dir, {
      "package.json": JSON.stringify({ scripts: { test: "bun record.ts" } }),
      "record.ts": 'await Bun.write("runs", process.argv.slice(2).map((a) => a + "\\n").join(""));\n',
      ...Object.fromEntries(files.map((f) => [f, ""])),
    });
    for (const args of [["init", "-q"], ["add", "-A"]]) expect([args[0], exitOf(spawnSync("git", args, { cwd: dir, encoding: "utf8" }))]).toEqual([args[0], 0]);
    const got = [1, 2, 3].map((k) => runStep(bunShardStep(), k, 3, path.join(dir, "runs")));
    const flags = (k: number) => ["--reporter=junit", `--reporter-outfile=.spec-report-${k}.xml`];
    // путь с пробелом — один аргумент
    expect(got).toEqual([[`./${LIGHT}/a b.test.ts`, ...flags(1)], [`./${LIGHT}/c.test.ts`, ...flags(2)], null]);
  });

  // шард, разложенный по числу рядом с шардами по длительностям, теряет файлы так же, как шарды с разными источниками
  it("сбой шага длительностей — красный шард: шаг без continue-on-error", () => {
    const steps = (["unit", "e2e"] as const).map((job) => templateSteps(job).filter((s) => s.run?.includes("elves spec-run --artifact")));
    expect(steps.map((found) => found.map((s) => s["continue-on-error"] ?? "none"))).toEqual([["none"], ["none"]]);
  });
});
