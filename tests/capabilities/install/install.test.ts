import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, aiDevPackage, bunxPackage, REPO, sandbox, snapshot, type Sandbox } from "../../lib/ai-dev.ts";
import { writeTree } from "../../lib/spec.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SKILLS = ["ci-wait", "dashboard", "est", "github", "slot", "spec", "task-env"];

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

function install(args: string[] = [], cwd = proj, extra: Record<string, string> = {}) {
  return aiDev(sb, ["install", ...args], { cwd, env: extra });
}

const read = (p: string) => readFileSync(p, "utf8");
const isLink = (p: string) => lstatSync(p).isSymbolicLink();

describe("В проект — копия, которую видят облачная сессия и CI", () => {
  it("правила, справочники и все скиллы — копией в .agents, Claude Code получает их симлинками из .claude", () => {
    expect(install().code).toBe(0);
    expect(read(path.join(proj, ".agents/ai-dev/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(existsSync(path.join(proj, ".agents/ai-dev/docs/ci-concurrency.md"))).toBe(true);
    expect(isLink(path.join(proj, ".agents/ai-dev"))).toBe(false);
    for (const s of SKILLS) {
      expect(read(path.join(proj, ".agents/skills", s, "SKILL.md"))).toBe(read(path.join(REPO, "skills", s, "SKILL.md")));
      expect(isLink(path.join(proj, ".agents/skills", s))).toBe(false);
      expect(readlinkSync(path.join(proj, ".claude/skills", s))).toBe(`../../.agents/skills/${s}`);
    }
    expect(readlinkSync(path.join(proj, ".claude/rules/ai-dev.md"))).toBe("../../.agents/ai-dev/AGENTS.md");
    expect(read(path.join(proj, ".claude/rules/ai-dev-claude.md"))).toBe(read(path.join(REPO, "claude/CLAUDE.md")));
  });

  it("в AGENTS.md проекта — блок со ссылкой на правила: свой текст проекта на месте, повторная установка блок не дублирует", () => {
    writeFileSync(path.join(proj, "AGENTS.md"), "# Проект\n\nСвои правила.\n");
    install();
    install();
    const text = read(path.join(proj, "AGENTS.md"));
    expect(text.match(/<!-- ai-dev:begin/g)).toHaveLength(1);
    expect(text).toContain("`.agents/ai-dev/AGENTS.md`");
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
    expect(text.match(/<!-- ai-dev:begin/g)).toHaveLength(1);
    const block = /^<!-- ai-dev:begin[^]*?<!-- ai-dev:end -->/.exec(text)?.[0] ?? "";
    expect(block).toContain("Shared rules — `.agents/ai-dev/AGENTS.md`");
    expect(block).not.toMatch(/\p{Script=Cyrillic}/u);
    expect(text).toEndWith("<!-- ai-dev:end -->\n\n# Проект\n\nСвои правила.\n");
  });

  it("без AGENTS.md в проекте — файл создаётся с одним блоком", () => {
    install();
    expect(read(path.join(proj, "AGENTS.md"))).toMatch(/^<!-- ai-dev:begin[^]*<!-- ai-dev:end -->\n$/);
  });

  it("скилл, которого больше нет в Elves, при переустановке удаляется; свой скилл проекта не трогается", () => {
    install();
    const manifest = path.join(proj, ".agents/ai-dev.json");
    const m = JSON.parse(read(manifest));
    writeFileSync(manifest, JSON.stringify({ ...m, skills: [...m.skills, "old"] }));
    writeTree(proj, { ".agents/skills/old/SKILL.md": "old", ".agents/skills/mine/SKILL.md": "mine" });
    symlinkSync("../../.agents/skills/old", path.join(proj, ".claude/skills/old"));
    install();
    expect(existsSync(path.join(proj, ".agents/skills/old"))).toBe(false);
    expect(existsSync(path.join(proj, ".claude/skills/old"))).toBe(false);
    expect(read(path.join(proj, ".agents/skills/mine/SKILL.md"))).toBe("mine");
  });

  it("чужой каталог с именем скилла Elves не перезаписывается — предупреждение", () => {
    writeTree(proj, { ".agents/skills/spec/SKILL.md": "свой spec" });
    const r = install();
    expect(read(path.join(proj, ".agents/skills/spec/SKILL.md"))).toBe("свой spec");
    expect(r.stderr).toContain(".agents/skills/spec");
  });

  /**
   * bunx ставит пакет в node_modules своего каталога и запускает его bin по шебангу — так же, как `bun add` пакета из
   * `bun pm pack`: только файлы из `files`, TypeScript в node_modules Bun стирает сам. Кеш bun — свой, в песочнице.
   */
  it("через bunx из пакета Elves: bin из node_modules под Bun ставит правила и скиллы", () => {
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
    expect(read(path.join(proj, ".agents/ai-dev/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(existsSync(path.join(proj, ".agents/ai-dev/docs/ci-concurrency.md"))).toBe(true);
    expect(existsSync(path.join(proj, ".agents/skills/spec/scripts/package.json"))).toBe(true);
  });

  it("в .agents/ai-dev.json — SHA Elves, из которого поставлено: у клона — его HEAD", () => {
    install();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    expect(JSON.parse(read(path.join(proj, ".agents/ai-dev.json"))).sha).toBe(head);
  });

  /**
   * bunx ставит пакет из GitHub архивом, без `.git`, и в `.bun-tag` оставляет лишь 7 знаков SHA: полный коммит виден
   * только в спецификаторе, по которому поставлено, — `package.json` каталога bunx рядом с node_modules.
   */
  it("из пакета bunx — SHA из спецификатора в package.json каталога bunx", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const bin = bunxPackage(path.join(tmp, "bunx"), REPO, sha);
    expect(aiDev(sb, ["install"], { bin }).code).toBe(0);
    expect(JSON.parse(read(path.join(proj, ".agents/ai-dev.json"))).sha).toBe(sha);
  });

  it("корень установки — корень git-репозитория, даже при запуске из подкаталога", () => {
    mkdirSync(path.join(proj, "src/app"), { recursive: true });
    expect(install([], path.join(proj, "src/app")).code).toBe(0);
    expect(existsSync(path.join(proj, ".agents/ai-dev/AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(proj, "src/app/.agents"))).toBe(false);
  });
});

/**
 * Песочница агента не пускает запись в `.claude/skills` проекта (Seatbelt у Claude Code — EPERM): установка
 * обрывается на симлинках, когда копии в `.agents/skills` уже легли. Тест закрывает каталог правами — отказ тот же
 * по сути (EACCES).
 */
describe("Отказ в записи посреди установки — понятная строка вместо стека, повтор доводит установку", () => {
  const skillsDir = () => path.join(proj, ".claude/skills");
  const lock = () => (mkdirSync(skillsDir(), { recursive: true }), chmodSync(skillsDir(), 0o555));
  // каталог без права записи не удалить — права возвращаются до уборки песочницы
  afterEach(() => existsSync(skillsDir()) && chmodSync(skillsDir(), 0o755));

  it("нет права писать в .claude/skills — install: код 2, строка с путём и командой для своего терминала, без стека", () => {
    lock();
    const r = install(["--lang", "ru"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(".claude/skills/ci-wait");
    expect(r.stderr).toContain("bunx github:miroshnik/elves install --lang ru");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("повтор после отказа на .claude/skills доводит установку: скиллы признаны своими, симлинки на месте, предупреждения «isn't an Elves skill» нет", () => {
    lock();
    install();
    chmodSync(skillsDir(), 0o755);
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("isn't an Elves skill");
    for (const s of SKILLS) expect(readlinkSync(path.join(skillsDir(), s))).toBe(`../../.agents/skills/${s}`);
    expect(JSON.parse(read(path.join(proj, ".agents/ai-dev.json"))).skills).toEqual(SKILLS);
  });

  it("update: нет права писать в .claude/skills — код 2, та же строка с командой update", () => {
    install();
    rmSync(path.join(skillsDir(), "spec"));
    chmodSync(skillsDir(), 0o555);
    const r = aiDev(sb, ["update"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(".claude/skills/spec");
    expect(r.stderr).toContain("bunx github:miroshnik/elves update");
  });

  it("симлинк, который уже ведёт куда надо, установка не пересоздаёт: .claude/skills без права записи не мешает повтору без нового скилла", () => {
    install();
    chmodSync(skillsDir(), 0o555);
    expect(install().code).toBe(0);
    expect(aiDev(sb, ["update"]).code).toBe(0);
  });
});

/**
 * Копия флоу коммитится: облачная сессия, чужой чекаут и CI видят только репозиторий. Шаблон из .gitignore проекта
 * (`CLAUDE.md` — частая практика прятать личные заметки агента, `.claude/`, `vendor/`) молча оставляет файл флоу вне
 * коммита, а закоммиченный симлинк `.claude/rules` — ведущим в пустоту. Исключение действует, только если идёт после
 * игнорирующего правила, — поэтому блок ai-dev в конце `.gitignore`.
 */
describe("Файлы флоу не игнорируются git проекта — иначе их нет в коммите, чужом чекауте и облачной сессии", () => {
  const gitignore = () => read(path.join(proj, ".gitignore"));
  // игнорируемые git файлы проекта — по одному, и внутри игнорируемых каталогов
  const ignored = () => execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], { cwd: proj, env, encoding: "utf8" }).split("\n").filter(Boolean).sort();

  it("шаблон CLAUDE.md в .gitignore проекта — install дописывает в конец .gitignore блок ai-dev с исключением: копия claude/CLAUDE.md не игнорируется, свои строки .gitignore на месте, повторная установка блок не дублирует", () => {
    writeTree(proj, { ".gitignore": "node_modules/\nCLAUDE.md\n", "notes/CLAUDE.md": "мои заметки\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".gitignore");
    expect(ignored()).toEqual(["notes/CLAUDE.md"]);
    const text = gitignore();
    expect(text).toStartWith("node_modules/\nCLAUDE.md\n");
    expect(text).toContain("\n!/.agents/ai-dev/claude/CLAUDE.md\n");
    expect(text).toMatch(/\n# ai-dev:begin[^\n]*\n[^]*\n# ai-dev:end\n$/);
    install();
    expect(gitignore()).toBe(text);
  });

  /** Шапка блока прошлой версии — по-русски; маркеры begin и end у него те же: по ним установка его находит. */
  it("блок исключений прошлой версии с шапкой по-русски установка заменяет английским, а не ставит второй", () => {
    const old = ["# ai-dev:begin — файлы флоу, которые иначе игнорирует git; ставит `npx -y github:miroshnik/ai-dev install`, руками не править", "!/.agents/ai-dev/claude/CLAUDE.md", "# ai-dev:end"].join("\n");
    writeTree(proj, { ".gitignore": `node_modules/\nCLAUDE.md\n\n${old}\n` });
    expect(install().code).toBe(0);
    install();
    const text = gitignore();
    expect(text.match(/# ai-dev:begin/g)).toHaveLength(1);
    expect(text).toStartWith("node_modules/\nCLAUDE.md\n\n# ai-dev:begin — flow files git would otherwise ignore; ");
    expect(text).toContain("\n!/.agents/ai-dev/claude/CLAUDE.md\n");
    expect(text).toEndWith("\n# ai-dev:end\n");
    expect(text).not.toMatch(/\p{Script=Cyrillic}/u);
    expect(ignored()).toEqual([]);
  });

  it("каталог .claude/ в .gitignore проекта — исключения снимают его только с файлов флоу: правила и скиллы не игнорируются, свои файлы в .claude по-прежнему игнорируются", () => {
    writeTree(proj, { ".gitignore": ".claude/\n", ".claude/settings.local.json": "{}\n", ".claude/rules/mine.md": "моё правило\n", ".claude/skills/mine/SKILL.md": "мой скилл\n" });
    expect(install().code).toBe(0);
    expect(ignored()).toEqual([".claude/rules/mine.md", ".claude/settings.local.json", ".claude/skills/mine/SKILL.md"]);
  });

  /** `vendor/` — у скилла spec есть `scripts/vendor`: шаблон внутри скилла снимается уже после исключения на `.agents`. */
  it("игнорируются .agents/ и vendor/ — после install ни один файл флоу не игнорируется, свои vendor/ проекта и прочее в .agents игнорируются", () => {
    writeTree(proj, { ".gitignore": ".agents/\nvendor/\n", "vendor/lib.js": "// чужое\n", ".agents/notes.md": "мои заметки\n" });
    expect(install().code).toBe(0);
    expect(ignored()).toEqual([".agents/notes.md", "vendor/lib.js"]);
  });

  it("ничего не игнорируется — .gitignore не создаётся и не меняется; ставший ненужным блок убирается", () => {
    install();
    expect(existsSync(path.join(proj, ".gitignore"))).toBe(false);
    writeFileSync(path.join(proj, ".gitignore"), "dist");
    install();
    expect(gitignore()).toBe("dist");
    writeFileSync(path.join(proj, ".gitignore"), "dist\nCLAUDE.md\n");
    install();
    expect(gitignore()).toContain("# ai-dev:begin");
    writeFileSync(path.join(proj, ".gitignore"), gitignore().replace("dist\nCLAUDE.md\n", "dist\n"));
    install();
    expect(gitignore()).toBe("dist\n");
  });

  /**
   * Личные правила (core.excludesFile, `.git/info/exclude`) — не проекта. Исключение файла безвредно для всех, а
   * исключение каталога с `/<каталог>/*` спрятало бы остальное в нём у тех, у кого такого правила нет.
   */
  it("шаблон файла вне проекта (core.excludesFile) снимается исключением в .gitignore проекта; каталог, исключённый вне проекта, — ❌ с правилом, исключений на него в .gitignore проекта нет", () => {
    writeTree(home, { ".config/git/ignore": "CLAUDE.md\n.claude/\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(gitignore()).toContain("\n!/.agents/ai-dev/claude/CLAUDE.md\n");
    expect(gitignore()).not.toContain("/.claude");
    expect(r.stderr).toContain("❌ .claude/ — ");
    expect(r.stderr).toContain(".config/git/ignore:2 «.claude/»");
    expect(ignored()).toEqual([".claude/rules/ai-dev-claude.md", ".claude/rules/ai-dev.md", ...SKILLS.map((s) => `.claude/skills/${s}`)]);
  });
});

/**
 * Тяжёлые проверки проекта идут очередью машины (capability `slot`). Обёртка — в самих скриптах `package.json`: их
 * зовёт любой — Claude, Codex, человек в терминале. `build` не оборачивается — его запускают хостинг и Docker, где
 * копии скилла может не быть; watch — долгий, занял бы слот надолго.
 */
describe("Проверки проекта идут очередью машины: install оборачивает их скрипты package.json в slot", () => {
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
  const slot = (cmd: string) => `. .agents/skills/slot/scripts/slot.sh && ${cmd}`;
  /** Обёртка прошлых установок: команда — строкой-аргументом slot.ts. */
  const slotString = (cmd: string, runtime = "bun --no-env-file") => `${runtime} .agents/skills/slot/scripts/slot.ts '${cmd}'`;

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

  /** npm и bun дописывают аргументы к скрипту в конец его строки: `npm test -- <файл>` — так же и с обёрткой. */
  it("обёрнутый скрипт идёт как прежде: кавычки команды на месте, аргументы — в её конце", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { test: `printf '%s|' "it's"` } }) });
    install();
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
      "package.json": JSON.stringify({ scripts: { test: `echo "[$AI_DEV_DOTENV|$AI_DEV_DOTENV_LOCAL]"` } }),
      ".env": "AI_DEV_DOTENV=dotenv\n",
      ".env.local": "AI_DEV_DOTENV_LOCAL=prod-key\n",
    });
    install();
    const r = spawnSync("sh", ["-c", scripts().test], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("[|]\n");
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
   * Прошлые установки передавали команду slot.ts строкой — через node в проекте на Node, через bun без отключения
   * env-файлов, через bun с ним: knip такую команду не видит.
   */
  it("обёртка прошлой установки — команда строкой у slot.ts через node или bun — переписывается, команда та же", () => {
    const quoted = `printf '%s' "it's"`;
    writeTree(proj, {
      "package.json": JSON.stringify({
        scripts: { test: slotString("vitest run", "node"), lint: slotString("eslint .", "bun"), typecheck: slotString(quoted.replaceAll("'", "'\\''")) },
      }),
    });
    install();
    expect(scripts()).toEqual({ test: slot("vitest run"), lint: slot("eslint ."), typecheck: slot(quoted) });
  });

  /**
   * Yarn 2+ выполняет скрипты своим shell (`@yarnpkg/shell`): в нём нет `.`, `eval` и `export`, и подключить slot.sh
   * нечем. Там команда остаётся строкой у slot.ts — knip её не видит, но проверки идут очередью.
   */
  it("в проекте на Yarn 2+ команда остаётся строкой у slot.ts: shell Yarn не подключает slot.sh", () => {
    const markers: [Record<string, string>, string?][] = [[{ ".yarnrc.yml": "nodeLinker: node-modules\n" }], [{}, "yarn@4.9.1"]];
    for (const [files, packageManager] of markers) {
      rmSync(path.join(proj, ".yarnrc.yml"), { force: true });
      writeTree(proj, { ...files, "package.json": JSON.stringify({ packageManager, scripts: { test: "vitest run", lint: slot("eslint .") } }) });
      install();
      expect(scripts()).toEqual({ test: slotString("vitest run"), lint: slotString("eslint .") });
      expect(aiDev(sb, ["check"]).code).toBe(0);
    }
    writeTree(proj, { "package.json": JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { test: "vitest run" } }) });
    install();
    expect(scripts()).toEqual({ test: slot("vitest run") });
  });

  it("check называет обёртку прошлой установки несоответствием, update переписывает её", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }) });
    install();
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: scripts().lint, test: slotString("vitest run") } }) });
    const c = aiDev(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/~ package\.json — [^\n]*previous install[^\n]*\btest\b/);
    expect(c.stdout).not.toMatch(/~ package\.json — [^\n]*\blint\b/);
    const u = aiDev(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(scripts()).toEqual({ lint: slot("eslint ."), test: slot("vitest run") });
    expect(aiDev(sb, ["check"]).code).toBe(0);
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
    expect(aiDev(sb, ["check"]).code).toBe(0);
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: scripts().lint, test: "vitest run" } }) });
    const c = aiDev(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/~ package\.json — [^\n]*\btest\b/);
    expect(c.stdout).not.toMatch(/~ package\.json — [^\n]*\blint\b/);
    const u = aiDev(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(scripts().test).toBe(slot("vitest run"));
    expect(u.stdout).toMatch(/git add [^\n]* package\.json/);
    expect(aiDev(sb, ["check"]).code).toBe(0);
  });

  /**
   * turbo 2 в strict env mode пропускает задачам только переменные, названные в turbo.json: без проброса раннер не
   * видит `AI_DEV_SLOT_CPUS` и берёт машину целиком, а вложенный скрипт в slot — `AI_DEV_SLOT` и ждёт собственный
   * слот. `globalPassThroughEnv`, а не `globalEnv`: в хэш кэша они не входят, а `AI_DEV_SLOT` у каждого прогона свой.
   * turbo.json правит владелец проекта (в нём бывают комментарии — JSONC), поэтому install и check только
   * предупреждают; отставанием флоу это не считается.
   */
  it("скрипт в slot зовёт turbo без проброса переменных очереди — install и check предупреждают готовой строкой для turbo.json, отставанием это не считается", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "turbo run test --filter=web" } }),
      "turbo.json": `{\n  // кэш\n  "globalPassThroughEnv": ["SENTRY_*", "AI_DEV_SLOT_CPUS",],\n  "tasks": { "test": {} }\n}\n`,
    });
    const ready = `"globalPassThroughEnv": ["SENTRY_*", "AI_DEV_SLOT_CPUS", "AI_DEV_SLOT"]`;
    const i = install();
    expect(i.code).toBe(0);
    expect(i.stderr).toContain(`!! turbo.json — AI_DEV_SLOT doesn't reach the runner`);
    expect(i.stderr).toContain(ready);
    const c = aiDev(sb, ["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/up to date[^\n]*\n {2}! turbo\.json — AI_DEV_SLOT doesn't reach the runner: turbo in strict env mode/);
    expect(c.stdout).toContain(ready);
    expect(aiDev(sb, ["check", "--hook"]).stdout).toContain(ready);
  });

  it("предупреждения нет, если переменные очереди доходят до задач turbo — globalPassThroughEnv или globalEnv с масками, envMode loose, --env-mode=loose — или turbo зовёт скрипт вне очереди", () => {
    const warning = (scripts: Record<string, string>, turbo: string, file = "turbo.json") => {
      for (const f of ["turbo.json", "turbo.jsonc"]) rmSync(path.join(proj, f), { force: true });
      writeTree(proj, { "package.json": JSON.stringify({ scripts }), [file]: turbo });
      return /^!! turbo\.jsonc? — .*$/m.exec(install().stderr)?.[0] ?? null;
    };
    const test = { test: "npx turbo test" };
    expect(warning(test, `{ "tasks": {} }`)).toContain(`"globalPassThroughEnv": ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"]`);
    expect(warning(test, `{ "globalPassThroughEnv": ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"] }`)).toBeNull();
    expect(warning(test, `{ "globalEnv": ["AI_DEV_*"] }`)).toBeNull();
    expect(warning(test, `{ "globalPassThroughEnv": ["AI_DEV_*", "!AI_DEV_SLOT"] }`)).toContain(`"globalPassThroughEnv": ["AI_DEV_*", "AI_DEV_SLOT"]`);
    expect(warning(test, `{ "envMode": "loose" }`)).toBeNull();
    expect(warning({ test: "turbo run test --env-mode=loose" }, `{}`)).toBeNull();
    expect(warning({ test: "vitest run --turbo" }, `{}`)).toBeNull();
    expect(warning({ build: "turbo run build" }, `{}`)).toBeNull();
    expect(warning(test, `{ /* JSONC */ "tasks": {}, }`, "turbo.jsonc")).toMatch(/^!! turbo\.jsonc — /);
    expect(warning(test, `{ /* JSONC */ "globalPassThroughEnv": ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"] }`, "turbo.jsonc")).toBeNull();
  });
});

