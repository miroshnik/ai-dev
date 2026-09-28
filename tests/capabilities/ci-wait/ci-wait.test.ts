import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SCRIPT = fileURLToPath(new URL("../../../skills/ci-wait/scripts/wait-ci.sh", import.meta.url));
const SHA = "e6dba3bc59256d1324b2f0de3914dfaa56ea8786";

// `gh` — внешний край, подменяется он: ответы — массивы JSON в <вид>.json, по одному на опрос, последний
// повторяется; строка — ошибка gh (текст в stderr, код 1), как «no checks reported» у `gh pr checks`
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "pr checks") kind=pr-checks ;;
  api\\ *) case "$2" in */check-runs*) kind=check-runs ;; */status) kind=status ;; *) exit 0 ;; esac ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
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
const status = (context: string, state: string): Status => ({ context, state, target_url: "" });

function ciWait(args: string[]) {
  const r = spawnSync("bash", [SCRIPT, ...args, "--interval", "0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${sb.dir}:${process.env.PATH}`, FAKE_GH: sb.dir },
  });
  if (r.error) throw r.error;
  return { code: r.status, result: /^RESULT: (.*)$/m.exec(r.stdout)?.[1] ?? `(нет RESULT) ${r.stdout}${r.stderr}`, stdout: r.stdout };
}

/** Коммит: на каждый опрос — его статусы и check-runs. */
function waitCommit(polls: { statuses?: Status[]; runs?: CheckRun[] }[], args: string[] = []) {
  const write = (kind: string, v: unknown[]) => writeFileSync(path.join(sb.dir, `${kind}.json`), JSON.stringify(v));
  write("status", polls.map((p) => ({ state: "pending", statuses: p.statuses ?? [] })));
  write("check-runs", polls.map((p) => ({ total_count: p.runs?.length ?? 0, check_runs: p.runs ?? [] })));
  return ciWait(["status", SHA, "--timeout", "5", ...args]);
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
    const r = waitCommit([{ runs: [ok("tests"), run("lint", "completed", "failure")] }]);
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
    const r = waitCommit([{ runs: [ok("tests"), run("lint", "completed", "failure")] }], ["--context", "tests"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });

  it("чеки не завершились к сроку — TIMEOUT", () => {
    const r = waitCommit([{ runs: [run("tests", "in_progress")] }], ["--timeout", "0"]);
    expect(r.code).toBe(2);
    expect(r.result).toStartWith("TIMEOUT");
  });
});

describe("PR ждут, пока его чеки не зарегистрируются и не завершатся", () => {
  it("сразу после push «no checks reported» — ожидание, а не ошибка", () => {
    // пять ответов подряд — порог ERROR, если бы «no checks reported» считался ошибкой gh
    const none = "no checks reported on the 'feat/1-x' branch";
    writeFileSync(path.join(sb.dir, "pr-checks.json"), JSON.stringify([none, none, none, none, none, [{ name: "tests", bucket: "pass" }]]));
    const r = ciWait(["pr", "1", "--timeout", "5"]);
    expect([r.code, r.result]).toEqual([0, "PASS (1 checks)"]);
  });
});
