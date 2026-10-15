import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant, source } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";
import { parseJs } from "../../../skills/spec/scripts/speclib.ts";
import * as babel from "../../../skills/spec/scripts/vendor/babel-parser.cjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Старое имя флоу: `ai-dev` в путях, именах и прозе, `AI_DEV_*` в переменных — в любом регистре. */
const OLD = /(?<![\p{L}\d])ai[-_]dev/giu;
const hasOld = (s: string) => s.search(OLD) >= 0;

/**
 * Файлы флоу — то, что ставит install в проект и на машину (канон, справочники, скиллы), установщик, README и
 * package.json. Тесты — вне охвата: они моделируют установки до переименования.
 */
const FLOW = ["AGENTS.md", "claude", "docs", "skills", "bin", "README.md", "package.json"];

/** Место, где старое имя читается для перехода. */
interface Place {
  /** Файл от корня. */
  file: string;
  /**
   * Блок файла: в коде — имя объявления верхнего уровня (с его комментарием), `header` — комментарий в начале файла; в
   * документе — фраза абзаца или заголовок раздела (`## …`); в JSON — путь ключа. Без `at` — файл целиком, с путём.
   */
  at?: string;
  /** Что узнаётся под старым именем. */
  reads: string;
  /**
   * Тест «старое имя узнаётся своим и заменяется, второго нет» — `<папка решения> › <название теста>`; у выражения
   * каталога конфигурации — папка стандарта `config-dir`, который его держит.
   */
  test: string;
}

const CONFIG_DIR = "каталог личной конфигурации до переименования — AI_DEV_CONFIG_DIR и ~/.config/ai-dev, пока update -g его не перенёс";
const MOVE = "update › update переносит .agents/ai-dev.json и правила ai-dev в новые имена, содержимое не теряется";
const RULESET = "github-project › project check узнаёт ruleset ai-dev своим, project fix переименовывает его в elves";
const LANGUAGE = "github-project › до update язык читается из прежнего манифеста .agents/ai-dev.json, а когда есть и .agents/elves.json — из нового";
const UPDATE_TASK = "github-task › task new узнаёт открытую задачу обновления флоу со старым названием и второй не заводит";
const SLOT_ENV = "slot › slot экспортирует ELVES_SLOT, ELVES_SLOT_CPUS и AI_DEV_SLOT, AI_DEV_SLOT_CPUS; вложенный вызов только с AI_DEV_SLOT своего слота не ждёт";
const SLOT_TEMP = "slot › очередь видит билеты slot прошлого релиза в ai-dev/slots временного каталога";
const PROXY = "task-env › `proxy up` убирает прежний прокси, который держит порт, а его сеть оставляет: новый прокси на том же порту, в своей сети и в сети прежнего";
const PROXY_NETWORK = "task-env › сеть прокси под прежним именем ai-dev-proxy — строка ❌ называет прежнее имя с правкой: убрать сеть, `task-env up` добавляет сеть прокси сам; код 1";
const PROXY_PORT = "task-env › имя прокси — `elves-proxy`, ELVES_PROXY его меняет; порт — ELVES_PROXY_PORT, без неё — прежняя AI_DEV_PROXY_PORT из профиля, без обеих — 80";
const SETTINGS = "task-env › `env.http` — из `.agents/elves.json`; пока его нет — из `.agents/ai-dev.json`; сообщение об ошибке называет прочитанный файл";

/**
 * Реестр имён для перехода: в каждом месте старое имя узнаётся своим и заменяется новым, второго нет. Места task-env
 * с записанным сроком «один релиз» снимает #564.
 */