/**
 * Правила грузятся из проекта: вторая копия на машине читалась бы Claude Code на каждом ходу каждого агента
 * (~20k токенов). На машине — только скиллы и хук.
 */
describe("На машину (-g) — только скиллы и хук, правила грузятся из проекта", () => {
  const gone = (p: string) => lstatSync(p, { throwIfNoEntry: false }) === undefined;

  it("install -g ставит скиллы в ~/.agents/skills и ~/.claude/skills и хук SessionStart; правил на машине нет — ни ~/.agents/ai-dev, ни ~/.claude/rules, ни файлов правил Codex, Gemini CLI, Copilot, OpenCode, Amp", () => {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    expect(install(["-g"]).code).toBe(0);
    expect(isLink(path.join(home, ".agents/skills/spec"))).toBe(false);
    expect(readlinkSync(path.join(home, ".claude/skills/spec"))).toBe("../../.agents/skills/spec");
    expect(read(path.join(home, ".claude/settings.json"))).toContain("check --hook");
    for (const p of [".agents/ai-dev", ".claude/rules", ".codex/AGENTS.md", ".gemini", ".copilot", ".config/opencode", ".config/amp"]) expect(gone(path.join(home, p))).toBe(true);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("повторный install -g убирает правила прошлой установки — ~/.agents/ai-dev, симлинки ~/.claude/rules/ai-dev*.md и симлинки агентов на канон; свой файл правил агента остаётся", () => {
    writeTree(home, { ".agents/ai-dev/AGENTS.md": "старый канон\n", ".agents/ai-dev/claude/CLAUDE.md": "старый\n", ".gemini/GEMINI.md": "мои правила\n" });
    mkdirSync(path.join(home, ".claude/rules"), { recursive: true });
    symlinkSync("../../.agents/ai-dev/AGENTS.md", path.join(home, ".claude/rules/ai-dev.md"));
    symlinkSync("../../.agents/ai-dev/claude/CLAUDE.md", path.join(home, ".claude/rules/ai-dev-claude.md"));
    mkdirSync(path.join(home, ".codex"));
    symlinkSync("../.agents/ai-dev/AGENTS.md", path.join(home, ".codex/AGENTS.md"));
    expect(install(["-g"]).code).toBe(0);
    for (const p of [".agents/ai-dev", ".claude/rules/ai-dev.md", ".claude/rules/ai-dev-claude.md", ".codex/AGENTS.md"]) expect(gone(path.join(home, p))).toBe(true);
    expect(read(path.join(home, ".gemini/GEMINI.md"))).toBe("мои правила\n");
    expect(read(path.join(home, ".agents/ai-dev.json"))).toContain('"skills"');
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
  it("--link из клона — симлинки только на skills/ клона, правка в клоне видна сразу; путь клона — в ~/.agents/ai-dev.json", () => {
    mkdirSync(path.join(home, ".claude"));
    const clone = aiDevPackage(path.join(tmp, "clone"));
    expect(aiDev(sb, ["install", "-g", "--link"], { bin: clone.bin }).code).toBe(0);
    expect(realpathSync(path.join(home, ".agents/skills/spec"))).toBe(realpathSync(path.join(clone.dir, "skills/spec")));
    expect(realpathSync(path.join(home, ".claude/skills/spec"))).toBe(realpathSync(path.join(clone.dir, "skills/spec")));
    expect(gone(path.join(home, ".agents/ai-dev"))).toBe(true);
    expect(gone(path.join(home, ".claude/rules"))).toBe(true);
    expect(realpathSync(JSON.parse(read(path.join(home, ".agents/ai-dev.json"))).clone)).toBe(realpathSync(clone.dir));
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

  it("AI_DEV_PRIVATE — ~/.config/ai-dev становится симлинком на личную конфигурацию", () => {
    const priv = path.join(tmp, "private");
    mkdirSync(priv);
    install(["-g"], proj, { AI_DEV_PRIVATE: priv });
    expect(readlinkSync(path.join(home, ".config/ai-dev"))).toBe(priv);
  });
});

/**
 * Commit, push и мерж необратимы, поэтому по умолчанию они — по «да» владельца. Проект может разрешить агенту вести
 * задачу целиком самому: ответ хранится в манифесте проекта, а не на машине — его видят облачная сессия и любой
 * агент. Сам вопрос в терминале тестом не покрыт: псевдотерминала без зависимостей у Node нет.
 */
describe("Задача целиком без спроса — настройка проекта, по умолчанию «нет»", () => {
  const manifest = (root: string) => JSON.parse(read(path.join(root, ".agents/ai-dev.json")));

  it("без терминала и без флага вопроса нет — у новой установки в .agents/ai-dev.json auto: false", () => {
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

  it("install -g настройку не спрашивает и не хранит — в ~/.agents/ai-dev.json поля auto нет", () => {
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Let the agent do tasks");
    expect(manifest(home).skills).toEqual(SKILLS);
    expect(manifest(home)).not.toHaveProperty("auto");
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  /** Клон Elves — сам канон: правила в его корне, копия флоу в нём — лишняя. Режим у него свой, как у проекта. */
  it("в клоне Elves install флоу не ставит — пишет в .agents/ai-dev.json только auto и language: с флагом — его значение, без флага и терминала — прежнее", () => {
    const clone = path.join(tmp, "clone");
    writeTree(clone, { "package.json": JSON.stringify({ name: "elves" }) });
    execFileSync("git", ["init", "-q"], { cwd: clone });
    expect(install(["--auto"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "en" });
    expect(install([], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "en" });
    expect(install(["--no-auto", "--lang", "ru"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: false, language: "ru" });
    expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
    expect(readdirSync(path.join(clone, ".agents"))).toEqual(["ai-dev.json"]);
  });

  /**
   * Пакет назван по репозиторию: до переименования в Elves (#544) — `ai-dev`. Клон или ветка, ещё не получившие
   * переименование, — тот же клон: флоу в него не ставится, check не зовёт его отставшим.
   */
  it("клон со старым именем пакета узнаётся как клон", () => {
    const clone = path.join(tmp, "clone");
    writeTree(clone, { "package.json": JSON.stringify({ name: "ai-dev" }) });
    execFileSync("git", ["init", "-q"], { cwd: clone });
    expect(install(["--auto", "--lang", "ru"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "ru" });
    expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
    const check = aiDev(sb, ["check"], { cwd: clone });
    expect(check.code).toBe(0);
    expect(check.stdout).toStartWith("Elves in the project: not installed — an Elves clone, the canon is at its root\n");
  });
});

/**
 * Флоу написан по-английски, а агент работает с человеком на языке проекта: диалог, задачи, промпты, документы. Язык —
 * настройка проекта, как auto: хранится в манифесте, его видят облачная сессия и любой агент. Флоу до поля работал
 * только по-русски, поэтому установка прошлой версии без поля — `ru`: обновление не меняет языка проектам.
 */
describe("Язык работы агента — настройка проекта: по умолчанию en, у установки прошлой версии — ru", () => {
  const manifest = (root: string) => JSON.parse(read(path.join(root, ".agents/ai-dev.json")));

  it("без терминала и без флага вопроса нет — у новой установки в .agents/ai-dev.json language: en", () => {
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
    writeFileSync(path.join(proj, ".agents/ai-dev.json"), JSON.stringify(m, null, 2) + "\n");
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
    expect(aiDev(sb, ["update", "--lang", "ru"]).code).toBe(2);
    expect(aiDev(sb, ["check", "--lang=ru"]).stderr).toContain("unknown flag: --lang=ru");
  });

  it("install -g язык не спрашивает и не хранит — в ~/.agents/ai-dev.json поля language нет", () => {
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
    for (const cmd of ["update", "check"]) expect(aiDev(sb, [cmd]).stdout).not.toContain("gh pr merge");
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
  it("--link без -g — код 2: в проект коммитится копия, не ссылка на локальный клон", () => {
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
    const r = aiDev(sb, ["instal"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("install");
  });
});
