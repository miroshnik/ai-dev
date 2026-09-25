#!/usr/bin/env node
// @ts-check
/**
 * ai-dev — установка флоу: общие правила, справочники и все скиллы ai-dev в проект или на машину.
 *
 *   npx -y github:miroshnik/ai-dev install                — в проект: корень git (или текущий каталог)
 *   npx -y github:miroshnik/ai-dev install -g             — на машину: ~/.agents и агенты, которые на ней есть
 *   node <клон ai-dev>/bin/ai-dev.mjs install -g --link   — из клона: симлинки на клон, правки видны сразу
 *
 * Раскладка как у скиллов (`npx skills`): канон в `.agents/` — `.agents/ai-dev/` (AGENTS.md, claude/CLAUDE.md,
 * docs/*.md) и `.agents/skills/<name>/`; Claude Code получает симлинки в `.claude/skills` и `.claude/rules`
 * (грузит их сам, независимо от CLAUDE.md проекта), остальные агенты — ссылку в `AGENTS.md` проекта или
 * симлинк своего глобального файла правил. Список поставленных скиллов — `.agents/ai-dev.json`: по нему
 * переустановка убирает скиллы, которых в ai-dev больше нет, и не трогает чужие.
 *
 * JavaScript, а не TypeScript, как скрипты скиллов: npx кладёт пакет в node_modules, а там Node типы не
 * стирает (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Без зависимостей, только node:-API.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SOURCE = "miroshnik/ai-dev";
const BEGIN = "<!-- ai-dev:begin";
const END = "<!-- ai-dev:end -->";
const BLOCK = [
  `${BEGIN} — ставит \`npx -y github:${SOURCE} install\`, руками не править -->`,
  "Общие правила — `.agents/ai-dev/AGENTS.md`: прочитай до начала работы (справочники — `.agents/ai-dev/docs/`).",
  "Скиллы — `.agents/skills/`.",
  END,
].join("\n");

const USAGE = `Использование: ai-dev install [-g] [--link]

  install          правила, справочники и все скиллы ai-dev — в проект (корень git или текущий каталог)
  install -g       то же на машину: ~/.agents и агенты, которые на ней есть
  install -g --link  из клона ai-dev: симлинки на клон вместо копий, правки видны сразу

Запуск: npx -y github:${SOURCE} install [-g]
`;

/** @param {string} s */
const note = (s) => process.stdout.write(s + "\n");
/** @param {string} s */
const warn = (s) => process.stderr.write("!! " + s + "\n");

/** @param {string} p */
function lstat(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** @param {string} cmd */
function onPath(cmd) {
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => d && existsSync(path.join(d, cmd)));
}

/**
 * Относительный симлинк dst → target. Заменяет симлинк и пустой файл; чужой файл или каталог — предупреждение.
 * @param {string} target @param {string} dst @param {string} root
 */
function link(target, dst, root) {
  const st = lstat(dst);
  if (st && !st.isSymbolicLink()) {
    if (st.isFile() && st.size === 0) rmSync(dst);
    else return warn(`${path.relative(root, dst)} уже есть и это не симлинк — оставлен как есть`), false;
  }
  if (st?.isSymbolicLink()) rmSync(dst);
  mkdirSync(path.dirname(dst), { recursive: true });
  symlinkSync(path.relative(path.dirname(dst), target), dst);
  note(`${path.relative(root, dst)} → ${path.relative(root, target)}`);
  return true;
}

/** Каталог или симлинк — долой. @param {string} p */
const remove = (p) => lstat(p) && rmSync(p, { recursive: true, force: true });

/** Скиллы ai-dev: каталоги skills/<name> с SKILL.md. */
function sourceSkills() {
  return readdirSync(path.join(SRC, "skills"))
    .filter((n) => existsSync(path.join(SRC, "skills", n, "SKILL.md")))
    .sort();
}

/**
 * Канон правил: `.agents/ai-dev/` — копия AGENTS.md, claude/CLAUDE.md и docs/*.md или симлинк на клон.
 * @param {string} root @param {boolean} linkMode
 */
function installRules(root, linkMode) {
  const canon = path.join(root, ".agents/ai-dev");
  remove(canon);
  if (linkMode) return link(SRC, canon, root);
  const docs = readdirSync(path.join(SRC, "docs")).filter((f) => f.endsWith(".md") && statSync(path.join(SRC, "docs", f)).isFile());
  for (const rel of ["AGENTS.md", "claude/CLAUDE.md", ...docs.map((f) => `docs/${f}`)]) {
    mkdirSync(path.dirname(path.join(canon, rel)), { recursive: true });
    cpSync(path.join(SRC, rel), path.join(canon, rel));
  }
  note(`${path.relative(root, canon)}/ ← AGENTS.md, claude/CLAUDE.md, docs/ (${docs.length})`);
  return true;
}

/**
 * Скиллы: `.agents/skills/<name>` — копия (или симлинк на клон), Claude Code — симлинк из `.claude/skills`.
 * Чужой каталог с тем же именем не трогается; скиллы из прошлой установки, которых в ai-dev больше нет, убираются.
 * @param {string} root @param {boolean} linkMode @param {boolean} claude
 */
