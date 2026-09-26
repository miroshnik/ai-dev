#!/usr/bin/env node
// @ts-check
/**
 * ai-dev — установка флоу: общие правила, справочники и все скиллы ai-dev в проект или на машину; проверка, не
 * отстала ли установка от main ai-dev, и обновление.
 *
 *   npx -y github:miroshnik/ai-dev install                — в проект: корень git (или текущий каталог)
 *   npx -y github:miroshnik/ai-dev install -g             — на машину: ~/.agents и агенты, которые на ней есть
 *   node <клон ai-dev>/bin/ai-dev.mjs install -g --link   — из клона: симлинки на клон, правки видны сразу
 *   npx -y github:miroshnik/ai-dev check [-g]             — отстала ли установка: 0 — нет, 1 — да, 2 — не проверить
 *   npx -y github:miroshnik/ai-dev update [-g]            — довести установку до актуальной
 *
 * Раскладка как у скиллов (`npx skills`): канон в `.agents/` — `.agents/ai-dev/` (AGENTS.md, claude/CLAUDE.md,
 * docs/*.md) и `.agents/skills/<name>/`; Claude Code получает симлинки в `.claude/skills` и `.claude/rules`
 * (грузит их сам, независимо от CLAUDE.md проекта), остальные агенты — ссылку в `AGENTS.md` проекта или
 * симлинк своего глобального файла правил. `.agents/ai-dev.json` — SHA ai-dev, из которого поставлено, и список
 * поставленных скиллов: по нему переустановка убирает скиллы, которых в ai-dev больше нет, и не трогает чужие.
 *
 * `check` — та же установка вхолостую: свежий пакет (npx берёт его из main при каждом запуске) перечисляет, что бы
 * он изменил. Машина с `--link` — иначе: клон сверяется с `origin/main` после `git fetch`, `update` делает
 * `git pull --ff-only` и переставляет ссылки кодом из обновлённого клона.
 *
 * JavaScript, а не TypeScript, как скрипты скиллов: npx кладёт пакет в node_modules, а там Node типы не
 * стирает (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Без зависимостей, только node:-API.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Хук SessionStart Claude Code: в начале сессии — `check --hook` (машина и проект). Вывод хука с кодом 0 Claude Code
 * добавляет в контекст, с другим — нет, поэтому код всегда 0: и `check --hook`, и запасной `echo`, если npx не
 * запустился. Таймаут — чтобы сеть не держала старт; ошибка сессию не блокирует — страхует правило «Первый шаг
 * сессии» в AGENTS.md.
 */
const HOOK_COMMAND = `npx -y --loglevel=error github:${SOURCE} check --hook 2>&1 || echo "ai-dev check недоступен (код $?): работай по текущему флоу и скажи об этом"`;
const HOOK = { matcher: "startup|resume|clear", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] };

/** Файлы флоу в клоне: то, что `install` ставит из него (pathspec git). */
const FLOW = ["AGENTS.md", "claude/CLAUDE.md", ":(glob)docs/*.md", "skills"];
/** Строк списка изменений в выводе `check` — дальше «… и ещё N». */
const MAX_LINES = 20;

const USAGE = `Использование: ai-dev <команда> [-g]

  install            правила, справочники и все скиллы ai-dev — в проект (корень git или текущий каталог)
  install -g         то же на машину: ~/.agents и агенты, которые на ней есть
  install -g --link  из клона ai-dev: симлинки на клон вместо копий, правки видны сразу
  check [-g]         отстала ли установка от main ai-dev, ничего не меняет: 0 — актуально, 1 — отстаёт,
                     2 — проверка недоступна; копию сверяет свежий пакет, клон --link — origin/main
  check --hook       машина и проект разом для хука SessionStart Claude Code: код всегда 0, ошибки — в выводе
  update [-g]        довести до актуальной: клон --link — git pull --ff-only, копия — install

Запуск: npx -y github:${SOURCE} <команда> [-g]
`;

/**
 * Холостой прогон (`check`): вместо записи на диск установка складывает сюда, что бы она изменила; null — пишет.
 * @type {{ op: "+" | "-" | "~", path: string }[] | null}
 */
let dry = null;

/** @param {string} s */
const note = (s) => dry || process.stdout.write(s + "\n");
/** @param {string} s */
const warn = (s) => dry || process.stderr.write("!! " + s + "\n");

