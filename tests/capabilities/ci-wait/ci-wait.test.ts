import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SCRIPT = fileURLToPath(new URL("../../../skills/ci-wait/scripts/wait-ci.sh", import.meta.url));
const SHA = "e6dba3bc59256d1324b2f0de3914dfaa56ea8786";
const HEAD = "4270c1c020120a3c709131f0986d67689e7a343d";
const MERGE = "9b1e3f7c2d4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c";
const CI = ".github/workflows/ci.yml";

// `gh` — внешний край, подменяется он: ответы — массивы JSON в <вид>.json, по одному на вызов, последний
// повторяется; строка — ошибка gh (текст в stderr, код 1), как «API rate limit exceeded»; нет файла — `{}`.
// Пути вызовов `gh api` пишутся в calls. GraphQL (`gh pr checks`, `gh pr view`) — ошибка: скрипт ходит по REST.
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "api rate_limit") kind=rate_limit ;;
  api\\ *) case "$2" in
      */actions/runs*) kind=runs ;;
      */actions/workflows*) kind=workflows ;;
      */contents/*) kind=contents ;;
      */check-runs*) kind=check-runs ;;
      */status) kind=status ;;
      */commits/*) kind=commit ;;
      */pulls/*) kind=pull ;;
      */rules/branches/*) kind=rules ;;
      */branches/*) kind=branch ;;
      */issues/*) kind=issue ;;
      *) exit 0 ;;
    esac ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
echo "$2" >> "$FAKE_GH/calls"
[ -f "$FAKE_GH/$kind.json" ] || { echo '{}'; exit 0; }
n=$(cat "$FAKE_GH/$kind.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_GH/$kind.n"
r=$(jq -c --argjson n "$n" '.[$n] // .[-1]' "$FAKE_GH/$kind.json")
if [[ "$r" == '"'* ]]; then jq -r . <<<"$r" >&2; exit 1; fi
printf '%s\\n' "$r"
`;

/**
 * Часы скрипта — тоже подделка: `sleep` не ждёт, а двигает время, которое отдаёт `date +%s` (остальные форматы —
 * настоящий `date`); паузы пишутся в sleeps. Исход не зависит от скорости машины: на реальных часах `--timeout` истекал
 * под нагрузкой параллельных сессий раньше, чем приходил нужный опрос, а долгое ожидание не проверить без долгого теста.
 */
const CLOCK = 1_800_000_000;
const REAL_DATE = Bun.which("date");
function fakeClock() {
  writeFileSync(path.join(sb.dir, "clock"), String(CLOCK));
  writeFileSync(path.join(sb.dir, "date"), `#!/usr/bin/env bash\n[ "$1" == "+%s" ] && exec cat "$FAKE_GH/clock"\nexec ${REAL_DATE} "$@"\n`);
  writeFileSync(path.join(sb.dir, "sleep"), `#!/usr/bin/env bash\necho "$1" >> "$FAKE_GH/sleeps"\necho $(( $(cat "$FAKE_GH/clock") + $1 )) > "$FAKE_GH/clock"\n`);
  for (const f of ["date", "sleep"]) chmodSync(path.join(sb.dir, f), 0o755);
}
const sleeps = () => readFileSync(path.join(sb.dir, "sleeps"), "utf8").trim().split("\n").map(Number);
const lines = (s: string) => s.split("\n").filter(Boolean);

let sb: { dir: string; cleanup: () => void };
beforeEach(() => {
  sb = tmpDir();
  writeFileSync(path.join(sb.dir, "gh"), FAKE_GH);
  chmodSync(path.join(sb.dir, "gh"), 0o755);
  fakeClock();
});
afterEach(() => sb.cleanup());