const PLACES: readonly Place[] = [
  // установщик
  {
    file: "bin/ai-dev.ts",
    reads: "установщик под прежним путём: update -g релиза до переименования запускает его в клоне --link",
    test: "update › установщик клона по прежнему пути bin/ai-dev.ts — тот же установщик: update -g релиза до переименования ставит машине новый хук",
  },
  {
    file: "bin/elves.ts",
    at: "LEGACY_SOURCE",
    reads: "прежнее имя репозитория miroshnik/ai-dev — в хуке SessionStart, имени пакета клона и origin клона --link",
    test: "update › update -g на машине со старым хуком оставляет один хук — с командой miroshnik/elves",
  },
  {
    file: "bin/elves.ts",
    at: "FORMER",
    reads: "имена установки до переименования — манифест, канон, правила, блоки AGENTS.md и .gitignore, каталог конфигурации, переменные AI_DEV_*",
    test: "update › update заменяет блоки ai-dev в AGENTS.md и .gitignore блоками elves — второго блока нет",
  },
  { file: "bin/elves.ts", at: "HELP", reads: "справка check и update называет прежние имена, которые update переносит, а check -g называет", test: MOVE },
  { file: "README.md", at: "**Before the rename to Elves**", reads: "README называет прежние имена установки и их перенос", test: MOVE },
  // github
  { file: "skills/github/scripts/github.ts", at: "FORMER_RULESET", reads: "ruleset ai-dev, поставленный project fix до переименования", test: RULESET },
  { file: "skills/github/scripts/github.ts", at: "configDir", reads: CONFIG_DIR, test: "config-dir" },
  { file: "skills/github/reference.md", at: "under the flow's former name `ai-dev`", reads: "справочник называет ruleset под прежним именем", test: RULESET },
  { file: "skills/github/scripts/locale.ts", at: "FORMER_MANIFEST", reads: "язык проекта из манифеста .agents/ai-dev.json, пока update его не перенёс", test: LANGUAGE },
  { file: "skills/github/reference.md", at: "the former `.agents/ai-dev.json`", reads: "справочник называет прежний манифест, из которого читается язык", test: LANGUAGE },
  { file: "skills/github/locales/en.json", at: "formerly.updateTask", reads: "название задачи обновления флоу до переименования", test: UPDATE_TASK },
  { file: "skills/github/locales/ru.json", at: "formerly.updateTask", reads: "название задачи обновления флоу до переименования", test: UPDATE_TASK },
  // est
  { file: "skills/est/scripts/est.ts", at: "EST_DIR", reads: CONFIG_DIR, test: "config-dir" },
  { file: "skills/est/reference.md", at: "the former `~/.config/ai-dev`", reads: "справочник называет прежний каталог реестра репозиториев", test: "config-dir" },
  // slot
  { file: "skills/slot/scripts/slot.ts", at: "FORMER_ENV", reads: "переменные очереди AI_DEV_SLOT и AI_DEV_SLOT_CPUS проектов и slot прошлого релиза", test: SLOT_ENV },
  { file: "skills/slot/scripts/slot.ts", at: "FORMER_TEMP", reads: "билеты slot прошлого релиза в ai-dev/slots временного каталога", test: SLOT_TEMP },
  { file: "skills/slot/scripts/slot.ts", at: "places", reads: CONFIG_DIR, test: "config-dir" },
  { file: "skills/slot/SKILL.md", at: "**The flow's former name.**", reads: "описание скилла называет прежние переменные очереди", test: SLOT_ENV },
  { file: "skills/slot/SKILL.md", at: "the tickets of an earlier release's slot", reads: "описание скилла называет прежнее место билетов", test: SLOT_TEMP },
  // task-env — один релиз, снятие — #564
  { file: "skills/task-env/scripts/task-env.ts", at: "FORMER_PROXY", reads: "прокси ai-dev-proxy и его сеть — один релиз", test: PROXY },
  { file: "skills/task-env/scripts/task-env.ts", at: "HELP", reads: "справка check и proxy up называет прокси ai-dev-proxy и его сеть", test: PROXY_NETWORK },
  { file: "skills/task-env/scripts/task-env.ts", at: "proxyPort", reads: "порт прокси из AI_DEV_PROXY_PORT профиля владельца", test: PROXY_PORT },
  { file: "skills/task-env/scripts/task-env.ts", at: "MANIFESTS", reads: "настройки стека из .agents/ai-dev.json, пока update его не перенёс", test: SETTINGS },
  { file: "skills/task-env/SKILL.md", at: "**Before the rename**", reads: "описание скилла называет прокси до переименования", test: PROXY },
  { file: "skills/task-env/SKILL.md", at: "(the proxy before the rename, written by hand)", reads: "описание скилла называет сеть ai-dev-proxy в compose-файле", test: PROXY_NETWORK },
  { file: "skills/task-env/SKILL.md", at: "its name before the rename", reads: "описание скилла называет AI_DEV_PROXY_PORT", test: PROXY_PORT },
  { file: "skills/task-env/SKILL.md", at: "an install from before the rename", reads: "описание скилла называет прежний файл настроек", test: SETTINGS },
  { file: "skills/task-env/reference.md", at: "## The proxy before the rename", reads: "справочник описывает переход с прокси ai-dev-proxy", test: PROXY },
  { file: "skills/task-env/reference.md", at: "`providers.docker.network`", reads: "справочник называет сеть ai-dev-proxy сетью провайдера по умолчанию", test: PROXY },
];

