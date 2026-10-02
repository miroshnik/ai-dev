#!/usr/bin/env node
// @ts-check
/**
 * ai-dev — установка флоу: общие правила, справочники и все скиллы ai-dev в проект или на машину; проверка, не
 * отстала ли установка от последнего релиза ai-dev, обновление и выпуск релиза.
 *
 *   npx -y github:miroshnik/ai-dev install                — в проект: корень git (или текущий каталог)
 *   npx -y github:miroshnik/ai-dev install -g             — на машину: только скиллы и хук, правила — из проекта
 *   node <клон ai-dev>/bin/ai-dev.mjs install -g --link   — из клона: симлинки на клон, правки видны сразу
 *   npx -y github:miroshnik/ai-dev check [-g]             — отстала ли установка: 0 — нет, 1 — да, 2 — не проверить
 *   npx -y github:miroshnik/ai-dev update [-g]            — довести установку до актуальной
 *   node <клон ai-dev>/bin/ai-dev.mjs release             — выпустить релиз: тег и список изменений флоу
 *
 * Раскладка как у скиллов (`npx skills`): канон в `.agents/` — `.agents/ai-dev/` (AGENTS.md, claude/CLAUDE.md,
 * docs/*.md) и `.agents/skills/<name>/`; Claude Code получает симлинки в `.claude/skills` и `.claude/rules`
 * (грузит их сам, независимо от CLAUDE.md проекта), остальные агенты — ссылку в `AGENTS.md` проекта. На машине
 * (`-g`) правил нет — только скиллы (`~/.agents/skills`, `~/.claude/skills`) и хук: правила грузятся из проекта,
 * вторая копия на машине стоила бы ~20k токенов на каждом ходу каждого агента. `.agents/ai-dev.json` — SHA ai-dev,
 * из которого поставлено, список поставленных скиллов (по нему переустановка убирает скиллы, которых в ai-dev
 * больше нет, и не трогает чужие), у машины с `--link` — путь клона, у проекта — `auto`: ведёт ли агент задачу
 * целиком сам — ответы на вопросы по рекомендации, commit, push, починка CI и мерж своего PR по зелёным чекам
 * (AGENTS.md, «Что делаю без спроса, а что — по разрешению»). Его задаёт `install` в проекте — вопросом в терминале
 * или флагом `--auto` / `--no-auto`; по умолчанию «нет», без терминала и флага — прежнее значение, `update` его
 * сохраняет. С auto `install` подсказывает правило разрешений Claude Code на мерж (MERGE_HINT) — настройки машины
 * не меняет. В клон ai-dev флоу не ставится (канон — в его корне): `install` пишет в нём один манифест с `auto`.
 *
 * Копия (проект, машина без `--link`) следует за релизами ai-dev — тегами vГГГГ.ММ.ДД, — а не за main: пакет npx
 * (он из main) находит последний релиз и перезапускается из него (`toRelease`). `check` — та же установка вхолостую:
 * пакет релиза перечисляет, что бы он изменил. Машина с `--link` — иначе: клон сверяется с `origin/main` после
 * `git fetch`, `update` делает `git pull --ff-only` и переставляет ссылки кодом из обновлённого клона.
 *
 * JavaScript, а не TypeScript, как скрипты скиллов: npx кладёт пакет в node_modules, а там Node типы не
 * стирает (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Без зависимостей, только node:-API.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
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
/** Что делает релиз нужным: флоу и установщик — его код проекты тоже получают из релиза. */
const RELEASED = [...FLOW, "bin"];
/** Тег релиза: vГГГГ.ММ.ДД, патч того же дня — vГГГГ.ММ.ДД.N. */
const RELEASE_TAG = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.([1-9]\d*))?$/;
/** Строк списка изменений в выводе `check` — дальше «… и ещё N». */
const MAX_LINES = 20;

