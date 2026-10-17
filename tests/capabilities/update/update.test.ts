import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import locale from "../../../skills/github/scripts/locale.ts";
import { copyInstall, elves, elvesPackage, bunxPackage, bunxServesPackages, copyPackage, FLOW_SKILLS, loadedAtStart, npmPackage, REPO, sandbox, snapshot, toFormer, type ElvesPackage, type Sandbox } from "../../lib/elves.ts";
import { npmRegistry, type Registry } from "../../lib/registry.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// версии пакета Elves в npm: V1 — стоит в проекте, V2 — вышла новее
const V1 = "2026.1015.1";
const V2 = "2026.1016.0";

// пакеты Elves собираются один раз на файл: base — как этот клон, newer — Elves ушёл вперёд; v1 и v2 — пакеты из npm
// версий V1 и V2 (сами релизы, #557), и реестр npm с обеими
let packages: { dir: string; cleanup: () => void };
let base: ElvesPackage;
let newer: ElvesPackage;
let v1: { bin: string };
let v2: { bin: string };
let registry: Registry;
beforeAll(async () => {
  packages = tmpDir();
  base = elvesPackage(path.join(packages.dir, "base"));
  // новое правило в AGENTS.md, новый скилл, скилл ci-wait убран
  newer = elvesPackage(path.join(packages.dir, "newer"), {
    "AGENTS.md": readFileSync(path.join(REPO, "AGENTS.md"), "utf8") + "\nНовое правило.\n",
    "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: новый скилл\n---\n",
    "skills/ci-wait": null,
  });
  v1 = { bin: npmPackage(path.join(packages.dir, "v1"), base.dir, V1, base.sha) };
  v2 = { bin: npmPackage(path.join(packages.dir, "v2"), base.dir, V2, base.sha) };
  registry = await npmRegistry([V1, V2]);
});
afterAll(() => {
  registry.stop();
  packages.cleanup();
});

const read = (p: string) => readFileSync(p, "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 7);
const manifest = (root: string) => path.join(root, ".agents/elves.json");

// правка .agents/elves.json руками: поля из fields заменяются, undefined — поле убирается
function editManifest(root: string, fields: Record<string, unknown>) {
  writeFileSync(manifest(root), JSON.stringify({ ...JSON.parse(read(manifest(root))), ...fields }, null, 2) + "\n");
}

// установка прошлой версией установщика: в .agents/elves.json нет SHA
const dropSha = (root: string) => editManifest(root, { sha: undefined });

// режим и язык проекта — последними строками check: язык новой установки без флага — en
const MODE_ASK = "  tasks: with permission\n  language: en\n";
const MODE_AUTO = "  tasks: entirely by itself\n  language: en\n";

// скрипт скилла github в копии флоу — проекта (от корня проекта) и машины (от домашнего каталога)
const GITHUB = ".agents/skills/github/scripts/github.ts";
// хвост хука: переезд копии — своя задача, отставший тонкий проект — задача сессии, машину — сама сессия
const PROJECT_COPY = "The project keeps a copy of the flow — moving it to a thin project is a task of its own, not in a task session";
const PROJECT_BEHIND = "The project's flow is behind — update in the session's task";
const MACHINE_BEHIND = "The machine is behind — update -g";
// строки check: тонкий проект отстал — обновление в задаче сессии; копия — переезд своей задачей
const UPDATE_HERE = "Update in this session's task — @miroshnik/elves in package.json and the lockfile, a few lines: bunx @miroshnik/elves update";
const MOVE_TASK = "Move in a task of its own, not in this session's task: bunx @miroshnik/elves update";

const writePkg = (fields: Record<string, unknown>) => writeFileSync(path.join(sb.proj, "package.json"), JSON.stringify({ name: "x", private: true, ...fields }, null, 2) + "\n");
// шим очереди убран — тонкий проект отстал без смены версии
const dropShim = () => rmSync(path.join(sb.proj, ".agents/slot.sh"));
// версия пакета Elves в package.json проекта
const pinned = () => JSON.parse(read(path.join(sb.proj, "package.json"))).devDependencies?.["@miroshnik/elves"];

/**
 * Проект на bun со своей зависимостью — пакетом workspace по `file:`: lockfile есть, как у живого проекта, а реестр для
 * него не нужен.
 */
function bunProject() {
  writeTree(sb.proj, {
    "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "@app/util": "file:./util" } }, null, 2) + "\n",
    "util/package.json": JSON.stringify({ name: "@app/util", version: "1.0.0" }) + "\n",
    ".gitignore": "node_modules/\n",
  });
  expect(spawnSync(process.execPath, ["install"], { cwd: sb.proj, env: sb.env, encoding: "utf8" }).status).toBe(0);
}

// машина с `install -g --link` из клона; origin клона — upstream, куда тест коммитит новое в main
function linkedClone() {
  mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  expect(elves(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/elves.ts") }).code).toBe(0);
  return { up, clone };
}

/**
 * Тонкий проект (#552) держит версию пакета `@miroshnik/elves`: отстал — значит, вышел релиз новее. Обновление — подъём
 * версии, несколько строк package.json и lockfile, — идёт в ветке текущей задачи, без отдельной задачи и копии.
 */
describe("Тонкий проект сверяется с версией пакета и обновляется в задаче сессии", () => {
  it("версия пакета проекта — как у релиза установщика: актуально, код 0", () => {
    writePkg({});
    expect(elves(sb, ["install"], { bin: v1.bin }).code).toBe(0);
    const r = elves(sb, ["check"], { bin: v1.bin });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: up to date (v2026.10.15.1)");
  });

  it("check тонкого проекта называет отставание версии пакета и строку для текущей задачи; check ничего не меняет", () => {
    writePkg({});
    elves(sb, ["install", "--lang", "ru"], { bin: v1.bin });
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"], { bin: v2.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: behind — installed v2026.10.15.1, latest v2026.10.16\n");
    expect(r.stdout).toContain(`  ~ package.json — @miroshnik/elves ${V1} → ${V2}\n`);
    expect(r.stdout).toContain(`\n${UPDATE_HERE}\n`);
    expect(r.stdout).not.toContain("task new");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  /** Строку агент запускает как есть, и в облаке тоже: npm там есть, `github:` — 403 (#555, #559). */
  it("check называет команду обновления из npm — bunx @miroshnik/elves update: в облачной сессии github: — 403", () => {
    writePkg({});
    elves(sb, ["install"], { bin: v1.bin });
    const r = elves(sb, ["check"], { bin: v2.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(": bunx @miroshnik/elves update\n");
    expect(r.stdout).not.toContain("github:");
  });

  /** Подъём версии — три строки: версия в package.json и две строки bun.lock — версия workspace и запись пакета. */
  it("update в тонком проекте поднимает версию пакета в package.json и bun.lock — три строки; коммит — в задаче сессии; после него check — актуально", () => {
    bunProject();
    expect(elves(sb, ["install", "--lang", "ru"], { bin: v1.bin, env: registry.env }).code).toBe(0);
    gitRepo(sb.proj, { init: false }).commit({}, "chore: флоу Elves");
    const u = elves(sb, ["update"], { bin: v2.bin, env: registry.env });
    expect(u.code).toBe(0);
    expect(JSON.parse(read(path.join(sb.proj, "package.json"))).devDependencies).toEqual({ "@miroshnik/elves": V2 });
    expect(read(path.join(sb.proj, "bun.lock"))).toContain(`"@miroshnik/elves@${V2}"`);
    expect(git(sb.proj, "diff", "--numstat").split("\n")).toEqual(["2\t2\tbun.lock", "1\t1\tpackage.json"]);
    expect(u.stdout).toContain(`Commit it with the session's task:\n  git add -A -- package.json bun.lock && git commit -m "chore(agents): флоу Elves v2026.10.16"\n`);
    expect(elves(sb, ["check"], { bin: v2.bin }).code).toBe(0);
  });

  it("флоу в проекте не стоит — «not installed», код 0, ничего не создаётся", () => {
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: not installed");
    expect(existsSync(path.join(sb.proj, ".agents"))).toBe(false);
  });

  /** Настройку задаёт только `install` (capability `install`): `update` идёт без терминала и флагов — из сессии агента. */
  it("update настройку сохраняет: auto true остаётся true, у установки прошлой версии без поля — false", () => {
    elves(sb, ["install", "--auto"]);
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: true, language: "en" });
    editManifest(sb.proj, { auto: undefined });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).auto).toBe(false);
  });

  /**
   * Язык задаёт только `install`. Установка прошлой версии без поля — проект, который флоу вёл по-русски: `update`
   * записывает ему `ru`, и язык проекта после обновления не меняется.
   */
  it("update язык сохраняет: language ru остаётся ru, у установки прошлой версии без поля — ru", () => {
    elves(sb, ["install", "--lang", "ru"]);
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "ru" });
    elves(sb, ["install", "--lang", "en"]);
    editManifest(sb.proj, { language: undefined });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).language).toBe("ru");
  });

  /** `env` — настройка стека задачи (скилл task-env: HTTP-сервисы и их порты): её пишет проект, установщик переносит. */
  it("`install` и `update` сохраняют `env` в `.agents/elves.json`", () => {
    const env = { http: { web: 3000, admin: 5173 } };
    elves(sb, ["install"]);
    editManifest(sb.proj, { env });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "en", env });
    expect(elves(sb, ["install", "--lang", "ru"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "ru", env });
  });

  /** Язык — последней строкой: в начале сессии агент видит, на каком языке работать, не читая манифест. */
  it("check называет язык проекта; установка прошлой версии без поля — ru, отставанием не считается", () => {
    elves(sb, ["install", "--lang", "ru"]);
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/\n {2}language: ru\n$/) });
    editManifest(sb.proj, { language: undefined });
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: with permission\n {2}language: ru\n$/) });
  });

  /** Режим — последней строкой: в начале сессии агент видит, вести ли задачу целиком самому. */
  it("check называет режим проекта: auto true — «tasks: entirely by itself», иначе — «tasks: with permission»; поле, правленное руками, и установка без поля отставанием не считаются", () => {
    elves(sb, ["install"]);
    const check = () => elves(sb, ["check"]);
    expect(check().stdout).toEndWith(MODE_ASK);
    editManifest(sb.proj, { auto: true });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n$/) });
    editManifest(sb.proj, { auto: undefined });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: with permission\n {2}language: en\n$/) });
    editManifest(sb.proj, { auto: true });
    dropShim();
    const behind = check();
    expect(behind.code).toBe(1);
    expect(behind.stdout).toEndWith(`${UPDATE_HERE}\n${MODE_AUTO}`);
    expect(elves(sb, ["install", "-g"]).code).toBe(0);
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("tasks:");
  });

  /** Клон Elves — сам канон: сверять и обновлять в нём нечего, а режим сессии в нём знать нужно. */
  it("в клоне Elves check и хук называют режим, клон остаётся «not installed»: релиз не ищут, поставить флоу не зовут, update флоу в клон не ставит", () => {
    const clone = copyPackage(base, path.join(sb.tmp, "clone")).dir;
    // установщик — пакет bunx из main, релизы недоступны: поиск релиза дал бы код 2
    const bin = bunxPackage(path.join(sb.tmp, "bunx/main"), base.dir, null);
    const run = (...args: string[]) => elves(sb, args, { cwd: clone, bin, env: { ELVES_REPO: path.join(sb.tmp, "nowhere") } });
    const ABSENT = "Elves in the project: not installed — an Elves clone, the canon is at its root\n";
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
    expect(elves(sb, ["install", "--auto"], { cwd: clone }).code).toBe(0);
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_AUTO });
    const hook = run("check", "--hook");
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain(ABSENT + MODE_AUTO);
    expect(hook.stdout).not.toContain("install it");
    expect(elves(sb, ["update"], { cwd: clone }).code).toBe(0);
    expect(snapshot(path.join(clone, ".agents"))).toEqual({ "elves.json": JSON.stringify({ auto: true, language: "en" }, null, 2) + "\n" });
  });

  /** Флоу до перехода на Bun ставился через npx: его команду носят блок AGENTS.md и блок исключений .gitignore. */
  it("блоки AGENTS.md и .gitignore со старой командой npx — отстаёт; update переписывает оба на bunx; после него check — актуально", () => {
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    elves(sb, ["install"]);
    const files = [path.join(sb.proj, "AGENTS.md"), path.join(sb.proj, ".gitignore")];
    for (const f of files) {
      const text = read(f);
      expect(text).toContain("`bunx @miroshnik/elves install`");
      writeFileSync(f, text.replace("`bunx @miroshnik/elves install`", "`npx -y github:miroshnik/ai-dev install`"));
    }
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("  ~ AGENTS.md\n");
    expect(elves(sb, ["update"]).code).toBe(0);
    for (const f of files) expect(read(f)).not.toContain("npx");
    expect(elves(sb, ["check"]).code).toBe(0);
  });
});

