#!/usr/bin/env bun
/**
 * ai-dev — installs the flow: the shared rules, references and all ai-dev skills into a project or onto the machine;
 * checks whether an install has fallen behind the latest ai-dev release, updates it and cuts a release.
 *
 *   bunx github:miroshnik/ai-dev install                — into the project: the git root (or the current directory)
 *   bunx github:miroshnik/ai-dev install -g             — machine-wide: skills and hook only, rules from the project
 *   bun <ai-dev clone>/bin/ai-dev.ts install -g --link  — from a clone: symlinks to the clone, edits show at once
 *   bunx github:miroshnik/ai-dev check [-g]             — is the install behind: 0 — no, 1 — yes, 2 — can't tell
 *   bunx github:miroshnik/ai-dev update [-g]            — bring the install up to date
 *   bun <ai-dev clone>/bin/ai-dev.ts release            — cut a release: a tag and the list of flow changes
 *
 * The layout is as with skills (`npx skills`): the canon is in `.agents/` — `.agents/ai-dev/` (AGENTS.md,
 * claude/CLAUDE.md, docs/*.md) and `.agents/skills/<name>/`; Claude Code gets symlinks in `.claude/skills` and
 * `.claude/rules` (it loads them itself, whatever the project's CLAUDE.md), the other agents — a link in the project's
 * `AGENTS.md`. On the machine (`-g`) there are no rules — only skills (`~/.agents/skills`, `~/.claude/skills`) and the
 * hook: rules load from the project, a second copy on the machine would cost ~20k tokens on every turn of every agent.
 * `.agents/ai-dev.json` — the ai-dev SHA it was installed from, the list of installed skills (by it a reinstall removes
 * skills ai-dev no longer has and leaves others' alone), for a machine with `--link` — the clone path, for a project —
 * `auto`: whether the agent runs a task entirely by itself — answers to questions by recommendation, commit, push,
 * fixing CI and merging its own PR on green checks (AGENTS.md, "What I do without asking and what needs a yes"), and
 * `language` — the language the agent works in in the project: dialog, tasks, prompts, documents (AGENTS.md,
 * "Language"); the flow is written in English. `install` in a project sets them — by a question in the terminal or by
 * the flags `--auto` / `--no-auto` and `--lang <code>`; by default auto is "no", the language is `en`, without a
 * terminal and a flag — the previous value, `update` keeps it. An install of a previous version has no `language`
 * field, and the flow before it worked only in Russian: its language is `ru` (`LEGACY_LANGUAGE` of the github skill's
 * language module), `update` writes it. With auto `install` suggests the Claude Code permission rule for the merge
 * (MERGE_HINT) — it doesn't change the machine's settings. The flow isn't installed into an ai-dev clone (the canon is
 * at its root): `install` writes a single manifest there, with `auto` and `language`.
 * The copy in a project is committed — the flow files the project's git ignores (the `CLAUDE.md` template, the
 * `.claude/` directory) the install un-ignores with exceptions in an ai-dev block at the end of `.gitignore`, `check`
 * reports them as a mismatch (`gitignoreFlow`). A project's compose file `check` holds to the task isolation rules
 * with the task-env skill's command (`composeCheck`): a violation is a mismatch too, `update` doesn't fix it. The
 * project's checks — the `package.json` scripts `lint`, `typecheck`, `test`, `test:*` — the install wraps in the
 * machine queue, the slot skill (`slotScripts`); if such a script calls turbo and turbo.json doesn't pass the queue
 * variables to tasks, it warns with a ready-made line (`turboEnv`).
 *
 * A copy (a project, a machine without `--link`) follows ai-dev releases — tags vYYYY.MM.DD — not main: the bunx
 * package from main is only a launcher — it finds the latest release and restarts from it by SHA (`toRelease`).
 * `check` is the same install as a dry run: the release package lists what it would change. A machine with `--link`
 * is different: the clone is compared with `origin/main` after `git fetch`, `update` does `git pull --ff-only` and
 * re-creates the links with the code of the updated clone.
 * `update` says what changed — the agent tells the user: a copy — every release after the installed one, newest first,
 * with the list of changes its GitHub Release has (one function, `changeItems`, builds both); a `--link` clone — the
 * flow commits it pulled.
 *
 * TypeScript under Bun, like the skills' scripts: bunx runs the package's bin by its shebang, and Bun strips types in
 * node_modules too — so the installer imports the skills' values (the language module, the task-env compose files and
 * proxy name) instead of holding copies. No dependencies, only node: APIs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import locale from "../skills/github/scripts/locale.ts";
import { COMPOSE_FILES, proxyName } from "../skills/task-env/scripts/task-env.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SOURCE = "miroshnik/ai-dev";
/** The command the output names: the installer from GitHub through bunx, then the subcommand. */
const RUN = `bunx github:${SOURCE}`;
const BEGIN = "<!-- ai-dev:begin";
const END = "<!-- ai-dev:end -->";
const BLOCK = [
  `${BEGIN} — set by \`${RUN} install\`, don't edit by hand -->`,
  "Shared rules — `.agents/ai-dev/AGENTS.md`: read them before starting work (references — `.agents/ai-dev/docs/`).",
  "Skills — `.agents/skills/`.",
  END,
].join("\n");

/**
 * Claude Code's SessionStart hook: at the start of a session — `check --hook` (machine and project) and the agent's Bash
 * environment (`writeAgentShell`). Claude Code adds the output of a hook with code 0 to the context, with any other
 * code — doesn't, so the code is always 0: both `check --hook` and the fallback `echo` if bunx didn't start.
 * `--silent` — the first install of the package prints bunx's progress to stderr, and the hook's output goes into the
 * context. The timeout keeps the network from holding up the start; an error doesn't block the session — the "First
 * step of a session" rule in AGENTS.md is the safety net.
 */
const HOOK_COMMAND = `bunx --silent github:${SOURCE} check --hook 2>&1 || echo "ai-dev check unavailable (exit $?): work by the current flow and say so"`;
const HOOK = { matcher: "startup|resume|clear", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] };

/** Flow files in the clone: what `install` installs from it (a git pathspec). */
const FLOW = ["AGENTS.md", "claude/CLAUDE.md", ":(glob)docs/*.md", "skills"];
/** What makes a release necessary: the flow and the installer — projects get its code from the release too. */
const RELEASED = [...FLOW, "bin"];
/** Release tag: vYYYY.MM.DD, a same-day patch — vYYYY.MM.DD.N. */
const RELEASE_TAG = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.([1-9]\d*))?$/;
/** ai-dev releases on GitHub: a release's page is `${RELEASES}/tag/<tag>`. */
const RELEASES = `https://github.com/${SOURCE}/releases`;
/** Lines of the change list in `check` output — beyond that, "… and N more". */
const MAX_LINES = 20;
/** The compose file check — a command of the task-env skill, from the package `check` runs from. */
const TASK_ENV = path.join(SRC, "skills/task-env/scripts/task-env.ts");
/** bun start and `docker compose config` take a fraction of a second; the hook has 60 s for everything. */
const TASK_ENV_TIMEOUT = 30_000;

/**
 * Help — `--help` or `-h` anywhere in the arguments (tests/standards/cli-help): a command's synopsis (the first
 * paragraph), what it does and examples; `ai-dev --help` — the synopses of all. Answered before the launcher goes to the
 * release (`toRelease`) — by the launcher's own version: no network, at the cost of lagging behind a newer release. The
 * dispatcher takes only the commands from here (their flags — `FLAGS`).
 */
const HELP: Record<string, string> = {
  install: `ai-dev install [--auto | --no-auto] [--lang <code>]
ai-dev install -g [--link]

Rules, references and all skills of the latest ai-dev release — into the project (the git root or the current
directory); in a terminal asks whether the agent does tasks entirely by itself — answers by recommendation, commit, push,
fixing CI, merge on green checks (auto in .agents/ai-dev.json, default — no); without a terminal — the --auto or
--no-auto flag, without the flag the previous answer stays; with auto prints the Claude Code permission rule for the
merge — Bash(gh pr merge *) in ~/.claude/settings.json: the owner adds it, install doesn't change the machine's
settings. --lang <code> — the project language the agent works in: dialog, tasks, prompts, documents (language in
.agents/ai-dev.json, a BCP 47 code: ru, en, pt-BR); in a terminal — a question, en by default, without the flag and a
terminal — the previous one. In an ai-dev clone writes only auto and language.
-g — onto the machine only the skills (~/.agents/skills, ~/.claude/skills) and the SessionStart hook; the rules come
from the project, a machine copy of a previous install is removed. --link — from an ai-dev clone: symlinks to the clone
instead of copies, edits show up immediately.

Examples:
  ai-dev install --auto --lang en
  ai-dev install -g`,
  check: `ai-dev check [-g]
ai-dev check --hook

Whether the install is behind, changes nothing: 0 — up to date, 1 — behind, the project's git ignores flow files or its
compose file breaks task isolation, 2 — the check is unavailable; a copy is compared with the latest release, a --link
clone — with origin/main. For a project names the mode (auto) and the language, holds the compose file to the task
isolation rules (❌ per violation, ○ — not checked: no docker compose; the task-env skill) and warns (!) if a script in
slot calls turbo and turbo.json doesn't pass the queue variables to tasks (the exit code stays the same); a project that
needs update — the update in a task of its own, not in a task session: the task new command of the github skill, one
task per project. For the machine names the task-env proxy of *.localhost addresses — running or not, with the start
command (with Docker on the machine; the exit code stays the same), run from the agent's Bash in Claude Code — a
session without the agent's Bash environment, for a --link clone run from an ai-dev clone — flow commits not in a
release yet.
--hook — the machine and the project at once for the Claude Code SessionStart hook: the exit code is always 0, errors
go to the output; writes the agent's Bash environment to $CLAUDE_ENV_FILE — zsh without errors on a glob without matches
and on =word, timeout from bin/shims.

Examples:
  ai-dev check
  ai-dev check -g`,
  update: `ai-dev update [-g]

Brings it up to date: a --link clone — git pull --ff-only, a copy — install of the latest release (the project's mode
and language are kept; an install of a previous version without a language gets ru: before the field the flow worked in
Russian); in a project install and update un-ignore flow files from .gitignore patterns with exceptions at its end and
wrap the package.json checks (lint, typecheck, test, test:*) in the machine queue slot; prints what changed: every
release after the installed one, newest first, with the list of changes of its GitHub Release (a --link clone — the
flow commits it pulled).

Examples:
  ai-dev update
  ai-dev update -g`,
  release: `ai-dev release [--dry-run]

From an ai-dev clone: a vYYYY.MM.DD tag on origin/main and a GitHub Release listing the flow changes since the previous
release; --dry-run — only show them.

Examples:
  ai-dev release --dry-run`,
};

