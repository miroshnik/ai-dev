import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Зависимости скиллов: соседи, которых импортируют скрипты скилла. Список — ровно граф: импорт вне списка и зависимость
 * без импорта — красные; новый скилл — строка здесь, новое ребро — причина в skill-imports.md.
 */
const DEPENDS: Record<string, readonly string[]> = {
  "ci-wait": [],
  dashboard: ["est", "github", "task-env"],
  est: ["github"],
  github: [],
  slot: [],
  spec: ["github"],
  "task-env": [],
};

/** Скилл — каталог `skills/<name>` и файлы кода в нём. */
interface Skill {
  name: string;
  files: SourceFile[];
}

// import … from "x", export … from "x", import "x", import("x"), require("x"); `import type` — тоже ребро: без соседа
// скилл не проходит typecheck
const IMPORT =
  /^[ \t]*(?:import|export)\s+[\w$*\s{},]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gm;

/** Импорты чужих скиллов: скилл → места `файл:строка`; импорт мимо каталога скиллов — `outside`. Комментарии не в счёт. */
function importsOf(skill: Skill): { deps: Map<string, string[]>; outside: string[] } {
  const deps = new Map<string, string[]>();
  const outside: string[] = [];
  for (const f of skill.files) {
    // дешёвый отсев: без `../` в тексте импорта за пределы каталога нет — разбор комментариев не нужен
    if (!f.text.includes("../")) continue;
    const code = codeOnly(f.text, f.file);
    for (const m of code.matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
      if (!spec.startsWith(".")) continue;
      const at = `${f.file}:${code.slice(0, m.index).split("\n").length}`;
      const [top, name] = path.posix.normalize(path.posix.join(path.posix.dirname(f.file), spec)).split("/");
      if (top !== "skills" || !name) outside.push(`${at} — ${spec}`);
      else if (name !== skill.name) deps.set(name, [...(deps.get(name) ?? []), at]);
    }
  }
  return { deps, outside };
}

/** Скрипты скилла импортируют ровно его зависимости из списка; нарушения — с местом импорта. */
function check(skill: Skill): void {
  const allowed = DEPENDS[skill.name];
  if (!allowed) throw new Error(`скилла ${skill.name} нет в списке зависимостей (DEPENDS в skill-imports.test.ts) — добавь строку: от каких скиллов он зависит`);
  const { deps, outside } = importsOf(skill);
  const errors = outside.map((o) => `${o}: импорт вне каталога скиллов — у поставленного скилла этого файла нет`);
  for (const [dep, at] of deps) {
    if (allowed.includes(dep)) continue;
    const list = allowed.length ? allowed.join(", ") : "ни одного";
    errors.push(...at.map((a) => `${a}: импорт скилла ${dep}, а зависимости ${skill.name} — ${list}: без ${dep} ${skill.name} упадёт на загрузке`));
  }
  for (const dep of allowed) if (!deps.has(dep)) errors.push(`${skill.name}: в списке зависимость ${dep}, а импорта нет — убери её из DEPENDS`);
  if (errors.length) throw new Error(errors.join("\n"));
}

const code = (name: string) => `\`${name}\``;

/** Утверждение о скилле — его строка графа. */
function statement(skill: Skill): string {
  const deps = DEPENDS[skill.name];
  if (!deps) return `${code(skill.name)} есть в списке зависимостей скиллов`;
  if (!deps.length) return `${code(skill.name)} не импортирует другие скиллы`;
  return `${code(skill.name)} импортирует из других скиллов ${deps.map(code).join(", ")} — и только их`;
}

const SKILLS = readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e): Skill => ({ name: e.name, files: sources(ROOT, [`skills/${e.name}`]) }));

/** Скилл-нарушитель из текста, без файлов на диске. */
const fake = (name: string, ...files: [string, string][]): Skill => ({ name, files: files.map(([f, text]) => source(f, text)) });

describe("Скрипт скилла импортирует другой скилл только по списку зависимостей стандарта", () => {
  invariant(it, {
    registry: "скиллы",
    items: SKILLS,
    key: (s) => s.name,
    name: statement,
    check,
    violator: [
      { name: "`github` импортирует `est`", item: fake("github", ["skills/github/scripts/github.ts", 'import { sessionPin } from "../../est/scripts/est.ts";\n']) },
      { name: "в списке у `est` зависимость `github`, а импорта нет", item: fake("est", ["skills/est/scripts/est.ts", "export const x = 1;\n"]) },
      { name: "скрипт скилла импортирует файл вне каталога скиллов", item: fake("slot", ["skills/slot/scripts/slot.ts", 'import { run } from "../../../tests/lib/cli.ts";\n']) },
      { name: "скилла нет в списке зависимостей", item: fake("x", ["skills/x/scripts/x.ts", "export const x = 1;\n"]) },
    ],
    // реестр — каталоги skills/: скилл, у которого запрос потерял файлы, был бы «без импортов» молча
    includes: ["dashboard", "est", "github", "spec"],
  });

  describe("примеры", () => {
    const deps = (...files: [string, string][]) => [...importsOf(fake("github", ...files)).deps.keys()];

    it("`import type`, `export … from`, `import()` и `require()` чужого скилла — его импорт", () => {
      const at = "skills/github/scripts/a.ts";
      expect(deps([at, 'import type { Row } from "../../est/scripts/est.ts";\n'])).toEqual(["est"]);
      expect(deps([at, 'export { proxyPort } from "../../task-env/scripts/task-env.ts";\n'])).toEqual(["task-env"]);
      expect(deps([at, 'const m = await import("../../spec/scripts/speclib.ts");\n'])).toEqual(["spec"]);
      expect(deps([at, 'const k = require("../../spec/scripts/knip-hints.cjs");\n'])).toEqual(["spec"]);
      expect(deps([at, 'import {\n  a,\n  b,\n} from "../../est/scripts/est.ts";\n'])).toEqual(["est"]);
    });

    it("файл своего скилла, комментарий и путь к соседнему скрипту для запуска процессом — не импорт другого скилла", () => {
      const text = [
        'import locale from "./locale.ts";',
        'import { x } from "../scripts/x.ts";',
        '// import { sessionPin } from "../../est/scripts/est.ts";',
        'const estScript = path.resolve(import.meta.dir, "../../est/scripts/est.ts");',
        "",
      ].join("\n");
      expect(deps(["skills/github/scripts/github.ts", text])).toEqual([]);
    });

    it("место нарушения — файл и строка импорта", () => {
      const text = 'import a from "./a.ts";\n\nimport { b } from "../../est/scripts/est.ts";\n';
      expect(() => check(fake("github", ["skills/github/scripts/github.ts", text]))).toThrow("skills/github/scripts/github.ts:3: импорт скилла est");
    });
  });
});