/**
 * Проект с копией флоу прошлого релиза (до #558) переезжает на тонкий: копия, её симлинки и исключения уходят, импорты
 * харнесса и пути CI ведут в пакет. Переезд — тысячи удалённых строк, правка тестов и CI: это своя задача, одна на
 * проект, а не ветка задачи сессии.
 */
describe("Проект с копией флоу переезжает на тонкий проект", () => {
  /** Название постоянное, на языке проекта: открытую задачу `task new` второй раз не заводит — отказывает с её номером. */
  it("check проекта с копией флоу печатает задачу переезда на тонкий проект — своей задачей, одной на проект; check ничего не меняет", () => {
    copyInstall(sb.proj, { language: "ru" });
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"], { bin: v2.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toStartWith("Elves in the project: a copy of the flow (installed v2026.10.05) — move it to a thin project: @miroshnik/elves 2026.1016.0 in devDependencies, the canon and the skills on the machine\n");
    const skills = FLOW_SKILLS.join(", ");
    for (const line of [
      "  - .claude/rules/elves.md\n",
      "  - .claude/rules/elves-claude.md\n",
      `  - .agents/skills/ — the flow's skills: ${skills}\n`,
      `  - .claude/skills/ — the symlinks to them: ${skills}\n`,
      "  - .agents/elves/\n",
      "  ~ .agents/elves.json\n",
      "  + .agents/slot.sh\n",
      "  ~ AGENTS.md\n",
    ]) {
      expect(r.stdout).toContain(line);
    }
    expect(r.stdout).toContain(`\n${MOVE_TASK}\n`);
    expect(r.stdout).toMatch(/\nThe task — one per project, an open one is named by the refusal: bun --no-env-file \S+\/skills\/github\/scripts\/github\.ts task new --title "Обновить флоу Elves" --branch-type chore\n/);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  /**
   * Строка выходит ровно тогда, когда в проекте копия, — её скрипт github может не знать печатаемых флагов
   * (`--branch-type` — с v2026.10.11). Команда — скриптом машины, иначе пакета, которым идёт check: тот же релиз. Без
   * GitHub задачу не завести — команда доходит до поиска репозитория, а не падает на флаге.
   */
  it("копия проекта до `--branch-type`: команда задачи переезда из `check` — скриптом github, который знает её флаги, а не копией", () => {
    copyInstall(sb.proj);
    writeTree(sb.proj, { [GITHUB]: "console.error(\"Unknown option '--branch-type'\");\nprocess.exit(2);\n" });
    const run = () => {
      const command = /bun --no-env-file (\S+) task new --title "Update the Elves flow" --branch-type chore\n/.exec(elves(sb, ["check"], { bin: newer.bin }).stdout);
      const r = spawnSync("sh", ["-c", command![0]], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
      return { script: realpathSync(path.resolve(sb.proj, command![1]!)), stderr: r.stderr };
    };
    const pkg = run();
    expect(pkg.script).toBe(realpathSync(path.join(newer.dir, "skills/github/scripts/github.ts")));
    expect(pkg.stderr).toContain("couldn't determine the repository");
    mkdirSync(path.join(sb.home, ".claude"));
    elves(sb, ["install", "-g"], { bin: newer.bin });
    const machine = run();
    expect(machine.script).toBe(realpathSync(path.join(sb.home, GITHUB)));
    expect(machine.stderr).toContain("couldn't determine the repository");
  });

  /**
   * Переезд целиком: копия, её симлинки и исключения .gitignore уходят, свой скилл проекта остаётся, манифест — только
   * режим, язык и env; импорты харнесса и github в тестах и конфигах — из пакета, скрипты копии в CI и package.json —
   * через пакет; версия пакета — в package.json и bun.lock; что ещё называет `.agents` (исключение линтера) — строкой.
   */
  it("update в проекте с копией переводит его на тонкий: копия, симлинки и исключения .gitignore удалены, импорты harness и пути CI переписаны", () => {
    bunProject();
    const env = { http: { web: 3000 } };
    copyInstall(sb.proj, { auto: true, language: "ru", env });
    writeTree(sb.proj, {
      ".gitignore": `node_modules/\nCLAUDE.md\n\n# elves:begin — flow files git would otherwise ignore; set by \`bunx github:miroshnik/elves install\`, don't edit by hand\n!/.agents/elves/claude/CLAUDE.md\n# elves:end\n`,
      ".agents/skills/mine/SKILL.md": "свой скилл проекта\n",
      "package.json": JSON.stringify(
        {
          ...JSON.parse(read(path.join(sb.proj, "package.json"))),
          scripts: {
            test: ". .agents/skills/slot/scripts/slot.sh && bun test",
            "spec:doc": "bun --no-env-file .agents/skills/spec/scripts/spec-doc.ts .spec-report.xml --strict",
          },
        },
        null,
        2,
      ) + "\n",
      "tests/capabilities/orders/orders.test.ts": 'import { describe, it } from "bun:test";\nimport { invariant } from "../../../.agents/skills/spec/scripts/harness.ts";\nimport { projectCommands } from "../../../.agents/skills/github/scripts/github.ts";\n',
      "eslint.config.js": 'import elves from "./.agents/skills/spec/scripts/eslint-config.ts";\n\nexport default [{ ignores: [".agents/**"] }, ...elves];\n',
      ".github/workflows/ci.yml": [
        "jobs:",
        "  tests:",
        "    steps:",
        "      - run: bun --no-env-file .agents/skills/spec/scripts/spec-diff.ts --base origin/main >> \"$GITHUB_STEP_SUMMARY\"",
        "      - run: npx knip --reporter json --reporter .agents/skills/spec/scripts/knip-hints.cjs > .knip.json",
        "",
      ].join("\n"),
    });
    mkdirSync(path.join(sb.proj, ".claude/skills/mine"), { recursive: true });
    const repo = gitRepo(sb.proj, { init: false });
    repo.commit({}, "chore: копия флоу");
    const u = elves(sb, ["update"], { bin: v2.bin, env: registry.env });
    expect(u.stderr).toBe("");
    expect(u.code).toBe(0);
    // копия ушла, своё — осталось
    for (const rel of [".agents/elves", ".claude/rules", ...FLOW_SKILLS.flatMap((s) => [`.agents/skills/${s}`, `.claude/skills/${s}`])]) expect(lstatSync(path.join(sb.proj, rel), { throwIfNoEntry: false })).toBeUndefined();
    expect(read(path.join(sb.proj, ".agents/skills/mine/SKILL.md"))).toBe("свой скилл проекта\n");
    expect(existsSync(path.join(sb.proj, ".claude/skills/mine"))).toBe(true);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: true, language: "ru", env });
    expect(read(path.join(sb.proj, ".gitignore"))).toBe("node_modules/\nCLAUDE.md\n");
    expect(read(path.join(sb.proj, "AGENTS.md"))).toContain("`~/.agents/elves/AGENTS.md`");
    expect(read(path.join(sb.proj, ".agents/slot.sh"))).toContain("elves slot --for $$");
    // тесты, конфиги, CI и скрипты — через пакет
    const pkg = JSON.parse(read(path.join(sb.proj, "package.json")));
    expect(pkg.scripts).toEqual({ test: ". .agents/slot.sh && bun test", "spec:doc": "bun --no-env-file node_modules/.bin/elves spec-doc .spec-report.xml --strict" });
    expect(pkg.devDependencies).toEqual({ "@miroshnik/elves": V2 });
    expect(read(path.join(sb.proj, "bun.lock"))).toContain(`"@miroshnik/elves@${V2}"`);
    expect(read(path.join(sb.proj, "tests/capabilities/orders/orders.test.ts"))).toBe('import { describe, it } from "bun:test";\nimport { invariant } from "@miroshnik/elves/spec/harness";\nimport { projectCommands } from "@miroshnik/elves/github";\n');
    expect(read(path.join(sb.proj, "eslint.config.js"))).toStartWith('import elves from "@miroshnik/elves/spec/eslint-config";\n');
    const ci = read(path.join(sb.proj, ".github/workflows/ci.yml"));
    expect(ci).toContain("      - run: bun --no-env-file node_modules/.bin/elves spec-diff --base origin/main >> \"$GITHUB_STEP_SUMMARY\"\n");
    expect(ci).toContain("--reporter node_modules/@miroshnik/elves/skills/spec/scripts/knip-hints.cjs > .knip.json\n");
    // исключение линтера для копии больше не нужно — строка с файлом и номером
    expect(u.stdout).toContain("Still naming .agents — the flow copy is gone");
    expect(u.stdout).toContain('  eslint.config.js:3: export default [{ ignores: [".agents/**"] }, ...elves];\n');
    // git add подсказки берёт и удаления копии: после коммита рабочее дерево чистое
    const add = /\n {2}(git add -A -- [^&\n]+)&& git commit -m "chore\(agents\): флоу Elves v2026\.10\.16"\n/.exec(u.stdout)?.[1] ?? "";
    expect(add).toContain(".agents/elves");
    expect(u.stdout).toContain("Commit the move into the update task's branch:");
    execFileSync("sh", ["-c", add], { cwd: sb.proj, env: sb.env });
    expect({ unstaged: git(sb.proj, "diff", "--name-only"), untracked: git(sb.proj, "ls-files", "--others", "--exclude-standard") }).toEqual({ unstaged: "", untracked: "" });
    const c = elves(sb, ["check"], { bin: v2.bin });
    expect(c).toMatchObject({ code: 0, stdout: expect.stringContaining("in the project: up to date (v2026.10.16)") });
  });

  /** Копия до списка скиллов в манифесте: свои скиллы флоу узнаёт по скиллам Elves. */
  it("копия без списка скиллов в манифесте — уходят скиллы, которые есть у Elves; свой скилл проекта остаётся", () => {
    copyInstall(sb.proj);
    editManifest(sb.proj, { skills: undefined });
    writeTree(sb.proj, { ".agents/skills/mine/SKILL.md": "свой\n" });
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(readdirSync(path.join(sb.proj, ".agents/skills"))).toEqual(["mine"]);
    expect(existsSync(path.join(sb.proj, ".claude"))).toBe(false);
  });
});

/**
 * Файл тонкого проекта, который игнорирует git, в коммит не попадёт — CI и чужой чекаут без шима падают на `. .agents/slot.sh`.
 * Это несоответствие флоу, как отставание: чинит тот же `update` — в задаче сессии (capability `install` — как).
 */
describe("Файл флоу, который игнорирует git проекта, — несоответствие: check его называет, update снимает исключением", () => {
  it("check: код 1, ❌ с путём и правилом, команда update — в задаче сессии; check ничего не меняет", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain("git ignores flow files");
    expect(r.stdout).toContain("  ❌ .agents/ — .gitignore:1 «.agents/»\n");
    expect(r.stdout).toContain("Fix in this session's task: bunx @miroshnik/elves update — adds exceptions to .gitignore\n");
    expect(r.stdout).not.toContain("task new");
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update дописывает исключения, подсказка коммита включает .gitignore и файлы флоу; после него check — актуально", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    const add = /git add -A -- [^&\n]+/.exec(u.stdout)?.[0] ?? "";
    expect(add).toContain(".gitignore");
    execFileSync("sh", ["-c", add], { cwd: sb.proj, env: sb.env });
    const staged = git(sb.proj, "diff", "--cached", "--name-only").split("\n");
    expect(staged).toEqual(expect.arrayContaining([".gitignore", ".agents/elves.json", ".agents/slot.sh"]));
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringContaining("in the project: up to date") });
  });

  /** Сторож от перекоррекции: свои правки .gitignore проекта в коммит флоу не уходят. */
  it("ничего не игнорируется — подсказка коммита update без .gitignore", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "dist/\n");
    dropShim();
    const add = /git add -A -- [^&\n]+/.exec(elves(sb, ["update"]).stdout)?.[0] ?? "";
    expect(add).toContain(".agents/slot.sh");
    expect(add).not.toContain(".gitignore");
  });

  it("каталог флоу исключён правилом вне проекта — check: ❌ с правилом и «fix the rule», без команды update: её исключение не поможет", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.home, ".gitconfig"), `[core]\n\texcludesFile = ${path.join(sb.home, "personal-ignore")}\n`);
    writeFileSync(path.join(sb.home, "personal-ignore"), ".agents/\n");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ❌ .agents/ — ~/personal-ignore:1 «.agents/»: the directory is excluded outside the project");
    expect(r.stdout).toContain("fix the rule");
    expect(r.stdout).not.toContain("elves update");
    expect(r.stdout).not.toContain("task new");
  });
});

