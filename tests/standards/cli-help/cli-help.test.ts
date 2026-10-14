import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { clis, commandsOf, escape, isolated, mapLimit } from "../../lib/cli.ts";
import type { Cli, Run } from "../../lib/cli.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Процессов разом: справка стартует за 0,1 с, ~90 запусков — пара секунд. */
const PARALLEL = 8;

/** Справка скрипта или его команды: `--help` и `-h`; `command` пустая — справка скрипта целиком. */
interface Help {
  cli: Cli;
  command: string;
  /** Где команда названа: обзор скрипта или документ флоу. */
  from: string[];
  help: Run;
  short: Run;
}

/** Документы флоу — то, что ставит install (AGENTS.md, claude/, docs/*.md, *.md скиллов), и README. */
function flowDocs(): { file: string; text: string }[] {
  const docs = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(path.join(ROOT, "skills")).flatMap((s) => {
    const dir = path.join(ROOT, "skills", s);
    return existsSync(path.join(dir, "SKILL.md")) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `skills/${s}/${f}`) : [];
  });
  return ["AGENTS.md", "claude/CLAUDE.md", "README.md", ...docs, ...skills].map((file) => ({ file, text: read(file) }));
}

/** Код документа: строки блоков ``` и `…` — там вызовы; проза («скилл github») — не вызов. `…` переносится строкой. */
function codeOf(md: string): string[] {
  const fence = /^\s*```[^\n]*\n([\s\S]*?)^\s*```/gm;
  const blocks = [...md.matchAll(fence)].flatMap((m) => m[1]!.split("\n"));
  const spans = [...md.replace(fence, "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\s+/g, " "));
  return [...blocks, ...spans];
}

/**
 * Команды скриптов, названные в документах флоу: `…/scripts/github.ts task new`, `github task close <N>`,
 * `bunx github:miroshnik/ai-dev check -g` — имя скрипта в начале кода или после пути и слова после него до первого
 * аргумента; имя посреди кода — комментарий или текст («# тесты ai-dev standards»), не вызов.
 */
function namedInDocs(all: Cli[]): { cli: Cli; words: string; file: string }[] {
  const names = all.map((c) => escape(c.name)).join("|");
  const re = new RegExp(String.raw`(?:^\s*|scripts/|bin/|miroshnik/)(${names})(?:\.ts|\.sh)?((?: [a-z][a-z0-9-]*)+)(?=$|[\s\`'"|;,)])`, "g");
  return flowDocs().flatMap(({ file, text }) =>
    codeOf(text).flatMap((code) => [...code.matchAll(re)].map((m) => ({ cli: all.find((c) => c.name === m[1])!, words: m[2]!.trim(), file }))),
  );
}

const CLIS = clis();
const run = (cli: Cli, args: string[]) => Promise.all([isolated(cli, [...args, "--help"]), isolated(cli, [...args, "-h"])]);
const SCRIPTS: Help[] = await mapLimit(CLIS, PARALLEL / 2, async (cli) => {
  const [help, short] = await run(cli, []);
  return { cli, command: "", from: [], help, short };
});

/**
 * Реестр команд — из кода и документов: строки синтаксиса обзора каждого скрипта и вызовы в документах флоу. Вызов в
 * документе — команда обзора, с которой начинаются его слова; иначе — его слова как есть: команда без справки, тест
 * красный. У скрипта без команд слова после имени — аргументы.
 */
function commands(): Omit<Help, "help" | "short">[] {
  const found = new Map<string, Omit<Help, "help" | "short">>();
  const add = (cli: Cli, command: string, from: string) => {
    const key = `${cli.name} ${command}`;
    if (!found.has(key)) found.set(key, { cli, command, from: [] });
    if (!found.get(key)!.from.includes(from)) found.get(key)!.from.push(from);
  };
  const listed = new Map(SCRIPTS.map((s) => [s.cli.name, commandsOf(s.cli.name, s.help.stdout)]));
  for (const s of SCRIPTS) for (const c of listed.get(s.cli.name)!) add(s.cli, c, `${s.cli.name} --help`);
  for (const { cli, words, file } of namedInDocs(CLIS)) {
    const own = listed.get(cli.name)!;
    if (!own.length) continue;
    add(cli, own.find((c) => `${words} `.startsWith(`${c} `)) ?? words, file);
  }
  return [...found.values()];
}

const COMMANDS: Help[] = await mapLimit(commands(), PARALLEL / 2, async (c) => {
  const [help, short] = await run(c.cli, c.command.split(" "));
  return { ...c, help, short };
});

/** Строка запуска: `github task new`. */
const line = (h: Pick<Help, "cli" | "command">) => [h.cli.name, h.command].filter(Boolean).join(" ");

/** Справка — только печать: код 0, вывод в stdout, ни сети, ни внешних команд, ни файлов; `-h` — то же, что `--help`. */
function quiet(h: Help) {
  for (const [flag, r] of [["--help", h.help], ["-h", h.short]] as const) {
    const at = `${line(h)} ${flag}`;
    if (r.code !== 0) throw new Error(`${at}: код ${r.code}, а не 0; stderr: ${r.stderr.slice(-500)}`);
    if (r.stderr) throw new Error(`${at}: справка — в stdout, а в stderr: ${r.stderr.slice(0, 500)}`);
    if (r.net.length) throw new Error(`${at}: обращение к сети — ${r.net.join("; ")}`);
    if (r.calls.length) throw new Error(`${at}: внешние команды — ${r.calls.join("; ")}`);
    if (r.changed.length) throw new Error(`${at}: созданы файлы — ${r.changed.join(", ")}`);
  }
  if (h.short.stdout !== h.help.stdout) throw new Error(`${line(h)} -h печатает не то же, что --help`);
}

/**
 * Справка команды: первый абзац — синтаксис, его первая строка начинается со строки запуска; затем «Examples:» —
 * один-два примера, каждый со строки запуска и только с флагами из синтаксиса.
 */
function usage(h: Help) {
  const text = h.help.stdout;
  const [synopsis = ""] = text.split("\n\n");
  if (!new RegExp(`^${escape(line(h))}(?: |$)`, "m").test(synopsis.split("\n")[0]!)) {
    throw new Error(`${line(h)} --help: первая строка — не синтаксис «${line(h)} …», а «${synopsis.split("\n")[0]}»${h.from.length ? ` (названа: ${h.from.join(", ")})` : ""}`);
  }
  const examples = /^Examples:\n((?: {2}.*\n?)+)/m.exec(text)?.[1]?.trimEnd().split("\n").map((l) => l.trim()) ?? [];
  if (!examples.length) throw new Error(`${line(h)} --help: нет примеров — строки «Examples:» и под ней «  ${line(h)} …»`);
  for (const ex of examples) {
    if (!new RegExp(`^${escape(line(h))}(?: |$)`).test(ex)) throw new Error(`${line(h)} --help: пример «${ex}» — не вызов «${line(h)} …»`);
    const extra = [...ex.matchAll(/(?<=^|\s)(--?[a-z][\w-]*)/g)].map((m) => m[1]!).filter((f) => !new RegExp(`(?<![\\w-])${escape(f)}(?![\\w-])`).test(synopsis));
    if (extra.length) throw new Error(`${line(h)} --help: в примере «${ex}» флаги не из синтаксиса — ${extra.join(", ")}`);
  }
}

/** Справка скрипта с командами — обзор: синтаксис каждой и строка «<скрипт> <command> --help» о подробностях. */
function overview(h: Help) {
  if (!commandsOf(h.cli.name, h.help.stdout).length) return usage(h);
  const hint = `${h.cli.name} <command> --help`;
  if (!h.help.stdout.includes(hint)) throw new Error(`${h.cli.name} --help: обзор не называет «${hint}» — где подробности команды`);
}

/** Исход запуска справки, как у честного скрипта: код 0, только stdout. */
const clean = (stdout: string): Run => ({ code: 0, stdout, stderr: "", calls: [], net: [], changed: [] });
const fake: Cli = { file: "skills/x/scripts/x.ts", name: "x", run: [] };
const GOOD = "x run <N> [--force]\n\nRuns it.\n\nExamples:\n  x run 42\n";
const helpOf = (command: string, help: Run, short: Run = help): Help => ({ cli: fake, command, from: [], help, short });

describe("Скрипты флоу отвечают на --help и -h: синтаксис с примером, код 0, без сети и без изменений", () => {
  invariant(it, {
    rule: "скрипты",
    registry: "скрипты флоу — установщик и исполняемые скрипты скиллов",
    items: SCRIPTS,
    key: (h) => h.cli.file,
    name: (h) => `${h.cli.name} --help и -h — ${commandsOf(h.cli.name, h.help.stdout).length ? "обзор команд" : "синтаксис с примером"}, код 0, без сети и изменений`,
    check: (h) => (quiet(h), overview(h)),
    violator: [
      { name: "справка в stderr с кодом 2", item: helpOf("", { ...clean(""), code: 2, stderr: "Usage: x …" }) },
      { name: "обзор без строки о справке команды", item: helpOf("", clean("x — tools\n\n  x run <N>\n  x stop <N>\n")) },
    ],
    includes: ["bin/ai-dev.ts", "skills/github/scripts/github.ts", "skills/est/scripts/est.ts", "skills/task-env/scripts/task-env.ts", "skills/ci-wait/scripts/wait-ci.sh", "skills/slot/scripts/slot.ts", "skills/spec/scripts/spec-doc.ts"],
  });

  invariant(it, {
    rule: "команды",
    registry: "команды скриптов — из обзора каждого скрипта и из вызовов в документах флоу",
    items: COMMANDS,
    key: (h) => line(h),
    name: (h) => `${line(h)} --help и -h — синтаксис с примером, код 0, без сети и изменений`,
    check: (h) => (quiet(h), usage(h)),
    violator: [
      { name: "без примеров", item: helpOf("run", clean("x run <N> [--force]\n\nRuns it.\n")) },
      { name: "пример с флагом не из синтаксиса", item: helpOf("run", clean(GOOD.replace("x run 42", "x run 42 --dry-run"))) },
      { name: "команда без справки — обзор вместо её синтаксиса", item: helpOf("run", clean("x — tools\n\n  x stop <N>\n\nx <command> --help\n")) },
      { name: "обращение к сети", item: helpOf("run", { ...clean(GOOD), net: ["fetch https://api.github.com/user"] }) },
      { name: "внешняя команда", item: helpOf("run", { ...clean(GOOD), calls: ["gh api user"] }) },
      { name: "запись файла", item: helpOf("run", { ...clean(GOOD), changed: [".agents"] }) },
      { name: "-h не то же, что --help", item: helpOf("run", clean(GOOD), { ...clean(""), code: 2, stderr: "Unknown option '-h'" }) },
    ],
    includes: ["ai-dev install", "ai-dev check", "github task new", "github pr premerge", "est fact", "task-env proxy up", "task-env check", "wait-ci merged"],
  });

  /** Песочница видит то, что проверка запрещает справке: без этого «без сети и изменений» было бы зелёным всегда. */
  it("песочница видит обращение к сети, внешнюю команду и запись файла", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli-help-violator-"));
    try {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "x.ts");
      writeFileSync(
        file,
        [
          `import { spawnSync } from "node:child_process";`,
          `import { writeFileSync } from "node:fs";`,
          `await fetch("https://api.github.com/user").catch(() => {});`,
          `spawnSync("gh", ["api", "user"]);`,
          `writeFileSync(".agents", "");`,
          `console.log("x run <N>");`,
        ].join("\n"),
      );
      const r = await isolated({ file: "x.ts", name: "x", run: [process.execPath, "--no-env-file", file] }, ["--help"]);
      expect({ code: r.code, net: r.net, calls: r.calls, changed: r.changed }).toEqual({ code: 0, net: ["fetch https://api.github.com/user"], calls: ["gh api user"], changed: ["cwd/.agents"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