const USAGE = `Использование: ai-dev <команда> [-g]

  install            правила, справочники и все скиллы последнего релиза ai-dev — в проект (корень git или текущий
                     каталог); в терминале спрашивает, делать ли агенту задачи целиком самому — ответы по
                     рекомендации, commit, push, починка CI, мерж по зелёным чекам (auto в .agents/ai-dev.json,
                     по умолчанию — нет); без терминала — флаг --auto или --no-auto, без флага ответ прежний;
                     с auto подсказывает правило разрешений Claude Code на мерж — Bash(gh pr merge *) в
                     ~/.claude/settings.json: его ставит владелец, install настройки машины не меняет;
                     в клоне ai-dev пишет только auto
  install -g         на машину только скиллы (~/.agents/skills, ~/.claude/skills) и хук SessionStart; правила —
                     из проекта, копию на машине прошлой установки убирает
  install -g --link  из клона ai-dev: симлинки на клон вместо копий, правки видны сразу
  check [-g]         отстала ли установка, ничего не меняет: 0 — актуально, 1 — отстаёт, 2 — проверка недоступна;
                     копию сверяет последний релиз, клон --link — origin/main; у проекта называет режим (auto)
  check --hook       машина и проект разом для хука SessionStart Claude Code: код всегда 0, ошибки — в выводе
  update [-g]        довести до актуальной: клон --link — git pull --ff-only, копия — install последнего релиза
                     (режим проекта — auto — сохраняется)
  release [--dry-run]  из клона ai-dev: тег vГГГГ.ММ.ДД на origin/main и GitHub Release со списком изменений флоу
                     с прошлого релиза; --dry-run — только показать

Запуск: npx -y github:${SOURCE} <команда> [-g]
`;

/**
 * Холостой прогон (`check`): вместо записи на диск установка складывает сюда, что бы она изменила; null — пишет.
 * @type {{ op: "+" | "-" | "~", path: string }[] | null}
 */
let dry = null;

/** Тег релиза, из которого идёт установка (`toRelease`); null — не релиз: клон или релизов ещё нет. @type {string | null} */
let release = null;

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

/**
 * Релизы ai-dev по возрастанию — теги RELEASE_TAG из `git ls-remote --tags remote` (по дате, затем по номеру патча);
 * у аннотированного тега — SHA коммита, а не объекта тега. Чужие теги не в счёт. Ошибка git — исключение.
 * @param {string} remote URL или имя remote в cwd @param {string} [cwd]
 * @returns {{ tag: string, sha: string }[]}
 */
