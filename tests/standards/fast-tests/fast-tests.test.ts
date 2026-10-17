import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Медленный уровень — по имени файла: `--path-ignore-patterns` и фильтр `bun test` выбирают файлы, а не describe. */
const SLOW = /\.slow\.test\.ts$/;

interface File {
  path: string;
  text: string;
}

// импорт значения `spawn` (не `spawnSync`) с начала строки: пример кода в строке теста — не импорт
const SPAWN = /^import\s+\{[^}]*\bspawn\b[^}]*\}\s+from\s+["']node:child_process["']/m;
const DOCKER_INFO = /["']docker["'],\s*\[\s*["']info["']/;
// процесс corepack: менеджер пакетов по `packageManager` проекта он скачивает из сети
const COREPACK = /\bspawn(?:Sync)?\(\s*["']corepack["']/;

/**
 * Причина медленного уровня: тесту нужен демон Docker — он пробует его `docker info`, — живой сервер — скрипт
 * процессом `spawn`, к которому тест ходит `fetch`, — или сеть: менеджер пакетов через corepack. Нет причины — null.
 */
function reason(text: string): string | null {
  if (DOCKER_INFO.test(text)) return "Docker";
  if (SPAWN.test(text) && /\bfetch\(/.test(text)) return "живой сервер";
  if (COREPACK.test(text)) return "corepack";
  return null;
}

function read(dir: string): File[] {
  return readdirSync(path.join(ROOT, "tests", dir), { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".test.ts"))
    .map((rel) => ({ path: path.join("tests", dir, rel), text: readFileSync(path.join(ROOT, "tests", dir, rel), "utf8") }));
}

const tests = [...read("capabilities"), ...read("standards")];
const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

/** Тест проекта-образца: проходит и пишет свой файл в журнал $LEVELS_LOG — так видно, какие файлы прогнала команда. */
const probe = (name: string) => `import { appendFileSync } from "node:fs";\nimport { it } from "bun:test";\nit("${name}", () => appendFileSync(process.env.LEVELS_LOG!, "${name}\\n"));\n`;

/** Стандарт проекта-образца — тест в `tests/standards`. */
const STANDARD = { "tests/standards/s/s.test.ts": probe("s.test.ts") };

/**
 * Проект-образец со скриптами `package.json` Elves, быстрым и медленным тестом (и файлами `extra`); скилы — клона
 * (скрипты зовут slot и spec-doc по относительным путям). → прогон команд в нём: какие из файлов прошли.
 */
function sample(commands: string[][], extra: Record<string, string> = {}): string[] {
  const { dir, cleanup } = tmpDir();
  try {
    writeTree(dir, {
      "package.json": JSON.stringify({ private: true, scripts }),
      "tests/capabilities/x/x.test.ts": probe("x.test.ts"),
      "tests/capabilities/x/x.slow.test.ts": probe("x.slow.test.ts"),
      ...extra,
      "ran.log": "",
    });
    symlinkSync(path.join(ROOT, "skills"), path.join(dir, "skills"));
    const log = path.join(dir, "ran.log");
    // без очереди машины: прогон теста сам в слоте или в CI
    for (const cmd of commands) spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ELVES_SLOT: "fast-tests", LEVELS_LOG: log } });
    return [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))].sort();
  } finally {
    cleanup();
  }
}

interface Step {
  run?: string;
  if?: string;
}

/** Шаги CI, что идут на PR (не только на push в main), — команды, в которых `bun test`: сами или через скрипт `package.json`. */
function ciTestCommands(workflow: string): string[][] {
  const { jobs } = Bun.YAML.parse(workflow) as { jobs: Record<string, { if?: string; steps?: Step[] }> };
  const onPr = (cond?: string) => !cond || !/event_name\s*==\s*'push'/.test(cond);
  const runs = Object.values(jobs)
    .filter((j) => onPr(j.if))
    .flatMap((j) => (j.steps ?? []).filter((s) => s.run && onPr(s.if)).map((s) => s.run!));
  return runs.flatMap((run) => [
    ...[...run.matchAll(/\bbun run ([\w:.-]+)/g)].filter((m) => scripts[m[1]!]?.includes("bun test")).map((m) => ["bun", "run", m[1]!]),
    ...(/\bbun test\b/.test(run) ? [["sh", "-c", run]] : []),
  ]);
}