/** Что изменила бы установка: `+` появится, `-` уберётся, `~` изменится; каталог — с `/` в конце. @param {"+" | "-" | "~"} op @param {string} p */
const change = (op, p) => dry?.push({ op, path: p });

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

/** @param {string} a @param {string} b */
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** git в каталоге dir; ошибка — исключение. @param {string} dir @param {string[]} args */
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Первая строка stderr упавшей команды. @param {unknown} e */
function reason(e) {
  const err = /** @type {{ stderr?: string | Buffer, message?: string }} */ (e);
  return (String(err.stderr ?? "").trim() || String(err.message)).split("\n")[0];
}

/** @param {string | null | undefined} sha */
const short = (sha) => (sha ? sha.slice(0, 7) : null);

/**
 * SHA ai-dev, из которого идёт установка: у клона — HEAD; у пакета npx — из `resolved` lock-файла npm (npx ставит
 * пакет из GitHub архивом, без `.git`, коммит виден только там); иначе null.
 * @param {string} src
 */
function sourceSha(src) {
  if (existsSync(path.join(src, ".git"))) {
    try {
      return git(src, "rev-parse", "HEAD");
    } catch {
      return null;
    }
  }
  const nm = path.dirname(src);
  if (path.basename(nm) !== "node_modules") return null;
  for (const lock of [path.join(nm, ".package-lock.json"), path.join(nm, "..", "package-lock.json")]) {
    try {
      const resolved = JSON.parse(readFileSync(lock, "utf8")).packages?.[`node_modules/${path.basename(src)}`]?.resolved ?? "";
      const m = /#([0-9a-f]{40})$/.exec(resolved);
      if (m) return m[1];
    } catch {
      /* нет lock-файла */
    }
  }
  return null;
}

/** Строка симлинка dst → target, как её пишет link(). @param {string} target @param {string} dst @param {string} root */
function linkText(target, dst, root) {
  const inRoot = !path.relative(root, target).startsWith("..");
  return inRoot ? path.relative(path.dirname(dst), target) : target;
}

/**
 * Симлинк dst → target: внутри root — относительный (в проекте его коммитят), вне — абсолютный (относительный
 * ломается, если путь к root идёт через симлинк: macOS /var → /private/var). Заменяет симлинк и пустой файл;
 * чужой файл или каталог — предупреждение.
 * @param {string} target @param {string} dst @param {string} root
 */
function link(target, dst, root) {
  const st = lstat(dst);
  if (st && !st.isSymbolicLink() && !(st.isFile() && st.size === 0)) {
    return warn(`${path.relative(root, dst)} уже есть и это не симлинк — оставлен как есть`), false;
  }
  const text = linkText(target, dst, root);
  if (dry) {
    if (!st?.isSymbolicLink() || readlinkSync(dst) !== text) change(st ? "~" : "+", dst);
    return true;
  }
  if (st) rmSync(dst);
  mkdirSync(path.dirname(dst), { recursive: true });
  symlinkSync(text, dst);
  note(`${path.relative(root, dst)} → ${path.relative(root, target)}`);
  return true;
}

/** Каталог или симлинк — долой. @param {string} p */
const remove = (p) => lstat(p) && rmSync(p, { recursive: true, force: true });

/** Файлы каталога (и симлинки) рекурсивно: путь от dir → полный путь. .DS_Store Finder — не в счёт. @param {string} dir */
function walk(dir, rel = "", out = /** @type {Map<string, string>} */ (new Map())) {
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walk(dir, r, out);
    else out.set(r, path.join(dir, r));
  }
  return out;
}

/** @param {string} a @param {string} b */
function sameFile(a, b) {
  const [sa, sb] = [lstatSync(a), lstatSync(b)];
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  return readFileSync(a).equals(readFileSync(b));
}

/** Холостой прогон копии: чем каталог dst отличается от файлов expected (путь в dst → источник). @param {Map<string, string>} expected @param {string} dst */
function diffTree(expected, dst) {
  const st = lstat(dst);
  if (!st) return change("+", dst + "/");
  if (!st.isDirectory()) return change("~", dst);
  const actual = walk(dst);
  for (const [rel, src] of expected) {
    const have = actual.get(rel);
    if (!have) change("+", path.join(dst, rel));
    else if (!sameFile(src, have)) change("~", path.join(dst, rel));
  }
  for (const [rel, have] of actual) if (!expected.has(rel)) change("-", have);
}

