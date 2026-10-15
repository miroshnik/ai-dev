import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { elves, elvesPackage, bunxPackage, bunxServesPackages, copyPackage, REPO, sandbox, snapshot, type ElvesPackage, type Sandbox } from "../../lib/elves.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// пакеты Elves собираются один раз на файл: base — как этот клон, newer — Elves ушёл вперёд
let packages: { dir: string; cleanup: () => void };
let base: ElvesPackage;
let newer: ElvesPackage;
beforeAll(() => {
  packages = tmpDir();
  base = elvesPackage(path.join(packages.dir, "base"));
  // новое правило в AGENTS.md, новый скилл, скилл ci-wait убран
  newer = elvesPackage(path.join(packages.dir, "newer"), {
    "AGENTS.md": readFileSync(path.join(REPO, "AGENTS.md"), "utf8") + "\nНовое правило.\n",
    "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: новый скилл\n---\n",
    "skills/ci-wait": null,
  });
});
afterAll(() => packages.cleanup());

const read = (p: string) => readFileSync(p, "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 7);
const manifest = (root: string) => path.join(root, ".agents/ai-dev.json");

// правка .agents/ai-dev.json руками: поля из fields заменяются, undefined — поле убирается
function editManifest(root: string, fields: Record<string, unknown>) {
  writeFileSync(manifest(root), JSON.stringify({ ...JSON.parse(read(manifest(root))), ...fields }, null, 2) + "\n");
}

// установка прошлой версией установщика: в .agents/ai-dev.json нет SHA
const dropSha = (root: string) => editManifest(root, { sha: undefined });

// режим и язык проекта — последними строками check: язык новой установки без флага — en
const MODE_ASK = "  tasks: with permission\n  language: en\n";
const MODE_AUTO = "  tasks: entirely by itself\n  language: en\n";

// скрипт скилла github в копии флоу — проекта (от корня проекта) и машины (от домашнего каталога)
const GITHUB = ".agents/skills/github/scripts/github.ts";
// хвост хука: флоу проекта обновляет своя задача, машину — сама сессия
const PROJECT_UPDATE = "The project's flow needs update — not in a task session";
const MACHINE_BEHIND = "The machine is behind — update -g";

// машина с `install -g --link` из клона; origin клона — upstream, куда тест коммитит новое в main
function linkedClone() {
  mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  expect(elves(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/elves.ts") }).code).toBe(0);
  return { up, clone };
}

describe("Копия в проекте сверяется со свежим Elves и обновляется им", () => {
  it("поставлено из того же Elves — актуально, код 0", () => {
    elves(sb, ["install"]);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: up to date");
  });

  it("Elves ушёл вперёд — отстаёт, код 1: стоит и свежий SHA, что изменится, команда обновления; check ничего не меняет", () => {
    elves(sb, ["install"]);
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`in the project: behind — installed ${short(git(REPO, "rev-parse", "HEAD"))}, latest ${short(newer.sha)}`);
    expect(r.stdout).toContain("~ .agents/ai-dev/AGENTS.md");
    expect(r.stdout).toContain("+ .agents/skills/fresh/");
    expect(r.stdout).toContain("- .agents/skills/ci-wait/");
    expect(r.stdout).toContain("bunx github:miroshnik/elves update\n");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  /**
   * Копия — тысячи строк, в ветке задачи им не место: обновление — своя задача, одна на проект. Название постоянное, на
   * языке проекта: открытую задачу `task new` второй раз не заводит — отказывает с её номером.
   */
  it("проверка проекта с отставшим флоу рекомендует обновление и не велит обновлять в сессии задачи", () => {
    elves(sb, ["install", "--lang", "ru"]);
    const r = elves(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Update in a task of its own, not in this session's task: bunx github:miroshnik/elves update\n");
    expect(r.stdout).toMatch(/\nThe task — one per project, an open one is named by the refusal: bun --no-env-file \S+\/skills\/github\/scripts\/github\.ts task new --title "Обновить флоу Elves" --branch-type chore\n/);
  });

  /**
   * Строка выходит ровно тогда, когда копия проекта отстала, — её скрипт github может не знать печатаемых флагов
   * (`--branch-type` — с v2026.10.11). Команда — скриптом машины, иначе пакета, которым идёт check: тот же релиз. Без
   * GitHub задачу не завести — команда доходит до поиска репозитория, а не падает на флаге.
   */
  it("копия проекта до `--branch-type`: команда задачи обновления из `check` — скриптом github, который знает её флаги, а не отставшей копией", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, GITHUB), "console.error(\"Unknown option '--branch-type'\");\nprocess.exit(2);\n");
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

  it("update — копия как у свежего пакета, его SHA в .agents/ai-dev.json, подсказка коммита chore(agents) на языке проекта; после него check — актуально", () => {
    elves(sb, ["install", "--lang", "ru"]);
    const r = elves(sb, ["update"], { bin: newer.bin });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`chore(agents): флоу Elves ${short(newer.sha)}`);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).toContain("Новое правило.");
    expect(existsSync(path.join(sb.proj, ".agents/skills/fresh/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(sb.proj, ".agents/skills/ci-wait"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.proj))).sha).toBe(newer.sha);
    expect(elves(sb, ["check"], { bin: newer.bin }).code).toBe(0);
  });

  /** Флоу до перехода на Bun ставился через npx: его команду носят блок AGENTS.md и блок исключений .gitignore. */
  it("блоки AGENTS.md и .gitignore со старой командой npx — отстаёт; update переписывает оба на bunx; после него check — актуально", () => {
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n");
    elves(sb, ["install"]);
    const files = [path.join(sb.proj, "AGENTS.md"), path.join(sb.proj, ".gitignore")];
    for (const f of files) {
      const text = read(f);
      expect(text).toContain("`bunx github:miroshnik/elves install`");
      writeFileSync(f, text.replace("`bunx github:miroshnik/elves install`", "`npx -y github:miroshnik/ai-dev install`"));
    }
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("  ~ AGENTS.md\n");
    expect(elves(sb, ["update"]).code).toBe(0);
    for (const f of files) expect(read(f)).not.toContain("npx");
    expect(elves(sb, ["check"]).code).toBe(0);
  });

  it("старая установка без SHA — check сравнивает содержимое: совпадает — актуально, нет — отстаёт «without SHA»; update записывает SHA", () => {
    elves(sb, ["install"]);
    dropSha(sb.proj);
    expect(elves(sb, ["check"]).code).toBe(0);
    const r = elves(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("installed without SHA");
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).sha).toBe(newer.sha);
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
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ sha: newer.sha, auto: true });
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
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ sha: newer.sha, language: "ru" });
    elves(sb, ["install", "--lang", "en"]);
    editManifest(sb.proj, { language: undefined });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).language).toBe("ru");
  });

  /** `env` — настройка стека задачи (скилл task-env: HTTP-сервисы и их порты): её пишет проект, установщик переносит. */
  it("`install` и `update` сохраняют `env` в `.agents/ai-dev.json`", () => {
    const env = { http: { web: 3000, admin: 5173 } };
    elves(sb, ["install"]);
    editManifest(sb.proj, { env });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ sha: newer.sha, env });
    expect(elves(sb, ["install", "--lang", "ru"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ language: "ru", env });
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
    const check = (bin?: string) => elves(sb, ["check"], { bin });
    expect(check().stdout).toEndWith(MODE_ASK);
    editManifest(sb.proj, { auto: true });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n$/) });
    const behind = check(newer.bin);
    expect(behind.code).toBe(1);
    expect(behind.stdout).toEndWith(`task new --title "Update the Elves flow" --branch-type chore\n${MODE_AUTO}`);
    editManifest(sb.proj, { auto: undefined });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: with permission\n {2}language: en\n$/) });
    expect(elves(sb, ["install", "-g"]).code).toBe(0);
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("tasks:");
  });

  /** Клон Elves — сам канон: сверять и обновлять в нём нечего, а режим сессии в нём знать нужно. */
  it("в клоне Elves check и хук называют режим, клон остаётся «not installed»: релиз не ищут, поставить флоу не зовут, update флоу в клон не ставит", () => {
    const clone = copyPackage(base, path.join(sb.tmp, "clone")).dir;
    // установщик — пакет bunx из main, релизы недоступны: поиск релиза дал бы код 2
    const bin = bunxPackage(path.join(sb.tmp, "bunx/main"), base.dir, null);
    const run = (...args: string[]) => elves(sb, args, { cwd: clone, bin, env: { AI_DEV_REPO: path.join(sb.tmp, "nowhere") } });
    const ABSENT = "Elves in the project: not installed — an Elves clone, the canon is at its root\n";
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
    expect(elves(sb, ["install", "--auto"], { cwd: clone }).code).toBe(0);
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_AUTO });
    const hook = run("check", "--hook");
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain(ABSENT + MODE_AUTO);
    expect(hook.stdout).not.toContain("install it");
    expect(elves(sb, ["update"], { cwd: clone }).code).toBe(0);
    expect(snapshot(path.join(clone, ".agents"))).toEqual({ "ai-dev.json": JSON.stringify({ auto: true, language: "en" }, null, 2) + "\n" });
  });
});

