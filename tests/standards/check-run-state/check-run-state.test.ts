import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { HEAD_CHECKS, Q } from "../../../skills/github/scripts/github.ts";
import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

/** Check-run, как его описывает таблица: значения status и conclusion — как в REST, id растёт с созданием. */
interface Run {
  id: number;
  name: string;
  app: number;
  status: string;
  conclusion: string | null;
}

/** Ответ копии: состояние каждого имени по check-runs коммита. */
type Read = (runs: Run[]) => Record<string, string>;

/** Копия правила: скилл, файл и как она отвечает. */
interface Copy {
  skill: string;
  file: string;
  read: Read;
}

/**
 * `CHECK_STATES` `.sh` — определение jq `check_states` над check-runs REST, тем же движком, что `wait-ci.sh`: строчные
 * значения, id — `id`, приложение — `app.id`.
 */
const viaJq =
  (program: string): Read =>
  (runs) => {
    const rest = runs.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, app: { id: r.app } }));
    const r = spawnSync("jq", ["-nc", "--argjson", "runs", JSON.stringify(rest), `${program} $runs | check_states`], { encoding: "utf8", timeout: SPAWN_TIMEOUT });
    if (r.status !== 0) throw new Error(`jq не разобрал правило: ${exitOf(r)} ${r.stderr.trim()}`);
    return Object.fromEntries((JSON.parse(r.stdout) as { name: string; bucket: string }[]).map((c) => [c.name, c.bucket]));
  };

/**
 * `checkStates` `.ts` — узлы `statusCheckRollup` GraphQL: перечисления в верхнем регистре, id — `databaseId`,
 * приложение — `checkSuite.app.databaseId`.
 */
const viaGraphql =
  (checkStates: (nodes: unknown[]) => Map<string, string>): Read =>
  (runs) =>
    Object.fromEntries(
      checkStates(
        runs.map((r) => ({
          __typename: "CheckRun",
          name: r.name,
          status: r.status.toUpperCase(),
          conclusion: r.conclusion?.toUpperCase() ?? null,
          databaseId: r.id,
          checkSuite: { app: { databaseId: r.app } },
        })),
      ),
    );

/** Копия `.sh` без строки в одинарных кавычках — ошибка на первом вопросе, а не пропуск в реестре. */
const unreadable =
  (file: string): Read =>
  () => {
    throw new Error(`${file}: CHECK_STATES не строкой в одинарных кавычках — правило не прочитать`);
  };

/** Скрипты скиллов с правилом: `export function checkStates` в `.ts`, `CHECK_STATES=` в `.sh` — новая копия попадает под таблицу сама. */
async function copies(): Promise<Copy[]> {
  const out: Copy[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => /\.(ts|sh)$/.test(f))
        .sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const file = `skills/${skill}/scripts/${f}`;
      const text = readFileSync(path.join(dir, f), "utf8");
      if (f.endsWith(".ts") && /^export function checkStates\b/m.test(text)) {
        const mod = await import(pathToFileURL(path.join(dir, f)).href);
        out.push({ skill, file, read: viaGraphql(mod.checkStates) });
      } else if (f.endsWith(".sh") && /^CHECK_STATES=/m.test(text)) {
        const m = /^CHECK_STATES='([^']*)'$/m.exec(text);
        out.push({ skill, file, read: m ? viaJq(m[1]!) : unreadable(file) });
      }
    }
  }
  return out;
}

// приложения check-run: GitHub Actions и стороннее
const ACTIONS = 15368;
const OTHER = 9426;
const run = (id: number, status: string, conclusion: string | null = null, o: { name?: string; app?: number } = {}): Run => ({
  id,
  name: o.name ?? "tests",
  app: o.app ?? ACTIONS,
  status,
  conclusion,
});
const done = (id: number, conclusion: string, o?: { name?: string; app?: number }) => run(id, "completed", conclusion, o);

