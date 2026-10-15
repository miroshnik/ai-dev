import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import { packageManager, projectCommands } from "../../../skills/github/scripts/github.ts";
import type { PackageManager } from "../../../skills/github/scripts/github.ts";
import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";
import { elves, sandbox } from "../../lib/elves.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = path.join(ROOT, "skills");
const OWNER = "skills/github/scripts/github.ts";

type Answer = (dir: string) => PackageManager;

/** Ответ на «какой менеджер пакетов у проекта»: скрипт скилла и его `packageManager`. */
interface Copy {
  file: string;
  answer: Answer;
}

/** Скрипты скиллов, которые экспортируют `packageManager`: новый ответ попадает под таблицу сам. */
async function copies(): Promise<Copy[]> {
  const out: Copy[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^export function packageManager\(/m.test(readFileSync(path.join(dir, f), "utf8"))) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      out.push({ file: `skills/${skill}/scripts/${f}`, answer: mod.packageManager });
    }
  }
  return out;
}

/** Строка таблицы: поле `packageManager` (`null` — нет `package.json`, `""` — без поля), файлы проекта и ответ. */
interface Row {
  field: string | null;
  files: string[];
  want: string;
  why: string;
}

/** Таблица правила: что лежит в проекте и какой у него менеджер пакетов, Yarn 2+ и lockfile для установки. */
const TABLE: Row[] = [
  { field: "", files: ["bun.lock"], want: "bun · bun.lock", why: "lockfile Bun" },
  { field: "", files: ["bun.lockb"], want: "bun · bun.lockb", why: "бинарный lockfile Bun" },
  { field: "", files: ["pnpm-lock.yaml"], want: "pnpm · pnpm-lock.yaml", why: "lockfile pnpm" },
  { field: "", files: ["yarn.lock"], want: "Yarn 1 · yarn.lock", why: "lockfile Yarn без .yarnrc.yml" },
  { field: "", files: ["yarn.lock", ".yarnrc.yml"], want: "Yarn 2+ · yarn.lock", why: "lockfile Yarn с .yarnrc.yml" },
  { field: "", files: ["package-lock.json"], want: "npm · package-lock.json", why: "lockfile npm" },
  { field: "", files: ["bun.lock", "package-lock.json"], want: "bun · bun.lock", why: "два lockfile — по порядку" },
  { field: "", files: [], want: "npm · без lockfile", why: "ни packageManager, ни lockfile" },
  { field: null, files: [], want: "npm · без lockfile", why: "нет package.json" },
  { field: "bun@1.4.3", files: [], want: "bun · без lockfile", why: "packageManager без lockfile" },
  { field: "pnpm@10.1.0", files: ["bun.lock"], want: "pnpm · bun.lock", why: "packageManager сильнее забытого lockfile" },
  { field: "pnpm@10.1.0", files: ["bun.lock", "pnpm-lock.yaml"], want: "pnpm · pnpm-lock.yaml", why: "lockfile — свой у менеджера" },
  { field: "yarn@4.9.1", files: [], want: "Yarn 2+ · без lockfile", why: "yarn@2+ в packageManager" },
  { field: "yarn@1.22.22", files: [".yarnrc.yml"], want: "Yarn 1 · без lockfile", why: "версию Yarn решает packageManager" },
  { field: "pnpm@10.1.0", files: [".yarnrc.yml"], want: "pnpm · без lockfile", why: "packageManager сильнее забытого .yarnrc.yml" },
  { field: "", files: [".yarnrc.yml"], want: "Yarn 2+ · без lockfile", why: ".yarnrc.yml без lockfile" },
  { field: "", files: ["package-lock.json", ".yarnrc.yml"], want: "npm · package-lock.json", why: "lockfile сильнее .yarnrc.yml" },
];

const label = (row: Row) => [row.field === null ? "без package.json" : row.field ? `packageManager ${row.field}` : "package.json", ...row.files].join(" + ");

