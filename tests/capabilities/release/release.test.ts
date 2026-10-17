import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { elves, elvesPackage, bunxPackage, copyPackage, REPO, sandbox, type ElvesPackage, type Run, type Sandbox } from "../../lib/elves.ts";
import { PACK_VERSION, packageProject } from "../../lib/npm.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// пакет Elves собирается один раз на файл
let packages: { dir: string; cleanup: () => void };
let base: ElvesPackage;
beforeAll(() => {
  packages = tmpDir();
  base = elvesPackage(path.join(packages.dir, "base"));
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
  const bin = path.join(clone, "bin/elves.ts");
  const tag = (name: string) => up.repo.git("tag", name);
  const rule = (text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  return { up, clone, tag, rule, release: (args: string[] = ["--dry-run"]) => elves(sb, ["release", ...args], { bin }) };
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
    o.up.repo.commit({ "bin/elves.ts": read(path.join(o.up.dir, "bin/elves.ts")) + "// правка\n" }, "fix(install): правка установщика");
    o.up.repo.commit({ "skills/est/SKILL.md": read(path.join(o.up.dir, "skills/est/SKILL.md")) + "\nшаг\n" }, "feat(est): новый шаг");
    const { r, tag, days } = dated(() => o.release());
    expect(r.code).toBe(0);
    expect(days).toContain(tag);
    expect(r.stdout).toContain(`Flow changes since ${PREV}:`);
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
    o.up.repo.commit({ "bin/elves.ts": read(path.join(o.up.dir, "bin/elves.ts")) + "// правка\n" }, "fix(install): правка под правило\n\nПричина в одну строку.\nRefs #7");
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
    expect(same.stderr).toContain(`already in release ${PREV}`);
    o.up.repo.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const r = o.release();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`flow hasn't changed since ${PREV}`);
  });

  it("первый релиз — без списка изменений, с пометкой «First release»", () => {
    const o = owner();
    const { r, tag, days } = dated(() => o.release());
    expect(r.code).toBe(0);
    expect(days).toContain(tag);
    expect(r.stdout).toContain("First release");
  });

  it("release — GitHub Release командой gh: тег, коммит origin/main, заголовок и список изменений", () => {
    const o = owner();
    o.tag(PREV);
    const sha = o.up.repo.commit(o.rule("Новое правило."), "docs(agents): новое правило");
    // gh песочницы записывает свои аргументы
    const out = path.join(sb.tmp, "gh-args.json");
    const script = `#!/bin/sh\nexec "${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${out}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "gh"), script, { mode: 0o755 });
    const { r, tag, days } = dated(() => o.release([]));
    expect(r.code).toBe(0);
    expect(days).toContain(tag);
    const args: string[] = JSON.parse(read(out));
    expect(args.slice(0, 9)).toEqual(["release", "create", tag, "--repo", "miroshnik/elves", "--target", sha, "--title", tag]);
    expect(args[9]).toBe("--notes");
    expect(args[10]).toContain("- docs(agents): новое правило");
    expect(r.stdout).toContain(`https://github.com/miroshnik/elves/releases/tag/${tag}`);
  });

  it("не из клона Elves — отказ, код 2", () => {
    const bin = bunxPackage(path.join(sb.tmp, "bunx"), base.dir, base.sha);
    const r = elves(sb, ["release", "--dry-run"], { bin });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("only from an Elves clone");
  });
});

/**
 * Пакет `@miroshnik/elves` в npm — то, что проект ставит в devDependencies без копии флоу, а облачная сессия получает
 * из реестра (`github:` в ней — 403, #555). Версия — тег релиза в виде semver, публикует CI по тегу.
 */