describe("Локальный test — быстрый уровень: тесты с Docker, живым сервером и corepack — в файлах *.slow.test.ts скрипта test:slow, CI гоняет оба", () => {
  invariant(it, {
    registry: "тесты Elves, которым нужен Docker, живой сервер или corepack",
    items: tests.filter((f) => reason(f.text)),
    name: (f) => `${f.path} (${reason(f.text)}) — в медленном уровне`,
    key: (f) => f.path,
    check: (f) => {
      if (!SLOW.test(f.path)) throw new Error(`${f.path}: ${reason(f.text)} — тест медленного уровня, файл — <имя>.slow.test.ts`);
    },
    violator: { name: "быстрый файл с пробой docker info", item: { path: "tests/capabilities/x/x.test.ts", text: `const up = spawnSync("${"docker"}", ["info"]).status === 0;\n` } },
    includes: ["tests/capabilities/task-env/task-env.slow.test.ts", "tests/capabilities/dashboard/dashboard.slow.test.ts", "tests/capabilities/install/install.slow.test.ts"],
  });

  // без причины медленным тест не становится: иначе в test:slow уходило бы просто медленное и красное
  invariant(it, {
    registry: "медленные тесты Elves",
    items: tests.filter((f) => SLOW.test(f.path)),
    name: (f) => `${f.path} — медленный по причине: Docker, живой сервер или corepack`,
    key: (f) => f.path,
    check: (f) => {
      if (!reason(f.text)) throw new Error(`${f.path}: ни Docker, ни живого сервера, ни corepack — тест быстрого уровня, файл — <имя>.test.ts`);
    },
    violator: { name: "медленный файл без Docker, сервера и corepack", item: { path: "tests/capabilities/x/x.slow.test.ts", text: 'it("считает", () => expect(1 + 1).toBe(2));\n' } },
  });

  it("скрипт test не запускает тесты, которым нужен Docker, живой сервер или corepack: файлы *.slow.test.ts идут скриптом test:slow", () => {
    expect(sample([["bun", "run", "test"]])).toEqual(["x.test.ts"]);
    expect(sample([["bun", "run", "test:slow"]])).toEqual(["x.slow.test.ts"]);
  });

  /** Стандарты — статические проверки, им хватает одного прогона: перед коммитом идут test:spec, затем test (#479). */
  it("скрипт test не повторяет test:spec: стандарты Elves идут только скриптом test:spec", () => {
    const runsStandard = (script: string) => sample([["bun", "run", script]], STANDARD).includes("s.test.ts");
    expect(["test", "test:slow", "test:spec"].filter(runsStandard)).toEqual(["test:spec"]);
  });

  it("CI запускает и быстрый, и медленный уровень", () => {
    const commands = ciTestCommands(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    expect(commands.length).toBeGreaterThan(0);
    expect(sample(commands)).toEqual(["x.slow.test.ts", "x.test.ts"]);
  });

  /** Паузы — 2, 5 и 15 с на каждый сбой: тест ошибки GitHub в dashboard ждал их 44 с из 45. */
  it("скрипты под тестом повторяют gh без настоящих пауз: прогон задаёт ELVES_GH_RETRY_MS=0,0,0, дочерние процессы его наследуют", () => {
    expect(process.env.ELVES_GH_RETRY_MS).toBe("0,0,0");
    const child = spawnSync(process.execPath, ["-e", "console.log(process.env.ELVES_GH_RETRY_MS)"], { encoding: "utf8" });
    expect(exitOf(child)).toBe(0);
    expect(child.stdout.trim()).toBe("0,0,0");
  });

  describe("примеры", () => {
    it("проба docker info — Docker; spawn скрипта и fetch к нему — живой сервер; процесс corepack — corepack", () => {
      expect(reason(`const up = spawnSync("${"docker"}", ["info", "--format", "{{.ServerVersion}}"]).status === 0;\n`)).toBe("Docker");
      expect(reason('import { spawn, spawnSync } from "node:child_process";\nawait fetch(url);\n')).toBe("живой сервер");
      expect(reason(`const r = spawnSync("${"corepack"}", ["yarn", "install"], { cwd });\n`)).toBe("corepack");
    });

    it("spawnSync с fetch, spawn без fetch, docker compose config без демона, слово corepack в тексте — причины нет", () => {
      expect(reason('import { spawnSync } from "node:child_process";\nawait fetch(url);\n')).toBeNull();
      expect(reason('import { spawn } from "node:child_process";\nspawn("bun", [script]);\n')).toBeNull();
      expect(reason(`spawnSync("${"docker"}", ["compose", "config"]);\n`)).toBeNull();
      expect(reason('const NOTE = "Yarn — corepack по packageManager";\n')).toBeNull();
    });

    it("CI с одним test без test:slow — медленный уровень не идёт", () => {
      const ci = "on: pull_request\njobs:\n  tests:\n    steps:\n      - run: bun install\n      - run: bun run test\n";
      expect(sample(ciTestCommands(ci))).toEqual(["x.test.ts"]);
    });

    it("уровни шагом только на push в main — PR их не гоняет", () => {
      const ci = "on: [pull_request, push]\njobs:\n  tests:\n    if: github.event_name == 'push'\n    steps:\n      - run: bun test\n";
      expect(ciTestCommands(ci)).toEqual([]);
    });
  });
});