/**
 * Каталог dst — копия каталога src или, при linkMode, симлинк на него; прежнее содержимое dst уходит целиком.
 * @param {string} src @param {string} dst @param {string} root @param {boolean} linkMode
 */
function placeDir(src, dst, root, linkMode) {
  if (dry) {
    if (!linkMode) return diffTree(walk(src), dst);
    if (lstat(dst) && !lstat(dst)?.isSymbolicLink()) return change("~", dst + "/");
    return void link(src, dst, root);
  }
  remove(dst);
  if (linkMode) return void link(src, dst, root);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

/** Скиллы ai-dev: каталоги skills/<name> с SKILL.md. @param {string} src */
function sourceSkills(src) {
  return readdirSync(path.join(src, "skills"))
    .filter((n) => existsSync(path.join(src, "skills", n, "SKILL.md")))
    .sort();
}

/**
 * Канон правил: `.agents/ai-dev/` — копия AGENTS.md, claude/CLAUDE.md и docs/*.md или симлинк на клон.
 * @param {string} src @param {string} root @param {boolean} linkMode
 */
function installRules(src, root, linkMode) {
  const canon = path.join(root, ".agents/ai-dev");
  if (linkMode) return placeDir(src, canon, root, true);
  const docs = readdirSync(path.join(src, "docs")).filter((f) => f.endsWith(".md") && statSync(path.join(src, "docs", f)).isFile());
  const files = ["AGENTS.md", "claude/CLAUDE.md", ...docs.map((f) => `docs/${f}`)];
  if (dry) return diffTree(new Map(files.map((rel) => [rel, path.join(src, rel)])), canon);
  remove(canon);
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(canon, rel)), { recursive: true });
    cpSync(path.join(src, rel), path.join(canon, rel));
  }
  note(`${path.relative(root, canon)}/ ← AGENTS.md, claude/CLAUDE.md, docs/ (${docs.length})`);
}

/** `.agents/ai-dev.json` установки; нет или битый — пустой. @param {string} root @returns {{ source?: string, sha?: string, skills?: string[] }} */
function readManifest(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, ".agents/ai-dev.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Скиллы: `.agents/skills/<name>` — копия (или симлинк на клон), Claude Code — симлинк из `.claude/skills`.
 * Чужой каталог с тем же именем не трогается; скиллы из прошлой установки, которых в ai-dev больше нет, убираются.
 * В `.agents/ai-dev.json` — SHA источника и поставленные скиллы; холостой прогон SHA не сравнивает: установка
 * актуальна, если совпадает то, что она ставит.
 * @param {string} src @param {string} root @param {boolean} linkMode @param {boolean} claude
 */
function installSkills(src, root, linkMode, claude) {
  const manifestPath = path.join(root, ".agents/ai-dev.json");
  const before = readManifest(root).skills ?? [];
  const names = sourceSkills(src);
  /** @type {string[]} */
  const installed = [];
  for (const name of names) {
    const dst = path.join(root, ".agents/skills", name);
    const st = lstat(dst);
    if (st && !st.isSymbolicLink() && !before.includes(name)) {
      warn(`${path.relative(root, dst)} уже есть и это не скилл ai-dev — оставлен; удали, чтобы поставить скилл ai-dev`);
      continue;
    }
    placeDir(path.join(src, "skills", name), dst, root, linkMode);
    installed.push(name);
  }
  if (!linkMode) note(`.agents/skills/ ← ${installed.join(", ")}`);
  if (claude) for (const name of installed) link(path.join(root, ".agents/skills", name), path.join(root, ".claude/skills", name), root);
  for (const name of before.filter((n) => !names.includes(n))) {
    const dst = path.join(root, ".agents/skills", name);
    if (dry) {
      if (lstat(dst)) change("-", dst + "/");
      continue;
    }
    remove(dst);
    if (lstat(path.join(root, ".claude/skills", name))?.isSymbolicLink()) rmSync(path.join(root, ".claude/skills", name));
    note(`${path.relative(root, dst)} — убран: в ai-dev его больше нет`);
  }
  if (dry) {
    const m = readManifest(root);
    if (m.source !== SOURCE || JSON.stringify(m.skills) !== JSON.stringify(installed)) change(existsSync(manifestPath) ? "~" : "+", manifestPath);
    return;
  }
  const sha = sourceSha(src);
  writeFileSync(manifestPath, JSON.stringify({ source: SOURCE, ...(sha ? { sha } : {}), skills: installed }, null, 2) + "\n");
}

/** Claude Code: правила из `.claude/rules` грузятся сами, при любом CLAUDE.md. @param {string} root */
function claudeRules(root) {
  link(path.join(root, ".agents/ai-dev/AGENTS.md"), path.join(root, ".claude/rules/ai-dev.md"), root);
  link(path.join(root, ".agents/ai-dev/claude/CLAUDE.md"), path.join(root, ".claude/rules/ai-dev-claude.md"), root);
}

/**
 * Хук SessionStart в `~/.claude/settings.json` (HOOK): свои настройки и хуки пользователя на месте, хук прошлой версии
 * заменяется, повторная установка его не дублирует.
 * @param {string} home
 */
function claudeHook(home) {
  const file = path.join(home, ".claude/settings.json");
  /** @type {{ hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> }} */
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return warn(`.claude/settings.json — не JSON: хук SessionStart не поставлен, добавь его сам: ${HOOK_COMMAND}`);
    }
  }
  const ours = (/** @type {{ command?: unknown }} */ h) => typeof h.command === "string" && h.command.includes(`${SOURCE} check --hook`);
  const groups = settings.hooks?.SessionStart ?? [];
  const count = groups.flatMap((g) => g.hooks ?? []).filter(ours).length;
  if (count === 1 && groups.some((g) => JSON.stringify(g) === JSON.stringify(HOOK))) return;
  if (dry) return change(existsSync(file) ? "~" : "+", file);
  const rest = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
  settings.hooks = { ...settings.hooks, SessionStart: [...rest, HOOK] };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  note(".claude/settings.json — хук SessionStart: ai-dev check --hook");
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
  if (out !== text) {
    if (dry) return change(text ? "~" : "+", file);
    writeFileSync(file, out);
  }
  note("AGENTS.md — блок со ссылкой на .agents/ai-dev/AGENTS.md");
}

