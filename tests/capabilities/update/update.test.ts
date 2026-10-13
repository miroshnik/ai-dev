import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, aiDevPackage, copyPackage, npxPackage, npxServesPackages, REPO, sandbox, snapshot, type AiDevPackage, type Sandbox } from "../../lib/ai-dev.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// пакеты ai-dev собираются один раз на файл: base — как этот клон, newer — ai-dev ушёл вперёд
let packages: { dir: string; cleanup: () => void };
let base: AiDevPackage;
let newer: AiDevPackage;
beforeAll(() => {
  packages = tmpDir();
  base = aiDevPackage(path.join(packages.dir, "base"));
  // новое правило в AGENTS.md, новый скилл, скилл ci-wait убран
  newer = aiDevPackage(path.join(packages.dir, "newer"), {
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

// машина с `install -g --link` из клона; origin клона — upstream, куда тест коммитит новое в main
function linkedClone() {
  mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  expect(aiDev(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/ai-dev.mjs") }).code).toBe(0);
  return { up, clone };
}

describe("Копия в проекте сверяется со свежим ai-dev и обновляется им", () => {
  it("поставлено из того же ai-dev — актуально, код 0", () => {
    aiDev(sb, ["install"]);
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: up to date");
  });

  it("ai-dev ушёл вперёд — отстаёт, код 1: стоит и свежий SHA, что изменится, команда обновления; check ничего не меняет", () => {
    aiDev(sb, ["install"]);
    const before = snapshot(sb.proj);
    const r = aiDev(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`in the project: behind — installed ${short(git(REPO, "rev-parse", "HEAD"))}, latest ${short(newer.sha)}`);
    expect(r.stdout).toContain("~ .agents/ai-dev/AGENTS.md");
    expect(r.stdout).toContain("+ .agents/skills/fresh/");
    expect(r.stdout).toContain("- .agents/skills/ci-wait/");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update\n");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update — копия как у свежего пакета, его SHA в .agents/ai-dev.json, подсказка коммита chore(agents) на языке проекта; после него check — актуально", () => {
    aiDev(sb, ["install", "--lang", "ru"]);
    const r = aiDev(sb, ["update"], { bin: newer.bin });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`chore(agents): флоу ai-dev ${short(newer.sha)}`);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).toContain("Новое правило.");
    expect(existsSync(path.join(sb.proj, ".agents/skills/fresh/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(sb.proj, ".agents/skills/ci-wait"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.proj))).sha).toBe(newer.sha);
    expect(aiDev(sb, ["check"], { bin: newer.bin }).code).toBe(0);
  });

  it("старая установка без SHA — check сравнивает содержимое: совпадает — актуально, нет — отстаёт «without SHA»; update записывает SHA", () => {
    aiDev(sb, ["install"]);
    dropSha(sb.proj);
    expect(aiDev(sb, ["check"]).code).toBe(0);
    const r = aiDev(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("installed without SHA");
    expect(aiDev(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).sha).toBe(newer.sha);
  });

  it("флоу в проекте не стоит — «not installed», код 0, ничего не создаётся", () => {
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: not installed");
    expect(existsSync(path.join(sb.proj, ".agents"))).toBe(false);
  });

  /** Настройку задаёт только `install` (capability `install`): `update` идёт без терминала и флагов — из сессии агента. */
  it("update настройку сохраняет: auto true остаётся true, у установки прошлой версии без поля — false", () => {
    aiDev(sb, ["install", "--auto"]);
    expect(aiDev(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ sha: newer.sha, auto: true });
    editManifest(sb.proj, { auto: undefined });
    expect(aiDev(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).auto).toBe(false);
  });

  /**
   * Язык задаёт только `install`. Установка прошлой версии без поля — проект, который флоу вёл по-русски: `update`
   * записывает ему `ru`, и язык проекта после обновления не меняется.
   */
  it("update язык сохраняет: language ru остаётся ru, у установки прошлой версии без поля — ru", () => {
    aiDev(sb, ["install", "--lang", "ru"]);
    expect(aiDev(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ sha: newer.sha, language: "ru" });
    aiDev(sb, ["install", "--lang", "en"]);
    editManifest(sb.proj, { language: undefined });
    expect(aiDev(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).language).toBe("ru");
  });

  /** Язык — последней строкой: в начале сессии агент видит, на каком языке работать, не читая манифест. */
  it("check называет язык проекта; установка прошлой версии без поля — ru, отставанием не считается", () => {
    aiDev(sb, ["install", "--lang", "ru"]);
    expect(aiDev(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/\n {2}language: ru\n$/) });
    editManifest(sb.proj, { language: undefined });
    expect(aiDev(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: with permission\n {2}language: ru\n$/) });
  });

  /** Режим — последней строкой: в начале сессии агент видит, вести ли задачу целиком самому. */
  it("check называет режим проекта: auto true — «tasks: entirely by itself», иначе — «tasks: with permission»; поле, правленное руками, и установка без поля отставанием не считаются", () => {
    aiDev(sb, ["install"]);
    const check = (bin?: string) => aiDev(sb, ["check"], { bin });
    expect(check().stdout).toEndWith(MODE_ASK);
    editManifest(sb.proj, { auto: true });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n$/) });
    const behind = check(newer.bin);
    expect(behind.code).toBe(1);
    expect(behind.stdout).toEndWith("npx -y github:miroshnik/ai-dev update\n" + MODE_AUTO);
    editManifest(sb.proj, { auto: undefined });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: with permission\n {2}language: en\n$/) });
    expect(aiDev(sb, ["install", "-g"]).code).toBe(0);
    expect(aiDev(sb, ["check", "-g"]).stdout).not.toContain("tasks:");
  });

  /** Клон ai-dev — сам канон: сверять и обновлять в нём нечего, а режим сессии в нём знать нужно. */
  it("в клоне ai-dev check и хук называют режим, клон остаётся «not installed»: релиз не ищут, поставить флоу не зовут, update флоу в клон не ставит", () => {
    const clone = copyPackage(base, path.join(sb.tmp, "clone")).dir;
    // установщик — пакет npx, релизы недоступны: поиск релиза дал бы код 2
    const bin = npxPackage(path.join(sb.tmp, "npx/main"), base.dir, base.sha);
    const run = (...args: string[]) => aiDev(sb, args, { cwd: clone, bin, env: { AI_DEV_REPO: path.join(sb.tmp, "nowhere") } });
    const ABSENT = "ai-dev in the project: not installed — an ai-dev clone, the canon is at its root\n";
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
    expect(aiDev(sb, ["install", "--auto"], { cwd: clone }).code).toBe(0);
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_AUTO });
    const hook = run("check", "--hook");
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain(ABSENT + MODE_AUTO);
    expect(hook.stdout).not.toContain("install it");
    expect(aiDev(sb, ["update"], { cwd: clone }).code).toBe(0);
    expect(snapshot(path.join(clone, ".agents"))).toEqual({ "ai-dev.json": JSON.stringify({ auto: true, language: "en" }, null, 2) + "\n" });
  });
});

