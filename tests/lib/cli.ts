import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Скрипты флоу с точкой входа и запуск их справки в песочнице — для стандарта `tests/standards/cli-help` и тестов,
 * которым нужны команды скриптов (README, язык справки). Не спека.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Скрипт флоу: файл от корня, имя в справке (`github`, `wait-ci`), чем запускать. */
export interface Cli {
  file: string;
  name: string;
  run: string[];
}

/** Установщик и исполняемые скрипты скиллов (со строкой `#!`): из файлов, не списком; библиотеки скилла — без неё. */
export function clis(): Cli[] {
  const skills = readdirSync(path.join(ROOT, "skills")).filter((s) => existsSync(path.join(ROOT, "skills", s, "SKILL.md")));
  const scripts = skills.flatMap((s) => {
    const dir = path.join(ROOT, "skills", s, "scripts");
    // подкаталог (vendor/ — чужой код файлом) — не скрипт
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `skills/${s}/scripts/${e.name}`) : [];
  });
  return ["bin/elves.ts", ...scripts]
    .filter((file) => readFileSync(path.join(ROOT, file), "utf8").startsWith("#!"))
    .map((file) => ({
      file,
      name: path.basename(file).replace(/\.(ts|sh)$/, ""),
      // bash — абсолютным путём: в песочнице PATH — только заглушки
      run: file.endsWith(".sh") ? [bash(), path.join(ROOT, file)] : [process.execPath, "--no-env-file", path.join(ROOT, file)],
    }));
}

/** bash машины: на macOS из PATH (brew), иначе системный. */
function bash(): string {
  const found = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "bash")).find((p) => existsSync(p));
  return found ?? "/bin/bash";
}

/**
 * Команды из обзора скрипта: слова после имени в строке синтаксиса до первого аргумента — `  github task close <N>` →
 * `task close`; слово кончается пробелом или концом строки (`spec-doc report.json` — без команды).
 */
export function commandsOf(name: string, overview: string): string[] {
  const re = new RegExp(String.raw`^ {2}${escape(name)}((?: [a-z][a-z0-9-]*)+)(?= |$)`, "gm");
  return [...new Set([...overview.matchAll(re)].map((m) => m[1]!.trim()))];
}

export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Запуск в песочнице: исход и всё, что процесс сделал вовне. */
export interface Run {
  /** Код выхода; не завершился — строка с причиной. */
  code: number | string;
  stdout: string;
  stderr: string;
  /** Внешние команды, которые он запускал: `gh api user`. */
  calls: string[];
  /** Обращения к сети: `fetch https://api.github.com/user`. */
  net: string[];
  /** Файлы и каталоги, которые он создал в рабочем каталоге, HOME и TMPDIR. */
  changed: string[];
}

/**
 * Команды, которые песочница подменяет заглушкой: PATH — только они. Заглушка пишет вызов в журнал и выходит с кодом 1;
 * остальное не находится вовсе.
 */
const STUBS = ["gh", "git", "docker", "curl", "wget", "bun", "bunx", "npm", "npx", "node", "open", "xdg-open", "sh", "bash", "awk", "sed", "cat", "mkdir", "rm", "cp", "mv", "touch"];
/** Скрипт не завершился за это время — зависание, а не медленный старт. */
const RUN_TIMEOUT = 60_000;

/** Preload, который записывает `fetch` дочернего bun и отказывает ему. */
const NET_RECORDER = fileURLToPath(new URL("./cli-net.ts", import.meta.url));
/** Прокси — закрытый порт: обращение в обход `fetch` не уйдёт в сеть, а упадёт сразу. */
const NO_PROXY_PORT = "http://127.0.0.1:1";

/**
 * Запуск скрипта с аргументами в песочнице: пустые рабочий каталог, HOME и TMPDIR, PATH из заглушек, `fetch` bun —
 * записывает обращение и отказывает (`cli-net.ts`), без кэша транспилятора Bun (он пишет в HOME). Окружение — только
 * это: переменные сессии и машины до скрипта не доходят.
 */
export async function isolated(cli: Cli, args: string[]): Promise<Run> {
  const base = mkdtempSync(path.join(os.tmpdir(), "cli-help-"));
  const [bin, box, journal, netLog] = ["bin", "box", "calls", "net"].map((d) => path.join(base, d)) as [string, string, string, string];
  const [cwd, home, tmp] = ["cwd", "home", "tmp"].map((d) => path.join(box, d)) as [string, string, string];
  for (const d of [bin, cwd, home, tmp]) mkdirSync(d, { recursive: true });
  for (const f of [journal, netLog]) writeFileSync(f, "");
  for (const s of STUBS) writeFileSync(path.join(bin, s), `#!/bin/sh\nprintf '%s %s\\n' "\${0##*/}" "$*" >> "$CLI_CALLS"\nexit 1\n`, { mode: 0o755 });
  const env: Record<string, string> = {
    PATH: bin,
    HOME: home,
    TMPDIR: tmp,
    CLI_CALLS: journal,
    CLI_NET: netLog,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    ...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((k) => [[k, NO_PROXY_PORT], [k.toLowerCase(), NO_PROXY_PORT]])),
    // стандарт spawn-no-jit: дочерний bun на macOS — без JIT
    ...(process.env.BUN_JSC_useJIT ? { BUN_JSC_useJIT: process.env.BUN_JSC_useJIT } : {}),
  };
  const [cmd, ...rest] = cli.run as [string, ...string[]];
  const argv = cmd === process.execPath ? ["--preload", NET_RECORDER, ...rest, ...args] : [...rest, ...args];
  try {
    const out = await new Promise<Pick<Run, "code" | "stdout" | "stderr">>((resolve) => {
      const p = spawn(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let [stdout, stderr] = ["", ""];
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => p.kill("SIGKILL"), RUN_TIMEOUT);
      p.on("error", (e) => (clearTimeout(timer), resolve({ code: `не запущен: ${e.message}`, stdout, stderr })));
      p.on("close", (code, signal) => (clearTimeout(timer), resolve({ code: code ?? `убит сигналом ${signal}`, stdout, stderr })));
    });
    const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean);
    return { ...out, calls: lines(journal), net: lines(netLog), changed: created(box).filter((p) => !["cwd", "home", "tmp"].includes(p)) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Пути под каталогом, от него. */
function created(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

/** `fn` над элементами, не больше `limit` разом; порядок результатов — порядок элементов. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