/** Корень проекта: корень git или текущий каталог. */
function projectRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

/** @param {string} src @param {string} root */
function installProject(src, root) {
  installRules(src, root, false);
  installSkills(src, root, false, true);
  claudeRules(root);
  agentsBlock(root);
}

/** @param {string} src @param {boolean} linkMode */
function installGlobal(src, linkMode) {
  const home = os.homedir();
  const has = (/** @type {string} */ dir, /** @type {string} */ cmd = "") => existsSync(path.join(home, dir)) || (cmd !== "" && onPath(cmd));
  const claude = has(".claude", "claude");
  installRules(src, home, linkMode);
  installSkills(src, home, linkMode, claude);

  if (claude) {
    claudeRules(home);
    claudeHook(home);
    // install.sh ставил ~/.claude/CLAUDE.md симлинком на claude/CLAUDE.md, а тот импортировал AGENTS.md: с
    // ~/.claude/rules правила загрузились бы дважды
    const old = path.join(home, ".claude/CLAUDE.md");
    if (lstat(old)?.isSymbolicLink() && readlinkSync(old).endsWith(path.join("claude", "CLAUDE.md"))) {
      if (dry) change("-", old);
      else rmSync(old), note(".claude/CLAUDE.md — старый симлинк install.sh убран: правила теперь в .claude/rules");
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
    else if (dry) {
      if (!st || readlinkSync(dst) !== priv) change(st ? "~" : "+", dst);
    } else {
      if (st) rmSync(dst);
      mkdirSync(path.dirname(dst), { recursive: true });
      symlinkSync(priv, dst);
      note(`.config/ai-dev → ${priv}`);
    }
  }
}

/** Установка вхолостую: что бы она изменила. @param {() => void} fn */
function dryRun(fn) {
  dry = [];
  try {
    fn();
    return dry;
  } finally {
    dry = null;
  }
}

/** Строки списка: ограничены MAX_LINES. @param {string[]} lines */
function capped(lines) {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `  … и ещё ${lines.length - MAX_LINES}`] : lines;
}

/** Изменения холостого прогона — строками `  ~ путь`; на машине путь от `~/`. @param {{ op: string, path: string }[]} changes @param {string} root @param {boolean} global */
function changeLines(changes, root, global) {
  return changes.map((c) => `  ${c.op} ${global ? "~/" : ""}${path.relative(root, c.path)}${c.path.endsWith("/") ? "/" : ""}`);
}