const show = (pm: PackageManager) => {
  const name = pm.name === "yarn" ? (pm.berry ? "Yarn 2+" : "Yarn 1") : pm.berry ? `${pm.name} в shell Yarn 2+` : pm.name;
  return `${name} · ${pm.lockfile ?? "без lockfile"}`;
};

const fixtures = tmpDir();
afterAll(() => fixtures.cleanup());

/** Проект строки таблицы — каталог с её package.json и файлами. */
const projects = TABLE.map((row, i) => {
  const dir = path.join(fixtures.dir, String(i));
  const files: Record<string, string> = Object.fromEntries(row.files.map((f) => [f, f === ".yarnrc.yml" ? "nodeLinker: node-modules\n" : "{}\n"]));
  if (row.field !== null) files["package.json"] = JSON.stringify(row.field ? { name: "x", packageManager: row.field } : { name: "x" });
  writeTree(dir, { ...files, ".keep": "" });
  return dir;
});

/** Строки таблицы, на которые ответ расходится с правилом. */
function mismatches(answer: Answer): string[] {
  return TABLE.flatMap((row, i) => {
    const got = show(answer(projects[i]!));
    return got === row.want ? [] : [`${label(row)}: ${got}, а по правилу — ${row.want} (${row.why})`];
  });
}

const has = (dir: string, ...files: string[]) => files.some((f) => existsSync(path.join(dir, f)));
// копии до стандарта поверх правила: каждая со своим расхождением
const bunByLockfile: Answer = (dir) => {
  const pm = packageManager(dir);
  return has(dir, "bun.lock", "bun.lockb") ? { ...pm, name: "bun" } : pm;
};
const yarnrcAnyManager: Answer = (dir) => {
  const pm = packageManager(dir);
  return { ...pm, berry: pm.berry || has(dir, ".yarnrc.yml") };
};

const registry = await copies();

describe("Менеджер пакетов проекта отвечает одна функция: packageManager в package.json сильнее lockfile, без обоих — npm, .yarnrc.yml — Yarn 2+", () => {
  invariant(it, {
    registry: "скрипты скиллов с ответом на «какой менеджер пакетов у проекта»",
    items: registry,
    key: (c) => c.file,
    includes: [OWNER],
    name: (c) => `${c.file}: менеджер пакетов проекта — по таблице правила`,
    check: (c) => {
      const wrong = mismatches(c.answer);
      if (wrong.length) throw new Error(`${c.file}: packageManager расходится с правилом:\n${wrong.join("\n")}`);
    },
    violator: [
      { name: "раннер test:spec до стандарта: bun.lock сильнее packageManager", item: { file: "bin/elves.ts specScript", answer: bunByLockfile } },
      { name: "обёртка slot до стандарта: .yarnrc.yml — shell Yarn 2+ при любом менеджере", item: { file: "bin/elves.ts yarnShell", answer: yarnrcAnyManager } },
    ],
  });

  it("таблица ловит расхождения копий до стандарта: забытый bun.lock у раннера test:spec, забытый .yarnrc.yml у обёртки slot", () => {
    expect([...mismatches(bunByLockfile), ...mismatches(yarnrcAnyManager)].map((m) => m.split(":")[0])).toEqual([
      "packageManager pnpm@10.1.0 + bun.lock",
      "packageManager pnpm@10.1.0 + bun.lock + pnpm-lock.yaml",
      "packageManager yarn@1.22.22 + .yarnrc.yml",
      "packageManager pnpm@10.1.0 + .yarnrc.yml",
      "package.json + package-lock.json + .yarnrc.yml",
    ]);
  });
});

