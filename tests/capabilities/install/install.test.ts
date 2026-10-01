import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, REPO, sandbox, type Sandbox } from "../../lib/ai-dev.ts";
import { writeTree } from "../../lib/spec.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SKILLS = ["ci-wait", "est", "github", "spec"];

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

  it("без AGENTS.md в проекте — файл создаётся с одним блоком", () => {
    install();
    expect(read(path.join(proj, "AGENTS.md"))).toMatch(/^<!-- ai-dev:begin[^]*<!-- ai-dev:end -->\n$/);
  });

  it("скилл, которого больше нет в ai-dev, при переустановке удаляется; свой скилл проекта не трогается", () => {
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

  it("чужой каталог с именем скилла ai-dev не перезаписывается — предупреждение", () => {
    writeTree(proj, { ".agents/skills/spec/SKILL.md": "свой spec" });
    const r = install();
    expect(read(path.join(proj, ".agents/skills/spec/SKILL.md"))).toBe("свой spec");
    expect(r.stderr).toContain(".agents/skills/spec");
  });

  /** npx ставит пакет из GitHub в node_modules — так же, как пакет из `npm pack`: только файлы из `files`. */
  it("через npx из пакета ai-dev: bin из node_modules ставит правила и скиллы", () => {
    const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: REPO, env: { ...env, npm_config_cache: path.join(tmp, "npm") }, encoding: "utf8" });
    expect(pack.status).toBe(0);
    const tgz = path.join(tmp, pack.stdout.trim().split("\n").pop()!);
    const r = spawnSync("npx", ["-y", `--package=${tgz}`, "ai-dev", "install"], { cwd: proj, env: { ...env, npm_config_cache: path.join(tmp, "npm") }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(read(path.join(proj, ".agents/ai-dev/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(existsSync(path.join(proj, ".agents/ai-dev/docs/ci-concurrency.md"))).toBe(true);
    expect(existsSync(path.join(proj, ".agents/skills/spec/scripts/package.json"))).toBe(true);
  });

  it("в .agents/ai-dev.json — SHA ai-dev, из которого поставлено: у клона — его HEAD", () => {
    install();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    expect(JSON.parse(read(path.join(proj, ".agents/ai-dev.json"))).sha).toBe(head);
  });

  /** npx ставит пакет из GitHub архивом, без `.git`: коммит виден только в `resolved` lock-файла npm рядом с пакетом. */
  it("из пакета npx — SHA из resolved в lock-файле npm", () => {
    const nm = path.join(tmp, "npx/node_modules");
    const pkg = path.join(nm, "ai-dev");
    for (const rel of ["package.json", "bin", "AGENTS.md", "claude", "docs", "skills"]) cpSync(path.join(REPO, rel), path.join(pkg, rel), { recursive: true });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const resolved = `git+ssh://git@github.com/miroshnik/ai-dev.git#${sha}`;
    writeFileSync(path.join(nm, ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/ai-dev": { version: "0.0.0", resolved } } }));
    expect(aiDev(sb, ["install"], { bin: path.join(pkg, "bin/ai-dev.mjs") }).code).toBe(0);
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

  it("--link из клона — симлинки только на skills/ клона, правка в клоне видна сразу; путь клона — в ~/.agents/ai-dev.json", () => {
    mkdirSync(path.join(home, ".claude"));
    expect(install(["-g", "--link"]).code).toBe(0);
    expect(realpathSync(path.join(home, ".agents/skills/spec"))).toBe(realpathSync(path.join(REPO, "skills/spec")));
    expect(realpathSync(path.join(home, ".claude/skills/spec"))).toBe(realpathSync(path.join(REPO, "skills/spec")));
    expect(gone(path.join(home, ".agents/ai-dev"))).toBe(true);
    expect(gone(path.join(home, ".claude/rules"))).toBe(true);
    expect(realpathSync(JSON.parse(read(path.join(home, ".agents/ai-dev.json"))).clone)).toBe(realpathSync(REPO));
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
    const ours = s.hooks.SessionStart.filter((g: { hooks: { command: string }[] }) => g.hooks.some((h) => h.command.includes("ai-dev check --hook")));
    expect(ours).toHaveLength(1);
    expect(ours[0].matcher).toContain("startup");
    expect(ours[0].hooks[0].timeout).toBeGreaterThan(0);
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
    expect(r.stdout).not.toContain("Делать задачи");
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
    expect(r.stdout).not.toContain("Делать задачи");
    expect(manifest(home).skills).toEqual(SKILLS);
    expect(manifest(home)).not.toHaveProperty("auto");
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  /** Клон ai-dev — сам канон: правила в его корне, копия флоу в нём — лишняя. Режим у него свой, как у проекта. */
  it("в клоне ai-dev install флоу не ставит — пишет в .agents/ai-dev.json только auto: с --auto — true, без флага и терминала — прежнее значение", () => {
    const clone = path.join(tmp, "clone");
    writeTree(clone, { "package.json": JSON.stringify({ name: "ai-dev" }) });
    execFileSync("git", ["init", "-q"], { cwd: clone });
    expect(install(["--auto"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true });
    expect(install([], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true });
    expect(install(["--no-auto"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: false });
    expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
    expect(readdirSync(path.join(clone, ".agents"))).toEqual(["ai-dev.json"]);
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
      expect(r.stderr).toContain("настройка проекта");
      expect(r.stderr).not.toContain("неизвестный флаг");
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
