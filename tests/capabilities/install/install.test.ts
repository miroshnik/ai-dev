import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { BIN, elves, elvesPackage, bunxPackage, loadedAtStart, npmPackage, REPO, sandbox, snapshot, type ElvesPackage, type Sandbox } from "../../lib/elves.ts";
import { npmRegistry, type Registry } from "../../lib/registry.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SKILLS = ["ci-wait", "dashboard", "est", "github", "slot", "spec", "task-env"];
/** Версия пакета релиза, которым ставится флоу, — `2026.1015.1` у тега `v2026.10.15.1`. */
const VERSION = "2026.1015.1";

let sb: Sandbox;
let tmp: string;
let home: string;
let proj: string;
let env: Record<string, string>;

beforeEach(() => {
  sb = sandbox();
  ({ tmp, home, proj, env } = sb);
});
afterEach(() => sb.cleanup());

// пакет Elves этого клона (src), он же из npm версии VERSION (release — сам релиз, #557) и реестр npm с ней: один раз
// на файл
let packages: { dir: string; cleanup: () => void };
let src: ElvesPackage;
let release: { bin: string };
let registry: Registry;
beforeAll(async () => {
  packages = tmpDir();
  src = elvesPackage(path.join(packages.dir, "src"));
  release = { bin: npmPackage(path.join(packages.dir, "npm"), src.dir, VERSION, src.sha) };
  registry = await npmRegistry([VERSION]);
});
afterAll(() => {
  registry.stop();
  packages.cleanup();
});

function install(args: string[] = [], cwd = proj, extra: Record<string, string> = {}) {
  return elves(sb, ["install", ...args], { cwd, env: extra });
}

const read = (p: string) => readFileSync(p, "utf8");
const isLink = (p: string) => lstatSync(p).isSymbolicLink();
const gone = (p: string) => lstatSync(p, { throwIfNoEntry: false }) === undefined;

/**
 * Проект на bun со своей зависимостью — пакетом workspace по `file:`: lockfile есть, как у живого проекта, а реестр для
 * него не нужен.
 */
