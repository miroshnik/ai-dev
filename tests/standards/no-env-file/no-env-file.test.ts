import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { codeOnly, exceptionsIn, invariant, sources } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Файл флоу: путь от корня и текст. */
interface Source {
  file: string;
  text: string;
}

/** Документы флоу — то, что ставит install (AGENTS.md, claude/, docs/*.md, *.md скиллов), README и package.json. */
function flowDocs(): Source[] {
  const docs = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(path.join(ROOT, "skills")).flatMap((s) => {
    const dir = path.join(ROOT, "skills", s);
    return existsSync(path.join(dir, "SKILL.md")) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `skills/${s}/${f}`) : [];
  });
  return ["AGENTS.md", "claude/CLAUDE.md", "README.md", "package.json", ...docs, ...skills].map((file) => ({ file, text: read(file) }));
}

/** Флаги между `bun` и скриптом: `--no-env-file` среди них — вызов без env-файлов проекта. */
const FLAGS = String.raw`((?:\s+--?[\w-]+(?:=[^\s\`'"]+)?)*)`;
/**
 * Вызов скрипта скилла в документе: `bun <skill dir>/scripts/x.ts`, `bun .agents/skills/…/scripts/x.ts`. Путь не
 * начинается со `*` — маска разрешения `Bash(bun *skills/…)` покрывает и флаг.
 */
const DOC_CALL = new RegExp(String.raw`\bbun${FLAGS}\s+(?:<[^>\n]+>|[^\s\`'"*()<>]+)/scripts/[\w-]+\.ts\b`, "g");
/** Команда, которую печатает скрипт: `bun ${путь}`, `bun .agents/skills/…`, `bun skills/…`. */
const PRINTED = new RegExp(String.raw`\bbun${FLAGS}\s+(?:\$\{|~?/?\.agents/skills/|skills/)`, "g");
/**
 * Вызов скрипта пакета — bin `elves` с шебангом `#!/usr/bin/env bun`: `elves spec-doc`, `elves <скрипт>`,
 * `node_modules/.bin/elves spec-…`, `bunx elves …`. Не вызов: `elves slot --for` шима — команда идёт в shell скрипта, а
 * `elves` только печатает переменные очереди; пакет через bunx (`bunx @miroshnik/elves@<версия> spec-…`) и `$elves` джобы
 * CI без зависимостей — «Вне охвата»; команды установщика (`elves install`) проверок проекта не запускают.
 */
