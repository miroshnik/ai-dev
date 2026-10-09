import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** Документ флоу: путь от корня и текст. */
interface Doc {
  file: string;
  text: string;
}

/** Документы флоу — то, что ставит install (AGENTS.md, claude/, docs/*.md, *.md скиллов), и README. */
function flowDocs(): Doc[] {
  const docs = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(path.join(ROOT, "skills")).flatMap((s) => {
    const dir = path.join(ROOT, "skills", s);
    return existsSync(path.join(dir, "SKILL.md")) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `skills/${s}/${f}`) : [];
  });
  return ["AGENTS.md", "claude/CLAUDE.md", "README.md", ...docs, ...skills].map((file) => ({ file, text: read(file) }));
}

/** Строки с кириллицей: «номер: строка». */
export function cyrillicLines(text: string): string[] {
  return text.split("\n").flatMap((line, i) => (CYRILLIC.test(line) ? [`${i + 1}: ${line.trim().slice(0, 100)}`] : []));
}

describe("Флоу написан по-английски: в его документах нет кириллицы", () => {
  invariant(it, {
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, docs/*.md, *.md скиллов",
    items: flowDocs(),
    key: (d) => d.file,
    name: (d) => `в ${d.file} нет кириллицы`,
    check: (d) => {
      const lines = cyrillicLines(d.text);
      if (lines.length) {
        throw new Error(`${d.file}: кириллица — флоу пишется по-английски, названия на языке проекта — в skills/github/locales (tests/standards/flow-english):\n${lines.join("\n")}`);
      }
    },
    violator: { name: "справочник с русской цитатой вывода скрипта", item: { file: "docs/x.md", text: "# Rule\n\nThe script prints «○ актуализация не нужна».\n" } },
    includes: ["AGENTS.md", "claude/CLAUDE.md", "README.md", "docs/testing.md", "skills/spec/SKILL.md", "skills/github/reference.md"],
  });
});

/** Названия файла языка: ключ через точку → название. */
type Names = { [key: string]: string | Names };
function leaves(names: Names, prefix = ""): [string, string][] {
  return Object.entries(names).flatMap(([k, v]) => (typeof v === "string" ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
}

const LOCALES = "skills/github/locales";
const locale = (lang: string) => leaves(JSON.parse(read(`${LOCALES}/${lang}.json`)) as Names);
/** Исходники скриптов скиллов: русские названия скрипты пока держат в коде (#366). */
const SOURCES = readdirSync(path.join(ROOT, "skills"))
  .flatMap((s) => {
    const dir = path.join(ROOT, "skills", s, "scripts");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => read(`skills/${s}/scripts/${f}`)) : [];
  })
  .join("\n");

describe("Названия, которые пишут и разбирают скрипты, — в locales скилла github, у каждого языка одни ключи", () => {
  it("у каждого языка те же ключи, что у en, и ни одного пустого названия", () => {
    const keys = locale("en").map(([k]) => k);
    expect(keys.length).toBeGreaterThan(0);
    for (const lang of readdirSync(path.join(ROOT, LOCALES)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))) {
      const names = locale(lang);
      expect({ lang, keys: names.map(([k]) => k) }).toEqual({ lang, keys });
      expect(names.filter(([, v]) => !v.trim())).toEqual([]);
    }
  });

  it("в en.json нет кириллицы", () => {
    expect(cyrillicLines(read(`${LOCALES}/en.json`))).toEqual([]);
  });

  invariant<[string, string]>(it, {
    registry: "русские названия skills/github/locales/ru.json",
    items: locale("ru"),
    key: ([k]) => k,
    name: ([k]) => `название ${k} из ru.json есть в скриптах скиллов`,
    check: ([k, v]) => {
      if (!SOURCES.includes(v)) throw new Error(`${LOCALES}/ru.json ${k}: «${v}» нет в скриптах скиллов — название разошлось с тем, что они пишут и разбирают (tests/standards/flow-english)`);
    },
    violator: { name: "название, которого скрипты не пишут", item: ["status.done", "Сделано"] },
    outside: [
      { item: "standardIssue", reason: "соглашение агента: issue «Стандарт · …» заводит он сам, скрипты название не разбирают" },
      { item: "autoAnswer", reason: "пометку ответа в разделе вопросов ставит агент, скрипты её не читают" },
    ],
    includes: ["status.backlog", "sections.questions", "subagentPrompt.task", "lastLine.done"],
  });
});