/**
 * check проекта с compose-файлом зовёт скрипт task-env под тем же bun, тот — `docker compose config`: в PATH песочницы
 * — docker прогона. Плагин compose docker ищет в каталоге своей конфигурации, а HOME у песочницы свой — DOCKER_CONFIG
 * ведёт в настоящий.
 */
function withDocker() {
  symlinkSync(execFileSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim(), path.join(sb.bin, "docker"));
  sb.env.DOCKER_CONFIG = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
}

const composeFile = (yaml: string) => writeFileSync(path.join(sb.proj, "compose.yaml"), yaml);
const CONTAINER_NAME = "services:\n  db:\n    image: postgres\n    container_name: pg\n";
const COMPOSE_VIOLATION = "  ❌ compose.yaml: service db — container_name pg: a second task stack can't start; remove it, Compose names containers by the project\n";

describe("check проекта держит compose-файл правил изоляции стеков задач: нарушение — строка ❌ с правилом и сервисом", () => {
  it("нарушения — строки ❌ скрипта task-env, код 1 и при актуальном флоу; check ничего не меняет", () => {
    withDocker();
    elves(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("флоу отстал — строки ❌ compose-файла идут вместе со списком изменений, код 1", () => {
    withDocker();
    elves(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    dropShim();
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: behind");
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toEndWith(MODE_ASK);
  });

  /** Без docker в PATH: начни check скрипт в проекте без compose-файла — была бы строка ○ «docker not found». */
  it("проект без compose-файла — ни строки сверх обычных, скрипт не запускается; чистый compose-файл — тоже ни строки; код 0", () => {
    elves(sb, ["install"]);
    const upToDate = /^Elves in the project: up to date \([^)\n]+\)\n {2}tasks: with permission\n {2}language: en\n$/;
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(upToDate) });
    withDocker();
    composeFile("services:\n  db:\n    image: postgres\n    ports: ['127.0.0.1::5432']\n");
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(upToDate) });
  });

  it("без Docker — строка ○ «not checked» с причиной, код по-прежнему 0", () => {
    elves(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const noDocker = elves(sb, ["check"]);
    expect(noDocker.code).toBe(0);
    expect(noDocker.stdout).toContain("  ○ compose.yaml: not checked — docker not found\n");
    expect(noDocker.stdout).toEndWith(MODE_ASK);
  });
});

// решение в корне спеки — каталог с тестом, как у проекта
function decision(rel: string) {
  mkdirSync(path.join(sb.proj, rel), { recursive: true });
  writeFileSync(path.join(sb.proj, rel, `${path.basename(rel)}.test.ts`), "");
}
// обёртка slot, которую ставит install: скрипт подключает шим и берёт слот своим shell, команда — как есть
const inSlot = (cmd: string) => `. .agents/slot.sh && ${cmd}`;
const NO_TEST_SPEC = (roots: string) => `  ❌ package.json: no test:spec script — pr premerge doesn't run ${roots} on the merge with a moved main; `;
// готовые строки скриптов: test:spec, а если test гоняет те же корни — и test без них
const ADD_SPEC = (spec: string) => `add to "scripts": "test:spec": ${JSON.stringify(spec)}\n`;
const PUT_PAIR = (spec: string, test: string) => `put in "scripts" — test without them, they don't run twice: "test:spec": ${JSON.stringify(spec)}, "test": ${JSON.stringify(test)}\n`;

/**
 * Без скрипта `test:spec` `pr premerge` проверяет слияние с ушедшим main одним typecheck или ничем, а стандарты и
 * архитектура — там, где ломают два зелёных PR, — не идут: в одном проекте 89 запусков premerge ничего не проверили,
 * в другом стандарт покраснел на main сразу после мержа (#442).
 */
describe("check проекта со стандартами или архитектурой требует скрипт test:spec — быструю проверку pr premerge", () => {
  it("проект со стандартами без скрипта test:spec — check называет нарушение и строку для package.json", () => {
    writePkg({ devDependencies: { vitest: "^4.0.0" }, scripts: { test: "vitest run" } });
    elves(sb, ["install"]);
    decision("tests/standards/naming");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    const spec = inSlot("vitest run tests/standards");
    const test = inSlot("vitest run --exclude 'tests/standards/**'");
    expect(r.stdout).toContain(NO_TEST_SPEC("tests/standards") + PUT_PAIR(spec, test));
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
    // готовые строки как есть в package.json — актуально: они уже в очереди slot, update их не переписывает
    const pkg = JSON.parse(read(path.join(sb.proj, "package.json")));
    writePkg({ ...pkg, scripts: { ...pkg.scripts, "test:spec": spec, test } });
    const fixed = elves(sb, ["check"]);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).not.toContain("test:spec");
  });

  it("test:spec — раннер команды test, без неё — по зависимостям: vitest, jest, bun test в проекте на Bun, без раннера — vitest; по корням спеки, что есть", () => {
    elves(sb, ["install"]);
    const cases: [fields: Record<string, unknown>, roots: string[], files: string[], cmd: string][] = [
      [{ devDependencies: { jest: "^30.0.0" } }, ["tests/architecture/layers"], [], "jest tests/architecture"],
      [{ packageManager: "bun@1.4.3" }, ["tests/standards/naming", "tests/architecture/layers"], [], "bun test tests/standards tests/architecture"],
      [{}, ["tests/standards/naming"], ["bun.lock"], "bun test tests/standards"],
      [{ devDependencies: { vitest: "^4.0.0" } }, ["tests/standards/naming"], ["bun.lock"], "vitest run tests/standards"],
      [{}, ["tests/standards/naming"], [], "vitest run tests/standards"],
      // раннер команды test — сильнее зависимостей
      [{ devDependencies: { vitest: "^4.0.0" }, scripts: { test: inSlot("jest --ci") } }, ["tests/standards/naming"], [], "jest tests/standards"],
      [{ devDependencies: { jest: "^30.0.0" }, scripts: { test: inSlot("bun test") } }, ["tests/standards/naming"], [], "bun test tests/standards"],
    ];
    for (const [fields, roots, files, cmd] of cases) {
      rmSync(path.join(sb.proj, "tests"), { recursive: true, force: true });
      rmSync(path.join(sb.proj, "bun.lock"), { force: true });
      writePkg(fields);
      for (const rel of roots) decision(rel);
      for (const f of files) writeFileSync(path.join(sb.proj, f), "{}\n");
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(NO_TEST_SPEC(roots.map((d) => d.split("/").slice(0, 2).join("/")).join(", ")));
      expect(r.stdout).toContain(`"test:spec": ${JSON.stringify(inSlot(cmd))}`);
    }
  });

  /**
   * Стандарты и архитектура идут один раз — в `test:spec`, своём джобе CI; `test` их не повторяет (скилл `spec`,
   * `checks.md`): один `test:spec` без исключения — те же тесты дважды. Исключение дописывается к фильтру, который у
   * `test` уже есть, — уровень `test:slow` держит там свои файлы.
   */
  it("рядом со строкой test:spec — исключение тех же корней из test фильтром раннера: стандарты не идут дважды", () => {
    elves(sb, ["install"]);
    decision("tests/standards/naming");
    const cases: [deps: Record<string, string>, test: string | undefined, line: string][] = [
      [{ vitest: "^4.0.0" }, "vitest run", PUT_PAIR(inSlot("vitest run tests/standards"), inSlot("vitest run --exclude 'tests/standards/**'"))],
      [{ jest: "^30.0.0" }, "jest --ci", PUT_PAIR(inSlot("jest tests/standards"), inSlot("jest --ci --testPathIgnorePatterns=tests/standards/"))],
      // фильтр медленного уровня остаётся, исключение корней — следом
      [{}, "bun test --path-ignore-patterns='**/*.slow.test.ts'", PUT_PAIR(inSlot("bun test tests/standards"), inSlot("bun test --path-ignore-patterns='**/*.slow.test.ts' --path-ignore-patterns='tests/standards/**'"))],
      // test корни уже не гоняет или его нет — одна строка test:spec
      [{ vitest: "^4.0.0" }, "vitest run --exclude 'tests/standards/**'", ADD_SPEC(inSlot("vitest run tests/standards"))],
      [{ vitest: "^4.0.0" }, undefined, ADD_SPEC(inSlot("vitest run tests/standards"))],
      // test — не вызов раннера: фильтр не к чему дописать — словами
      [{ vitest: "^4.0.0" }, "turbo run test", `${ADD_SPEC(inSlot("vitest run tests/standards")).trimEnd()}; exclude tests/standards from test with the runner's filter — they don't run twice\n`],
    ];
    for (const [deps, test, line] of cases) {
      writePkg({ devDependencies: deps, ...(test === undefined ? {} : { scripts: { test: inSlot(test) } }) });
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(NO_TEST_SPEC("tests/standards") + line);
    }
  });

  it("проект без стандартов и архитектуры — check не требует test:spec", () => {
    writePkg({ scripts: { test: "vitest run" } });
    elves(sb, ["install"]);
    decision("tests/capabilities/export");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("test:spec");
  });
});

// строка ○: test гоняет корни спеки, которые уже гоняет test:spec, — готовая строка test без них
const REPEATS = (roots: string, test: string) => `  ○ package.json: test repeats test:spec — runs ${roots} a second time; put in "scripts": "test": ${JSON.stringify(test)}\n`;

/**
 * С `test:spec` стандарты и архитектура идут и в `test`, если он их не исключает: замер #470 — во всех трёх проектах с
 * `test:spec` локальный прогон перед коммитом гонял стандарты дважды, в одном это 76 с из 142 с `test`. Это лишнее
 * время, а не дыра в проверке: строка `○`, код выхода и признак нехватки `test:spec` прежние (#487).
 */
