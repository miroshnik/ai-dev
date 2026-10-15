import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import localeModule from "../../../skills/github/scripts/locale.ts";
import { codeOnly, invariant, sources } from "../../../skills/spec/scripts/harness.ts";
import { clis, commandsOf, isolated, mapLimit } from "../../lib/cli.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LOCALES = "skills/github/locales";
/** Код скриптов скиллов и установщика без комментариев: названия словаря они читают по пути ключа. */
const CODE = sources(ROOT, ["skills", "bin"]).map((f) => codeOnly(f.text, f.file)).join("\n");

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

/**
 * Сообщения установщика и скриптов скиллов — справка, подсказки, ошибки, вывод `check` и хука — часть флоу, а не
 * артефакт проекта: они по-английски при любом языке проекта. Названия на языке проекта скрипты берут из словаря
 * (`skills/github/locales`), а комментарии — по-английски, как документы флоу, поэтому кириллицы в коде скриптов нет
 * вовсе: файл сверяется целиком, с комментариями.
 */
describe("Код установщика и скриптов скиллов — сообщения и комментарии — по-английски", () => {
  invariant(it, {
    registry: "код скриптов скиллов и установщика — skills/*/scripts и bin",
    items: sources(ROOT, ["skills", "bin"]).map((f) => ({ file: f.file, text: f.text })),
    key: (f) => f.file,
    name: (f) => `в ${f.file} нет кириллицы`,
    check: (f) => {
      const lines = cyrillicLines(f.text);
      if (lines.length) {
        throw new Error(`${f.file}: кириллица — сообщения и комментарии в коде флоу по-английски, названия на языке проекта — из skills/github/locales (tests/standards/flow-english):\n${lines.join("\n")}`);
      }
    },
    violator: { name: "комментарий по-русски", item: { file: "skills/x/scripts/x.ts", text: '// подсказка агенту\nconsole.log("Next: task close");\n' } },
    includes: ["bin/elves.ts", "skills/github/scripts/github.ts", "skills/est/scripts/est.ts", "skills/spec/scripts/harness.ts"],
  });

  it("справка установщика и скриптов скиллов и их команд — на английском", async () => {
    const scripts = clis();
    expect(scripts.map((c) => c.file)).toEqual(expect.arrayContaining(["bin/elves.ts", "skills/github/scripts/github.ts", "skills/est/scripts/est.ts", "skills/slot/scripts/slot.ts", "skills/spec/scripts/spec-doc.ts"]));
    const overviews = await mapLimit(scripts, 8, async (cli) => ({ cli, text: (await isolated(cli, ["--help"])).stdout }));
    const calls = overviews.flatMap(({ cli, text }) => [{ cli, args: [] as string[] }, ...commandsOf(cli.name, text).map((c) => ({ cli, args: c.split(" ") }))]);
    const help = await mapLimit(calls, 8, async ({ cli, args }) => {
      const r = await isolated(cli, [...args, "--help"]);
      const text = `${r.stdout}${r.stderr}`;
      return { call: [cli.name, ...args].join(" "), printed: text.trim().length > 0, cyrillic: cyrillicLines(text) };
    });
    expect(help).toEqual(calls.map(({ cli, args }) => ({ call: [cli.name, ...args].join(" "), printed: true, cyrillic: [] })));
  });
});

/** Цитата в «ёлочках» из документа флоу: где и текст. */
interface Quote {
  file: string;
  text: string;
}

/**
 * Цитаты «…» документов флоу (внутренние — у вложенных), без повторов; переносы строк — пробелом. Цитата — по первому
 * документу в порядке путей, а не readdirSync: тот отдаёт файлы в порядке файловой системы, и имя теста расходилось бы
 * на macOS и в CI.
 */