function bunProject(fields: Record<string, unknown> = {}) {
  writeTree(proj, {
    "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "@app/util": "file:./util" }, ...fields }, null, 2) + "\n",
    "util/package.json": JSON.stringify({ name: "@app/util", version: "1.0.0" }) + "\n",
  });
  const r = spawnSync(process.execPath, ["install"], { cwd: proj, env, encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(existsSync(path.join(proj, "bun.lock"))).toBe(true);
}

/**
 * Проект тонкий (#552): в репозитории — версия пакета `@miroshnik/elves` для харнесса, spec-скриптов и CI, манифест, шим
 * очереди и блок AGENTS.md; канон и скиллы — на машине. Обновление проекта — подъём версии, а не копия на тысячи строк.
 */
describe("В проект — тонкий флоу: версия пакета, манифест, шим slot и блок AGENTS.md, без копии флоу", () => {
  it("install в проект без флоу ставит devDependency пакета, .agents/elves.json, шим slot и блок AGENTS.md — без копии флоу", () => {
    bunProject();
    const r = elves(sb, ["install"], { bin: release.bin, env: registry.env });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`package.json, bun.lock — @miroshnik/elves ${VERSION} (bun install)`);
    const pkg = JSON.parse(read(path.join(proj, "package.json")));
    expect(pkg.devDependencies).toEqual({ "@miroshnik/elves": VERSION });
    expect(pkg.dependencies).toEqual({ "@app/util": "file:./util" });
    expect(read(path.join(proj, "bun.lock"))).toContain(`"@miroshnik/elves@${VERSION}"`);
    expect(JSON.parse(read(path.join(proj, "node_modules/@miroshnik/elves/package.json"))).version).toBe(VERSION);
    expect(JSON.parse(read(path.join(proj, ".agents/elves.json")))).toEqual({ auto: false, language: "en" });
    expect(read(path.join(proj, ".agents/slot.sh"))).toContain("elves slot --for $$");
    expect(read(path.join(proj, "AGENTS.md"))).toContain("Shared rules — `~/.agents/elves/AGENTS.md` on the machine");
    expect(readdirSync(path.join(proj, ".agents")).sort()).toEqual(["elves.json", "slot.sh"]);
    expect(gone(path.join(proj, ".claude"))).toBe(true);
  });

  /** Lockfile проекта установка не заводит: без него менеджер пакетов не запускается, команда — строкой. */
  it("без lockfile — только версия в package.json и команда установки зависимостей; lockfile не появляется", () => {
    writeTree(proj, { "package.json": JSON.stringify({ name: "app", private: true }, null, 2) + "\n" });
    const r = elves(sb, ["install"], { bin: release.bin, env: registry.env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`package.json — @miroshnik/elves ${VERSION}; no lockfile — install the dependencies: npm install`);
    expect(JSON.parse(read(path.join(proj, "package.json"))).devDependencies).toEqual({ "@miroshnik/elves": VERSION });
    expect(readdirSync(proj).sort()).toEqual([".agents", ".git", "AGENTS.md", "package.json"]);
  });

  it("менеджер пакетов не поставил пакет (нет сети) — версия в package.json, предупреждение с командой, код 0", () => {
    bunProject();
    const r = elves(sb, ["install"], { bin: release.bin, env: { npm_config_registry: "http://127.0.0.1:9/" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^!! package\.json — @miroshnik\/elves 2026\.1015\.1, but bun\.lock isn't updated: bun install — .*; run it yourself$/m);
    expect(JSON.parse(read(path.join(proj, "package.json"))).devDependencies).toEqual({ "@miroshnik/elves": VERSION });
  });

  /** Ни скриптов, ни тестов на JS — закреплять нечего; канон и скиллы проекту дают машина и блок AGENTS.md. */
  it("проект без package.json — без devDependency: манифест, шим и блок AGENTS.md", () => {
    expect(elves(sb, ["install"], { bin: release.bin }).code).toBe(0);
    expect(readdirSync(proj).sort()).toEqual([".agents", ".git", "AGENTS.md"]);
    expect(readdirSync(path.join(proj, ".agents")).sort()).toEqual(["elves.json", "slot.sh"]);
  });

  /** Клон — не релиз: версии, которую закрепить, у него нет (#558, вопрос 5). */
  it("установщик не релиз (клон) — devDependency не трогает: предупреждение с причиной", () => {
    writeTree(proj, { "package.json": JSON.stringify({ name: "app", private: true }, null, 2) + "\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("!! package.json — @miroshnik/elves isn't added: this installer isn't a release (a clone or no releases yet)");
    expect(JSON.parse(read(path.join(proj, "package.json")))).toEqual({ name: "app", private: true });
  });

  it("в AGENTS.md проекта — блок со ссылкой на канон машины: свой текст проекта на месте, повторная установка блок не дублирует", () => {
    writeFileSync(path.join(proj, "AGENTS.md"), "# Проект\n\nСвои правила.\n");
    install();
    install();
    const text = read(path.join(proj, "AGENTS.md"));
    expect(text.match(/<!-- elves:begin/g)).toHaveLength(1);
    expect(text).toContain("`~/.agents/elves/AGENTS.md`");
    expect(text).toContain("# Проект\n\nСвои правила.\n");
  });

  /** Блок прошлой версии — по-русски; маркеры begin и end у него те же: по ним установка его находит и заменяет. */
  it("блок прошлой версии по-русски в AGENTS.md проекта установка заменяет английским, а не ставит второй", () => {
    const old = [
      "<!-- ai-dev:begin — ставит `npx -y github:miroshnik/ai-dev install`, руками не править -->",
      "Общие правила — `.agents/ai-dev/AGENTS.md`: прочитай до начала работы (справочники — `.agents/ai-dev/docs/`).",
      "Скиллы — `.agents/skills/`.",
      "<!-- ai-dev:end -->",
    ].join("\n");
    writeFileSync(path.join(proj, "AGENTS.md"), `${old}\n\n# Проект\n\nСвои правила.\n`);
    install();
    install();
    const text = read(path.join(proj, "AGENTS.md"));
    expect(text.match(/<!-- elves:begin/g)).toHaveLength(1);
    const block = /^<!-- elves:begin[^]*?<!-- elves:end -->/.exec(text)?.[0] ?? "";
    expect(block).toContain("Shared rules — `~/.agents/elves/AGENTS.md`");
    expect(block).not.toMatch(/\p{Script=Cyrillic}/u);
    expect(text).toEndWith("<!-- elves:end -->\n\n# Проект\n\nСвои правила.\n");
  });

  it("без AGENTS.md в проекте — файл создаётся с одним блоком", () => {
    install();
    expect(read(path.join(proj, "AGENTS.md"))).toMatch(/^<!-- elves:begin[^]*<!-- elves:end -->\n$/);
  });

  /**
   * bunx ставит пакет в node_modules своего каталога и запускает его bin по шебангу — так же, как `bun add` пакета из
   * `bun pm pack`: только файлы из `files`, TypeScript в node_modules Bun стирает сам. Кеш bun — свой, в песочнице.
   */
  it("через bunx из пакета Elves: bin из node_modules под Bun ставит тонкий флоу", () => {
    const bunEnv = { ...env, BUN_INSTALL_CACHE_DIR: path.join(tmp, "bun-cache") };
    const pack = spawnSync(process.execPath, ["pm", "pack", "--destination", tmp, "--quiet"], { cwd: REPO, env: bunEnv, encoding: "utf8" });
    expect(pack.status).toBe(0);
    const tgz = pack.stdout.trim().split("\n").pop()!;
    const bunx = path.join(tmp, "bunx");
    writeTree(bunx, { "package.json": "{}\n" });
    expect(spawnSync(process.execPath, ["add", "--silent", tgz], { cwd: bunx, env: bunEnv, encoding: "utf8" }).status).toBe(0);
    const r = spawnSync(path.join(bunx, "node_modules/.bin/elves"), ["install"], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(read(path.join(proj, ".agents/elves.json")))).toEqual({ auto: false, language: "en" });
    expect(read(path.join(proj, ".agents/slot.sh"))).toContain("elves slot --for $$");
    expect(read(path.join(proj, "AGENTS.md"))).toContain("`~/.agents/elves/AGENTS.md`");
  });

  it("корень установки — корень git-репозитория, даже при запуске из подкаталога", () => {
    mkdirSync(path.join(proj, "src/app"), { recursive: true });
    expect(install([], path.join(proj, "src/app")).code).toBe(0);
    expect(existsSync(path.join(proj, ".agents/elves.json"))).toBe(true);
    expect(existsSync(path.join(proj, "src/app/.agents"))).toBe(false);
  });
});

/**
 * Песочница агента не пускает запись в `.claude/skills` (Seatbelt у Claude Code — EPERM): установка на машину
 * обрывается на симлинках, когда копии в `~/.agents/skills` уже легли. Тест закрывает каталог правами — отказ тот же
 * по сути (EACCES).
 */
describe("Отказ в записи посреди установки — понятная строка вместо стека, повтор доводит установку", () => {
  const skillsDir = () => path.join(home, ".claude/skills");
  const lock = () => (mkdirSync(skillsDir(), { recursive: true }), chmodSync(skillsDir(), 0o555));
  // машина с Claude Code: симлинки скиллов ставятся в ~/.claude/skills
  beforeEach(() => mkdirSync(path.join(home, ".claude"), { recursive: true }));
  // каталог без права записи не удалить — права возвращаются до уборки песочницы
  afterEach(() => existsSync(skillsDir()) && chmodSync(skillsDir(), 0o755));

  it("нет права писать в ~/.claude/skills — install -g: код 2, строка с путём и командой для своего терминала, без стека", () => {
    lock();
    const r = install(["-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("~/.claude/skills/ci-wait");
    expect(r.stderr).toContain("bunx github:miroshnik/elves install -g");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("повтор после отказа на ~/.claude/skills доводит установку: скиллы признаны своими, симлинки на месте, предупреждения «isn't an Elves skill» нет", () => {
    lock();
    install(["-g"]);
    chmodSync(skillsDir(), 0o755);
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("isn't an Elves skill");
    for (const s of SKILLS) expect(readlinkSync(path.join(skillsDir(), s))).toBe(`../../.agents/skills/${s}`);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).skills).toEqual(SKILLS);
  });

  it("update -g: нет права писать в ~/.claude/skills — код 2, та же строка с командой update -g", () => {
    install(["-g"]);
    rmSync(path.join(skillsDir(), "spec"));
    chmodSync(skillsDir(), 0o555);
    const r = elves(sb, ["update", "-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("~/.claude/skills/spec");
    expect(r.stderr).toContain("bunx github:miroshnik/elves update -g");
  });

  it("симлинк, который уже ведёт куда надо, установка не пересоздаёт: ~/.claude/skills без права записи не мешает повтору без нового скилла", () => {
    install(["-g"]);
    chmodSync(skillsDir(), 0o555);
    expect(install(["-g"]).code).toBe(0);
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
  });
});

/**
 * Файлы тонкого проекта коммитятся: без шима `.agents/slot.sh` в коммите скрипт package.json в CI и чужом чекауте падает
 * на `. .agents/slot.sh`, без манифеста облачная сессия не знает режима и языка (#558, вопрос 4). Исключение действует,
 * только если идёт после игнорирующего правила, — поэтому блок Elves в конце `.gitignore`.
 */
describe("Файлы флоу не игнорируются git проекта — иначе их нет в коммите, чужом чекауте и CI", () => {
  const gitignore = () => read(path.join(proj, ".gitignore"));
  // игнорируемые git файлы проекта — по одному, и внутри игнорируемых каталогов
  const ignored = () => execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], { cwd: proj, env, encoding: "utf8" }).split("\n").filter(Boolean).sort();

  it(".agents/ в .gitignore проекта — install дописывает в конец .gitignore блок Elves: манифест и шим не игнорируются, своё в .agents — как прежде, свои строки на месте, повтор блок не дублирует", () => {
    writeTree(proj, { ".gitignore": "node_modules/\n.agents/\n", ".agents/notes.md": "мои заметки\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".gitignore");
    expect(ignored()).toEqual([".agents/notes.md"]);
    const text = gitignore();
    expect(text).toStartWith("node_modules/\n.agents/\n");
    expect(text).toContain("\n!/.agents/elves.json\n!/.agents/slot.sh\n");
    expect(text).toMatch(/\n# elves:begin[^\n]*\n[^]*\n# elves:end\n$/);
    install();
    expect(gitignore()).toBe(text);
  });

  /** Шаблоны, которые прятали файлы копии (`CLAUDE.md`, `.claude/`), тонкому проекту безразличны: его файлы — не там. */
  it("шаблоны CLAUDE.md и .claude/ тонкому проекту не мешают — исключений нет, .gitignore не меняется", () => {
    writeTree(proj, { ".gitignore": "CLAUDE.md\n.claude/\nvendor/\n" });
    expect(install().code).toBe(0);
    expect(gitignore()).toBe("CLAUDE.md\n.claude/\nvendor/\n");
    expect(ignored()).toEqual([]);
  });

  /** Шапка блока прошлой версии — по-русски; маркеры begin и end у него те же: по ним установка его находит. */
  it("блок исключений копии прошлой версии с шапкой по-русски установка убирает — файлам тонкого проекта исключения не нужны", () => {
    const old = ["# ai-dev:begin — файлы флоу, которые иначе игнорирует git; ставит `npx -y github:miroshnik/ai-dev install`, руками не править", "!/.agents/ai-dev/claude/CLAUDE.md", "# ai-dev:end"].join("\n");
    writeTree(proj, { ".gitignore": `node_modules/\nCLAUDE.md\n\n${old}\n` });
    expect(install().code).toBe(0);
    expect(gitignore()).toBe("node_modules/\nCLAUDE.md\n");
  });

  it("ничего не игнорируется — .gitignore не создаётся и не меняется; ставший ненужным блок убирается", () => {
    install();
    expect(existsSync(path.join(proj, ".gitignore"))).toBe(false);
    writeFileSync(path.join(proj, ".gitignore"), "dist");
    install();
    expect(gitignore()).toBe("dist");
    writeFileSync(path.join(proj, ".gitignore"), "dist\n.agents/\n");
    install();
    expect(gitignore()).toContain("# elves:begin");
    writeFileSync(path.join(proj, ".gitignore"), gitignore().replace("dist\n.agents/\n", "dist\n"));
    install();
    expect(gitignore()).toBe("dist\n");
  });

  /**
   * Личные правила (core.excludesFile, `.git/info/exclude`) — не проекта. Исключение файла безвредно для всех, а
   * исключение каталога с `/<каталог>/*` спрятало бы остальное в нём у тех, у кого такого правила нет.
   */
  it("шаблон файла вне проекта (core.excludesFile) снимается исключением в .gitignore проекта; каталог, исключённый вне проекта, — ❌ с правилом, исключений на него в .gitignore проекта нет", () => {
    writeTree(home, { ".config/git/ignore": "slot.sh\n" });
    expect(install().code).toBe(0);
    expect(gitignore()).toContain("\n!/.agents/slot.sh\n");
    rmSync(path.join(proj, ".gitignore"));
    writeTree(home, { ".config/git/ignore": ".agents/\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(proj, ".gitignore"))).toBe(false);
    expect(r.stderr).toContain("❌ .agents/ — ");
    expect(r.stderr).toContain(".config/git/ignore:1 «.agents/»");
    expect(ignored()).toEqual([".agents/elves.json", ".agents/slot.sh"]);
  });
});

/**
 * Тяжёлые проверки проекта идут очередью машины (capability `slot`). Обёртка — в самих скриптах `package.json`: их
 * зовёт любой — Claude, Codex, человек в терминале. `build` не оборачивается — его запускают хостинг и Docker, где
 * шима или пакета может не быть; watch — долгий, занял бы слот надолго.
 */
describe("Проверки проекта идут очередью машины: install оборачивает их скрипты package.json в шим slot", () => {
  const SCRIPTS = {
    build: "next build",
    dev: "next dev",
    lint: "eslint .",
    typecheck: "tsc --noEmit && tsc -p tsconfig.test.json --noEmit",
    test: "vitest run",
    "test:e2e": "playwright test",
    "test:watch": "vitest",
  };
  const pkgFile = () => path.join(proj, "package.json");
  const scripts = () => JSON.parse(read(pkgFile())).scripts;
  const slot = (cmd: string) => `. .agents/slot.sh && ${cmd}`;
  /** Обёртка копии флоу прошлых установок: её slot.sh. */
  const copySlot = (cmd: string) => `. .agents/skills/slot/scripts/slot.sh && ${cmd}`;
  /** Обёртка ещё раньше: команда — строкой-аргументом slot.ts копии. */
  const slotString = (cmd: string, runtime = "bun --no-env-file") => `${runtime} .agents/skills/slot/scripts/slot.ts '${cmd}'`;
  /** elves песочницы — bin этого клона: шим зовёт `elves slot` из PATH, как из node_modules/.bin проекта. */
  const elvesOnPath = () => symlinkSync(BIN, path.join(sb.bin, "elves"));

  it("установка оборачивает lint, typecheck, test и test:* в slot, build и watch — нет", () => {
    writeTree(proj, { "package.json": JSON.stringify({ name: "app", scripts: SCRIPTS }, null, 2) + "\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("package.json");
    expect(scripts()).toEqual({
      ...SCRIPTS,
      lint: slot("eslint ."),
      typecheck: slot(SCRIPTS.typecheck),
      test: slot("vitest run"),
      "test:e2e": slot("playwright test"),
    });
  });

  /**
   * Шим зовёт `elves slot` пакета проекта, в `if command -v elves`: без elves на PATH (CI до установки
   * зависимостей, чекаут без пакета) команда идёт как есть, сбой elves роняет скрипт его кодом — проверено в #552.
   */
  it("скрипты package.json тонкого проекта идут через шим slot: с elves на PATH — в слоте машины, без elves — как есть, сбой elves роняет скрипт с его кодом", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { test: 'echo "slot=[$ELVES_SLOT_CPUS]"' } }) });
    install();
    const run = () => spawnSync("sh", ["-c", scripts().test], { cwd: proj, env, encoding: "utf8" });
    expect(run()).toMatchObject({ status: 0, stdout: "slot=[]\n" });
    elvesOnPath();
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringMatching(/^slot=\[[1-9]\d*\]\n$/) });
    rmSync(path.join(sb.bin, "elves"));
    writeFileSync(path.join(sb.bin, "elves"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    expect(run()).toMatchObject({ status: 3, stdout: "" });
  });

  /** npm и bun дописывают аргументы к скрипту в конец его строки: `npm test -- <файл>` — так же и с обёрткой. */
  it("обёрнутый скрипт идёт как прежде: кавычки команды на месте, аргументы — в её конце", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { test: `printf '%s|' "it's"` } }) });
    install();
    elvesOnPath();
    const r = spawnSync("sh", ["-c", `${scripts().test} 'a b'`], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("it's|a b|");
  });

  /**
   * Bun сам подгружает env-файлы рабочего каталога: прод-ключи `.env.local` не должны дойти через slot до раннера
   * тестов, который без обёртки их не видел (tests/standards/no-env-file). Окружение песочницы — без `CI`: команда идёт
   * через слот, очередь — в её домашнем каталоге.
   */
  it("команда под slot не видит ключей env-файлов рабочего каталога", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { test: `echo "[$ELVES_DOTENV|$ELVES_DOTENV_LOCAL|\${ELVES_SLOT_CPUS:+slot}]"` } }),
      ".env": "ELVES_DOTENV=dotenv\n",
      ".env.local": "ELVES_DOTENV_LOCAL=prod-key\n",
    });
    install();
    elvesOnPath();
    const r = spawnSync("sh", ["-c", scripts().test], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("[||slot]\n");
  });

  it("повторная установка не оборачивает дважды, отступ и конец package.json — как были", () => {
    writeTree(proj, { "package.json": `{\n\t"name": "app",\n\t"scripts": {\n\t\t"test": "vitest run"\n\t}\n}` });
    install();
    const once = read(pkgFile());
    expect(once).toBe(`{\n\t"name": "app",\n\t"scripts": {\n\t\t"test": "${slot("vitest run")}"\n\t}\n}`);
    install();
    expect(read(pkgFile())).toBe(once);
  });

  /**
   * Копия флоу подключала свой slot.sh; ещё раньше установки передавали команду slot.ts строкой — через node в проекте на
   * Node, через bun без отключения env-файлов, через bun с ним: knip такую команду не видит.
   */
  it("обёртка прошлой установки — slot.sh копии или команда строкой у slot.ts через node или bun — переписывается, команда та же", () => {
    const quoted = `printf '%s' "it's"`;
    writeTree(proj, {
      "package.json": JSON.stringify({
        scripts: { test: slotString("vitest run", "node"), lint: slotString("eslint .", "bun"), typecheck: slotString(quoted.replaceAll("'", "'\\''")), "test:e2e": copySlot("playwright test") },
      }),
    });
    install();
    expect(scripts()).toEqual({ test: slot("vitest run"), lint: slot("eslint ."), typecheck: slot(quoted), "test:e2e": slot("playwright test") });
  });

  /**
   * Скрипты spec копии флоу шли по её пути (`bun .agents/skills/spec/scripts/<скрипт>.ts`), репортёр knip для `report`
   * харнесса — тоже; в тонком проекте их даёт пакет: `elves <скрипт>` из node_modules/.bin, репортёр — файлом пакета.
   */
  it("скрипты копии флоу — bun .agents/skills/spec/scripts/<скрипт>.ts — переписываются на elves <скрипт>, репортёр knip — на файл пакета", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({
        scripts: {
          "spec:doc": "bun --no-env-file .agents/skills/spec/scripts/spec-doc.ts .spec-report.xml --strict",
          "spec:claims": "bun .agents/skills/spec/scripts/spec-claims.ts --entries tests/entries.ts",
          "test:spec": copySlot("bun test tests/standards && bun --no-env-file ./.agents/skills/spec/scripts/spec-diff.ts --base origin/main"),
          knip: "knip --reporter json --reporter .agents/skills/spec/scripts/knip-hints.cjs > .knip.json",
        },
      }),
    });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("package.json — the flow copy's scripts through the package (elves <script>): spec:doc, spec:claims, test:spec, knip");
    expect(scripts()).toEqual({
      "spec:doc": "elves spec-doc .spec-report.xml --strict",
      "spec:claims": "elves spec-claims --entries tests/entries.ts",
      "test:spec": slot("bun test tests/standards && elves spec-diff --base origin/main"),
      knip: "knip --reporter json --reporter node_modules/@miroshnik/elves/skills/spec/scripts/knip-hints.cjs > .knip.json",
    });
  });

  /**
   * Yarn 2+ выполняет скрипты своим shell (`@yarnpkg/shell`): в нём нет `.`, `eval` и `export`, и подключить шим нечем.
   * Там команда остаётся строкой у `elves slot` — knip её не видит, но проверки идут очередью.
   */
  it("в проекте на Yarn 2+ команда остаётся строкой у elves slot: shell Yarn не подключает шим", () => {
    const yarnSlot = (cmd: string) => `elves slot '${cmd}'`;
    const markers: [Record<string, string>, string?][] = [[{ ".yarnrc.yml": "nodeLinker: node-modules\n" }], [{}, "yarn@4.9.1"]];
    for (const [files, packageManager] of markers) {
      rmSync(path.join(proj, ".yarnrc.yml"), { force: true });
      writeTree(proj, { ...files, "package.json": JSON.stringify({ packageManager, scripts: { test: "vitest run", lint: slot("eslint ."), typecheck: slotString("tsc") } }) });
      install();
      expect(scripts()).toEqual({ test: yarnSlot("vitest run"), lint: yarnSlot("eslint ."), typecheck: yarnSlot("tsc") });
      expect(elves(sb, ["check"]).code).toBe(0);
    }
    writeTree(proj, { "package.json": JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { test: "vitest run" } }) });
    install();
    expect(scripts()).toEqual({ test: slot("vitest run") });
  });

  it("check называет обёртку прошлой установки несоответствием, update переписывает её", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }) });
    install();
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: scripts().lint, test: slotString("vitest run") } }) });
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/~ package\.json — [^\n]*previous install — knip doesn't see the command[^\n]*\btest\b/);
    expect(c.stdout).not.toMatch(/~ package\.json — [^\n]*\blint\b/);
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(scripts()).toEqual({ lint: slot("eslint ."), test: slot("vitest run") });
    expect(elves(sb, ["check"]).code).toBe(0);
  });

  /**
   * knip разбирает скрипты package.json: по скрипту `bun test` плагин Bun берёт входами файлы тестов и `preload` из
   * bunfig.toml, по бинарнику команды зависимость считается использованной. Команду строкой-аргументом knip не видел —
   * deadCode проекта краснел от установки флоу, а не от кода. knip — настоящий, из devDependencies Elves, под node.
   */
  it("после установки флоу knip видит команды обёрнутых скриптов: тесты bun test и preload — входы, бинарник команды — использованная зависимость", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ name: "app", private: true, type: "module", scripts: { lint: "eslint .", test: "bun test" }, devDependencies: { eslint: "^10.0.0", knip: "^6.41.0" } }),
      "bunfig.toml": '[test]\npreload = ["./tests/lib/setup.ts"]\n',
      "knip.json": JSON.stringify({ project: ["src/**/*.ts", "tests/**/*.ts"] }),
      "src/index.ts": "export const sum = (a: number, b: number): number => a + b;\n",
      "tests/sum.test.ts": 'import { expect, it } from "bun:test";\nimport { sum } from "../src/index.ts";\n\nit("сумма", () => expect(sum(1, 2)).toBe(3));\n',
      "tests/lib/setup.ts": 'process.env.TZ = "UTC";\n',
      "node_modules/eslint/package.json": JSON.stringify({ name: "eslint", version: "10.0.0", bin: { eslint: "bin/eslint.js" } }),
      "node_modules/eslint/bin/eslint.js": "",
    });
    symlinkSync(path.join(REPO, "node_modules/knip"), path.join(proj, "node_modules/knip"));
    symlinkSync(execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim(), path.join(sb.bin, "node"));
    expect(install().code).toBe(0);
    expect(scripts()).toMatchObject({ lint: slot("eslint ."), test: slot("bun test") });
    const knip = spawnSync("node", ["node_modules/knip/bin/knip.js", "--no-progress"], { cwd: proj, env, encoding: "utf8" });
    expect({ code: knip.status, out: knip.stdout + knip.stderr }).toEqual({ code: 0, out: "" });
  });

  it("check называет скрипт без slot несоответствием, update оборачивает и зовёт закоммитить package.json", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }) });
    install();
    expect(elves(sb, ["check"]).code).toBe(0);
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: scripts().lint, test: "vitest run" } }) });
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/~ package\.json — [^\n]*\btest\b/);
    expect(c.stdout).not.toMatch(/~ package\.json — [^\n]*\blint\b/);
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(scripts().test).toBe(slot("vitest run"));
    expect(u.stdout).toMatch(/\n {2}git add -A -- package\.json [^\n]*&& git commit/);
    expect(elves(sb, ["check"]).code).toBe(0);
  });


  /**
   * turbo 2 в strict env mode пропускает задачам только переменные, названные в turbo.json: без проброса раннер не
   * видит `ELVES_SLOT_CPUS` и берёт машину целиком, а вложенный скрипт в slot — `ELVES_SLOT` и ждёт собственный
   * слот. `globalPassThroughEnv`, а не `globalEnv`: в хэш кэша они не входят, а `ELVES_SLOT` у каждого прогона свой.
   * turbo.json правит владелец проекта (в нём бывают комментарии — JSONC), поэтому install и check только
   * предупреждают; отставанием флоу это не считается.
   */
  it("скрипт в slot зовёт turbo без проброса переменных очереди — install и check предупреждают готовой строкой для turbo.json, отставанием это не считается", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "turbo run test --filter=web" } }),
      "turbo.json": `{\n  // кэш\n  "globalPassThroughEnv": ["SENTRY_*", "ELVES_SLOT_CPUS",],\n  "tasks": { "test": {} }\n}\n`,
    });
    const ready = `"globalPassThroughEnv": ["SENTRY_*", "ELVES_SLOT_CPUS", "ELVES_SLOT"]`;
    const i = install();
    expect(i.code).toBe(0);
    expect(i.stderr).toContain(`!! turbo.json — ELVES_SLOT doesn't reach the runner`);
    expect(i.stderr).toContain(ready);
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/up to date[^\n]*\n {2}! turbo\.json — ELVES_SLOT doesn't reach the runner: turbo in strict env mode/);
    expect(c.stdout).toContain(ready);
    expect(elves(sb, ["check", "--hook"]).stdout).toContain(ready);
  });

  it("предупреждения нет, если переменные очереди доходят до задач turbo — globalPassThroughEnv или globalEnv с масками, envMode loose, --env-mode=loose — или turbo зовёт скрипт вне очереди", () => {
    const warning = (scripts: Record<string, string>, turbo: string, file = "turbo.json") => {
      for (const f of ["turbo.json", "turbo.jsonc"]) rmSync(path.join(proj, f), { force: true });
      writeTree(proj, { "package.json": JSON.stringify({ scripts }), [file]: turbo });
      return /^!! turbo\.jsonc? — .*$/m.exec(install().stderr)?.[0] ?? null;
    };
    const test = { test: "npx turbo test" };
    expect(warning(test, `{ "tasks": {} }`)).toContain(`"globalPassThroughEnv": ["ELVES_SLOT", "ELVES_SLOT_CPUS"]`);
    expect(warning(test, `{ "globalPassThroughEnv": ["ELVES_SLOT", "ELVES_SLOT_CPUS"] }`)).toBeNull();
    expect(warning(test, `{ "globalEnv": ["ELVES_*"] }`)).toBeNull();
    expect(warning(test, `{ "globalPassThroughEnv": ["ELVES_*", "!ELVES_SLOT"] }`)).toContain(`"globalPassThroughEnv": ["ELVES_*", "ELVES_SLOT"]`);
    expect(warning(test, `{ "envMode": "loose" }`)).toBeNull();
    expect(warning({ test: "turbo run test --env-mode=loose" }, `{}`)).toBeNull();
    expect(warning({ test: "vitest run --turbo" }, `{}`)).toBeNull();
    expect(warning({ build: "turbo run build" }, `{}`)).toBeNull();
    expect(warning(test, `{ /* JSONC */ "tasks": {}, }`, "turbo.jsonc")).toMatch(/^!! turbo\.jsonc — /);
    expect(warning(test, `{ /* JSONC */ "globalPassThroughEnv": ["ELVES_SLOT", "ELVES_SLOT_CPUS"] }`, "turbo.jsonc")).toBeNull();
  });

  /**
   * До переименования флоу (#545) переменные очереди назывались AI_DEV_SLOT и AI_DEV_SLOT_CPUS: slot пока экспортирует
   * и их, поэтому turbo.json с прежними именами работает, но конфиг раннера, переведённый на новое имя, его не получит.
   * Готовая строка добавляет новые имена и оставляет прежние — их ещё читают конфиги раннеров проекта.
   */
  it("turbo.json пропускает переменные очереди только под прежними именами флоу — install и check называют их и строку с новыми", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { test: "turbo run test" } }),
      "turbo.json": `{ "globalPassThroughEnv": ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"] }\n`,
    });
    const line = `! turbo.json — turbo.json passes the queue variables only under the flow's former names AI_DEV_SLOT, AI_DEV_SLOT_CPUS — runner configs and nested scripts in slot that read ELVES_SLOT, ELVES_SLOT_CPUS don't get them — put at its root "globalPassThroughEnv": ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS", "ELVES_SLOT", "ELVES_SLOT_CPUS"]`;
    expect(install().stderr).toContain(`!${line}\n`);
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain(`  ${line}\n`);
  });
});