/** `ai-dev --help`: the synopsis of each command and how to run it. */
const OVERVIEW = [
  "ai-dev — the flow's rules and skills: install, check, update, release",
  "",
  ...Object.values(HELP).map((h) => h.split("\n\n")[0]!.replace(/^/gm, "  ")),
  "",
  "ai-dev <command> --help — the command's details and examples",
  `Run: ${RUN} <command>`,
].join("\n");

/** The help the arguments ask for (`--help`, `-h`): of the command they start with, otherwise the overview; none — undefined. */
function helpOf(argv: string[]): string | undefined {
  if (!argv.some((a) => a === "--help" || a === "-h")) return undefined;
  const words = `${argv.join(" ")} `;
  const cmd = Object.keys(HELP).find((c) => words.startsWith(`${c} `));
  return cmd ? HELP[cmd] : OVERVIEW;
}

/**
 * Dry run (`check`): instead of writing to disk the install collects here what it would change, the flow files the
 * project's git ignores (`❌`, the note has the rule, manual — an exception can't un-ignore it), and warnings about
 * project settings the install doesn't touch (`!`, the note says what to fix); null — it writes.
 */
interface Change {
  op: "+" | "-" | "~" | "❌" | "!";
  path: string;
  note?: string;
  manual?: boolean;
}
let dry: Change[] | null = null;

/** The release tag the install runs from (`toRelease`); null — not a release: a clone or no releases yet. */
let release: string | null = null;

const note = (s: string) => dry || process.stdout.write(s + "\n");
const warn = (s: string) => dry || process.stderr.write("!! " + s + "\n");
/** A mismatch the install didn't fix. */
const fail = (s: string) => dry || process.stderr.write("❌ " + s + "\n");

/**
 * What the install would change: `+` will appear, `-` will be removed, `~` will change, `❌` — git ignores a flow
 * file, `!` — a warning (not falling behind: update won't fix it); a directory ends with `/`.
 */
const change = (op: Change["op"], p: string, extra: { note?: string; manual?: boolean } = {}) => dry?.push({ op, path: p, ...extra });

function lstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function onPath(cmd: string) {
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => d && existsSync(path.join(d, cmd)));
}

function samePath(a: string, b: string) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** git in directory dir; an error throws. */
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The first stderr line of a failed command. */
function reason(e: unknown) {
  const err = e as { stderr?: string | Buffer; message?: string };
  return (String(err.stderr ?? "").trim() || String(err.message)).split("\n")[0] ?? "";
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);

/**
 * The ai-dev SHA the install runs from: for a clone — HEAD; for the bunx package — the SHA of the spec bunx installed it
 * by, `github:miroshnik/ai-dev#<sha>` in the package.json of the bunx directory next to node_modules (bunx unpacks the
 * package from GitHub without `.git`, its `.bun-tag` holds only 7 characters of the SHA). The package from main — no SHA
 * in the spec — null: it is only a launcher (`toRelease`).
 */
function sourceSha(src: string) {
  if (existsSync(path.join(src, ".git"))) {
    try {
      return git(src, "rev-parse", "HEAD");
    } catch {
      return null;
    }
  }
  const nm = path.dirname(src);
  if (path.basename(nm) !== "node_modules") return null;
  try {
    const spec: unknown = JSON.parse(readFileSync(path.join(nm, "..", "package.json"), "utf8")).dependencies?.[path.basename(src)];
    return /#([0-9a-f]{40})$/.exec(String(spec ?? ""))?.[1] ?? null;
  } catch {
    return null;
  }
}