/** Файлы флоу от корня, по порядку; скрытые и node_modules — не флоу. */
function flowFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (!statSync(abs).isDirectory()) return void out.push(rel);
    for (const e of readdirSync(abs)) if (e !== "node_modules" && !e.startsWith(".")) walk(`${rel}/${e}`);
  };
  for (const f of FLOW) walk(f);
  return out.sort();
}

/** Вхождение старого имени: строка (0 — путь файла), её текст, блок — для сообщения — и входит ли оно в место `at`. */
interface Occurrence {
  line: number;
  snippet: string;
  block: string;
  in: (at: string) => boolean;
}

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
const lineText = (text: string, at: number) => text.slice(text.lastIndexOf("\n", at - 1) + 1).split("\n", 1)[0]!.trim();

interface AstNode {
  type: string;
  start: number;
  end: number;
  leadingComments?: { start: number }[] | null;
  declaration?: AstNode | null;
  declarations?: { id: { name?: string } }[];
  id?: { name?: string } | null;
}

/** Имя объявления верхнего уровня — ключ блока; не объявление — вид узла. */
function declared(n: AstNode): string {
  const d = n.declaration ?? n;
  if (n.type === "ImportDeclaration") return "import";
  if (n.type === "ExportDefaultDeclaration" && !d.id?.name) return "default";
  return d.declarations?.[0]?.id.name ?? d.id?.name ?? n.type;
}

/**
 * Блоки кода: объявление верхнего уровня с его комментарием — от комментария до следующего блока; комментарий перед
 * первым импортом — `header`. Комментарий на строке конца прошлого объявления — его, а не следующего.
 */
function codeBlocks(file: string, text: string): { key: string; start: number }[] {
  const plugins = /\.[cm]?tsx?$/.test(file) ? ["typescript"] : ["jsx"];
  const body = (babel.parse(text, { sourceType: "module", errorRecovery: true, plugins }) as { program: { body: AstNode[] } }).program.body;
  const blocks = [{ key: "header", start: 0 }];
  let prev = 0;
  body.forEach((n, i) => {
    const lead = (n.leadingComments ?? []).find((c) => c.start >= prev && text.slice(prev, c.start).includes("\n"));
    blocks.push({ key: declared(n), start: i === 0 && n.type === "ImportDeclaration" ? n.start : (lead?.start ?? n.start) });
    prev = n.end;
  });
  return blocks;
}

function inCode(file: string, text: string): Occurrence[] {
  const blocks = codeBlocks(file, text);
  return [...text.matchAll(OLD)].map((m) => {
    const key = blocks.filter((b) => b.start <= m.index).at(-1)!.key;
    return { line: lineOf(text, m.index), snippet: lineText(text, m.index), block: key, in: (at: string) => at === key };
  });
}

/** В JSON блок — путь ключа: старое имя в значении или в самом ключе. */
function inJson(text: string): Occurrence[] {
  const out: Occurrence[] = [];
  const found = (keys: string[], s: string) => {
    const key = keys.join(".");
    const at = text.indexOf(JSON.stringify(s));
    out.push({ line: at < 0 ? 1 : lineOf(text, at), snippet: s, block: key, in: (a) => a === key });
  };
  const walk = (v: unknown, keys: string[]): void => {
    if (typeof v === "string") return void (hasOld(v) && found(keys, v));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (hasOld(k)) found([...keys, k], k);
      walk(x, [...keys, k]);
    }
  };
  walk(JSON.parse(text), []);
  return out;
}

/**
 * В тексте блок — абзац (строки до пустой) или раздел под заголовком `#` документа `.md`; заголовок — абзац сам по себе,
 * `#` в блоке кода — не заголовок. Фраза места ищется в абзаце, где переносы строк — пробел.
 */