/**
 * В тонком проекте копии канона нет (#557): агент получает его с машины. Claude Code грузит `~/.claude/rules` без
 * диалога внешних импортов и во всех проектах машины, другие агенты — свой глобальный файл правил. До #180 так и было;
 * #180 убрал правила с машины только из-за второй копии в проекте.
 */
describe("На машину (-g) — канон, скиллы и хук: тонкий проект берёт канон с машины", () => {
  const canon = () => realpathSync(path.join(home, ".agents/elves/AGENTS.md"));

  it("скилл, которого больше нет в Elves, при переустановке удаляется; свой скилл на машине не трогается", () => {
    mkdirSync(path.join(home, ".claude"));
    install(["-g"]);
    const manifest = path.join(home, ".agents/elves.json");
    const m = JSON.parse(read(manifest));
    writeFileSync(manifest, JSON.stringify({ ...m, skills: [...m.skills, "old"] }));
    writeTree(home, { ".agents/skills/old/SKILL.md": "old", ".agents/skills/mine/SKILL.md": "mine" });
    symlinkSync("../../.agents/skills/old", path.join(home, ".claude/skills/old"));
    install(["-g"]);
    expect(existsSync(path.join(home, ".agents/skills/old"))).toBe(false);
    expect(existsSync(path.join(home, ".claude/skills/old"))).toBe(false);
    expect(read(path.join(home, ".agents/skills/mine/SKILL.md"))).toBe("mine");
  });

  it("чужой каталог с именем скилла Elves не перезаписывается — предупреждение", () => {
    writeTree(home, { ".agents/skills/spec/SKILL.md": "свой spec" });
    const r = install(["-g"]);
    expect(read(path.join(home, ".agents/skills/spec/SKILL.md"))).toBe("свой spec");
    expect(r.stderr).toContain(".agents/skills/spec");
  });

  it("в ~/.agents/elves.json — SHA Elves, из которого поставлено: у клона — его HEAD", () => {
    install(["-g"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).sha).toBe(head);
  });

  /**
   * bunx ставит пакет из GitHub архивом, без `.git`, и в `.bun-tag` оставляет лишь 7 знаков SHA: полный коммит виден
   * только в спецификаторе, по которому поставлено, — `package.json` каталога bunx рядом с node_modules.
   */
  it("из пакета bunx — SHA из спецификатора в package.json каталога bunx", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const bin = bunxPackage(path.join(tmp, "bunx"), src.dir, sha);
    expect(elves(sb, ["install", "-g"], { bin }).code).toBe(0);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).sha).toBe(sha);
  });

  /**
   * Пакет называется `@miroshnik/elves` (#556): bun кладёт зависимость по имени пакета — в `node_modules/@miroshnik/elves`,
   * спецификатор — под полным именем. Не узнай установщик SHA, пакет релиза счёл бы себя пускателем из main и
   * перезапускался бы снова и снова.
   */
  it("из пакета под scope @miroshnik — SHA из спецификатора под полным именем пакета", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const bin = bunxPackage(path.join(tmp, "bunx"), src.dir, sha, "@miroshnik/elves");
    expect(elves(sb, ["install", "-g"], { bin }).code).toBe(0);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).sha).toBe(sha);
  });

  it("install -g ставит канон в ~/.agents/elves и симлинки ~/.claude/rules/elves*.md", () => {
    mkdirSync(path.join(home, ".claude"));
    expect(install(["-g"]).code).toBe(0);
    expect(read(path.join(home, ".agents/elves/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(read(path.join(home, ".agents/elves/claude/CLAUDE.md"))).toBe(read(path.join(REPO, "claude/CLAUDE.md")));
    expect(existsSync(path.join(home, ".agents/elves/docs/ci-concurrency.md"))).toBe(true);
    expect(isLink(path.join(home, ".agents/elves"))).toBe(false);
    expect(readlinkSync(path.join(home, ".claude/rules/elves.md"))).toBe("../../.agents/elves/AGENTS.md");
    expect(readlinkSync(path.join(home, ".claude/rules/elves-claude.md"))).toBe("../../.agents/elves/claude/CLAUDE.md");
    expect(isLink(path.join(home, ".agents/skills/spec"))).toBe(false);
    expect(readlinkSync(path.join(home, ".claude/skills/spec"))).toBe("../../.agents/skills/spec");
    expect(read(path.join(home, ".claude/settings.json"))).toContain("check --hook");
    // агентов, которых на машине нет, установка не заводит
    for (const p of [".agents/ai-dev", ".codex", ".gemini", ".copilot", ".config/opencode", ".config/amp"]) expect(gone(path.join(home, p))).toBe(true);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("install -g ставит файлы правил Codex, Gemini CLI, Copilot, OpenCode и Amp ссылкой на канон машины, а чужой файл не трогает", () => {
    for (const dir of [".codex", ".copilot", ".config/opencode", ".config/amp"]) mkdirSync(path.join(home, dir), { recursive: true });
    writeTree(home, { ".gemini/GEMINI.md": "мои правила\n" });
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    for (const file of [".codex/AGENTS.md", ".copilot/copilot-instructions.md", ".config/opencode/AGENTS.md", ".config/amp/AGENTS.md"]) {
      expect(isLink(path.join(home, file))).toBe(true);
      expect(realpathSync(path.join(home, file))).toBe(canon());
    }
    expect(isLink(path.join(home, ".gemini/GEMINI.md"))).toBe(false);
    expect(read(path.join(home, ".gemini/GEMINI.md"))).toBe("мои правила\n");
    expect(r.stdout).toContain("~/.gemini/GEMINI.md — the user's own rules: left as is; the canon — ~/.agents/elves/AGENTS.md\n");
    expect(install(["-g"]).code).toBe(0);
    expect(read(path.join(home, ".gemini/GEMINI.md"))).toBe("мои правила\n");
  });

  it("правила прошлой установки под прежним именем — ~/.agents/ai-dev, симлинки ~/.claude/rules/ai-dev*.md и файлов агентов на него — install -g переносит на новые имена; свой файл правил агента остаётся", () => {
    writeTree(home, { ".agents/ai-dev/AGENTS.md": "старый канон\n", ".agents/ai-dev/claude/CLAUDE.md": "старый\n", ".gemini/GEMINI.md": "мои правила\n" });
    mkdirSync(path.join(home, ".claude/rules"), { recursive: true });
    symlinkSync("../../.agents/ai-dev/AGENTS.md", path.join(home, ".claude/rules/ai-dev.md"));
    symlinkSync("../../.agents/ai-dev/claude/CLAUDE.md", path.join(home, ".claude/rules/ai-dev-claude.md"));
    mkdirSync(path.join(home, ".codex"));
    symlinkSync("../.agents/ai-dev/AGENTS.md", path.join(home, ".codex/AGENTS.md"));
    expect(install(["-g"]).code).toBe(0);
    for (const p of [".agents/ai-dev", ".claude/rules/ai-dev.md", ".claude/rules/ai-dev-claude.md"]) expect(gone(path.join(home, p))).toBe(true);
    expect(read(path.join(home, ".claude/rules/elves.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(read(path.join(home, ".claude/rules/elves-claude.md"))).toBe(read(path.join(REPO, "claude/CLAUDE.md")));
    expect(readlinkSync(path.join(home, ".codex/AGENTS.md"))).toBe("../.agents/elves/AGENTS.md");
    expect(read(path.join(home, ".gemini/GEMINI.md"))).toBe("мои правила\n");
    expect(read(path.join(home, ".agents/elves.json"))).toContain('"skills"');
  });

  /**
   * Setup script окружения claude.ai ставит флоу до запуска Claude Code (#555): под root в свежем HOME, без терминала,
   * с `CLAUDE_CODE_REMOTE=true`. `~/.claude` там может ещё не быть, а Claude Code будет; `~/.claude/settings.json`
   * облако не читает — хука там нет.
   */
  it("install -g без терминала в пустом HOME ставит канон и скиллы — как setup script облачного окружения", () => {
    const r = install(["-g"], proj, { CLAUDE_CODE_REMOTE: "true" });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(realpathSync(path.join(home, ".claude/rules/elves.md"))).toBe(canon());
    expect(read(path.join(home, ".claude/rules/elves-claude.md"))).toBe(read(path.join(REPO, "claude/CLAUDE.md")));
    for (const s of SKILLS) {
      expect(read(path.join(home, ".agents/skills", s, "SKILL.md"))).toBe(read(path.join(REPO, "skills", s, "SKILL.md")));
      expect(readlinkSync(path.join(home, ".claude/skills", s))).toBe(`../../.agents/skills/${s}`);
    }
    expect(existsSync(path.join(home, ".claude/settings.json"))).toBe(false);
    expect(elves(sb, ["check", "-g"], { env: { CLAUDE_CODE_REMOTE: "true" } }).code).toBe(0);
  });

  it("старый симлинк install.sh ~/.claude/CLAUDE.md → claude/CLAUDE.md убирается — правила не грузятся дважды", () => {
    mkdirSync(path.join(home, ".claude"));
    symlinkSync(path.join(REPO, "claude/CLAUDE.md"), path.join(home, ".claude/CLAUDE.md"));
    install(["-g"]);
    expect(existsSync(path.join(home, ".claude/CLAUDE.md"))).toBe(false);
  });

  it("свой ~/.claude/CLAUDE.md пользователя остаётся", () => {
    writeTree(home, { ".claude/CLAUDE.md": "мои заметки\n" });
    install(["-g"]);
    expect(read(path.join(home, ".claude/CLAUDE.md"))).toBe("мои заметки\n");
  });

  // клон — копия пакета в песочнице: установка --link правит origin клона (переименование #544), настоящий не трогаем
  it("--link из клона — канон и скиллы машины — симлинки на клон, правка в клоне видна сразу; путь клона — в ~/.agents/elves.json", () => {
    mkdirSync(path.join(home, ".claude"));
    const clone = elvesPackage(path.join(tmp, "clone"));
    expect(elves(sb, ["install", "-g", "--link"], { bin: clone.bin }).code).toBe(0);
    expect(realpathSync(path.join(home, ".agents/elves"))).toBe(realpathSync(clone.dir));
    expect(realpathSync(path.join(home, ".claude/rules/elves.md"))).toBe(realpathSync(path.join(clone.dir, "AGENTS.md")));
    expect(realpathSync(path.join(home, ".claude/rules/elves-claude.md"))).toBe(realpathSync(path.join(clone.dir, "claude/CLAUDE.md")));
    expect(realpathSync(path.join(home, ".agents/skills/spec"))).toBe(realpathSync(path.join(clone.dir, "skills/spec")));
    expect(realpathSync(path.join(home, ".claude/skills/spec"))).toBe(realpathSync(path.join(clone.dir, "skills/spec")));
    expect(gone(path.join(home, ".agents/ai-dev"))).toBe(true);
    expect(realpathSync(JSON.parse(read(path.join(home, ".agents/elves.json"))).clone)).toBe(realpathSync(clone.dir));
    writeFileSync(path.join(clone.dir, "AGENTS.md"), "правка в клоне\n");
    expect(read(path.join(home, ".claude/rules/elves.md"))).toBe("правка в клоне\n");
  });

  /**
   * Канон клона Elves — его корень: Claude Code сам читает корневой AGENTS.md, если CLAUDE.md нет, а правила машины с
   * `--link` ведут в тот же клон. Клон поэтому не грузит канон сам — ни симлинком в `.claude/rules`, ни корневым
   * AGENTS.md: `.claude/CLAUDE.md` клона выключает чтение AGENTS.md. Клон песочницы получает файлы `.claude/`, которые
   * закоммичены в Elves.
   */
  it("в клоне elves с --link канон не грузится дважды", () => {
    mkdirSync(path.join(home, ".claude"));
    const clone = elvesPackage(path.join(tmp, "clone"));
    for (const rel of execFileSync("git", ["ls-files", "-z", ".claude"], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean)) {
      mkdirSync(path.dirname(path.join(clone.dir, rel)), { recursive: true });
      cpSync(path.join(REPO, rel), path.join(clone.dir, rel), { verbatimSymlinks: true });
    }
    expect(elves(sb, ["install", "-g", "--link"], { bin: clone.bin }).code).toBe(0);
    const loaded = loadedAtStart(home, clone.dir, tmp);
    const once = (rel: string) => loaded.filter((p) => p === realpathSync(path.join(clone.dir, rel)));
    expect(once("AGENTS.md")).toHaveLength(1);
    expect(once("claude/CLAUDE.md")).toHaveLength(1);
    expect(new Set(loaded).size).toBe(loaded.length);
  });

  /** Хук проверяет флоу в начале каждой сессии Claude Code; что он делает — capability `update`. */
  it("с Claude Code — хук SessionStart в ~/.claude/settings.json запускает check --hook; свои настройки и хуки на месте, повторная установка хук не дублирует", () => {
    const mine = { hooks: [{ type: "command", command: "echo мой хук" }] };
    writeTree(home, { ".claude/settings.json": JSON.stringify({ model: "opus", hooks: { SessionStart: [mine], Stop: [mine] } }) });
    install(["-g"]);
    install(["-g"]);
    const s = JSON.parse(read(path.join(home, ".claude/settings.json")));
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toEqual([mine]);
    expect(s.hooks.SessionStart[0]).toEqual(mine);
    const ours = s.hooks.SessionStart.filter((g: { hooks: { command: string }[] }) => g.hooks.some((h) => h.command.includes("elves check --hook")));
    expect(ours).toHaveLength(1);
    expect(ours[0].matcher).toContain("startup");
    expect(ours[0].hooks[0].timeout).toBeGreaterThan(0);
  });

  /**
   * Вывод хука с кодом 0 Claude Code кладёт в контекст сессии: `--silent` — первая установка пакета bunx печатает свой
   * прогресс в stderr, а хук сводит stderr в вывод.
   */
  it("команда хука — bunx --silent github:miroshnik/elves check --hook, вывод с ошибками и запасной echo при сбое bunx", () => {
    mkdirSync(path.join(home, ".claude"));
    install(["-g"]);
    const hooks = JSON.parse(read(path.join(home, ".claude/settings.json"))).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    expect(hooks[0].command).toMatch(/^bunx --silent github:miroshnik\/elves check --hook 2>&1 \|\| echo "elves check unavailable/);
  });

  /** Хук прошлой версии — с запасным текстом по-русски: установка узнаёт свой хук по команде `check --hook`. */
  it("хук прошлой версии с запасным текстом по-русски install -g заменяет, а не ставит второй", () => {
    const command = 'npx -y --loglevel=error github:miroshnik/ai-dev check --hook 2>&1 || echo "ai-dev check недоступен (код $?): работай по текущему флоу и скажи об этом"';
    const old = { matcher: "startup|resume|clear", hooks: [{ type: "command", command, timeout: 60 }] };
    writeTree(home, { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [old] } }) });
    expect(install(["-g"]).code).toBe(0);
    const hooks = JSON.parse(read(path.join(home, ".claude/settings.json"))).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].command).toContain("github:miroshnik/elves check --hook");
    expect(hooks[0].command).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it("без Claude Code на машине — хука нет, ~/.claude не создаётся", () => {
    mkdirSync(path.join(home, ".codex"));
    expect(install(["-g"]).code).toBe(0);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("ELVES_PRIVATE — ~/.config/elves становится симлинком на личную конфигурацию", () => {
    const priv = path.join(tmp, "private");
    mkdirSync(priv);
    install(["-g"], proj, { ELVES_PRIVATE: priv });
    expect(readlinkSync(path.join(home, ".config/elves"))).toBe(priv);
  });
});

/**
 * Commit, push и мерж необратимы, поэтому по умолчанию они — по «да» владельца. Проект может разрешить агенту вести
 * задачу целиком самому: ответ хранится в манифесте проекта, а не на машине — его видят облачная сессия и любой
 * агент. Сам вопрос в терминале тестом не покрыт: псевдотерминала без зависимостей у Node нет.
 */
describe("Задача целиком без спроса — настройка проекта, по умолчанию «нет»", () => {
  const manifest = (root: string) => JSON.parse(read(path.join(root, ".agents/elves.json")));

  it("без терминала и без флага вопроса нет — у новой установки в .agents/elves.json auto: false", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Let the agent do tasks");
    expect(manifest(proj).auto).toBe(false);
  });

  it("--auto пишет auto: true, повторный install без флага его сохраняет, --no-auto возвращает false", () => {
    expect(install(["--auto"]).code).toBe(0);
    expect(manifest(proj).auto).toBe(true);
    expect(install().code).toBe(0);
    expect(manifest(proj).auto).toBe(true);
    expect(install(["--no-auto"]).code).toBe(0);
    expect(manifest(proj).auto).toBe(false);
  });

  it("install -g настройку не спрашивает и не хранит — в ~/.agents/elves.json поля auto нет", () => {
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Let the agent do tasks");
    expect(manifest(home).skills).toEqual(SKILLS);
    expect(manifest(home)).not.toHaveProperty("auto");
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  /** Клон Elves — сам канон: правила в его корне, копия флоу в нём — лишняя. Режим у него свой, как у проекта. */
  it("в клоне Elves install флоу не ставит — пишет в .agents/elves.json только auto и language: с флагом — его значение, без флага и терминала — прежнее", () => {
    const clone = path.join(tmp, "clone");
    writeTree(clone, { "package.json": JSON.stringify({ name: "@miroshnik/elves" }) });
    execFileSync("git", ["init", "-q"], { cwd: clone });
    expect(install(["--auto"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "en" });
    expect(install([], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "en" });
    expect(install(["--no-auto", "--lang", "ru"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: false, language: "ru" });
    expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
    expect(readdirSync(path.join(clone, ".agents"))).toEqual(["elves.json"]);
  });

  /**
   * Пакет — `@miroshnik/elves` (#556), до него назывался по репозиторию: `elves`, а до переименования в Elves (#544) —
   * `ai-dev`. Клон или ветка, ещё не получившие новое имя, — тот же клон: флоу в него не ставится, check не зовёт его
   * отставшим.
   */
  it("клон со старым именем пакета — elves или ai-dev — узнаётся как клон", () => {
    for (const name of ["elves", "ai-dev"]) {
      const clone = path.join(tmp, `clone-${name}`);
      writeTree(clone, { "package.json": JSON.stringify({ name }) });
      execFileSync("git", ["init", "-q"], { cwd: clone });
      expect(install(["--auto", "--lang", "ru"], clone).code).toBe(0);
      expect(manifest(clone)).toEqual({ auto: true, language: "ru" });
      expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
      const check = elves(sb, ["check"], { cwd: clone });
      expect(check.code).toBe(0);
      expect(check.stdout).toStartWith("Elves in the project: not installed — an Elves clone, the canon is at its root\n");
    }
  });
});

/**
 * Флоу написан по-английски, а агент работает с человеком на языке проекта: диалог, задачи, промпты, документы. Язык —
 * настройка проекта, как auto: хранится в манифесте, его видят облачная сессия и любой агент. Флоу до поля работал
 * только по-русски, поэтому установка прошлой версии без поля — `ru`: обновление не меняет языка проектам.
 */
describe("Язык работы агента — настройка проекта: по умолчанию en, у установки прошлой версии — ru", () => {
  const manifest = (root: string) => JSON.parse(read(path.join(root, ".agents/elves.json")));

  it("без терминала и без флага вопроса нет — у новой установки в .agents/elves.json language: en", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Project language the agent works in");
    expect(manifest(proj).language).toBe("en");
  });

  it("--lang ru пишет language: ru, повторный install без флага его сохраняет, --lang=pt-BR меняет", () => {
    expect(install(["--lang", "ru"]).code).toBe(0);
    expect(manifest(proj).language).toBe("ru");
    expect(install().code).toBe(0);
    expect(manifest(proj).language).toBe("ru");
    expect(install(["--lang=pt-BR"]).code).toBe(0);
    expect(manifest(proj).language).toBe("pt-BR");
  });

  it("установка прошлой версии без поля language — install без флага пишет ru", () => {
    install(["--auto"]);
    const m = manifest(proj);
    delete m.language;
    writeFileSync(path.join(proj, ".agents/elves.json"), JSON.stringify(m, null, 2) + "\n");
    expect(install().code).toBe(0);
    expect(manifest(proj)).toMatchObject({ auto: true, language: "ru" });
  });

  it("не код языка, --lang без значения и --lang с -g — отказ с кодом 2, ничего не ставится", () => {
    for (const args of [["--lang", "русский"], ["--lang"], ["--lang=ru_RU"], ["-g", "--lang", "ru"]]) {
      const r = install(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--lang <code>");
    }
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
    expect(existsSync(path.join(home, ".agents"))).toBe(false);
  });

  it("--lang — флаг только install: у update и check он неизвестен", () => {
    install();
    expect(elves(sb, ["update", "--lang", "ru"]).code).toBe(2);
    expect(elves(sb, ["check", "--lang=ru"]).stderr).toContain("unknown flag: --lang=ru");
  });

  it("install -g язык не спрашивает и не хранит — в ~/.agents/elves.json поля language нет", () => {
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Project language the agent works in");
    expect(manifest(home)).not.toHaveProperty("language");
  });
});

/**
 * `auto` — настройка проекта, а мерж без ревью человека в Claude Code решают настройки разрешений машины: правило
 * `Bash(gh pr merge *)` действует на все её репозитории. Разрешение шире проекта владелец ставит своей рукой —
 * `install` его называет, а не пишет: иначе владелец узнаёт о правиле из отказа в конце первой задачи.
 */
describe("Мерж своего PR в Claude Code — правило разрешений владельца: install с auto подсказывает, а не ставит", () => {
  const RULE = "Bash(gh pr merge *)";

  it("install с auto называет правило разрешений на мерж и того, кто его ставит", () => {
    const r = install(["--auto"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Claude Code");
    expect(r.stdout).toContain(`"${RULE}"`);
    expect(r.stdout).toContain("permissions.allow");
    expect(r.stdout).toContain("~/.claude/settings.json");
    expect(r.stdout).toContain("the owner adds it");
    // режим остался с прошлой установки — подсказка та же: о правиле узнают не из отказа
    expect(install().stdout).toContain(RULE);
  });

  /** Последняя строка сессии — на языке проекта, из словаря скилла github; остальной текст подсказки — по-английски. */
  it("подсказка цитирует последнюю строку сессии на языке проекта: en — «Remaining: …», ru — «Осталось: …»", () => {
    expect(install(["--auto"]).stdout).toContain("the session ends with «Remaining: …»");
    const ru = install(["--auto", "--lang", "ru"]).stdout;
    expect(ru).toContain("the session ends with «Осталось: …»");
    expect(ru.replace("«Осталось: …»", "")).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it("install без auto о правиле разрешений молчит", () => {
    for (const args of [[], ["--no-auto"], ["-g"]]) {
      const r = install(args);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("gh pr merge");
    }
    install(["--auto"]);
    // update и check идут с режимом манифеста — подсказка только у install
    for (const cmd of ["update", "check"]) expect(elves(sb, [cmd]).stdout).not.toContain("gh pr merge");
  });

  it("подсказка не меняет настройки машины", () => {
    const settings = JSON.stringify({ permissions: { allow: ["Bash(git status)"] } });
    writeTree(home, { ".claude/settings.json": settings });
    const before = snapshot(home);
    expect(install(["--auto"]).stdout).toContain(RULE);
    expect(snapshot(home)).toEqual(before);
    expect(read(path.join(home, ".claude/settings.json"))).toBe(settings);
  });
});

describe("Неверный вызов — код 2 с объяснением", () => {
  it("--link без -g — код 2: проект держит версию пакета, а не ссылку на локальный клон", () => {
    const r = install(["--link"]);
    expect(r.code).toBe(2);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("--auto с -g или вместе с --no-auto — код 2: настройка одна и она у проекта", () => {
    for (const args of [["-g", "--auto"], ["-g", "--no-auto"], ["--auto", "--no-auto"]]) {
      const r = install(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("project setting");
      expect(r.stderr).not.toContain("unknown flag");
    }
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
    expect(existsSync(path.join(home, ".agents"))).toBe(false);
  });

  it("неизвестная команда — код 2 и справка", () => {
    const r = elves(sb, ["instal"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("install");
  });
});
