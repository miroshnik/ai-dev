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

// `gh` — внешний край, подменяется он: ответы — массивы JSON в <вид>.json, по одному на вызов, последний
// повторяется; строка — ошибка gh (текст в stderr, код 1), как «API rate limit exceeded»; нет файла — `{}`.
// Пути вызовов `gh api` пишутся в calls. GraphQL (`gh pr checks`, `gh pr view`) — ошибка: скрипт ходит по REST.
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "api rate_limit") kind=rate_limit ;;
  api\\ *) case "$2" in
      */check-runs*) kind=check-runs ;;
      */status) kind=status ;;
      */pulls/*) kind=pull ;;
      */rules/branches/*) kind=rules ;;
      */branches/*) kind=branch ;;
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

let sb: { dir: string; cleanup: () => void };
beforeEach(() => {
  sb = tmpDir();
  writeFileSync(path.join(sb.dir, "gh"), FAKE_GH);
  chmodSync(path.join(sb.dir, "gh"), 0o755);
});
afterEach(() => sb.cleanup());

interface CheckRun { name: string; status: string; conclusion: string | null; html_url: string }
interface Status { context: string; state: string; target_url: string }
const run = (name: string, status: string, conclusion: string | null = null): CheckRun => ({ name, status, conclusion, html_url: "" });
const ok = (name: string) => run(name, "completed", "success");
const failed = (name: string) => run(name, "completed", "failure");
const status = (context: string, state: string): Status => ({ context, state, target_url: "" });
const write = (kind: string, v: unknown[]) => writeFileSync(path.join(sb.dir, `${kind}.json`), JSON.stringify(v));
const calls = () => readFileSync(path.join(sb.dir, "calls"), "utf8").split("\n");

function ciWait(args: string[]) {
  const r = spawnSync("bash", [SCRIPT, ...args, "--interval", "0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${sb.dir}:${process.env.PATH}`, FAKE_GH: sb.dir },
  });
  if (r.error) throw r.error;
  return { code: r.status, result: /^RESULT: (.*)$/m.exec(r.stdout)?.[1] ?? `(нет RESULT) ${r.stdout}${r.stderr}`, stdout: r.stdout };
}

interface Poll { statuses?: Status[]; runs?: CheckRun[] }
function writeChecks(polls: Poll[]) {
  write("status", polls.map((p) => ({ state: "pending", statuses: p.statuses ?? [] })));
  write("check-runs", polls.map((p) => ({ total_count: p.runs?.length ?? 0, check_runs: p.runs ?? [] })));
}

/** Коммит: на каждый опрос — его статусы и check-runs. */
function waitCommit(polls: Poll[], args: string[] = []) {
  writeChecks(polls);
  return ciWait(["status", SHA, "--timeout", "5", ...args]);
}

/** PR: на каждый опрос — `mergeable` (по умолчанию true) и чеки его головы. */
function waitPr(polls: (Poll & { mergeable?: boolean | null })[], args: string[] = []) {
  write("pull", polls.map((p) => ({ head: { sha: HEAD }, base: { ref: "main" }, mergeable: p.mergeable === undefined ? true : p.mergeable })));
  writeChecks(polls);
  return ciWait(["pr", "1", "--timeout", "5", ...args]);
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
    expect(r.stdout).toContain("CHECK deploy: pending");
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
      { runs: [ok("tests"), run("spec-publish", "queued")] },
      { runs: [ok("tests"), ok("spec-publish")] },
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
    expect(r.result).toStartWith("TIMEOUT");
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
    expect(r.stdout).toContain("CHECK preview: pass");
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

  it("лимит API — ожидание до сброса, а не ERROR", () => {
    // шесть отказов подряд: порог ERROR — пять ошибок gh
    const limit = "gh: API rate limit exceeded for user ID 1. (HTTP 403)";
    write("pull", [limit, limit, limit, limit, limit, limit, { head: { sha: HEAD }, base: { ref: "main" }, mergeable: true }]);
    write("rate_limit", [{ resources: { core: { limit: 5000, remaining: 0, reset: 0 } } }]);
    writeChecks([{ runs: [ok("tests")] }]);
    const r = ciWait(["pr", "1", "--timeout", "5"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });
});

describe("PR с конфликтом с базой не ждут — CI на нём не запустится", () => {
  it("PR с конфликтом с базой — ERROR сразу: CI на нём не запустится", () => {
    const r = waitPr([{ mergeable: false, statuses: [status("preview", "pending")] }]);
    expect(r.code).toBe(3);
    expect(r.result).toStartWith("ERROR conflict with base main");
  });

  it("mergeable ещё не вычислен — ожидание, а не ERROR", () => {
    const r = waitPr([{ mergeable: null }, { mergeable: null, runs: [ok("tests")] }]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });
});