const lsRemote = (args: string[], cwd?: string) =>
  execFileSync("git", ["ls-remote", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/**
 * ai-dev releases in ascending order — RELEASE_TAG tags from `git ls-remote --tags remote` (by date, then by patch
 * number); for an annotated tag — the commit SHA, not the tag object's. Other tags don't count. A git error throws.
 * @param remote a URL or a remote name in cwd
 */
function releases(remote: string, cwd?: string): { tag: string; sha: string }[] {
  const tags = new Map<string, string>();
  for (const line of lsRemote(["--tags", remote], cwd).split("\n")) {
    const [sha, ref = ""] = line.split("\t");
    const m = /^refs\/tags\/([^^]+)(\^\{\})?$/.exec(ref);
    // `tag^{}` comes after the tag: the annotated tag's commit
    if (sha && m?.[1] && RELEASE_TAG.test(m[1]) && (m[2] || !tags.has(m[1]))) tags.set(m[1], sha);
  }
  const key = (tag: string) => (RELEASE_TAG.exec(tag) ?? []).slice(1).map((n) => Number(n ?? 0));
  const cmp = (a: number[], b: number[]) => a.reduce((r, n, i) => r || n - (b[i] ?? 0), 0);
  return [...tags].map(([tag, sha]) => ({ tag, sha })).sort((a, b) => cmp(key(a.tag), key(b.tag)));
}

/** The commit of the remote's HEAD — main; an empty repository — null. A git error throws. */
function mainHead(remote: string) {
  return lsRemote([remote, "HEAD"]).split("\t")[0]?.trim() || null;
}

/** Where releases and their history come from: AI_DEV_REPO (a mirror, tests) or GitHub. */
const repoUrl = () => process.env.AI_DEV_REPO || `https://github.com/${SOURCE}.git`;

/**
 * A copy follows ai-dev releases, not main. bunx installs a package by its spec once and then runs it from its cache
 * without the network: the package from main (`bunx github:miroshnik/ai-dev`) stays as old as its first run. So it is
 * only a launcher: it finds the latest release and restarts from it by the full SHA — a SHA doesn't change, the cache
 * doesn't harm it; no releases yet — by the SHA of main's head. A package installed by a SHA (`sourceSha`: the restart
 * or the user's own pin) works itself; AI_DEV_RELEASE — the tag the launcher restarted to. A clone installs itself as
 * is. Tags come from AI_DEV_REPO (a mirror, tests) or GitHub.
 * @returns the restarted process's code; null — work here
 */
function toRelease(argv: string[]): number | null {
  if (existsSync(path.join(SRC, ".git"))) return null;
  if (sourceSha(SRC)) return (release = process.env.AI_DEV_RELEASE || null), null;
  let to: { tag?: string; sha: string } | undefined;
  try {
    const head = (sha: string | null) => (sha ? { sha } : undefined);
    to = releases(repoUrl()).at(-1) ?? head(mainHead(repoUrl()));
  } catch (e) {
    throw new Error(`can't find out the latest ai-dev release — ${reason(e)}`);
  }
  if (!to) return null;
  const env = { ...process.env };
  delete env.AI_DEV_RELEASE;
  if (to.tag) env.AI_DEV_RELEASE = to.tag;
  const r = spawnSync("bunx", ["--silent", `github:${SOURCE}#${to.sha}`, ...argv], { stdio: "inherit", env });
  if (r.error) throw new Error(`can't run ${to.tag ? `release ${to.tag}` : `ai-dev ${short(to.sha)}`} — ${reason(r.error)}`);
  return r.status ?? 2;
}

/** The symlink dst → target text, as link() writes it. */
function linkText(target: string, dst: string, root: string) {
  const inRoot = !path.relative(root, target).startsWith("..");
  return inRoot ? path.relative(path.dirname(dst), target) : target;
}

/**
 * Symlink dst → target: inside root — relative (it is committed in a project), outside — absolute (a relative one
 * breaks if the path to root goes through a symlink: macOS /var → /private/var). Replaces a symlink and an empty file;
 * someone else's file or directory — a warning. A symlink that already points there stays untouched: an agent's
 * sandbox refuses writes to `.claude/skills`, and an update without a new skill mustn't fail on it.
 */
function link(target: string, dst: string, root: string) {
  const st = lstat(dst);
  if (st && !st.isSymbolicLink() && !(st.isFile() && st.size === 0)) {
    return warn(`${path.relative(root, dst)} already exists and isn't a symlink — left as is`), false;
  }
  const text = linkText(target, dst, root);
  const same = Boolean(st?.isSymbolicLink()) && readlinkSync(dst) === text;
  if (dry) {
    if (!same) change(st ? "~" : "+", dst);
    return true;
  }
  if (same) return true;
  if (st) rmSync(dst);
  mkdirSync(path.dirname(dst), { recursive: true });
  symlinkSync(text, dst);
  note(`${path.relative(root, dst)} → ${path.relative(root, target)}`);
  return true;
}

/** Removes a directory or a symlink. */
const remove = (p: string) => lstat(p) && rmSync(p, { recursive: true, force: true });

/** The directory's files (and symlinks) recursively: path from dir → full path. Finder's .DS_Store doesn't count. */
function walk(dir: string, rel = "", out = new Map<string, string>()) {
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walk(dir, r, out);
    else out.set(r, path.join(dir, r));
  }
  return out;
}

function sameFile(a: string, b: string) {
  const [sa, sb] = [lstatSync(a), lstatSync(b)];
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  return readFileSync(a).equals(readFileSync(b));
}

/** Dry run of a copy: how directory dst differs from the files expected (path in dst → source). */
function diffTree(expected: Map<string, string>, dst: string) {
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

/** Directory dst — a copy of directory src or, in linkMode, a symlink to it; the previous contents of dst go entirely. */
function placeDir(src: string, dst: string, root: string, linkMode: boolean) {
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

/** ai-dev skills: skills/<name> directories with SKILL.md. */
function sourceSkills(src: string) {
  return readdirSync(path.join(src, "skills"))
    .filter((n) => existsSync(path.join(src, "skills", n, "SKILL.md")))
    .sort();
}

/** The rules canon: `.agents/ai-dev/` — a copy of AGENTS.md, claude/CLAUDE.md and docs/*.md or a symlink to the clone. */
function installRules(src: string, root: string, linkMode: boolean) {
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

/** The install's `.agents/ai-dev.json`. */
interface Manifest {
  source?: string;
  sha?: string;
  tag?: string;
  clone?: string;
  skills?: string[];
  auto?: boolean;
  language?: string;
  env?: unknown;
}

/** The install's `.agents/ai-dev.json`; missing or broken — empty. */
function readManifest(root: string): Manifest {
  try {
    return JSON.parse(readFileSync(path.join(root, ".agents/ai-dev.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Skills: `.agents/skills/<name>` — a copy (or a symlink to the clone), Claude Code — a symlink from `.claude/skills`.
 * Someone else's directory with the same name is left alone; skills from a previous install that ai-dev no longer
 * has are removed. `.agents/ai-dev.json` holds the source SHA, the release tag and the installed skills; a dry run
 * doesn't compare the SHA and the tag: the install is up to date if what it installs matches (a release that changes
 * only the installer doesn't touch projects). auto and language — the project settings "a task entirely without
 * asking" and the language the agent works in, always written; the machine doesn't have them (undefined). `env` —
 * the project's task stack settings (the task-env skill: HTTP services and their ports): the project writes it, the
 * install carries it over. A dry run doesn't compare them either: editing a field by hand doesn't make the install
 * "behind".
 * The order survives a run cut off midway (an agent's sandbox refuses writes to `.claude/skills`): skills ai-dev no
 * longer has go while the old manifest still lists them, and the new manifest is written before the copies — a repeat
 * run takes them for ai-dev's and finishes the install instead of leaving them as someone else's.
 * @returns installed skills
 */
function installSkills(src: string, root: string, linkMode: boolean, claude: boolean, auto?: boolean, language?: string) {
  const manifestPath = path.join(root, ".agents/ai-dev.json");
  const before = readManifest(root).skills ?? [];
  const names = sourceSkills(src);
  const env = readManifest(root).env;
  const installed = names.filter((name) => {
    const dst = path.join(root, ".agents/skills", name);
    const st = lstat(dst);
    if (!st || st.isSymbolicLink() || before.includes(name)) return true;
    warn(`${path.relative(root, dst)} already exists and isn't an ai-dev skill — left; remove it to install the ai-dev skill`);
    return false;
  });
  for (const name of before.filter((n) => !names.includes(n))) {
    const dst = path.join(root, ".agents/skills", name);
    if (dry) {
      if (lstat(dst)) change("-", dst + "/");
      continue;
    }
    remove(dst);
    if (lstat(path.join(root, ".claude/skills", name))?.isSymbolicLink()) rmSync(path.join(root, ".claude/skills", name));
    note(`${path.relative(root, dst)} — removed: ai-dev no longer has it`);
  }
  const clone = linkMode ? path.resolve(src) : undefined; // a --link machine: check and update find the clone by it
  if (dry) {
    const m = readManifest(root);
    if (m.source !== SOURCE || JSON.stringify(m.skills) !== JSON.stringify(installed) || m.clone !== clone) change(existsSync(manifestPath) ? "~" : "+", manifestPath);
  } else {
    const sha = sourceSha(src);
    const manifest = { source: SOURCE, ...(sha ? { sha } : {}), ...(release ? { tag: release } : {}), ...(clone ? { clone } : {}), skills: installed, ...(auto === undefined ? {} : { auto }), ...(language === undefined ? {} : { language }), ...(env === undefined ? {} : { env }) };
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  for (const name of installed) placeDir(path.join(src, "skills", name), path.join(root, ".agents/skills", name), root, linkMode);
  if (!linkMode) note(`.agents/skills/ ← ${installed.join(", ")}`);
  if (claude) for (const name of installed) link(path.join(root, ".agents/skills", name), path.join(root, ".claude/skills", name), root);
  return installed;
}

/**
 * The machine queue in the project's flow copy: a package.json script sources it before its command, in CI too (there
 * the command goes at once, without a queue).
 */
const SLOT_SH = ".agents/skills/slot/scripts/slot.sh";
/** The queue script itself: slot.sh calls it, and on Yarn 2+ a script passes it the command as a string. */
const SLOT_TS = ".agents/skills/slot/scripts/slot.ts";
/** A package.json script wrapped in slot: `. SLOT_SH && <command>`. */
const SLOT_WRAPPED = /^\. \.agents\/skills\/slot\/scripts\/slot\.sh && ([^]*)$/;
/**
 * A script a previous install wrapped: the command a string argument of slot.ts — tools that read package.json scripts
 * (knip) don't see it; by any runtime — node too; with Bun's env files too — without `--no-env-file`.
 */
const SLOT_STRING = /^(?:node|bun)(?: --no-env-file)? \.agents\/skills\/slot\/scripts\/slot\.ts '((?:[^']|'\\'')*)'$/;
/** The script's own command, without the slot wrapper of any install. */
const unslot = (cmd: string) => SLOT_WRAPPED.exec(cmd)?.[1] ?? SLOT_STRING.exec(cmd)?.[1]?.replaceAll("'\\''", "'") ?? cmd;
/**
 * Yarn 2+ runs package.json scripts in its own shell (`@yarnpkg/shell`) — without `.`, `eval` and `export`, slot.sh
 * can't be sourced there: the command stays a string argument of slot.ts, hidden from knip, but in the queue.
 */
const yarnShell = (root: string, pkg: { packageManager?: unknown }) =>
  existsSync(path.join(root, ".yarnrc.yml")) || /^yarn@(?!1\.)\d/.test(String(pkg.packageManager ?? ""));
/**
 * Check scripts that go through the machine queue: `lint`, `typecheck`, `test`, `test:*`. Not `build` — hosting and
 * Docker run it, where the skill's copy may be missing; not watch — long-running, it would hold a slot for long.
 */
const slotted = (name: string) => /^(?:lint|typecheck|test)$|^test:/.test(name) && !name.includes("watch");

/**
 * The project's checks — through the machine queue (the slot skill): `slotted` scripts in the root package.json are
 * wrapped in `. SLOT_SH && <command>` — any agent and human call them. The script's shell sources slot.sh: it holds the
 * slot and gets the queue variables, the command stays a plain command of the script — knip sees its binary, and
 * `bun test` gives knip the test files and `preload` as entries; the command gets exactly the environment it would
 * without the wrapper, no env files of Bun. A wrapper of a previous install — the command a string argument of
 * slot.ts, hidden from knip — is rewritten; on Yarn 2+ that is the wrapper (`yarnShell`). The indentation and the
 * trailing newline stay as they were. The slot skill isn't installed (someone else's directory with the same name) —
 * left alone.
 * @param skills installed skills
 * @returns package.json changed
 */
function slotScripts(root: string, skills: string[]) {
  const file = path.join(root, "package.json");
  if (!skills.includes("slot") || !existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    pkg = JSON.parse(text);
  } catch {
    return warn("package.json — not JSON: the project's checks aren't wrapped in the slot queue"), false;
  }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object") return false;
  const yarn = yarnShell(root, pkg);
  const wrap = (cmd: string) => (yarn ? `bun --no-env-file ${SLOT_TS} '${cmd.replaceAll("'", "'\\''")}'` : `. ${SLOT_SH} && ${cmd}`);
  const outside: string[] = [];
  const previous: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!slotted(name) || typeof cmd !== "string") continue;
    const inner = unslot(cmd);
    const want = wrap(inner);
    if (cmd !== want) (scripts[name] = want), (inner === cmd ? outside : previous).push(name);
  }
  const wrapped = [...outside, ...previous];
  if (!wrapped.length) return false;
  if (dry) {
    const why = yarn ? "" : " — knip doesn't see the command";
    const notes = [outside.length && `checks outside the slot queue: ${outside.join(", ")}`, previous.length && `the slot wrapper of a previous install${why}: ${previous.join(", ")}`];
    return change("~", file, { note: notes.filter(Boolean).join("; ") }), false;
  }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
  writeFileSync(file, JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  note(`package.json — checks through the machine queue (slot): ${wrapped.join(", ")}`);
  return true;
}

/**
 * Queue variables a command in a slot needs: the runner's share of cores and "already in a slot" for a nested script
 * in slot.
 */
const SLOT_ENV = ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"];
/**
 * The command calls turbo — `turbo run test`, `turbo test`, `npx turbo …` — but not the `--turbo` flag and not the
 * `turbo.json` path.
 */
const TURBO = /(?:^|[\s;&|(])turbo(?=\s|$)/;
/** A JSON string goes as is; outside strings — a JSONC comment, then a trailing comma. */
const JSON_STRING = String.raw`("(?:[^"\\]|\\.)*")`;
const JSONC_COMMENT = new RegExp(`${JSON_STRING}|//[^\\n]*|/\\*[^]*?\\*/`, "g");
const TRAILING_COMMA = new RegExp(`${JSON_STRING}|,(?=\\s*[}\\]])`, "g");

/** turbo.json is JSONC: comments and trailing commas go, strings stay as they were. */
const parseJsonc = (text: string) => JSON.parse(text.replace(JSONC_COMMENT, (_, s) => s ?? "").replace(TRAILING_COMMA, (_, s) => s ?? ""));

/** A turbo variable mask: `*` — any characters, the rest — literally. */
function envMatch(mask: string, name: string) {
  const literal = mask.split("*").map((s) => s.replace(/[.+?^$|()[\]{}\\]/g, "\\$&"));
  return new RegExp(`^${literal.join(".*")}$`).test(name);
}

/**
 * turbo 2 in strict env mode (the default) passes to tasks only the variables named in turbo.json: a script in slot
 * that calls turbo loses `AI_DEV_SLOT_CPUS` on the way — the runner takes the whole machine — and `AI_DEV_SLOT` — a
 * nested script in slot waits for its own slot. The pass-through is `globalPassThroughEnv`, not `globalEnv`: it isn't
 * part of the cache hash, and `AI_DEV_SLOT` is different on every run. The project owns turbo.json, and it may have
 * comments (JSONC) — we don't edit it but warn with a ready-made line; in `check` — a `!` line, not falling behind.
 * turbo.json can't be parsed — we stay silent: turbo itself will parse it.
 */
function turboEnv(root: string) {
  let scripts: unknown;
  try {
    scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  } catch {
    return;
  }
  if (!scripts || typeof scripts !== "object") return;
  const cmds = Object.entries(scripts).flatMap(([name, cmd]) => (slotted(name) && typeof cmd === "string" ? [unslot(cmd)] : []));
  if (!cmds.some((cmd) => TURBO.test(cmd) && !/--env-mode[= ]loose\b/.test(cmd))) return;
  const name = ["turbo.json", "turbo.jsonc"].find((f) => existsSync(path.join(root, f)));
  if (!name) return;
  let cfg;
  try {
    cfg = parseJsonc(readFileSync(path.join(root, name), "utf8"));
  } catch {
    return;
  }
  if (cfg?.envMode === "loose") return;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : []);
  const masks = [...list(cfg?.globalPassThroughEnv), ...list(cfg?.globalEnv)];
  const negated = (m: string, v: string) => m.startsWith("!") && envMatch(m.slice(1), v);
  const reaches = (v: string) => masks.some((m) => !m.startsWith("!") && envMatch(m, v)) && !masks.some((m) => negated(m, v));
  const missing = SLOT_ENV.filter((v) => !reaches(v));
  if (!missing.length) return;
  const keep = list(cfg?.globalPassThroughEnv).filter((m) => !SLOT_ENV.some((v) => negated(m, v)));
  const line = `"globalPassThroughEnv": [${[...keep, ...missing.filter((v) => !keep.includes(v))].map((m) => JSON.stringify(m)).join(", ")}]`;
  const text = `${missing.join(", ")} ${missing.length > 1 ? "don't reach" : "doesn't reach"} the runner: turbo in strict env mode passes to tasks only the variables named in ${name} — put at its root ${line}`;
  if (dry) change("!", path.join(root, name), { note: text });
  else warn(`${name} — ${text}`);
}

/** Claude Code: rules from `.claude/rules` load by themselves, whatever the CLAUDE.md. */
function claudeRules(root: string) {
  link(path.join(root, ".agents/ai-dev/AGENTS.md"), path.join(root, ".claude/rules/ai-dev.md"), root);
  link(path.join(root, ".agents/ai-dev/claude/CLAUDE.md"), path.join(root, ".claude/rules/ai-dev-claude.md"), root);
}

/**
 * The SessionStart hook in `~/.claude/settings.json` (HOOK): the user's own settings and hooks stay in place, a hook
 * of a previous version (with npx too) is replaced, a repeated install doesn't duplicate it. A dry run names what the
 * hook gives: from a terminal `check -g` can't see the agent's shell, a missing hook is how it names a missing Bash
 * environment (tests/capabilities/agent-shell).
 */
function claudeHook(home: string) {
  const file = path.join(home, ".claude/settings.json");
  let settings: { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> } = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return warn(`.claude/settings.json — not JSON: the SessionStart hook isn't installed, add it yourself: ${HOOK_COMMAND}`);
    }
  }
  const ours = (h: { command?: unknown }) => typeof h.command === "string" && h.command.includes(`${SOURCE} check --hook`);
  const groups = settings.hooks?.SessionStart ?? [];
  const count = groups.flatMap((g) => g.hooks ?? []).filter(ours).length;
  if (count === 1 && groups.some((g) => JSON.stringify(g) === JSON.stringify(HOOK))) return;
  if (dry) return change(existsSync(file) ? "~" : "+", file, { note: "the SessionStart hook: the flow check and the agent's Bash environment" });
  const rest = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
  settings.hooks = { ...settings.hooks, SessionStart: [...rest, HOOK] };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  note(".claude/settings.json — SessionStart hook: ai-dev check --hook");
}

/** The block linking to the rules in the project's AGENTS.md: at the start of the file, a repeated install replaces it. */
function agentsBlock(root: string) {
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
  note("AGENTS.md — a block linking to .agents/ai-dev/AGENTS.md");
}

const GI_BEGIN = "# ai-dev:begin";
const GI_END = "# ai-dev:end";
const GI_HEAD = `${GI_BEGIN} — flow files git would otherwise ignore; set by \`${RUN} install\`, don't edit by hand`;

/** `.gitignore` without the ai-dev block; no block — as is. */
function withoutGiBlock(text: string) {
  const b = text.indexOf(GI_BEGIN);
  const e = text.indexOf(GI_END, b);
  if (b < 0 || e < 0) return text;
  const rest = [text.slice(0, b).replace(/\n+$/, ""), text.slice(e + GI_END.length).replace(/^\n+|\n+$/g, "")].filter(Boolean).join("\n");
  return rest ? rest + "\n" : "";
}

/** The block goes at the end of `.gitignore`: an exception works only if it comes after the ignoring rule. */
function withGiBlock(base: string, lines: string[]) {
  if (!lines.length) return base;
  const block = [GI_HEAD, ...lines, GI_END].join("\n") + "\n";
  return base ? base.replace(/\n*$/, "\n\n") + block : block;
}

/** A path as a `.gitignore` pattern: special characters — literally. */
const glob = (p: string) => p.replace(/[\\*?[]/g, "\\$&");

/**
 * Order of the block's lines: the directory exception `!/a/`, then `/a/*` — the rest of its contents is ignored again,
 * then deeper exceptions.
 */
const giKey = (line: string) => line.replace(/^!?\//, "").replace(/\/$/, "/\0").replace(/\/\*$/, "/\x01");

/** Directories above a path from the root: `a/b/c` → `a`, `a/b`. */
const dirsAbove = (p: string) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));

/**
 * Which of the paths (from the project root) the project's git ignores: path → the rule `<source>:<line> «<pattern>»`.
 * Git doesn't name tracked ones — rules don't apply to them. local — a rule from the repository's `.gitignore`, not a
 * personal one (core.excludesFile, `.git/info/exclude`).
 */
function ignoredBy(root: string, paths: string[]) {
  const out = new Map<string, { rule: string; local: boolean }>();
  if (!paths.length) return out;
  const r = spawnSync("git", ["-C", root, "check-ignore", "-v", "-z", "--stdin"], { input: paths.join("\0") + "\0", encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore — ${String(r.stderr).trim().split("\n")[0]}`);
  const home = os.homedir();
  const fields = r.stdout.split("\0");
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source = "", line = "", pattern = "", p = ""] = fields.slice(i, i + 4);
    if (pattern.startsWith("!")) continue; // -v names exceptions too: the path isn't ignored
    const shown = source.startsWith(home + path.sep) ? `~${source.slice(home.length)}` : source;
    out.set(p, { rule: `${shown}:${line} «${pattern}»`, local: !path.isAbsolute(source) && path.basename(source) === ".gitignore" });
  }
  return out;
}

/** What the install puts into a project and what must go into the commit: copy directories, files and symlinks. */
function flowEntries(root: string) {
  const skills = readManifest(root).skills ?? [];
  return [
    { path: ".agents/ai-dev", dir: true },
    ...skills.map((n) => ({ path: `.agents/skills/${n}`, dir: true })),
    { path: ".agents/ai-dev.json", dir: false },
    { path: ".claude/rules/ai-dev.md", dir: false },
    { path: ".claude/rules/ai-dev-claude.md", dir: false },
    ...skills.map((n) => ({ path: `.claude/skills/${n}`, dir: false })),
    { path: "AGENTS.md", dir: false },
  ].filter((e) => lstat(path.join(root, e.path))?.isDirectory() === e.dir);
}

interface Ignored {
  rule: string;
  personal?: boolean;
}

/**
 * One pass: flow files that git ignores → exception lines and what is ignored (the path — a file or the topmost
 * ignored directory). A flow directory (`.agents/skills/spec/…/vendor/`) is un-ignored as a whole — everything in it
 * is ours. A directory above a flow file (`.claude/`) — by the chain `!/.claude/`, `/.claude/*`, `!/.claude/rules/` …
 * down to the file: the rest of it stays ignored, as before; only for a repository rule — for a personal rule
 * `/.claude/*` would hide the rest for everyone who doesn't have that rule (personal). The next pass lifts a deeper
 * pattern.
 */
function giRound(root: string, entries: { path: string; dir: boolean }[]) {
  const files = entries.flatMap((e) => (e.dir ? [...walk(path.join(root, e.path)).keys()].map((rel) => `${e.path}/${rel}`) : [e.path]));
  const ignored = ignoredBy(root, files);
  const lines: string[] = [];
  const found = new Map<string, Ignored>();
  if (!ignored.size) return { lines, found };
  const dirs = ignoredBy(root, [...new Set([...ignored.keys()].flatMap(dirsAbove))]);
  for (const [file, own] of ignored) {
    const entry = entries.find((e) => file === e.path || file.startsWith(e.path + "/"));
    const above = dirsAbove(file);
    const top = above.find((d) => dirs.has(d));
    const rule = top ? dirs.get(top) : undefined;
    if (!entry || !top || !rule) {
      lines.push(`!/${glob(file)}`);
      found.set(file, { rule: own.rule });
    } else if (top === entry.path || top.startsWith(entry.path + "/")) {
      lines.push(`!/${glob(top)}/`);
      found.set(top + "/", { rule: rule.rule });
    } else if (!rule.local) {
      found.set(top + "/", { rule: rule.rule, personal: true });
    } else {
      for (const d of above.slice(above.indexOf(top), dirsAbove(entry.path).length)) lines.push(`!/${glob(d)}/`, `/${glob(d)}/*`);
      lines.push(`!/${glob(entry.path)}${entry.dir ? "/" : ""}`);
      found.set(top + "/", { rule: rule.rule });
    }
  }
  return { lines, found };
}

/** Why a path is ignored: the rule and, if an exception can't un-ignore it, what to do. */
function ignoredNote(i: Ignored, stuck: boolean) {
  if (i.personal) return `${i.rule}: the directory is excluded outside the project, an exception in the project's .gitignore would hide the rest of it for everyone — fix the rule`;
  return stuck ? `${i.rule}: an exception at the end of .gitignore doesn't un-ignore it — fix the rule` : i.rule;
}

/**
 * Flow files go into the commit: a copy the project's git ignores is invisible to another checkout and to a cloud
 * session, and the committed symlink `.claude/rules` points into nowhere. Exceptions — as an ai-dev block at the end
 * of the root `.gitignore` (giRound), rebuilt by every install: passes while new lines appear; not needed — removed.
 * What an exception can't un-ignore — `❌`. A dry run only names what is ignored. Not git — nothing to check.
 * @returns `.gitignore` changed
 */
function gitignoreFlow(root: string) {
  try {
    git(root, "rev-parse", "--git-dir");
  } catch {
    return false;
  }
  const entries = flowEntries(root);
  if (dry) {
    for (const [p, i] of giRound(root, entries).found) change("❌", path.join(root, p), { note: ignoredNote(i, false), manual: Boolean(i.personal) });
    return false;
  }
  const file = path.join(root, ".gitignore");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const put = (text: string) => {
    if (text === (existsSync(file) ? readFileSync(file, "utf8") : "")) return;
    if (text) writeFileSync(file, text);
    else rmSync(file, { force: true });
  };
  const base = withoutGiBlock(before);
  let lines: string[] = [];
  const fixed = new Map<string, Ignored>();
  let stuck = new Map<string, Ignored>();
  try {
    put(base);
    for (let pass = 0; ; pass++) {
      const r = giRound(root, entries);
      const fresh = r.lines.filter((l) => !lines.includes(l));
      if (!fresh.length || pass === 10) {
        stuck = r.found;
        break;
      }
      for (const [p, i] of r.found) fixed.set(p, i);
      lines = [...new Set([...lines, ...fresh])].sort((a, b) => (giKey(a) < giKey(b) ? -1 : 1));
      put(withGiBlock(base, lines));
    }
  } catch (e) {
    put(before);
    return warn(`.gitignore not checked — ${reason(e)}`), false;
  }
  const after = withGiBlock(base, lines);
  put(after);
  for (const p of stuck.keys()) fixed.delete(p);
  if (fixed.size) note(`.gitignore — ai-dev exceptions: git ignored ${[...fixed].map(([p, i]) => `${p} (${i.rule})`).join(", ")}`);
  else if (after !== before && !lines.length) note(".gitignore — the ai-dev exceptions block removed: git doesn't ignore flow files");
  for (const [p, i] of stuck) fail(`${p} — ${ignoredNote(i, true)}`);
  return after !== before;
}

/** The git repository root of the current directory; null — not a repository. */
function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The project root: the git root or the current directory. */
function projectRoot() {
  return gitRoot() ?? process.cwd();
}

/** An ai-dev clone: its canon is the root AGENTS.md, the flow needn't be installed into it. */
function isAiDevClone(root: string) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === "ai-dev";
  } catch {
    return false;
  }
}

/** Whether the agent runs a task entirely by itself — `auto` of the project manifest; no field — "no". */
const autoOf = (root: string) => readManifest(root).auto === true;

/** A BCP 47 language code: the language and optional subtags — `ru`, `en`, `pt-BR`, `zh-Hant`. */
const LANGUAGE_CODE = locale.LANGUAGE_CODE;

/**
 * The language the agent works in in the project — via the github skill's language module, the same one the skills'
 * scripts use: `language` of the manifest; a manifest without the field (an install of a previous version) — `ru`, no
 * manifest — `en`, the flow's language.
 */
const languageOf = (root: string) => locale.projectLanguage(root);

/** Lines with the project's mode and language in `check` output: the session start (hook) sees them. */
const modeLines = (root: string) => [`  tasks: ${autoOf(root) ? "entirely by itself" : "with permission"}`, `  language: ${languageOf(root)}`];

const CLONE_NOTE = "an ai-dev clone: the flow isn't installed into it — the canon is at its root";

/**
 * An ai-dev clone: of the install it gets only the mode and the language, a manifest of two fields; the task stack
 * settings (`env`), if the clone has them, are carried over as in a project.
 */
function installClone(root: string, auto: boolean, language: string) {
  const file = path.join(root, ".agents/ai-dev.json");
  const env = readManifest(root).env;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ auto, language, ...(env === undefined ? {} : { env }) }, null, 2) + "\n");
  note(`.agents/ai-dev.json — auto: ${auto}, language: ${language}; ${CLONE_NOTE}`);
}

/**
 * auto and language — the project's mode and language; only `install` sets them (a flag or a question in the
 * terminal), `update` and `check` go with the manifest's previous value.
 * @returns changed project files outside the flow copy — they go into the commit too
 */
function installProject(src: string, root: string, auto = autoOf(root), language = languageOf(root)) {
  installRules(src, root, false);
  const skills = installSkills(src, root, false, true, auto, language);
  claudeRules(root);
  agentsBlock(root);
  const pkg = slotScripts(root, skills);
  if (skills.includes("slot")) turboEnv(root);
  return [...(gitignoreFlow(root) ? [".gitignore"] : []), ...(pkg ? ["package.json"] : [])];
}

/** Agents' global rule files that a previous install made symlinks to `~/.agents/ai-dev/AGENTS.md`. */
const AGENT_RULE_FILES = [".codex/AGENTS.md", ".gemini/GEMINI.md", ".copilot/copilot-instructions.md", ".config/opencode/AGENTS.md", ".config/amp/AGENTS.md"];

/**
 * There are no rules on the machine: the project loads them (`.claude/rules`, `AGENTS.md`), and a second copy from
 * the machine is the same ~20k tokens on every turn of every agent. A previous install put them there — we remove
 * them: `~/.agents/ai-dev` (a copy or a symlink to the clone), the `~/.claude/rules/ai-dev*.md` symlinks and the
 * symlinks of agents' global files to the canon. Someone else's file or symlink is left alone.
 */
function removeGlobalRules(home: string) {
  const canon = path.join(home, ".agents/ai-dev");
  const st = lstat(canon);
  if (st) {
    if (dry) change("-", canon + "/");
    else if (st.isSymbolicLink()) rmSync(canon);
    else rmSync(canon, { recursive: true, force: true });
  }
  const removed: string[] = [];
  for (const rel of [".claude/rules/ai-dev.md", ".claude/rules/ai-dev-claude.md", ...AGENT_RULE_FILES]) {
    const file = path.join(home, rel);
    const ls = lstat(file);
    if (!ls?.isSymbolicLink() || !path.resolve(path.dirname(file), readlinkSync(file)).startsWith(canon + path.sep)) continue;
    if (dry) change("-", file);
    else rmSync(file), removed.push(rel);
  }
  if (!dry && (st || removed.length)) note(`rules on the machine removed (${[st ? ".agents/ai-dev/" : "", ...removed].filter(Boolean).join(", ")}): rules load from the project`);
}

function installGlobal(src: string, linkMode: boolean) {
  const home = os.homedir();
  const has = (dir: string, cmd = "") => existsSync(path.join(home, dir)) || (cmd !== "" && onPath(cmd));
  const claude = has(".claude", "claude");
  installSkills(src, home, linkMode, claude);
  removeGlobalRules(home);

  if (claude) {
    claudeHook(home);
    // install.sh installed ~/.claude/CLAUDE.md as a symlink to claude/CLAUDE.md, and that one imported AGENTS.md
    const old = path.join(home, ".claude/CLAUDE.md");
    if (lstat(old)?.isSymbolicLink() && readlinkSync(old).endsWith(path.join("claude", "CLAUDE.md"))) {
      if (dry) change("-", old);
      else rmSync(old), note(".claude/CLAUDE.md — the old install.sh symlink removed: rules now come only from the project");
    }
  }

  if (has(".cursor")) note("Cursor: sees the skills in ~/.agents/skills; rules — from the project's AGENTS.md");

  // The default location of the personal configuration. AI_DEV_CONFIG_DIR is deliberately not read here: the
  // variable overrides the whole directory and needs no symlink — the skills' scripts look where it points
  // (tests/standards/config-dir).
  const priv = process.env.AI_DEV_PRIVATE;
  if (priv) {
    const dst = path.join(home, ".config/ai-dev");
    const st = lstat(dst);
    if (st && !st.isSymbolicLink()) warn(`~/.config/ai-dev already exists and isn't a symlink — move its contents to ${priv} and remove it`);
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

/** A dry-run install: what it would change. */
function dryRun(fn: () => void) {
  dry = [];
  try {
    fn();
    return dry;
  } finally {
    dry = null;
  }
}

/** List lines, capped at MAX_LINES. */
function capped(lines: string[]) {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `  … and ${lines.length - MAX_LINES} more`] : lines;
}

/** Dry-run changes as `  ~ path` lines; on the machine the path is from `~/`. */
function changeLines(changes: Change[], root: string, global: boolean) {
  return changes.map((c) => `  ${c.op} ${global ? "~/" : ""}${path.relative(root, c.path)}${c.path.endsWith("/") ? "/" : ""}${c.note ? ` — ${c.note}` : ""}`);
}

/**
 * behind — falls behind: update will install something new; ignored — the project's git ignores flow files: update
 * will add exceptions; compose — the project's compose file breaks task isolation: update won't fix it; run — the text
 * names a command to run.
 */
interface Result {
  code: 0 | 1 | 2;
  text: string;
  absent?: boolean;
  behind?: boolean;
  ignored?: boolean;
  compose?: boolean;
  run?: boolean;
}

/**
 * The project's compose file against the task isolation rules (the task-env skill, tests/capabilities/task-env): a `❌`
 * line per violation, `○` — not checked (no docker compose, the config doesn't parse): that isn't a violation, and the
 * exit code of `check` doesn't change. No compose file — no lines, the script doesn't start. The script runs under the
 * same Bun as the installer.
 */
function composeCheck(root: string): { lines: string[]; violations: boolean } {
  const file = COMPOSE_FILES.find((f) => existsSync(path.join(root, f)));
  if (!file) return { lines: [], violations: false };
  const r = spawnSync(process.execPath, ["--no-env-file", TASK_ENV, "check", root], { encoding: "utf8", timeout: TASK_ENV_TIMEOUT });
  const notChecked = (why: string) => ({ lines: [`  ○ ${file}: not checked — ${why}`], violations: false });
  if (r.error) return notChecked(`task-env: ${r.error.message}`);
  if (r.status === 0) return { lines: [], violations: false };
  const lines = r.stdout.split("\n").filter(Boolean).map((l) => `  ${l}`);
  if (r.status === 1 || (r.status === 2 && lines.length)) return { lines, violations: r.status === 1 };
  return notChecked(`task-env: ${r.stderr.trim().split("\n")[0] || `exit code ${r.status ?? r.signal}`}`);
}

/**
 * The project's update is a task of its own, one per project: a task session doesn't update the copy — thousands of
 * lines don't belong in its branch. The title is constant, in the project language (the `updateTask` key of this
 * package's github skill dictionary): `task new` refuses a second open task with the same title and names the open one.
 * The script — not the project's copy: the line shows exactly when the copy is behind, and its script may not know the
 * flags printed here (`--branch-type` — since v2026.10.11, #431).
 */
const updateTaskLine = (root: string) =>
  `The task — one per project, an open one is named by the refusal: bun --no-env-file ${githubScript(false)} task new --title "${locale.names(languageOf(root)).updateTask}" --branch-type chore`;

/** The check failed: what and why. */
const unavailable = (global: boolean, e: unknown): Result => ({ code: 2, text: `ai-dev ${global ? "on the machine" : "in the project"}: check unavailable — ${reason(e)}` });

/**
 * The clone a `--link` install on the machine refers to: the path from the manifest; for an install of a previous
 * version — the `~/.agents/ai-dev` symlink (`update -g` removes it and writes the path). null — a copy or not
 * installed.
 */
function linkedClone(home: string) {
  const m = readManifest(home);
  if (typeof m.clone === "string") return m.clone;
  const canon = path.join(home, ".agents/ai-dev");
  return lstat(canon)?.isSymbolicLink() ? path.resolve(path.dirname(canon), readlinkSync(canon)) : null;
}

/** The install on the machine (global) or in the project: the root and whether the flow is there. */
function target(global: boolean) {
  const home = os.homedir();
  const root = global ? home : projectRoot();
  const canon = path.join(root, ".agents/ai-dev");
  // the home directory is the machine's install, not a project; an ai-dev clone is the canon itself: its manifest
  // keeps only the mode
  const installed = Boolean(lstat(canon) || existsSync(path.join(root, ".agents/ai-dev.json"))) && (global || (!samePath(root, home) && !isAiDevClone(root)));
  return { home, root, canon, installed };
}

/**
 * Whether the install on the machine (global) or in the project is behind. This package (SRC, the release —
 * `toRelease`) checks a copy with a dry-run install, a `--link` clone — against `origin/main`.
 */
function check(global: boolean): Result {
  const { home, root, installed } = target(global);
  const where = global ? "on the machine" : "in the project";
  // an ai-dev clone has nothing to compare against, but the session mode is needed in it — as in a project
  if (!installed && !global && isAiDevClone(root)) return { code: 0, text: [`ai-dev ${where}: not installed — an ai-dev clone, the canon is at its root`, ...modeLines(root)].join("\n") };
  if (!installed) return { code: 0, text: `ai-dev ${where}: not installed`, absent: true };
  const clone = global ? linkedClone(home) : null;
  if (clone) return checkLink(home, clone);
  const changes = dryRun(() => (global ? installGlobal(SRC, false) : installProject(SRC, root)));
  const fresh = release ?? short(sourceSha(SRC)) ?? "SHA unknown";
  // mode and language are project settings: the last lines, the session start (hook) sees them too
  const mode = global ? [] : modeLines(root);
  // warnings — project settings that update doesn't fix: `!` lines, they don't change the exit code
  const warnings = changeLines(changes.filter((c) => c.op === "!"), root, global);
  // the compose file breaks task isolation — a mismatch (code 1) that update doesn't fix either; `○` — not checked
  const compose = global ? { lines: [], violations: false } : composeCheck(root);
  const project = [...warnings, ...compose.lines, ...mode];
  const stale = changes.filter((c) => c.op !== "❌" && c.op !== "!");
  const ignored = changes.filter((c) => c.op === "❌");
  if (!stale.length && !ignored.length) return { code: compose.violations ? 1 : 0, compose: compose.violations, text: [`ai-dev ${where}: up to date (${fresh})`, ...project].join("\n") };
  const m = readManifest(root);
  const fixable = ignored.some((c) => !c.manual);
  const lost = "ignores flow files — they are missing from the commit, other checkouts and the cloud session:";
  return {
    code: 1,
    behind: stale.length > 0,
    ignored: ignored.length > 0,
    compose: compose.violations,
    run: stale.length > 0 || fixable,
    text: [
      stale.length ? `ai-dev ${where}: behind — installed ${m.tag ?? short(m.sha) ?? "without SHA"}, latest ${fresh}` : `ai-dev ${where}: up to date (${fresh}), but git ${lost}`,
      ...capped(changeLines(stale, root, global)),
      ...(stale.length && ignored.length ? [`Git ${lost}`] : []),
      ...capped(changeLines(ignored, root, global)),
      // update won't fix a personal rule — what to do is said in the ❌ line; the project — in a task of its own
      ...(stale.length || fixable
        ? global
          ? [`${stale.length ? "Update" : "Fix"}: ${RUN} update -g${fixable ? " — adds exceptions to .gitignore" : ""}`]
          : [`${stale.length ? "Update" : "Fix"} in a task of its own, not in this session's task: ${RUN} update${fixable ? " — adds exceptions to .gitignore" : ""}`, updateTaskLine(root)]
        : []),
      ...project,
    ].join("\n"),
  };
}

/**
 * A machine with `--link`: the clone against `origin/main` after `git fetch` — skill files the clone doesn't have
 * yet, and missing links (a new skill, the hook). Rules and references in main don't affect the machine (the project
 * loads them), commits without skill files aren't falling behind.
 */
function checkLink(home: string, clone: string): Result {
  const where = `on the machine (clone ${clone})`;
  let head, main, behind, files;
  try {
    git(clone, "fetch", "--quiet", "origin", "main");
    head = git(clone, "rev-parse", "HEAD");
    main = git(clone, "rev-parse", "origin/main");
    behind = Number(git(clone, "rev-list", "--count", "HEAD..origin/main"));
    files = git(clone, "diff", "--no-renames", "--name-status", "HEAD...origin/main", "--", "skills").split("\n").filter(Boolean);
  } catch (e) {
    return { code: 2, text: `ai-dev ${where}: check unavailable — ${reason(e)}` };
  }
  const links = dryRun(() => installGlobal(clone, true));
  if (!files.length && !links.length) {
    const ahead = behind ? `; origin/main ${short(main)} is ahead by ${behind}, the flow isn't affected` : "";
    return { code: 0, text: [`ai-dev ${where}: up to date (${short(head)}${ahead})`, ...unreleased(clone)].join("\n") };
  }
  const op = (status: string) => (status === "A" ? "+" : status === "D" ? "-" : "~");
  return {
    code: 1,
    behind: true,
    text: [
      `ai-dev ${where}: behind — clone ${short(head)}, origin/main ${short(main)}`,
      ...capped([...files.map((l) => `  ${op(l.split("\t")[0] ?? "")} ${l.split("\t")[1]}`), ...changeLines(links, home, true)]),
      `Update: ${RUN} update -g`,
      ...unreleased(clone),
    ].join("\n"),
  };
}

/**
 * A reminder to the owner on a machine with a `--link` clone: origin/main has flow changes that aren't in the latest
 * release — projects won't get them until it's cut. Only in an ai-dev clone's session: a release is the owner's step
 * there, in a project's session the line is noise at every start. Not falling behind: it doesn't change the check's
 * code. Can't tell — no line.
 */
function unreleased(clone: string): string[] {
  if (!isAiDevClone(projectRoot())) return [];
  const cmd = `release it: bun --no-env-file ${path.join(clone, "bin/ai-dev.ts")} release`;
  try {
    const last = releases("origin", clone).at(-1);
    if (!last) return [`  not in a release: no releases yet — ${cmd}`];
    const n = Number(git(clone, "rev-list", "--count", "--first-parent", `${last.sha}..origin/main`, "--", ...RELEASED));
    return n ? [`  not in a release: flow commits after ${last.tag} — ${n}; ${cmd}`] : [];
  } catch {
    return [];
  }
}

/**
 * The machine's proxy for task addresses (the task-env skill): one Traefik per machine gives containers of task stacks
 * the addresses `<service>.<N>.<project>.localhost` by their labels. Its Compose project is the skill's `proxyName`
 * (`$AI_DEV_PROXY`, by default `ai-dev-proxy`). A line for `check -g` and the hook: running, not running — with the
 * start command, Docker unavailable — with the reason. No task-env skill or no docker on the machine — no line: without
 * Docker there are no task stacks, and a line in every session would be noise. Asks docker itself — the skill's
 * `proxyRunning` folds "docker not found" into its reason. Doesn't change the check's code — the proxy isn't the flow
 * falling behind.
 */
function proxyLines(home: string): string[] {
  if (!existsSync(path.join(home, ".agents/skills/task-env/scripts/task-env.ts"))) return [];
  const name = proxyName();
  const filters = ["--filter", `label=com.docker.compose.project=${name}`, "--filter", "label=com.docker.compose.service=traefik"];
  const r = spawnSync("docker", ["ps", "--all", ...filters, "--format", "{{.State}}"], { encoding: "utf8", timeout: 10_000 });
  const err = r.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") return [];
  if (err || r.status !== 0) return [`  proxy *.localhost: Docker unavailable — ${err ? (err.code === "ETIMEDOUT" ? "docker didn't answer in 10 s" : err.message) : String(r.stderr).trim().split("\n")[0]}`];
  if (r.stdout.split("\n").includes("running")) return [`  proxy *.localhost: running (${name})`];
  return ["  proxy *.localhost: not running — start: bun --no-env-file ~/.agents/skills/task-env/scripts/task-env.ts proxy up"];
}

/**
 * The agent's Bash environment (tests/capabilities/agent-shell). Claude Code's Bash tool — the user's zsh on macOS —
 * puts the text of the files SessionStart hooks write to `$CLAUDE_ENV_FILE` into every call, after the user's shell
 * snapshot and before the command's `eval` (checked on Claude Code 2.1.295): shell options and PATH from there hold
 * in the command itself, in subagents too. zsh breaks commands written for bash: a glob without matches is an error
 * (`no matches found: --include=*.ts`, and grep in a pipe reads it as "nothing found"), a word starting with `=` is a
 * command's path (`echo ====`, `[ a == b ]`), and macOS has no `timeout`. So: NO_NOMATCH and NO_EQUALS in zsh, this
 * package's `bin/shims` (`timeout`) at the end of PATH — a real `timeout` wins — and the AGENT_SHELL mark `check -g`
 * recognises the environment by.
 */
const AGENT_SHELL = "AI_DEV_AGENT_SHELL";

/** A word for sh: in single quotes. */
const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function agentShellScript() {
  return [
    `# ai-dev: the agent's Bash environment, written by the SessionStart hook (${RUN} check --hook)`,
    `export ${AGENT_SHELL}=1`,
    'if [ -n "${ZSH_VERSION-}" ]; then setopt NO_NOMATCH NO_EQUALS; fi',
    `export PATH="\${PATH:+$PATH:}"${shQuote(path.join(SRC, "bin/shims"))}`,
    "",
  ].join("\n");
}

/** Without the environment the zsh pitfalls are back: what the agent does by hand meanwhile. */
const SHELL_FALLBACK = "meanwhile in zsh quote globs ('*.ts') and words starting with = ('===='), use the Bash tool's timeout instead of timeout";

/**
 * The SessionStart hook: the agent's Bash environment into `$CLAUDE_ENV_FILE` — the file Claude Code gives this hook
 * (`~/.claude/session-env/<session>/sessionstart-hook-<N>.sh`); rewritten on every start, resume and clear, a repeat
 * doesn't add a second copy. Written — no line: the hook's output is read in every session.
 */
function writeAgentShell(): string[] {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) return [`  agent Bash: not set up — Claude Code gave the hook no CLAUDE_ENV_FILE; ${SHELL_FALLBACK}`];
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, agentShellScript());
    return [];
  } catch (e) {
    return [`  agent Bash: not set up — can't write CLAUDE_ENV_FILE ${file}: ${reason(e)}; ${SHELL_FALLBACK}`];
  }
}

/**
 * `check -g` from the agent's Bash (Claude Code sets CLAUDECODE=1 in it): no AGENT_SHELL mark — the session didn't get
 * the environment. From a terminal the agent's shell can't be seen — no line.
 */
function agentShellLines(): string[] {
  if (process.env.CLAUDECODE !== "1" || process.env[AGENT_SHELL]) return [];
  return [`  agent Bash: not set up — this session got no environment from the ai-dev SessionStart hook (its output at the session start says why); ${SHELL_FALLBACK}`];
}

/**
 * The check's result plus the machine's lines, installed or not, behind or not: the proxy (`proxyLines`) and the
 * agent's Bash environment — the hook passes what writing it gave, `check -g` asks `agentShellLines`.
 */
function withMachine(global: boolean, r: Result, shell = agentShellLines()): Result {
  if (!global || r.absent) return r;
  const lines = [...proxyLines(os.homedir()), ...shell];
  return lines.length ? { ...r, text: [r.text, ...lines].join("\n") } : r;
}

/**
 * The hook runs outside the Bash sandbox and doesn't see it, but the agent runs the commands it names inside: bunx
 * there can't write its cache `~/.bun/install/cache` ("unable to write files to tempdir: EPERM"), the install —
 * `.claude/skills` (`denied`).
 */
const SANDBOX_HINT = `In the Claude Code sandbox bunx can't write its cache ~/.bun/install/cache — prefix the command with BUN_INSTALL_CACHE_DIR="$TMPDIR/bun"; the sandbox refuses writes to .claude/ too — then the owner runs the command in their terminal.`;

/** One request or two of the github skill to GitHub; the hook has 60 s for everything. */
const RESUME_TIMEOUT = 20_000;

/**
 * The session id from the hook's input: Claude Code passes JSON on stdin (`session_id`, `source` — startup, resume,
 * clear); a run by hand in a terminal has no input — then `CLAUDE_CODE_SESSION_ID`, as the agent's Bash has it.
 */
function hookSession(): string | null {
  let id: unknown;
  if (!isatty(0)) {
    try {
      id = JSON.parse(readFileSync(0, "utf8")).session_id;
    } catch {
      /* no input or not JSON */
    }
  }
  return (typeof id === "string" && id) || process.env.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * The github skill script the agent runs: the machine's — a same-named machine skill wins over the project's in Claude
 * Code, — otherwise the project's copy, otherwise this package's. The commands it prints name its own paths.
 * withProject false — without the project's copy: a command for updating it (updateTaskLine) when it's behind.
 */
function githubScript(withProject = true): string {
  const rel = "skills/github/scripts/github.ts";
  const roots = [path.join(os.homedir(), ".agents"), ...(withProject ? [path.join(projectRoot(), ".agents")] : []), SRC];
  return roots.map((r) => path.join(r, rel)).find((f) => existsSync(f)) ?? path.join(SRC, rel);
}

/**
 * A background wait (ci-wait) dies with the app's process, and the session resumed after a restart doesn't know it has
 * to restart it (#433). The task pinned to the session and its PR are known to the github skill: `task resume` names
 * the wait; no pin — it prints nothing. Not filtered by `source`: the pin itself is the sign of a resumed session — a
 * new session and /clear have a new id. A failure — its lines and a `!` line: the hook's code stays 0.
 */
function resumeLines(): string[] {
  const id = hookSession();
  if (!id) return [];
  const r = spawnSync(process.execPath, ["--no-env-file", githubScript(), "task", "resume"], { encoding: "utf8", timeout: RESUME_TIMEOUT, env: { ...process.env, CLAUDE_CODE_SESSION_ID: id } });
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim());
  if (!r.error && r.status === 0) return lines;
  const why = r.error ? r.error.message : String(r.stderr).trim().split("\n").filter(Boolean).pop() || `exit code ${r.status ?? r.signal}`;
  return [...lines, `! the session's task — github task resume: ${why}`];
}

/**
 * The SessionStart hook: the agent's Bash environment, then the machine and the project in one output to the session
 * context, then the wait a resumed session restarts; the code is always 0, errors go to stdout. failed — the latest
 * release couldn't be found: what's installed is "check unavailable", the environment is written all the same.
 */
function hook(failed?: unknown) {
  const shell = writeAgentShell();
  const results: Result[] = [];
  for (const global of [true, false]) {
    try {
      results.push(withMachine(global, failed && target(global).installed ? unavailable(global, failed) : check(global), shell));
    } catch (e) {
      results.push(withMachine(global, unavailable(global, e), shell));
    }
  }
  const [machine, project] = results;
  const shown = results.filter((r) => !r.absent);
  // rules load only from the project: a git repository without the flow — how to install it (an ai-dev clone is the
  // canon itself, it isn't absent)
  if (project?.absent && gitRoot()) shown.push({ code: 0, run: true, text: `ai-dev in the project: not installed — install it: ${RUN} install --lang <project language>` });
  const resume = resumeLines();
  if (!shown.length && !resume.length) return 0;
  const tail = [];
  // the machine's update touches only ~/.agents and the hook — the session does it; the project's — the copy in the
  // branch: a task of its own (updateTaskLine), the session works by the current flow
  if (machine?.behind) tail.push("The machine is behind — update -g, tell the user what changed (update lists it), re-read what was updated.");
  if (project?.run) {
    tail.push(
      "The project's flow needs update — not in a task session: recommend it to the user and give a chip for its task (task new above; no chips — the first prompt #N), work by the current flow. The update task's session — update, tell the user what changed, commit the copy into its branch, re-read what was updated.",
    );
  }
  if (shown.some((r) => r.ignored)) tail.push("Git ignores flow files — update adds exceptions to .gitignore, committed with the copy in the update task; a rule outside the project — fix it yourself.");
  // the session has no task yet at its start, and one session is one task: the fix goes into a task of its own
  if (shown.some((r) => r.compose)) tail.push("The compose file breaks task isolation — each ❌ line names the rule and the service (the task-env skill); fixing it is a task of its own in the project.");
  if (shown.some((r) => r.code === 2)) tail.push("Check unavailable — work by the current flow and say so.");
  if (shown.some((r) => r.run)) tail.push(SANDBOX_HINT);
  note(["ai-dev flow (AGENTS.md, «First step of a session»):", ...shown.map((r) => r.text), ...resume, ...tail].join("\n"));
  return 0;
}

/**
 * The flow copy's commit subject — in the project language, the `updateCommit` key of this package's github skill
 * dictionary: "ai-dev flow <tag>" in English, the same phrase translated in other languages.
 */
const commitSubject = (root: string, version: string | null | undefined) => locale.fill(locale.names(languageOf(root)).updateCommit, { version: version ?? "" }).trim();

/**
 * Bring the install up to date. A machine with `--link` — `updateLink`; a copy — `install` by this package, in a
 * project with a commit hint.
 */
function update(global: boolean) {
  if (global) {
    const home = os.homedir();
    const clone = linkedClone(home);
    if (clone) return updateLink(clone);
    const from = readManifest(home);
    installGlobal(SRC, false);
    note(whatChanged(from).join("\n"));
    return 0;
  }
  const root = projectRoot();
  if (isAiDevClone(root)) return note(CLONE_NOTE), 0;
  const from = readManifest(root);
  const changed = installProject(SRC, root);
  const version = release ?? short(sourceSha(SRC));
  note(
    [
      ...whatChanged(from),
      "Commit the project copy into the update task's branch:",
      `  git add -A .agents .claude/rules .claude/skills AGENTS.md${changed.map((f) => ` ${f}`).join("")} && git commit -m "chore(agents): ${commitSubject(root, version)}"`,
    ].join("\n"),
  );
  return 0;
}

/**
 * What the update brought, for the agent to tell the user: every release after the installed one up to this package's,
 * newest first — the tag, its page and the list its GitHub Release has (`changeItems`); no releases yet or an installer
 * from a clone — also the flow commits after the last release up to this package's SHA. Can't tell (an install without
 * SHA, no network, the SHA isn't in the history) — a line with the reason: the flow is already installed, the update
 * doesn't fail over it.
 * @param from the manifest before the update
 */
function whatChanged(from: { sha?: unknown; tag?: unknown }): string[] {
  const to = sourceSha(SRC);
  const sha = typeof from.sha === "string" ? from.sha : null;
  const was = (typeof from.tag === "string" && from.tag) || short(sha) || "without SHA";
  const now = release ?? short(to) ?? "SHA unknown";
  if (sha && sha === to) return [`ai-dev flow ${now} was already installed — nothing changed`];
  const unavailable = (why: string) => [`ai-dev flow ${was} → ${now}: changes unavailable — ${why}; releases: ${RELEASES}`];
  if (!sha) return unavailable("installed without SHA");
  if (!to) return unavailable("the SHA of this package is unknown");
  let groups;
  try {
    groups = releaseGroups(sha, to);
  } catch (e) {
    return unavailable(reason(e));
  }
  const tags = groups.filter((g) => g.tag).length;
  return [
    `ai-dev flow ${was} → ${now}${tags ? `, new releases: ${tags}` : ""} — tell the user what changed:`,
    // commits after the last release (an installer from a clone) are named only next to releases
    ...groups.flatMap((g) => [...(g.tag ? [`${g.tag} — ${RELEASES}/tag/${g.tag}`] : tags ? [`${short(to)} — not in a release`] : []), ...g.items.map((i) => `  ${i}`)]),
  ];
}

/**
 * The releases between two SHAs of ai-dev, newest first, each with its list of changes; commits after the last of them
 * (no releases yet, an installer from a clone) — a group without a tag. The history comes from where the releases do,
 * fetched without file contents into a temporary repository: the bunx package has no `.git`. A release's list starts
 * from the previous release, the first one's — from `from`: with an install from a release that is exactly its GitHub
 * Release's list.
 */
function releaseGroups(from: string, to: string): { tag?: string; items: string[] }[] {
  const remote = repoUrl();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ai-dev-history-"));
  try {
    git(tmp, "init", "--quiet", "--bare");
    git(tmp, "fetch", "--quiet", "--no-tags", "--filter=blob:none", remote, to);
    const range = new Set(git(tmp, "rev-list", `${from}..${to}`).split("\n"));
    const tags = releases(remote).filter((r) => range.has(r.sha));
    const groups: { tag?: string; items: string[] }[] = [];
    let prev = from;
    for (const r of tags) groups.push({ tag: r.tag, items: changeItems(tmp, `${prev}..${(prev = r.sha)}`) });
    if (prev !== to) groups.push({ items: changeItems(tmp, `${prev}..${to}`) });
    return groups.reverse();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The flow changes in a range of first-parent commits, a `- …` line each — the list of a GitHub Release and of
 * `update`: commits that touched the flow or the installer; a PR merged with a merge commit — by its title and number,
 * one merged by rebase — by its own commits with the task number from `Refs #N`.
 */
function changeItems(repo: string, range: string): string[] {
  return git(repo, "log", "--first-parent", "--format=%s%x1f%b%x1e", range, "--", ...RELEASED)
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
}

/**
 * A `--link` clone: only main and without changes in tracked files — otherwise a refusal (code 1), the clone is left
 * alone: that's the user's work. Then `git pull --ff-only` and `install -g --link` with the code of the updated clone:
 * this process may have loaded its old version, and new skills need links too.
 */
function updateLink(clone: string) {
  let branch = "";
  try {
    branch = git(clone, "symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    /* HEAD is detached */
  }
  if (branch !== "main") return warn(`update: clone ${clone} is not on main (${branch ? `branch ${branch}` : "HEAD detached"}) — switch it yourself and retry`), 1;
  const dirty = execFileSync("git", ["-C", clone, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trimEnd();
  if (dirty) return warn(`update: clone ${clone} has changes in tracked files — commit or remove them yourself and retry:\n${dirty}`), 1;
  const before = git(clone, "rev-parse", "HEAD");
  try {
    git(clone, "pull", "--ff-only", "--quiet", "origin", "main");
  } catch (e) {
    return warn(`update: git pull --ff-only in clone ${clone} — ${reason(e)}`), 2;
  }
  const after = git(clone, "rev-parse", "HEAD");
  const items = changeItems(clone, `${before}..${after}`);
  const head = `clone ${clone}: ${short(before)} → ${short(after)}`;
  note((items.length ? [`${head} — tell the user what changed:`, ...items.map((i) => `  ${i}`)] : [`${head}, the flow hasn't changed`]).join("\n"));
  return spawnSync(process.execPath, ["--no-env-file", path.join(clone, "bin/ai-dev.ts"), "install", "-g", "--link"], { stdio: "inherit" }).status ?? 2;
}

/**
 * A release is the owner's step, from a clone: the tag vYYYY.MM.DD (the date in UTC; a second one the same day — .1,
 * .2…) on origin/main and a GitHub Release with the list of changes since the previous release (`changeItems` — `update`
 * prints the same list). Nothing to release — a refusal (code 1): projects mustn't update for nothing.
 * @param preview `--dry-run`: show the tag and the list, create nothing
 */
function releaseCmd(preview: boolean) {
  if (!existsSync(path.join(SRC, ".git"))) return warn("release — only from an ai-dev clone: bun <clone>/bin/ai-dev.ts release"), 2;
  let head, tags, items;
  try {
    git(SRC, "fetch", "--quiet", "origin", "main");
    head = git(SRC, "rev-parse", "origin/main");
    tags = releases("origin", SRC);
    const last = tags.at(-1);
    items = last ? changeItems(SRC, `${last.sha}..${head}`) : [];
  } catch (e) {
    return warn(`release: ${reason(e)}`), 2;
  }
  const last = tags.at(-1);
  if (last?.sha === head) return warn(`release: origin/main ${short(head)} is already in release ${last.tag}`), 1;
  if (last && !items.length) return warn(`release: the flow hasn't changed since ${last.tag} — no release needed`), 1;
  const notes = last ? [`Flow changes since ${last.tag}:`, "", ...items].join("\n") : "First release: projects install and update the flow by ai-dev releases, not by main.";
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
  note(`\nRelease ${tag}: ${RELEASES}/tag/${tag}`);
  return 0;
}

/**
 * The `install` question in a project about the `auto` setting: "yes" allows the agent everything listed without a
 * "yes" for each action.
 */
const AUTO_QUESTION = "Let the agent do tasks entirely by itself — answers by recommendation, commit, push, fixing CI, merge on green checks?";

/**
 * The `install` question in a project about the language: in it the agent talks to the human and writes tasks,
 * prompts and documents.
 */
const LANGUAGE_QUESTION = "Project language the agent works in — dialog, tasks, prompts, documents (code: ru, en, …)?";

/**
 * The answer to a question in the terminal: the line trimmed of spaces; input closed or unreadable — null.
 * Synchronous and without dependencies — `readSync(0)`: `main` is synchronous.
 */
function readAnswer(prompt: string) {
  const buf = Buffer.alloc(1024);
  process.stdout.write(prompt);
  try {
    const n = readSync(0, buf, 0, buf.length, null);
    return n ? buf.toString("utf8", 0, n).trim() : null;
  } catch {
    return null;
  }
}

/**
 * A yes/no question in the terminal: Enter — the default value (shown in upper case), an unclear answer — the
 * question again. Input closed or unreadable — the default value.
 */
function ask(question: string, def: boolean) {
  for (;;) {
    const answer = readAnswer(`${question} [${def ? "Y/n" : "y/N"}] `)?.toLowerCase();
    if (!answer) return def;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

/**
 * A language question in the terminal: Enter — the default value, not a language code — the question again; input
 * closed — the default.
 */
function askLanguage(def: string) {
  for (;;) {
    const answer = readAnswer(`${LANGUAGE_QUESTION} [${def}] `);
    if (!answer) return def;
    if (LANGUAGE_CODE.test(answer)) return answer;
  }
}

/**
 * `--lang <code>` or `--lang=<code>` among the flags: the code and the other flags; a flag without a value — code "",
 * the code check will reject it.
 */
function takeLang(flags: string[]): { lang: string | undefined; rest: string[] } {
  let lang: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i] ?? "";
    if (f === "--lang") lang = flags[++i] ?? "";
    else if (f.startsWith("--lang=")) lang = f.slice("--lang=".length);
    else rest.push(f);
  }
  return { lang, rest };
}

/**
 * The `install` hint with auto. The Claude Code app rejects a merge without human review even in auto mode: the
 * machine's permission rule decides it, and that rule applies to all the machine's repositories — wider than the
 * project. So `install` names the rule instead of setting it: otherwise the owner learns about it from a refusal at
 * the end of the first task.
 */
const MERGE_HINT = (language: string) =>
  [
    "Claude Code: for the session to merge its own PR, the machine needs a permission rule — the owner adds it, install doesn't change the settings:",
    '  ~/.claude/settings.json → permissions.allow: "Bash(gh pr merge *)"',
    `  without the rule the app rejects a merge without human review — the session ends with «${locale.names(language).lastLine.remaining} …», the merge is left to the owner`,
  ].join("\n");

/**
 * No permission to write — usually an agent's sandbox: Claude Code's refuses writes to `.claude/skills` of a project
 * and to `~/.agents`. Instead of a stack — what was refused and the same command for the owner's terminal: the install
 * order (installSkills) lets a repeat run finish it. Not a permission error — false, the caller handles it.
 * @returns the error was reported
 */
function denied(e: unknown, argv: string[], global: boolean) {
  const err = e as { code?: unknown; path?: unknown; dest?: unknown };
  if (err?.code !== "EPERM" && err?.code !== "EACCES") return false;
  const file = String(err.dest ?? err.path ?? "");
  const home = os.homedir();
  const shown = global && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : path.relative(projectRoot(), file);
  warn(`${argv[0]}: no permission to write ${shown} (${err.code}) — an agent's sandbox? Run the same command in your own terminal, a repeat run finishes it: ${RUN} ${argv.join(" ")}`);
  return true;
}

const FLAGS: Record<string, string[]> = { install: ["-g", "--global", "--link", "--auto", "--no-auto"], check: ["-g", "--global", "--hook"], update: ["-g", "--global"], release: ["--dry-run"] };

function main(argv: string[]) {
  const [cmd = "", ...args] = argv;
  const help = helpOf(argv) ?? (cmd === "help" ? OVERVIEW : undefined);
  if (help) return note(help), 0;
  const global = args.includes("-g") || args.includes("--global");
  const hookMode = cmd === "check" && args.includes("--hook");
  // the launcher restarts before it checks the command and flags (`toRelease`): bunx keeps it as old as its first run,
  // and it mustn't reject what the release knows. "Not installed" needs no release: the hook in someone else's project
  // doesn't go to the network for nothing; release — only from a clone
  if (cmd !== "release" && (cmd !== "check" || (hookMode ? [true, false].some((g) => target(g).installed) : target(global).installed))) {
    try {
      const code = toRelease(argv);
      if (code !== null) return code;
    } catch (e) {
      if (hookMode) return hook(e);
      if (cmd === "check") return process.stderr.write(unavailable(global, e).text + "\n"), 2;
      return warn(`${cmd}: ${reason(e)}`), 2;
    }
  }
  // --lang with a value — only for install: for the other commands it's an unknown flag
  const { lang, rest: flags } = cmd === "install" ? takeLang(args) : { lang: undefined, rest: args };
  const allowed = Object.hasOwn(HELP, cmd) ? FLAGS[cmd] : undefined;
  const unknown = allowed ? flags.filter((f) => !allowed.includes(f)) : [];
  if (!allowed || unknown.length) {
    process.stderr.write((!allowed && cmd ? `unknown command: ${cmd}\n\n` : unknown.length ? `unknown flag: ${unknown[0]}\n\n` : "") + OVERVIEW + "\n");
    return 2;
  }
  if (lang !== undefined && (global || !LANGUAGE_CODE.test(lang))) {
    warn(`--lang <code> — the project language the agent works in: without -g, a BCP 47 code — ru, en, pt-BR${global ? "" : `; «${lang}» is not a language code`}`);
    return 2;
  }
  if (cmd === "release") return releaseCmd(flags.includes("--dry-run"));
  if (cmd === "check") {
    if (hookMode) return hook();
    let r: Result;
    try {
      r = check(global);
    } catch (e) {
      r = unavailable(global, e);
    }
    r = withMachine(global, r);
    (r.code === 2 ? process.stderr : process.stdout).write(r.text + "\n");
    return r.code;
  }
  if (cmd === "update") {
    try {
      return update(global);
    } catch (e) {
      return denied(e, argv, global) || warn(`update: ${reason(e)}`), 2;
    }
  }
  const linkMode = flags.includes("--link");
  if (linkMode && (!global || !existsSync(path.join(SRC, ".git")))) {
    warn("--link — only with -g and only from an ai-dev clone: a project commits a copy, not a link to a local clone");
    return 2;
  }
  const [on, off] = [flags.includes("--auto"), flags.includes("--no-auto")];
  if ((on || off) && (global || (on && off))) {
    warn("--auto and --no-auto — the project setting «a task entirely without asking»: without -g and only one of the two");
    return 2;
  }
  try {
    if (global) return installGlobal(SRC, linkMode), 0;
    const root = projectRoot();
    // questions — only here and only in a terminal: `update` and `check` (the hook at session start) go through
    // installProject without them
    const tty = isatty(0) && isatty(1);
    const language = lang ?? (tty ? askLanguage(languageOf(root)) : languageOf(root));
    const before = autoOf(root);
    const auto = on ? true : off ? false : tty ? ask(AUTO_QUESTION, before) : before;
    if (isAiDevClone(root)) installClone(root, auto, language);
    else installProject(SRC, root, auto, language);
    if (auto) note(MERGE_HINT(language));
    return 0;
  } catch (e) {
    if (denied(e, argv, global)) return 2;
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
