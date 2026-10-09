import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import localeModule from "../../../skills/github/scripts/locale.cjs";
import type { Names as LocaleNames } from "../../../skills/github/scripts/locale.cjs";
import en from "../../../skills/github/locales/en.json" with { type: "json" };
import { codeOnly, invariant, sources } from "../../../skills/spec/scripts/harness.ts";
import { tmpDir } from "../../lib/spec.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** Документ флоу: путь от корня и текст. */
interface Doc {
  file: string;
  text: string;
}

/** Документы флоу — то, что ставит install (AGENTS.md, claude/, docs/*.md, *.md скиллов), README и package.json: его описание показывают npm и npx. */
function flowDocs(): Doc[] {
  const docs = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(path.join(ROOT, "skills")).flatMap((s) => {
    const dir = path.join(ROOT, "skills", s);
    return existsSync(path.join(dir, "SKILL.md")) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `skills/${s}/${f}`) : [];
  });
  return ["AGENTS.md", "claude/CLAUDE.md", "README.md", "package.json", ...docs, ...skills].map((file) => ({ file, text: read(file) }));
}

/** Строки с кириллицей: «номер: строка». */
export function cyrillicLines(text: string): string[] {
  return text.split("\n").flatMap((line, i) => (CYRILLIC.test(line) ? [`${i + 1}: ${line.trim().slice(0, 100)}`] : []));
}

describe("Флоу написан по-английски: в его документах нет кириллицы", () => {
  invariant(it, {
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов",
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
    includes: ["AGENTS.md", "claude/CLAUDE.md", "README.md", "package.json", "docs/testing.md", "skills/spec/SKILL.md", "skills/github/reference.md"],
  });
});

/** Названия файла языка: ключ через точку → название; формы числа ({one, few, many, other}) — одно название. */
type Names = { [key: string]: string | Names };
const PLURAL = ["few", "many", "one", "other"];
const isPlural = (v: Names) => Object.keys(v).sort().join() === PLURAL.join();
function leaves(names: Names, prefix = "", plural = false): [string, string][] {
  return Object.entries(names).flatMap(([k, v]) =>
    typeof v === "string" ? [[prefix + k, v] as [string, string]] : plural && isPlural(v) ? [[prefix + k, v.other as string] as [string, string]] : leaves(v, `${prefix}${k}.`, plural),
  );
}

const LOCALES = "skills/github/locales";
const dictionary = (lang: string) => JSON.parse(read(`${LOCALES}/${lang}.json`)) as Names;
const locale = (lang: string) => leaves(dictionary(lang));
/** Код скриптов скиллов и установщика без комментариев: названия словаря они читают по пути ключа. */
const CODE = sources(ROOT, ["skills", "bin"]).map((f) => codeOnly(f.text, f.file)).join("\n");

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

  it("словарь en соответствует типам модуля locale (Names в locale.d.cts)", () => {
    // проверка — typecheck этого присваивания: ключ из Names, которого нет в en.json, — ошибка tsc
    const typed: LocaleNames = en;
    expect(Object.keys(typed)).toEqual(Object.keys(dictionary("en")));
  });

  /**
   * Скрипты не держат названия строкой в коде, а читают словарь — по полному пути ключа от объекта названий
   * (`N.status.backlog`, `n.spec.doc.title`; формы числа — путь до объекта). Ключ, которого не читает ни один скрипт, —
   * название, которое скрипты пишут мимо словаря, или мёртвый ключ.
   */
  invariant<[string, string]>(it, {
    registry: "названия словаря skills/github/locales/en.json",
    items: leaves(dictionary("en"), "", true),
    key: ([k]) => k,
    name: ([k]) => `название ${k} скрипты читают из словаря`,
    check: ([k]) => {
      const path = new RegExp(`(?<![\\w$])${k.replace(/\./g, "\\??\\.")}(?![\\w$])`);
      if (!path.test(CODE)) throw new Error(`${LOCALES}/en.json ${k}: ни один скрипт не читает это название по пути ключа — скрипт пишет его мимо словаря или ключ мёртвый (tests/standards/flow-english)`);
    },
    violator: { name: "название, которого скрипты не читают", item: ["status.archived", "Archived"] },
    outside: [
      { item: "standardIssue", reason: "соглашение агента: issue «Standard · …» заводит он сам, скрипты название не разбирают" },
      { item: "autoAnswer", reason: "пометку ответа в разделе вопросов ставит агент, скрипты её не читают" },
      { item: "comments.state", reason: "комментарий «State» перед паузой пишет агент, скрипты его не пишут и не разбирают" },
    ],
    includes: ["status.backlog", "sections.questions", "subagentPrompt.task", "lastLine.done"],
  });
});

/**
 * Язык проекта — `language` в `.agents/ai-dev.json`, без поля — `ru`, без манифеста — `en`: скрипты скиллов берут его
 * модулем `locale.cjs`, установщик — своей `languageOf` (npx запускает его из node_modules, где Node не стирает типы, и
 * модуль скилла он не импортирует). Правило в двух местах держат одинаковые константы.
 */
describe("Язык проекта у скриптов скиллов и у установщика — по одному правилу", () => {
  const BIN = read("bin/ai-dev.mjs");
  const constant = (name: string) => new RegExp(`const ${name} = (.+);`).exec(BIN)?.[1];

  it("код языка, язык по умолчанию и язык установки прошлой версии — те же, что у установщика", () => {
    expect({ code: constant("LANGUAGE_CODE"), byDefault: constant("DEFAULT_LANGUAGE"), legacy: constant("LEGACY_LANGUAGE") }).toEqual({
      code: String(localeModule.LANGUAGE_CODE),
      byDefault: JSON.stringify(localeModule.DEFAULT_LANGUAGE),
      legacy: JSON.stringify(localeModule.LEGACY_LANGUAGE),
    });
  });

  it("манифест с языком — его язык, без поля — ru, битый — ru, без манифеста — en", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const project = (name: string, manifest: string | null) => {
        const root = path.join(dir, name);
        mkdirSync(path.join(root, ".git"), { recursive: true });
        if (manifest !== null) {
          mkdirSync(path.join(root, ".agents"));
          writeFileSync(path.join(root, ".agents/ai-dev.json"), manifest);
        }
        mkdirSync(path.join(root, "src"));
        return path.join(root, "src");
      };
      expect([
        localeModule.projectLanguage(project("pt", '{ "language": "pt-BR" }')),
        localeModule.projectLanguage(project("legacy", '{ "auto": true }')),
        localeModule.projectLanguage(project("broken", "{")),
        localeModule.projectLanguage(project("none", null)),
      ]).toEqual(["pt-BR", "ru", "ru", "en"]);
    } finally {
      cleanup();
    }
  });
});
