import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, aiDevPackage, copyPackage, npxPackage, sandbox, type AiDevPackage, type Run, type Sandbox } from "../../lib/ai-dev.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// пакет ai-dev собирается один раз на файл
let packages: { dir: string; cleanup: () => void };
let base: AiDevPackage;
beforeAll(() => {
  packages = tmpDir();
  base = aiDevPackage(path.join(packages.dir, "base"));
});
afterAll(() => packages.cleanup());

const read = (p: string) => readFileSync(p, "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.email=spec@example.test", "-c", "user.name=spec"];

// клон владельца, из которого выпускается релиз; origin — upstream: тест коммитит туда после клонирования и ставит теги
function owner() {
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  const bin = path.join(clone, "bin/ai-dev.mjs");
  const tag = (name: string) => up.repo.git("tag", name);
  const rule = (text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  return { up, clone, tag, rule, release: (args: string[] = ["--dry-run"]) => aiDev(sb, ["release", ...args], { bin }) };
}

// прошлый релиз — дата в прошлом: в день, совпавший с ней, релиз был бы патчем того же дня (.1), а не тегом дня
const PREV = "v2025.01.15";
const today = () => `v${new Date().toISOString().slice(0, 10).replaceAll("-", ".")}`;

// тег релиза — день запуска по UTC: день берём до и после запуска, чтобы полночь между ними не роняла тест
function dated(run: () => Run) {
  const before = today();
  const r = run();
  return { r, tag: r.stdout.split(" ")[0] ?? "", days: [before, today()] };
}

describe("Релиз — тег по дате на origin/main и список изменений флоу с прошлого релиза", () => {
  it("в списке — изменения флоу и установщика с прошлого релиза, остальные коммиты — нет; --dry-run ничего не создаёт", () => {
    const o = owner();
    o.tag(PREV);
    o.up.repo.commit(o.rule("Новое правило."), "docs(agents): новое правило");
    o.up.repo.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    o.up.repo.commit({ "bin/ai-dev.mjs": read(path.join(o.up.dir, "bin/ai-dev.mjs")) + "// правка\n" }, "fix(install): правка установщика");
    o.up.repo.commit({ "skills/est/SKILL.md": read(path.join(o.up.dir, "skills/est/SKILL.md")) + "\nшаг\n" }, "feat(est): новый шаг");
    const { r, tag, days } = dated(() => o.release());
    expect(r.code).toBe(0);
    expect(days).toContain(tag);
    expect(r.stdout).toContain(`Изменения флоу с ${PREV}:`);
    expect(r.stdout).toContain("- docs(agents): новое правило");
    expect(r.stdout).toContain("- fix(install): правка установщика");
    expect(r.stdout).toContain("- feat(est): новый шаг");
    expect(r.stdout).not.toContain("только тесты");
    expect(o.up.repo.git("tag", "--list")).toBe(PREV);
  });

  it("PR, влитый merge-коммитом, — строкой с заголовком PR и номером, без коммитов его ветки", () => {
    const o = owner();
    o.tag(PREV);
    o.up.repo.git("switch", "-q", "-c", "feat/7-x");
    o.up.repo.commit(o.rule("Правило из PR."), "wip: черновик");
    o.up.repo.git("switch", "-q", "main");
    o.up.repo.git(...ID, "merge", "-q", "--no-ff", "-m", "Merge pull request #7 from miroshnik/feat/7-x", "-m", "feat(agents): правило из PR", "feat/7-x");
    const r = o.release();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("- feat(agents): правило из PR (#7)");
    expect(r.stdout).not.toContain("черновик");
  });

  // мерж — только rebase: в main уходят сами коммиты ветки, у каждого в теле «Refs #N» задачи
  it("PR, влитый rebase, — коммитами ветки, каждый с номером задачи из Refs", () => {
    const o = owner();
    o.tag(PREV);
    o.up.repo.commit(o.rule("Правило из PR."), "feat(agents): правило из PR\n\nRefs #7");
    o.up.repo.commit({ "bin/ai-dev.mjs": read(path.join(o.up.dir, "bin/ai-dev.mjs")) + "// правка\n" }, "fix(install): правка под правило\n\nПричина в одну строку.\nRefs #7");
    const r = o.release();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("- feat(agents): правило из PR (#7)");
    expect(r.stdout).toContain("- fix(install): правка под правило (#7)");
  });

  it("релиз того же дня уже есть — патч: .1, затем .2", () => {
    const o = owner();
    const first = today();
    o.tag(first);
    o.up.repo.commit(o.rule("Срочно."), "fix(agents): срочно");
    const a = dated(() => o.release());
    // день сменился после тега — тогда патча нет, тег нового дня
    expect([`${first}.1`, a.days[1] !== first ? a.days[1] : null]).toContain(a.tag);
    if (a.tag !== `${first}.1`) return;
    o.tag(a.tag);
    o.up.repo.commit(o.rule("Ещё срочнее."), "fix(agents): ещё срочнее");
    const b = dated(() => o.release());
    expect([`${first}.2`, b.days[1] !== first ? b.days[1] : null]).toContain(b.tag);
  });

  it("origin/main уже в релизе или с прошлого релиза флоу не менялся — отказ, код 1", () => {
    const o = owner();
    o.tag(PREV);
    const same = o.release();
    expect(same.code).toBe(1);
    expect(same.stderr).toContain(`уже в релизе ${PREV}`);
    o.up.repo.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const r = o.release();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`с ${PREV} флоу не менялся`);
  });

  it("первый релиз — без списка изменений, с пометкой «Первый релиз»", () => {
    const o = owner();
    const { r, tag, days } = dated(() => o.release());
    expect(r.code).toBe(0);
    expect(days).toContain(tag);
    expect(r.stdout).toContain("Первый релиз");
  });

  it("release — GitHub Release командой gh: тег, коммит origin/main, заголовок и список изменений", () => {
    const o = owner();
    o.tag(PREV);
    const sha = o.up.repo.commit(o.rule("Новое правило."), "docs(agents): новое правило");
    // gh песочницы записывает свои аргументы
    const out = path.join(sb.tmp, "gh-args.json");
    const script = `#!/bin/sh\nexec node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${out}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "gh"), script, { mode: 0o755 });
    const { r, tag, days } = dated(() => o.release([]));
    expect(r.code).toBe(0);
    expect(days).toContain(tag);
    const args: string[] = JSON.parse(read(out));
    expect(args.slice(0, 9)).toEqual(["release", "create", tag, "--repo", "miroshnik/ai-dev", "--target", sha, "--title", tag]);
    expect(args[9]).toBe("--notes");
    expect(args[10]).toContain("- docs(agents): новое правило");
    expect(r.stdout).toContain(`https://github.com/miroshnik/ai-dev/releases/tag/${tag}`);
  });

  it("не из клона ai-dev — отказ, код 2", () => {
    const bin = npxPackage(path.join(sb.tmp, "npx"), base.dir, base.sha);
    const r = aiDev(sb, ["release", "--dry-run"], { bin });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("только из клона ai-dev");
  });
});