describe("Менеджер пакетов у premerge, обёртки slot и раннера test:spec у check — ответ packageManager", () => {
  it("premerge, обёртка slot и раннер test:spec у check берут менеджер пакетов у неё: packageManager pnpm и забытые bun.lock и .yarnrc.yml — premerge зовёт pnpm, обёртка slot — через шим slot.sh, check не предлагает bun test", () => {
    const sb = sandbox();
    try {
      writeTree(sb.proj, {
        "package.json": JSON.stringify({ name: "x", private: true, packageManager: "pnpm@10.1.0", scripts: { lint: "eslint ." } }, null, 2) + "\n",
        "bun.lock": "{}\n",
        ".yarnrc.yml": "nodeLinker: node-modules\n",
        "tests/standards/naming/naming.test.ts": "",
      });
      const install = elves(sb, ["install"]);
      expect(install.code, install.stderr).toBe(0);
      const scripts = JSON.parse(readFileSync(path.join(sb.proj, "package.json"), "utf8")).scripts;
      expect(scripts.lint).toBe(". .agents/slot.sh && eslint .");
      const check = elves(sb, ["check"]);
      expect(check.stdout).toContain(`"test:spec": ${JSON.stringify(". .agents/slot.sh && vitest run tests/standards")}`);
      expect(check.stdout).not.toContain("bun test");
      expect(projectCommands(sb.proj).run("test:spec").join(" ")).toBe("pnpm run test:spec");
    } finally {
      sb.cleanup();
    }
  });
});

// поле packageManager из package.json — обращение к свойству, по ключу, деструктуризация; не вызов функции и не тип
const FIELD = /\.packageManager\b(?!\s*\()|\[\s*["'`]packageManager["'`]\s*\]|\b(?:const|let|var)\s*\{[^{}]*\bpackageManager\b[^{}]*\}\s*=/;
// lockfile или .yarnrc.yml строкой — целиком или концом пути
const LOCKFILE = /["'`/](?:bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|\.yarnrc\.yml)["'`]/;
const touches = (code: string) => FIELD.test(code) || LOCKFILE.test(code);

/** Код файла без тела `packageManager` в github.ts — там поле и lockfile на своём месте; строки — на прежних номерах. */
function outsideAnswer(f: SourceFile): string {
  const code = codeOnly(f.text, f.file);
  if (f.file !== OWNER) return code;
  const start = code.search(/^export function packageManager\(/m);
  if (start < 0) return code;
  const end = start + code.slice(start).search(/^\}/m) + 1;
  return end <= start ? code : code.slice(0, start) + code.slice(start, end).replace(/[^\n]/g, " ") + code.slice(end);
}

describe("Скрипт флоу не читает packageManager и не ищет lockfile мимо функции packageManager", () => {
  invariant(it, {
    registry: "скрипты флоу, которые читают поле packageManager или называют lockfile",
    items: sources(ROOT, ["bin", "skills"]).filter((f) => /packageManager|lock|yarnrc/.test(f.text) && touches(codeOnly(f.text, f.file))),
    key: (f) => f.file,
    includes: [OWNER],
    name: (f) => `${f.file}: поле packageManager и lockfile — только в теле packageManager github`,
    check: (f) => {
      const code = outsideAnswer(f);
      if (!touches(code)) return;
      const lines = code.split("\n").flatMap((l, i) => (touches(l) ? [`${f.file}:${i + 1}: ${l.trim()}`] : []));
      throw new Error(`поле packageManager или lockfile мимо packageManager github — возьми ответ у неё:\n${lines.join("\n") || f.file}`);
    },
    violator: [
      {
        name: "скрипт флоу читает packageManager мимо этой функции",
        item: source("bin/elves.ts", 'const yarnShell = (root: string, pkg: { packageManager?: unknown }) => /^yarn@(?!1\\.)\\d/.test(String(pkg.packageManager ?? ""));\n'),
      },
      {
        name: "скрипт флоу ищет lockfile мимо этой функции",
        item: source("bin/elves.ts", 'const bun = ["bun.lock", "bun.lockb"].some((f) => existsSync(path.join(root, f)));\n'),
      },
      {
        name: "вторая функция packageManager в другом скрипте",
        item: source("skills/x/scripts/x.ts", 'export function packageManager(dir: string) {\n  return existsSync(path.join(dir, "yarn.lock")) ? "yarn" : "npm";\n}\n'),
      },
    ],
  });
});