interface CheckRun {
  id: number; name: string; status: string; conclusion: string | null; html_url: string; app: { id: number }; check_suite: { id: number };
}
interface Status { context: string; state: string; target_url: string }
// id растёт с созданием check-run, как в GitHub; app — приложение, создавшее его (GitHub Actions — 15368); check suite —
// прогона workflow, чей это job
let lastId = 0;
const run = (name: string, status: string, conclusion: string | null = null, app = 15368, suite = 1): CheckRun => ({
  id: ++lastId, name, status, conclusion, html_url: "", app: { id: app }, check_suite: { id: suite },
});
const ok = (name: string) => run(name, "completed", "success");
const failed = (name: string) => run(name, "completed", "failure");
const cancelled = (name: string) => run(name, "completed", "cancelled");
const status = (context: string, state: string): Status => ({ context, state, target_url: "" });
interface WorkflowRun {
  id: number; name: string; path: string; event: string; status: string; conclusion: string | null; check_suite_id: number; html_url: string;
}
/** Прогон workflow `ci.yml` на SHA; его job — check-runs с тем же check suite (по умолчанию 1, как у `run`). */
const wfRun = (conclusion: string | null, o: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: ++lastId, name: "CI", path: CI, event: "pull_request", status: conclusion ? "completed" : "in_progress", conclusion,
  check_suite_id: 1, html_url: `https://github.com/o/r/actions/runs/${lastId}`, ...o,
});
/** Прогон-«пустышка» неразобранного workflow, как его оставляет GitHub: имя — путь файла, событие push, без job. */
const unparsed = () => wfRun("failure", { name: CI, event: "push", check_suite_id: 99 });
const write = (kind: string, v: unknown[]) => writeFileSync(path.join(sb.dir, `${kind}.json`), JSON.stringify(v));
const calls = () => readFileSync(path.join(sb.dir, "calls"), "utf8").split("\n");