function installSkills(root, linkMode, claude) {
  const manifestPath = path.join(root, ".agents/ai-dev.json");
  /** @type {string[]} */
  let before = [];
  try {
    before = JSON.parse(readFileSync(manifestPath, "utf8")).skills ?? [];
  } catch {
    /* первая установка */
  }
  const names = sourceSkills();
  /** @type {string[]} */
  const installed = [];
  for (const name of names) {
    const dst = path.join(root, ".agents/skills", name);
    const st = lstat(dst);
    if (st && !st.isSymbolicLink() && !before.includes(name)) {
      warn(`${path.relative(root, dst)} уже есть и это не скилл ai-dev — оставлен; удали, чтобы поставить скилл ai-dev`);
      continue;
    }
    remove(dst);
    if (linkMode) link(path.join(SRC, "skills", name), dst, root);
    else {
      mkdirSync(path.dirname(dst), { recursive: true });
      cpSync(path.join(SRC, "skills", name), dst, { recursive: true });
    }
    if (claude) link(dst, path.join(root, ".claude/skills", name), root);
    installed.push(name);
  }
  if (!linkMode) note(`${path.relative(root, path.join(root, ".agents/skills"))}/ ← ${installed.join(", ")}`);
  for (const name of before.filter((n) => !names.includes(n))) {
    remove(path.join(root, ".agents/skills", name));
    if (lstat(path.join(root, ".claude/skills", name))?.isSymbolicLink()) rmSync(path.join(root, ".claude/skills", name));
    note(`${path.relative(root, path.join(root, ".agents/skills", name))} — убран: в ai-dev его больше нет`);
  }
  writeFileSync(manifestPath, JSON.stringify({ source: SOURCE, skills: installed }, null, 2) + "\n");
}

/** Claude Code: правила из `.claude/rules` грузятся сами, при любом CLAUDE.md. @param {string} root */
function claudeRules(root) {
  link(path.join(root, ".agents/ai-dev/AGENTS.md"), path.join(root, ".claude/rules/ai-dev.md"), root);
  link(path.join(root, ".agents/ai-dev/claude/CLAUDE.md"), path.join(root, ".claude/rules/ai-dev-claude.md"), root);
}

/** Блок со ссылкой на правила в AGENTS.md проекта: в начале файла, повторная установка заменяет его. @param {string} root */
function agentsBlock(root) {
  const file = path.join(root, "AGENTS.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  let out;
  if (b >= 0 && e > b) out = text.slice(0, b) + BLOCK + text.slice(e + END.length);
  else out = text ? `${BLOCK}\n\n${text}` : `${BLOCK}\n`;
  if (out !== text) writeFileSync(file, out);
  note("AGENTS.md — блок со ссылкой на .agents/ai-dev/AGENTS.md");
}

/** @param {boolean} linkMode */
function installProject(linkMode) {
  let root = process.cwd();
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || root;
  } catch {
    /* не git — текущий каталог */
  }
  installRules(root, linkMode);
  installSkills(root, linkMode, true);
  claudeRules(root);
  agentsBlock(root);
}

/** @param {boolean} linkMode */
function installGlobal(linkMode) {
  const home = os.homedir();
  const has = (/** @type {string} */ dir, /** @type {string} */ cmd = "") => existsSync(path.join(home, dir)) || (cmd !== "" && onPath(cmd));
  const claude = has(".claude", "claude");
  installRules(home, linkMode);
  installSkills(home, linkMode, claude);

  if (claude) {
    claudeRules(home);
    // install.sh ставил ~/.claude/CLAUDE.md симлинком на claude/CLAUDE.md, а тот импортировал AGENTS.md: с
    // ~/.claude/rules правила загрузились бы дважды
    const old = path.join(home, ".claude/CLAUDE.md");
    if (lstat(old)?.isSymbolicLink() && readlinkSync(old).endsWith(path.join("claude", "CLAUDE.md"))) {
      rmSync(old);
      note(".claude/CLAUDE.md — старый симлинк install.sh убран: правила теперь в .claude/rules");
    }
  }

  const canon = path.join(home, ".agents/ai-dev/AGENTS.md");
  /** @type {[boolean, string][]} */
  const agents = [
    [has(".codex", "codex"), ".codex/AGENTS.md"],
    [has(".gemini"), ".gemini/GEMINI.md"],
    [has(".copilot"), ".copilot/copilot-instructions.md"],
    [has(".config/opencode"), ".config/opencode/AGENTS.md"],
    [has(".config/amp"), ".config/amp/AGENTS.md"],
  ];
  for (const [present, file] of agents) if (present) link(canon, path.join(home, file), home);

  if (has(".cursor")) note("Cursor: глобального файла правил нет — вставь ~/.agents/ai-dev/AGENTS.md в Settings → Rules → User Rules; скиллы он видит в ~/.agents/skills");

  const priv = process.env.AI_DEV_PRIVATE;
  if (priv) {
    const dst = path.join(home, ".config/ai-dev");
    const st = lstat(dst);
    if (st && !st.isSymbolicLink()) warn(`~/.config/ai-dev уже есть и это не симлинк — перенеси его содержимое в ${priv} и удали`);
    else {
      if (st) rmSync(dst);
      mkdirSync(path.dirname(dst), { recursive: true });
      symlinkSync(priv, dst);
      note(`.config/ai-dev → ${priv}`);
    }
  }
}

function main(/** @type {string[]} */ argv) {
  const [cmd, ...flags] = argv;
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return note(USAGE.trimEnd()), 0;
  const unknown = flags.filter((f) => !["-g", "--global", "--link"].includes(f));
  if (cmd !== "install" || unknown.length) {
    process.stderr.write((cmd && cmd !== "install" ? `неизвестная команда: ${cmd}\n\n` : unknown.length ? `неизвестный флаг: ${unknown[0]}\n\n` : "") + USAGE);
    return 2;
  }
  const global = flags.includes("-g") || flags.includes("--global");
  const linkMode = flags.includes("--link");
  if (linkMode && (!global || !existsSync(path.join(SRC, ".git")))) {
    warn("--link — только с -g и только из клона ai-dev: в проект коммитится копия, а не ссылка на локальный клон");
    return 2;
  }
  if (global) installGlobal(linkMode);
  else installProject(linkMode);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
