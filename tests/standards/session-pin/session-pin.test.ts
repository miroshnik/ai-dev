import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

import { pinLine } from "../../../skills/github/scripts/github.ts";
import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = path.join(ROOT, "skills");

type Pin = { slug: string; number: number } | null;
type Parse = (text: string) => Pin;

/** Копия разбора: скилл и его `sessionPin`. */
interface Copy {
  skill: string;
  parse: Parse;
}

/** Скрипты скиллов, которые экспортируют `sessionPin`: новый разбор закрепления попадает под таблицу сам. */
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
      if (!/^export function sessionPin\(/m.test(readFileSync(path.join(dir, f), "utf8"))) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      out.push({ skill, parse: mod.sessionPin });
    }
  }
  return out;
}

const task = (slug: string, number: number): Pin => ({ slug, number });

/** Таблица канона: текст файла закрепления и ответ на «за какой задачей сессия?» — задача или `null`. */
const TABLE: { text: string; want: Pin; why: string }[] = [
  { text: "o/r#42", want: task("o/r", 42), why: "задача owner/repo#N" },
  { text: "o/r#42\n", want: task("o/r", 42), why: "перевод строки в конце файла" },
  { text: "  o/r#42 \n", want: task("o/r", 42), why: "пробелы по краям" },
  { text: "Owner/My.Repo_x-1#7", want: task("Owner/My.Repo_x-1", 7), why: "репозиторий как записан: регистр, точка, подчёркивание, дефис" },
  { text: "o/r#420", want: task("o/r", 420), why: "номер целиком, не его начало" },
  { text: "", want: null, why: "пустой файл" },
  { text: "49\n", want: null, why: "номер без репозитория" },
  { text: "#49", want: null, why: "номер без репозитория" },
  { text: "r#49", want: null, why: "репозиторий без владельца" },
  { text: "o/r", want: null, why: "репозиторий без номера" },
  { text: "o/r#", want: null, why: "репозиторий без номера" },
  { text: "o/r/x#49", want: null, why: "лишний сегмент пути" },
  { text: "o/r#49x", want: null, why: "хвост за номером" },
  { text: "o/r #49", want: null, why: "пробел внутри" },
  { text: "o/r#49\no/r#50\n", want: null, why: "две строки — не одна задача" },
  { text: "https://github.com/o/r/issues/49", want: null, why: "ссылка на задачу" },
  { text: "*\n", want: null, why: ".gitignore каталога" },
];

const show = (p: Pin) => (p ? `${p.slug}#${p.number}` : "не закрепление");

/** Строки таблицы, на которые копия отвечает не по канону. */
function mismatches(parse: Parse): string[] {
  return TABLE.filter((row) => show(parse(row.text)) !== show(row.want)).map(
    (row) => `${JSON.stringify(row.text)}: ${show(parse(row.text))}, а по канону — ${show(row.want)} (${row.why})`,
  );
}

// разбор без якорей: задача — первое owner/repo#N в строке, хвост и лишнее вокруг не мешают
const unanchored: Parse = (text) => {
  const m = /([\w.-]+\/[\w.-]+)#(\d+)/.exec(text);
  return m ? task(m[1]!, Number(m[2])) : null;
};

// каталог закреплений в коде: сегмент "sessions" сразу под каталогом — path.join(<каталог>, "sessions", …) — или PINS_DIR est
const PINS_DIR = /path\.join\(\s*[\w$.]+(?:\([^()]*\))?\s*,\s*["'`]sessions["'`]|\bPINS_DIR\b/;
const readsPins = (f: SourceFile): boolean => PINS_DIR.test(codeOnly(f.text, f.file));

const registry = await copies();

describe("Закрепление разбирается одинаково в github, est и dashboard: owner/repo#N — задача, другое — не закрепление", () => {
  invariant(it, {
    registry: "скрипты скиллов с разбором закрепления",
    items: registry,
    key: (c) => c.skill,
    includes: ["est", "github"],
    name: (c) => `${c.skill}: owner/repo#N — задача, другое — не закрепление`,
    check: (c) => {
      const wrong = mismatches(c.parse);
      if (wrong.length) throw new Error(`${c.skill}: разбор закрепления расходится с каноном:\n${wrong.join("\n")}`);
    },
    violator: { name: "разбор без якорей: задача — первое owner/repo#N в строке", item: { skill: "без якорей", parse: unanchored } },
  });

  it("строку, которую пишет github task status, каждая копия разбирает как ту же задачу", () => {
    expect(registry.map((c) => `${c.skill}: ${show(c.parse(pinLine("Owner/My.Repo", 463)))}`)).toEqual(registry.map((c) => `${c.skill}: Owner/My.Repo#463`));
  });

  it("таблица ловит расхождения разбора без якорей: лишний сегмент пути, хвост за номером, вторая строка", () => {
    expect(mismatches(unanchored).map((m) => m.split(":")[0])).toEqual(['"o/r/x#49"', '"o/r#49x"', '"o/r#49\\no/r#50\\n"']);
  });
});

describe("Скрипт, читающий каталог sessions/, разбирает закрепление через sessionPin", () => {
  invariant(it, {
    registry: "скрипты скиллов, которые читают каталог закреплений sessions/",
    items: sources(ROOT, ["skills"]).filter(readsPins),
    key: (f) => f.file,
    includes: ["skills/est/scripts/est.ts", "skills/github/scripts/github.ts"],
    name: (f) => `${f.file} разбирает закрепление через sessionPin`,
    check: (f) => {
      if (!/\bsessionPin\(/.test(codeOnly(f.text, f.file))) throw new Error(`${f.file} читает каталог закреплений sessions/ без sessionPin`);
    },
    violator: [
      { name: "скрипт берёт строку файла закрепления как есть", item: source("skills/x/scripts/x.ts", 'const task = readFileSync(path.join(EST_DIR, "sessions", id), "utf8").trim();\n') },
      { name: "скрипт обходит PINS_DIR est своим разбором", item: source("skills/x/scripts/x.ts", "for (const id of readdirSync(PINS_DIR)) out.push(read(id).split(\"#\"));\n") },
    ],
  });
});