/** @typedef {{ code: 0 | 1 | 2, text: string, absent?: boolean }} Result */

/** Проверка упала: что и почему. @param {boolean} global @param {unknown} e @returns {Result} */
const unavailable = (global, e) => ({ code: 2, text: `ai-dev ${global ? "на машине" : "в проекте"}: проверка недоступна — ${reason(e)}` });

/**
 * Отстала ли установка на машине (global) или в проекте. Копию сверяет этот пакет (SRC) холостой установкой, клон
 * `--link` — с `origin/main`.
 * @param {boolean} global @returns {Result}
 */
function check(global) {
  const home = os.homedir();
  const root = global ? home : projectRoot();
  const where = global ? "на машине" : "в проекте";
  const canon = path.join(root, ".agents/ai-dev");
  const st = lstat(canon);
  const installed = st || existsSync(path.join(root, ".agents/ai-dev.json"));
  // домашний каталог — установка машины, а не проект
  if (!installed || (!global && samePath(root, home))) return { code: 0, text: `ai-dev ${where}: не установлен`, absent: true };
  if (global && st?.isSymbolicLink()) return checkLink(home, path.resolve(path.dirname(canon), readlinkSync(canon)));
  const changes = dryRun(() => (global ? installGlobal(SRC, false) : installProject(SRC, root)));
  const fresh = short(sourceSha(SRC)) ?? "SHA неизвестен";
  if (!changes.length) return { code: 0, text: `ai-dev ${where}: актуально (${fresh})` };
  return {
    code: 1,
    text: [
      `ai-dev ${where}: отстаёт — стоит ${short(readManifest(root).sha) ?? "без SHA"}, свежий ${fresh}`,
      ...capped(changeLines(changes, root, global)),
      `Обновить: npx -y github:${SOURCE} update${global ? " -g" : ""}`,
    ].join("\n"),
  };
}

/**
 * Машина с `--link`: клон против `origin/main` после `git fetch` — файлы флоу, которых в клоне ещё нет, и ссылки,
 * которых не хватает (новый скилл, хук). Коммиты в main без файлов флоу — не отставание.
 * @param {string} home @param {string} clone @returns {Result}
 */
function checkLink(home, clone) {
  const where = `на машине (клон ${clone})`;
  let head, main, behind, files;
  try {
    git(clone, "fetch", "--quiet", "origin", "main");
    head = git(clone, "rev-parse", "HEAD");
    main = git(clone, "rev-parse", "origin/main");
    behind = Number(git(clone, "rev-list", "--count", "HEAD..origin/main"));
    files = git(clone, "diff", "--no-renames", "--name-status", "HEAD...origin/main", "--", ...FLOW).split("\n").filter(Boolean);
  } catch (e) {
    return { code: 2, text: `ai-dev ${where}: проверка недоступна — ${reason(e)}` };
  }
  const links = dryRun(() => installGlobal(clone, true));
  if (!files.length && !links.length) {
    const ahead = behind ? `; origin/main ${short(main)} впереди на ${behind}, флоу не затронут` : "";
    return { code: 0, text: `ai-dev ${where}: актуально (${short(head)}${ahead})` };
  }
  const op = (/** @type {string} */ status) => (status === "A" ? "+" : status === "D" ? "-" : "~");
  return {
    code: 1,
    text: [
      `ai-dev ${where}: отстаёт — клон ${short(head)}, origin/main ${short(main)}`,
      ...capped([...files.map((l) => `  ${op(l.split("\t")[0] ?? "")} ${l.split("\t")[1]}`), ...changeLines(links, home, true)]),
      `Обновить: npx -y github:${SOURCE} update -g`,
    ].join("\n"),
  };
}

/** Хук SessionStart: машина и проект одним выводом в контекст сессии; код всегда 0, ошибки — в stdout. */
function hook() {
  /** @type {Result[]} */
  const results = [];
  for (const global of [true, false]) {
    try {
      results.push(check(global));
    } catch (e) {
      results.push(unavailable(global, e));
    }
  }
  const shown = results.filter((r) => !r.absent);
  if (!shown.length) return 0;
  const tail = [];
  if (shown.some((r) => r.code === 1)) tail.push("Отстаёт — update, копию в проекте закоммитить, перечитать обновлённое.");
  if (shown.some((r) => r.code === 2)) tail.push("Проверка недоступна — работать по текущему флоу и сказать об этом.");
  note(["Флоу ai-dev (AGENTS.md, «Первый шаг сессии»):", ...shown.map((r) => r.text), ...tail].join("\n"));
  return 0;
}

