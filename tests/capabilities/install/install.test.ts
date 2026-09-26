/**
 * Установка флоу: одна команда `npx github:miroshnik/ai-dev install` даёт проекту — или, с `-g`, машине — общие
 * правила, справочники и все скиллы ai-dev для любого агента.
 *
 * В проекте всё ложится копией в `.agents/` и коммитится: облачная сессия и CI видят ровно ту версию, что агент
 * у разработчика. Claude Code получает симлинки из `.claude/`, остальные агенты — ссылку в `AGENTS.md` проекта. На
 * машине — `~/.agents/` и агенты, которые на ней есть.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, REPO, sandbox, SPAWN_TIMEOUT, type Sandbox } from "../../lib/ai-dev.ts";
import { writeTree } from "../../lib/spec.ts";

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

describe("На машину (-g) — всем агентам, что на ней есть", () => {
  it("правила и скиллы — в ~/.agents; агентам, что есть на машине, — симлинки, отсутствующим каталоги не создаются", () => {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    expect(install(["-g"]).code).toBe(0);
    expect(read(path.join(home, ".agents/ai-dev/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(isLink(path.join(home, ".agents/skills/spec"))).toBe(false);
    expect(readlinkSync(path.join(home, ".claude/skills/spec"))).toBe("../../.agents/skills/spec");
    expect(readlinkSync(path.join(home, ".claude/rules/ai-dev.md"))).toBe("../../.agents/ai-dev/AGENTS.md");
    expect(realpathSync(path.join(home, ".codex/AGENTS.md"))).toBe(realpathSync(path.join(home, ".agents/ai-dev/AGENTS.md")));
    expect(existsSync(path.join(home, ".gemini"))).toBe(false);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("чужой непустой файл правил агента не трогается — предупреждение", () => {
    writeTree(home, { ".codex/AGENTS.md": "мои правила\n" });
    const r = install(["-g"]);
    expect(read(path.join(home, ".codex/AGENTS.md"))).toBe("мои правила\n");
    expect(r.stderr).toContain(".codex/AGENTS.md");
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

  it("--link из клона — симлинки на клон вместо копий: правка в клоне видна сразу", () => {
    mkdirSync(path.join(home, ".claude"));
    expect(install(["-g", "--link"]).code).toBe(0);
    // клон вне HOME — ссылка абсолютная: относительная ломается, если путь к HOME идёт через симлинк
    // (macOS: /var → /private/var, а HOME=/var/… здесь)
    expect(path.isAbsolute(readlinkSync(path.join(home, ".agents/ai-dev")))).toBe(true);
    expect(realpathSync(path.join(home, ".agents/ai-dev"))).toBe(realpathSync(REPO));
    expect(realpathSync(path.join(home, ".agents/skills/spec"))).toBe(realpathSync(path.join(REPO, "skills/spec")));
    expect(realpathSync(path.join(home, ".claude/rules/ai-dev.md"))).toBe(realpathSync(path.join(REPO, "AGENTS.md")));
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

describe("Неверный вызов — код 2 с объяснением", () => {
  it("--link без -g — код 2: в проект коммитится копия, не ссылка на локальный клон", () => {
    const r = install(["--link"]);
    expect(r.code).toBe(2);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("неизвестная команда — код 2 и справка", () => {
    const r = aiDev(sb, ["instal"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("install");
  });
});