/**
 * Копия, которую игнорирует git проекта, в коммит не попадёт — чужой чекаут и облачная сессия работают без неё. Это
 * несоответствие флоу, как отставание: чинит тот же `update` (capability `install` — как).
 */
describe("Файл флоу, который игнорирует git проекта, — несоответствие: check его называет, update снимает исключением", () => {
  it("check: код 1, ❌ с путём и правилом, команда update; check ничего не меняет", () => {
    aiDev(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n");
    const before = snapshot(sb.proj);
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain("git ignores flow files");
    expect(r.stdout).toContain("  ❌ .agents/ai-dev/claude/CLAUDE.md — .gitignore:1 «CLAUDE.md»\n");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update — adds exceptions to .gitignore\n");
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update дописывает исключения, подсказка коммита включает .gitignore — её git add берёт копию и симлинки; после него check — актуально", () => {
    aiDev(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n.claude/\n");
    const u = aiDev(sb, ["update"]);
    expect(u.code).toBe(0);
    const add = /git add -A [^&\n]+/.exec(u.stdout)?.[0] ?? "";
    expect(add).toContain(".gitignore");
    execFileSync("sh", ["-c", add], { cwd: sb.proj, env: sb.env });
    const staged = git(sb.proj, "diff", "--cached", "--name-only").split("\n");
    expect(staged).toEqual(expect.arrayContaining([".gitignore", ".agents/ai-dev/claude/CLAUDE.md", ".claude/rules/ai-dev-claude.md", ".claude/skills/spec"]));
    expect(aiDev(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringContaining("in the project: up to date") });
  });

  /** Сторож от перекоррекции: свои правки .gitignore проекта в коммит флоу не уходят. */
  it("ничего не игнорируется — подсказка коммита update без .gitignore", () => {
    aiDev(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "dist/\n");
    expect(aiDev(sb, ["update"]).stdout).toContain("git add -A .agents .claude/rules .claude/skills AGENTS.md && git commit");
  });

  it("каталог флоу исключён правилом вне проекта — check: ❌ с правилом и «fix the rule», без команды update: её исключение не поможет", () => {
    aiDev(sb, ["install"]);
    writeFileSync(path.join(sb.home, ".gitconfig"), `[core]\n\texcludesFile = ${path.join(sb.home, "personal-ignore")}\n`);
    writeFileSync(path.join(sb.home, "personal-ignore"), ".claude/\n");
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ❌ .claude/ — ~/personal-ignore:1 «.claude/»: the directory is excluded outside the project");
    expect(r.stdout).toContain("fix the rule");
    expect(r.stdout).not.toContain("ai-dev update");
  });
});

/**
 * check проекта с compose-файлом зовёт скрипт task-env под bun, тот — `docker compose config`: в PATH песочницы — bun и
 * docker прогона. Плагин compose docker ищет в каталоге своей конфигурации, а HOME у песочницы свой — DOCKER_CONFIG
 * ведёт в настоящий; дочерний bun на macOS — без JIT (tests/standards/spawn-no-jit).
 */
function withTools(...tools: ("bun" | "docker")[]) {
  for (const t of tools) {
    const found = t === "bun" ? process.execPath : execFileSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim();
    symlinkSync(found, path.join(sb.bin, t));
  }
  sb.env.DOCKER_CONFIG = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
  if (process.env.BUN_JSC_useJIT) sb.env.BUN_JSC_useJIT = process.env.BUN_JSC_useJIT;
}

const composeFile = (yaml: string) => writeFileSync(path.join(sb.proj, "compose.yaml"), yaml);
const CONTAINER_NAME = "services:\n  db:\n    image: postgres\n    container_name: pg\n";
const COMPOSE_VIOLATION = "  ❌ compose.yaml: service db — container_name pg: a second task stack can't start; remove it, Compose names containers by the project\n";

describe("check проекта держит compose-файл правил изоляции стеков задач: нарушение — строка ❌ с правилом и сервисом", () => {
  it("нарушения — строки ❌ скрипта task-env, код 1 и при актуальном флоу; check ничего не меняет", () => {
    withTools("bun", "docker");
    aiDev(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const before = snapshot(sb.proj);
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("флоу отстал — строки ❌ compose-файла идут вместе со списком изменений, код 1", () => {
    withTools("bun", "docker");
    aiDev(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const r = aiDev(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: behind");
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toEndWith(MODE_ASK);
  });

  /** Без bun в PATH: начни check скрипт в проекте без compose-файла — была бы строка ○ «bun not found». */
  it("проект без compose-файла — ни строки сверх обычных, bun не запускается; чистый compose-файл — тоже ни строки; код 0", () => {
    aiDev(sb, ["install"]);
    const upToDate = /^ai-dev in the project: up to date \([^)\n]+\)\n {2}tasks: with permission\n {2}language: en\n$/;
    expect(aiDev(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(upToDate) });
    withTools("bun", "docker");
    composeFile("services:\n  db:\n    image: postgres\n    ports: ['127.0.0.1::5432']\n");
    expect(aiDev(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(upToDate) });
  });

  it("без Docker — строка ○ «not checked» с причиной, код по-прежнему 0; без bun — так же", () => {
    aiDev(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const noBun = aiDev(sb, ["check"]);
    expect(noBun.code).toBe(0);
    expect(noBun.stdout).toContain("  ○ compose.yaml: not checked — bun not found\n");
    withTools("bun");
    const noDocker = aiDev(sb, ["check"]);
    expect(noDocker.code).toBe(0);
    expect(noDocker.stdout).toContain("  ○ compose.yaml: not checked — docker not found\n");
    expect(noDocker.stdout).toEndWith(MODE_ASK);
  });
});

describe("Копия на машине (-g) сверяется и обновляется так же — вместе с хуком SessionStart", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  it("поставлено из того же ai-dev — актуально, код 0", () => {
    aiDev(sb, ["install", "-g"]);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("on the machine: up to date");
  });

  it("ai-dev ушёл вперёд (новый скилл) — отстаёт, код 1, check ничего не меняет; update -g доводит до актуального, правил на машине по-прежнему нет", () => {
    aiDev(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = aiDev(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ ~/.agents/skills/fresh/");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(aiDev(sb, ["update", "-g"], { bin: newer.bin }).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(true);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(newer.sha);
    expect(aiDev(sb, ["check", "-g"], { bin: newer.bin }).code).toBe(0);
  });

  it("поставлено прошлой версией с правилами на машине — отстаёт: в списке «- ~/.agents/ai-dev/» и «- ~/.claude/rules/ai-dev.md»; update -g убирает их, после него check — актуально", () => {
    aiDev(sb, ["install", "-g"]);
    mkdirSync(path.join(sb.home, ".agents/ai-dev"), { recursive: true });
    writeFileSync(path.join(sb.home, ".agents/ai-dev/AGENTS.md"), "старый канон\n");
    mkdirSync(path.join(sb.home, ".claude/rules"), { recursive: true });
    symlinkSync("../../.agents/ai-dev/AGENTS.md", path.join(sb.home, ".claude/rules/ai-dev.md"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("- ~/.agents/ai-dev/");
    expect(r.stdout).toContain("- ~/.claude/rules/ai-dev.md");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(lstatSync(path.join(sb.home, ".claude/rules/ai-dev.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });

  /** Хук прошлой версии — с запасным текстом по-русски: check -g сверяет хук целиком, update -g узнаёт свой по команде. */
  it("хук прошлой версии с запасным текстом по-русски — отстаёт; update -g заменяет его, а не ставит второй; после него check — актуально", () => {
    aiDev(sb, ["install", "-g"]);
    const file = path.join(sb.home, ".claude/settings.json");
    const hooks = () => JSON.parse(read(file)).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const settings = JSON.parse(read(file));
    settings.hooks.SessionStart[0].hooks[0].command = 'npx -y --loglevel=error github:miroshnik/ai-dev check --hook 2>&1 || echo "ai-dev check недоступен (код $?): работай по текущему флоу и скажи об этом"';
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ~ ~/.claude/settings.json\n");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(hooks()).toHaveLength(1);
    expect(hooks()[0].command).toContain("github:miroshnik/ai-dev check --hook");
    expect(hooks()[0].command).not.toMatch(/\p{Script=Cyrillic}/u);
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });

  it("старая установка без SHA и без хука SessionStart — отстаёт; update -g ставит хук и пишет SHA", () => {
    aiDev(sb, ["install", "-g"]);
    dropSha(sb.home);
    rmSync(path.join(sb.home, ".claude/settings.json"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("installed without SHA");
    expect(r.stdout).toContain("+ ~/.claude/settings.json");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/settings.json"))).toContain("check --hook");
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(git(REPO, "rev-parse", "HEAD"));
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });
});

// ai-dev с релизами: upstream — git-репозиторий, откуда установщик берёт теги (AI_DEV_REPO); npx песочницы отдаёт
// пакеты его коммитов — голову main по `github:miroshnik/ai-dev` и релиз по SHA тега
function withReleases() {
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const pkgs = path.join(sb.tmp, "npx");
  npxServesPackages(sb, pkgs);
  const head = () => up.repo.git("rev-parse", "HEAD");
  const serveMain = () => (rmSync(path.join(pkgs, "main"), { recursive: true, force: true }), npxPackage(path.join(pkgs, "main"), up.dir, head()));
  const bin = serveMain();
  return {
    up,
    /** коммит в main upstream: npx теперь отдаёт его */
    commit(files: Record<string, string | null>) {
      const sha = up.repo.commit(files);
      serveMain();
      return sha;
    },
    /** релиз — тег на голову main (annotated — аннотированный), npx отдаёт его пакет по SHA коммита */
    release(tag: string, { annotated = false } = {}) {
      const sha = head();
      if (annotated) up.repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "tag", "-a", "-m", tag, tag);
      else up.repo.git("tag", tag);
      npxPackage(path.join(pkgs, sha), up.dir, sha);
      return sha;
    },
    /** установщик — пакет npx из main, как его запускает `npx -y github:miroshnik/ai-dev` */
    run: (args: string[], env: Record<string, string> = {}) => aiDev(sb, args, { bin, env: { AI_DEV_REPO: up.dir, ...env } }),
  };
}

/**
 * Проекты и машина копией следуют за релизами ai-dev (теги vГГГГ.ММ.ДД), а не за main: коммит в main без релиза их
 * «отставшими» не делает. Пакет npx из main находит последний релиз и перезапускается из него — дальше и код, и
 * файлы релиза.
 */
describe("Копия следует за релизами ai-dev, а не за main", () => {
  const rule = (up: AiDevPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });

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
    expect(u.stdout).toContain("chore(agents): ai-dev flow v2026.10.12");
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

  it("релизов ещё нет — ставит голову main, как раньше, без тега", () => {
    const r = withReleases();
    const sha = r.commit(rule(r.up, "Правило из main."));
    expect(r.run(["install"]).code).toBe(0);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).toContain("Правило из main.");
    const m = JSON.parse(read(manifest(sb.proj)));
    expect(m.sha).toBe(sha);
    expect(m.tag).toBeUndefined();
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
    expect(c.stderr).toContain("in the project: check unavailable — can't find out the latest ai-dev release");
    for (const cmd of ["install", "update"]) {
      const u = r.run([cmd], offline);
      expect(u.code).toBe(2);
      expect(u.stderr).toContain("can't find out the latest ai-dev release");
    }
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("хук: последний релиз не узнать — код 0, в выводе — проверка недоступна", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    const h = r.run(["check", "--hook"], { AI_DEV_REPO: path.join(sb.tmp, "nowhere") });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("in the project: check unavailable — can't find out the latest ai-dev release");
  });
});

describe("Клон --link сверяется с origin/main, update подтягивает его, не трогая работу пользователя", () => {
  const RULE = "\nНовое правило.\n";

  it("клон на origin/main — актуально, код 0", () => {
    linkedClone();
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("в main новое правило и новый скилл — отстаёт по скиллу, код 1; правило машину не задевает; клон и ~/.agents не тронуты", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const before = snapshot(sb.home);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("AGENTS.md");
    expect(r.stdout).toContain("+ skills/fresh/SKILL.md");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update -g");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("update -g — git pull --ff-only клона и ссылки на новый скилл; после него check — актуально", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(realpathSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(realpathSync(path.join(sb.home, ".claude/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });

  it("коммиты в main без файлов флоу — актуально, код 0", () => {
    const { up } = linkedClone();
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  /** Напоминание владельцу: без релиза проекты этих правок не получат. Отставанием не считается — код тот же. */
  it("в main после последнего релиза изменения флоу — строка «not in a release» с тегом, числом и командой релиза; код 0", () => {
    const { up, clone } = linkedClone();
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE });
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    up.repo.commit({ "bin/ai-dev.mjs": read(path.join(up.dir, "bin/ai-dev.mjs")) + "// правка установщика\n" });
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not in a release: flow commits after v2026.10.05 — 2");
    expect(r.stdout).toContain(`${path.join(clone, "bin/ai-dev.mjs")} release`);
  });

  it("всё в релизе — строки «not in a release» нет; релизов ещё нет — так и сказано", () => {
    const { up } = linkedClone();
    expect(aiDev(sb, ["check", "-g"]).stdout).toContain("not in a release: no releases yet");
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    expect(aiDev(sb, ["check", "-g"]).stdout).not.toContain("not in a release");
  });

  it("старая установка без SHA — check по git; update -g пишет SHA клона", () => {
    const { up } = linkedClone();
    dropSha(sb.home);
    const sha = up.repo.commit({ "skills/est/new.md": "# Новый справочник скилла\n" });
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ skills/est/new.md");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(sha);
  });

  it("поставлено прошлой версией — симлинк ~/.agents/ai-dev на клон, пути клона в манифесте нет: check находит клон по симлинку, update -g убирает симлинк и пишет путь", () => {
    const { clone } = linkedClone();
    const m = JSON.parse(read(manifest(sb.home)));
    delete m.clone;
    writeFileSync(manifest(sb.home), JSON.stringify(m, null, 2) + "\n");
    symlinkSync(clone, path.join(sb.home, ".agents/ai-dev"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`clone ${clone}`);
    expect(r.stdout).toContain("- ~/.agents/ai-dev/");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(lstatSync(path.join(sb.home, ".agents/ai-dev"), { throwIfNoEntry: false })).toBeUndefined();
    expect(realpathSync(JSON.parse(read(manifest(sb.home))).clone)).toBe(realpathSync(clone));
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });

  it("update -g: в клоне изменения в отслеживаемых файлах — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "AGENTS.md"), "моя правка\n");
    const head = git(clone, "rev-parse", "HEAD");
    const r = aiDev(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AGENTS.md");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(read(path.join(clone, "AGENTS.md"))).toBe("моя правка\n");
  });

  it("update -g: неотслеживаемые файлы в клоне не мешают", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "notes.txt"), "мои заметки\n");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(read(path.join(clone, "notes.txt"))).toBe("мои заметки\n");
  });

  it("update -g: клон не на main — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    git(clone, "switch", "-q", "-c", "feature");
    const head = git(clone, "rev-parse", "HEAD");
    const r = aiDev(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not on main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  it("git fetch не удался (нет сети, нет remote) — проверка недоступна, код 2", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("check unavailable");
  });
});

/**
 * Хук SessionStart ставит `install -g`. Вывод хука с кодом 0 Claude Code добавляет в контекст сессии, с другим — нет,
 * поэтому код хука всегда 0, а ошибка — в выводе.
 */
describe("В начале сессии Claude Code проверка идёт сама и старт сессии не срывает", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude"), { recursive: true }));

  // команда хука из ~/.claude/settings.json — как её запускает Claude Code: через shell, в каталоге проекта
  function runHook() {
    const s = JSON.parse(read(path.join(sb.home, ".claude/settings.json")));
    const hooks: { command: string }[] = s.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const command = hooks.find((h) => h.command.includes("check --hook"))!.command;
    const r = spawnSync("sh", ["-c", command], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout };
  }

  // npx песочницы отдаёт пакет bin: `npx … github:miroshnik/ai-dev <команда>` → `node <bin> <команда>`
  function npxServes(bin: string) {
    rmSync(path.join(sb.bin, "npx"));
    const script = `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in github:*) shift; break ;; *) shift ;; esac; done\nexec node "${bin}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "npx"), script, { mode: 0o755 });
  }

  it("команда хука — check --hook: машина и проект одним выводом, код 0, даже когда отстаёт", () => {
    aiDev(sb, ["install", "-g"]);
    aiDev(sb, ["install"]);
    npxServes(newer.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-dev on the machine: behind");
    expect(r.stdout).toContain("ai-dev in the project: behind");
  });

  it("в git-репозитории без флоу вывод хука зовёт поставить его в проект; вне git-репозитория строки про проект нет", () => {
    aiDev(sb, ["install", "-g"]);
    npxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-dev in the project: not installed — install it: npx -y github:miroshnik/ai-dev install --lang <project language>");
    expect(aiDev(sb, ["check", "--hook"], { cwd: sb.tmp }).stdout).not.toContain("in the project");
  });

  it("вывод хука называет режим и язык проекта; в проекте без флоу строк режима и языка нет", () => {
    aiDev(sb, ["install", "-g"]);
    npxServes(base.bin);
    expect(runHook().stdout).not.toMatch(/tasks:|language:/);
    aiDev(sb, ["install", "--auto"]);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ai-dev in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n/);
  });

  /** Вывод check и хука — сообщение флоу агенту, а не артефакт проекта: по-английски при любом языке проекта. */
  it("check и хук называют язык и режим проекта по-английски", () => {
    aiDev(sb, ["install", "-g"]);
    npxServes(base.bin);
    aiDev(sb, ["install", "--auto", "--lang", "ru"]);
    const mode = /ai-dev in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: ru\n/;
    const check = aiDev(sb, ["check"]);
    expect(check).toMatchObject({ code: 0, stdout: expect.stringMatching(mode) });
    const hook = runHook();
    expect(hook).toMatchObject({ code: 0, stdout: expect.stringMatching(mode) });
    expect(`${check.stdout}${hook.stdout}`).not.toMatch(/\p{Script=Cyrillic}/u);
    editManifest(sb.proj, { auto: false });
    expect(aiDev(sb, ["check"]).stdout).toEndWith("  tasks: with permission\n  language: ru\n");
  });

  it("вывод хука называет игнорируемый файл флоу и что update допишет исключения в .gitignore", () => {
    aiDev(sb, ["install", "-g"]);
    aiDev(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "CLAUDE.md\n");
    npxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("❌ .agents/ai-dev/claude/CLAUDE.md");
    expect(r.stdout).toContain("Git ignores flow files — update adds exceptions to .gitignore");
    expect(r.stdout).not.toContain("Behind —");
  });

  /** Правка compose-файла — не текущая задача сессии: в начале сессии задачи ещё нет, а «одна сессия — одна задача». */
  it("вывод хука называет нарушения compose-файла и что их правка — отдельная задача проекта; без нарушений подсказки нет", () => {
    withTools("bun", "docker");
    aiDev(sb, ["install", "-g"]);
    aiDev(sb, ["install"]);
    npxServes(base.bin);
    composeFile(CONTAINER_NAME);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toContain("The compose file breaks task isolation — each ❌ line names the rule and the service (the task-env skill); fixing it is a task of its own in the project.");
    expect(r.stdout).not.toContain("Behind —");
    composeFile("services:\n  db:\n    image: postgres\n");
    expect(runHook().stdout).not.toContain("compose");
  });

  /**
   * Команду из вывода хука агент запускает в песочнице Bash: npx там не пишет свой кеш `~/.npm`, установка — в
   * `.claude/skills`. Хук идёт вне песочницы и её не видит — подсказка условная.
   */
  it("вывод хука с командой для запуска подсказывает песочницу Claude Code: кеш npm — npm_config_cache, отказ записи в .claude/ — команда в терминале владельца; без команды подсказки нет", () => {
    const hint = /In the Claude Code sandbox npx can't write its cache ~\/\.npm — prefix the command with npm_config_cache="\$TMPDIR\/npm"; [^\n]*\.claude\/[^\n]*the owner runs the command in their terminal/;
    aiDev(sb, ["install", "-g"]);
    npxServes(base.bin);
    expect(runHook().stdout).toMatch(hint);
    aiDev(sb, ["install"]);
    expect(runHook().stdout).not.toContain("sandbox");
    npxServes(newer.bin);
    expect(runHook().stdout).toMatch(hint);
  });

  it("npx недоступен — код хука 0, в выводе — что проверка недоступна", () => {
    aiDev(sb, ["install", "-g"]);
    rmSync(path.join(sb.bin, "npx"));
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-dev check unavailable");
  });

  it("check --hook: проверка недоступна — объяснение в stdout, код 0", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = aiDev(sb, ["check", "--hook"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check unavailable");
  });
});
