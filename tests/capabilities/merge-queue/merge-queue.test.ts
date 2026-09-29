import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

import { main } from "../../../skills/github/scripts/github.ts";
import { FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";

// `gh` подменён: открытые PR — FakeGitHub.pulls, остальное — записанные ответы GitHub проекта ai-dev
const REC: Recording = JSON.parse(readFileSync(new URL("../../lib/github-ai-dev.json", import.meta.url), "utf8"));
const REPO = "miroshnik/ai-dev";

function queue(f: FakeGitHub, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["pr", "queue", ...args, "--repo", REPO], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/**
 * Каждый мерж в основную ветку заставляет остальные ветки ребейзить и гонять CI заново. Поэтому push и ожидание CI —
 * только у головы: остальные ребейзят локально и ждут её мержа. Голова — PR, который не отстаёт от основной ветки и
 * у которого CI зелёный или идёт; из нескольких — меньший номер.
 */
describe("Push, CI и мерж — только у головы очереди мержа", () => {
  it("другой PR репозитория с идущим CI — ветка не голова, предупреждение называет PR впереди", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 151, title: "Биллинг · Экспорт", ci: "PENDING" });
    f.pull({ number: 153, behind: 2, ci: "SUCCESS" });
    const r = queue(f, ["153"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("⚠ #153 — не голова очереди: впереди #151 «Биллинг · Экспорт» (CI идёт)");
    expect(r.out).toContain("push — после их мержа");
  });

  it("других PR в фазе мержа нет — ветка голова, предупреждения нет", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 153, behind: 2, ci: "SUCCESS" });
    const r = queue(f, ["153"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✅ #153 — голова очереди: ребейз на main, push, CI и мерж — твои");
    expect(r.out).not.toContain("⚠");
  });

  it("отставший от основной ветки PR очередь не держит", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 151, behind: 3, ci: "SUCCESS" });
    f.pull({ number: 153 });
    const r = queue(f, ["153"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ #151 — отстаёт от main на 3, очередь не держит");
  });

  it("PR с красным CI, черновик и PR без ветки очередь не держат", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 150, ci: "FAILURE" });
    f.pull({ number: 151, draft: true });
    f.pull({ number: 152, behind: null });
    f.pull({ number: 153 });
    const r = queue(f, ["153"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ #150 — CI красный, очередь не держит");
    expect(r.out).toContain("○ #151 — черновик, очередь не держит");
    expect(r.out).toContain("○ #152 — ветки нет, очередь не держит");
  });

  it("зелёный PR ждёт мержа и PR, чьи чеки ещё не зарегистрированы, — держат очередь", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 150, ci: "SUCCESS" });
    f.pull({ number: 151, ci: null });
    f.pull({ number: 153, behind: 1 });
    const r = queue(f, ["153"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("впереди #150 «PR 150» (CI зелёный, ждёт мержа), #151 «PR 151» (чеков ещё нет)");
  });

  it("оба PR актуальны и в CI — голова тот, у кого номер меньше; ему — кто за ним", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 151 });
    f.pull({ number: 153 });
    const second = queue(f, ["153"]);
    expect(second.code).toBe(1);
    expect(second.out).toContain("впереди #151");
    const first = queue(f, ["151"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("за тобой: #153 — после мержа напиши им «влит, твоя очередь»");
  });

  it("у ветки ещё нет PR — впереди все PR в фазе мержа; PR ветки находится по её имени", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 151 });
    f.pull({ number: 153, head: "fix/153-y", draft: true });
    const fresh = queue(f, ["--head", "feat/160-new"]);
    expect(fresh.code).toBe(1);
    expect(fresh.out).toContain("у ветки feat/160-new ещё нет PR");
    expect(fresh.out).toContain("⚠ ветка feat/160-new — не голова очереди: впереди #151");
    const own = queue(f, ["--head", "fix/153-y"]);
    expect(own.out).toContain("⚠ #153 — не голова очереди: впереди #151");
  });

  it("PR не открыт в основную ветку — ошибка", () => {
    const f = new FakeGitHub(REC);
    f.pull({ number: 151, base: "release" });
    const r = queue(f, ["151"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("PR #151 — не открытый PR в main");
  });
});