/** Таблица: check-runs коммита и состояние каждого имени. */
const TABLE: { runs: Run[]; state: Record<string, string>; why: string }[] = [
  { runs: [run(1, "queued")], state: { tests: "pending" }, why: "в очереди" },
  { runs: [run(1, "in_progress")], state: { tests: "pending" }, why: "идёт" },
  { runs: [run(1, "waiting")], state: { tests: "pending" }, why: "ждёт окружения" },
  { runs: [done(1, "success")], state: { tests: "pass" }, why: "зелёный" },
  { runs: [done(1, "neutral")], state: { tests: "skipping" }, why: "нейтральный — ни зелёный, ни красный, как в gh pr checks" },
  { runs: [done(1, "skipped")], state: { tests: "skipping" }, why: "job пропущен по условию" },
  { runs: [done(1, "cancelled")], state: { tests: "cancel" }, why: "отменён" },
  { runs: [done(1, "failure")], state: { tests: "fail" }, why: "упал" },
  { runs: [done(1, "timed_out")], state: { tests: "fail" }, why: "вышел по таймауту" },
  { runs: [done(1, "action_required")], state: { tests: "fail" }, why: "ждёт решения человека — ожидание его не дождётся" },
  { runs: [done(1, "startup_failure")], state: { tests: "fail" }, why: "не стартовал" },
  { runs: [done(1, "stale")], state: { tests: "fail" }, why: "GitHub бросил незавершённый" },
  { runs: [done(1, "success"), done(2, "failure")], state: { tests: "fail" }, why: "зелёный, потом красный на перезапуске — решает последний" },
  { runs: [done(1, "failure"), done(2, "success")], state: { tests: "pass" }, why: "упавший перезапущен и позеленел" },
  { runs: [done(1, "success"), done(2, "cancelled")], state: { tests: "cancel" }, why: "поздний отменённый после раннего зелёного" },
  { runs: [done(1, "failure"), run(2, "in_progress")], state: { tests: "pending" }, why: "перезапуск ещё идёт" },
  { runs: [done(2, "failure"), done(1, "success")], state: { tests: "fail" }, why: "последний — по id, а не по месту в ответе" },
  { runs: [done(1, "failure"), done(2, "success", { app: OTHER })], state: { tests: "fail" }, why: "приложения порознь: упавший у одного — имя красное" },
  { runs: [done(1, "success"), run(2, "in_progress", null, { app: OTHER })], state: { tests: "pending" }, why: "приложения порознь: идущий у одного — имя ждёт" },
  { runs: [done(1, "success", { name: "lint" }), done(2, "failure")], state: { lint: "pass", tests: "fail" }, why: "имена порознь" },
];

const show = (state: Record<string, string>) =>
  Object.entries(state)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

/** Строки таблицы, на которые копия отвечает не по правилу: почему строка такая, ответ копии и ответ правила. */
function mismatches(read: Read): { why: string; got: string; want: string }[] {
  return TABLE.flatMap((row) => {
    const got = show(read(row.runs));
    const want = show(row.state);
    return got === want ? [] : [{ why: row.why, got, want }];
  });
}

// task show до #492: из перезапусков — лучший прогон, NEUTRAL и SKIPPED зелёные, приложения не различает
const best: Copy = {
  skill: "github с лучшим прогоном",
  file: "github.ts",
  read: (runs) => {
    const rank = { fail: 0, cancel: 0, pending: 1, pass: 2, skipping: 2 } as Record<string, number>;
    const out: Record<string, string> = {};
    for (const r of runs) {
      const s = r.status !== "completed" ? "pending" : r.conclusion === "success" ? "pass" : r.conclusion === "cancelled" ? "cancel" : ["neutral", "skipped"].includes(r.conclusion!) ? "skipping" : "fail";
      if (!(r.name in out) || rank[s]! > rank[out[r.name]!]!) out[r.name] = s;
    }
    return out;
  },
};
// ci-wait без приложений: зелёный check-run другого приложения скрывает упавший
const oneApp: Copy = {
  skill: "ci-wait без приложений",
  file: "wait-ci.sh",
  read: viaJq(
    'def check_states: group_by(.name) | map(max_by(.id) | { name, bucket: (if .status != "completed" then "pending" elif .conclusion == "success" then "pass" elif .conclusion == "neutral" or .conclusion == "skipped" then "skipping" elif .conclusion == "cancelled" then "cancel" else "fail" end) });',
  ),
};