describe("check проекта с test:spec называет test, который повторяет стандарты и архитектуру", () => {
  beforeEach(() => {
    elves(sb, ["install"]);
    decision("tests/standards/naming");
  });
  const withSpec = (test: string, deps: Record<string, string> = { vitest: "^4.0.0" }) =>
    writePkg({ devDependencies: deps, scripts: { "test:spec": inSlot("vitest run tests/standards tests/architecture"), test: inSlot(test) } });

  it("проект с test:spec, test — одиночный вызов раннера без корней спеки — check выводит строку ○ с готовой строкой test без них", () => {
    decision("tests/architecture/layers");
    withSpec("vitest run");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.stdout).toContain(REPEATS("tests/standards, tests/architecture", inSlot("vitest run --exclude 'tests/standards/**' --exclude 'tests/architecture/**'")));
    expect(snapshot(sb.proj)).toEqual(before);
    // раннер под менеджером пакетов — тот же одиночный вызов
    withSpec("pnpm exec vitest run");
    expect(elves(sb, ["check"]).stdout).toContain(REPEATS("tests/standards, tests/architecture", inSlot("pnpm exec vitest run --exclude 'tests/standards/**' --exclude 'tests/architecture/**'")));
  });

  it("готовая строка test дописывает исключение к фильтру, который в test уже есть, и остаётся под обёрткой slot", () => {
    const cases: [deps: Record<string, string>, test: string, line: string][] = [
      [{ vitest: "^4.0.0" }, "vitest run --exclude '**/*.slow.test.ts'", inSlot("vitest run --exclude '**/*.slow.test.ts' --exclude 'tests/standards/**'")],
      [{ jest: "^30.0.0" }, "jest --ci", inSlot("jest --ci --testPathIgnorePatterns=tests/standards/")],
      [{}, "bun test --path-ignore-patterns='**/*.slow.test.ts'", inSlot("bun test --path-ignore-patterns='**/*.slow.test.ts' --path-ignore-patterns='tests/standards/**'")],
    ];
    for (const [deps, test, line] of cases) {
      withSpec(test, deps);
      expect(elves(sb, ["check"]).stdout).toContain(REPEATS("tests/standards", line));
    }
  });

  it("test называет все корни спеки — строки нет", () => {
    decision("tests/architecture/layers");
    // называет один корень из двух — строка о другом
    withSpec("vitest run --exclude 'tests/standards/**'");
    expect(elves(sb, ["check"]).stdout).toContain(REPEATS("tests/architecture", inSlot("vitest run --exclude 'tests/standards/**' --exclude 'tests/architecture/**'")));
    withSpec("vitest run --exclude 'tests/standards/**' --exclude 'tests/architecture/**'");
    expect(elves(sb, ["check"]).stdout).not.toContain("○");
  });

  it("test не одиночный вызов раннера — turbo или цепочка команд — check молчит", () => {
    for (const test of ["turbo run test", "vitest run && tsc --noEmit", "vitest run | tee vitest.log"]) {
      withSpec(test);
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("○");
    }
  });

  it("строка ○ о повторе стандартов не меняет код выхода check", () => {
    withSpec("vitest run");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("Elves in the project: up to date");
    expect(r.stdout).toEndWith(REPEATS("tests/standards", inSlot("vitest run --exclude 'tests/standards/**'")) + MODE_ASK);
  });
});

