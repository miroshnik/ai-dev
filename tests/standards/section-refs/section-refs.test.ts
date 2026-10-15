import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant, sources } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ссылка на раздел документа флоу по названию: где стоит, на какой файл и какое название. */
export interface Ref {
  file: string;
  line: number;
  target: string;
  name: string;
}

/** Файл, в котором ищут ссылки: путь от корня и текст. */
interface Source {
  file: string;
  text: string;
}

const SKILLS = readdirSync(path.join(ROOT, "skills")).filter((n) => existsSync(path.join(ROOT, "skills", n, "SKILL.md")));

/** Документы флоу — то, что ставит install (AGENTS.md, claude/, docs/*.md, *.md скиллов), и README. */
function flowDocs(): string[] {
  const docs = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = SKILLS.flatMap((s) => readdirSync(path.join(ROOT, "skills", s)).filter((f) => f.endsWith(".md")).map((f) => `skills/${s}/${f}`));
  return ["AGENTS.md", "claude/CLAUDE.md", "README.md", ...docs, ...skills];
}

/** Описания решений спеки — `tests/<вид>/<имя>/<имя>.md`: они тоже ссылаются на разделы AGENTS.md. */
const decisionDocs = (): string[] =>
  readdirSync(path.join(ROOT, "tests"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((kind) => readdirSync(path.join(ROOT, "tests", kind.name)).map((name) => `tests/${kind.name}/${name}/${name}.md`))
    .filter((file) => existsSync(path.join(ROOT, file)));

/** Где ищут ссылки: документы флоу, решения спеки и код — установщик и скрипты скиллов (комментарии, JSDoc, строки вывода). */
const sourcesOfRefs = (): Source[] => [
  ...[...flowDocs(), ...decisionDocs()].map((file) => ({ file, text: read(file) })),
  ...sources(ROOT, ["bin", "skills"]).filter((f) => !f.file.includes("/vendor/")),
];

const QUOTE = `[«"“]([^«»"”]{2,100}?)[»"”]`;
const FILE = "(?<![\\w./-])`?((?:[\\w.-]+/)*[\\w.-]+\\.md|README)`?(?![\\w.])";
const NAMES = SKILLS.map(escape).join("|");
const SKILL = `(?:\\s+(?:of\\s+the\\s+)?(${NAMES})(?:\\s+skill)?)?`;
const AFTER = `(?:,\\s+|\\s+\\()(?:section\\s+)?${QUOTE}`;
/**
 * Формы ссылки: `ФАЙЛ[ скилл], "Раздел"`, `ФАЙЛ (section "Раздел")`, `the "Раздел" section of|in ФАЙЛ`,
 * ``the `скилл` skill, section "Раздел"`` — его SKILL.md; в документе без файла — `section "Раздел"` и
 * `the "Раздел" section`: раздел того же документа, только в прямых кавычках — в «…» документы цитируют вывод скриптов
 * и разделы сгенерированной спеки.
 */
const FORMS = new RegExp(
  [
    `(?:the\\s+)?${QUOTE}\\s+section\\s+(?:of|in)\\s+${FILE}`,
    `${FILE}${SKILL}${AFTER}`,
    `\`(${NAMES})\`\\s+skill${AFTER}`,
    `\\bsection\\s+"([^"]{2,100}?)"`,
    `"([^"]{2,100}?)"\\s+section\\b`,
  ].join("|"),
  "g",
);

/** Перенос строки с отступом и маркером комментария (`//`, `*` JSDoc) — пробелы той же длины: ссылка переносится. */
const flatten = (text: string) => text.replace(/\n[ \t]*(?:\/\/|\*(?!\/))?/g, (m) => " ".repeat(m.length));

/**
 * Код в строке документа с кавычкой внутри (`` `ФАЙЛ, "Раздел"` ``) — пример формы, не ссылка: пробелы той же длины.
 * Имя файла в коде (`` `AGENTS.md`, "…" ``) остаётся. В коде скриптов обратные кавычки — шаблонные строки вывода.
 */
const examplesOut = (md: string) => md.replace(/(`+)(?!`)([^\n]*?[^`])\1(?!`)/g, (m, _, body: string) => (/[«"“]/.test(body) ? m.replace(/[^\n]/g, " ") : m));

/** Файл, на который ведёт ссылка: `SKILL.md`/`reference.md` без имени скилла — того же скилла, что и ссылка. */
export function resolve(from: string, file: string, skill: string | undefined): string {
  if (file === "README") return "README.md";
  if (file === "CLAUDE.md") return "claude/CLAUDE.md";
  if (file.includes("/")) return file.replace(/^\.agents\/(?:elves\/)?/, "");
  if (skill) return `skills/${skill}/${file}`;
  const own = /^(skills\/[^/]+)\//.exec(from)?.[1] ?? (from.startsWith("docs/") ? "docs" : null);
  if (own && existsSync(path.join(ROOT, own, file))) return `${own}/${file}`;
  return file;
}

/** Ссылки текста на разделы по названию; в коде — без ссылок «на себя»: заголовков у него нет. */
export function refsIn(src: Source): Ref[] {
  const doc = src.file.endsWith(".md");
  const out: Ref[] = [];
  for (const m of flatten(doc ? examplesOut(src.text) : src.text).matchAll(FORMS)) {
    const [, rName, rFile, fFile, fSkill, fName, kSkill, kName, sName1, sName2] = m;
    const own = sName1 ?? sName2;
    if (own !== undefined && !doc) continue;
    const name = (rName ?? fName ?? kName ?? own)!.replace(/\s+/g, " ").trim();
    const target = own !== undefined ? src.file : kSkill ? `skills/${kSkill}/SKILL.md` : resolve(src.file, (rFile ?? fFile)!, fSkill);
    out.push({ file: src.file, line: src.text.slice(0, m.index).split("\n").length, target, name });
  }
  return out;
}

/**
 * Разделы документа вне блоков кода: заголовки `#` и жирное начало пункта списка (`- **A decision is the unit….**`) —
 * так разбит `canon.md` спеки.
 */
export function headings(md: string): string[] {
  let fenced = false;
  const out: string[] = [];
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? /^\s*[-*]\s+\*\*(.+?)\*\*/.exec(line)?.[1];
      if (h) out.push(h);
    }
  }
  return out;
}

/**
 * Заголовок — это название, за ним конец или знак препинания: «Task tracking» → `## Task tracking — structure`, но
 * «Task» — не `## Task tracking`.
 */
export const titles = (heading: string, name: string): boolean => heading.startsWith(name) && /^(?:\s*[—–:(,.;]|$)/.test(heading.slice(name.length));

/** Битая ссылка — текст ошибки, целая — null. `file` — текст файла флоу или null, если его нет. */
export function broken(ref: Ref, file: (rel: string) => string | null): string | null {
  const text = file(ref.target);
  if (text === null) return `${ref.file}:${ref.line}: «${ref.name}» — нет файла ${ref.target}`;
  if (headings(text).some((h) => titles(h, ref.name))) return null;
  return `${ref.file}:${ref.line}: в ${ref.target} нет раздела «${ref.name}» — раздел переименован? поправь ссылку (tests/standards/section-refs)`;
}

const repoFile = (rel: string) => (existsSync(path.join(ROOT, rel)) ? read(rel) : null);
const keyOf = (r: Ref) => `${r.file} → ${r.target}, «${r.name}»`;
const unique = (refs: Ref[]) => [...new Map(refs.map((r) => [keyOf(r), r])).values()];

describe("Ссылка на раздел документа флоу по названию ведёт на существующий заголовок", () => {
  invariant(it, {
    registry: "ссылки «файл + название раздела» в документах флоу и решений спеки, установщике и скриптах скиллов",
    items: unique(sourcesOfRefs().flatMap(refsIn)),
    key: keyOf,
    name: (r) => `${r.file}: ${r.target}, «${r.name}» — есть такой раздел`,
    check: (r) => {
      const err = broken(r, repoFile);
      if (err) throw new Error(err);
    },
    violator: { name: "ссылка на переименованный раздел AGENTS.md", item: { file: "bin/elves.ts", line: 1, target: "AGENTS.md", name: "First step of the session" } },
    includes: [
      "bin/elves.ts → AGENTS.md, «First step of a session»",
      "claude/CLAUDE.md → AGENTS.md, «First step of a session»",
      "skills/est/scripts/est.ts → skills/est/SKILL.md, «Cloud session»",
      "skills/github/scripts/github.ts → skills/github/SKILL.md, «Git, PRs and merging — mechanics»",
      "skills/github/reference.md → AGENTS.md, «Estimate and actual — the `est` skill»",
      "docs/ci-concurrency.md → AGENTS.md, «CI: parallel tasks»",
      "skills/spec/SKILL.md → skills/spec/SKILL.md, «Checks»",
    ],
  });

  describe("примеры", () => {
    const files: Record<string, string> = {
      "AGENTS.md": "# Rules\n\n## First step of a session — an up-to-date flow\n\n## Task tracking\n\n```\n## Not a heading\n```\n",
      "skills/est/SKILL.md": "# est\n\n## Cloud session\n",
      "skills/github/SKILL.md": "# github\n\n## Git, PRs and merging — mechanics\n",
    };
    const file = (rel: string) => files[rel] ?? null;
    const check = (src: Source) => refsIn(src).map((r) => broken(r, file));

    it("ссылка скрипта на раздел AGENTS.md по названию ведёт на существующий заголовок", () => {
      const src = { file: "bin/elves.ts", text: 'note("Elves flow (AGENTS.md, «First step of a session»):");\n' };
      expect(refsIn(src)).toEqual([{ file: "bin/elves.ts", line: 1, target: "AGENTS.md", name: "First step of a session" }]);
      expect(check(src)).toEqual([null]);
    });

    it("ссылка на переименованный раздел роняет проверку", () => {
      const src = { file: "skills/dashboard/scripts/sessions.ts", text: '// the canon (AGENTS.md, "Epic refresh on task close")\n' };
      expect(check(src)).toEqual(["skills/dashboard/scripts/sessions.ts:1: в AGENTS.md нет раздела «Epic refresh on task close» — раздел переименован? поправь ссылку (tests/standards/section-refs)"]);
    });

    it("ссылка на SKILL.md без имени скилла ищет раздел в SKILL.md того же скилла", () => {
      expect(refsIn({ file: "skills/est/scripts/est.ts", text: "console.log(`… est cloud-import (SKILL.md, «Cloud session»)`);" })).toEqual([
        { file: "skills/est/scripts/est.ts", line: 1, target: "skills/est/SKILL.md", name: "Cloud session" },
      ]);
      expect(refsIn({ file: "bin/elves.ts", text: "// see SKILL.md est, «Cloud session»" })[0]?.target).toBe("skills/est/SKILL.md");
      expect(check({ file: "skills/github/scripts/github.ts", text: '// (SKILL.md, "Cloud session")' })[0]).toContain("в skills/github/SKILL.md нет раздела «Cloud session»");
    });

    it("формы ссылки: файл и раздел через запятую, «section» в скобках, раздел перед файлом; перенос строки комментария — не помеха", () => {
      const text = [
        "Principles — `AGENTS.md`, section \"Task tracking\"; mechanics — `AGENTS.md`",
        '  (section "First step of a session"); the "Task tracking" section of `AGENTS.md`.',
        " * the canon (AGENTS.md, \"First step of a",
        ' * session").',
      ].join("\n");
      expect(refsIn({ file: "docs/x.md", text }).map((r) => [r.line, r.target, r.name])).toEqual([
        [1, "AGENTS.md", "Task tracking"],
        [1, "AGENTS.md", "First step of a session"],
        [2, "AGENTS.md", "Task tracking"],
        [3, "AGENTS.md", "First step of a session"],
      ]);
    });

    it("раздел того же документа — `section \"…\"` в документе; в коде и в «…» — не ссылка", () => {
      const md = 'The rule — section "Cloud session" below; the generated «Outside the tree» section.\n';
      expect(refsIn({ file: "skills/est/SKILL.md", text: md })).toEqual([{ file: "skills/est/SKILL.md", line: 1, target: "skills/est/SKILL.md", name: "Cloud session" }]);
      expect(refsIn({ file: "skills/est/scripts/est.ts", text: md })).toEqual([]);
    });

    it("пример формы в `…` документа — не ссылка; имя файла в `…` перед названием — ссылка", () => {
      const md = 'Forms: `ФАЙЛ, "Раздел"`, ``the `github` skill, section "Раздел"``; see `AGENTS.md`, "Task tracking".\n';
      expect(refsIn({ file: "docs/x.md", text: md }).map((r) => [r.target, r.name])).toEqual([["AGENTS.md", "Task tracking"]]);
    });

    it("строки путей в коде и заголовок в блоке кода — не ссылка и не раздел", () => {
      expect(refsIn({ file: "bin/elves.ts", text: 'const FLOW = ["AGENTS.md", "claude/CLAUDE.md", ":(glob)docs/*.md"];' })).toEqual([]);
      expect(check({ file: "docs/x.md", text: '`AGENTS.md`, "Not a heading"' })[0]).toContain("нет раздела «Not a heading»");
    });

    it("заголовок — название, за ним конец или знак препинания: «Task» не находит `## Task tracking`", () => {
      expect(titles("Task tracking — structure", "Task tracking")).toBe(true);
      expect(titles("Estimate and actual — the `est` skill", "Estimate and actual — the `est` skill")).toBe(true);
      expect(titles("Task tracking", "Task")).toBe(false);
      expect(titles("Tasks", "Task")).toBe(false);
    });

    it("раздел — и жирное начало пункта списка; ссылка на скилл по имени ведёт в его SKILL.md", () => {
      expect(headings("# Canon\n\n- **A decision is the unit of the spec.** One anatomy\n- plain item\n")).toEqual(["Canon", "A decision is the unit of the spec."]);
      expect(refsIn({ file: "docs/pr-checks.md", text: 'Rebase — the `github` skill,\nsection "Git, PRs and merging — mechanics".' })).toEqual([
        { file: "docs/pr-checks.md", line: 1, target: "skills/github/SKILL.md", name: "Git, PRs and merging — mechanics" },
      ]);
    });
  });
});
