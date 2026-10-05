/**
 * Документы YAML, которые проекты копируют: workflow ai-dev и YAML-фрагменты справочников и скиллов. Общий реестр
 * мест для проверок фрагментов CI (`tests/standards/ci-concurrency`, `tests/standards/artifact-hidden-files`).
 * Не спека — в документацию не попадает.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Документ YAML: файл от корня проекта, текст и строк в файле до документа (фрагмент в Markdown). */
export interface YamlDocument {
  file: string;
  text: string;
  offset: number;
}

export const indentOf = (l: string): number => l.length - l.trimStart().length;

/** Документы YAML файла: workflow целиком, у Markdown — блоки ```yaml со строкой начала. */
export function documentsOf(file: string, text: string): YamlDocument[] {
  if (!file.endsWith(".md")) return [{ file, text, offset: 0 }];
  const out: YamlDocument[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*ya?ml\b/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[2]!;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j]!.trim().startsWith(fence); j++) body.push(lines[j]!.slice(Math.min(open[1]!.length, indentOf(lines[j]!))));
    out.push({ file, text: body.join("\n"), offset: i + 1 });
    i = j;
  }
  return out;
}

/** Файлы под каталогом от корня проекта (подкаталоги — при `deep`) с подходящим именем; скрытые и зависимости — мимо. */
function filesIn(dir: string, deep: boolean, match: RegExp): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => (e.isDirectory() ? (deep ? filesIn(`${dir}/${e.name}`, deep, match) : []) : match.test(e.name) ? [`${dir}/${e.name}`] : []))
    .sort();
}

/** Файлы реестра: `.github/workflows/*.yml`, `skills/**\/*.md`, `docs/*.md`. */
export const FRAGMENT_FILES = [...filesIn(".github/workflows", false, /\.ya?ml$/), ...filesIn("skills", true, /\.md$/), ...filesIn("docs", false, /\.md$/)];

/** Текст файла реестра от корня проекта. */
export const readFragmentFile = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");