describe("Копия на машине (-g) сверяется и обновляется так же — вместе с хуком SessionStart", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  it("поставлено из того же Elves — актуально, код 0", () => {
    elves(sb, ["install", "-g"]);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("on the machine: up to date");
  });

  it("Elves ушёл вперёд (новое правило, новый скилл) — check -g называет отставание канона и скиллов, код 1, ничего не меняет; update -g доводит канон, скиллы и хук машины до актуального", () => {
    elves(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`on the machine: behind — installed ${short(git(REPO, "rev-parse", "HEAD"))}, latest ${short(newer.sha)}`);
    expect(r.stdout).toContain("~ ~/.agents/elves/AGENTS.md");
    expect(r.stdout).toContain("+ ~/.agents/skills/fresh/");
    expect(r.stdout).toContain("bunx @miroshnik/elves update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(elves(sb, ["update", "-g"], { bin: newer.bin }).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toContain("Новое правило.");
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(true);
    expect(existsSync(path.join(sb.home, ".agents/skills/ci-wait"))).toBe(false);
    expect(read(path.join(sb.home, ".claude/settings.json"))).toContain("check --hook");
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(newer.sha);
    expect(elves(sb, ["check", "-g"], { bin: newer.bin }).code).toBe(0);
  });

  /** Машина прошлого релиза: скиллы и хук, канона нет (#180) — канон на машине теперь часть установки (#557). */
  it("поставлено релизом без канона на машине — отстаёт: в списке канон и правила Claude Code; update -g их ставит", () => {
    elves(sb, ["install", "-g"]);
    for (const rel of [".agents/elves", ".claude/rules"]) rmSync(path.join(sb.home, rel), { recursive: true });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ ~/.agents/elves/\n");
    expect(r.stdout).toContain("+ ~/.claude/rules/elves.md\n");
    expect(r.stdout).toContain("+ ~/.claude/rules/elves-claude.md\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  it("поставлено прошлой версией с правилами на машине под прежним именем — отстаёт: в списке «- ~/.agents/ai-dev/» и «- ~/.claude/rules/ai-dev.md»; update -g переносит их на новые имена, после него check — актуально", () => {
    elves(sb, ["install", "-g"]);
    mkdirSync(path.join(sb.home, ".agents/ai-dev"), { recursive: true });
    writeFileSync(path.join(sb.home, ".agents/ai-dev/AGENTS.md"), "старый канон\n");
    mkdirSync(path.join(sb.home, ".claude/rules"), { recursive: true });
    symlinkSync("../../.agents/ai-dev/AGENTS.md", path.join(sb.home, ".claude/rules/ai-dev.md"));
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("- ~/.agents/ai-dev/");
    expect(r.stdout).toContain("- ~/.claude/rules/ai-dev.md");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(lstatSync(path.join(sb.home, ".claude/rules/ai-dev.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  /** Хук прошлой версии — с запасным текстом по-русски: check -g сверяет хук целиком, update -g узнаёт свой по команде. */
  it("хук прошлой версии с запасным текстом по-русски — отстаёт; update -g заменяет его, а не ставит второй; после него check — актуально", () => {
    elves(sb, ["install", "-g"]);
    const file = path.join(sb.home, ".claude/settings.json");
    const hooks = () => JSON.parse(read(file)).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const settings = JSON.parse(read(file));
    settings.hooks.SessionStart[0].hooks[0].command = 'npx -y --loglevel=error github:miroshnik/ai-dev check --hook 2>&1 || echo "ai-dev check недоступен (код $?): работай по текущему флоу и скажи об этом"';
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ~ ~/.claude/settings.json — the SessionStart hook: the flow check and the agent's Bash environment\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(hooks()).toHaveLength(1);
    expect(hooks()[0].command).toContain("github:miroshnik/elves check --hook");
    expect(hooks()[0].command).not.toMatch(/\p{Script=Cyrillic}/u);
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  /**
   * Хук до переименования в Elves (#544) — с адресом miroshnik/ai-dev: GitHub его перенаправляет, хук работает и до
   * update; update -g узнаёт его своим и меняет на новый, а не ставит второй — иначе каждая сессия проверяла бы флоу дважды.
   */
  it("update -g на машине со старым хуком оставляет один хук — с командой miroshnik/elves", () => {
    elves(sb, ["install", "-g"]);
    const file = path.join(sb.home, ".claude/settings.json");
    const hooks = () => JSON.parse(read(file)).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const settings = JSON.parse(read(file));
    settings.hooks.SessionStart[0].hooks[0].command = 'bunx --silent github:miroshnik/ai-dev check --hook 2>&1 || echo "ai-dev check unavailable (exit $?): work by the current flow and say so"';
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    expect(elves(sb, ["check", "-g"]).code).toBe(1);
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(hooks()).toHaveLength(1);
    expect(hooks()[0].command).toStartWith("bunx --silent github:miroshnik/elves check --hook 2>&1 || ");
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  it("старая установка без SHA и без хука SessionStart — отстаёт; update -g ставит хук и пишет SHA", () => {
    elves(sb, ["install", "-g"]);
    dropSha(sb.home);
    rmSync(path.join(sb.home, ".claude/settings.json"));
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("installed without SHA");
    expect(r.stdout).toContain("+ ~/.claude/settings.json");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/settings.json"))).toContain("check --hook");
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(git(REPO, "rev-parse", "HEAD"));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });
});

// Elves с релизами: upstream — git-репозиторий, откуда установщик берёт теги (ELVES_REPO); bunx песочницы отдаёт
// пакеты его коммитов — пускатель из main по `github:miroshnik/elves` и пакет каждого коммита по его SHA
function withReleases() {
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const pkgs = path.join(sb.tmp, "bunx");
  bunxServesPackages(sb, pkgs);
  const head = () => up.repo.git("rev-parse", "HEAD");
  const serveMain = () => {
    rmSync(path.join(pkgs, "main"), { recursive: true, force: true });
    bunxPackage(path.join(pkgs, head()), up.dir, head());
    return bunxPackage(path.join(pkgs, "main"), up.dir, null);
  };
  const bin = serveMain();
  return {
    up,
    /** пускатель bunx — пакет из main, каким его запускает `bunx github:miroshnik/elves` */
    bin,
    /** коммит в main upstream: bunx теперь отдаёт его */
    commit(files: Record<string, string | null>, message?: string) {
      const sha = up.repo.commit(files, message);
      serveMain();
      return sha;
    },
    /** пункты списка изменений, который `release --dry-run` владельца выпустил бы сейчас в GitHub Release */
    notes() {
      const clone = path.join(sb.tmp, "owner");
      if (!existsSync(clone)) git(sb.tmp, "clone", "-q", up.dir, clone);
      const r = elves(sb, ["release", "--dry-run"], { bin: path.join(clone, "bin/elves.ts") });
      expect(r.code).toBe(0);
      return r.stdout.split("\n").filter((l) => l.startsWith("- "));
    },
    /** релиз — тег на голову main (annotated — аннотированный); пакет его коммита bunx уже отдаёт по SHA */
    release(tag: string, { annotated = false } = {}) {
      const sha = head();
      if (annotated) up.repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "tag", "-a", "-m", tag, tag);
      else up.repo.git("tag", tag);
      return sha;
    },
    /** установщик — пускатель из main */
    run: (args: string[], env: Record<string, string> = {}) => elves(sb, args, { bin, env: { ELVES_REPO: up.dir, ...env } }),
  };
}

/**
 * Проект версией пакета и машина копией следуют за релизами Elves (теги vГГГГ.ММ.ДД), а не за main: коммит в main без
 * релиза их «отставшими» не делает. bunx ставит пакет из main один раз и дальше берёт его из кеша — он только пускатель:
 * находит последний релиз и перезапускается по его SHA, дальше и код, и файлы релиза, а проект получает его версию в npm.
 */
describe("Версия пакета проекта и копия на машине следуют за релизами Elves, а не за main", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });

  it("install ставит проекту версию пакета последнего релиза, а не головы main", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Правило из main."));
    writePkg({});
    expect(r.run(["install"]).code).toBe(0);
    expect(pinned()).toBe("2026.1005.0");
  });

  it("main ушёл вперёд, нового релиза нет — актуально, код 0", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("in the project: up to date (v2026.10.05)");
  });

  it("вышел релиз новее установленного — отстаёт, код 1: стоящий и свежий тег, версия пакета; check ничего не меняет", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    const before = snapshot(sb.proj);
    const c = r.run(["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("in the project: behind — installed v2026.10.05, latest v2026.10.12");
    expect(c.stdout).toContain("  ~ package.json — @miroshnik/elves 2026.1005.0 → 2026.1012.0\n");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update ставит версию последнего релиза, а не головы main; подсказка коммита — с тегом; после него check — актуально", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    r.commit(rule(r.up, "Правило из main."));
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    // проект на en (install без флага и терминала): описание коммита — по-английски
    expect(u.stdout).toContain("chore(agents): Elves flow v2026.10.12");
    expect(pinned()).toBe("2026.1012.0");
    expect(r.run(["check"]).code).toBe(0);
  });

  /** Аннотированный тег ls-remote отдаёт объектом тега — ставится коммит, на который он указывает. */
  it("последний релиз — по дате, затем по номеру патча; аннотированный тег — его коммит; чужие теги не в счёт", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Патч."));
    const sha = r.release("v2026.10.05.1", { annotated: true });
    r.commit({ "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: из main\n---\n" });
    r.release("v2026.09.30");
    r.up.repo.git("tag", "v9.0.0");
    writePkg({});
    r.run(["install"]);
    expect(pinned()).toBe("2026.1005.1");
    r.run(["install", "-g"]);
    expect(JSON.parse(read(manifest(sb.home)))).toMatchObject({ tag: "v2026.10.05.1", sha });
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(false);
  });

  it("машина копией (-g) — тоже по релизам: main ушёл вперёд — актуально", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const r = withReleases();
    r.release("v2026.10.05");
    expect(r.run(["install", "-g"]).code).toBe(0);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check", "-g"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("on the machine: up to date (v2026.10.05)");
    expect(JSON.parse(read(manifest(sb.home))).tag).toBe("v2026.10.05");
  });

  /** Пускатель из кеша bunx старше main: по SHA головы ставится свежий main, а не он сам; версии в npm у main нет. */
  it("релизов ещё нет — пускатель перезапускается по SHA головы main: её файлы и SHA, без тега; версию пакета проекту не ставит", () => {
    const r = withReleases();
    const sha = r.commit({ "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: из main\n---\n" });
    expect(r.run(["install", "-g"]).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh/SKILL.md"))).toBe(true);
    const m = JSON.parse(read(manifest(sb.home)));
    expect(m.sha).toBe(sha);
    expect(m.tag).toBeUndefined();
    writePkg({});
    const p = r.run(["install"]);
    expect(p.code).toBe(0);
    expect(p.stderr).toContain("@miroshnik/elves isn't added: this installer isn't a release");
    expect(pinned()).toBeUndefined();
  });

  /**
   * Пускатель в кеше bunx старше релиза: флаг или команду, которые появились позже, он сам бы отверг. Поэтому он
   * перезапускается до проверки команды и флагов.
   */
  it("устаревший пускатель не отвергает флаг, который знает релиз: перезапуск — до проверки флагов", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    const text = read(r.bin);
    const stale = text.replace('"--auto", "--no-auto"]', '"--auto"]');
    expect(stale).not.toBe(text);
    writeFileSync(r.bin, stale);
    writePkg({});
    expect(r.run(["install", "--no-auto"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).auto).toBe(false);
    expect(pinned()).toBe("2026.1005.0");
  });

  /**
   * Флоу переименован (#545), а пускатель в кеше bunx — как его первый запуск: пускатель до переименования передаёт тег
   * релиза в AI_DEV_RELEASE, а релиз до переименования, который запустил новый пускатель, читает только её.
   */
  it("пускатель и релиз по разные стороны переименования флоу: тег релиза доходит и под прежним именем AI_DEV_RELEASE", () => {
    const r = withReleases();
    const sha = r.release("v2026.10.05");
    const release = path.join(sb.tmp, "bunx", sha, "node_modules/elves/bin/elves.ts");
    const edit = (file: string, from: string, to: string) => {
      const text = read(file);
      expect(text).toContain(from);
      writeFileSync(file, text.replace(from, to));
    };
    // пускатель прошлого релиза — только прежнее имя
    const launcher = read(r.bin);
    edit(r.bin, 'for (const name of ["ELVES_RELEASE", FORMER.release])', "for (const name of [FORMER.release])");
    writePkg({});
    expect(r.run(["install"]).code).toBe(0);
    expect(pinned()).toBe("2026.1005.0");
    // релиз прошлого релиза — читает только прежнее имя
    writeFileSync(r.bin, launcher);
    edit(release, "process.env.ELVES_RELEASE || process.env[FORMER.release]", "process.env[FORMER.release]");
    writePkg({});
    expect(r.run(["install"]).code).toBe(0);
    expect(pinned()).toBe("2026.1005.0");
  });

  it("последний релиз не узнать (нет сети) — check: проверка недоступна, код 2; install и update — отказ, код 2; флоу не стоит — релиз не ищет", () => {
    const r = withReleases();
    const offline = { ELVES_REPO: path.join(sb.tmp, "nowhere") };
    const absent = r.run(["check"], offline);
    expect(absent.code).toBe(0);
    expect(absent.stdout).toContain("in the project: not installed");
    r.release("v2026.10.05");
    r.run(["install"]);
    const before = snapshot(sb.proj);
    const c = r.run(["check"], offline);
    expect(c.code).toBe(2);
    expect(c.stderr).toContain("in the project: check unavailable — can't find out the latest Elves release");
    for (const cmd of ["install", "update"]) {
      const u = r.run([cmd], offline);
      expect(u.code).toBe(2);
      expect(u.stderr).toContain("can't find out the latest Elves release");
    }
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("хук: последний релиз не узнать — код 0, в выводе — проверка недоступна", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    const h = r.run(["check", "--hook"], { ELVES_REPO: path.join(sb.tmp, "nowhere") });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("in the project: check unavailable — can't find out the latest Elves release");
  });
});

/**
 * Пакет из npm — `npm i -g`, `bun add -g` — сам релиз (#557): его версия — тег релиза (`ГГГГ.ММДД.N` ↔
 * `vГГГГ.ММ.ДД.N`), коммит — `gitHead`, который пишет `elves pack`. SHA в спецификаторе у него нет, и без этого
 * установщик счёл бы себя пускателем из main и перезапустился бы через `bunx github:` — в облачной сессии это 403, а в
 * setup script установка шла бы из архива GitHub, а не из npm. `check` и `update` сверяют с последним релизом и
 * перезапускаются пакетом его версии из npm.
 */
describe("Пакет из npm — сам релиз: install -g ставит его версию, check -g и update -g — по последнему релизу пакета", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  // ни GitHub, ни bunx: релиз установщик узнаёт только по самому пакету
  it("install -g из пакета npm ставит релиз своей версии, без перезапуска через bunx github:", () => {
    const r = withReleases();
    const sha = r.release("v2026.10.05");
    const bin = npmPackage(path.join(sb.tmp, "global"), r.up.dir, "2026.1005.0", sha);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    rmSync(path.join(sb.bin, "bunx"));
    const u = elves(sb, ["install", "-g"], { bin, env: { ELVES_REPO: path.join(sb.tmp, "nowhere") } });
    expect(u).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(read(manifest(sb.home)))).toMatchObject({ tag: "v2026.10.05", sha });
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).not.toContain("Правило релиза.");
  });

  // машина поставлена глобальным пакетом v2026.10.05, вышел v2026.10.12 с новым правилом и скиллом — его пакет есть в npm
  function behindLatest() {
    const r = withReleases();
    const from = r.release("v2026.10.05");
    const bin = npmPackage(path.join(sb.tmp, "global"), r.up.dir, "2026.1005.0", from);
    const run = (args: string[]) => elves(sb, args, { bin, env: { ELVES_REPO: r.up.dir } });
    expect(run(["install", "-g"]).code).toBe(0);
    r.commit({ ...rule(r.up, "Правило релиза."), "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: новый скилл\n---\n" }, "feat(agents): правило релиза\n\nRefs #7");
    const to = r.release("v2026.10.12");
    npmPackage(path.join(sb.tmp, "bunx", "npm@2026.1012.0"), r.up.dir, "2026.1012.0", to);
    return { run, to };
  }

  it("check -g называет отставание машины от последнего релиза пакета", () => {
    const { run } = behindLatest();
    const before = snapshot(sb.home);
    const c = run(["check", "-g"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("Elves on the machine: behind — installed v2026.10.05, latest v2026.10.12\n");
    expect(c.stdout).toContain("  ~ ~/.agents/elves/AGENTS.md\n");
    expect(c.stdout).toContain("  + ~/.agents/skills/fresh/\n");
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("update -g доводит канон, скиллы и хук машины до последнего релиза пакета", () => {
    const { run, to } = behindLatest();
    rmSync(path.join(sb.home, ".claude/settings.json"));
    const u = run(["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n");
    expect(u.stdout).toContain("  - feat(agents): правило релиза (#7)\n");
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toContain("Правило релиза.");
    expect(existsSync(path.join(sb.home, ".claude/skills/fresh/SKILL.md"))).toBe(true);
    expect(read(path.join(sb.home, ".claude/settings.json"))).toContain("check --hook");
    expect(JSON.parse(read(manifest(sb.home)))).toMatchObject({ tag: "v2026.10.12", sha: to });
    const again = run(["check", "-g"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Elves on the machine: up to date (v2026.10.12)");
  });
});

/**
 * update говорит, что поменялось: агент передаёт это пользователю. Список релиза собирает та же функция, что заметки
 * GitHub Release, — из истории git того же репозитория, где теги. Тонкий проект — от релиза своей версии пакета.
 */
describe("update называет изменения каждого пропущенного релиза", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  const block = (tag: string, items: string[]) => [`${tag} — https://github.com/miroshnik/elves/releases/tag/${tag}`, ...items.map((i) => `  ${i}`)].join("\n");

  it("update проекта перечисляет каждый релиз после его версии пакета от нового к старому: тег, ссылка и пункты — те же, что в заметках релиза", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    const a = r.notes();
    r.release("v2026.10.08");
    r.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    r.commit(rule(r.up, "Правило B."), "fix(est): правка B\n\nRefs #8");
    const b = r.notes();
    r.release("v2026.10.12");
    r.commit(rule(r.up, "Правило из main."), "feat(agents): правило из main");
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(a).toEqual(["- feat(agents): правило A (#7)"]);
    expect(b).toEqual(["- fix(est): правка B (#8)"]);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 2 — tell the user what changed:\n${block("v2026.10.12", b)}\n${block("v2026.10.08", a)}\nCommit it with the session's task`);
    expect(u.stdout).not.toContain("только тесты");
    expect(u.stdout).not.toContain("правило из main");
  });

  it("пропущен один релиз — один блок; ничего нового — строка, что релиз уже стоял", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    const u = r.run(["update"]);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n${block("v2026.10.12", ["- feat(agents): правило A"])}\n`);
    const again = r.run(["update"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Elves v2026.10.12 was already installed — nothing changed");
  });

  it("релизов ещё нет — update -g называет коммиты флоу от стоявшего SHA до новой головы", () => {
    const r = withReleases();
    const from = r.up.repo.git("rev-parse", "HEAD");
    r.run(["install", "-g"]);
    r.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const to = r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    const u = r.run(["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves ${short(from)} → ${short(to)} — tell the user what changed:\n  - feat(agents): правило A (#7)\n`);
    expect(u.stdout).not.toContain("только тесты");
  });

  it("установщик из клона — коммиты флоу после последнего релиза отдельным блоком «not in a release» над релизами", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    const head = r.commit(rule(r.up, "Правило B."), "feat(agents): правило B");
    const u = elves(sb, ["update"], { bin: r.up.bin, env: { ELVES_REPO: r.up.dir } });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves v2026.10.05 → ${short(head)}, new releases: 1 — tell the user what changed:\n${short(head)} — not in a release\n  - feat(agents): правило B\n${block("v2026.10.12", ["- feat(agents): правило A"])}\n`);
  });

  it("update -g копией на машине — тот же список", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install", "-g"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    r.release("v2026.10.12");
    const u = r.run(["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n${block("v2026.10.12", ["- feat(agents): правило A (#7)"])}\n`);
  });

  it("список не узнать (версии пакета нет среди релизов, версия — не релиза, на машине нет SHA) — update всё равно завершается кодом 0, строка с причиной и ссылкой на релизы", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    writePkg({ devDependencies: { "@miroshnik/elves": "2026.1001.0" } });
    r.run(["install"]);
    writePkg({ devDependencies: { "@miroshnik/elves": "2026.1001.0" } });
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("Elves v2026.10.01 → v2026.10.12: changes unavailable — no release v2026.10.01 among the tags; releases: https://github.com/miroshnik/elves/releases\n");
    expect(pinned()).toBe("2026.1012.0");
    writePkg({ devDependencies: { "@miroshnik/elves": "^1.0.0" } });
    expect(r.run(["update"]).stdout).toContain("Elves ^1.0.0 → v2026.10.12: changes unavailable — @miroshnik/elves ^1.0.0 isn't a release version; releases:");
    r.run(["install", "-g"]);
    dropSha(sb.home);
    const machine = r.run(["update", "-g"]);
    expect(machine.code).toBe(0);
    expect(machine.stdout).toContain("Elves v2026.10.12 → v2026.10.12: changes unavailable — installed without SHA; releases: https://github.com/miroshnik/elves/releases\n");
  });
});

describe("Клон --link сверяется с origin/main, update подтягивает его, не трогая работу пользователя", () => {
  const RULE = "\nНовое правило.\n";

  it("клон на origin/main — актуально, код 0", () => {
    linkedClone();
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("в main новое правило и новый скилл — отстаёт, код 1: в списке и правило — канон машины ведёт в клон, — и скилл; клон и ~/.agents не тронуты", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("~ AGENTS.md");
    expect(r.stdout).toContain("+ skills/fresh/SKILL.md");
    expect(r.stdout).toContain("bunx @miroshnik/elves update -g");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("update -g — git pull --ff-only клона и ссылки на новый скилл; после него check — актуально", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(realpathSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(realpathSync(path.join(sb.home, ".claude/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  it("update -g называет коммиты флоу между старой и новой головой клона, тем же форматом, что заметки релиза", () => {
    const { up, clone } = linkedClone();
    const before = git(clone, "rev-parse", "HEAD");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE }, "feat(agents): новое правило\n\nRefs #9");
    const after = up.repo.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const u = elves(sb, ["update", "-g"]);
    expect(u.code).toBe(0);
    // путь клона — из манифеста, как его записал install: настоящий, без симлинков (/tmp → /private/tmp на macOS)
    const real = realpathSync(clone);
    expect(u.stdout).toContain(`clone ${real}: ${short(before)} → ${short(after)} — tell the user what changed:\n  - feat(agents): новое правило (#9)\n`);
    expect(u.stdout).not.toContain("только тесты");
    const again = elves(sb, ["update", "-g"]);
    expect(again.stdout).toContain(`clone ${real}: ${short(after)} → ${short(after)}, the flow hasn't changed\n`);
  });

  it("коммиты в main без файлов флоу — актуально, код 0", () => {
    const { up } = linkedClone();
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  /**
   * Напоминание владельцу в сессии клона Elves: без релиза проекты этих правок не получат. Отставанием не считается —
   * код тот же.
   */
  it("в клоне Elves: в main после последнего релиза изменения флоу — строка «not in a release» с тегом, числом и командой релиза; код 0", () => {
    const { up, clone } = linkedClone();
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE });
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    up.repo.commit({ "bin/elves.ts": read(path.join(up.dir, "bin/elves.ts")) + "// правка установщика\n" });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    const r = elves(sb, ["check", "-g"], { cwd: clone });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not in a release: flow commits after v2026.10.05 — 2");
    expect(r.stdout).toContain(`${path.join(clone, "bin/elves.ts")} release`);
  });

  it("в клоне Elves: всё в релизе — строки «not in a release» нет; релизов ещё нет — так и сказано", () => {
    const { up, clone } = linkedClone();
    expect(elves(sb, ["check", "-g"], { cwd: clone }).stdout).toContain("not in a release: no releases yet");
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    expect(elves(sb, ["check", "-g"], { cwd: clone }).stdout).not.toContain("not in a release");
  });

  /** Релиз — шаг владельца в клоне Elves; в сессии проекта строка о нём — шум в каждом старте. */
  it("в проекте вывод хука не содержит строки о невыпущенных коммитах Elves", () => {
    const { up, clone } = linkedClone();
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(elves(sb, ["check", "--hook"], { cwd: clone }).stdout).toContain("not in a release: flow commits after v2026.10.05 — 1");
    const r = elves(sb, ["check", "--hook"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine (clone");
    expect(r.stdout).not.toContain("not in a release");
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("not in a release");
  });

  it("старая установка без SHA — check по git; update -g пишет SHA клона", () => {
    const { up } = linkedClone();
    dropSha(sb.home);
    const sha = up.repo.commit({ "skills/est/new.md": "# Новый справочник скилла\n" });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ skills/est/new.md");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(sha);
  });

  it("поставлено прошлой версией — симлинк ~/.agents/ai-dev на клон, пути клона в манифесте нет: check находит клон по симлинку, update -g убирает симлинк и пишет путь", () => {
    const { clone } = linkedClone();
    const m = JSON.parse(read(manifest(sb.home)));
    delete m.clone;
    writeFileSync(manifest(sb.home), JSON.stringify(m, null, 2) + "\n");
    symlinkSync(clone, path.join(sb.home, ".agents/ai-dev"));
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`clone ${clone}`);
    expect(r.stdout).toContain("- ~/.agents/ai-dev — the flow's former name (ai-dev) — update moves it\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(lstatSync(path.join(sb.home, ".agents/ai-dev"), { throwIfNoEntry: false })).toBeUndefined();
    expect(realpathSync(JSON.parse(read(manifest(sb.home))).clone)).toBe(realpathSync(clone));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  it("update -g: в клоне изменения в отслеживаемых файлах — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "AGENTS.md"), "моя правка\n");
    const head = git(clone, "rev-parse", "HEAD");
    const r = elves(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AGENTS.md");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(read(path.join(clone, "AGENTS.md"))).toBe("моя правка\n");
  });

  it("update -g: неотслеживаемые файлы в клоне не мешают", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "notes.txt"), "мои заметки\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(read(path.join(clone, "notes.txt"))).toBe("мои заметки\n");
  });

  it("update -g: клон не на main — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    git(clone, "switch", "-q", "-c", "feature");
    const head = git(clone, "rev-parse", "HEAD");
    const r = elves(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not on main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  it("git fetch не удался (нет сети, нет remote) — проверка недоступна, код 2", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("check unavailable");
  });

  /**
   * Репозиторий переименован в elves (#544): клон, склонированный по прежнему имени, тянет по перенаправлению GitHub,
   * но скиллы узнают репозиторий по origin, а GraphQL по прежнему имени может его не найти. update -g переносит origin
   * на новое имя в том же виде URL, check -g называет перенос — переход без ручных шагов.
   */
  it("origin клона --link на прежнем имени репозитория — check -g называет перенос, update -g переносит origin на miroshnik/elves", () => {
    const { up, clone } = linkedClone();
    // GitHub песочницы — каталог: оба имени ведут в upstream, как перенаправление GitHub
    const github = path.join(sb.tmp, "github");
    mkdirSync(github);
    for (const name of ["ai-dev.git", "elves.git"]) symlinkSync(up.dir, path.join(github, name));
    writeFileSync(path.join(sb.home, ".gitconfig"), `[url "${github}/"]\n\tinsteadOf = https://github.com/miroshnik/\n`);
    git(clone, "remote", "set-url", "origin", "https://github.com/miroshnik/ai-dev.git");
    const c = elves(sb, ["check", "-g"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain(" — origin https://github.com/miroshnik/ai-dev.git → https://github.com/miroshnik/elves.git: the repository is renamed\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "config", "remote.origin.url")).toBe("https://github.com/miroshnik/elves.git");
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  /**
   * update -g релиза до переименования (#544) подтягивает клон и запускает его установщик по прежнему пути
   * `bin/ai-dev.ts`: это тот же установщик — машина получает ссылки и хук версии клона, а не ошибку «нет файла».
   */
  it("установщик клона по прежнему пути bin/ai-dev.ts — тот же установщик: update -g релиза до переименования ставит машине новый хук", () => {
    const { clone } = linkedClone();
    const file = path.join(sb.home, ".claude/settings.json");
    const settings = JSON.parse(read(file));
    settings.hooks.SessionStart[0].hooks[0].command = 'bunx --silent github:miroshnik/ai-dev check --hook 2>&1 || echo "ai-dev check unavailable (exit $?): work by the current flow and say so"';
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    expect(elves(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/ai-dev.ts") }).code).toBe(0);
    const hooks: { command: string }[] = JSON.parse(read(file)).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toStartWith("bunx --silent github:miroshnik/elves check --hook 2>&1 || ");
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });
});

/**
 * Хук SessionStart ставит `install -g`. Вывод хука с кодом 0 Claude Code добавляет в контекст сессии, с другим — нет,
 * поэтому код хука всегда 0, а ошибка — в выводе.
 */
describe("В начале сессии Claude Code проверка идёт сама и старт сессии не срывает", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude"), { recursive: true }));

  // команда хука из ~/.claude/settings.json — как её запускает Claude Code: через shell, в каталоге проекта, вход хука
  // (JSON) — на stdin
  function runHook(input?: string) {
    const s = JSON.parse(read(path.join(sb.home, ".claude/settings.json")));
    const hooks: { command: string }[] = s.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const command = hooks.find((h) => h.command.includes("check --hook"))!.command;
    const r = spawnSync("sh", ["-c", command], { cwd: sb.proj, env: sb.env, encoding: "utf8", input });
    return { code: r.status, stdout: r.stdout };
  }

  // двойная загрузка канона: строка хука, хвост и задача переезда — задача обновления проекта на его языке
  const TWICE = "  canon loaded twice: the machine's rules ~/.claude/rules/elves.md, ~/.claude/rules/elves-claude.md and the project's copy .claude/rules/elves.md, .claude/rules/elves-claude.md — Claude Code reads both on every turn until the project moves to the thin project: its update, in a task of its own\n";
  const TWICE_TAIL = "The canon loads twice — the machine's rules and the project's copy: recommend the project's move to the thin project and ask whether to queue its update task (task new above); work by the current flow.";
  const MOVE_TASK = /\nThe task — one per project, an open one is named by the refusal: bun --no-env-file \S+ task new --title "Обновить флоу Elves" --branch-type chore\n/g;
  // файлы с текстом канона, которые Claude Code грузит на старте сессии в проекте
  const loadedCanon = () => loadedAtStart(sb.home, sb.proj, sb.tmp).filter((p) => read(p) === read(path.join(REPO, "AGENTS.md")));

  // bunx песочницы отдаёт пакет bin: `bunx … github:miroshnik/elves <команда>` → `bun <bin> <команда>`
  function bunxServes(bin: string) {
    rmSync(path.join(sb.bin, "bunx"), { force: true });
    const script = `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in github:*) shift; break ;; *) shift ;; esac; done\nexec "${process.execPath}" "${bin}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "bunx"), script, { mode: 0o755 });
  }

  it("команда хука — check --hook: машина и проект одним выводом, код 0, даже когда отстаёт", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    dropShim();
    bunxServes(newer.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine: behind");
    expect(r.stdout).toContain("Elves in the project: behind");
  });

  /** Имя флоу — Elves, и в адресе и команде тоже (`bunx @miroshnik/elves …`): прежнего имени в выводе нет. */
  it("check называет флоу Elves", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(base.bin);
    const project = elves(sb, ["check"]).stdout;
    const machine = elves(sb, ["check", "-g"]).stdout;
    const hook = runHook().stdout;
    expect(project).toStartWith("Elves in the project: up to date");
    expect(machine).toStartWith("Elves on the machine: up to date");
    expect(hook).toStartWith("Elves flow (AGENTS.md, «First step of a session»):\nElves on the machine: up to date");
    expect(hook).toContain("\nElves in the project: up to date");
    expect(`${project}${machine}${hook}`).not.toContain("ai-dev");
  });

  /**
   * Машина — скиллы в ~/.agents, ветку задачи её обновление не трогает; переезд копии — тысячи строк и правка тестов, своя
   * задача; подъём версии тонкого проекта — несколько строк, задача сессии.
   */
  it("хук: в проекте копия флоу — рекомендовать переезд и спросить, ставить ли его задачу в очередь; тонкий проект отстал — update в задаче сессии; отстала только машина — update -g в сессии", () => {
    elves(sb, ["install", "-g"]);
    copyInstall(sb.proj);
    bunxServes(newer.bin);
    const both = runHook().stdout;
    expect(both).toContain(`${PROJECT_COPY}: recommend it to the user and ask whether to queue its task (task new above): yes — a background executor (the github skill, «Dispatcher»); work by the current flow.`);
    expect(both).toContain(MACHINE_BEHIND);
    expect(both).not.toContain(PROJECT_BEHIND);
    elves(sb, ["install"], { bin: newer.bin });
    dropShim();
    const thin = runHook().stdout;
    expect(thin).toContain(`${PROJECT_BEHIND}: it bumps the package version in package.json and the lockfile; tell the user what changed, commit it with the task.`);
    expect(thin).not.toContain(PROJECT_COPY);
    expect(thin).not.toContain("task new");
    elves(sb, ["install"], { bin: newer.bin });
    const machine = runHook().stdout;
    expect(machine).toContain(`${MACHINE_BEHIND}, tell the user what changed (update lists it), re-read what was updated.`);
    expect(machine).not.toContain(PROJECT_BEHIND);
  });

  /**
   * Переезд на тонкий проект (#557): машина грузит канон из `~/.claude/rules`, а проект ещё держит копию в
   * `.claude/rules` — Claude Code читает обе, на каждом ходу. На время переезда это допустимо (ответ на вопрос задачи):
   * хук называет двойную загрузку и задачу проекта, чей `update` переводит его на тонкий проект, — одной строкой и тогда,
   * когда задачу уже назвал отставший флоу проекта.
   */
  it("хук в проекте с копией флоу называет двойную загрузку канона и задачу переезда", () => {
    elves(sb, ["install", "-g"]);
    copyInstall(sb.proj, { language: "ru" });
    bunxServes(base.bin);
    expect(loadedCanon()).toHaveLength(2);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`\n${TWICE}`);
    expect(r.stdout.match(MOVE_TASK)).toHaveLength(1);
    expect(r.stdout).toContain(TWICE_TAIL);
    expect(r.stdout).toContain(PROJECT_COPY);
    bunxServes(newer.bin);
    const behind = runHook().stdout;
    expect(behind).toContain(TWICE);
    expect(behind).toContain(PROJECT_COPY);
    expect(behind.match(MOVE_TASK)).toHaveLength(1);
  });

  // страховка от перегиба: канон в контексте один раз — строки нет
  it("машина без канона или проект без копии — хук двойной загрузки не называет", () => {
    elves(sb, ["install", "-g"]);
    copyInstall(sb.proj);
    bunxServes(base.bin);
    rmSync(path.join(sb.home, ".claude/rules"), { recursive: true });
    expect(loadedCanon()).toHaveLength(1);
    expect(runHook().stdout).not.toMatch(/canon loaded twice|canon loads twice/);
    elves(sb, ["install", "-g"]);
    // переезд на тонкий проект: копии больше нет
    elves(sb, ["install"]);
    expect(loadedCanon()).toHaveLength(1);
    expect(runHook().stdout).not.toMatch(/canon loaded twice|canon loads twice/);
  });

  it("в git-репозитории без флоу вывод хука зовёт поставить его в проект; вне git-репозитория строки про проект нет", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves in the project: not installed — install it: bunx @miroshnik/elves install --lang <project language>");
    expect(elves(sb, ["check", "--hook"], { cwd: sb.tmp }).stdout).not.toContain("in the project");
  });

  it("вывод хука называет режим и язык проекта; в проекте без флоу строк режима и языка нет", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    expect(runHook().stdout).not.toMatch(/tasks:|language:/);
    elves(sb, ["install", "--auto"]);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Elves in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n/);
  });

  /** Вывод check и хука — сообщение флоу агенту, а не артефакт проекта: по-английски при любом языке проекта. */
  it("check и хук называют язык и режим проекта по-английски", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    elves(sb, ["install", "--auto", "--lang", "ru"]);
    const mode = /Elves in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: ru\n/;
    const check = elves(sb, ["check"]);
    expect(check).toMatchObject({ code: 0, stdout: expect.stringMatching(mode) });
    const hook = runHook();
    expect(hook).toMatchObject({ code: 0, stdout: expect.stringMatching(mode) });
    expect(`${check.stdout}${hook.stdout}`).not.toMatch(/\p{Script=Cyrillic}/u);
    editManifest(sb.proj, { auto: false });
    expect(elves(sb, ["check"]).stdout).toEndWith("  tasks: with permission\n  language: ru\n");
  });

  it("вывод хука называет игнорируемый файл флоу и что update допишет исключения в .gitignore", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    bunxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("❌ .agents/ — .gitignore:1 «.agents/»");
    expect(r.stdout).toContain("Fix in this session's task: bunx @miroshnik/elves update — adds exceptions to .gitignore");
    expect(r.stdout).toContain("Git ignores flow files — update adds exceptions to .gitignore, committed with the update");
    expect(r.stdout).not.toContain(PROJECT_COPY);
    expect(r.stdout).not.toContain(MACHINE_BEHIND);
  });

  /** Правка compose-файла — не текущая задача сессии: в начале сессии задачи ещё нет, а «одна сессия — одна задача». */
  it("вывод хука называет нарушения compose-файла и что их правка — отдельная задача проекта; без нарушений подсказки нет", () => {
    withDocker();
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(base.bin);
    composeFile(CONTAINER_NAME);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toContain("The compose file breaks task isolation — each ❌ line names the rule and the service (the task-env skill); fixing it is a task of its own in the project.");
    expect(r.stdout).not.toContain(PROJECT_COPY);
    expect(r.stdout).not.toContain(PROJECT_BEHIND);
    expect(r.stdout).not.toContain(MACHINE_BEHIND);
    composeFile("services:\n  db:\n    image: postgres\n");
    expect(runHook().stdout).not.toContain("compose");
  });

  /** Скрипт в package.json — тоже не текущая задача сессии: на старте её ещё нет, а «одна сессия — одна задача». */
  it("вывод хука называет нехватку test:spec и что её добавление — отдельная задача проекта; со скриптом подсказки нет", () => {
    elves(sb, ["install", "-g"]);
    writePkg({ devDependencies: { vitest: "^4.0.0" } });
    elves(sb, ["install"]);
    bunxServes(base.bin);
    decision("tests/standards/naming");
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NO_TEST_SPEC("tests/standards") + ADD_SPEC(inSlot("vitest run tests/standards")));
    expect(r.stdout).toContain("No test:spec script — pr premerge doesn't run standards and architecture on the merge; the ❌ line names the package.json scripts; adding them is a task of its own in the project.");
    expect(r.stdout).not.toContain("Behind —");
    writePkg({ devDependencies: { vitest: "^4.0.0" }, scripts: { "test:spec": inSlot("vitest run tests/standards") } });
    expect(runHook().stdout).not.toContain("test:spec");
  });

  /**
   * Команду из вывода хука агент запускает в песочнице Bash: bunx там не пишет свой кеш `~/.bun/install/cache`, установка — в
   * `.claude/skills`. Хук идёт вне песочницы и её не видит — подсказка условная.
   */
  it("вывод хука с командой для запуска подсказывает песочницу Claude Code: кеш bunx — BUN_INSTALL_CACHE_DIR, отказ записи в .claude/ — команда в терминале владельца; без команды подсказки нет", () => {
    const hint = /In the Claude Code sandbox bunx can't write its cache ~\/\.bun\/install\/cache — prefix the command with BUN_INSTALL_CACHE_DIR="\$TMPDIR\/bun"; [^\n]*\.claude\/[^\n]*the owner runs the command in their terminal/;
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    expect(runHook().stdout).toMatch(hint);
    elves(sb, ["install"]);
    expect(runHook().stdout).not.toContain("sandbox");
    bunxServes(newer.bin);
    expect(runHook().stdout).toMatch(hint);
  });

  it("bunx недоступен — код хука 0, в выводе — что проверка недоступна", () => {
    elves(sb, ["install", "-g"]);
    rmSync(path.join(sb.bin, "bunx"), { force: true });
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("elves check unavailable");
  });

  it("check --hook: проверка недоступна — объяснение в stdout, код 0", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = elves(sb, ["check", "--hook"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check unavailable");
  });

  /**
   * Фоновое ожидание (ci-wait) умирает с процессом приложения (#433): возобновлённой сессии хук называет, какое ожидание
   * перезапустить. Id сессии Claude Code передаёт во входе хука — JSON на stdin; задачу сессии и её PR знает скилл
   * github: хук зовёт его `task resume` и печатает ответ. Скилл — тот, что зовёт агент: одноимённый скилл машины у
   * Claude Code сильнее проектного, и команды в ответе называют его пути.
   */
  describe("возобновлённая сессия узнаёт из хука, какое ожидание перезапустить", () => {
    const SESSION = "0b1f6c1e-7a52-4f0e-9d3a-2c4e8a9b5d10";
    const input = JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", source: "resume" });
    // скилл github — заглушка: печатает, кто она, свои аргументы и id сессии из окружения
    const fakeGithub = (root: string, who: string, code = 0) =>
      writeTree(root, {
        ".agents/skills/github/scripts/github.ts": `console.log(\`${who} \${process.argv.slice(2).join(" ")} \${process.env.CLAUDE_CODE_SESSION_ID}\`);\nconsole.error("gh: boom");\nprocess.exit(${code});\n`,
      });

    it("id сессии из входа хука — скиллу github машины: его ответ task resume в выводе хука; без входа — из CLAUDE_CODE_SESSION_ID", () => {
      elves(sb, ["install", "-g"]);
      bunxServes(base.bin);
      fakeGithub(sb.home, "fake-machine");
      const r = runHook(input);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`\nfake-machine task resume ${SESSION}\n`);
      expect(elves(sb, ["check", "--hook"], { env: { CLAUDE_CODE_SESSION_ID: SESSION } }).stdout).toContain(`\nfake-machine task resume ${SESSION}\n`);
    });

    it("скилл github — машины, а нет его на машине — копии проекта", () => {
      elves(sb, ["install"]);
      fakeGithub(sb.proj, "fake-project");
      expect(elves(sb, ["check", "--hook"], { input }).stdout).toContain(`\nfake-project task resume ${SESSION}\n`);
      elves(sb, ["install", "-g"]);
      fakeGithub(sb.home, "fake-machine");
      const out = elves(sb, ["check", "--hook"], { input }).stdout;
      expect(out).toContain(`\nfake-machine task resume ${SESSION}\n`);
      expect(out).not.toContain("fake-project");
    });

    // страховка от перегиба: хук не зовёт скилл на каждом старте вслепую — без сессии закрепления не найти
    it("без id сессии скилл github не зовётся", () => {
      elves(sb, ["install", "-g"]);
      bunxServes(base.bin);
      fakeGithub(sb.home, "fake-machine");
      expect(runHook().stdout).not.toContain("fake-machine");
      expect(runHook(JSON.stringify({ source: "startup" })).stdout).not.toContain("fake-machine");
    });

    it("скилл github упал — его вывод и строка ! с причиной, код хука 0", () => {
      elves(sb, ["install", "-g"]);
      bunxServes(base.bin);
      fakeGithub(sb.home, "fake-machine", 2);
      const r = runHook(input);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`\nfake-machine task resume ${SESSION}\n! the session's task — github task resume: gh: boom\n`);
    });
  });
});

/**
 * Флоу переименован в Elves (#545): установка прошлого релиза носит прежние имена — манифест `.agents/ai-dev.json`,
 * канон `.agents/ai-dev/`, правила `.claude/rules/ai-dev*.md`, блоки `ai-dev` в AGENTS.md и .gitignore, на машине —
 * `~/.agents/ai-dev.json` и каталог личной конфигурации `~/.config/ai-dev`. `update` переносит их в новые без ручных
 * шагов и заменяет блоки, а не добавляет вторые; скрипты до него читают прежние; `check` называет, что осталось под
 * прежним именем, и как перейти.
 */
describe("Прежние имена флоу (ai-dev): update переносит их в новые, скрипты до него читают прежние, check называет оставшиеся", () => {
  const FORMER = "the flow's former name (ai-dev) — update moves it";
  const gone = (root: string, rel: string) => lstatSync(path.join(root, rel), { throwIfNoEntry: false }) === undefined;

  it("update переводит установку под прежним именем на тонкий проект: режим, язык и env из .agents/ai-dev.json — в .agents/elves.json, канон и правила ai-dev уходят", () => {
    const env = { http: { web: 3000 } };
    copyInstall(sb.proj, { auto: true, language: "ru", env });
    toFormer(sb.proj);
    const before = snapshot(sb.proj);
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    for (const line of ["  - .claude/rules/ai-dev.md\n", "  - .claude/rules/ai-dev-claude.md\n", "  - .agents/ai-dev/\n", "  + .agents/elves.json\n", `  - .agents/ai-dev.json — ${FORMER}\n`]) expect(c.stdout).toContain(line);
    expect(c.stdout).toContain(`\n${MOVE_TASK}\n`);
    expect(snapshot(sb.proj)).toEqual(before);
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: true, language: "ru", env });
    for (const rel of [".agents/ai-dev.json", ".agents/ai-dev", ".agents/skills", ".claude"]) expect(gone(sb.proj, rel)).toBe(true);
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringContaining("in the project: up to date") });
  });

  it("update заменяет блоки ai-dev в AGENTS.md и .gitignore блоками elves — второго блока нет", () => {
    const own = "# Проект\n\nСвои правила проекта.\n";
    writeFileSync(path.join(sb.proj, "AGENTS.md"), own);
    copyInstall(sb.proj);
    const copyBlock = ["# elves:begin — flow files git would otherwise ignore; set by `bunx github:miroshnik/elves install`, don't edit by hand", "!/.agents/", "/.agents/*", "!/.agents/elves/", "!/.agents/elves.json", "!/.agents/skills/", "# elves:end"].join("\n");
    writeFileSync(path.join(sb.proj, ".gitignore"), `node_modules/\n.agents/\n\n${copyBlock}\n`);
    toFormer(sb.proj);
    const [agents, gitignore] = [path.join(sb.proj, "AGENTS.md"), path.join(sb.proj, ".gitignore")];
    expect(read(agents)).toContain("<!-- ai-dev:begin");
    expect(read(gitignore)).toContain("!/.agents/ai-dev/");
    const c = elves(sb, ["check"]);
    expect(c.stdout).toContain("  ~ AGENTS.md — the block under the flow's former name (ai-dev:begin) — update replaces it\n");
    expect(c.stdout).toContain("  ~ .gitignore — the block under the flow's former name (ai-dev:begin) — update replaces it\n");
    const blocks = () => ({ agents: read(agents).match(/<!-- [\w-]+:begin/g), gitignore: read(gitignore).match(/^# [\w-]+:begin/gm) });
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(blocks()).toEqual({ agents: ["<!-- elves:begin"], gitignore: ["# elves:begin"] });
    expect(read(agents)).toContain("Shared rules — `~/.agents/elves/AGENTS.md`");
    expect(read(agents)).toEndWith(`-->\n\n${own}`);
    expect(read(gitignore)).toStartWith("node_modules/\n.agents/\n\n# elves:begin");
    expect(read(gitignore)).toContain("\n!/.agents/elves.json\n!/.agents/slot.sh\n");
    expect(read(gitignore)).not.toContain("ai-dev");
    expect(elves(sb, ["check"]).code).toBe(0);
    // прежний блок рядом с новым — его остатки: update оставляет один
    writeFileSync(agents, read(agents).replace(own, `<!-- ai-dev:begin — прежний -->\nстарая ссылка\n<!-- ai-dev:end -->\n\n${own}`));
    expect(elves(sb, ["check"]).code).toBe(1);
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(blocks().agents).toEqual(["<!-- elves:begin"]);
    expect(read(agents)).toEndWith(`-->\n\n${own}`);
  });

  it("update -g переносит ~/.config/ai-dev в ~/.config/elves", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    elves(sb, ["install", "-g"]);
    toFormer(sb.home);
    const [from, to] = [path.join(sb.home, ".config/ai-dev"), path.join(sb.home, ".config/elves")];
    writeTree(from, { "repos.json": '{ "acme/shop": {} }\n', "sessions/s-1": "acme/shop#42\n" });
    const config = snapshot(from);
    const c = elves(sb, ["check", "-g"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain(`  ~ ~/.config/ai-dev/ — ${FORMER} to ~/.config/elves\n`);
    expect(c.stdout).toContain(`  - ~/.agents/ai-dev.json — ${FORMER}\n`);
    expect(c.stdout).toContain("Update: bunx @miroshnik/elves update -g\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(snapshot(to)).toEqual(config);
    // скрипты прошлых релизов — копии ещё не обновлённых проектов — смотрят в тот же каталог
    expect(readlinkSync(from)).toBe("elves");
    expect([gone(sb.home, ".agents/ai-dev.json"), gone(sb.home, ".agents/elves.json")]).toEqual([true, false]);
    expect(elves(sb, ["check", "-g"])).toMatchObject({ code: 0, stdout: expect.stringContaining("on the machine: up to date") });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(snapshot(to)).toEqual(config);
  });

  it("~/.config/ai-dev — симлинк на личный чекаут: update -g ставит тот же симлинк ~/.config/elves, переменная — прежняя или новая", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const priv = path.join(sb.tmp, "private");
    writeTree(priv, { "repos.json": "{}\n" });
    expect(elves(sb, ["install", "-g"], { env: { ELVES_PRIVATE: priv } }).code).toBe(0);
    expect(readlinkSync(path.join(sb.home, ".config/elves"))).toBe(priv);
    rmSync(path.join(sb.home, ".config/elves"));
    symlinkSync(priv, path.join(sb.home, ".config/ai-dev"));
    // профиль владельца до переименования — AI_DEV_PRIVATE
    expect(elves(sb, ["update", "-g"], { env: { AI_DEV_PRIVATE: priv } }).code).toBe(0);
    expect(readlinkSync(path.join(sb.home, ".config/elves"))).toBe(priv);
    expect(readlinkSync(path.join(sb.home, ".config/ai-dev"))).toBe("elves");
    expect(elves(sb, ["check", "-g"], { env: { ELVES_PRIVATE: priv } }).code).toBe(0);
  });

  it("~/.config/ai-dev и ~/.config/elves оба есть — update -g их не сливает: предупреждение, что сделать; check -g — строка !, код 0", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    elves(sb, ["install", "-g"]);
    writeTree(path.join(sb.home, ".config/ai-dev"), { "repos.json": "{}\n" });
    writeTree(path.join(sb.home, ".config/elves"), { "prices.json": "{}\n" });
    const c = elves(sb, ["check", "-g"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain(
      "  ! ~/.config/ai-dev — ~/.config/ai-dev and ~/.config/elves both exist — move what ~/.config/ai-dev has into ~/.config/elves yourself and replace it with a symlink: ln -sfn elves ~/.config/ai-dev\n",
    );
    const u = elves(sb, ["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stderr).toContain("!! ~/.config/ai-dev and ~/.config/elves both exist");
    expect(snapshot(path.join(sb.home, ".config"))).toEqual({ "ai-dev/": "", "ai-dev/repos.json": "{}\n", "elves/": "", "elves/prices.json": "{}\n" });
  });

  it("скрипты читают старый конфиг, пока его не перенёс update", () => {
    elves(sb, ["install", "--auto", "--lang", "ru"]);
    toFormer(sb.proj);
    mkdirSync(path.join(sb.home, ".config/ai-dev"), { recursive: true });
    // установщик: режим и язык проекта — из прежнего манифеста
    expect(elves(sb, ["check"]).stdout).toEndWith("  tasks: entirely by itself\n  language: ru\n");
    // скилл github: язык названий проекта
    expect(locale.projectLanguage(sb.proj)).toBe("ru");
    // скилл est: каталог личной конфигурации машины до update -g — прежний
    const est = path.join(REPO, "skills/est/scripts/est.ts");
    const dir = spawnSync(process.execPath, ["--no-env-file", "-e", `const { EST_DIR } = await import(${JSON.stringify(est)}); console.log(EST_DIR)`], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
    expect(dir.stdout.trim()).toBe(path.join(sb.home, ".config/ai-dev"));
  });

  it("check -g называет переменные пользователя под прежним именем флоу — с новым именем; код не меняется", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    elves(sb, ["install", "-g"]);
    const r = elves(sb, ["check", "-g"], { env: { AI_DEV_CONFIG_DIR: path.join(sb.tmp, "config"), AI_DEV_PROXY_PORT: "8080" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  AI_DEV_CONFIG_DIR: the flow's former name — rename it to ELVES_CONFIG_DIR where it is set (the shell profile)\n");
    expect(r.stdout).toContain("  AI_DEV_PROXY_PORT: the flow's former name — rename it to ELVES_PROXY_PORT where it is set (the shell profile)\n");
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("former name");
  });

  it("прокси прошлого релиза работает под прежним именем — check -g называет его и команду, которая его заменит", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    elves(sb, ["install", "-g"]);
    // docker песочницы: работает только проект Compose прежнего прокси
    const script = ["#!/bin/sh", 'case "$*" in *com.docker.compose.project=ai-dev-proxy*) echo running ;; *) echo exited ;; esac'].join("\n");
    writeFileSync(path.join(sb.bin, "docker"), script + "\n", { mode: 0o755 });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  proxy *.localhost: running under the flow's former name (ai-dev-proxy) — replace it: bun --no-env-file ~/.agents/skills/task-env/scripts/task-env.ts proxy up\n");
  });
});