function quotes(docs: Doc[] = flowDocs()): Quote[] {
  const seen = new Map<string, Quote>();
  for (const d of [...docs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    for (const m of d.text.matchAll(/«([^«»]+)»/g)) {
      const text = m[1]!.replace(/\s+/g, " ").trim();
      if (!seen.has(text)) seen.set(text, { file: d.file, text });
    }
  }
  return [...seen.values()];
}

/** Подстановки в цитате: `<имя>`, `…`, `N`/`M`/`K`/`k`, `#`, обратные кавычки — между ними литеральные куски. */
const PLACEHOLDER = /<[^<>]*>|…|\.\.\.|`|#|\b[NMKk]\b/;
/** Литеральный кусок цитаты без пунктуации по краям: двоеточие или скобку рядом с подстановкой код ставит сам. */
const literal = (s: string) => s.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
/**
 * Где цитата может быть дословно: код скриптов без комментариев и названия словаря en — без подстановок (`${…}`,
 * `{имя}`): `outside scope{tag}: {item}` печатается как «outside scope: …»; пробелы — одним.
 */
const PRINTED = `${CODE}\n${read(`${LOCALES}/en.json`)}`
  .replace(/\$\{[^{}]*\}|\{\w+\}/g, "")
  .replace(/\s+/g, " ");

/**
 * Доки флоу цитируют вывод скриптов — строки, по которым агент узнаёт исход, — и названия, которые скрипты пишут в
 * GitHub. Цитата, которой нет в коде, — дрейф: скрипт печатает иначе, и агент ищет строку, которой не будет. Цитата
 * сверяется по литеральным кускам между подстановками: каждый кусок со словом — в коде скриптов или в `en.json`.
 */
describe("Строки вывода, которые цитируют доки флоу, скрипты печатают дословно", () => {
  invariant(it, {
    registry: "цитаты «…» в документах флоу",
    items: quotes(),
    key: (q) => q.text,
    name: (q) => `цитату «${q.text}» из ${q.file} печатает или пишет скрипт`,
    check: (q) => {
      const missing = q.text.split(PLACEHOLDER).map(literal).filter((s) => /\p{L}{2,}/u.test(s) && !PRINTED.includes(s));
      if (missing.length) throw new Error(`${q.file}: «${q.text}» — в коде скриптов и в en.json нет: ${missing.map((s) => `«${s}»`).join(", ")} — поправь вывод скрипта или цитату (tests/standards/flow-english)`);
    },
    violator: { name: "цитата вывода, которого нет", item: { file: "skills/x/SKILL.md", text: "nothing to refresh, all quiet" } },
    outside: [
      { item: "api/DATABASE_URL is declared", reason: "пример названия с подставленным элементом: шаблон «{name} is declared» — в en.json" },
      { item: "host <h> is only in adapter <a>", reason: "название собрано из двух ключей en.json: hostName и inAdapter" },
      { item: "package <p> of external system <x> is only with adapter <a>", reason: "название собрано из двух ключей en.json: packageName и withAdapter" },
      { item: "shared commit … (share 1/k)", reason: "строка собрана из двух ключей en.json: est.fact.shared и est.fact.commitUnit" },
    ],
    includes: ["already newer", "Actual (cloud)", "closed in 90 days without an actual: N"],
  });

  // имя теста — утверждение спеки: локальный spec-diff против ветки spec показывал фантомные «Изменены» (#385)
  it("имя теста цитаты не зависит от порядка, в котором файловая система отдаёт документы", () => {
    const docs = [
      { file: "docs/a.md", text: "The script prints «all quiet»." },
      { file: "skills/b/SKILL.md", text: "Wait for «all quiet»." },
    ];
    expect(quotes([...docs].reverse())).toEqual(quotes(docs));
    expect(quotes(docs)).toEqual([{ file: "docs/a.md", text: "all quiet" }]);
  });
});

const dictionary = (lang: string) => JSON.parse(read(`${LOCALES}/${lang}.json`)) as Names;
const locale = (lang: string) => leaves(dictionary(lang));

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

  /**
   * Модуль `locale` берёт словари статическим импортом в карту, типизированную `Names`, — каталог `locales/` он не
   * читает: так tsc сверяет каждый словарь с типом, а модуль грузится любым раннером проекта
   * (tests/standards/harness-load). Файл языка, которого нет в карте, молча не подхватился бы ни скриптами, ни typecheck.
   */
  it("каждый файл skills/github/locales/*.json — язык модуля locale с этим словарём, en первым", () => {
    const files = readdirSync(path.join(ROOT, LOCALES)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    expect(files).toContain("en");
    expect(localeModule.languages()).toEqual(["en", ...files.filter((l) => l !== "en")]);
    const loaded = files.map((lang): { lang: string; names: unknown } => ({ lang, names: localeModule.names(lang) }));
    expect(loaded).toEqual(files.map((lang) => ({ lang, names: dictionary(lang) })));
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
      { item: "comments.state", reason: "комментарий «State» перед паузой пишет агент, скрипты его не пишут и не разбирают" },
    ],
    includes: ["status.backlog", "sections.questions", "subagentPrompt.task", "lastLine.done"],
  });
});

/**
 * Язык проекта — `language` в `.agents/ai-dev.json`, без поля — `ru`, без манифеста — `en`: скрипты скиллов и
 * установщик берут его одним модулем `skills/github/scripts/locale.ts` — правило в одном месте.
 */
describe("Язык проекта у скриптов скиллов и у установщика — один модуль", () => {
  it("установщик берёт язык и код языка модулем locale скилла github, своего правила у него нет", () => {
    const bin = codeOnly(read("bin/elves.ts"), "bin/elves.ts");
    expect(bin).toContain('import locale from "../skills/github/scripts/locale.ts";');
    expect(bin).not.toMatch(/const (?:DEFAULT|LEGACY)_LANGUAGE\b|\[a-z\]\{2,3\}/);
  });

  it("манифест с языком — его язык, без поля — ru, битый — ru, без манифеста — en", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flow-english-"));
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