/**
 * Копия, которую игнорирует git проекта, в коммит не попадёт — чужой чекаут и облачная сессия работают без неё. Это
 * несоответствие флоу, как отставание: чинит тот же `update` (capability `install` — как).
 */
describe("Файл флоу, который игнорирует git проекта, — несоответствие: check его называет, update снимает исключением", () => {
  it("check: код 1, ❌ с путём и правилом, команда update — в задаче обновления, как и при отставании; check ничего не меняет", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain("git ignores flow files");
    expect(r.stdout).toContain("  ❌ .agents/ai-dev/claude/CLAUDE.md — .gitignore:1 «CLAUDE.md»\n");
    expect(r.stdout).toContain("Fix in a task of its own, not in this session's task: bunx github:miroshnik/elves update — adds exceptions to .gitignore\n");
    expect(r.stdout).toContain("/skills/github/scripts/github.ts task new --title \"Update the Elves flow\" --branch-type chore\n");
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update дописывает исключения, подсказка коммита включает .gitignore — её git add берёт копию и симлинки; после него check — актуально", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n.claude/\n");
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    const add = /git add -A [^&\n]+/.exec(u.stdout)?.[0] ?? "";
    expect(add).toContain(".gitignore");
    execFileSync("sh", ["-c", add], { cwd: sb.proj, env: sb.env });
    const staged = git(sb.proj, "diff", "--cached", "--name-only").split("\n");
    expect(staged).toEqual(expect.arrayContaining([".gitignore", ".agents/ai-dev/claude/CLAUDE.md", ".claude/rules/ai-dev-claude.md", ".claude/skills/spec"]));
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringContaining("in the project: up to date") });
  });

  /** Сторож от перекоррекции: свои правки .gitignore проекта в коммит флоу не уходят. */
  it("ничего не игнорируется — подсказка коммита update без .gitignore", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "dist/\n");
    expect(elves(sb, ["update"]).stdout).toContain("git add -A .agents .claude/rules .claude/skills AGENTS.md && git commit");
  });

  it("каталог флоу исключён правилом вне проекта — check: ❌ с правилом и «fix the rule», без команды update: её исключение не поможет", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.home, ".gitconfig"), `[core]\n\texcludesFile = ${path.join(sb.home, "personal-ignore")}\n`);
    writeFileSync(path.join(sb.home, "personal-ignore"), ".claude/\n");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ❌ .claude/ — ~/personal-ignore:1 «.claude/»: the directory is excluded outside the project");
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
    const r = elves(sb, ["check"], { bin: newer.bin });
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