function inText(file: string, text: string): Occurrence[] {
  const out: Occurrence[] = [];
  const md = file.endsWith(".md");
  const lines = text.split("\n");
  const sections: string[] = [];
  let para: number[] = [];
  let fence = false;
  const flush = () => {
    const paragraph = para.map((i) => lines[i]!.trim()).join(" ");
    const chain = [...sections];
    for (const i of para.filter((j) => hasOld(lines[j]!))) {
      out.push({ line: i + 1, snippet: lines[i]!.trim(), block: chain.at(-1) ?? `«${paragraph.slice(0, 40)}…»`, in: (at) => (at.startsWith("#") ? chain.includes(at) : paragraph.includes(at)) });
    }
    para = [];
  };
  lines.forEach((line, i) => {
    if (md && /^\s*```/.test(line)) fence = !fence;
    const heading = md && !fence ? /^(#{1,6})\s/.exec(line) : null;
    if (heading || !line.trim()) flush();
    if (heading) sections.splice(heading[1]!.length - 1, Infinity, line.trim());
    if (line.trim()) para.push(i);
    if (heading) flush();
  });
  flush();
  return out;
}

const CODE = /\.[cm]?[jt]sx?$/;

/** Вхождения старого имени в файле: путь, затем текст — по блокам вида файла. */
function occurrences(file: string, text: string): Occurrence[] {
  const named = hasOld(file) ? [{ line: 0, snippet: file, block: "путь файла", in: () => false }] : [];
  if (!hasOld(text)) return named;
  return [...named, ...(file.endsWith(".json") ? inJson(text) : CODE.test(file) ? inCode(file, text) : inText(file, text))];
}

const where = (p: Place) => `${p.file}${p.at === undefined ? "" : ` · ${p.at}`}`;

/** Вхождения старого имени вне мест реестра — `файл:строка (блок) — строка`. */
function outside(file: string, text: string, places: readonly Place[] = PLACES): string[] {
  const own = places.filter((p) => p.file === file);
  if (own.some((p) => p.at === undefined)) return [];
  return occurrences(file, text)
    .filter((o) => !own.some((p) => o.in(p.at!)))
    .map((o) => `${file}${o.line ? `:${o.line}` : ""} (${o.block}) — ${o.snippet}`);
}

/** Названия тестов папки решения — по разбору исходников, без запуска. */
const testNames = new Map<string, string[] | null>();
function testsOf(folder: string): string[] | null {
  if (!testNames.has(folder)) {
    const dir = ["capabilities", "standards"].map((k) => `tests/${k}/${folder}`).find((d) => existsSync(path.join(ROOT, d)));
    const files = dir ? readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".test.ts")) : [];
    testNames.set(folder, dir ? files.flatMap((f) => parseJs(`${dir}/${f}`, read(`${dir}/${f}`)).map((t) => t.name)) : null);
  }
  return testNames.get(folder)!;
}

/** Место живо: файл есть, старое имя в месте есть, тест перехода есть. */
function checkPlace(p: Place): void {
  if (!existsSync(path.join(ROOT, p.file))) throw new Error(`${where(p)}: файла нет — убери место из реестра (tests/standards/old-name)`);
  const text = read(p.file);
  const live = p.at === undefined ? hasOld(p.file) || hasOld(text) : occurrences(p.file, text).some((o) => o.in(p.at!));
  if (!live) throw new Error(`${where(p)}: старого имени в месте нет — переход снят или место переехало: убери его из реестра или поправь at (tests/standards/old-name)`);
  const [folder = "", name] = p.test.split(" › ", 2);
  const names = testsOf(folder);
  if (!names) throw new Error(`${where(p)}: папки решения ${folder} нет ни в tests/capabilities, ни в tests/standards`);
  if (name !== undefined && !names.includes(name)) throw new Error(`${where(p)}: в ${folder} нет теста «${name}» — назови тест, который держит переход`);
}

const FILES: SourceFile[] = flowFiles()
  .map((file) => ({ file, text: read(file) }))
  .filter((f) => hasOld(f.file) || hasOld(f.text));

describe("Старое имя ai-dev в файлах флоу — только в местах реестра имён для перехода", () => {
  invariant(it, {
    registry: "файлы флоу со старым именем — bin, skills, канон, docs, README.md, package.json",
    items: FILES,
    key: (f) => f.file,
    name: (f) => `в ${f.file} старое имя — только в местах реестра`,
    check: (f) => {
      const found = outside(f.file, f.text);
      if (found.length) {
        throw new Error(
          `старое имя вне реестра имён для перехода — новое имя (Elves, elves, ELVES_*); читается для перехода — место в реестр tests/standards/old-name с тем, что узнаётся, и тестом перехода:\n${found.join("\n")}`,
        );
      }
    },
    violator: [
      {
        name: "скрипт читает прежний манифест в новой функции, мимо своей константы",
        item: source("skills/github/scripts/locale.ts", 'const FORMER_MANIFEST = path.join(".agents", "ai-dev.json");\nconst auto = () => read(".agents/ai-dev.json").auto;\n'),
      },
      { name: "справочник называет прежний каталог вне абзаца о переходе", item: source("README.md", "**Before the rename to Elves** — `~/.config/ai-dev`.\n\nPrices — `~/.config/ai-dev/prices.json`.\n") },
      { name: "файл скилла под прежним именем", item: source("skills/x/scripts/ai-dev.ts", "export {};\n") },
    ],
    includes: ["bin/ai-dev.ts", "bin/elves.ts", "README.md", "skills/github/locales/en.json", "skills/task-env/SKILL.md"],
  });
});

describe("Место реестра имён для перехода живо: старое имя в нём есть, тест перехода — тоже", () => {
  invariant(it, {
    registry: "места реестра имён для перехода",
    items: PLACES,
    key: where,
    name: (p) => `${where(p)} — ${p.reads}`,
    check: checkPlace,
    violator: [
      { name: "место, где старого имени уже нет", item: { file: "bin/elves.ts", at: "MANIFEST", reads: "манифест", test: MOVE } },
      { name: "место с тестом, которого нет", item: { file: "bin/elves.ts", at: "FORMER", reads: "прежние имена", test: "update › update переносит прежние имена" } },
    ],
  });
});

describe("примеры", () => {
  const places: Place[] = [
    { file: "x.ts", at: "FORMER", reads: "", test: "" },
    { file: "x.ts", at: "header", reads: "", test: "" },
    { file: "x.md", at: "**Before the rename.**", reads: "", test: "" },
    { file: "x.md", at: "## The proxy before the rename", reads: "", test: "" },
    { file: "x.json", at: "formerly.title", reads: "", test: "" },
    { file: "bin/ai-dev.ts", reads: "", test: "" },
  ];

  it("старое имя вне реестра роняет проверку", () => {
    const code = ['/** The manifest before the rename. */', 'const FORMER = ".agents/ai-dev.json";', "", "function settings() {", '  return read(".agents/ai-dev.json");', "}", ""].join("\n");
    expect(outside("x.ts", code, places)).toEqual(['x.ts:5 (settings) — return read(".agents/ai-dev.json");']);
    expect(outside("y.ts", 'const FORMER = "AI_DEV_SLOT";\n', places)).toEqual(['y.ts:1 (FORMER) — const FORMER = "AI_DEV_SLOT";']);
    expect(outside("x.md", "# Setup\n\nThe settings — `.agents/ai-dev.json`.\n", places)).toEqual(["x.md:3 (# Setup) — The settings — `.agents/ai-dev.json`."]);
    expect(outside("x.json", '{ "title": "Update the ai-dev flow" }\n', places)).toEqual(["x.json:1 (title) — Update the ai-dev flow"]);
    expect(outside("skills/x/ai-dev.md", "Elves\n", places)).toEqual(["skills/x/ai-dev.md (путь файла) — skills/x/ai-dev.md"]);
  });

  it("место кода — объявление верхнего уровня с его комментарием; комментарий перед импортами — место header", () => {
    const code = [
      "#!/usr/bin/env bun",
      "/** slot — the queue; before the rename it was ai-dev/slots. */",
      'import path from "node:path";',
      "",
      "/**",
      " * The names before the rename (ai-dev): AI_DEV_SLOT and the manifest.",
      " */",
      "const FORMER = {",
      '  slot: "AI_DEV_SLOT",',
      '  manifest: path.join(".agents", "ai-dev.json"),',
      "}; // the same names as AI_DEV_SLOT",
      "const NEXT = 1;",
      "",
    ].join("\n");
    expect(outside("x.ts", code, places)).toEqual([]);
    expect(outside("x.ts", code.replace("const NEXT = 1;", 'const NEXT = "ai-dev";'), places)).toEqual(['x.ts:12 (NEXT) — const NEXT = "ai-dev";']);
  });

  it("место документа — абзац с фразой или раздел под заголовком; в JSON — путь ключа; файл под старым именем — место целиком", () => {
    const doc = [
      "# Skill",
      "",
      "**Before the rename.** The variables were",
      "`AI_DEV_SLOT` and `AI_DEV_SLOT_CPUS`.",
      "",
      "## The proxy before the rename",
      "",
      "The proxy was `ai-dev-proxy`.",
      "",
      "```sh",
      "# not a heading: ai-dev-proxy",
      "```",
      "",
      "## Labels",
      "",
      "No `ai-dev-proxy` here.",
      "",
    ].join("\n");
    expect(outside("x.md", doc, places)).toEqual(["x.md:16 (## Labels) — No `ai-dev-proxy` here."]);
    expect(outside("x.json", '{\n  "formerly": { "title": "Update the ai-dev flow" }\n}\n', places)).toEqual([]);
    expect(outside("bin/ai-dev.ts", '/** The installer under its name before the rename: <clone>/bin/ai-dev.ts. */\nimport "./elves.ts";\n', places)).toEqual([]);
  });
});
