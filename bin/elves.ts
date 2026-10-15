#!/usr/bin/env bun
/**
 * elves — installs the flow: the shared rules, references and all Elves skills into a project or onto the machine;
 * checks whether an install has fallen behind the latest Elves release, updates it and cuts a release.
 *
 *   bunx github:miroshnik/elves install                — into the project: the git root (or the current directory)
 *   bunx github:miroshnik/elves install -g             — machine-wide: the canon, skills and hook
 *   elves install -g                                   — the same from the npm package (npm i -g @miroshnik/elves)
 *   bun <Elves clone>/bin/elves.ts install -g --link   — from a clone: symlinks to the clone, edits show at once
 *   bunx github:miroshnik/elves check [-g]             — is the install behind: 0 — no, 1 — yes, 2 — can't tell
 *   bunx github:miroshnik/elves update [-g]            — bring the install up to date
 *   bun <Elves clone>/bin/elves.ts release             — cut a release: a tag and the list of flow changes
 *   bun <Elves checkout>/bin/elves.ts pack <tag>       — CI on the release tag: the npm package @miroshnik/elves
 *   elves spec-doc … · elves slot --for <PID>          — a project with the package: the skills' scripts at its version
 *
 * The layout is as with skills (`npx skills`), on the machine (`-g`, #557): the canon `~/.agents/elves/` (AGENTS.md,
 * claude/CLAUDE.md, docs/*.md) with Claude Code's rules `~/.claude/rules/elves*.md` — they load without the
 * external-imports dialog in every project of the machine — and the global rule files of the other agents linking to it
 * (`agentRules`), skills (`~/.agents/skills/<name>/`, Claude Code — symlinks in `~/.claude/skills`) and the hook. A
 * project is thin (#552): no copy of the flow, the repository holds only `@miroshnik/elves` in devDependencies
 * (PACKAGE: the project's version of the harness and the skills' scripts for its tests and CI), the manifest, the
 * machine queue's shim `.agents/slot.sh` and a block in the project's `AGENTS.md` linking to the canon on the machine;
 * updating the project is bumping the package version — a few lines in the branch of the current task. A project with a
 * copy of an earlier release loads the canon twice until it moves — the hook names it (`twiceLines`); `install` and
 * `update` move it to a thin one: the copy, its symlinks and `.gitignore` exceptions go (`removeCopy`), the imports and
 * CI paths into the copy lead to the package (`rewriteCopyRefs`), the rest that names `.agents` is listed
 * (`copyLeftovers`).
 * `.agents/elves.json` — on the machine the Elves SHA it was installed from, the list of installed skills (by it a
 * reinstall removes skills Elves no longer has and leaves others' alone), for a machine with `--link` — the clone path;
 * in a project — only `auto`: whether the agent runs a task entirely by itself — answers to questions by
 * recommendation, commit, push, fixing CI and merging its own PR on green checks (AGENTS.md, "What I do without asking
 * and what needs a yes"), `language` — the language the agent works in in the project: dialog, tasks, prompts,
 * documents (AGENTS.md, "Language"; the flow is written in English), and `env` — the task stack settings of the
 * task-env skill. `install` in a project sets auto and language — by a question in the terminal or by
 * the flags `--auto` / `--no-auto` and `--lang <code>`; by default auto is "no", the language is `en`, without a
 * terminal and a flag — the previous value, `update` keeps it. An install of a previous version has no `language`
 * field, and the flow before it worked only in Russian: its language is `ru` (`LEGACY_LANGUAGE` of the github skill's
 * language module), `update` writes it. With auto `install` suggests the Claude Code permission rule for the merge
 * (MERGE_HINT) — it doesn't change the machine's settings. The flow isn't installed into an Elves clone (the canon is
 * at its root): `install` writes a single manifest there, with `auto` and `language`.
 * The project's flow files are committed — the ones the project's git ignores (`.agents/`) the install un-ignores with
 * exceptions in an Elves block at the end of `.gitignore`, `check` reports them as a mismatch (`gitignoreFlow`). A
 * project's compose file `check` holds to the task isolation rules
 * with the task-env skill's command (`composeCheck`): a violation is a mismatch too, `update` doesn't fix it; so is a
 * project with standards or architecture without a `test:spec` script — `check` names the lines (`specScript`); a
 * `test` that runs them a second time next to `test:spec` — an `○` line with `test` without them. The
 * project's checks — the `package.json` scripts `lint`, `typecheck`, `test`, `test:*` — the install wraps in the
 * machine queue, the slot skill (`packageScripts`); if such a script calls turbo and turbo.json doesn't pass the queue
 * variables to tasks, it warns with a ready-made line (`turboEnv`).
 *
 * A copy on the machine without `--link` and a project's package version follow Elves releases — tags vYYYY.MM.DD — not
 * main: the bunx package from main is only a launcher — it finds the latest release and restarts from it by SHA
 * (`toRelease`); the project gets the release's npm version (`ownVersion`). The npm package is a release itself — its
 * version (`npmRelease`): `install` from it installs that release without the network, `check` and `update` restart
 * from the latest release's npm package.
 * `check` is the same install as a dry run: the release package lists what it would change. A machine with `--link`
 * is different: the clone is compared with `origin/main` after `git fetch`, `update` does `git pull --ff-only` and
 * re-creates the links with the code of the updated clone.
 * `update` says what changed — the agent tells the user: a copy and a project — every release after the installed one
 * (a project — after its package version), newest first, with the list of changes its GitHub Release has (one
 * function, `changeItems`, builds both); a `--link` clone — the flow commits it pulled.
 *
 * TypeScript under Bun, like the skills' scripts: bunx runs the package's bin by its shebang, and Bun strips types in
 * node_modules too — so the installer imports the skills' values (the language module, the task-env compose files and
 * proxy name) instead of holding copies. No dependencies, only node: APIs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { packageManager, specRoots } from "../skills/github/scripts/github.ts";
import locale from "../skills/github/scripts/locale.ts";
import { COMPOSE_FILES, formerProxyName, proxyName } from "../skills/task-env/scripts/task-env.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SOURCE = "miroshnik/elves";
/**
 * The npm package: a project gets it in devDependencies — the harness and the skills' scripts at the project's version
 * (`SCRIPTS`, `exports` of package.json); its version is the release tag (`npmVersion`), CI publishes it on the tag.
 */
const PACKAGE = "@miroshnik/elves";
/**
 * The repository's name before the rename to Elves (#544): GitHub redirects it, installs of earlier releases still call
 * it — a SessionStart hook with it is ours (`claudeHook`), a `--link` clone's origin with it moves to SOURCE
 * (`cloneOrigin`), a clone with this package name is a clone (`isElvesClone`).
 */
const LEGACY_SOURCE = "miroshnik/ai-dev";
/** The command the output names: the installer from GitHub through bunx, then the subcommand. */
const RUN = `bunx github:${SOURCE}`;

/** The install's manifest: `.agents/elves.json`. */
const MANIFEST = ".agents/elves.json";
/** The rules canon in a project: a copy of AGENTS.md, claude/CLAUDE.md and docs/*.md. */
const CANON = ".agents/elves";
/** Claude Code's rules: symlinks to the canon's AGENTS.md and claude/CLAUDE.md. */
const RULES = { agents: ".claude/rules/elves.md", claude: ".claude/rules/elves-claude.md" };
/** The personal configuration directory, from the home directory (tests/standards/config-dir). */
const CONFIG = ".config/elves";

/**
 * The flow's names before the rename to Elves (#545). An install of an earlier release has them: `update` moves each to
 * its new name and replaces a block instead of adding a second one, the skills' scripts read the former manifest and
 * configuration directory until it does, `check` names what is left. A user's variable `update` can't rename — `check
 * -g` names it with the new name; the launcher of an earlier release passes AI_DEV_RELEASE, the hook of an earlier
 * release marks the agent's Bash with AI_DEV_AGENT_SHELL.
 */
const FORMER = {
  /** The flow's former name itself — in the output about what is left under it. */
  name: "ai-dev",
  manifest: ".agents/ai-dev.json",
  canon: ".agents/ai-dev",
  rules: [".claude/rules/ai-dev.md", ".claude/rules/ai-dev-claude.md"],
  begin: "<!-- ai-dev:begin",
  end: "<!-- ai-dev:end -->",
  giBegin: "# ai-dev:begin",
  giEnd: "# ai-dev:end",
  config: ".config/ai-dev",
  release: "AI_DEV_RELEASE",
  agentShell: "AI_DEV_AGENT_SHELL",
  /** A user's variables under the former name: the new name → the former one. */
  env: { ELVES_CONFIG_DIR: "AI_DEV_CONFIG_DIR", ELVES_PRIVATE: "AI_DEV_PRIVATE", ELVES_PROXY: "AI_DEV_PROXY", ELVES_PROXY_PORT: "AI_DEV_PROXY_PORT" },
  /** The slot skill's queue variables: runner configs and `turbo.json` of projects pass them until renamed. */
  slotEnv: ["AI_DEV_SLOT", "AI_DEV_SLOT_CPUS"],
};
/** What `check` adds to a line about a file or a directory under the former name. */
const FORMER_NOTE = `the flow's former name (${FORMER.name}) — update moves it`;

const BEGIN = "<!-- elves:begin";
const END = "<!-- elves:end -->";
/**
 * The block in a project's AGENTS.md: the canon and the skills are on the machine (`install -g`), not in the
 * repository — the agents without the machine's rules (Codex and others without a global rules file) read them by it.
 */
const BLOCK = [
  `${BEGIN} — set by \`${RUN} install\`, don't edit by hand -->`,
  `Shared rules — \`~/${CANON}/AGENTS.md\` on the machine (\`${RUN} install -g\`): read them before starting work (references — \`~/${CANON}/docs/\`).`,
  "Skills — `~/.agents/skills/`.",
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
const HOOK_COMMAND = `bunx --silent github:${SOURCE} check --hook 2>&1 || echo "elves check unavailable (exit $?): work by the current flow and say so"`;
const HOOK = { matcher: "startup|resume|clear", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] };

/** Flow files in the clone: what `install` installs from it (a git pathspec). */
const FLOW = ["AGENTS.md", "claude/CLAUDE.md", ":(glob)docs/*.md", "skills"];
/** What makes a release necessary: the flow and the installer — projects get its code from the release too. */
const RELEASED = [...FLOW, "bin"];
/** Release tag: vYYYY.MM.DD, a same-day patch — vYYYY.MM.DD.N. */
const RELEASE_TAG = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.([1-9]\d*))?$/;
/** Elves releases on GitHub: a release's page is `${RELEASES}/tag/<tag>`. */
const RELEASES = `https://github.com/${SOURCE}/releases`;
/** Lines of the change list in `check` output — beyond that, "… and N more". */
const MAX_LINES = 20;
/** The compose file check — a command of the task-env skill, from the package `check` runs from. */
const TASK_ENV = path.join(SRC, "skills/task-env/scripts/task-env.ts");
/** bun start and `docker compose config` take a fraction of a second; the hook has 60 s for everything. */
const TASK_ENV_TIMEOUT = 30_000;

/**
 * Help — `--help` or `-h` anywhere in the arguments (tests/standards/cli-help): a command's synopsis (the first
 * paragraph), what it does and examples; `elves --help` — the synopses of all. Answered before the launcher goes to the
 * release (`toRelease`) — by the launcher's own version: no network, at the cost of lagging behind a newer release. The
 * dispatcher takes only the commands from here (their flags — `FLAGS`) and the skills' scripts (`SCRIPTS`).
 */