/**
 * Довести установку до актуальной. Машина с `--link` — `updateLink`; копия — `install` этим пакетом, в проекте с
 * подсказкой коммита.
 * @param {boolean} global
 */
function update(global) {
  if (global) {
    const canon = path.join(os.homedir(), ".agents/ai-dev");
    if (lstat(canon)?.isSymbolicLink()) return updateLink(path.resolve(path.dirname(canon), readlinkSync(canon)));
    installGlobal(SRC, false);
    return 0;
  }
  installProject(SRC, projectRoot());
  const sha = short(sourceSha(SRC));
  note(
    [
      "Копию в проекте — отдельным коммитом в ветку текущей задачи:",
      `  git add -A .agents .claude/rules .claude/skills AGENTS.md && git commit -m "chore(agents): флоу ai-dev${sha ? ` ${sha}` : ""}"`,
    ].join("\n"),
  );
  return 0;
}

/**
 * Клон `--link`: только main и без изменений в отслеживаемых файлах — иначе отказ (код 1), клон не трогаем: это
 * работа пользователя. Затем `git pull --ff-only` и `install -g --link` кодом из обновлённого клона: этот процесс
 * мог загрузить его старую версию, а ссылки нужны и новым скиллам.
 * @param {string} clone
 */
function updateLink(clone) {
  let branch = "";
  try {
    branch = git(clone, "symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    /* HEAD отсоединён */
  }
  if (branch !== "main") return warn(`update: клон ${clone} не на main (${branch ? `ветка ${branch}` : "HEAD отсоединён"}) — переключи его сам и повтори`), 1;
  const dirty = execFileSync("git", ["-C", clone, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trimEnd();
  if (dirty) return warn(`update: в клоне ${clone} изменения в отслеживаемых файлах — закоммить или убери их сам и повтори:\n${dirty}`), 1;
  const before = git(clone, "rev-parse", "HEAD");
  try {
    git(clone, "pull", "--ff-only", "--quiet", "origin", "main");
  } catch (e) {
    return warn(`update: git pull --ff-only в клоне ${clone} — ${reason(e)}`), 2;
  }
  note(`клон ${clone}: ${short(before)} → ${short(git(clone, "rev-parse", "HEAD"))}`);
  return spawnSync(process.execPath, [path.join(clone, "bin/ai-dev.mjs"), "install", "-g", "--link"], { stdio: "inherit" }).status ?? 2;
}

/** @type {Record<string, string[]>} */
const FLAGS = { install: ["-g", "--global", "--link"], check: ["-g", "--global", "--hook"], update: ["-g", "--global"] };

function main(/** @type {string[]} */ argv) {
  const [cmd = "", ...flags] = argv;
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return note(USAGE.trimEnd()), 0;
  const allowed = Object.hasOwn(FLAGS, cmd) ? FLAGS[cmd] : undefined;
  const unknown = allowed ? flags.filter((f) => !allowed.includes(f)) : [];
  if (!allowed || unknown.length) {
    process.stderr.write((!allowed && cmd ? `неизвестная команда: ${cmd}\n\n` : unknown.length ? `неизвестный флаг: ${unknown[0]}\n\n` : "") + USAGE);
    return 2;
  }
  const global = flags.includes("-g") || flags.includes("--global");
  if (cmd === "check") {
    if (flags.includes("--hook")) return hook();
    /** @type {Result} */
    let r;
    try {
      r = check(global);
    } catch (e) {
      r = unavailable(global, e);
    }
    (r.code === 2 ? process.stderr : process.stdout).write(r.text + "\n");
    return r.code;
  }
  if (cmd === "update") {
    try {
      return update(global);
    } catch (e) {
      return warn(`update: ${reason(e)}`), 2;
    }
  }
  const linkMode = flags.includes("--link");
  if (linkMode && (!global || !existsSync(path.join(SRC, ".git")))) {
    warn("--link — только с -g и только из клона ai-dev: в проект коммитится копия, а не ссылка на локальный клон");
    return 2;
  }
  if (global) installGlobal(SRC, linkMode);
  else installProject(SRC, projectRoot());
  return 0;
}

process.exitCode = main(process.argv.slice(2));
