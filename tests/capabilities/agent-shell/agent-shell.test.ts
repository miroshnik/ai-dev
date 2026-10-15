import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { elves, sandbox, type Sandbox } from "../../lib/elves.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
/** Файл, который Claude Code даёт хуку SessionStart в `CLAUDE_ENV_FILE`. */
let envFile: string;
beforeEach(() => {
  sb = sandbox();
  // команды, которые зовут проверки, — в PATH песочницы; timeout в нём нет, как на macOS без coreutils
  for (const cmd of ["zsh", "bash", "sleep", "cat"]) symlinkSync(which(cmd), path.join(sb.bin, cmd));
  mkdirSync(path.join(sb.home, ".claude"));
  envFile = path.join(sb.home, ".claude/session-env/session/sessionstart-hook-0.sh");
  mkdirSync(path.dirname(envFile), { recursive: true });
  elves(sb, ["install", "-g"]);
});
afterEach(() => sb.cleanup());

function which(cmd: string) {
  return execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Хук SessionStart в начале сессии: `check --hook` с `CLAUDE_ENV_FILE`, как его зовёт Claude Code. */
function hook(env: Record<string, string> = { CLAUDE_ENV_FILE: envFile }) {
  return elves(sb, ["check", "--hook"], { env });
}

/**
 * Bash-вызов агента так, как его собирает Claude Code (сверено с 2.1.295): `<оболочка> -c` и через ` && ` — `source`
 * снапшота оболочки пользователя (в песочнице снапшота нет — пустой), текст сессионного окружения (файлы хуков
 * SessionStart) с `:` после него, `setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL` для zsh и `eval` команды. session — текст
 * окружения, null — сессия без него.
 */
function agentBash(command: string, session: string | null = readFileSync(envFile, "utf8"), shell = "zsh") {
  const parts = [
    "source /dev/null 2>/dev/null || true",
    ...(session === null ? [] : [`${session.trim()}\n:`]),
    ...(shell === "zsh" ? ["setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true"] : []),
    `eval ${quote(command)}`,
  ];
  const started = Date.now();
  const r = spawnSync(path.join(sb.bin, shell), ["-c", parts.join(" && ")], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, seconds: (Date.now() - started) / 1000 };
}

describe("zsh в Bash-вызове агента понимает команды, написанные для bash", () => {
  it("Bash-вызов агента с глобом без совпадений передаёт его команде как есть", () => {
    expect(hook().code).toBe(0);
    expect(agentBash("printf '%s\\n' --include=*.nomatch src/*.nomatch")).toMatchObject({ code: 0, stdout: "--include=*.nomatch\nsrc/*.nomatch\n" });
    expect(agentBash("printf '%s\\n' --include=*.nomatch", null).stderr).toContain("no matches found: --include=*.nomatch");
  });

  it("глоб с совпадениями по-прежнему раскрывается", () => {
    hook();
    writeFileSync(path.join(sb.proj, "a.ts"), "");
    expect(agentBash("printf '%s\\n' *.ts").stdout).toBe("a.ts\n");
  });

  it("`echo ====` в Bash-вызове агента печатает строку", () => {
    hook();
    expect(agentBash("echo ====")).toMatchObject({ code: 0, stdout: "====\n" });
    expect(agentBash("echo ====", null).stderr).toContain("not found");
  });

  it("== в [ ] — сравнение, а слово с = в начале — строка, а не путь к команде", () => {
    hook();
    expect(agentBash('[ a == a ] && echo same').stdout).toBe("same\n");
    expect(agentBash("echo =cat").stdout).toBe("=cat\n");
  });

  it("в bash текст окружения ничего не ломает и не шумит", () => {
    hook();
    expect(agentBash("echo ok", undefined, "bash")).toMatchObject({ code: 0, stdout: "ok\n", stderr: "" });
  });

  it("хук на resume перезаписывает файл окружения, а не дописывает второй раз", () => {
    hook();
    const first = readFileSync(envFile, "utf8");
    hook();
    expect(readFileSync(envFile, "utf8")).toBe(first);
  });
});

describe("timeout там, где его нет у машины, ведёт себя как GNU timeout", () => {
  beforeEach(() => void hook());

  /** В PATH песочницы timeout нет — как на macOS без coreutils; на Linux CI настоящий timeout в /usr/bin вне её PATH. */
  it("`timeout <секунды> <команда>` работает на macOS без coreutils", () => {
    const late = agentBash("timeout 0.3 sleep 60; echo code=$?");
    expect(late.stdout).toBe("code=124\n");
    expect(late.seconds).toBeLessThan(30);
    expect(agentBash("echo hi | timeout 5 cat; timeout 5s sh -c 'exit 3'; echo code=$?").stdout).toBe("hi\ncode=3\n");
  });

  it("убита вся группа команды: внук не держит вывод вызова и ничего не печатает после срока", () => {
    const r = agentBash("timeout 0.3 sh -c 'sleep 60; echo late'; echo code=$?");
    expect(r.stdout).toBe("code=124\n");
    expect(r.seconds).toBeLessThan(30);
  });

  it("-s — сигнал (KILL — код 137, как у GNU), -k — KILL вдогонку команде, которая сигнал ловит; --preserve-status — код команды", () => {
    expect(agentBash("timeout -s KILL 0.3 sleep 60; echo code=$?").stdout).toBe("code=137\n");
    const trap = agentBash("timeout -k 0.3 3 sh -c 'trap \"\" TERM; sleep 60'; echo code=$?");
    expect(trap.stdout).toBe("code=137\n");
    expect(trap.seconds).toBeLessThan(30);
    expect(agentBash("timeout --preserve-status 0.3 sleep 60; echo code=$?").stdout).toBe("code=143\n");
  });

  it("команды нет — 127, неверный срок — 125 с причиной", () => {
    expect(agentBash("timeout 5 no-such-command-430; echo code=$?").stdout).toBe("code=127\n");
    const bad = agentBash("timeout 5x true; echo code=$?");
    expect(bad.stdout).toBe("code=125\n");
    expect(bad.stderr).toContain("invalid time interval '5x'");
  });

  it("настоящий timeout машины выигрывает у шима", () => {
    writeFileSync(path.join(sb.bin, "timeout"), "#!/bin/sh\necho real timeout\n", { mode: 0o755 });
    expect(agentBash("timeout 5 true").stdout).toBe("real timeout\n");
  });
});

describe("Окружение Bash агента не настроено — об этом говорят check -g и хук", () => {
  const NOT_SET_UP = "agent Bash: not set up";

  /**
   * Из Bash агента: Claude Code ставит в нём CLAUDECODE=1, а метку ELVES_AGENT_SHELL — окружение хука. Сессия, начатая
   * до `update -g`, несёт метку хука прошлого релиза — AI_DEV_AGENT_SHELL (прежнее имя флоу, #545): окружение у неё есть.
   */
  it("`check -g` называет, если окружение Bash агента не настроено; метка хука прошлого релиза — тоже окружение", () => {
    const bare = elves(sb, ["check", "-g"], { env: { CLAUDECODE: "1" } });
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain(`  ${NOT_SET_UP} — this session got no environment from the Elves SessionStart hook`);
    expect(bare.stdout).toContain("quote globs");
    expect(elves(sb, ["check", "-g"], { env: { CLAUDECODE: "1", ELVES_AGENT_SHELL: "1" } }).stdout).not.toContain(NOT_SET_UP);
    expect(elves(sb, ["check", "-g"], { env: { CLAUDECODE: "1", AI_DEV_AGENT_SHELL: "1" } }).stdout).not.toContain(NOT_SET_UP);
  });

  it("из терминала строки нет: оболочку агента оттуда не видно", () => {
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain(NOT_SET_UP);
  });

  it("окружение Bash агента ставит метку, по которой его узнаёт check -g", () => {
    hook();
    expect(agentBash('echo "$ELVES_AGENT_SHELL"').stdout).toBe("1\n");
  });

  it("хук без CLAUDE_ENV_FILE или с файлом, который не записать, — строка с причиной; записал — строки нет", () => {
    expect(hook().stdout).not.toContain(NOT_SET_UP);
    expect(hook({}).stdout).toContain(`  ${NOT_SET_UP} — Claude Code gave the hook no CLAUDE_ENV_FILE`);
    writeFileSync(path.join(sb.tmp, "file"), "");
    const r = hook({ CLAUDE_ENV_FILE: path.join(sb.tmp, "file/sessionstart-hook-0.sh") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`  ${NOT_SET_UP} — can't write CLAUDE_ENV_FILE`);
  });

  it("машина без хука SessionStart — check -g называет, что без него нет и окружения Bash агента", () => {
    writeFileSync(path.join(sb.home, ".claude/settings.json"), "{}\n");
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ~ ~/.claude/settings.json — the SessionStart hook: the flow check and the agent's Bash environment\n");
  });
});
