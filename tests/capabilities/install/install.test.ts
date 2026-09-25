/**
 * Установка флоу: `npx github:miroshnik/ai-dev install` ставит общие правила, справочники и все скиллы в проект,
 * с `-g` — на машину.
 *
 * В проекте всё копией в `.agents/` (коммитится: облачная сессия и CI видят ровно эту версию), Claude Code
 * получает симлинки из `.claude/`, остальные агенты — ссылку в `AGENTS.md` проекта. На машине — `~/.agents/` и
 * агенты, которые на ней есть.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { tmpDir, writeTree } from "../../lib/spec.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = path.join(REPO, "bin/ai-dev.mjs");
const SKILLS = ["ci-wait", "est", "github", "spec"];

let tmp: string;
let cleanup: () => void;
let home: string;
let proj: string;
let env: Record<string, string>;

beforeEach(() => {
  ({ dir: tmp, cleanup } = tmpDir());
  home = path.join(tmp, "home");
  proj = path.join(tmp, "proj");
  mkdirSync(home);
  mkdirSync(proj);
  execFileSync("git", ["init", "-q"], { cwd: proj });
  // PATH — только node, git, npm и sh: агенты на машине определяются по каталогам в HOME, а не по тому, что стоит у раннера
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  for (const cmd of ["node", "git", "npm", "npx", "sh"]) {
    symlinkSync(execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim(), path.join(bin, cmd));
  }
  env = { HOME: home, PATH: bin };
});
afterEach(() => cleanup());

function install(args: string[] = [], cwd = proj, extra: Record<string, string> = {}) {
  const r = spawnSync("node", [BIN, "install", ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const read = (p: string) => readFileSync(p, "utf8");
const isLink = (p: string) => lstatSync(p).isSymbolicLink();

describe("Установка в проект", () => {
  it("правила, справочники и все скиллы — копией в .agents, Claude Code получает их симлинками из .claude", () => {
    expect(install().code).toBe(0);
    expect(read(path.join(proj, ".agents/ai-dev/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(existsSync(path.join(proj, ".agents/ai-dev/docs/github-projects.md"))).toBe(true);
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
    expect(existsSync(path.join(proj, ".agents/ai-dev/docs/github-projects.md"))).toBe(true);
    expect(existsSync(path.join(proj, ".agents/skills/spec/scripts/package.json"))).toBe(true);
  });

  it("корень установки — корень git-репозитория, даже при запуске из подкаталога", () => {
    mkdirSync(path.join(proj, "src/app"), { recursive: true });
    expect(install([], path.join(proj, "src/app")).code).toBe(0);
    expect(existsSync(path.join(proj, ".agents/ai-dev/AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(proj, "src/app/.agents"))).toBe(false);
  });
});

describe("Установка на машину (-g)", () => {
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

  it("AI_DEV_PRIVATE — ~/.config/ai-dev становится симлинком на личную конфигурацию", () => {
    const priv = path.join(tmp, "private");
    mkdirSync(priv);
    install(["-g"], proj, { AI_DEV_PRIVATE: priv });
    expect(readlinkSync(path.join(home, ".config/ai-dev"))).toBe(priv);
  });
});

describe("Ошибки", () => {
  it("--link без -g — код 2: в проект коммитится копия, не ссылка на локальный клон", () => {
    const r = install(["--link"]);
    expect(r.code).toBe(2);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("неизвестная команда — код 2 и справка", () => {
    const r = spawnSync("node", [BIN, "instal"], { cwd: proj, env, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("install");
  });
});