describe("Релиз публикуется в npm пакетом @miroshnik/elves: версия — тег релиза, публикует CI по тегу", () => {
  it("bun install проекта с @miroshnik/elves в devDependencies приносит пакет с бинарём elves", () => {
    const proj = packageProject("release-bin");
    const installed = JSON.parse(read(path.join(proj, "node_modules/@miroshnik/elves/package.json")));
    expect(installed.version).toBe(PACK_VERSION);
    const r = spawnSync(path.join(proj, "node_modules/.bin/elves"), ["--help"], { cwd: proj, encoding: "utf8" });
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toStartWith("elves — ");
    expect(r.stdout).toContain("\n  bun --no-env-file node_modules/.bin/elves spec-doc ");
  });

  /**
   * Тег календарный, а npm требует semver: без ведущих нулей, патч дня — своим числом. Пререлиз (`-1`) в semver младше
   * самого релиза, build-метаданные (`+1`) npm не различает — поэтому `vГГГГ.ММ.ДД.N` — `ГГГГ.ММДД.N`: порядок версий —
   * порядок тегов. Коммит релиза — в `gitHead`: пакет из npm знает свой SHA без сети (#557).
   */
  it("версия пакета соответствует тегу релиза, gitHead — его коммиту", () => {
    const pkg = copyPackage(base, path.join(sb.tmp, "package"));
    const versionOf = (tag: string) => {
      const r = elves(sb, ["pack", tag], { bin: pkg.bin, cwd: pkg.dir });
      expect({ tag, code: r.code, stderr: r.stderr }).toEqual({ tag, code: 0, stderr: "" });
      const json = JSON.parse(read(path.join(pkg.dir, "package.json")));
      expect(json.gitHead).toBe(pkg.sha);
      return json.version as string;
    };
    const tags = ["v2025.12.31.3", "v2026.01.05", "v2026.01.05.1", "v2026.10.15", "v2026.10.15.2", "v2026.10.15.12"];
    const versions = tags.map(versionOf);
    expect(versions).toEqual(["2025.1231.3", "2026.105.0", "2026.105.1", "2026.1015.0", "2026.1015.2", "2026.1015.12"]);
    expect([...versions].sort(Bun.semver.order)).toEqual(versions);
  });

  it("pack не с тегом релиза — код 2, package.json и dist/ не меняются", () => {
    const pkg = copyPackage(base, path.join(sb.tmp, "package"));
    const before = read(path.join(pkg.dir, "package.json"));
    for (const tag of [[], ["1.2.3"], ["v2026.10.15-rc"], ["v2026.10.15.0"]]) {
      const r = elves(sb, ["pack", ...tag], { bin: pkg.bin, cwd: pkg.dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("a release tag is needed");
    }
    expect(read(path.join(pkg.dir, "package.json"))).toBe(before);
    expect(existsSync(path.join(pkg.dir, "dist"))).toBe(false);
  });

  /**
   * Сборка идёт на машине CI, а работает у проекта: путь машины сборки в ней (`__filename` CommonJS-модуля, который
   * сборщик заменяет строкой) вёл бы в никуда. Такой модуль pack оставляет файлом рядом со сборкой, а путь, всё же
   * запечённый в неё, — отказ до публикации.
   */
  it("pack с путём машины сборки в сборке — код 2, пакет не публикуется", () => {
    const pkg = copyPackage(base, path.join(sb.tmp, "package"));
    const manifest = JSON.parse(read(path.join(pkg.dir, "package.json")));
    manifest.exports["./spec/where"] = { bun: "./skills/spec/scripts/where.ts", default: "./dist/spec/scripts/where.js" };
    writeFileSync(path.join(pkg.dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(path.join(pkg.dir, "skills/spec/scripts/where.cjs"), "module.exports = __filename;\n");
    writeFileSync(path.join(pkg.dir, "skills/spec/scripts/where.ts"), 'import where from "./where.cjs";\n\nexport const file: string = where;\n');
    const r = elves(sb, ["pack", "v2026.10.15"], { bin: pkg.bin, cwd: pkg.dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the build machine's path");
    expect(JSON.parse(read(path.join(pkg.dir, "package.json"))).version).toBe("0.0.0");
  });

  /**
   * CI по тегу: `elves pack` ставит версию и собирает модули для Node, `npm publish` публикует через trusted publishing
   * (docs.npmjs.com/trusted-publishers): npm доверяет workflow `npm.yml` этого репозитория по OIDC — `id-token: write`,
   * секрета и токена в workflow нет, provenance npm ставит сам. Нужен npm CLI ≥ 11.5.1: Node 22 несёт npm 10, поэтому
   * Node — линия 24 (npm 11), как в примере документации, без кэша менеджера пакетов в релизной сборке. `repository.url`
   * пакета должен совпадать с репозиторием. Публикация тега не отменяется: очередь `npm-publish` (стандарт ci-concurrency).
   */
  it("релиз публикует пакет в npm из CI по тегу без токена — через trusted publishing", () => {
    const text = read(path.join(REPO, ".github/workflows/npm.yml"));
    const wf = Bun.YAML.parse(text) as {
      on: Record<string, unknown>;
      jobs: Record<string, { permissions?: Record<string, string>; steps: { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }[] }>;
    };
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
    const [job, ...others] = Object.values(wf.jobs);
    expect(others).toEqual([]);
    expect(job!.permissions?.["id-token"]).toBe("write");
    expect(text).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/);
    expect(job!.steps.flatMap((s) => (s.env ? [s.env] : []))).toEqual([]);
    const node = job!.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(node?.with).toMatchObject({ "registry-url": "https://registry.npmjs.org", "package-manager-cache": false });
    expect(Number(String(node?.with?.["node-version"]).split(".")[0])).toBeGreaterThanOrEqual(24);
    expect(job!.steps.flatMap((s) => (s.run ? [s.run] : []))).toEqual(['bun --no-env-file bin/elves.ts pack "$GITHUB_REF_NAME"', "npm publish"]);
    const pkg = JSON.parse(read(path.join(REPO, "package.json")));
    expect(pkg).toMatchObject({ name: "@miroshnik/elves", publishConfig: { access: "public", provenance: true }, repository: { url: "git+https://github.com/miroshnik/elves.git" } });
    expect(pkg.private).toBeUndefined();
  });
});