const HELP: Record<string, string> = {
  install: `elves install [--auto | --no-auto] [--lang <code>]
elves install -g [--link]

The flow of the latest Elves release into the project (the git root or the current directory), thin — without a copy:
${PACKAGE} of the release in devDependencies of package.json (the project's package manager installs it, the lockfile
changes too), .agents/elves.json, the machine queue's shim .agents/slot.sh and a block in AGENTS.md linking to the canon
on the machine; the package.json checks (lint, typecheck, test, test:*) go through the shim, the skills' scripts —
elves <script>. A project with a copy of the flow of an earlier release moves to a thin one: the copy, its symlinks and
.gitignore exceptions go, imports and CI paths into the copy lead to the package, what else names .agents is listed.
In a terminal asks whether the agent does tasks entirely by itself — answers by recommendation, commit, push,
fixing CI, merge on green checks (auto in .agents/elves.json, default — no); without a terminal — the --auto or
--no-auto flag, without the flag the previous answer stays; with auto prints the Claude Code permission rule for the
merge — Bash(gh pr merge *) in ~/.claude/settings.json: the owner adds it, install doesn't change the machine's
settings. --lang <code> — the project language the agent works in: dialog, tasks, prompts, documents (language in
.agents/elves.json, a BCP 47 code: ru, en, pt-BR); in a terminal — a question, en by default, without the flag and a
terminal — the previous one. In an Elves clone writes only auto and language.
-g — onto the machine: the canon in ~/.agents/elves with Claude Code's rules ~/.claude/rules/elves*.md and the global
rule files of Codex, Gemini CLI, Copilot, OpenCode and Amp linking to it (someone else's file stays), the skills
(~/.agents/skills, ~/.claude/skills) and the SessionStart hook; without a terminal too — a cloud environment's setup
script (CLAUDE_CODE_REMOTE=true) gets the canon and skills without the hook: the cloud doesn't read
~/.claude/settings.json. From the npm package (npm i -g / bun add -g ${PACKAGE}) — the release of its version, without
the network. --link — from an Elves clone: symlinks to the clone instead of copies, edits show up immediately.

Examples:
  elves install --auto --lang en
  elves install -g`,
  check: `elves check [-g]
elves check --hook

Whether the install is behind, changes nothing: 0 — up to date, 1 — behind, the project's git ignores flow files, its
compose file breaks task isolation or standards and architecture have no test:spec script, 2 — the check is
unavailable; the machine's copy and a project's package version are compared with the latest release (from the npm
package — by restarting from the latest release's package), a --link clone — with origin/main. For a project names the
mode (auto) and the language, holds the compose file to the task isolation rules (❌ per violation, ○ — not checked: no
docker compose; the task-env skill), names a test that runs standards and architecture again next to test:spec (○, the
ready test without them) and warns (!) if a script in slot calls turbo and turbo.json doesn't pass the queue variables
to tasks (the exit code stays the same); a thin project behind — update in this session's task (the package version in
package.json and the lockfile), a project with a copy of the flow — the move to a thin project in a task of its own: the
task new command of the github skill, one task per project. For the machine names the task-env proxy of *.localhost
addresses — running, not running or running
under the flow's former name, with the command (with Docker on the machine; the exit code stays the same), the user's
variables under the former name (AI_DEV_*) with the new one, run from the agent's Bash in Claude Code — a session
without the agent's Bash environment, for a --link clone run from an Elves clone — flow commits not in a release yet.
--hook — the machine and the project at once for the Claude Code SessionStart hook: the exit code is always 0, errors
go to the output; writes the agent's Bash environment to $CLAUDE_ENV_FILE — zsh without errors on a glob without matches
and on =word, timeout from bin/shims; a project with a copy of the canon next to the machine's rules — the canon loads
twice: names it and the project's update task that moves it to the thin project.

Examples:
  elves check
  elves check -g`,
  update: `elves update [-g]

Brings it up to date: a --link clone — git pull --ff-only, the machine's copy — install of the latest release: the
canon, the skills and the hook; a project — install of the latest release: ${PACKAGE} in package.json and the
lockfile, a few lines in the branch of the current task; a project with a copy of the flow moves to a thin one (install
--help); from the npm package — by restarting from the latest release's package. The project's mode and language are
kept; an install of a previous version without a language gets ru: before the field the flow worked in Russian. In a
project install and update un-ignore flow files from .gitignore patterns with exceptions at its end and wrap the
package.json checks (lint, typecheck, test, test:*) in the machine queue slot; prints what changed: every release after
the installed one, newest first, with the list of changes of its GitHub Release (a --link clone — the flow commits it
pulled), and the git add of what changed. An install from before the rename to Elves — the ai-dev names
(.agents/ai-dev.json, .agents/ai-dev/, .claude/rules/ai-dev*.md, the blocks in AGENTS.md and .gitignore,
~/.config/ai-dev) move to the new ones with the same contents.

Examples:
  elves update
  elves update -g`,
  release: `elves release [--dry-run]

From an Elves clone: a vYYYY.MM.DD tag on origin/main and a GitHub Release listing the flow changes since the previous
release; --dry-run — only show them.

Examples:
  elves release --dry-run`,
  pack: `elves pack <tag>

From an Elves checkout, in CI on a release tag: the npm package ${PACKAGE} of that release — the version
from the tag into package.json (vYYYY.MM.DD.N → YYYY.MMDD.N: semver without leading zeros, versions sort as tags), the
release commit into its gitHead and the modules a project imports (exports of package.json: the harness, the
architecture model, the ESLint fragment, github) built for Node into dist/; then npm publish. Not a release tag — code
2, nothing changes.

Examples:
  elves pack v2026.10.15.1`,
};

/**
 * The skills' scripts a project runs at its own Elves version — the package in its devDependencies, without a copy of
 * the flow: `elves spec-doc …` from `node_modules/.bin` runs the script's `main` from this package with the same
 * arguments, in this process; the project's paths (`.agents/elves.json`, `tests/`, the reports) come from the current
 * directory and its git root, as with `bun <copy>/scripts/<script>.ts`. No release launcher (`toRelease`): the version
 * is the project's. Help — the script's own `HELP` under the elves name; `--help` counts where the script reads it: a
 * spec script — before `--`, slot — only as the first argument (the rest is its command). A script module runs its
 * `main` itself only as the entry point (`import.meta.main`).
 */
const SCRIPTS: Record<string, { file: string; helpFirst?: boolean }> = {
  ...Object.fromEntries(["spec-doc", "spec-diff", "spec-publish", "spec-run", "spec-shard", "spec-claims", "spec-break", "spec-exceptions"].map((name) => [name, { file: `skills/spec/scripts/${name}.ts` }])),
  slot: { file: "skills/slot/scripts/slot.ts", helpFirst: true },
};

/** A script of SCRIPTS: its help and its entry point. */
interface Script {
  HELP: string;
  main: (argv: string[]) => number | Promise<number>;
}

const loadScript = (cmd: string): Promise<Script> => import(path.join(SRC, SCRIPTS[cmd]!.file));

/** A script's help under the elves name: its synopsis and example lines start with `elves <command>`. */
const scriptHelp = async (cmd: string) => (await loadScript(cmd)).HELP.replace(new RegExp(`^( *)${cmd}(?= |$)`, "gm"), `$1elves ${cmd}`).trimEnd();

/** `elves <script> …`: the script's help or its `main` with the arguments; the exit code is the script's. */
async function runScript(cmd: string, args: string[]): Promise<number> {
  const options = SCRIPTS[cmd]!.helpFirst ? args.slice(0, 1) : args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (options.some((a) => a === "--help" || a === "-h")) return note(await scriptHelp(cmd)), 0;
  return (await loadScript(cmd)).main(args);
}

/** `elves --help`: the synopsis of each command, the scripts' too, and how to run it. */
async function overview() {
  const synopsis = (h: string) => h.split("\n\n")[0]!.replace(/^/gm, "  ");
  const scripts = await Promise.all(Object.keys(SCRIPTS).map(scriptHelp));
  return [
    "elves — the rules and skills of the Elves flow: install, check, update, release, pack; skill scripts at a project's version",
    "",
    ...Object.values(HELP).map(synopsis),
    ...scripts.map(synopsis),
    "",
    "elves <command> --help — the command's details and examples",
    `Run: ${RUN} <command>; in a project with ${PACKAGE} in devDependencies — elves <command>`,
  ].join("\n");
}