function ciWait(args: string[]) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${sb.dir}:${process.env.PATH}`, FAKE_GH: sb.dir },
  });
  if (r.error) throw r.error;
  return { code: r.status, result: /^RESULT: (.*)$/m.exec(r.stdout)?.[1] ?? `(нет RESULT) ${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

interface Poll { statuses?: Status[]; runs?: CheckRun[]; workflowRuns?: WorkflowRun[] }
function writeChecks(polls: Poll[]) {
  write("status", polls.map((p) => ({ state: "pending", statuses: p.statuses ?? [] })));
  write("check-runs", polls.map((p) => ({ total_count: p.runs?.length ?? 0, check_runs: p.runs ?? [] })));
  write("runs", polls.map((p) => ({ total_count: p.workflowRuns?.length ?? 0, workflow_runs: p.workflowRuns ?? [] })));
}

/** Workflow `ci.yml` репозитория: состояние и файл на SHA головы — в base64 строками по 60, как отдаёт contents API. */
function workflow(yaml: string, state = "active") {
  write("workflows", [{ total_count: 1, workflows: [{ id: 1, name: "CI", path: CI, state }] }]);
  write("contents", [{ path: CI, encoding: "base64", content: Buffer.from(yaml).toString("base64").replace(/.{60}/g, "$&\n") }]);
}

/** Коммит: на каждый опрос — его статусы и check-runs. */
function waitCommit(polls: Poll[], args: string[] = []) {
  writeChecks(polls);
  return ciWait(["status", SHA, ...args]);
}

/** PR: на каждый опрос — `mergeable` (по умолчанию true), SHA головы (по умолчанию HEAD) и чеки его головы. */
function waitPr(polls: (Poll & { mergeable?: boolean | null; head?: string })[], args: string[] = []) {
  write("pull", polls.map((p) => ({ head: { sha: p.head ?? HEAD }, base: { ref: "main" }, mergeable: p.mergeable === undefined ? true : p.mergeable })));
  writeChecks(polls);
  return ciWait(["pr", "1", ...args]);
}

describe("Коммит ждут до исхода всех его чеков — и статусов, и check-runs GitHub Actions", () => {
  it("на коммите только check-runs Actions — PASS, когда все завершились успешно", () => {
    const r = waitCommit([{ runs: [run("tests", "in_progress")] }, { runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  it("statuses и check-runs вместе — PASS, только когда pending нет ни там, ни там", () => {
    const r = waitCommit([
      { statuses: [status("deploy", "pending")], runs: [ok("tests")] },
      { statuses: [status("deploy", "success")], runs: [ok("tests")] },
    ]);
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
    expect(r.stdout).toContain("1/2 done; waiting: deploy");
  });

  it("чеков на коммите ещё нет — ожидание, а не PASS", () => {
    const r = waitCommit([{}, {}, {}, { runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  it("упавший check-run — FAIL с его именем", () => {
    const r = waitCommit([{ runs: [ok("tests"), failed("lint")] }]);
    expect([r.code, r.result]).toEqual([1, "FAIL lint"]);
  });

  it("поздно зарегистрированный чек не проскакивает: финал — два опроса подряд без pending", () => {
    const r = waitCommit([
      { runs: [ok("tests")] },
      { runs: [ok("tests"), run("deploy", "queued")] },
      { runs: [ok("tests"), ok("deploy")] },
    ]);
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
  });

  it("--context находит чек по имени среди check-runs", () => {
    const r = waitCommit([{ runs: [ok("tests"), failed("lint")] }], ["--context", "tests"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  it("чеки не завершились к сроку — TIMEOUT", () => {
    const r = waitCommit([{ runs: [run("tests", "in_progress")] }], ["--timeout", "0"]);
    expect(r.code).toBe(2);
    expect(r.result).toBe("TIMEOUT after 0s (0/1 done; waiting: tests)");
  });
});

/**
 * На одном SHA бывают check-runs нескольких прогонов (#319): прогон отменён новым push, а голову вернули на прежний
 * коммит — проверка поломкой по канону; перезапуск упавшего job. GitHub отдаёт их все, а итог — за последним.
 */
describe("Одноимённые check-runs коммита сводятся к последнему — итог решает последний прогон, а не все сразу", () => {
  it("последний check-run имени решает итог: ранний отменённый и поздний зелёный — PASS", () => {
    const early = cancelled("tests");
    const r = waitPr([{ runs: [ok("tests"), early] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  // этот и следующий — сторожа от перекоррекции: сведение по порядку в ответе или по одному имени дало бы PASS
  it("поздний отменённый после раннего зелёного — FAIL", () => {
    const r = waitCommit([{ runs: [ok("tests"), cancelled("tests")] }]);
    expect([r.code, r.result]).toEqual([1, "FAIL tests"]);
  });

  it("одноимённые check-runs разных приложений сводятся порознь: упавший у одного — FAIL", () => {
    const r = waitCommit([{ runs: [failed("tests"), run("tests", "completed", "success", 9426)] }]);
    expect([r.code, r.result]).toEqual([1, "FAIL tests"]);
  });
});

describe("Упавший чек завершает ожидание сразу — о красном CI сессия узнаёт, не дожидаясь долгих чеков", () => {
  it("упавший чек при другом ещё pending — FAIL сразу, не дожидаясь pending", () => {
    // превью-деплой не завершится никогда: без раннего выхода — TIMEOUT
    const r = waitPr([{ statuses: [status("preview", "pending")], runs: [failed("tests")] }]);
    expect([r.code, r.result]).toEqual([1, "FAIL tests"]);
  });

  it("с --wait-all упавший чек — FAIL, только когда завершились все", () => {
    const r = waitPr(
      [
        { statuses: [status("preview", "pending")], runs: [failed("tests")] },
        { statuses: [status("preview", "success")], runs: [failed("tests")] },
      ],
      ["--wait-all"],
    );
    expect([r.code, r.result]).toEqual([1, "FAIL tests"]);
    expect(r.stdout).toContain("2/2 done; failed: tests");
  });
});

describe("PR ждут по SHA его головы, пока чеки не зарегистрируются и не завершатся", () => {
  it("чеки PR читаются по SHA головы через REST — и статусы хостинга, и check-runs Actions", () => {
    const r = waitPr([
      { statuses: [status("preview", "pending")], runs: [run("tests", "in_progress")] },
      { statuses: [status("preview", "success")], runs: [ok("tests")] },
    ]);
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
    expect(calls()).toContain(`repos/{owner}/{repo}/commits/${HEAD}/status`);
  });

  it("сразу после push чеков PR ещё нет — ожидание, а не ошибка", () => {
    // пять пустых опросов подряд — порог ERROR, если бы пустота считалась ошибкой
    const r = waitPr([{}, {}, {}, {}, {}, { runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  /** Так выглядел PR, на котором CI не запустился: статус хостинга есть, Actions нет; `tests` появляется поздно. */
  function waitRequiredTests() {
    const preview = status("preview", "success");
    return waitPr([{ statuses: [preview] }, { statuses: [preview] }, { statuses: [preview] }, { statuses: [preview], runs: [ok("tests")] }]);
  }

  it("обязательный чек базовой ветки из ruleset ещё не зарегистрирован — ожидание, хотя остальные завершились", () => {
    write("rules", [[{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "tests" }] } }]]);
    const r = waitRequiredTests();
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
  });

  it("обязательный чек базовой ветки из классической защиты ещё не зарегистрирован — ожидание, хотя остальные завершились", () => {
    write("branch", [{ protection: { required_status_checks: { enforcement_level: "non_admins", contexts: ["tests"] } } }]);
    const r = waitRequiredTests();
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
  });
});

/**
 * Ожидание CI — главный расход времени сессии (#432): медиана 25 мин на сессию в одном проекте, 86 — в другом, а владелец
 * не видел, чего ждём. Пульс на каждый опрос давал в выходном файле простыню, и агент читал его — до уведомления и после.
 */
describe("Ожидание показывает, чего ждёт, и не рвётся на лимите API", () => {
  it("ожидание печатает строку только при смене состояния чеков", () => {
    const pending = { runs: [run("tests", "in_progress")] };
    const r = waitCommit([pending, pending, pending, pending, { runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
    // фоновое ожидание пишет stdout и stderr в один файл: шесть опросов — две строки состояния и итог
    expect([...lines(r.stdout), ...lines(r.stderr)]).toEqual([
      expect.stringMatching(/ commit@e6dba3b: 0\/1 done; waiting: tests$/),
      expect.stringMatching(/ commit@e6dba3b: 1\/1 done$/),
      "RESULT: PASS (1 checks)",
    ]);
  });

  it("строка состояния называет ожидаемые чеки и прошедшее время", () => {
    write("rules", [[{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "e2e" }] } }]]);
    const r = waitPr(
      [
        { statuses: [status("preview", "pending")], runs: [run("tests", "in_progress")] },
        { statuses: [status("preview", "success")], runs: [run("tests", "in_progress")] },
        { statuses: [status("preview", "success")], runs: [ok("tests"), ok("e2e")] },
      ],
      ["--interval", "30"],
    );
    expect([r.code, r.result]).toEqual([0, "PASS (3 checks)"]);
    expect(lines(r.stdout)).toEqual([
      expect.stringMatching(/^\d\d:\d\d:\d\d \+0s pr#1@4270c1c: 0\/2 done; waiting: preview, tests; missing required: e2e$/),
      expect.stringMatching(/ \+30s pr#1@4270c1c: 1\/2 done; waiting: tests; missing required: e2e$/),
      expect.stringMatching(/ \+1m00s pr#1@4270c1c: 3\/3 done$/),
      "RESULT: PASS (3 checks)",
    ]);
  });

  it("исчерпанный лимит GitHub API — ожидание ждёт сброса и продолжается", () => {
    // шесть отказов подряд — больше порога ERROR в пять ошибок gh; квота сбросится через 10 минут — позже срока ожидания
    const limit = "gh: API rate limit exceeded for user ID 1. (HTTP 403)";
    write("pull", [limit, limit, limit, limit, limit, limit, { head: { sha: HEAD }, base: { ref: "main" }, mergeable: true }]);
    write("rate_limit", [{ resources: { core: { limit: 5000, remaining: 0, reset: CLOCK + 600 } } }]);
    writeChecks([{ runs: [ok("tests")] }]);
    const r = ciWait(["pr", "1", "--timeout", "300"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
    expect(sleeps()[0]).toBe(601);
    expect(r.stdout).toContain("pr#1: API rate limit — next poll in 10m01s");
  });

  it("интервал опроса растёт с длиной ожидания", () => {
    const pending = { runs: [run("deploy", "in_progress")] };
    const r = waitCommit([...Array(40).fill(pending), { runs: [ok("deploy")] }], ["--timeout", "7200"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
    const naps = sleeps();
    // первые 200 с — начальный интервал, дальше десятая доля прошедшего, не больше 5 минут
    expect(naps.slice(0, 10)).toEqual(Array(10).fill(20));
    expect(naps.slice(10, -1)).toEqual([...naps.slice(10, -1)].sort((a, b) => a - b));
    expect(Math.max(...naps)).toBe(300);
    // подтверждающий опрос перед PASS — снова начальный: выросший интервал только задержал бы итог
    expect(naps.at(-1)).toBe(20);
  });
});

/**
 * Сбой `gh` — не исход (#330): во время инцидента GitHub разовый сбой проверки коммита до опроса давал «коммит не
 * найден», код 3, хотя коммит был, — а сессия читает ERROR как неверный вызов. «Нет» — только ответ «нет» от API.
 */
describe("Разовый сбой API до начала опроса — повтор, как в опросе, а не исход «не найден»", () => {
  const BAD_GATEWAY = "gh: Server Error (HTTP 502)";

  it("ожидание чеков коммита переживает разовый сбой API до начала опроса", () => {
    write("commit", [BAD_GATEWAY, { sha: SHA }]);
    const r = waitCommit([{ runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  it("коммита нет в репозитории — ERROR сразу, а не ожидание до таймаута", () => {
    write("commit", [`gh: No commit found for SHA: ${SHA} (HTTP 422)`]);
    const r = waitCommit([{ runs: [ok("tests")] }]);
    expect(r.code).toBe(3);
    expect(r.result).toStartWith(`ERROR commit ${SHA} not found in repository`);
  });

  it("проверка коммита сбоит пять раз подряд — ERROR с текстом ответа gh", () => {
    write("commit", [BAD_GATEWAY]);
    const r = waitCommit([{ runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([3, `ERROR gh: ${BAD_GATEWAY}`]);
  });

  it("разовый сбой API при чтении обязательных чеков базовой ветки — повтор, а не PR без обязательных", () => {
    write("rules", [BAD_GATEWAY, [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "tests" }] } }]]);
    const preview = status("preview", "success");
    const r = waitPr([{ statuses: [preview] }, { statuses: [preview] }, { statuses: [preview] }, { statuses: [preview], runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
  });

  // сторож от перекоррекции: повтор на любой отказ дал бы ERROR на приватном репо без прав читать правила
  it("правила базовой ветки читать нельзя (403) — обязательных нет, а не ERROR", () => {
    write("rules", ["gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)"]);
    const r = waitPr([{ runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });
});

/**
 * Сразу после force-push GitHub ещё отдаёт `mergeable: false` прежней головы (#472): её конфликт с `main` и был причиной
 * ребейза, а у новой головы конфликта нет и CI на ней уже идёт. Конфликт — только подтверждённый повторным опросом той же
 * головы.
 */
describe("PR с конфликтом с базой не ждут — CI на нём не запустится", () => {
  const pulls = () => calls().filter((c) => c === "repos/{owner}/{repo}/pulls/1").length;

  it("конфликт текущей головы с базой — ERROR, как только повторный опрос той же головы его подтвердил", () => {
    const r = waitPr([{ mergeable: false, statuses: [status("preview", "pending")] }]);
    expect(r.code).toBe(3);
    expect(r.result).toStartWith("ERROR conflict with base main");
    expect(pulls()).toBe(2);
  });

  it("сразу после force-push устаревший mergeable=false прежней головы — ожидание, а не ERROR", () => {
    const tests = run("tests", "in_progress");
    const r = waitPr([{ mergeable: false, runs: [tests] }, { runs: [tests] }, { runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
    expect(r.stdout).toContain("waiting: conflict with base main: rechecking, tests");
  });

  // сторож от перекоррекции: два `false` подряд без сверки головы дали бы ERROR
  it("mergeable=false прежней головы не подтверждает конфликт новой", () => {
    const r = waitPr([{ mergeable: false, head: SHA }, { mergeable: false }, { runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  it("mergeable ещё не вычислен — ожидание, а не ERROR", () => {
    const r = waitPr([{ mergeable: null }, { mergeable: null, runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });
});

/**
 * После мержа SHA добывали отдельными ходами `gh pr view` (замер #285: в 10 закрытиях из 17), на пиковом контексте
 * сессии; `merged <N>` берёт его из PR сам — ожидание запускается тем же ходом, что `task actualize`.
 */
describe("Коммит мержа ждут по номеру PR — SHA мержа скрипт берёт сам", () => {
  it("влитый PR — ждут чеки коммита мержа: SHA скрипт берёт из PR сам", () => {
    write("pull", [{ state: "closed", merged: true, merge_commit_sha: MERGE, head: { sha: HEAD }, base: { ref: "main" } }]);
    writeChecks([{ runs: [run("deploy", "queued")] }, { runs: [ok("deploy")] }]);
    const r = ciWait(["merged", "7"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
    expect(calls()).toContain(`repos/{owner}/{repo}/commits/${MERGE}/status`);
    expect(calls().filter((c) => c.includes(HEAD))).toEqual([]);
  });

  it("невлитый PR — ERROR сразу, а не ожидание чеков", () => {
    write("pull", [{ state: "open", merged: false, merge_commit_sha: HEAD, head: { sha: HEAD }, base: { ref: "main" } }]);
    writeChecks([{ runs: [run("tests", "in_progress")] }]);
    const r = ciWait(["merged", "7"]);
    expect(r.code).toBe(3);
    expect(r.result).toStartWith("ERROR PR #7 not merged");
  });
});

/**
 * Публикация спеки — выкладка документации, а не проверка (#443): за три недели в проектах ни одной находки, а её
 * гонка пуша делала ожидание после мержа FAIL — деплой и чеки main ждутся без неё.
 */
describe("Публикация спеки — не проверка: её исход и незавершённость не решают ожидание", () => {
  it("упавшая публикация спеки не делает ожидание после мержа FAIL", () => {
    write("pull", [{ state: "closed", merged: true, merge_commit_sha: MERGE, head: { sha: HEAD }, base: { ref: "main" } }]);
    // публикация ещё идёт, когда деплой уже зелёный, — её не ждут; затем падает — и тот же job в реюзабельном workflow
    writeChecks([
      { runs: [ok("tests"), run("deploy", "in_progress"), run("spec-publish", "in_progress")] },
      { runs: [ok("tests"), ok("deploy"), failed("spec-publish"), failed("ci / spec-publish")] },
    ]);
    const r = ciWait(["merged", "7"]);
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
    expect(r.stdout).not.toContain("spec-publish");
  });

  it("публикацию спеки, названную в --context, ждут, как любой чек", () => {
    write("pull", [{ state: "closed", merged: true, merge_commit_sha: MERGE, head: { sha: HEAD }, base: { ref: "main" } }]);
    writeChecks([{ runs: [ok("tests"), failed("spec-publish")] }]);
    const r = ciWait(["merged", "7", "--context", "spec-publish"]);
    expect([r.code, r.result]).toEqual([1, "FAIL spec-publish"]);
  });
});

/**
 * Прогон Actions, упавший без единого job, check-run не даёт (#356): PR правил `ci.yml`, файл перестал разбираться, и
 * GitHub оставил на голове только прогон-«пустышку» — имя прогона — путь файла, событие push, без job. Ожидание видело
 * одни чеки хостинга и отдало PASS — PR без единого прогона тестов был бы влит. У PR из форка нет и «пустышки»: тогда
 * не PASS даёт workflow, который по своему `on:` на голове срабатывает на PR, а прогона не дал.
 */
describe("Прогон Actions, не ставший чеком, — не PASS: workflow не разобран, не стартовал или не дал прогона на PR", () => {
  const preview = status("preview", "success");

  it("ci-wait pr: прогон Actions с ошибкой разбора workflow на голове PR — FAIL с путём файла", () => {
    const r = waitPr([{ statuses: [preview], workflowRuns: [unparsed()] }]);
    expect(r.code).toBe(1);
    expect(r.result).toStartWith(`FAIL workflow not parsed: ${CI} https://github.com/o/r/actions/runs/`);
  });

  it("ci-wait merged: прогон Actions с ошибкой разбора workflow на SHA мержа — FAIL с путём файла", () => {
    write("pull", [{ state: "closed", merged: true, merge_commit_sha: MERGE, head: { sha: HEAD }, base: { ref: "main" } }]);
    writeChecks([{ statuses: [preview], workflowRuns: [unparsed()] }]);
    const r = ciWait(["merged", "7"]);
    expect(r.code).toBe(1);
    expect(r.result).toStartWith(`FAIL workflow not parsed: ${CI}`);
    expect(calls()).toContain(`repos/{owner}/{repo}/actions/runs?head_sha=${MERGE}&per_page=100`);
  });

  it("прогон Actions упал, не начав ни одного job, — FAIL с путём файла", () => {
    const r = waitCommit([{ statuses: [preview], workflowRuns: [wfRun("startup_failure", { event: "push", check_suite_id: 98 })] }]);
    expect(r.code).toBe(1);
    expect(r.result).toStartWith(`FAIL workflow failed without jobs: ${CI}`);
  });

  // сторож от перекоррекции: job упавшего прогона — уже упавший чек, пометка «без job» к нему не добавляется
  it("прогон Actions упал на job — FAIL по имени job, без пометки «без job»", () => {
    const r = waitCommit([{ runs: [failed("tests")], workflowRuns: [wfRun("failure")] }]);
    expect([r.code, r.result]).toEqual([1, "FAIL tests"]);
  });

  it("ci-wait pr: только чеки хостинга, а workflow с `on: pull_request` не дал прогона — не PASS", () => {
    workflow("on:\n  pull_request:\n    branches: [main]\n");
    const r = waitPr([{ statuses: [preview] }], ["--timeout", "2"]);
    expect(r.code).toBe(2);
    expect(r.result).toEndWith(`no run of workflow: ${CI})`);
    expect(calls()).toContain(`repos/{owner}/{repo}/contents/${CI}?ref=${HEAD}`);
  });

  it("workflow на голове PR не разбирается, а прогона-«пустышки» нет (PR из форка) — не PASS", () => {
    workflow("on: pull_request\njobs:\n  t:\n    steps:\n      - run: echo '{ \"a\": 1 }' > f\n");
    const r = waitPr([{ statuses: [preview] }], ["--timeout", "2"]);
    expect(r.code).toBe(2);
    expect(r.result).toEndWith(`no run of workflow: ${CI})`);
  });

  const due: [string, string][] = [
    ["on: pull_request", "on: pull_request\n"],
    ["on: [push, pull_request]", "on: [push, pull_request]\n"],
    ["ветки, пускающие базовую", "on:\n  pull_request:\n    branches: [develop, 'm*n']\n"],
    ["branches-ignore без базовой", "on:\n  pull_request:\n    branches-ignore: ['release/**']\n"],
    ["types с synchronize", "on:\n  pull_request:\n    types: [opened, synchronize]\n"],
  ];
  for (const [title, yaml] of due) {
    it(`workflow на PR (${title}) ждут: PASS — только с его прогоном и чеками`, () => {
      workflow(yaml);
      const later = { statuses: [preview], runs: [ok("tests")], workflowRuns: [wfRun("success")] };
      const r = waitPr([{ statuses: [preview] }, { statuses: [preview] }, { statuses: [preview] }, later]);
      expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
    });
  }

  // сторожа от перекоррекции: пойдёт ли такой workflow на этот PR, без диффа не решить — ожидание дало бы ложный TIMEOUT
  const notDue: [string, string, string?][] = [
    ["только push", "on:\n  push:\n    branches: [main]\n"],
    ["фильтр путей", "on:\n  pull_request:\n    paths: ['src/**']\n"],
    ["ветки без базовой", "on:\n  pull_request:\n    branches: ['release/**']\n"],
    ["отрицание в ветках", "on:\n  pull_request:\n    branches: ['**', '!main']\n"],
    ["types без synchronize", "on:\n  pull_request:\n    types: [labeled]\n"],
    ["pull_request_target", "on: pull_request_target\n"],
    ["workflow выключен", "on: pull_request\n", "disabled_manually"],
  ];
  for (const [title, yaml, state] of notDue) {
    it(`workflow, который на PR может не пойти (${title}), не ждут — PASS по остальным чекам`, () => {
      workflow(yaml, state);
      const r = waitPr([{ statuses: [preview] }]);
      expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
    });
  }
});

/**
 * Прогон workflow в очереди check-runs ещё не дал (#360): на голове PR были только превью-деплой и его комментарий, а
 * прогон CI стоял `queued`. Прогон на SHA есть — workflow не «без прогона», и не упал — не FAIL; ожидание отдало PASS
 * по чекам хостинга, мерж ушёл бы без CI.
 */
describe("Прогон Actions, ещё не давший check-runs, — ожидание, а не PASS по одним чекам хостинга", () => {
  it("прогон workflow в очереди без check-runs держит ожидание", () => {
    const preview = status("preview", "success");
    const queued = { statuses: [preview], workflowRuns: [wfRun(null, { status: "queued" })] };
    const done = { statuses: [preview], runs: [ok("tests")], workflowRuns: [wfRun("success")] };
    const r = waitPr([queued, queued, queued, done]);
    expect([r.code, r.result]).toEqual([0, "PASS (2 checks)"]);
    expect(r.stdout).toContain(`waiting: workflow queued: ${CI}`);
  });
});

/**
 * Красный `main` чинит одна сессия по багу «main красный…», остальные ждут его закрытия (`github pr premerge`, код 3,
 * #282): фоновой командой, чьё завершение будит сессию, а не опросом руками.
 */
describe("Issue ждут до закрытия — баг на красный main будит сессию, когда его закрыли", () => {
  it("открытый issue — ожидание, закрытый — PASS с причиной закрытия", () => {
    write("issue", [{ state: "open" }, { state: "open" }, { state: "closed", state_reason: "completed" }]);
    const r = ciWait(["issue", "41"]);
    expect([r.code, r.result]).toEqual([0, "PASS issue #41 closed (completed)"]);
    expect(calls().filter((c) => c === "repos/{owner}/{repo}/issues/41")).toHaveLength(3);
  });

  it("issue нет — ERROR сразу, а не ожидание до таймаута", () => {
    write("issue", ["gh: Not Found (HTTP 404)"]);
    const r = ciWait(["issue", "41"]);
    expect(r.code).toBe(3);
    expect(r.result).toStartWith("ERROR issue #41 not found");
  });
});