const writePkg = (fields: Record<string, unknown>) => writeFileSync(path.join(sb.proj, "package.json"), JSON.stringify({ name: "x", private: true, ...fields }, null, 2) + "\n");
// решение в корне спеки — каталог с тестом, как у проекта
function decision(rel: string) {
  mkdirSync(path.join(sb.proj, rel), { recursive: true });
  writeFileSync(path.join(sb.proj, rel, `${path.basename(rel)}.test.ts`), "");
}
// обёртка slot, которую ставит install: скрипт берёт слот своим shell, команда — как есть
const inSlot = (cmd: string) => `. .agents/skills/slot/scripts/slot.sh && ${cmd}`;
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

  it("Elves ушёл вперёд (новый скилл) — отстаёт, код 1, check ничего не меняет; update -g доводит до актуального, правил на машине по-прежнему нет", () => {
    elves(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ ~/.agents/skills/fresh/");
    expect(r.stdout).toContain("bunx github:miroshnik/elves update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(elves(sb, ["update", "-g"], { bin: newer.bin }).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(true);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(newer.sha);
    expect(elves(sb, ["check", "-g"], { bin: newer.bin }).code).toBe(0);
  });

  it("поставлено прошлой версией с правилами на машине — отстаёт: в списке «- ~/.agents/ai-dev/» и «- ~/.claude/rules/ai-dev.md»; update -g убирает их, после него check — актуально", () => {
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

// Elves с релизами: upstream — git-репозиторий, откуда установщик берёт теги (AI_DEV_REPO); bunx песочницы отдаёт
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
    run: (args: string[], env: Record<string, string> = {}) => elves(sb, args, { bin, env: { AI_DEV_REPO: up.dir, ...env } }),
  };
}

/**
 * Проекты и машина копией следуют за релизами Elves (теги vГГГГ.ММ.ДД), а не за main: коммит в main без релиза их
 * «отставшими» не делает. bunx ставит пакет из main один раз и дальше берёт его из кеша — он только пускатель: находит
 * последний релиз и перезапускается по его SHA, дальше и код, и файлы релиза.
 */
describe("Копия следует за релизами Elves, а не за main", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });

  it("install ставит последний релиз, а не голову main: его файлы, тег и SHA в .agents/ai-dev.json", () => {
    const r = withReleases();
    const sha = r.release("v2026.10.05");
    r.commit(rule(r.up, "Правило из main."));
    expect(r.run(["install"]).code).toBe(0);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).not.toContain("Правило из main.");
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.05", sha });
  });

  it("main ушёл вперёд, нового релиза нет — актуально, код 0", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("in the project: up to date (v2026.10.05)");
  });

  it("вышел релиз новее установленного — отстаёт, код 1: стоящий и свежий тег; check ничего не меняет", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    const before = snapshot(sb.proj);
    const c = r.run(["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("in the project: behind — installed v2026.10.05, latest v2026.10.12");
    expect(c.stdout).toContain("~ .agents/ai-dev/AGENTS.md");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update ставит последний релиз, а не голову main; подсказка коммита — с тегом; после него check — актуально", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    const sha = r.release("v2026.10.12");
    r.commit(rule(r.up, "Правило из main."));
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    // проект на en (install без флага и терминала): описание коммита — по-английски
    expect(u.stdout).toContain("chore(agents): Elves flow v2026.10.12");
    const agents = read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"));
    expect(agents).toContain("Правило релиза.");
    expect(agents).not.toContain("Правило из main.");
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.12", sha });
    expect(r.run(["check"]).code).toBe(0);
  });

  /** Аннотированный тег ls-remote отдаёт объектом тега — ставится коммит, на который он указывает. */
  it("последний релиз — по дате, затем по номеру патча; аннотированный тег — его коммит; чужие теги не в счёт", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Патч."));
    const sha = r.release("v2026.10.05.1", { annotated: true });
    r.commit(rule(r.up, "Правило из main."));
    r.release("v2026.09.30");
    r.up.repo.git("tag", "v9.0.0");
    r.run(["install"]);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.05.1", sha });
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).not.toContain("Правило из main.");
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

  /** Пускатель из кеша bunx старше main: по SHA головы ставится свежий main, а не он сам. */
  it("релизов ещё нет — пускатель перезапускается по SHA головы main: её файлы и SHA, без тега", () => {
    const r = withReleases();
    const sha = r.commit(rule(r.up, "Правило из main."));
    expect(r.run(["install"]).code).toBe(0);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).toContain("Правило из main.");
    const m = JSON.parse(read(manifest(sb.proj)));
    expect(m.sha).toBe(sha);
    expect(m.tag).toBeUndefined();
  });

  /**
   * Пускатель в кеше bunx старше релиза: флаг или команду, которые появились позже, он сам бы отверг. Поэтому он
   * перезапускается до проверки команды и флагов.
   */
  it("устаревший пускатель не отвергает флаг, который знает релиз: перезапуск — до проверки флагов", () => {
    const r = withReleases();
    const sha = r.release("v2026.10.05");
    const text = read(r.bin);
    const stale = text.replace('"--auto", "--no-auto"]', '"--auto"]');
    expect(stale).not.toBe(text);
    writeFileSync(r.bin, stale);
    expect(r.run(["install", "--no-auto"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.05", sha, auto: false });
  });

  it("последний релиз не узнать (нет сети) — check: проверка недоступна, код 2; install и update — отказ, код 2; флоу не стоит — релиз не ищет", () => {
    const r = withReleases();
    const offline = { AI_DEV_REPO: path.join(sb.tmp, "nowhere") };
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
    const h = r.run(["check", "--hook"], { AI_DEV_REPO: path.join(sb.tmp, "nowhere") });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("in the project: check unavailable — can't find out the latest Elves release");
  });
});

/**
 * update говорит, что поменялось: агент передаёт это пользователю. Список релиза собирает та же функция, что заметки
 * GitHub Release, — из истории git того же репозитория, где теги.
 */
describe("update называет изменения каждого пропущенного релиза", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  const block = (tag: string, items: string[]) => [`${tag} — https://github.com/miroshnik/elves/releases/tag/${tag}`, ...items.map((i) => `  ${i}`)].join("\n");

  it("update копии перечисляет каждый пропущенный релиз от нового к старому: тег, ссылка и пункты — те же, что в заметках релиза", () => {
    const r = withReleases();
    r.release("v2026.10.05");
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
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 2 — tell the user what changed:\n${block("v2026.10.12", b)}\n${block("v2026.10.08", a)}\nCommit the project copy`);
    expect(u.stdout).not.toContain("только тесты");
    expect(u.stdout).not.toContain("правило из main");
  });

  it("пропущен один релиз — один блок; ничего нового — строка, что релиз уже стоял", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    const u = r.run(["update"]);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n${block("v2026.10.12", ["- feat(agents): правило A"])}\n`);
    const again = r.run(["update"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Elves v2026.10.12 was already installed — nothing changed");
  });

  it("релизов ещё нет — список коммитов флоу от стоявшего SHA до новой головы", () => {
    const r = withReleases();
    const from = r.up.repo.git("rev-parse", "HEAD");
    r.run(["install"]);
    r.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const to = r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves ${short(from)} → ${short(to)} — tell the user what changed:\n  - feat(agents): правило A (#7)\nCommit the project copy`);
    expect(u.stdout).not.toContain("только тесты");
  });

  it("установщик из клона — коммиты флоу после последнего релиза отдельным блоком «not in a release» над релизами", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    const head = r.commit(rule(r.up, "Правило B."), "feat(agents): правило B");
    const u = elves(sb, ["update"], { bin: r.up.bin, env: { AI_DEV_REPO: r.up.dir } });
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

  it("список не узнать (в манифесте нет SHA, стоявшего SHA нет в истории) — update всё равно завершается кодом 0, строка с причиной и ссылкой на релизы", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    dropSha(sb.proj);
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("Elves v2026.10.05 → v2026.10.12: changes unavailable — installed without SHA; releases: https://github.com/miroshnik/elves/releases\n");
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.12" });
    editManifest(sb.proj, { sha: "1".repeat(40) });
    const lost = r.run(["update"]);
    expect(lost.code).toBe(0);
    expect(lost.stdout).toMatch(/Elves v2026\.10\.12 → v2026\.10\.12: changes unavailable — .+; releases: https:\/\/github\.com\/miroshnik\/elves\/releases\n/);
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

  it("в main новое правило и новый скилл — отстаёт по скиллу, код 1; правило машину не задевает; клон и ~/.agents не тронуты", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("AGENTS.md");
    expect(r.stdout).toContain("+ skills/fresh/SKILL.md");
    expect(r.stdout).toContain("bunx github:miroshnik/elves update -g");
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
    expect(r.stdout).toContain("- ~/.agents/ai-dev/");
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

  // bunx песочницы отдаёт пакет bin: `bunx … github:miroshnik/elves <команда>` → `bun <bin> <команда>`
  function bunxServes(bin: string) {
    rmSync(path.join(sb.bin, "bunx"), { force: true });
    const script = `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in github:*) shift; break ;; *) shift ;; esac; done\nexec "${process.execPath}" "${bin}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "bunx"), script, { mode: 0o755 });
  }

  it("команда хука — check --hook: машина и проект одним выводом, код 0, даже когда отстаёт", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(newer.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine: behind");
    expect(r.stdout).toContain("Elves in the project: behind");
  });

  /** Имя флоу — Elves, и в адресе и команде тоже (`bunx github:miroshnik/elves …`): прежнего имени в выводе нет. */
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

  /** Машина — скиллы в ~/.agents, ветку задачи её обновление не трогает; копия проекта — трогает. */
  it("хук: флоу проекта отстал — рекомендовать обновление и спросить, ставить ли его задачу в очередь, в сессии задачи не обновлять; отстала только машина — update -g в сессии", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(newer.bin);
    const both = runHook().stdout;
    expect(both).toContain(`${PROJECT_UPDATE}: recommend it to the user and ask whether to queue its task (task new above): yes — a background executor (the github skill, «Dispatcher»); work by the current flow.`);
    expect(both).toContain(MACHINE_BEHIND);
    expect(both).not.toContain("commit the project copy");
    elves(sb, ["install"], { bin: newer.bin });
    const machine = runHook().stdout;
    expect(machine).toContain(`${MACHINE_BEHIND}, tell the user what changed (update lists it), re-read what was updated.`);
    expect(machine).not.toContain(PROJECT_UPDATE);
  });

  it("в git-репозитории без флоу вывод хука зовёт поставить его в проект; вне git-репозитория строки про проект нет", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves in the project: not installed — install it: bunx github:miroshnik/elves install --lang <project language>");
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
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n");
    bunxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("❌ .agents/ai-dev/claude/CLAUDE.md");
    expect(r.stdout).toContain("Git ignores flow files — update adds exceptions to .gitignore");
    expect(r.stdout).toContain(PROJECT_UPDATE);
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
    expect(r.stdout).not.toContain(PROJECT_UPDATE);
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