function releases(remote, cwd) {
  const out = execFileSync("git", ["ls-remote", "--tags", remote], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  /** @type {Map<string, string>} */
  const tags = new Map();
  for (const line of out.split("\n")) {
    const [sha, ref = ""] = line.split("\t");
    const m = /^refs\/tags\/([^^]+)(\^\{\})?$/.exec(ref);
    // `тег^{}` идёт после тега: коммит аннотированного тега
    if (sha && m?.[1] && RELEASE_TAG.test(m[1]) && (m[2] || !tags.has(m[1]))) tags.set(m[1], sha);
  }
  const key = (/** @type {string} */ tag) => (RELEASE_TAG.exec(tag) ?? []).slice(1).map((n) => Number(n ?? 0));
  const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.reduce((r, n, i) => r || n - (b[i] ?? 0), 0);
  return [...tags].map(([tag, sha]) => ({ tag, sha })).sort((a, b) => cmp(key(a.tag), key(b.tag)));
}

/**
 * Копия следует за релизами ai-dev, а не за main: пакет npx (он из main) находит последний релиз и, если сам им не
 * является, перезапускается из него по SHA — дальше и код, и файлы релиза. AI_DEV_RELEASE — тег, из которого
 * перезапущен: второй раз не ищет. Релизов ещё нет — работает сам, как раньше; клон ставит себя как есть. Теги —
 * из AI_DEV_REPO (зеркало, тесты) или GitHub.
 * @param {string[]} argv @returns {number | null} код перезапущенного; null — работать здесь
 */
function toRelease(argv) {
  if (existsSync(path.join(SRC, ".git"))) return null;
  const pinned = process.env.AI_DEV_RELEASE;
  if (pinned) return (release = pinned), null;
  let latest;
  try {
    latest = releases(process.env.AI_DEV_REPO || `https://github.com/${SOURCE}.git`).at(-1);
  } catch (e) {
    throw new Error(`последний релиз ai-dev не узнать — ${reason(e)}`);
  }
  if (!latest) return null;
  if (latest.sha === sourceSha(SRC)) return (release = latest.tag), null;
  const r = spawnSync("npx", ["-y", "--loglevel=error", `github:${SOURCE}#${latest.sha}`, ...argv], {
    stdio: "inherit",
    env: { ...process.env, AI_DEV_RELEASE: latest.tag },
  });
  if (r.error) throw new Error(`релиз ${latest.tag} не запустить — ${reason(r.error)}`);
  return r.status ?? 2;
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

/** `.agents/ai-dev.json` установки; нет или битый — пустой. @param {string} root @returns {{ source?: string, sha?: string, tag?: string, clone?: string, skills?: string[], auto?: boolean }} */
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
 * В `.agents/ai-dev.json` — SHA источника, тег релиза и поставленные скиллы; холостой прогон SHA и тег не сравнивает:
 * установка актуальна, если совпадает то, что она ставит (релиз с правкой одного установщика проекты не трогает).
 * auto — настройка проекта «задача целиком без спроса», пишется всегда; у машины её нет (undefined).
 * Холостой прогон её тоже не сравнивает: правка поля руками установку «отставшей» не делает.
 * @param {string} src @param {string} root @param {boolean} linkMode @param {boolean} claude @param {boolean} [auto]
 */
function installSkills(src, root, linkMode, claude, auto) {
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
  const clone = linkMode ? path.resolve(src) : undefined; // машина с --link: по нему check и update находят клон
  if (dry) {
    const m = readManifest(root);
    if (m.source !== SOURCE || JSON.stringify(m.skills) !== JSON.stringify(installed) || m.clone !== clone) change(existsSync(manifestPath) ? "~" : "+", manifestPath);
    return;
  }
  const sha = sourceSha(src);
  const manifest = { source: SOURCE, ...(sha ? { sha } : {}), ...(release ? { tag: release } : {}), ...(clone ? { clone } : {}), skills: installed, ...(auto === undefined ? {} : { auto }) };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
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

/** Корень git-репозитория текущего каталога; null — не репозиторий. */
function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Корень проекта: корень git или текущий каталог. */
function projectRoot() {
  return gitRoot() ?? process.cwd();
}

/** Клон ai-dev: канон в нём — корневой AGENTS.md, ставить флоу в него не нужно. @param {string} root */
function isAiDevClone(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === "ai-dev";
  } catch {
    return false;
  }
}

/** Ведёт ли агент задачу целиком сам — `auto` манифеста проекта; нет поля — «нет». @param {string} root */
const autoOf = (root) => readManifest(root).auto === true;

/** Строка режима проекта в выводе `check`. @param {string} root */
const modeLine = (root) => `  задачи: ${autoOf(root) ? "целиком сам" : "по разрешению"}`;

const CLONE_NOTE = "клон ai-dev: флоу в него не ставится — канон в корне";

/** Клон ai-dev: из установки в нём — только режим, манифест из одного поля. @param {string} root @param {boolean} auto */
function installClone(root, auto) {
  const file = path.join(root, ".agents/ai-dev.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ auto }, null, 2) + "\n");
  note(`.agents/ai-dev.json — auto: ${auto}; ${CLONE_NOTE}`);
}

/**
 * auto — режим проекта; его задаёт только `install` (флаг или вопрос в терминале), `update` и `check` идут с прежним
 * значением манифеста.
 * @param {string} src @param {string} root @param {boolean} [auto]
 */
function installProject(src, root, auto = autoOf(root)) {
  installRules(src, root, false);
  installSkills(src, root, false, true, auto);
  claudeRules(root);
  agentsBlock(root);
}

/** Глобальные файлы правил агентов, которые прошлая установка делала симлинками на `~/.agents/ai-dev/AGENTS.md`. */
const AGENT_RULE_FILES = [".codex/AGENTS.md", ".gemini/GEMINI.md", ".copilot/copilot-instructions.md", ".config/opencode/AGENTS.md", ".config/amp/AGENTS.md"];

/**
 * Правил на машине нет: их грузит проект (`.claude/rules`, `AGENTS.md`), а вторая копия с машины — те же ~20k токенов
 * на каждом ходу каждого агента. Прошлая установка их ставила — убираем: `~/.agents/ai-dev` (копия или симлинк на
 * клон), симлинки `~/.claude/rules/ai-dev*.md` и симлинки глобальных файлов агентов на канон. Чужой файл и чужой
 * симлинк не трогаем.
 * @param {string} home
 */
function removeGlobalRules(home) {
  const canon = path.join(home, ".agents/ai-dev");
  const st = lstat(canon);
  if (st) {
    if (dry) change("-", canon + "/");
    else if (st.isSymbolicLink()) rmSync(canon);
    else rmSync(canon, { recursive: true, force: true });
  }
  /** @type {string[]} */
  const removed = [];
  for (const rel of [".claude/rules/ai-dev.md", ".claude/rules/ai-dev-claude.md", ...AGENT_RULE_FILES]) {
    const file = path.join(home, rel);
    const ls = lstat(file);
    if (!ls?.isSymbolicLink() || !path.resolve(path.dirname(file), readlinkSync(file)).startsWith(canon + path.sep)) continue;
    if (dry) change("-", file);
    else rmSync(file), removed.push(rel);
  }
  if (!dry && (st || removed.length)) note(`правила на машине убраны (${[st ? ".agents/ai-dev/" : "", ...removed].filter(Boolean).join(", ")}): правила грузятся из проекта`);
}

/** @param {string} src @param {boolean} linkMode */
function installGlobal(src, linkMode) {
  const home = os.homedir();
  const has = (/** @type {string} */ dir, /** @type {string} */ cmd = "") => existsSync(path.join(home, dir)) || (cmd !== "" && onPath(cmd));
  const claude = has(".claude", "claude");
  installSkills(src, home, linkMode, claude);
  removeGlobalRules(home);

  if (claude) {
    claudeHook(home);
    // install.sh ставил ~/.claude/CLAUDE.md симлинком на claude/CLAUDE.md, а тот импортировал AGENTS.md
    const old = path.join(home, ".claude/CLAUDE.md");
    if (lstat(old)?.isSymbolicLink() && readlinkSync(old).endsWith(path.join("claude", "CLAUDE.md"))) {
      if (dry) change("-", old);
      else rmSync(old), note(".claude/CLAUDE.md — старый симлинк install.sh убран: правила теперь только из проекта");
    }
  }

  if (has(".cursor")) note("Cursor: скиллы видит в ~/.agents/skills; правила — из AGENTS.md проекта");

  // Место личной конфигурации по умолчанию. AI_DEV_CONFIG_DIR здесь намеренно не читается: переменная переопределяет
  // каталог целиком, симлинк ей не нужен — скрипты скиллов смотрят туда, куда она указывает (tests/standards/config-dir).
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
 * Клон, на который ссылается установка `--link` на машине: путь из манифеста; у установки прошлой версии — симлинк
 * `~/.agents/ai-dev` (его `update -g` уберёт и запишет путь). null — копия или не установлено.
 * @param {string} home
 */
function linkedClone(home) {
  const m = readManifest(home);
  if (typeof m.clone === "string") return m.clone;
  const canon = path.join(home, ".agents/ai-dev");
  return lstat(canon)?.isSymbolicLink() ? path.resolve(path.dirname(canon), readlinkSync(canon)) : null;
}

/** Установка на машине (global) или в проекте: корень и стоит ли там флоу. @param {boolean} global */
function target(global) {
  const home = os.homedir();
  const root = global ? home : projectRoot();
  const canon = path.join(root, ".agents/ai-dev");
  // домашний каталог — установка машины, а не проект; клон ai-dev — сам канон: манифест в нём хранит только режим
  const installed = Boolean(lstat(canon) || existsSync(path.join(root, ".agents/ai-dev.json"))) && (global || (!samePath(root, home) && !isAiDevClone(root)));
  return { home, root, canon, installed };
}

/**
 * Отстала ли установка на машине (global) или в проекте. Копию сверяет этот пакет (SRC, релиз — `toRelease`)
 * холостой установкой, клон `--link` — с `origin/main`.
 * @param {boolean} global @returns {Result}
 */
function check(global) {
  const { home, root, installed } = target(global);
  const where = global ? "на машине" : "в проекте";
  // клон ai-dev сверять не с чем, но режим сессии в нём нужен — как в проекте
  if (!installed && !global && isAiDevClone(root)) return { code: 0, text: [`ai-dev ${where}: не установлен — клон ai-dev, канон в корне`, modeLine(root)].join("\n") };
  if (!installed) return { code: 0, text: `ai-dev ${where}: не установлен`, absent: true };
  const clone = global ? linkedClone(home) : null;
  if (clone) return checkLink(home, clone);
  const changes = dryRun(() => (global ? installGlobal(SRC, false) : installProject(SRC, root)));
  const fresh = release ?? short(sourceSha(SRC)) ?? "SHA неизвестен";
  // режим — настройка проекта: последней строкой, её видит и начало сессии (хук)
  const mode = global ? [] : [modeLine(root)];
  if (!changes.length) return { code: 0, text: [`ai-dev ${where}: актуально (${fresh})`, ...mode].join("\n") };
  const m = readManifest(root);
  return {
    code: 1,
    text: [
      `ai-dev ${where}: отстаёт — стоит ${m.tag ?? short(m.sha) ?? "без SHA"}, свежий ${fresh}`,
      ...capped(changeLines(changes, root, global)),
      `Обновить: npx -y github:${SOURCE} update${global ? " -g" : ""}`,
      ...mode,
    ].join("\n"),
  };
}

/**
 * Машина с `--link`: клон против `origin/main` после `git fetch` — файлы скиллов, которых в клоне ещё нет, и ссылки,
 * которых не хватает (новый скилл, хук). Правила и справочники в main машину не задевают (их грузит проект), коммиты
 * без файлов скиллов — не отставание.
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
    files = git(clone, "diff", "--no-renames", "--name-status", "HEAD...origin/main", "--", "skills").split("\n").filter(Boolean);
  } catch (e) {
    return { code: 2, text: `ai-dev ${where}: проверка недоступна — ${reason(e)}` };
  }
  const links = dryRun(() => installGlobal(clone, true));
  if (!files.length && !links.length) {
    const ahead = behind ? `; origin/main ${short(main)} впереди на ${behind}, флоу не затронут` : "";
    return { code: 0, text: [`ai-dev ${where}: актуально (${short(head)}${ahead})`, ...unreleased(clone)].join("\n") };
  }
  const op = (/** @type {string} */ status) => (status === "A" ? "+" : status === "D" ? "-" : "~");
  return {
    code: 1,
    text: [
      `ai-dev ${where}: отстаёт — клон ${short(head)}, origin/main ${short(main)}`,
      ...capped([...files.map((l) => `  ${op(l.split("\t")[0] ?? "")} ${l.split("\t")[1]}`), ...changeLines(links, home, true)]),
      `Обновить: npx -y github:${SOURCE} update -g`,
      ...unreleased(clone),
    ].join("\n"),
  };
}

/**
 * Напоминание владельцу на машине с клоном `--link`: в origin/main есть изменения флоу, которых нет в последнем
 * релизе, — проекты их не получат, пока он не выйдет. Не отставание: код проверки не меняет. Не узнать — строки нет.
 * @param {string} clone @returns {string[]}
 */
function unreleased(clone) {
  const cmd = `выпустить: node ${path.join(clone, "bin/ai-dev.mjs")} release`;
  try {
    const last = releases("origin", clone).at(-1);
    if (!last) return [`  не в релизе: релизов ещё нет — ${cmd}`];
    const n = Number(git(clone, "rev-list", "--count", "--first-parent", `${last.sha}..origin/main`, "--", ...RELEASED));
    return n ? [`  не в релизе: коммитов флоу после ${last.tag} — ${n}; ${cmd}`] : [];
  } catch {
    return [];
  }
}

/**
 * Хук SessionStart: машина и проект одним выводом в контекст сессии; код всегда 0, ошибки — в stdout. failed —
 * последний релиз не узнать: установленное — «проверка недоступна».
 * @param {unknown} [failed]
 */
function hook(failed) {
  /** @type {Result[]} */
  const results = [];
  for (const global of [true, false]) {
    try {
      results.push(failed && target(global).installed ? unavailable(global, failed) : check(global));
    } catch (e) {
      results.push(unavailable(global, e));
    }
  }
  const shown = results.filter((r) => !r.absent);
  // правила грузятся только из проекта: git-репозиторий без флоу — как поставить (клон ai-dev — сам канон, он не absent)
  if (results[1]?.absent && gitRoot()) shown.push({ code: 0, text: `ai-dev в проекте: не установлен — поставь: npx -y github:${SOURCE} install` });
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
    const clone = linkedClone(os.homedir());
    if (clone) return updateLink(clone);
    installGlobal(SRC, false);
    return 0;
  }
  const root = projectRoot();
  if (isAiDevClone(root)) return note(CLONE_NOTE), 0;
  installProject(SRC, root);
  const version = release ?? short(sourceSha(SRC));
  note(
    [
      "Копию в проекте — отдельным коммитом в ветку текущей задачи:",
      `  git add -A .agents .claude/rules .claude/skills AGENTS.md && git commit -m "chore(agents): флоу ai-dev${version ? ` ${version}` : ""}"`,
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

/**
 * Релиз — шаг владельца, из клона: тег vГГГГ.ММ.ДД (дата по UTC; второй за день — .1, .2…) на origin/main и GitHub
 * Release со списком изменений с прошлого релиза — коммиты первого родителя, затронувшие флоу или установщик (PR,
 * влитый merge-коммитом, — заголовком и номером; влитый rebase — своими коммитами с номером задачи из `Refs #N`).
 * Выпускать нечего — отказ (код 1): проекты не должны обновляться впустую.
 * @param {boolean} preview `--dry-run`: показать тег и список, ничего не создавать
 */
function releaseCmd(preview) {
  if (!existsSync(path.join(SRC, ".git"))) return warn("release — только из клона ai-dev: node <клон>/bin/ai-dev.mjs release"), 2;
  let head, tags, log;
  try {
    git(SRC, "fetch", "--quiet", "origin", "main");
    head = git(SRC, "rev-parse", "origin/main");
    tags = releases("origin", SRC);
    const last = tags.at(-1);
    log = last ? git(SRC, "log", "--first-parent", "--format=%s%x1f%b%x1e", `${last.sha}..${head}`, "--", ...RELEASED) : "";
  } catch (e) {
    return warn(`release: ${reason(e)}`), 2;
  }
  const last = tags.at(-1);
  if (last?.sha === head) return warn(`release: origin/main ${short(head)} уже в релизе ${last.tag}`), 1;
  if (last && !log) return warn(`release: с ${last.tag} флоу не менялся — релиз не нужен`), 1;
  const items = log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      const pr = /^Merge pull request #(\d+) /.exec(subject);
      const title = body.trim().split("\n")[0];
      if (pr && title) return `- ${title} (#${pr[1]})`;
      const refs = [...new Set([...body.matchAll(/^Refs #(\d+)/gm)].map((m) => `#${m[1]}`))];
      return refs.length ? `- ${subject} (${refs.join(", ")})` : `- ${subject}`;
    });
  const notes = last ? [`Изменения флоу с ${last.tag}:`, "", ...items].join("\n") : "Первый релиз: проекты ставят и обновляют флоу по релизам ai-dev, а не по main.";
  const day = `v${new Date().toISOString().slice(0, 10).replaceAll("-", ".")}`;
  const names = new Set(tags.map((t) => t.tag));
  let tag = day;
  for (let n = 1; names.has(tag); n++) tag = `${day}.${n}`;
  note(`${tag} → ${short(head)}\n\n${notes}`);
  if (preview) return 0;
  try {
    execFileSync("gh", ["release", "create", tag, "--repo", SOURCE, "--target", head, "--title", tag, "--notes", notes], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return warn(`release: gh release create — ${reason(e)}`), 2;
  }
  note(`\nРелиз ${tag}: https://github.com/${SOURCE}/releases/tag/${tag}`);
  return 0;
}

/** Вопрос `install` в проекте о настройке `auto`: «да» разрешает агенту всё перечисленное без «да» на каждое действие. */
const AUTO_QUESTION = "Делать задачи целиком самому — ответы по рекомендации, commit, push, починка CI, мерж по зелёным чекам?";

/**
 * Вопрос «да/нет» в терминале: Enter — значение по умолчанию (оно заглавной буквой), непонятный ответ — вопрос снова.
 * Синхронно и без зависимостей — `readSync(0)`: `main` синхронный. Ввод закрыт или не читается — значение по
 * умолчанию.
 * @param {string} question @param {boolean} def
 */
function ask(question, def) {
  const buf = Buffer.alloc(1024);
  for (;;) {
    process.stdout.write(`${question} [${def ? "Y/n" : "y/N"}] `);
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch {
      return def;
    }
    const answer = buf.toString("utf8", 0, n).trim().toLowerCase();
    if (!n || !answer) return def;
    if (["y", "yes", "д", "да"].includes(answer)) return true;
    if (["n", "no", "н", "нет"].includes(answer)) return false;
  }
}

/**
 * Подсказка `install` с auto. Мерж без ревью человека приложение Claude Code отклоняет и в режиме auto: его решает
 * правило разрешений машины, а оно действует на все её репозитории — шире проекта. Поэтому `install` правило называет,
 * а не ставит: иначе владелец узнаёт о нём из отказа в конце первой задачи.
 */
const MERGE_HINT = [
  "Claude Code: чтобы сессия вливала свой PR сама, нужно правило разрешений машины — его ставит владелец, install настройки не трогает:",
  '  ~/.claude/settings.json → permissions.allow: "Bash(gh pr merge *)"',
  "  без правила приложение мерж без ревью человека отклоняет — сессия закончит «Осталось: мерж — от владельца»",
].join("\n");

/** @type {Record<string, string[]>} */
const FLAGS = { install: ["-g", "--global", "--link", "--auto", "--no-auto"], check: ["-g", "--global", "--hook"], update: ["-g", "--global"], release: ["--dry-run"] };

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
  if (cmd === "release") return releaseCmd(flags.includes("--dry-run"));
  const hookMode = cmd === "check" && flags.includes("--hook");
  // «не установлен» релиз не нужен: хук в чужом проекте не ходит в сеть зря
  if (cmd !== "check" || (hookMode ? [true, false].some((g) => target(g).installed) : target(global).installed)) {
    try {
      const code = toRelease(argv);
      if (code !== null) return code;
    } catch (e) {
      if (hookMode) return hook(e);
      if (cmd === "check") return process.stderr.write(unavailable(global, e).text + "\n"), 2;
      return warn(`${cmd}: ${reason(e)}`), 2;
    }
  }
  if (cmd === "check") {
    if (hookMode) return hook();
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
  const [on, off] = [flags.includes("--auto"), flags.includes("--no-auto")];
  if ((on || off) && (global || (on && off))) {
    warn("--auto и --no-auto — настройка проекта «задача целиком без спроса»: без -g и только один из двух");
    return 2;
  }
  if (global) return installGlobal(SRC, linkMode), 0;
  const root = projectRoot();
  const before = autoOf(root);
  // вопрос — только здесь и только в терминале: `update` и `check` (хук в начале сессии) идут через installProject без него
  const auto = on ? true : off ? false : isatty(0) && isatty(1) ? ask(AUTO_QUESTION, before) : before;
  if (isAiDevClone(root)) installClone(root, auto);
  else installProject(SRC, root, auto);
  if (auto) note(MERGE_HINT);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
