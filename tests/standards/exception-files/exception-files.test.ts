import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

import { decisionsOfFiles } from "../../../skills/github/scripts/github.ts";
import { invariant } from "../../../skills/spec/scripts/harness.ts";

const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

type Answer = { folder: string; dir: string; legacy: boolean; error?: string } | null;
type Recognize = (p: string) => Answer;

/** Скрипт со знанием файлов исключений: код без комментариев и, у копии правила, её `exceptionFile`. */
interface Script {
  key: string;
  code: string;
  answer?: Recognize;
}

// своё знание путей исключений в коде: регулярка про exceptions, имя прежнего файла, путь …/exceptions; голое
// "exceptions" — не оно: так же называются поле и переменная
const OWN = /exceptions\\[./]|(["'`])(?:names\.)?exceptions\.(?:[cm]?[jt]s|json)\1|\/(?:names\.)?exceptions["'`/]|(["'`])names\.exceptions\2/g;
const COPY = /^export function exceptionFile\(/m;
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Скрипты скиллов, которые определяют `exceptionFile`, зовут его или сами знают пути исключений. */
async function scripts(): Promise<Script[]> {
  const out: Script[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const source = readFileSync(path.join(dir, f), "utf8");
      const code = transpiler.transformSync(source);
      if (!/\bexceptionFile\b/.test(code) && !code.match(OWN)) continue;
      const key = `${skill}/${f.replace(/\.ts$/, "")}`;
      out.push(COPY.test(source) ? { key, code, answer: (await import(pathToFileURL(path.join(dir, f)).href)).exceptionFile } : { key, code });
    }
  }
  return out;
}

const A = "tests/standards/audit";
const at = (folder: string, dir: string, legacy = false, error = false) => ({ folder, dir, legacy, ...(error ? { error: "…" } : {}) });

/** Таблица путей: файл и ответ на «файл исключений какой папки решения?». */
const TABLE: { path: string; want: Answer; why: string }[] = [
  { path: `${A}/exceptions/importLegacy.json`, want: at(A, "exceptions"), why: "исключение — файл в exceptions/ папки" },
  { path: "tests/capabilities/billing/names.exceptions/returns-201.json", want: at("tests/capabilities/billing", "names.exceptions"), why: "исключение названия" },
  { path: "tests/architecture/boundaries/exceptions/src-db.json", want: at("tests/architecture/boundaries", "exceptions"), why: "правило архитектуры — тоже папка решения" },
  { path: `${A}/exceptions/a.txt`, want: at(A, "exceptions", false, true), why: "не JSON" },
  { path: `${A}/exceptions/importLegacy.ts`, want: at(A, "exceptions", false, true), why: "модуль вместо JSON" },
  { path: `${A}/exceptions/old/a.json`, want: at(A, "exceptions", false, true), why: "вложенный каталог" },
  { path: `${A}/names.exceptions/writes-row.ts`, want: at(A, "names.exceptions", false, true), why: "исключение названия не JSON" },
  { path: `${A}/sub/exceptions/a.json`, want: at(A, "exceptions", false, true), why: "каталог в подпапке — не читается" },
  { path: `${A}/sub/names.exceptions/a.json`, want: at(A, "names.exceptions", false, true), why: "каталог названий в подпапке" },
  ...["ts", "mts", "js", "mjs", "json"].map((ext) => ({ path: `${A}/exceptions.${ext}`, want: at(A, "exceptions", true), why: "прежний файл, любое расширение" })),
  { path: `${A}/names.exceptions.ts`, want: at(A, "names.exceptions", true), why: "прежний файл названий" },
  { path: `${A}/names.exceptions.json`, want: at(A, "names.exceptions", true), why: "прежний файл названий" },
  { path: `${A}/sub/exceptions.ts`, want: at(A, "exceptions", true), why: "прежний файл подпапки — исключения папки решения" },
  { path: "tests/capabilities/exceptions/exceptions.ts", want: at("tests/capabilities/exceptions", "exceptions", true), why: "решение с именем exceptions" },
  { path: "tests/capabilities/exceptions/a.json", want: null, why: "файл решения с именем exceptions" },
  { path: `${A}/exceptions/.gitkeep`, want: null, why: "скрытый файл" },
  { path: `${A}/audit.test.ts`, want: null, why: "тест папки" },
  { path: `${A}/exceptions.test.ts`, want: null, why: "тест про исключения — не прежний файл" },
  { path: "tests/lib/exceptions/a.json", want: null, why: "вне папок решений" },
  { path: "tests/lib/exceptions.ts", want: null, why: "вне папок решений" },
  { path: "tests/standards/exceptions.ts", want: null, why: "файл прямо в каталоге вида" },
  { path: "src/exceptions/not-found.ts", want: null, why: "код проекта" },
];

const show = (a: Answer) => (a ? `${a.folder}/${a.dir}/${a.legacy ? " прежний" : ""}${a.error ? " ошибка" : ""}` : "не исключения");
const readable = (a: Answer) => !!a && !a.error;

/** Строки таблицы, на которые копия отвечает не по правилу. */
function mismatches(answer: Recognize): string[] {
  return TABLE.filter((row) => show(answer(row.path)) !== show(row.want)).map((row) => `${row.path}: ${show(answer(row.path))}, а по правилу — ${show(row.want)} (${row.why})`);
}

// pr labels до стандарта: прежний файл — только exceptions.ts, каталог — любой файл на глубине папки
const before: Recognize = (p) => {
  const parts = p.split("/");
  if (parts[0] !== "tests") return null;
  const folder = parts.slice(0, 3).join("/");
  if (parts.length === 4 && parts[3] === "exceptions.ts") return at(folder, "exceptions", true);
  if (parts.length === 5 && (parts[3] === "exceptions" || parts[3] === "names.exceptions")) return at(folder, parts[3]);
  return null;
};

const registry = await scripts();

describe("Файл исключений папки решения распознаётся одинаково в spec и github", () => {
  invariant(it, {
    registry: "скрипты, распознающие файлы исключений",
    items: registry,
    key: (s) => s.key,
    includes: ["github/github", "spec/harness", "spec/spec-diff", "spec/spec-doc", "spec/spec-exceptions", "spec/speclib"],
    name: (s) => (s.answer ? `${s.key} распознаёт файл исключений по таблице путей` : `${s.key} распознаёт файл исключений правилом exceptionFile, без своего`),
    check: (s) => {
      if (s.answer) {
        const wrong = mismatches(s.answer);
        if (wrong.length) throw new Error(`${s.key}: exceptionFile расходится с таблицей:\n${wrong.join("\n")}`);
        return;
      }
      const own = s.code.match(OWN);
      if (own) throw new Error(`${s.key}: своё правило путей исключений (${[...new Set(own)].join(", ")}) — бери exceptionFile скилла`);
    },
    violator: [
      { name: "pr labels до стандарта: прежний файл — только exceptions.ts", item: { key: "github до #264", code: "", answer: before } },
      {
        name: "spec-diff до стандарта: своя регулярка exceptions/",
        item: { key: "spec-diff до #264", code: "const EXCEPTION_FILE = /(^|\\/)(names\\.)?exceptions\\/[^/]+\\.json$/;\nL.exceptionFile;" },
      },
    ],
  });

  it("pr labels: механическая правка — файл, который spec читает исключением", () => {
    const rows = TABLE.filter((row) => row.want);
    const wrong = rows.filter((row) => {
      const { mechanical } = decisionsOfFiles([{ path: row.path, changeType: "MODIFIED", additions: 1, deletions: 1 }], {});
      return mechanical.length > 0 !== readable(row.want);
    });
    expect(wrong.map((row) => `${row.path} (${row.why})`)).toEqual([]);
  });

  it("таблица ловит расхождения pr labels до стандарта: не JSON, прежний файл не .ts, подпапка, скрытый файл", () => {
    expect(mismatches(before).map((m) => m.split(":")[0])).toEqual([
      `${A}/exceptions/a.txt`,
      `${A}/exceptions/importLegacy.ts`,
      `${A}/exceptions/old/a.json`,
      `${A}/names.exceptions/writes-row.ts`,
      `${A}/sub/exceptions/a.json`,
      `${A}/sub/names.exceptions/a.json`,
      `${A}/exceptions.mts`,
      `${A}/exceptions.js`,
      `${A}/exceptions.mjs`,
      `${A}/exceptions.json`,
      `${A}/names.exceptions.ts`,
      `${A}/names.exceptions.json`,
      `${A}/sub/exceptions.ts`,
      `${A}/exceptions/.gitkeep`,
    ]);
  });
});