/** The help the arguments ask for (`--help`, `-h`): of the command they start with, otherwise the overview; none — undefined. */
async function helpOf(argv: string[]): Promise<string | undefined> {
  if (!argv.some((a) => a === "--help" || a === "-h")) return undefined;
  const words = `${argv.join(" ")} `;
  const cmd = Object.keys(HELP).find((c) => words.startsWith(`${c} `));
  return cmd ? HELP[cmd] : overview();
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

/** Paths from the project root the install wrote or removed: `update` names them for the commit. */
const touched: string[] = [];
const touch = (rel: string) => void touched.push(rel);

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
 * The Elves SHA the install runs from: for a clone — HEAD; for the bunx package — the SHA of the spec bunx installed it
 * by, `github:miroshnik/elves#<sha>` in the package.json of the bunx directory next to node_modules (bunx unpacks the
 * package from GitHub without `.git`, its `.bun-tag` holds only 7 characters of the SHA). The package under its scope
 * (`node_modules/@miroshnik/elves`) — the spec under the full name. The package from main — no SHA in the spec — null:
 * it is only a launcher (`toRelease`). The npm package (`npmRelease`) — the commit `pack` wrote into its `gitHead`: its
 * spec is a version, `npm i -g` has no package.json above it at all.
 */
function sourceSha(src: string) {
  if (existsSync(path.join(src, ".git"))) {
    try {
      return git(src, "rev-parse", "HEAD");
    } catch {
      return null;
    }
  }
  if (npmRelease(src)) {
    const head: unknown = ownPackage(src).gitHead;
    return typeof head === "string" && /^[0-9a-f]{40}$/.test(head) ? head : null;
  }
  const scope = path.basename(path.dirname(src)).startsWith("@") ? path.basename(path.dirname(src)) : null;
  const nm = scope ? path.dirname(path.dirname(src)) : path.dirname(src);
  if (path.basename(nm) !== "node_modules") return null;
  const name = scope ? `${scope}/${path.basename(src)}` : path.basename(src);
  try {
    const spec: unknown = JSON.parse(readFileSync(path.join(nm, "..", "package.json"), "utf8")).dependencies?.[name];
    return /#([0-9a-f]{40})$/.exec(String(spec ?? ""))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The package's own package.json; unreadable — empty. */
function ownPackage(src: string): { name?: unknown; version?: unknown; gitHead?: unknown } {
  try {
    return JSON.parse(readFileSync(path.join(src, "package.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

/**
 * The release of the npm package — `npm i -g`, `bun add -g`, a project's devDependencies: the package is a release
 * itself, its version is the release tag (`npmVersion` back, `releaseTag`). A clone, a package from GitHub (the
 * repository's version 0.0.0 — `pack` sets the release version only in CI) — null.
 */
function npmRelease(src: string): string | null {
  if (existsSync(path.join(src, ".git"))) return null;
  const { name, version } = ownPackage(src);
  return name === PACKAGE && typeof version === "string" ? releaseTag(version) : null;
}

/**
 * The release tag of an npm version — `npmVersion` back: YYYY.MMDD.N → vYYYY.MM.DD.N, .0 — without a patch; not a
 * release version — null.
 */
function releaseTag(version: string): string | null {
  const m = /^(\d{4})\.(\d{3,4})\.(\d+)$/.exec(version);
  if (!m) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = Number(m[2]);
  const tag = `v${m[1]}.${pad(Math.floor(md / 100))}.${pad(md % 100)}${m[3] === "0" ? "" : `.${m[3]}`}`;
  return npmVersion(tag) === version ? tag : null;
}

/** Release tags in order: by date, then by patch number; negative — a is older. */
function compareTags(a: string, b: string) {
  const key = (tag: string) => (RELEASE_TAG.exec(tag) ?? []).slice(1).map((n) => Number(n ?? 0));
  const [ka, kb] = [key(a), key(b)];
  return ka.reduce((r, n, i) => r || n - (kb[i] ?? 0), 0);
}

const lsRemote = (args: string[], cwd?: string) =>
  execFileSync("git", ["ls-remote", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/**
 * Elves releases in ascending order — RELEASE_TAG tags from `git ls-remote --tags remote` (by date, then by patch
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
  return [...tags].map(([tag, sha]) => ({ tag, sha })).sort((a, b) => compareTags(a.tag, b.tag));
}

/** The commit of the remote's HEAD — main; an empty repository — null. A git error throws. */
function mainHead(remote: string) {
  return lsRemote([remote, "HEAD"]).split("\t")[0]?.trim() || null;
}

/** Where releases and their history come from: ELVES_REPO (a mirror, tests) or GitHub. */
const repoUrl = () => process.env.ELVES_REPO || `https://github.com/${SOURCE}.git`;

/**
 * A copy follows Elves releases, not main. bunx installs a package by its spec once and then runs it from its cache
 * without the network: the package from main (`bunx github:miroshnik/elves`) stays as old as its first run. So it is
 * only a launcher: it finds the latest release and restarts from it by the full SHA — a SHA doesn't change, the cache
 * doesn't harm it; no releases yet — by the SHA of main's head. A package installed by a SHA (`sourceSha`: the restart
 * or the user's own pin) works itself; ELVES_RELEASE — the tag the launcher restarted to. A clone installs itself as
 * is. Tags come from ELVES_REPO (a mirror, tests) or GitHub. The launcher is as old as its first run, the release may be
 * older than the launcher: the tag goes under the former name too (FORMER.release) — each reads its own.
 * The npm package is a release itself (`npmRelease`): from it `install` installs its own version — no launcher and no
 * network, as a cloud environment's setup script needs it (`github:` there would install from GitHub, not npm, and in
 * the cloud session itself it is 403); `check` and `update` compare with and bring to the latest release —
 * `toLatestNpm`.
 * @returns the restarted process's code; null — work here
 */
function toRelease(argv: string[]): number | null {
  if (existsSync(path.join(SRC, ".git"))) return null;
  const own = npmRelease(SRC);
  if (own) return (release = own), argv[0] === "install" ? null : toLatestNpm(own, argv);
  if (sourceSha(SRC)) return (release = process.env.ELVES_RELEASE || process.env[FORMER.release] || null), null;
  let to: { tag?: string; sha: string } | undefined;
  try {
    const head = (sha: string | null) => (sha ? { sha } : undefined);
    to = releases(repoUrl()).at(-1) ?? head(mainHead(repoUrl()));
  } catch (e) {
    throw new Error(`can't find out the latest Elves release — ${reason(e)}`);
  }
  if (!to) return null;
  const env = { ...process.env };
  for (const name of ["ELVES_RELEASE", FORMER.release]) {
    delete env[name];
    if (to.tag) env[name] = to.tag;
  }
  const r = spawnSync("bunx", ["--silent", `github:${SOURCE}#${to.sha}`, ...argv], { stdio: "inherit", env });
  if (r.error) throw new Error(`can't run ${to.tag ? `release ${to.tag}` : `Elves ${short(to.sha)}`} — ${reason(r.error)}`);
  return r.status ?? 2;
}

/**
 * `check` and `update` from the npm package: the latest release — by the tags, as for the launcher (a tag and an npm
 * version are one release, CI publishes on the tag); newer than this package — a restart from its npm package by the
 * exact version, not from GitHub: npm is reachable wherever the package came from. ELVES_RELEASE — the tag the
 * restart went to: the restarted package doesn't look it up a second time. This package is the latest — null.
 * @returns the restarted process's code; null — work here
 */
function toLatestNpm(own: string, argv: string[]): number | null {
  if (process.env.ELVES_RELEASE === own) return null;
  let latest: { tag: string } | undefined;
  try {
    latest = releases(repoUrl()).at(-1);
  } catch (e) {
    throw new Error(`can't find out the latest Elves release — ${reason(e)}`);
  }
  if (!latest || compareTags(latest.tag, own) <= 0) return null;
  const env: NodeJS.ProcessEnv = { ...process.env, ELVES_RELEASE: latest.tag };
  delete env[FORMER.release];
  const r = spawnSync("bunx", ["--silent", `${PACKAGE}@${npmVersion(latest.tag)}`, ...argv], { stdio: "inherit", env });
  if (r.error) throw new Error(`can't run release ${latest.tag} — ${reason(r.error)}`);
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

/** Elves skills: skills/<name> directories with SKILL.md. */
function sourceSkills(src: string) {
  return readdirSync(path.join(src, "skills"))
    .filter((n) => existsSync(path.join(src, "skills", n, "SKILL.md")))
    .sort();
}

/**
 * A file or a directory of the install under the flow's former name (FORMER) goes: the install writes its new name.
 * `ours` — for a path that may be someone else's: the rules' symlinks go only if they lead into the former canon.
 */
function removeFormer(root: string, rel: string, ours = (_: string) => true) {
  const p = path.join(root, rel);
  const st = lstat(p);
  if (!st || !ours(p)) return;
  if (dry) return void change("-", st.isDirectory() ? p + "/" : p, { note: FORMER_NOTE });
  rmSync(p, { recursive: true, force: true });
  touch(rel);
  note(`${rel}${st.isDirectory() ? "/" : ""} — removed: the flow's former name (${FORMER.name})`);
}

/** The rules canon: `.agents/elves/` — a copy of AGENTS.md, claude/CLAUDE.md and docs/*.md or a symlink to the clone. */
function installRules(src: string, root: string, linkMode: boolean) {
  const canon = path.join(root, CANON);
  removeFormer(root, FORMER.canon);
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

/** The install's `.agents/elves.json`. */
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

/**
 * The install's manifest: `.agents/elves.json`, until `update` moves it — the manifest of an earlier release under the
 * flow's former name (FORMER.manifest); missing or broken — empty.
 */
function readManifest(root: string): Manifest {
  const file = [MANIFEST, FORMER.manifest].map((f) => path.join(root, f)).find((f) => existsSync(f));
  try {
    return file ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * Skills: `.agents/skills/<name>` — a copy (or a symlink to the clone), Claude Code — a symlink from `.claude/skills`.
 * Someone else's directory with the same name is left alone; skills from a previous install that Elves no longer
 * has are removed. `.agents/elves.json` holds the source SHA, the release tag and the installed skills — the manifest
 * under the former name (FORMER) is read and moved into it, its fields carried over; a dry run
 * doesn't compare the SHA and the tag: the install is up to date if what it installs matches (a release that changes
 * only the installer doesn't touch projects). auto and language — the project settings "a task entirely without
 * asking" and the language the agent works in, always written; the machine doesn't have them (undefined). `env` —
 * the project's task stack settings (the task-env skill: HTTP services and their ports): the project writes it, the
 * install carries it over. A dry run doesn't compare them either: editing a field by hand doesn't make the install
 * "behind".
 * The order survives a run cut off midway (an agent's sandbox refuses writes to `.claude/skills`): skills Elves no
 * longer has go while the old manifest still lists them, and the new manifest is written before the copies — a repeat
 * run takes them for the flow's and finishes the install instead of leaving them as someone else's.
 * @returns installed skills
 */
function installSkills(src: string, root: string, linkMode: boolean, claude: boolean, auto?: boolean, language?: string) {
  const manifestPath = path.join(root, MANIFEST);
  const before = readManifest(root).skills ?? [];
  const names = sourceSkills(src);
  const env = readManifest(root).env;
  const installed = names.filter((name) => {
    const dst = path.join(root, ".agents/skills", name);
    const st = lstat(dst);
    if (!st || st.isSymbolicLink() || before.includes(name)) return true;
    warn(`${path.relative(root, dst)} already exists and isn't an Elves skill — left; remove it to install the Elves skill`);
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
    note(`${path.relative(root, dst)} — removed: Elves no longer has it`);
  }
  const clone = linkMode ? path.resolve(src) : undefined; // a --link machine: check and update find the clone by it
  if (dry) {
    const m = readManifest(root);
    if (m.source !== SOURCE || JSON.stringify(m.skills) !== JSON.stringify(installed) || m.clone !== clone || !existsSync(manifestPath)) change(existsSync(manifestPath) ? "~" : "+", manifestPath);
  } else {
    const sha = sourceSha(src);
    const manifest = { source: SOURCE, ...(sha ? { sha } : {}), ...(release ? { tag: release } : {}), ...(clone ? { clone } : {}), skills: installed, ...(auto === undefined ? {} : { auto }), ...(language === undefined ? {} : { language }), ...(env === undefined ? {} : { env }) };
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  // after the new one is written: a run cut off in between reads the new one
  removeFormer(root, FORMER.manifest);
  for (const name of installed) placeDir(path.join(src, "skills", name), path.join(root, ".agents/skills", name), root, linkMode);
  if (!linkMode) note(`.agents/skills/ ← ${installed.join(", ")}`);
  if (claude) for (const name of installed) link(path.join(root, ".agents/skills", name), path.join(root, ".claude/skills", name), root);
  return installed;
}

/**
 * The machine queue's shim in a project (`slotShim`): a package.json script sources it before its command, in CI too
 * (there the command goes at once, without a queue).
 */
const SLOT_SHIM = ".agents/slot.sh";
/**
 * The shim: slot.sh of the slot skill around `elves slot --for $$` of the project's package, in `if command -v elves` —
 * without elves on PATH (no node_modules yet, a checkout without the package) the command runs as is; elves failed —
 * the script fails with its code, the command doesn't run (#552).
 */
const SLOT_SHIM_TEXT = [
  `# Elves: the machine queue for a package.json check (the slot skill); set by \`${RUN} install\`, don't edit by hand.`,
  `# A script sources it: ". ${SLOT_SHIM} && <command>" — slot takes a slot for the script's own shell ($$), held until`,
  "# the shell exits, and the shell exports the queue variables to the command. elves — from node_modules/.bin of the",
  "# project's package: without it on PATH the command runs as is; elves failed — the script fails with its code.",
  "if command -v elves >/dev/null 2>&1; then",
  "  ELVES_SLOT_EXPORT=$(elves slot --for $$) || exit",
  '  eval "$ELVES_SLOT_EXPORT"',
  "  unset ELVES_SLOT_EXPORT",
  "fi",
  "",
].join("\n");
/** A package.json script wrapped in slot: `. SLOT_SHIM && <command>`; a project with a copy — its slot.sh. */
const SLOT_WRAPPED = /^\. \.agents\/(?:skills\/slot\/scripts\/)?slot\.sh && ([^]*)$/;
/**
 * A script wrapped with the command a string argument — the copy's slot.ts by any runtime (node too; with Bun's env
 * files too — without `--no-env-file`), or `elves slot` on Yarn 2+: tools that read package.json scripts (knip) don't
 * see the command.
 */
const SLOT_STRING = /^(?:(?:node|bun)(?: --no-env-file)? \.agents\/skills\/slot\/scripts\/slot\.ts|elves slot) '((?:[^']|'\\'')*)'$/;
/** The script's own command, without the slot wrapper of any install. */
const unslot = (cmd: string) => SLOT_WRAPPED.exec(cmd)?.[1] ?? SLOT_STRING.exec(cmd)?.[1]?.replaceAll("'\\''", "'") ?? cmd;
/**
 * Yarn 2+ runs package.json scripts in its own shell (`@yarnpkg/shell`) — without `.`, `eval` and `export`, the shim
 * can't be sourced there: the command stays a string argument of `elves slot`, hidden from knip, but in the queue. Yarn
 * 2+ or not — the project's package manager by `packageManager` of the github skill (tests/standards/package-manager).
 */
const yarnShell = (root: string) => packageManager(root).berry;
/**
 * Check scripts that go through the machine queue: `lint`, `typecheck`, `test`, `test:*`. Not `build` — hosting and
 * Docker run it, where the shim or the package may be missing; not watch — long-running, it would hold a slot for long.
 */
const slotted = (name: string) => /^(?:lint|typecheck|test)$|^test:/.test(name) && !name.includes("watch");
/** A package.json script's command through the machine queue: `. SLOT_SHIM && <command>`, on Yarn 2+ — `elves slot '<command>'`. */
const slotWrap = (yarn: boolean) => (cmd: string) => (yarn ? `elves slot '${cmd.replaceAll("'", "'\\''")}'` : `. ${SLOT_SHIM} && ${cmd}`);

/**
 * The shim — the same text in every project: an install of an earlier release (a copy) has none, a stale one is
 * rewritten.
 */
function slotShim(root: string) {
  const file = path.join(root, SLOT_SHIM);
  const have = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (have === SLOT_SHIM_TEXT) return;
  if (dry) return void change(have === null ? "+" : "~", file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, SLOT_SHIM_TEXT);
  touch(SLOT_SHIM);
  note(`${SLOT_SHIM} — the machine queue's shim: elves slot of the project's package`);
}

/**
 * A skill script the flow copy runs — `bun [--no-env-file] .agents/skills/<skill>/scripts/<script>.ts` of SCRIPTS — and
 * the knip reporter of the copy (`knip --reporter …/knip-hints.cjs`, the harness's `report`): the package has them,
 * the copy is gone. The script and its arguments are the same (SCRIPTS).
 */
const COPY_SCRIPT = /\bbun(?: --no-env-file)? (?:\.\/)?\.agents\/skills\/(?:spec|slot)\/scripts\/([\w-]+)\.ts\b/g;
const COPY_KNIP_HINTS = /(?:\.\/)?\.agents\/skills\/spec\/scripts\/knip-hints\.cjs\b/g;
/** The knip reporter in the project's package: `exports` of package.json don't have it, the file does. */
const PACKAGE_KNIP_HINTS = `node_modules/${PACKAGE}/skills/spec/scripts/knip-hints.cjs`;

/**
 * A command that ran the copy's scripts — through the package: in package.json `elves <script>` (scripts get
 * `node_modules/.bin` on PATH), in CI — `bun --no-env-file node_modules/.bin/elves <script>` (a step of GitHub Actions
 * doesn't, and `bunx elves` without the package in node_modules would fetch someone else's `elves` from npm; #558,
 * question 2). A script that isn't the package's stays — `copyLeftovers` names it.
 */
function fromCopy(text: string, ci: boolean) {
  const run = ci ? "bun --no-env-file node_modules/.bin/elves" : "elves";
  return text.replace(COPY_SCRIPT, (all, name: string) => (Object.hasOwn(SCRIPTS, name) ? `${run} ${name}` : all)).replace(COPY_KNIP_HINTS, PACKAGE_KNIP_HINTS);
}

/**
 * The project's package.json scripts. Checks — through the machine queue (the slot skill): `slotted` scripts in the
 * root package.json are wrapped in `. SLOT_SHIM && <command>` — any agent and human call them. The script's shell
 * sources the shim: it holds the slot and gets the queue variables, the command stays a plain command of the script —
 * knip sees its binary, and `bun test` gives knip the test files and `preload` as entries; the command gets exactly the
 * environment it would without the wrapper, no env files of Bun. A wrapper of a previous install — the copy's slot.sh,
 * the command a string argument of slot.ts, hidden from knip — is rewritten; on Yarn 2+ the string is the wrapper
 * (`yarnShell`). The copy's scripts in any script lead to the package (`fromCopy`). The indentation and the trailing
 * newline stay as they were.
 */
function packageScripts(root: string) {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(text);
  } catch {
    return warn("package.json — not JSON: the project's checks aren't wrapped in the slot queue");
  }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object") return;
  const yarn = yarnShell(root);
  const wrap = slotWrap(yarn);
  const outside: string[] = [];
  const previous: string[] = [];
  const copy: string[] = [];
  let hidden = false;
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== "string") continue;
    const inner = slotted(name) ? unslot(cmd) : cmd;
    const own = fromCopy(inner, false);
    const want = slotted(name) ? wrap(own) : own;
    if (cmd === want) continue;
    scripts[name] = want;
    if (own !== inner) copy.push(name);
    if (slotted(name) && inner === cmd) outside.push(name);
    else if (slotted(name) && wrap(inner) !== cmd) previous.push(name), (hidden ||= SLOT_STRING.test(cmd) && !yarn);
  }
  const changed = [...new Set([...outside, ...previous, ...copy])];
  if (!changed.length) return;
  if (dry) {
    const notes = [
      outside.length && `checks outside the slot queue: ${outside.join(", ")}`,
      previous.length && `the slot wrapper of a previous install${hidden ? " — knip doesn't see the command" : ""}: ${previous.join(", ")}`,
      copy.length && `the flow copy's scripts → elves: ${copy.join(", ")}`,
    ];
    return void change("~", file, { note: notes.filter(Boolean).join("; ") });
  }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
  writeFileSync(file, JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  touch("package.json");
  const wrapped = [...outside, ...previous];
  if (wrapped.length) note(`package.json — checks through the machine queue (slot): ${wrapped.join(", ")}`);
  if (copy.length) note(`package.json — the flow copy's scripts through the package (elves <script>): ${copy.join(", ")}`);
}

/**
 * Queue variables a command in a slot needs: the runner's share of cores and "already in a slot" for a nested script
 * in slot.
 */
const SLOT_ENV = ["ELVES_SLOT", "ELVES_SLOT_CPUS"];
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
 * that calls turbo loses `ELVES_SLOT_CPUS` on the way — the runner takes the whole machine — and `ELVES_SLOT` — a
 * nested script in slot waits for its own slot. The pass-through is `globalPassThroughEnv`, not `globalEnv`: it isn't
 * part of the cache hash, and `ELVES_SLOT` is different on every run. The project owns turbo.json, and it may have
 * comments (JSONC) — we don't edit it but warn with a ready-made line; in `check` — a `!` line, not falling behind.
 * turbo.json can't be parsed — we stay silent: turbo itself will parse it. A turbo.json that passes the variables only
 * under the flow's former names (FORMER.slotEnv: slot exports both for now) — the same line, which adds the new names
 * and keeps the former ones: the project's runner configs may still read them.
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
  const former = FORMER.slotEnv.filter((v) => reaches(v));
  const why = former.length
    ? `${name} passes the queue variables only under the flow's former names ${former.join(", ")} — runner configs and nested scripts in slot that read ${missing.join(", ")} don't get ${missing.length > 1 ? "them" : "it"}`
    : `${missing.join(", ")} ${missing.length > 1 ? "don't reach" : "doesn't reach"} the runner: turbo in strict env mode passes to tasks only the variables named in ${name}`;
  const text = `${why} — put at its root ${line}`;
  if (dry) change("!", path.join(root, name), { note: text });
  else warn(`${name} — ${text}`);
}

/**
 * Claude Code: rules from `.claude/rules` load by themselves, whatever the CLAUDE.md. The symlinks under the former
 * name go — Claude Code would load the rules twice; only ours, into the former canon.
 */
function claudeRules(root: string) {
  const intoFormer = (p: string) => Boolean(lstat(p)?.isSymbolicLink()) && path.resolve(path.dirname(p), readlinkSync(p)).startsWith(path.join(root, FORMER.canon) + path.sep);
  for (const rel of FORMER.rules) removeFormer(root, rel, intoFormer);
  link(path.join(root, CANON, "AGENTS.md"), path.join(root, RULES.agents), root);
  link(path.join(root, CANON, "claude/CLAUDE.md"), path.join(root, RULES.claude), root);
}

/**
 * The SessionStart hook in `~/.claude/settings.json` (HOOK): the user's own settings and hooks stay in place, a hook
 * of a previous version (with npx too, with the repository's name before the rename — LEGACY_SOURCE) is replaced, a
 * repeated install doesn't duplicate it. A dry run names what the hook gives: from a terminal `check -g` can't see the
 * agent's shell, a missing hook is how it names a missing Bash environment (tests/capabilities/agent-shell).
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
  const ours = ({ command }: { command?: unknown }) => typeof command === "string" && [SOURCE, LEGACY_SOURCE].some((repo) => command.includes(`${repo} check --hook`));
  const groups = settings.hooks?.SessionStart ?? [];
  const count = groups.flatMap((g) => g.hooks ?? []).filter(ours).length;
  if (count === 1 && groups.some((g) => JSON.stringify(g) === JSON.stringify(HOOK))) return;
  if (dry) return change(existsSync(file) ? "~" : "+", file, { note: "the SessionStart hook: the flow check and the agent's Bash environment" });
  const rest = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
  settings.hooks = { ...settings.hooks, SessionStart: [...rest, HOOK] };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  note(".claude/settings.json — SessionStart hook: elves check --hook");
}

/**
 * The block linking to the rules in the project's AGENTS.md: at the start of the file, a repeated install replaces it.
 * The block under the flow's former name (FORMER) is replaced in its place: the project's text around it stays, and
 * there is no second block.
 */
function agentsBlock(root: string) {
  const file = path.join(root, "AGENTS.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  let out = text;
  let placed = false;
  for (const [begin, end] of [
    [BEGIN, END],
    [FORMER.begin, FORMER.end],
  ] as const) {
    const b = out.indexOf(begin);
    const e = out.indexOf(end, b);
    if (b < 0 || e < 0) continue;
    // a second block goes with the empty lines after it
    out = placed ? out.slice(0, b) + out.slice(e + end.length).replace(/^\n+/, "") : out.slice(0, b) + BLOCK + out.slice(e + end.length);
    placed = true;
  }
  if (!placed) out = text ? `${BLOCK}\n\n${text}` : `${BLOCK}\n`;
  if (out !== text) {
    const former = text.includes(FORMER.begin) ? { note: `the block under the flow's former name (${FORMER.begin.slice(5)}) — update replaces it` } : {};
    if (dry) return change(text ? "~" : "+", file, former);
    writeFileSync(file, out);
    touch("AGENTS.md");
  }
  note(`AGENTS.md — a block linking to ~/${CANON}/AGENTS.md on the machine`);
}

const GI_BEGIN = "# elves:begin";
const GI_END = "# elves:end";
const GI_HEAD = `${GI_BEGIN} — flow files git would otherwise ignore; set by \`${RUN} install\`, don't edit by hand`;

/** `.gitignore` without the Elves block and the block under the flow's former name (FORMER); no block — as is. */
function withoutGiBlock(text: string) {
  let out = text;
  for (const [begin, end] of [
    [GI_BEGIN, GI_END],
    [FORMER.giBegin, FORMER.giEnd],
  ] as const) {
    const b = out.indexOf(begin);
    const e = out.indexOf(end, b);
    if (b < 0 || e < 0) continue;
    const rest = [out.slice(0, b).replace(/\n+$/, ""), out.slice(e + end.length).replace(/^\n+|\n+$/g, "")].filter(Boolean).join("\n");
    out = rest ? rest + "\n" : "";
  }
  return out;
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

/**
 * What the install puts into a project and what must go into the commit: the manifest, the shim — without it in the
 * commit a package.json check fails in CI and another checkout (#558, question 4) — and AGENTS.md.
 */
function flowEntries(root: string) {
  return [MANIFEST, SLOT_SHIM, "AGENTS.md"].map((p) => ({ path: p, dir: false })).filter((e) => lstat(path.join(root, e.path))?.isDirectory() === e.dir);
}

/** An exception line for the flow copy's directories — the canon (under the former name too), the skills, `.claude/` — not the thin project's `.agents/elves.json`. */
const COPY_EXCEPTION = new RegExp(`/(?:${[CANON, FORMER.canon, ".agents/skills", ".claude"].map((p) => p.replaceAll(".", "\\.")).join("|")})/`);

/** The Elves block of `.gitignore` (or the one under the former name) has exceptions for the flow copy. */
const copyGiBlock = (text: string) =>
  [
    [GI_BEGIN, GI_END],
    [FORMER.giBegin, FORMER.giEnd],
  ].some(([begin = "", end = ""]) => {
    const b = text.indexOf(begin);
    const e = text.indexOf(end, b);
    return b >= 0 && e >= 0 && COPY_EXCEPTION.test(text.slice(b, e));
  });

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
 * Flow files go into the commit: a file the project's git ignores is invisible to another checkout, CI and a cloud
 * session — without the shim a package.json check fails there. Exceptions — as an Elves block at the end
 * of the root `.gitignore` (giRound), rebuilt by every install: passes while new lines appear; not needed — removed,
 * the exceptions of a flow copy too. What an exception can't un-ignore — `❌`. A dry run only names what is ignored and
 * a block to rebuild. Not git — nothing to check.
 * @returns `.gitignore` changed
 */
function gitignoreFlow(root: string) {
  try {
    git(root, "rev-parse", "--git-dir");
  } catch {
    return false;
  }
  const entries = flowEntries(root);
  const file = path.join(root, ".gitignore");
  if (dry) {
    for (const [p, i] of giRound(root, entries).found) change("❌", path.join(root, p), { note: ignoredNote(i, false), manual: Boolean(i.personal) });
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.includes(FORMER.giBegin)) change("~", file, { note: `the block under the flow's former name (${FORMER.giBegin.slice(2)}) — update replaces it` });
    else if (copyGiBlock(text)) change("~", file, { note: "the flow copy's exceptions — update removes them" });
    return false;
  }
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
  if (fixed.size) note(`.gitignore — Elves exceptions: git ignored ${[...fixed].map(([p, i]) => `${p} (${i.rule})`).join(", ")}`);
  else if (after !== before && !lines.length) note(".gitignore — the Elves exceptions block removed: git doesn't ignore flow files");
  for (const [p, i] of stuck) fail(`${p} — ${ignoredNote(i, true)}`);
  if (after !== before) touch(".gitignore");
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

/**
 * An Elves clone: its canon is the root AGENTS.md, the flow needn't be installed into it. The package is PACKAGE; before
 * it — named after the repository, `elves`, and the repository's name before the rename (LEGACY_SOURCE): a clone or a
 * branch that hasn't pulled the rename yet is a clone too.
 */
function isElvesClone(root: string) {
  try {
    const name: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name;
    return name === PACKAGE || [SOURCE, LEGACY_SOURCE].some((repo) => repo.split("/")[1] === name);
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

const CLONE_NOTE = "an Elves clone: the flow isn't installed into it — the canon is at its root";

/**
 * An Elves clone: of the install it gets only the mode and the language, a manifest of two fields; the task stack
 * settings (`env`), if the clone has them, are carried over as in a project; the manifest under the former name goes.
 */
function installClone(root: string, auto: boolean, language: string) {
  const file = path.join(root, MANIFEST);
  const env = readManifest(root).env;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ auto, language, ...(env === undefined ? {} : { env }) }, null, 2) + "\n");
  removeFormer(root, FORMER.manifest);
  note(`${MANIFEST} — auto: ${auto}, language: ${language}; ${CLONE_NOTE}`);
}

/**
 * The npm version of this package — the release the install runs from (`toRelease`: the tag the launcher restarted to,
 * the npm package's own version); a clone and the launcher from main without releases have none (#558, question 5).
 */
const ownVersion = () => (release ? npmVersion(release) : null);

/** This package in the output: the release tag, otherwise its SHA. */
const ownLabel = () => release ?? short(sourceSha(SRC)) ?? "SHA unknown";

/** The project's PACKAGE in package.json — devDependencies or dependencies: the spec; none — undefined. */
function projectPackage(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const spec: unknown = pkg?.devDependencies?.[PACKAGE] ?? pkg?.dependencies?.[PACKAGE];
    return typeof spec === "string" ? spec : undefined;
  } catch {
    return undefined;
  }
}

/** The project's package version for the output: the release tag of an exact version, otherwise the spec as is. */
const shownPackage = (spec: string | undefined) => (spec === undefined ? `without ${PACKAGE}` : (releaseTag(spec) ?? spec));

/**
 * A project with a copy of the flow of an earlier release: the canon `.agents/elves/` (under the former name too) or a
 * manifest of a copy — the installed skills, the SHA; a thin project's manifest has only the mode, the language, env.
 */
function isCopy(root: string) {
  const m = readManifest(root);
  return [CANON, FORMER.canon, FORMER.manifest].some((p) => lstat(path.join(root, p))) || ["source", "sha", "tag", "skills"].some((k) => k in m);
}

/** Why the copy goes: the line of `install` and `update` about it. */
const COPY_NOTE = "the flow copy — the canon and the skills are on the machine (install -g), the scripts in the package";

/**
 * A copy of the flow of an earlier release goes (#558): the canon `.agents/elves/` (under the former name too), the skills
 * the manifest lists — without the list (an install before it) the ones Elves has — from `.agents/skills`, the symlinks
 * of Claude Code to them in `.claude/skills` and to the canon in `.claude/rules`; the project's own skills and files
 * stay (#558, question 6), emptied directories go. The manifest that lists the skills is rewritten after them
 * (`projectManifest`): a run cut off midway is finished by a repeat.
 */
function removeCopy(root: string) {
  if (!isCopy(root)) return;
  const listed = readManifest(root).skills;
  const named = Array.isArray(listed) ? listed.filter((s): s is string => typeof s === "string") : sourceSkills(SRC);
  const into = (dirs: string[]) => (p: string) => Boolean(lstat(p)?.isSymbolicLink()) && dirs.some((d) => (path.resolve(path.dirname(p), readlinkSync(p)) + path.sep).startsWith(path.join(root, d) + path.sep));
  const rules = [RULES.agents, RULES.claude, ...FORMER.rules].filter((rel) => into([CANON, FORMER.canon])(path.join(root, rel)));
  const skills = named.filter((name) => lstat(path.join(root, ".agents/skills", name)));
  const links = named.filter((name) => into([`.agents/skills/${name}`])(path.join(root, ".claude/skills", name)));
  const canons = [CANON, FORMER.canon].filter((rel) => lstat(path.join(root, rel)));
  if (dry) {
    // the skills — a line per directory, not per skill: the change list is capped, and a copy has a dozen of them
    for (const rel of rules) change("-", path.join(root, rel));
    if (skills.length) change("-", path.join(root, ".agents/skills") + "/", { note: `the flow's skills: ${skills.join(", ")}` });
    if (links.length) change("-", path.join(root, ".claude/skills") + "/", { note: `the symlinks to them: ${links.join(", ")}` });
    for (const rel of canons) change("-", path.join(root, rel) + "/");
    return;
  }
  const paths = [...rules, ...links.map((n) => `.claude/skills/${n}`), ...skills.map((n) => `.agents/skills/${n}`), ...canons];
  for (const rel of paths) rmSync(path.join(root, rel), { recursive: true, force: true }), touch(rel);
  const gone = [...rules, ...(skills.length ? [`.agents/skills/ (${skills.join(", ")})`] : []), ...(links.length ? [".claude/skills/ (their symlinks)"] : []), ...canons.map((rel) => `${rel}/`)];
  for (const rel of [".agents/skills", ".claude/skills", ".claude/rules", ".claude"]) {
    const p = path.join(root, rel);
    if (lstat(p)?.isDirectory() && !readdirSync(p).length) rmSync(p, { recursive: true });
  }
  if (gone.length) note(`${gone.join(", ")} — removed: ${COPY_NOTE}`);
}

/** The fields of a project's manifest; the rest are a copy's (`isCopy`). */
const PROJECT_FIELDS = ["auto", "language", "env"];

/**
 * The project's manifest: the mode, the language and the task stack settings (`env`, the task-env skill — the project
 * writes it, the install carries it over); the fields of a copy go, the manifest under the former name moves into it.
 * A dry run doesn't compare the values: auto and language edited by hand don't make the install behind.
 */
function projectManifest(root: string, auto: boolean, language: string) {
  const file = path.join(root, MANIFEST);
  const m = readManifest(root);
  if (dry) {
    if (!existsSync(file) || Object.keys(m).some((k) => !PROJECT_FIELDS.includes(k))) change(existsSync(file) ? "~" : "+", file);
  } else {
    const text = JSON.stringify({ auto, language, ...(m.env === undefined ? {} : { env: m.env }) }, null, 2) + "\n";
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      touch(MANIFEST);
    }
  }
  // after the new one is written: a run cut off in between reads the new one
  removeFormer(root, FORMER.manifest);
}

/** How long the project's package manager may install the dependencies: a big project with a cold cache — minutes. */
const PM_TIMEOUT = 600_000;

/**
 * The project's version of the package — PACKAGE of this release (`ownVersion`) in devDependencies of package.json, an
 * exact version (#558, question 1): the harness and the skills' scripts of its tests and CI. The edit keeps the
 * indentation and the key order, a new key goes to its alphabetical place; in dependencies it stays there. Then the
 * project's package manager (`packageManager` of the github skill) installs it and updates its lockfile; without a
 * lockfile — only package.json and a line with the command: the install doesn't create a lockfile the project doesn't
 * keep. The manager failed (no network, an agent's sandbox) — a warning with the command: package.json is right, the
 * lockfile follows it. No package.json — nothing to pin: no scripts or tests on JS. No version (a clone, the launcher
 * from main without releases) — the dependency stays as is, a missing one is a warning (#558, question 5).
 */
function packageDependency(root: string, version: string | null) {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text);
  } catch {
    return; // packageScripts names it
  }
  const object = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
  const section = object(pkg.dependencies)?.[PACKAGE] !== undefined ? "dependencies" : "devDependencies";
  const deps = object(pkg[section]) ?? {};
  const have = deps[PACKAGE];
  if (!version) {
    if (have === undefined) warn(`package.json — ${PACKAGE} isn't added: this installer isn't a release (a clone or no releases yet) — a release adds it: ${RUN} install`);
    return;
  }
  if (have === version) return;
  const was = typeof have === "string" ? `${have} → ` : "";
  if (dry) return void change("~", file, { note: `${PACKAGE} ${was || "none → "}${version}` });
  const entries = Object.entries(deps);
  const at = entries.findIndex(([name]) => name > PACKAGE);
  if (have === undefined) entries.splice(at < 0 ? entries.length : at, 0, [PACKAGE, version]);
  pkg[section] = have === undefined ? Object.fromEntries(entries) : { ...deps, [PACKAGE]: version };
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
  writeFileSync(file, JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  touch("package.json");
  const pm = packageManager(root);
  const cmd = `${pm.name} install`;
  if (!pm.lockfile) return note(`package.json — ${PACKAGE} ${was}${version}; no lockfile — install the dependencies: ${cmd}`);
  const r = spawnSync(pm.name, ["install"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: PM_TIMEOUT });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (`${r.stderr}\n${r.stdout}`.split("\n").find((l) => /error/i.test(l)) ?? `exit code ${r.status ?? r.signal}`).trim();
    return warn(`package.json — ${PACKAGE} ${was}${version}, but ${pm.lockfile} isn't updated: ${cmd} — ${why}; run it yourself`);
  }
  touch(pm.lockfile);
  note(`package.json, ${pm.lockfile} — ${PACKAGE} ${was}${version} (${cmd})`);
}

/**
 * Lines of the project's tracked files that git grep finds by args, outside the flow copy and its symlinks (`.agents/`,
 * `.claude/skills/`, `.claude/rules/` — git greps a symlink's target path): the hook runs check at every session start,
 * git grep reads the index, not every file. Not git or nothing — none.
 */
function gitGrep(root: string, args: string[]): string[] {
  const outside = [".agents", ".claude/skills", ".claude/rules"].map((p) => `:(exclude)${p}`);
  const r = spawnSync("git", ["-C", root, "grep", "-I", ...args, "--", ".", ...outside], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return !r.error && r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Source files whose imports may lead into the copy: JavaScript and TypeScript, configs too. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** A workflow or an action of GitHub Actions: the copy's scripts go there by path. */
const CI_FILE = /^\.github\/.*\.ya?ml$/;
/** An import of a copy's module the package exports (`exports` of package.json): the harness, the model, the ESLint fragment, github. */
const COPY_IMPORT = /(["'`])(?:\.{1,2}\/)*\.agents\/skills\/(spec\/scripts\/(?:harness|architecture|eslint-config)|github\/scripts\/github)(?:\.[cm]?[jt]s)?\1/g;
/** The package's export of a copy's module: spec/scripts/harness → @miroshnik/elves/spec/harness, github/scripts/github → @miroshnik/elves/github. */
const packageImport = (mod: string) => `${PACKAGE}/${mod.startsWith("spec/") ? mod.replace("/scripts/", "/") : "github"}`;

/**
 * Files of the project that lead into the copy (#558): imports of the copy's modules in tests and configs — to the
 * package's exports (`@miroshnik/elves/spec/harness` …), its scripts and the knip reporter in GitHub Actions — through
 * the package (`fromCopy`); package.json — `packageScripts`. Only tracked files that name `.agents/skills/`.
 */
function rewriteCopyRefs(root: string) {
  const done: string[] = [];
  for (const rel of gitGrep(root, ["-l", "-F", "-e", ".agents/skills/"])) {
    const ci = CI_FILE.test(rel);
    if (!ci && !SOURCE_FILE.test(rel)) continue;
    const file = path.join(root, rel);
    const text = readFileSync(file, "utf8");
    const out = ci ? fromCopy(text, true) : text.replace(COPY_IMPORT, (_, q: string, mod: string) => `${q}${packageImport(mod)}${q}`);
    if (out === text) continue;
    if (dry) {
      change("~", file, { note: ci ? "the flow copy's scripts → node_modules/.bin/elves" : `imports of the flow copy → ${PACKAGE}` });
      continue;
    }
    writeFileSync(file, out);
    touch(rel);
    done.push(rel);
  }
  if (done.length) note(`${done.join(", ")} — imports and scripts of the flow copy → ${PACKAGE}`);
}

/**
 * A mention of `.agents` that isn't the thin project's own: the manifest, the shim, `~/.agents` and `$HOME/.agents` of
 * the machine aren't one.
 */
const COPY_MENTION = /(?<![\w~}-]|~\/|HOME\/|HOME}\/)\.agents(?![\w-])(?!\/(?:elves\.json|slot\.sh)\b)/;

/**
 * What still names `.agents` once the copy is gone: exceptions `.agents/**` in linters, formatters and configs aren't
 * needed anymore, a path into the copy no rule rewrote — a line each for the agent to fix by hand (#558). `.gitignore`
 * doesn't count: its Elves block is the install's.
 */
function copyLeftovers(root: string) {
  const lines = gitGrep(root, ["-n", "-F", "-e", ".agents"]).flatMap((l) => {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    return m?.[1] && m[1] !== ".gitignore" && COPY_MENTION.test(m[3] ?? "") ? [`  ${m[1]}:${m[2]}: ${(m[3] ?? "").trim().slice(0, 120)}`] : [];
  });
  if (lines.length) note([`Still naming .agents — the flow copy is gone: exceptions for it in linters, formatters and configs aren't needed anymore, a path into it leads to ${PACKAGE} or a skill on the machine; fix by hand:`, ...capped(lines)].join("\n"));
}

/**
 * The project's thin flow (#552): a copy of an earlier release goes, then the manifest, the shim, the AGENTS.md block,
 * the package.json scripts, the files that led into the copy, the package version and the `.gitignore` exceptions. The
 * copy goes first — its manifest lists the skills to remove; the package manager runs after every package.json edit.
 * auto and language — the project's mode and language; only `install` sets them (a flag or a question in the
 * terminal), `update` and `check` go with the manifest's previous value.
 */
function installProject(root: string, auto = autoOf(root), language = languageOf(root)) {
  removeCopy(root);
  projectManifest(root, auto, language);
  slotShim(root);
  agentsBlock(root);
  packageScripts(root);
  turboEnv(root);
  rewriteCopyRefs(root);
  packageDependency(root, ownVersion());
  gitignoreFlow(root);
  if (!dry) copyLeftovers(root);
}

/**
 * Agents' global rule files: the agent is on the machine — its directory in the home directory (or the command on
 * PATH), the file — the canon's AGENTS.md. Cursor has no such file.
 */
const AGENT_RULES = [
  { dir: ".codex", cmd: "codex", file: ".codex/AGENTS.md" },
  { dir: ".gemini", file: ".gemini/GEMINI.md" },
  { dir: ".copilot", file: ".copilot/copilot-instructions.md" },
  { dir: ".config/opencode", file: ".config/opencode/AGENTS.md" },
  { dir: ".config/amp", file: ".config/amp/AGENTS.md" },
];

/**
 * The other agents get the machine's canon by their global rule file — a symlink to the canon's AGENTS.md, as before
 * #180: Codex glues it to the project's AGENTS.md, Gemini CLI, Copilot, OpenCode and Amp read it the same way. A file
 * is ours when it is missing, empty or a symlink into the canon — the current one or under the flow's former name
 * (FORMER.canon, a previous install); someone else's file or symlink — the user's own rules — stays, with a line
 * where the canon is.
 */
function agentRules(home: string, has: (dir: string, cmd?: string) => boolean) {
  const canons = [CANON, FORMER.canon].map((c) => path.join(home, c) + path.sep);
  const ours = (file: string) => {
    const st = lstat(file);
    if (!st || (st.isFile() && st.size === 0)) return true;
    return st.isSymbolicLink() && canons.some((c) => path.resolve(path.dirname(file), readlinkSync(file)).startsWith(c));
  };
  for (const { dir, cmd, file } of AGENT_RULES) {
    if (!has(dir, cmd)) continue;
    if (ours(path.join(home, file))) link(path.join(home, CANON, "AGENTS.md"), path.join(home, file), home);
    else note(`~/${file} — the user's own rules: left as is; the canon — ~/${CANON}/AGENTS.md`);
  }
}

/**
 * The URL of a GitHub origin on the repository's name before the rename (LEGACY_SOURCE, the name is case-insensitive) —
 * the same URL on SOURCE: the form, the credentials, the port and `.git` stay; another repository or host — null.
 */
function renamedOrigin(url: string): string | null {
  const m = /^(.*?(?:^|[@/])(?:ssh\.)?github\.com(?::\d+)?[:/])([^/]+\/[^/]+?)((?:\.git)?\/?)$/i.exec(url.trim());
  return m?.[2]?.toLowerCase() === LEGACY_SOURCE ? `${m[1]}${SOURCE}${m[3]}` : null;
}

/**
 * A `--link` clone's origin — on the repository's current name: GitHub redirects git by the old name, but the skills
 * find the repository and answer "a checkout of repository X?" by the origin URL (tests/standards/origin-repo), and
 * GraphQL by the old name may not find it. The clone is cloned by the old name — `install -g --link` and `update -g`
 * (it reinstalls the links) move it, `check -g` names it. `.git/config` is shared with the clone's worktrees, a parallel
 * git may hold its lock: a failed move is a warning with the command, the install goes on.
 */
function cloneOrigin(clone: string) {
  let url;
  try {
    // the URL as configured: `remote get-url` would expand the user's insteadOf rules
    url = git(clone, "config", "--get", "remote.origin.url");
  } catch {
    return;
  }
  const to = renamedOrigin(url);
  if (!to) return;
  if (dry) return void change("~", clone, { note: `origin ${url} → ${to}: the repository is renamed` });
  try {
    git(clone, "remote", "set-url", "origin", to);
    note(`clone ${clone}: origin → ${to} — the repository is renamed`);
  } catch (e) {
    warn(`clone ${clone}: origin isn't moved to ${to} — ${reason(e)}; run: git -C ${clone} remote set-url origin ${to}`);
  }
}

/** A Claude Code cloud environment (claude.ai/code): its setup script and its sessions have this variable. */
const remote = () => process.env.CLAUDE_CODE_REMOTE === "true";

/**
 * The machine (#557): the canon `~/.agents/elves/` — a copy or, with `--link`, a symlink to the clone — with Claude
 * Code's rules `~/.claude/rules/elves*.md` (the same `installRules` and `claudeRules` as in a project: what a previous
 * install left under the flow's former name moves), the other agents' rule files (`agentRules`), skills and the hook.
 * Claude Code is on the machine — `~/.claude`, `claude` on PATH or a cloud environment: its setup script runs in a
 * fresh home before Claude Code starts. The cloud doesn't read `~/.claude/settings.json` — no hook there.
 */
function installGlobal(src: string, linkMode: boolean) {
  const home = os.homedir();
  const has = (dir: string, cmd = "") => existsSync(path.join(home, dir)) || (cmd !== "" && onPath(cmd));
  const claude = has(".claude", "claude") || remote();
  installRules(src, home, linkMode);
  installSkills(src, home, linkMode, claude);
  agentRules(home, has);
  if (linkMode) cloneOrigin(src);

  if (claude) {
    claudeRules(home);
    if (!remote()) claudeHook(home);
    // install.sh installed ~/.claude/CLAUDE.md as a symlink to claude/CLAUDE.md, and that one imported AGENTS.md
    const old = path.join(home, ".claude/CLAUDE.md");
    if (lstat(old)?.isSymbolicLink() && readlinkSync(old).endsWith(path.join("claude", "CLAUDE.md"))) {
      if (dry) change("-", old);
      else rmSync(old), note(".claude/CLAUDE.md — the old install.sh symlink removed: the canon comes from ~/.claude/rules");
    }
  }

  if (has(".cursor")) note(`Cursor: sees the skills in ~/.agents/skills; it has no global rules file — paste ~/${CANON}/AGENTS.md into Settings → Rules → User Rules`);

  // The default location of the personal configuration. ELVES_CONFIG_DIR is deliberately not read here: the
  // variable overrides the whole directory and needs no symlink — the skills' scripts look where it points
  // (tests/standards/config-dir).
  moveConfig(home);
  const priv = process.env.ELVES_PRIVATE || process.env[FORMER.env.ELVES_PRIVATE];
  if (priv) {
    const dst = path.join(home, CONFIG);
    const st = lstat(dst);
    if (st && !st.isSymbolicLink()) warn(`~/${CONFIG} already exists and isn't a symlink — move its contents to ${priv} and remove it`);
    else if (dry) {
      if (!st || readlinkSync(dst) !== priv) change(st ? "~" : "+", dst);
    } else {
      if (st) rmSync(dst);
      mkdirSync(path.dirname(dst), { recursive: true });
      symlinkSync(priv, dst);
      note(`${CONFIG} → ${priv}`);
    }
  }
}

/**
 * The personal configuration directory under the flow's former name (FORMER.config in the home directory) moves to
 * `~/.config/elves`: a directory — whole, a symlink (to a private checkout, `ELVES_PRIVATE`) — the same symlink. In its
 * place stays a symlink to the new one: the scripts of earlier releases — a project copy `update` hasn't brought yet —
 * keep the same directory, and the queue, the pins and the registry don't split in two; the skills' scripts read the
 * former directory until the move (tests/standards/config-dir). Both exist — not merged by the script: a warning with
 * what to do.
 */
function moveConfig(home: string) {
  const from = path.join(home, FORMER.config);
  const to = path.join(home, CONFIG);
  const st = lstat(from);
  if (!st) return;
  const backLink = path.basename(to);
  if (st.isSymbolicLink() && path.resolve(path.dirname(from), readlinkSync(from)) === to) return;
  if (lstat(to)) {
    const text = `~/${FORMER.config} and ~/${CONFIG} both exist — move what ~/${FORMER.config} has into ~/${CONFIG} yourself and replace it with a symlink: ln -sfn ${backLink} ~/${FORMER.config}`;
    if (dry) return void change("!", from, { note: text });
    return void warn(text);
  }
  if (dry) return void change("~", from + (st.isDirectory() ? "/" : ""), { note: `${FORMER_NOTE} to ~/${CONFIG}` });
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to), rmSync(from);
  else renameSync(from, to);
  symlinkSync(backLink, from);
  note(`${FORMER.config} → ${CONFIG}: the flow's former name; ${FORMER.config} stays a symlink to it for the scripts of earlier releases`);
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

/**
 * Dry-run changes as `  ~ path` lines; on the machine the path is from `~/`, outside the home directory (a `--link`
 * clone) — absolute.
 */
function changeLines(changes: Change[], root: string, global: boolean) {
  const shown = (p: string) => {
    const rel = path.relative(root, p);
    return !global ? rel : rel.startsWith("..") ? path.resolve(p) : `~/${rel}`;
  };
  return changes.map((c) => `  ${c.op} ${shown(c.path)}${c.path.endsWith("/") ? "/" : ""}${c.note ? ` — ${c.note}` : ""}`);
}

/**
 * behind — falls behind: update will install something new; copy — the project keeps a copy of the flow: update moves
 * it to a thin one, in a task of its own; ignored — the project's git ignores flow files: update
 * will add exceptions; compose — the project's compose file breaks task isolation: update won't fix it; spec — the
 * project has standards or architecture without a `test:spec` script: update won't add it; run — the text names a
 * command to run.
 */
interface Result {
  code: 0 | 1 | 2;
  text: string;
  absent?: boolean;
  behind?: boolean;
  copy?: boolean;
  ignored?: boolean;
  compose?: boolean;
  spec?: boolean;
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
 * A project with a copy moves to a thin one in a task of its own, one per project: a task session doesn't take it —
 * the copy's thousands of lines go, imports and CI change. A thin project's update is a few lines — the session's own
 * task does it. The title is constant, in the project language (the `updateTask` key of this package's github skill
 * dictionary): `task new` refuses a second open task with the same title and names the open one — an open update task
 * of the copy is the same work (#558, question 3). The script — not the project's copy: the line shows exactly when
 * the project has one, and its script may not know the flags printed here (`--branch-type` — since v2026.10.11, #431).
 */
const updateTaskLine = (root: string) =>
  `The task — one per project, an open one is named by the refusal: bun --no-env-file ${githubScript(false)} task new --title "${locale.names(languageOf(root)).updateTask}" --branch-type chore`;

/**
 * Test runners of a package.json command — called directly or by the package manager: the `test:spec` command over the
 * spec roots and the filter that excludes a root from `test` (Vitest `--exclude` adds to the config's; Jest's
 * `--testPathIgnorePatterns` replaces the config's list; `bun test --path-ignore-patterns` repeats).
 */
const RUNNERS = {
  vitest: { re: /^(?:(?:npx|bunx|yarn|pnpm(?: exec)?) )?vitest\b/, spec: "vitest run", exclude: (dir: string) => `--exclude '${dir}/**'` },
  jest: { re: /^(?:(?:npx|bunx|yarn|pnpm(?: exec)?) )?jest\b/, spec: "jest", exclude: (dir: string) => `--testPathIgnorePatterns=${dir}/` },
  bun: { re: /^bun test\b/, spec: "bun test", exclude: (dir: string) => `--path-ignore-patterns='${dir}/**'` },
};

/**
 * The project's fast checks: with standards or architecture (`specRoots` of the github skill) the root package.json
 * needs a `test:spec` script — without it `github pr premerge` checks the merge with a moved main by typecheck alone
 * or by nothing, and a standard broken by two green PRs reaches main (#442). A mismatch that update doesn't fix — the
 * commands are the project's: a `❌` line with the ready scripts, in the slot wrapper `packageScripts` puts (its
 * `slotWrap`). `test:spec` — the runner of the `test` command, otherwise by the dependencies (Vitest, Jest, `bun test`
 * in a project on Bun — by `packageManager` of the github skill, otherwise Vitest — the spec skill's example), over the
 * roots the project has; next to it — `test` with the same roots excluded by the runner's filter, added to the command
 * under the wrapper (`unslot`): the roots run once, in `test:spec` (the spec skill, "Wiring into a repository").
 * `test` doesn't run them (names them already) or there is none — `test:spec` alone; `test` isn't a single runner call
 * — the exclusion in words.
 * With `test:spec` in place, a `test` that is a single runner call and doesn't name a root runs it a second time — an
 * `○` line with the same ready `test` (#487): extra time, not a hole in the check, so neither the exit code nor
 * `missing`. Any other `test` (turbo, a chain) — no line: its text doesn't tell what it runs. An exclusion in the
 * runner's config isn't seen in the text either — accepted noise: the ready line puts the exclusion in the script.
 */
function specScript(root: string): { lines: string[]; missing: boolean } {
  const roots = specRoots(root);
  let pkg: { scripts?: Record<string, unknown>; dependencies?: object; devDependencies?: object } = {};
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) ?? {};
  } catch {
    // no package.json or not JSON — no scripts
  }
  if (!roots.length) return { lines: [], missing: false };
  const test = typeof pkg.scripts?.test === "string" ? unslot(pkg.scripts.test) : undefined;
  const pm = packageManager(root);
  const byTest = Object.values(RUNNERS).find((r) => test !== undefined && r.re.test(test));
  // the install wraps checks in the shim — a copy too, when update moves it
  const wrap = slotWrap(pm.berry);
  // the roots test runs too — they would run twice, in test and in test:spec
  const twice = test === undefined ? [] : roots.filter((dir) => !test.includes(dir));
  // a filter goes to a single runner call only: after `&&` or a pipe it would reach another command
  const filtered = test !== undefined && byTest && twice.length && !/[;&|<>`$()]/.test(test) ? `"test": ${JSON.stringify(wrap([test, ...twice.map(byTest.exclude)].join(" ")))}` : undefined;
  if (pkg.scripts?.["test:spec"]) return { lines: filtered ? [`  ○ package.json: test repeats test:spec — runs ${twice.join(", ")} a second time; put in "scripts": ${filtered}`] : [], missing: false };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const runner = byTest ?? ("vitest" in deps ? RUNNERS.vitest : "jest" in deps ? RUNNERS.jest : pm.name === "bun" ? RUNNERS.bun : RUNNERS.vitest);
  const spec = `"test:spec": ${JSON.stringify(wrap([runner.spec, ...roots].join(" ")))}`;
  const lead = `  ❌ package.json: no test:spec script — pr premerge doesn't run ${roots.join(", ")} on the merge with a moved main`;
  if (!twice.length) return { lines: [`${lead}; add to "scripts": ${spec}`], missing: true };
  if (!filtered) return { lines: [`${lead}; add to "scripts": ${spec}; exclude ${twice.join(", ")} from test with the runner's filter — they don't run twice`], missing: true };
  return { lines: [`${lead}; put in "scripts" — test without them, they don't run twice: ${spec}, ${filtered}`], missing: true };
}

/** The check failed: what and why. */
const unavailable = (global: boolean, e: unknown): Result => ({ code: 2, text: `Elves ${global ? "on the machine" : "in the project"}: check unavailable — ${reason(e)}` });

/**
 * The clone a `--link` install on the machine refers to: the path from the manifest; for an install of a previous
 * version — the symlink of the former canon in the home directory (FORMER.canon; `update -g` removes it and writes the
 * path). null — a copy or not installed.
 */
function linkedClone(home: string) {
  const m = readManifest(home);
  if (typeof m.clone === "string") return m.clone;
  const canon = path.join(home, FORMER.canon);
  return lstat(canon)?.isSymbolicLink() ? path.resolve(path.dirname(canon), readlinkSync(canon)) : null;
}

/** The install on the machine (global) or in the project: the root and whether the flow is there. */
function target(global: boolean) {
  const home = os.homedir();
  const root = global ? home : projectRoot();
  // the home directory is the machine's install, not a project; an Elves clone is the canon itself: its manifest
  // keeps only the mode. An install of an earlier release — by the former names (FORMER)
  const installed = [CANON, MANIFEST, FORMER.canon, FORMER.manifest].some((p) => lstat(path.join(root, p))) && (global || (!samePath(root, home) && !isElvesClone(root)));
  return { home, root, installed };
}

/**
 * Whether the install on the machine (global) or in the project is behind. This package (SRC, the release —
 * `toRelease`) checks a copy on the machine and a project with a dry-run install, a `--link` clone — against
 * `origin/main`. A thin project behind — update in the session's task: a few lines; a project with a copy — the move in
 * a task of its own (`updateTaskLine`).
 */
function check(global: boolean): Result {
  const { home, root, installed } = target(global);
  const where = global ? "on the machine" : "in the project";
  // an Elves clone has nothing to compare against, but the session mode is needed in it — as in a project
  if (!installed && !global && isElvesClone(root)) return { code: 0, text: [`Elves ${where}: not installed — an Elves clone, the canon is at its root`, ...modeLines(root)].join("\n") };
  if (!installed) return { code: 0, text: `Elves ${where}: not installed`, absent: true };
  const clone = global ? linkedClone(home) : null;
  if (clone) return checkLink(home, clone);
  const copy = !global && isCopy(root);
  const changes = dryRun(() => (global ? installGlobal(SRC, false) : installProject(root)));
  const fresh = ownLabel();
  // mode and language are project settings: the last lines, the session start (hook) sees them too
  const mode = global ? [] : modeLines(root);
  // warnings — project settings that update doesn't fix: `!` lines, they don't change the exit code
  const warnings = changeLines(changes.filter((c) => c.op === "!"), root, global);
  // the compose file breaks task isolation — a mismatch (code 1) that update doesn't fix either; `○` — not checked
  const compose = global ? { lines: [], violations: false } : composeCheck(root);
  // standards without test:spec — a mismatch update doesn't add either
  const spec = global ? { lines: [], missing: false } : specScript(root);
  const project = [...warnings, ...compose.lines, ...spec.lines, ...mode];
  const stale = changes.filter((c) => c.op !== "❌" && c.op !== "!");
  const ignored = changes.filter((c) => c.op === "❌");
  if (!stale.length && !ignored.length) return { code: compose.violations || spec.missing ? 1 : 0, compose: compose.violations, spec: spec.missing, text: [`Elves ${where}: up to date (${fresh})`, ...project].join("\n") };
  const m = readManifest(root);
  const fixable = ignored.some((c) => !c.manual);
  const lost = "ignores flow files — they are missing from the commit, other checkouts and the cloud session:";
  const exceptions = fixable ? " — adds exceptions to .gitignore" : "";
  const installedAs = global || copy ? (m.tag ?? short(m.sha) ?? "without SHA") : shownPackage(projectPackage(root));
  const head = copy
    ? `Elves ${where}: a copy of the flow (installed ${installedAs}) — move it to a thin project: ${PACKAGE} ${ownVersion() ?? fresh} in devDependencies, the canon and the skills on the machine`
    : stale.length
      ? `Elves ${where}: behind — installed ${installedAs}, latest ${fresh}`
      : `Elves ${where}: up to date (${fresh}), but git ${lost}`;
  // update won't fix a personal rule — what to do is said in the ❌ line; a copy — in a task of its own, a thin project's
  // few lines — in the session's task
  const action = global
    ? [`${stale.length ? "Update" : "Fix"}: ${RUN} update -g${exceptions}`]
    : copy
      ? [`Move in a task of its own, not in this session's task: ${RUN} update${exceptions}`, updateTaskLine(root)]
      : [`${stale.length ? `Update in this session's task — ${PACKAGE} in package.json and the lockfile, a few lines` : "Fix in this session's task"}: ${RUN} update${exceptions}`];
  return {
    code: 1,
    behind: stale.length > 0,
    copy,
    ignored: ignored.length > 0,
    compose: compose.violations,
    spec: spec.missing,
    run: stale.length > 0 || fixable,
    text: [
      head,
      ...capped(changeLines(stale, root, global)),
      ...(stale.length && ignored.length ? [`Git ${lost}`] : []),
      ...capped(changeLines(ignored, root, global)),
      ...(stale.length || fixable ? action : []),
      ...project,
    ].join("\n"),
  };
}

/**
 * A machine with `--link`: the clone against `origin/main` after `git fetch` — flow files the clone doesn't have yet
 * (the canon of the machine is the clone's: rules, references, skills), and missing links (a new skill, the rules, the
 * hook). Commits without flow files aren't falling behind.
 */
function checkLink(home: string, clone: string): Result {
  const where = `on the machine (clone ${clone})`;
  let head, main, behind, files;
  try {
    git(clone, "fetch", "--quiet", "origin", "main");
    head = git(clone, "rev-parse", "HEAD");
    main = git(clone, "rev-parse", "origin/main");
    behind = Number(git(clone, "rev-list", "--count", "HEAD..origin/main"));
    files = git(clone, "diff", "--no-renames", "--name-status", "HEAD...origin/main", "--", ...FLOW).split("\n").filter(Boolean);
  } catch (e) {
    return { code: 2, text: `Elves ${where}: check unavailable — ${reason(e)}` };
  }
  const all = dryRun(() => installGlobal(clone, true));
  // warnings — what update doesn't fix: `!` lines, not falling behind
  const links = all.filter((c) => c.op !== "!");
  const warnings = changeLines(all.filter((c) => c.op === "!"), home, true);
  if (!files.length && !links.length) {
    const ahead = behind ? `; origin/main ${short(main)} is ahead by ${behind}, the flow isn't affected` : "";
    return { code: 0, text: [`Elves ${where}: up to date (${short(head)}${ahead})`, ...warnings, ...unreleased(clone)].join("\n") };
  }
  const op = (status: string) => (status === "A" ? "+" : status === "D" ? "-" : "~");
  return {
    code: 1,
    behind: true,
    text: [
      `Elves ${where}: behind — clone ${short(head)}, origin/main ${short(main)}`,
      ...capped([...files.map((l) => `  ${op(l.split("\t")[0] ?? "")} ${l.split("\t")[1]}`), ...changeLines(links, home, true)]),
      `Update: ${RUN} update -g`,
      ...warnings,
      ...unreleased(clone),
    ].join("\n"),
  };
}

/**
 * A reminder to the owner on a machine with a `--link` clone: origin/main has flow changes that aren't in the latest
 * release — projects won't get them until it's cut. Only in an Elves clone's session: a release is the owner's step
 * there, in a project's session the line is noise at every start. Not falling behind: it doesn't change the check's
 * code. Can't tell — no line.
 */
function unreleased(clone: string): string[] {
  if (!isElvesClone(projectRoot())) return [];
  const cmd = `release it: bun --no-env-file ${path.join(clone, "bin/elves.ts")} release`;
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
 * (`$ELVES_PROXY`, by default `elves-proxy`). A line for `check -g` and the hook: running, not running — with the
 * start command, Docker unavailable — with the reason. No task-env skill or no docker on the machine — no line: without
 * Docker there are no task stacks, and a line in every session would be noise. Asks docker itself — the skill's
 * `proxyRunning` folds "docker not found" into its reason. Doesn't change the check's code — the proxy isn't the flow
 * falling behind. Not running, while the proxy of an earlier release under the flow's former name (`formerProxyName` of
 * the skill) is — it holds the port: the line names it, and `proxy up` of the skill replaces it.
 */
function proxyLines(home: string): string[] {
  if (!existsSync(path.join(home, ".agents/skills/task-env/scripts/task-env.ts"))) return [];
  const name = proxyName();
  const ps = (project: string) =>
    spawnSync("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=traefik", "--format", "{{.State}}"], { encoding: "utf8", timeout: 10_000 });
  const r = ps(name);
  const err = r.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") return [];
  if (err || r.status !== 0) return [`  proxy *.localhost: Docker unavailable — ${err ? (err.code === "ETIMEDOUT" ? "docker didn't answer in 10 s" : err.message) : String(r.stderr).trim().split("\n")[0]}`];
  const running = (x: ReturnType<typeof ps>) => !x.error && x.status === 0 && x.stdout.split("\n").includes("running");
  if (running(r)) return [`  proxy *.localhost: running (${name})`];
  const up = "bun --no-env-file ~/.agents/skills/task-env/scripts/task-env.ts proxy up";
  const former = formerProxyName();
  if (running(ps(former))) return [`  proxy *.localhost: running under the flow's former name (${former}) — replace it: ${up}`];
  return [`  proxy *.localhost: not running — start: ${up}`];
}

/**
 * A user's variables under the flow's former name (FORMER.env) — set where `update` doesn't reach (the shell profile):
 * a line each with the new name. The skills' scripts read them until renamed.
 */
function formerEnvLines(): string[] {
  return Object.entries(FORMER.env)
    .filter(([, former]) => process.env[former])
    .map(([name, former]) => `  ${former}: the flow's former name — rename it to ${name} where it is set (the shell profile)`);
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
const AGENT_SHELL = "ELVES_AGENT_SHELL";

/** A word for sh: in single quotes. */
const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function agentShellScript() {
  return [
    `# Elves: the agent's Bash environment, written by the SessionStart hook (${RUN} check --hook)`,
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
 * the environment. From a terminal the agent's shell can't be seen — no line. A session started before `update -g`
 * has the mark of the hook of an earlier release (FORMER.agentShell) — the environment is there.
 */
function agentShellLines(): string[] {
  if (process.env.CLAUDECODE !== "1" || process.env[AGENT_SHELL] || process.env[FORMER.agentShell]) return [];
  return [`  agent Bash: not set up — this session got no environment from the Elves SessionStart hook (its output at the session start says why); ${SHELL_FALLBACK}`];
}

/**
 * The check's result plus the machine's lines, installed or not, behind or not: the proxy (`proxyLines`), the agent's
 * Bash environment — the hook passes what writing it gave, `check -g` asks `agentShellLines` — and the user's variables
 * under the flow's former name (`formerEnvLines`).
 */
function withMachine(global: boolean, r: Result, shell = agentShellLines()): Result {
  if (!global || r.absent) return r;
  const lines = [...proxyLines(os.homedir()), ...shell, ...formerEnvLines()];
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
 * The canon loads twice (#557): Claude Code reads the machine's rules (`~/.claude/rules/elves*.md`, `install -g`) and
 * the project's copy (`.claude/rules/elves*.md`, under the flow's former name too) — both, on every turn. Allowed for
 * the move (#180 removed the machine's rules only because of that copy, and projects with a copy are few): the hook
 * names it and the move — the project's update task, `update` turns the copy into the thin project. A rule that doesn't
 * load (a dangling symlink) doesn't count; an Elves clone has no copy, the home directory isn't a project.
 */
function twiceLines(home: string, root: string): string[] {
  const loads = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (samePath(root, home) || isElvesClone(root)) return [];
  const machine = Object.values(RULES).filter((rel) => loads(path.join(home, rel)));
  const project = [...Object.values(RULES), ...FORMER.rules].filter((rel) => loads(path.join(root, rel)));
  if (!machine.length || !project.length) return [];
  return [`  canon loaded twice: the machine's rules ${machine.map((r) => `~/${r}`).join(", ")} and the project's copy ${project.join(", ")} — Claude Code reads both on every turn until the project moves to the thin project: its update, in a task of its own`];
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
  // a git repository without the flow — how to install it (an Elves clone is the canon itself, it isn't absent)
  if (project?.absent && gitRoot()) shown.push({ code: 0, run: true, text: `Elves in the project: not installed — install it: ${RUN} install --lang <project language>` });
  // the canon twice: the update task's line — once, the project's behind text may have printed it already
  const root = projectRoot();
  const twice = twiceLines(os.homedir(), root);
  if (twice.length) shown.push({ code: 0, text: [...twice, ...(project?.run ? [] : [updateTaskLine(root)])].join("\n") });
  const resume = resumeLines();
  if (!shown.length && !resume.length) return 0;
  const tail = [];
  // the machine's update touches only ~/.agents and the hook — the session does it; a thin project's — a few lines in
  // the branch of the session's task; a copy's move — a task of its own (updateTaskLine), the session works by the
  // current flow
  if (machine?.behind) tail.push("The machine is behind — update -g, tell the user what changed (update lists it), re-read what was updated.");
  if (project?.copy) {
    tail.push(
      "The project keeps a copy of the flow — moving it to a thin project is a task of its own, not in a task session: recommend it to the user and ask whether to queue its task (task new above): yes — a background executor (the github skill, «Dispatcher»); work by the current flow. The move task — update, tell the user what changed, fix what it names, run the project's checks, commit into its branch.",
    );
  } else if (project?.behind) {
    tail.push("The project's flow is behind — update in the session's task: it bumps the package version in package.json and the lockfile; tell the user what changed, commit it with the task.");
  }
  if (twice.length) {
    tail.push("The canon loads twice — the machine's rules and the project's copy: recommend the project's move to the thin project and ask whether to queue its update task (task new above); work by the current flow.");
  }
  if (shown.some((r) => r.ignored)) tail.push("Git ignores flow files — update adds exceptions to .gitignore, committed with the update; a rule outside the project — fix it yourself.");
  // the session has no task yet at its start, and one session is one task: the fix goes into a task of its own
  if (shown.some((r) => r.compose)) tail.push("The compose file breaks task isolation — each ❌ line names the rule and the service (the task-env skill); fixing it is a task of its own in the project.");
  if (shown.some((r) => r.spec)) tail.push("No test:spec script — pr premerge doesn't run standards and architecture on the merge; the ❌ line names the package.json scripts; adding them is a task of its own in the project.");
  if (shown.some((r) => r.code === 2)) tail.push("Check unavailable — work by the current flow and say so.");
  if (shown.some((r) => r.run)) tail.push(SANDBOX_HINT);
  note(["Elves flow (AGENTS.md, «First step of a session»):", ...shown.map((r) => r.text), ...resume, ...tail].join("\n"));
  return 0;
}

/**
 * The flow copy's commit subject — in the project language, the `updateCommit` key of this package's github skill
 * dictionary: "Elves flow <tag>" in English, the same phrase translated in other languages.
 */
const commitSubject = (root: string, version: string | null | undefined) => locale.fill(locale.names(languageOf(root)).updateCommit, { version: version ?? "" }).trim();

/**
 * Where a thin project's update starts: the release of its package version and the release's SHA from the tags
 * (`releases`); `why` — the reason the SHA is unknown, for `whatChanged`.
 */
function packageFrom(root: string): { from: { sha?: string; tag?: string }; why: string } {
  const spec = projectPackage(root);
  const tag = spec === undefined ? null : releaseTag(spec);
  if (!tag) return { from: { tag: shownPackage(spec) }, why: spec === undefined ? `the project had no ${PACKAGE}` : `${PACKAGE} ${spec} isn't a release version` };
  try {
    const sha = releases(repoUrl()).find((r) => r.tag === tag)?.sha;
    return { from: { tag, ...(sha ? { sha } : {}) }, why: `no release ${tag} among the tags` };
  } catch (e) {
    return { from: { tag }, why: reason(e) };
  }
}

/** A path for sh: as is, or in single quotes. */
const shWord = (s: string) => (/^[\w./@:+-]+$/.test(s) ? s : shQuote(s));

/**
 * What goes into the commit of an update: what the install changed and the flow files git doesn't track yet (ignored
 * before the update added exceptions) — of them what exists now or what git tracks: `git add` of a removed path git
 * never tracked fails on the pathspec, and the commit with it.
 */
function committable(root: string, changed: string[]) {
  const tracked = (rel: string) => {
    try {
      return git(root, "ls-files", "--", rel) !== "";
    } catch {
      return false;
    }
  };
  const flow = flowEntries(root).map((e) => e.path).filter((rel) => !tracked(rel));
  return [...new Set([...changed, ...flow])].filter((rel) => lstat(path.join(root, rel)) || tracked(rel));
}

/**
 * Bring the install up to date. A machine with `--link` — `updateLink`; the machine's copy — `install` by this
 * package; a project — `installProject` with what changed and the commit of what it wrote: a thin project's — in the
 * session's task, a copy's move — in the update task's branch.
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
  if (isElvesClone(root)) return note(CLONE_NOTE), 0;
  const copy = isCopy(root);
  const { from, why } = copy ? { from: readManifest(root), why: undefined } : packageFrom(root);
  installProject(root);
  const version = ownLabel();
  const add = committable(root, touched);
  note(
    [
      ...whatChanged(from, why),
      ...(add.length
        ? [
            copy ? "Commit the move into the update task's branch:" : "Commit it with the session's task:",
            `  git add -A -- ${add.map(shWord).join(" ")} && git commit -m "chore(agents): ${commitSubject(root, version)}"`,
          ]
        : []),
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
 * @param from the manifest before the update; a thin project — the release of its package version (`packageFrom`)
 * @param why why `from` has no SHA
 */
function whatChanged(from: { sha?: unknown; tag?: unknown }, why = "installed without SHA"): string[] {
  const to = sourceSha(SRC);
  const sha = typeof from.sha === "string" ? from.sha : null;
  const was = (typeof from.tag === "string" && from.tag) || short(sha) || "without SHA";
  const now = ownLabel();
  if (sha && sha === to) return [`Elves ${now} was already installed — nothing changed`];
  const unavailable = (why: string) => [`Elves ${was} → ${now}: changes unavailable — ${why}; releases: ${RELEASES}`];
  if (!sha) return unavailable(why);
  if (!to) return unavailable("the SHA of this package is unknown");
  let groups;
  try {
    groups = releaseGroups(sha, to);
  } catch (e) {
    return unavailable(reason(e));
  }
  const tags = groups.filter((g) => g.tag).length;
  return [
    `Elves ${was} → ${now}${tags ? `, new releases: ${tags}` : ""} — tell the user what changed:`,
    // commits after the last release (an installer from a clone) are named only next to releases
    ...groups.flatMap((g) => [...(g.tag ? [`${g.tag} — ${RELEASES}/tag/${g.tag}`] : tags ? [`${short(to)} — not in a release`] : []), ...g.items.map((i) => `  ${i}`)]),
  ];
}

/**
 * The releases between two SHAs of Elves, newest first, each with its list of changes; commits after the last of them
 * (no releases yet, an installer from a clone) — a group without a tag. The history comes from where the releases do,
 * fetched without file contents into a temporary repository: the bunx package has no `.git`. A release's list starts
 * from the previous release, the first one's — from `from`: with an install from a release that is exactly its GitHub
 * Release's list.
 */
function releaseGroups(from: string, to: string): { tag?: string; items: string[] }[] {
  const remote = repoUrl();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "elves-history-"));
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
  return spawnSync(process.execPath, ["--no-env-file", path.join(clone, "bin/elves.ts"), "install", "-g", "--link"], { stdio: "inherit" }).status ?? 2;
}

/**
 * A release is the owner's step, from a clone: the tag vYYYY.MM.DD (the date in UTC; a second one the same day — .1,
 * .2…) on origin/main and a GitHub Release with the list of changes since the previous release (`changeItems` — `update`
 * prints the same list). Nothing to release — a refusal (code 1): projects mustn't update for nothing.
 * @param preview `--dry-run`: show the tag and the list, create nothing
 */
function releaseCmd(preview: boolean) {
  if (!existsSync(path.join(SRC, ".git"))) return warn("release — only from an Elves clone: bun <clone>/bin/elves.ts release"), 2;
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
  const notes = last ? [`Flow changes since ${last.tag}:`, "", ...items].join("\n") : "First release: projects install and update the flow by Elves releases, not by main.";
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
 * The npm version of a release tag: vYYYY.MM.DD.N → YYYY.MMDD.N, without a patch — .0. Semver has no leading zeros, and
 * a same-day patch needs a number of its own: a prerelease (`-1`) sorts below the release itself, build metadata (`+1`)
 * npm doesn't tell apart. MMDD as a number grows with the date — versions sort as tags. Not a release tag — null.
 */
function npmVersion(tag: string): string | null {
  const m = RELEASE_TAG.exec(tag);
  return m ? `${Number(m[1])}.${Number(m[2]) * 100 + Number(m[3])}.${Number(m[4] ?? 0)}` : null;
}

/**
 * A CommonJS module that names its own file (`__filename`: the knip reporter's path for `deadCode`) — the bundler would
 * bake the build machine's path into it, and the package would lead into nowhere. It stays a file of its own
 * (`--external`), copied next to the chunks that import it: the chunks go to CHUNKS beside it, the import keeps its
 * `./` path.
 */
const OWN_FILE = ["skills/spec/scripts/knip-hints.cjs"];
/** Where the build's chunks go, from dist/: next to OWN_FILE. */
const CHUNKS = "spec/scripts";

/** The modules built for Node: each export of package.json whose `default` is the build of its `bun` source. */
function builtExports(pkg: { exports?: unknown }): { src: string; out: string }[] {
  const entries = pkg.exports && typeof pkg.exports === "object" ? Object.values(pkg.exports) : [];
  return entries.flatMap((e) => (e && typeof e === "object" && "bun" in e && "default" in e ? [{ src: String(e.bun), out: String(e.default) }] : []));
}

/**
 * `pack`, CI on a release tag: the npm package of the release — the version from the tag into package.json, the release
 * commit into its `gitHead` (the package knows its SHA without the network: the manifest of an install from it and
 * what `update` lists — `sourceSha`) and the modules a project imports (`builtExports`) built into dist/. Node doesn't
 * strip types in node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING): a project's `eslint.config.js`, `node --test`, Playwright and Jest load
 * the JS (`default`), Bun and the type checker — the TypeScript source (`bun`, `types`). One build with shared chunks:
 * the modules share the language module and the TypeScript parser. A built module is a project's import, never the entry
 * point: `import.meta.main` is false — Bun's build for Node turns it into `require.main == require.module`, true under
 * Node's ESM, and `github` would run its command line on import. The build runs on CI and works at a project: a path of
 * the build machine in it (OWN_FILE) is a refusal. `npm publish` is the workflow's next step. The build fails —
 * package.json stays as it was.
 */
function pack(tag: string | undefined): number {
  const version = tag === undefined ? null : npmVersion(tag);
  if (!version) return warn(`pack: a release tag is needed — vYYYY.MM.DD or vYYYY.MM.DD.N, not «${tag ?? ""}»`), 2;
  if (!existsSync(path.join(SRC, ".git"))) return warn("pack — only from an Elves checkout: bun <checkout>/bin/elves.ts pack <tag>"), 2;
  const file = path.join(SRC, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const entries = builtExports(pkg);
  const skills = path.join(SRC, "skills");
  const dist = path.join(SRC, "dist");
  rmSync(dist, { recursive: true, force: true });
  const own = OWN_FILE.map((rel) => ({ from: path.join(SRC, rel), to: path.join(dist, path.relative(skills, path.join(SRC, rel))) }));
  const args = ["--target=node", "--format=esm", "--splitting", "--define", "import.meta.main=false", `--root=${skills}`, `--outdir=${dist}`, `--chunk-naming=${CHUNKS}/[name]-[hash].[ext]`, ...own.flatMap((o) => ["--external", `*${path.basename(o.from)}`])];
  const r = spawnSync(process.execPath, ["--no-env-file", "build", ...args, ...entries.map((e) => path.join(SRC, e.src))], { encoding: "utf8" });
  if (r.error || r.status !== 0) return warn(`pack: bun build — ${r.error?.message ?? (r.stderr || r.stdout).trim().split("\n").slice(-3).join("; ")}`), 2;
  for (const o of own) cpSync(o.from, o.to);
  const missing = entries.filter((e) => !existsSync(path.join(SRC, e.out)));
  if (missing.length) return warn(`pack: the build has no ${missing.map((e) => e.out).join(", ")} — exports of package.json lead past it`), 2;
  const baked = [...walk(dist).entries()].filter(([, file]) => readFileSync(file, "utf8").includes(SRC)).map(([rel]) => `dist/${rel}`);
  if (baked.length) return warn(`pack: ${baked.join(", ")} — the build machine's path ${SRC} is baked in: the package would lead into nowhere`), 2;
  writeFileSync(file, JSON.stringify({ ...pkg, version, gitHead: git(SRC, "rev-parse", "HEAD") }, null, 2) + "\n");
  note(`${PACKAGE}@${version} — release ${tag}: dist/ ← ${entries.map((e) => e.src).join(", ")}; next: npm publish`);
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

const FLAGS: Record<string, string[]> = { install: ["-g", "--global", "--link", "--auto", "--no-auto"], check: ["-g", "--global", "--hook"], update: ["-g", "--global"], release: ["--dry-run"], pack: [] };

/** `pack <tag>`: the tag — the first argument that isn't a flag; the other arguments. */
function takeTag(args: string[]): { tag: string | undefined; rest: string[] } {
  const i = args.findIndex((a) => !a.startsWith("-"));
  return i < 0 ? { tag: undefined, rest: args } : { tag: args[i], rest: args.filter((_, j) => j !== i) };
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "", ...args] = argv;
  // a skill's script — at this package's version, the project's: no launcher, the help is the script's
  if (Object.hasOwn(SCRIPTS, cmd)) return runScript(cmd, args);
  const help = (await helpOf(argv)) ?? (cmd === "help" ? await overview() : undefined);
  if (help) return note(help), 0;
  const global = args.includes("-g") || args.includes("--global");
  const hookMode = cmd === "check" && args.includes("--hook");
  // the launcher restarts before it checks the command and flags (`toRelease`): bunx keeps it as old as its first run,
  // and it mustn't reject what the release knows. "Not installed" needs no release: the hook in someone else's project
  // doesn't go to the network for nothing; release — only from a clone, pack — from a checkout
  if (cmd !== "release" && cmd !== "pack" && (cmd !== "check" || (hookMode ? [true, false].some((g) => target(g).installed) : target(global).installed))) {
    try {
      const code = toRelease(argv);
      if (code !== null) return code;
    } catch (e) {
      if (hookMode) return hook(e);
      if (cmd === "check") return process.stderr.write(unavailable(global, e).text + "\n"), 2;
      return warn(`${cmd}: ${reason(e)}`), 2;
    }
  }
  // --lang with a value — only for install, the tag — only for pack: for the other commands it's an unknown flag
  const { lang, rest } = cmd === "install" ? takeLang(args) : { lang: undefined, rest: args };
  const { tag, rest: flags } = cmd === "pack" ? takeTag(rest) : { tag: undefined, rest };
  const allowed = Object.hasOwn(HELP, cmd) ? FLAGS[cmd] : undefined;
  const unknown = allowed ? flags.filter((f) => !allowed.includes(f)) : [];
  if (!allowed || unknown.length) {
    process.stderr.write((!allowed && cmd ? `unknown command: ${cmd}\n\n` : unknown.length ? `unknown flag: ${unknown[0]}\n\n` : "") + (await overview()) + "\n");
    return 2;
  }
  if (lang !== undefined && (global || !LANGUAGE_CODE.test(lang))) {
    warn(`--lang <code> — the project language the agent works in: without -g, a BCP 47 code — ru, en, pt-BR${global ? "" : `; «${lang}» is not a language code`}`);
    return 2;
  }
  if (cmd === "release") return releaseCmd(flags.includes("--dry-run"));
  if (cmd === "pack") return pack(tag);
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
    warn("--link — only with -g and only from an Elves clone: a project keeps the package version, not a link to a local clone");
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
    if (isElvesClone(root)) installClone(root, auto, language);
    else installProject(root, auto, language);
    if (auto) note(MERGE_HINT(language));
    return 0;
  } catch (e) {
    if (denied(e, argv, global)) return 2;
    throw e;
  }
}

process.exitCode = await main(process.argv.slice(2));