const PACKAGE_CALL = new RegExp(String.raw`(?:\bbun${FLAGS}\s+)?(?:(?:\.\/)?node_modules\/\.bin\/|(?<![\w/.@$-]))elves\s+(?:spec-|slot\b(?!\s+--for\b)|<)`, "g");
/** Дочерний процесс bun: `spawn("bun", [скрипт…])`, `spawnSync(process.execPath, […])` — первым аргументом флаг. */
const SPAWN = /(?:"bun"|process\.execPath)\s*,\s*\[(?!\s*"--no-env-file")/g;

/** Строки нарушений: «номер: строка». */
function lines(text: string, at: number[]): string[] {
  const all = text.split("\n");
  return at.map((i) => {
    const n = text.slice(0, i).split("\n").length - 1;
    return `${n + 1}: ${all[n]!.trim().slice(0, 120)}`;
  });
}

/** Вызовы без флага: позиции совпадений, у которых среди флагов нет `--no-env-file`. */
const unflagged = (text: string, re: RegExp) => [...text.matchAll(re)].filter((m) => !/--no-env-file\b/.test(m[1] ?? "")).map((m) => m.index!);

function noUnflagged(f: Source, at: number[], what: string) {
  if (at.length) throw new Error(`${f.file}: ${what} без --no-env-file — Bun подгрузит env-файлы проекта (tests/standards/no-env-file):\n${lines(f.text, at).join("\n")}`);
}

describe("Скрипты флоу под bun не подгружают env-файлы проекта: вызов несёт --no-env-file", () => {
  invariant(it, {
    rule: "документы",
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов",
    items: flowDocs(),
    key: (f) => f.file,
    name: (f) => `в ${f.file} скрипты скиллов вызываются с --no-env-file`,
    check: (f) => noUnflagged(f, unflagged(f.text, DOC_CALL), "вызов скрипта скилла"),
    violator: [
      { name: "команда скилла без флага", item: { file: "skills/x/SKILL.md", text: "```bash\nbun <skill dir>/scripts/x.ts run\n```\n" } },
      { name: "скрипт package.json без флага", item: { file: "package.json", text: `{"scripts":{"test":"bun .agents/skills/slot/scripts/slot.ts 'vitest run'"}}` } },
    ],
    includes: ["skills/slot/SKILL.md", "skills/github/SKILL.md", "skills/task-env/SKILL.md", "skills/spec/SKILL.md", "docs/parallel-checkouts.md", "package.json"],
  });

  /**
   * bin пакета без флага Bun запускает с env-файлами рабочего каталога, и `elves <скрипт>` из `package.json` отдавал
   * их ключи `gh`, `git` и проверяемой команде (#596). Форма — как в CI: `bun --no-env-file node_modules/.bin/elves`.
   */
  it("вызов скрипта пакета в документах флоу и package.json, который подгрузит env-файлы проекта, — нарушение no-env-file", () => {
    const calls = (text: string) => unflagged(text, PACKAGE_CALL).length;
    const loads = [
      `"spec:doc": "elves spec-doc .spec-report.xml --strict"`,
      "`elves <script>`",
      "`elves spec-…` under Bun",
      "run: node_modules/.bin/elves spec-diff",
      "bun ./node_modules/.bin/elves spec-run --artifact spec-reports",
      "bunx elves spec-publish",
      `"test": "elves slot 'vitest run'"`,
    ];
    const clean = [
      `"spec:doc": "bun --no-env-file node_modules/.bin/elves spec-doc .spec-report.xml --strict"`,
      "bun --no-env-file ./node_modules/.bin/elves <script>",
      "ELVES_SLOT_EXPORT=$(elves slot --for $$)",
      `elves="bunx @miroshnik/elves@1.2.3"; $elves spec-diff`,
      "bunx @miroshnik/elves@<version> spec-publish",
      "bunx @miroshnik/elves install -g",
      "elves install --auto",
    ];
    expect(loads.filter((t) => calls(t) !== 1)).toEqual([]);
    expect(clean.filter((t) => calls(t) !== 0)).toEqual([]);
  });

  invariant(it, {
    rule: "скрипт пакета",
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов",
    items: flowDocs(),
    key: (f) => f.file,
    name: (f) => `в ${f.file} скрипты пакета вызываются как bun --no-env-file node_modules/.bin/elves <скрипт>`,
    check: (f) => noUnflagged(f, unflagged(f.text, PACKAGE_CALL), "вызов скрипта пакета"),
    violator: [
      { name: "скрипт package.json — голый elves", item: { file: "package.json", text: `{"scripts":{"spec:doc":"elves spec-doc .spec-report.xml --strict"}}` } },
      { name: "команда скилла — bin из node_modules без bun --no-env-file", item: { file: "skills/x/SKILL.md", text: "```bash\nnode_modules/.bin/elves spec-diff\n```\n" } },
    ],
    exceptions: exceptionsIn(),
    includes: ["README.md", "skills/spec/SKILL.md", "skills/spec/reference.md", "skills/spec/ci.md"],
  });

  invariant(it, {
    rule: "код",
    registry: "код скриптов скиллов и установщика без комментариев",
    items: sources(ROOT, ["skills", "bin"])
      .filter((f) => !f.file.includes("/vendor/"))
      .map((f) => ({ file: f.file, text: codeOnly(f.text, f.file) })),
    key: (f) => f.file,
    name: (f) => `${f.file} печатает и запускает скрипты флоу с --no-env-file`,
    check: (f) => {
      noUnflagged(f, unflagged(f.text, PRINTED), "печатаемая команда");
      noUnflagged(f, [...f.text.matchAll(SPAWN)].map((m) => m.index!), "дочерний bun");
    },
    violator: [
      { name: "подсказка с командой без флага", item: { file: "skills/x/scripts/x.ts", text: "console.log(`down: bun ${import.meta.path} down`);\n" } },
      { name: "дочерний bun без флага", item: { file: "skills/x/scripts/x.ts", text: `spawnSync("bun", [script, "down"], { cwd });\n` } },
      { name: "дочерний процесс того же bun без флага", item: { file: "bin/x.ts", text: `spawnSync(process.execPath, [TASK_ENV, "check", root]);\n` } },
    ],
    includes: ["skills/github/scripts/github.ts", "skills/task-env/scripts/task-env.ts", "skills/spec/scripts/harness.ts", "bin/elves.ts"],
  });
});