const registry = await copies();

describe("github и ci-wait одинаково читают состояние check-run по одной таблице: status и conclusion, перезапуски одного имени", () => {
  invariant(it, {
    registry: "скрипты скиллов с правилом checkStates / CHECK_STATES",
    items: registry,
    key: (c) => c.skill,
    includes: ["ci-wait", "github"],
    name: (c) => `${c.skill} (${c.file}) читает состояние check-run по таблице`,
    check: (c) => {
      const wrong = mismatches(c.read).map((m) => `${m.why}: ${m.got}, а по правилу — ${m.want}`);
      if (wrong.length) throw new Error(`${c.file}: правило состояния check-run расходится с таблицей:\n${wrong.join("\n")}`);
    },
    violator: [
      { name: "копия правила в одном из скриптов расходится с таблицей", item: best },
      { name: "копия сводит одноимённые check-runs разных приложений в один", item: oneApp },
    ],
  });

  it("чек зелёный, потом красный на перезапуске — task show и ci-wait оба называют его красным", () => {
    const runs = [done(1, "success"), done(2, "failure")];
    expect(Object.fromEntries(registry.map((c) => [c.skill, c.read(runs).tests]))).toEqual({ "ci-wait": "fail", github: "fail" });
  });

  it("таблица ловит лучший прогон из перезапусков и сведение приложений в одно", () => {
    expect(mismatches(best.read).map((m) => m.why)).toEqual([
      "зелёный, потом красный на перезапуске — решает последний",
      "поздний отменённый после раннего зелёного",
      "последний — по id, а не по месту в ответе",
      "приложения порознь: упавший у одного — имя красное",
      "приложения порознь: идущий у одного — имя ждёт",
    ]);
    expect(mismatches(oneApp.read).map((m) => m.why)).toEqual(["приложения порознь: упавший у одного — имя красное"]);
  });
});

/** Запрос `github` с чеками головы: имя в `Q` и его текст. */
interface Query {
  name: string;
  text: string;
}

const count = (text: string, part: string) => text.split(part).length - 1;

/** Нарушение запроса: `statusCheckRollup` мимо фрагмента; пусто — каждая выборка чеков — `HEAD_CHECKS`. */
function violation(q: Query): string | null {
  const own = count(q.text, "statusCheckRollup") - count(q.text, HEAD_CHECKS);
  return own > 0 ? `запрос ${q.name}: statusCheckRollup мимо фрагмента HEAD_CHECKS (${own}) — без id прогона и приложения перезапуски не различить` : null;
}

const QUERIES: Query[] = Object.entries(Q)
  .filter(([, text]) => text.includes("statusCheckRollup"))
  .map(([name, text]) => ({ name, text }));

describe("каждый запрос github с чеками головы PR берёт их одним фрагментом — с id прогона и приложением", () => {
  invariant(it, {
    registry: "запросы github со statusCheckRollup",
    items: QUERIES,
    key: (q) => q.name,
    includes: ["IssueShow", "MergeRules", "PrShow"],
    name: (q) => `запрос ${q.name} берёт чеки головы фрагментом HEAD_CHECKS`,
    check: (q) => {
      const v = violation(q);
      if (v) throw new Error(v);
    },
    violator: {
      name: "запрос со своей выборкой statusCheckRollup",
      item: { name: "PrChecks", text: "query PrChecks { pullRequest { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name status conclusion } } } } } } } } }" },
    },
  });

  it("фрагмент выбирает то, что читает правило: имя, status, conclusion, id прогона и приложение", () => {
    expect(HEAD_CHECKS).toMatch(/\.\.\. on CheckRun \{ name status conclusion databaseId checkSuite \{ app \{ databaseId \} \} \}/);
  });
});
