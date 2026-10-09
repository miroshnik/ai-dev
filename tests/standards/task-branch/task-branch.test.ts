import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

type Parsed = { type: string; issue: number } | null;
type Parse = (branch: string) => Parsed;

/** Копия разбора: скилл и его `taskBranch`. */
interface Copy {
  skill: string;
  parse: Parse;
}

/** Скрипты скиллов, которые экспортируют `taskBranch`: новый разбор ветки попадает под таблицу сам. */
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
      if (!/^export function taskBranch\(/m.test(readFileSync(path.join(dir, f), "utf8"))) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      out.push({ skill, parse: mod.taskBranch });
    }
  }
  return out;
}

// типы канона (AGENTS.md, «Session and branch»): conventional commits плюс research
const TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"];

/** Таблица канона: ветка и ответ на «ветка задачи N?» — тип и номер или `null`. */
const TABLE: { branch: string; want: Parsed; why: string }[] = [
  ...TYPES.map((type) => ({ branch: `${type}/42-invoice-export`, want: { type, issue: 42 }, why: "тип из списка канона" })),
  { branch: "backend/fix/263-login-loop", want: { type: "fix", issue: 263 }, why: "префикс области — один сегмент" },
  { branch: "web.v2/feat/7-x", want: { type: "feat", issue: 7 }, why: "префикс области с точкой и цифрой" },
  { branch: "fix/128-api-409-on-retry", want: { type: "fix", issue: 128 }, why: "число в слаге — не номер" },
  { branch: "feat/420-x", want: { type: "feat", issue: 420 }, why: "номер целиком, не его начало" },
  { branch: "Fix/12-x", want: { type: "fix", issue: 12 }, why: "регистр типа не важен" },
  { branch: "FEAT/12-x", want: { type: "feat", issue: 12 }, why: "регистр типа не важен" },
  { branch: "wip/7-x", want: null, why: "тип не из списка канона" },
  { branch: "style/7-x", want: null, why: "тип conventional commits вне списка канона" },
  { branch: "a/b/fix/12-x", want: null, why: "префикс области глубже одного сегмента" },
  { branch: "fix/12", want: null, why: "без слага" },
  { branch: "fix/x-12", want: null, why: "номер не сразу за типом" },
  { branch: "fix-12-x", want: null, why: "тип и номер не через слеш" },
  { branch: "issue-12-x", want: null, why: "эвристика вне канона" },
  { branch: "claude/interesting-kilby-df89ea", want: null, why: "ветка worktree до переименования" },
  { branch: "release/2026-09", want: null, why: "дата, а не номер задачи" },
];

const show = (p: Parsed) => (p ? `${p.type} #${p.issue}` : "не ветка задачи");

/** Строки таблицы, на которые копия отвечает не по канону. */
function mismatches(parse: Parse): string[] {
  return TABLE.filter((row) => show(parse(row.branch)) !== show(row.want)).map(
    (row) => `${row.branch}: ${show(parse(row.branch))}, а по канону — ${show(row.want)} (${row.why})`,
  );
}

// разбор github до стандарта: тип — любое слово, регистр важен, префикс любой глубины
const before: Parse = (branch) => {
  const m = /(?:^|\/)([a-z]+)\/(\d+)-/.exec(branch);
  return m ? { type: m[1]!, issue: Number(m[2]) } : null;
};

const registry = await copies();

describe("Ветка задачи разбирается одинаково во всех скиллах", () => {
  invariant(it, {
    registry: "скрипты скиллов с разбором ветки задачи",
    items: registry,
    key: (c) => c.skill,
    includes: ["est", "github"],
    name: (c) => `${c.skill} разбирает ветку задачи по таблице канона`,
    check: (c) => {
      const wrong = mismatches(c.parse);
      if (wrong.length) throw new Error(`${c.skill}: разбор ветки расходится с каноном:\n${wrong.join("\n")}`);
    },
    violator: { name: "разбор до стандарта: тип — любое слово, регистр важен, префикс любой глубины", item: { skill: "до #252", parse: before } },
  });

  it("таблица ловит расхождения разбора до стандарта: регистр, тип вне списка, глубокий префикс, дата", () => {
    expect(mismatches(before).map((m) => m.split(":")[0])).toEqual(["Fix/12-x", "FEAT/12-x", "wip/7-x", "style/7-x", "a/b/fix/12-x", "release/2026-09"]);
  });
});
