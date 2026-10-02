/**
 * harness — тесты механических проверок для дерева спеки (tests/capabilities, tests/architecture, tests/standards):
 * проверка регистрирует обычные тесты раннера, поэтому видна в его отчёте и в документации spec-doc.
 *
 * «Реестр + инвариант» — соглашение о поведении («каждая мутация пишет аудит») проверяется на каждом элементе
 * реестра, взятого из кода, а не на одном примере. «Примеры» — линт-правило проверяется кодом, на котором оно
 * обязано сработать, промолчать и не действовать; линтер — через адаптер (ESLint — `eslintLinter`).
 *
 * Раннер не важен: `it` передаёт тест (Vitest, Jest, bun test, node:test — у всех `it(name, fn)`). Импорт — из копии
 * скилла в проекте (`.agents/skills/spec/scripts/harness.ts`); только стираемый синтаксис TypeScript и `node:`-API,
 * поэтому идёт под Node ≥ 22.18 и под Bun без зависимостей.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Model } from "./architecture.ts";
import { skipString } from "./speclib.ts";

/** `it` раннера: имя и тело; тело бросает (expect) при нарушении. */
export type It = (name: string, fn: () => void | Promise<unknown>) => unknown;

export interface Invariant<T> {
  /** Имя реестра — для теста «не пуст»: «мутации», «файлы тестов, которые запускают процессы». */
  registry: string;
  /**
   * Элементы реестра — из кода (роутер, схема, файлы), не рукописный список: новый элемент не проскочит мимо
   * проверки. Считаются до регистрации тестов — асинхронный реестр ждать `await` на верхнем уровне файла теста.
   */
  items: readonly T[];
  /** Название теста элемента — утверждение о нём: «createInvoice пишет запись аудита». */
  name: (item: T) => string;
  /** Проверка одного элемента: бросает, если элемент нарушает соглашение. */
  check: (item: T) => unknown;
  /**
   * Заведомый нарушитель: проверка обязана на нём упасть — иначе она ничего не проверяет. У проверки из нескольких
   * половин (клиент и сервер) — нарушитель на каждую.
   */
  violator: { name: string; item: T } | readonly { name: string; item: T }[];
  /** Ключ элемента для исключений, охвата и `includes` — стабильный идентификатор (имя, путь); по умолчанию — название теста. */
  key?: (item: T) => string;
  /**
   * Идентификатор соглашения, когда в папке их несколько над одним реестром: исключения — только с этим `rule`,
   * служебные тесты называют его («реестр «формы» не пуст (audit)»).
   */
  rule?: string;
  /** Исключения — каталог `exceptions/` папки решения (`exceptionsIn()`): элемент, задача, которая его снимет, и причина. */
  exceptions?: readonly Exception[];
  /** Вне охвата — элементы, к которым соглашение не относится намеренно, с причиной: она видна на странице. */
  outside?: readonly { item: string; reason: string }[];
  /** Ключи, которые обязаны быть в реестре: «не пуст» не заметит, что выборка потеряла половину элементов. */
  includes?: readonly string[];
}

/** Исключение из соглашения: ключ элемента, номер задачи, которая снимет долг, и причина. */
export interface Exception {
  item: string;
  issue: number;
  reason: string;
  /** Соглашение (`rule` инварианта), к которому исключение относится; без него — ко всем инвариантам папки. */
  rule?: string;
  /** Файл исключения — его ставит `exceptionsIn`: храповик называет, какой файл удалить. */
  file?: string;
}

const EXCEPTIONS_DIR = "exceptions";
// прежний формат — массив в одном файле папки решения; исключения названий spec-doc (names.exceptions/) — не он
const LEGACY_EXCEPTIONS = ["exceptions.ts", "exceptions.mts", "exceptions.js", "exceptions.mjs", "exceptions.json"];
const MIGRATE = "перенеси командой spec-exceptions: node .agents/skills/spec/scripts/spec-exceptions.ts";

/**
 * Исключения папки решения — каталог `exceptions/`, файл на исключение (`<элемент>.json`: `{ item, issue, reason,
 * rule? }`): параллельные PR добавляют и удаляют каждый свой файл, а в общем массиве соседние строки конфликтуют.
 * Каталог — `<dir>/exceptions`, по умолчанию — папки вызывающего теста (по стеку, как `meta`); нет каталога —
 * исключений нет. Файл не JSON-исключение или один элемент (с тем же `rule`) в двух файлах — ошибка с путями.
 */
export function exceptionsIn(dir?: string): Exception[] {
  const folder = dir ?? callerFolder();
  if (folder === null) throw new Error("exceptionsIn: вызов не из файла теста — передай каталог папки решения");
  return exceptionFiles(path.join(folder, EXCEPTIONS_DIR));
}

/**
 * Исключения из каталога файлов (`<папка решения>/exceptions`): файл на исключение, по имени файла. Каталога нет —
 * исключений нет: git не хранит пустой каталог, последнее снятое исключение уносит его с собой.
 */
export function exceptionFiles(at: string): Exception[] {
  let names: string[];
  try {
    names = readdirSync(at).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out: Exception[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const file = path.join(at, name).split(path.sep).join("/");
    if (!name.endsWith(".json")) throw new Error(`${file}: исключение — файл <элемент>.json с { item, issue, reason }`);
    let data: Partial<Exception>;
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Partial<Exception>;
    } catch (e) {
      throw new Error(`${file}: не JSON — ${(e as Error).message}`);
    }
    if (!data || typeof data !== "object" || typeof data.item !== "string") throw new Error(`${file}: исключение — { item, issue, reason }, rule — по желанию`);
    const key = `${data.rule ?? ""}\0${data.item}`;
    const twin = seen.get(key);
    if (twin) throw new Error(`исключение ${data.item}${data.rule ? ` (${data.rule})` : ""} — в двух файлах: ${twin}, ${file} — оставь один`);
    seen.set(key, file);
    out.push({ item: data.item, issue: data.issue as number, reason: String(data.reason ?? ""), ...(data.rule ? { rule: data.rule } : {}), file });
  }
  return out;
}

/** Папка решения вызывающего теста от корня проекта (cwd): `tests/<вид>/<имя>`, вне `tests/` — каталог файла. */
function callerFolder(): string | null {
  const file = callerTest(process.cwd());
  if (!file) return null;
  const parts = file.split("/");
  return parts[0] === "tests" && parts.length > 3 ? parts.slice(0, 3).join("/") : path.posix.dirname(file);
}

/**
 * Прежний формат исключений — `exceptions.ts` в папке вызывающего теста: упавший тест с подсказкой переноса, один на
 * папку за прогон. Проверка регистрирует его сама — проект, который ещё импортирует `exceptions.ts`, `exceptionsIn` не зовёт.
 */
function legacyExceptions(it: It): void {
  const folder = callerFolder();
  if (folder === null) return;
  const legacy = LEGACY_EXCEPTIONS.map((n) => `${folder}/${n}`).find((f) => existsSync(path.resolve(process.cwd(), f)));
  if (!legacy || seen.has(`legacy\0${folder}`)) return;
  seen.add(`legacy\0${folder}`);
  it("исключения — файлом на элемент в exceptions/, а не в exceptions.ts", () => {
    throw new Error(`${legacy}: исключения — файл на элемент в ${folder}/${EXCEPTIONS_DIR}/ — ${MIGRATE}`);
  });
}

/** Что сделать с ненужным исключением: удалить его файл, а исключение без файла — убрать из списка. */
const dropHint = (e: Exception): string => (e.file ? `убери исключение: удали ${e.file}` : "убери исключение");

/**
 * Тесты соглашения: «реестр не пуст» (опечатка в пути не проходит молча), «нарушитель не проходит» (проверка умеет
 * падать) и по тесту на элемент. В названиях нет счётчиков: реестр растёт — в диффе спеки только новые элементы.
 */
export function invariant<T>(it: It, spec: Invariant<T>): void {
  legacyExceptions(it);
  // несколько соглашений над одним реестром в одном describe: служебные тесты различает правило
  const tag = spec.rule ? ` (${spec.rule})` : "";
  it(`реестр «${spec.registry}» не пуст${tag}`, () => {
    if (!spec.items.length) throw new Error(`реестр «${spec.registry}» пуст — проверять нечего: путь или выборка реестра ошибочны`);
  });
  const key = spec.key ?? spec.name;
  const byKey = new Map(spec.items.map((item) => [key(item), item]));
  if (spec.includes?.length) {
    it(`реестр «${spec.registry}» находит ${spec.includes.join(", ")}${tag}`, () => {
      const missing = spec.includes!.filter((k) => !byKey.has(k));
      if (missing.length) throw new Error(`в реестре «${spec.registry}» нет: ${missing.join(", ")} — выборка реестра потеряла элементы`);
    });
  }
  const violators = Array.isArray(spec.violator) ? spec.violator : [spec.violator as { name: string; item: T }];
  for (const v of violators) {
    it(`нарушитель не проходит${tag}: ${v.name}`, async () => {
      try {
        await spec.check(v.item);
      } catch {
        return;
      }
      throw new Error(`проверка прошла на нарушителе «${v.name}» — она ничего не проверяет`);
    });
  }
  // исключение без правила — ко всем соглашениям папки, с правилом — только к своему
  const excepted = new Map((spec.exceptions ?? []).filter((e) => !e.rule || e.rule === spec.rule).map((e) => [e.item, e]));
  const outside = new Map((spec.outside ?? []).map((o) => [o.item, o]));
  // по названию, а не в порядке реестра: порядок файлов и запросов зависит от машины, а спека — нет
  const named = spec.items.filter((item) => !excepted.has(key(item)) && !outside.has(key(item))).map((item) => ({ name: spec.name(item), item }));
  named.sort(byName);
  for (const { name, item } of named) {
    it(name, async () => {
      await spec.check(item);
    });
  }
  // вне охвата — намеренно, с причиной на странице; элемент пропал — запись об охвате убрать
  for (const o of [...outside.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))) {
    const name = `вне охвата${tag}: ${o.item}`;
    meta(name, { reason: o.reason });
    it(name, () => {
      if (!o.reason.trim()) throw new Error(`у элемента вне охвата ${o.item} нет причины`);
      if (!byKey.has(o.item)) throw new Error(`элемента ${o.item} в реестре «${spec.registry}» нет — убери из охвата`);
    });
  }
  // храповик: исключение живёт, пока элемент нарушает соглашение; начал соблюдать — исключение убрать
  const exceptions = [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  for (const e of exceptions) {
    meta(`исключение${tag}: ${e.item} (#${e.issue})`, { issue: e.issue, reason: e.reason });
    it(`исключение${tag}: ${e.item} (#${e.issue})`, async () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`у исключения ${e.item} нет задачи — issue: номер задачи, которая снимет долг`);
      if (!e.reason.trim()) throw new Error(`у исключения ${e.item} нет причины`);
      if (!byKey.has(e.item)) throw new Error(`элемента ${e.item} в реестре «${spec.registry}» нет — ${dropHint(e)}`);
      try {
        await spec.check(byKey.get(e.item)!);
      } catch {
        return;
      }
      throw new Error(`${e.item} уже соблюдает соглашение — ${dropHint(e)} (#${e.issue})`);
    });
  }
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Сообщение линтера о коде: правило (null — не правило, например ошибка разбора) и текст. */
export interface LintMessage {
  ruleId: string | null;
  message: string;
  fatal?: boolean;
}

/** Линтер проекта: код и путь файла (от корня проекта — по нему конфиг решает, действует ли правило). */
export interface Linter {
  lint(code: string, filePath: string): Promise<LintMessage[]>;
  /**
   * Загрузить конфиг заранее: `await linter.ready()` на верхнем уровне файла — не под таймаутом первого примера.
   * Необязателен адаптеру без долгой загрузки; у `eslintLinter()` есть всегда.
   */
  ready?(): Promise<void>;
}

/** Пример к правилу: название (утверждение), путь от корня проекта и код. */
export interface Example {
  name: string;
  path: string;
  code: string;
  /** У «нельзя»: сколько раз правило обязано сработать (по умолчанию — хотя бы раз). */
  count?: number;
}

export interface Examples {
  linter: Linter;
  /** Идентификатор правила, как его сообщает линтер: `no-console`, `boundaries/element-types`. */
  rule: string;
  /** На этом коде правило обязано сработать — иначе оно ничего не проверяет. */
  bad: Example[];
  /** На этом коде правило обязано промолчать. */
  good?: Example[];
  /** Файл вне охвата правила: то же нарушение там допустимо. */
  outside?: Example[];
}

/**
 * Тесты правила: «нельзя: …» — правило сработало, «можно: …» и «вне охвата: …» — не сработало. Срабатывания других
 * правил не считаются ни за, ни против; пример, который не разбирается, — упавший тест. Без «нельзя» — упавший тест
 * «у правила … есть пример «нельзя»»: доказать, что правило умеет падать, нечем.
 */
export function examples(it: It, spec: Examples): void {
  const fires = async (e: Example): Promise<LintMessage[]> => {
    const messages = await spec.linter.lint(e.code, e.path);
    const fatal = messages.find((m) => m.fatal);
    if (fatal) throw new Error(`пример не разбирается: ${e.path} — ${fatal.message}`);
    return messages.filter((m) => m.ruleId === spec.rule);
  };
  // конфиг линтера грузится с регистрации, а не под таймаутом первого примера; ошибку загрузки покажет пример
  spec.linter.ready?.().catch(() => {});
  if (!spec.bad.length) {
    it(`у правила ${spec.rule} есть пример «нельзя»`, () => {
      throw new Error(`у правила ${spec.rule} нет примера «нельзя» — доказать, что оно умеет падать, нечем`);
    });
  }
  for (const e of [...spec.bad.map((x) => ["нельзя", x] as const), ...(spec.good ?? []).map((x) => ["можно", x] as const), ...(spec.outside ?? []).map((x) => ["вне охвата", x] as const)]) {
    meta(`${e[0]}: ${e[1].name}`, { path: e[1].path, code: e[1].code });
  }
  for (const e of spec.bad) {
    it(`нельзя: ${e.name}`, async () => {
      const hits = (await fires(e)).length;
      if (e.count !== undefined && hits !== e.count) throw new Error(`срабатываний правила ${spec.rule}: ${hits}, а ждали ${e.count} — ${e.path}`);
      if (!hits) throw new Error(`правило ${spec.rule} не сработало: ${e.path}`);
    });
  }
  const silent = (label: string) => (e: Example) =>
    it(`${label}: ${e.name}`, async () => {
      const hit = await fires(e);
      if (hit.length) throw new Error(`правило ${spec.rule} сработало: ${e.path} — ${hit.map((m) => m.message).join("; ")}`);
    });
  (spec.good ?? []).forEach(silent("можно"));
  (spec.outside ?? []).forEach(silent("вне охвата"));
}

/**
 * Линтер — ESLint проекта с его конфигом (`eslint.config.*` в `cwd`): пример проверяется так же, как `lint` проверит
 * файл по этому пути. ESLint берётся из зависимостей проекта (`module` — другой путь к пакету); грузится при первом
 * примере, поэтому регистрация тестов синхронна.
 */
export function eslintLinter(opts: { cwd?: string; module?: string } = {}): Required<Linter> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  type Engine = {
    lintText(code: string, o: { filePath: string }): Promise<{ messages: LintMessage[] }[]>;
    calculateConfigForFile(filePath: string): Promise<unknown>;
  };
  let engine: Promise<Engine> | null = null;
  const load = async (): Promise<Engine> => {
    const entry = opts.module ?? createRequire(path.join(cwd, "package.json")).resolve("eslint");
    const { ESLint } = (await import(pathToFileURL(entry).href)) as { ESLint: new (o: { cwd: string }) => Engine };
    return new ESLint({ cwd });
  };
  let warmed: Promise<void> | null = null;
  return {
    async lint(code, filePath) {
      engine ??= load();
      const [result] = await (await engine).lintText(code, { filePath: path.join(cwd, filePath) });
      return (result?.messages ?? []).map((m) => ({ ruleId: m.ruleId, message: m.message, fatal: m.fatal }));
    },
    // ESLint грузит конфиг лениво, при первом файле: расчёт конфига для файла проекта грузит его сейчас
    ready() {
      engine ??= load();
      warmed ??= engine.then((e) => e.calculateConfigForFile(path.join(cwd, "index.js"))).then(() => undefined);
      return warmed;
    },
  };
}

/** Отключение линт-правила в коде: файл, строка, правила (пусто — все) и описание после « -- ». */
export interface Disable {
  file: string;
  line: number;
  rules: string[];
  description: string;
}

const CODE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const DIRECTIVE = /^(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?=\s|\*\/|$)([^\n]*?)(?:\*\/|$)/m;
// после них `/` начинает регулярное выражение, а не деление
const BEFORE_REGEX = "(,=:[!&|?{};+-*%<>~^";
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw", "instanceof", "new"]);

/** i — открывающий `/` регулярного выражения; индекс после флагов. Классы `[…]` и экранирование учтены. */
function skipRegex(s: string, i: number): number {
  let j = i + 1;
  let cls = false;
  while (j < s.length && s[j] !== "\n") {
    const c = s[j]!;
    if (c === "\\") j++;
    else if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) break;
    j++;
  }
  j++;
  while (j < s.length && /[a-z]/i.test(s[j]!)) j++;
  return j;
}

/**
 * Комментарии кода — [начало, текст]: строки, шаблоны и регулярные выражения пропускаются. ESLint читает директивы
 * только в комментариях: `// eslint-disable` в строке — фикстура или сообщение, а не отключение.
 */
function commentsIn(s: string): [number, string][] {
  const out: [number, string][] = [];
  let prev = ""; // последний значащий символ кода
  let word = ""; // последнее слово кода
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      const j = s[i + 1] === "/" ? s.indexOf("\n", i) : s.indexOf("*/", i + 2);
      const end = j < 0 ? s.length : s[i + 1] === "/" ? j : j + 2;
      out.push([i, s.slice(i, end)]);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(s, i);
      prev = c;
      word = "";
      continue;
    }
    if (c === "/" && (prev === "" || BEFORE_REGEX.includes(prev) || REGEX_WORDS.has(word))) {
      i = skipRegex(s, i);
      prev = "/";
      word = "";
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < s.length && /[\w$]/.test(s[j]!)) j++;
      word = s.slice(i, j);
      prev = s[j - 1]!;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = "";
    }
    i++;
  }
  return out;
}

/** Файл кода для реестра над исходниками: путь от корня и текст. */
export interface SourceFile {
  file: string;
  readonly text: string;
}

/** Нарушитель реестра над исходниками — текстом, без файла на диске. */
export function source(file: string, text: string): SourceFile {
  return { file, text };
}

/**
 * Реестр файлов кода в каталогах (от корня): список дешёвый, текст читается при первом обращении — разбор всего
 * `src/` идёт в проверке элемента, а не при сборе тестов.
 */
export function sources(root: string, dirs: string[] = ["src"]): SourceFile[] {
  return codeFiles(root, dirs).map((file) => {
    let text: string | undefined;
    return {
      file,
      get text() {
        return (text ??= readFileSync(path.join(root, file), "utf8"));
      },
    };
  });
}

/** Файлы кода в каталогах (от корня), по порядку. */
function codeFiles(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
      } else if (CODE.test(e.name)) out.push(child);
    }
  };
  for (const d of dirs) walk(d.replace(/\/+$/, ""));
  return out.sort();
}

/** Текст без комментариев (заменены пробелами, переводы строк сохранены): сканеры кода не видят прозу и старый код. */
export function codeOnly(text: string): string {
  let out = "";
  let at = 0;
  for (const [i, c] of commentsIn(text)) {
    out += text.slice(at, i) + c.replace(/[^\n]/g, " ");
    at = i + c.length;
  }
  return out + text.slice(at);
}

/** Отключения линт-правил в файле: `// eslint-disable-next-line a, b -- #12 причина` и такие же блочные комментарии. */
export function disablesIn(file: string, text: string): Disable[] {
  const out: Disable[] = [];
  for (const [at, comment] of commentsIn(text)) {
    const m = DIRECTIVE.exec(comment);
    if (!m) continue;
    const [head, ...desc] = m[1]!.split(/\s--\s|\s--$/);
    out.push({
      file,
      line: text.slice(0, at).split("\n").length,
      rules: head!.split(",").map((r) => r.trim()).filter(Boolean),
      description: desc.join(" -- ").trim(),
    });
  }
  return out;
}

/**
 * Исключения из линт-правил — отключения в коде: по тесту на файл с отключениями («исключения в <файл>: <правила>»),
 * у каждого отключения названо правило и есть «-- #N причина». Общий `eslint-disable` без правил запрещён: он глушит
 * и правила, и эту проверку внутри линтера — поэтому она тестом, а не правилом ESLint. Нет файлов кода — упавший
 * тест: путь ошибочен. Храповик (отключение больше ничего не глушит) — в конфиге `collectEslint`.
 */
export function lintExceptions(it: It, opts: { root: string; dirs?: string[] }): void {
  const dirs = opts.dirs ?? ["src"];
  const files = codeFiles(opts.root, dirs);
  it(`в ${dirs.join(", ")} есть файлы кода`, () => {
    if (!files.length) throw new Error(`в ${dirs.join(", ")} нет файлов кода — путь ошибочен`);
  });
  for (const file of files) {
    const text = readFileSync(path.join(opts.root, file), "utf8");
    if (!text.includes("eslint-disable")) continue;
    const disables = disablesIn(file, text);
    if (!disables.length) continue;
    const rules = [...new Set(disables.flatMap((d) => (d.rules.length ? d.rules : ["все правила"])))].sort();
    // задачи отключений — в названии: спека показывает, какое решение допускает исключение
    const issues = [...new Set(disables.map((d) => /^#(\d+)/.exec(d.description)?.[1]).filter((x): x is string => !!x).map(Number))].sort((a, b) => a - b);
    const name = `исключения в ${file}: ${rules.join(", ")}${issues.length ? ` (${issues.map((n) => `#${n}`).join(", ")})` : ""}`;
    meta(name, { disables: disables.map((d) => ({ line: d.line, rules: d.rules, description: d.description })) });
    it(name, () => {
      const bad = disables.flatMap((d) => {
        if (!d.rules.length) return [`${d.file}:${d.line} — отключение без названия правила: общий eslint-disable глушит всё, включая проверки`];
        if (!/^#\d+\s+\S/.test(d.description)) return [`${d.file}:${d.line} — отключение без «-- #N причина»: ${d.rules.join(", ")}`];
        return [];
      });
      if (bad.length) throw new Error(bad.join("\n"));
    });
  }
}

// файл теста в стеке вызова: *.test.* / *.spec.* / *.e2e.* (V8 и JavaScriptCore; file:// — у ESM)
// у кадра верхнего уровня модуля Bun пишет только строку, без колонки: «at /…/x.test.ts:4»
// V8 пишет анонимную async-функцию после await кадром «at async <путь>» — без имени и скобок
const STACK_FILE = /(?:\(|\bat\s+(?:async\s+)?)(?:file:\/\/)?(\/[^()\n]*?\.(?:test|spec|e2e)\.[cm]?[jt]sx?)(?=:\d+)/g;
const seen = new Set<string>();
let journalFile: string | null = null;

/** Файл теста, из которого идёт вызов, от корня проекта — по стеку; не из теста — null. */
function callerTest(root: string): string | null {
  return testFileIn(new Error().stack ?? "", root);
}

/**
 * Файл теста в стеке вызова, от корня проекта: первый кадр `*.test.*` / `*.spec.*` / `*.e2e.*` (V8 и
 * JavaScriptCore, `file://` у ESM, `at async` после await); не из теста — null.
 */
export function testFileIn(stack: string, root: string): string | null {
  for (const m of stack.matchAll(STACK_FILE)) {
    const abs = m[1]!;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!rel.startsWith("..")) return rel;
    const i = abs.indexOf("/tests/");
    if (i >= 0) return abs.slice(i + 1);
  }
  return null;
}

let metaFile: string | null = null;

/**
 * Метаданные прогона для `spec-doc`: то, чего нет в названии теста, — код примера, задача и причина исключения.
 * Строка JSON `{ file, test, … }` в `.spec-meta/<процесс>.jsonl` (`SPEC_META` — другой каталог); файл теста — по стеку
 * регистрации. Страница стандарта показывает их под строкой теста.
 */
function meta(test: string, data: object, file: string | null = callerTest(process.cwd())): void {
  const root = process.cwd();
  if (!file) return;
  const key = `meta\0${file}\0${test}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!metaFile) {
    const dir = path.resolve(root, process.env.SPEC_META ?? ".spec-meta");
    mkdirSync(dir, { recursive: true });
    metaFile = path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  }
  appendFileSync(metaFile, JSON.stringify({ file, test, ...data }) + "\n");
}

/**
 * Журнал точек входа: тестовое окружение отмечает вызов точки входа (маршрута, job, команды) — обёрткой роутера
 * или обработчика в тестовой сборке. Файл теста определяется по стеку; где стека теста нет (e2e: запрос приходит в
 * сервер) — передать явно (`test.info().file` у Playwright). Запись — строка JSON в `.spec-journal/<процесс>.jsonl`
 * (`SPEC_JOURNAL` — другой каталог); сверку с реестром делает `spec-claims` после прогона всех тестов и шардов.
 */
export function journal(id: string, opts: { test?: string; root?: string } = {}): void {
  const root = opts.root ?? process.cwd();
  const test = opts.test ? path.relative(root, path.resolve(root, opts.test)).split(path.sep).join("/") : callerTest(root);
  const key = `${id}\0${test}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!journalFile) {
    const dir = path.resolve(root, process.env.SPEC_JOURNAL ?? ".spec-journal");
    mkdirSync(dir, { recursive: true });
    journalFile = path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  }
  appendFileSync(journalFile, JSON.stringify({ id, test }) + "\n");
}

/** Вызов на границе модели: кто, кому, что. */
export interface Call {
  from: string;
  to: string;
  message: string;
}

// трасса идущего сценария: тесты файла идут по очереди, сценарий один (test.concurrent — не для sequence)
let activeTrace: Call[] | null = null;

/**
 * Вызов на границе модели — его пишет обёртка в тестовой сборке, рядом с `journal`: точка входа, адаптер внешней
 * системы, клиент хранилища, вызов другого контейнера. Участники — имена элементов модели. Вне сценария (`sequence`) —
 * ничего; вызов внутри участника (`from === to`) — не граница: перестановка внутри модуля схему не меняет.
 */
export function trace(from: string, to: string, message: string): void {
  if (activeTrace && from !== to) activeTrace.push({ from, to, message });
}

const callLine = (c: Call): string => `${c.from} → ${c.to}: ${c.message}`;

/** Участники схемы, если задана модель: модули, внешние системы, контейнеры. */
const modelParticipants = (m: Model): Set<string> => new Set([...Object.keys(m.modules), ...Object.keys(m.externals ?? {}), ...Object.keys(m.containers ?? {})]);

/**
 * Сценарий capability — тест, чья трасса вызовов на границах модели становится сиквенс-схемой на странице capability
 * (`spec-doc`: под тестом, или меткой `<!-- spec: sequence-<id> -->` в `<папка>.md`). `order` — объявленный порядок
 * (`"app → db: резерв"`), когда порядок сам решение: трасса должна содержать его шаги в этой последовательности (между
 * ними — что угодно), иначе тест красный. `model` — участники только из модели. Без `order` схема — документация.
 */
export function sequence(
  it: It,
  name: string,
  fn: () => void | Promise<unknown>,
  opts: { id?: string; order?: string[]; model?: Model } = {},
): void {
  // файл теста — по стеку регистрации: при запуске теста в стеке его уже нет
  const file = callerTest(process.cwd());
  it(name, async () => {
    const calls: Call[] = [];
    activeTrace = calls;
    try {
      await fn();
    } finally {
      activeTrace = null;
    }
    meta(name, { ...(opts.id ? { id: opts.id } : {}), sequence: calls }, file);
    if (opts.model) {
      const known = modelParticipants(opts.model);
      const unknown = [...new Set(calls.flatMap((c) => [c.from, c.to]).filter((x) => !known.has(x)))];
      if (unknown.length) throw new Error(unknown.map((x) => `участник ${x} — не элемент модели`).join("\n"));
    }
    if (opts.order?.length) {
      const lines = calls.map(callLine);
      let j = 0;
      for (const l of lines) if (l === opts.order[j]) j++;
      if (j < opts.order.length) {
        const after = j ? `после «${opts.order[j - 1]}»` : "с начала сценария";
        throw new Error(`порядок сценария «${name}» нарушен: нет «${opts.order[j]}» ${after}\nтрасса:\n${lines.join("\n") || "— пусто"}`);
      }
    }
  });
}

// виды находок knip (knip.dev, «Reporters», JSON) → тест и префикс ключа исключения
const KNIP: [string, string, string[]][] = [
  ["нет файлов без потребителя", "file", ["files"]],
  ["нет экспортов без потребителя", "export", ["exports", "nsExports"]],
  ["нет типов без потребителя", "type", ["types", "nsTypes"]],
  ["нет зависимостей без импорта", "dependency", ["dependencies", "devDependencies", "optionalPeerDependencies"]],
  ["нет импортов неустановленных пакетов", "unlisted", ["unlisted"]],
  ["нет нерезолвящихся импортов", "unresolved", ["unresolved"]],
  // виды knip 6 (JSONReportEntry): члены перечислений и пространств имён, дубли экспортов, бинарники, каталог pnpm
  ["нет членов перечислений без потребителя", "enumMember", ["enumMembers"]],
  ["нет членов пространств имён без потребителя", "nsMember", ["namespaceMembers"]],
  ["нет экспортов-дублей", "duplicate", ["duplicates"]],
  ["нет вызовов неустановленных бинарников", "binary", ["binaries"]],
  ["нет лишних записей каталога пакетов", "catalog", ["catalog"]],
];

type KnipItem = { name: string; namespace?: string };

/** Находка knip для показа и ключа исключения: файл — путь, пакет и бинарник — имя, остальное — `<файл>#<имя>`. */
function knipShown(kind: string, file: string, item: KnipItem | KnipItem[]): string {
  if (Array.isArray(item)) return `${file}#${item.map((x) => x.name).join(" = ")}`; // дубли — группа имён одного экспорта
  if (["file", "dependency", "unlisted", "binary", "catalog"].includes(kind)) return item.name;
  return `${file}#${item.namespace ? item.namespace + "." : ""}${item.name}`;
}

/** Находки knip по видам: ключ вида (`file:…`, `export:<файл>#<имя>`, `dependency:<пакет>`) → то, что показать. */
function knipFindings(report: { issues?: Record<string, unknown>[] }): Map<string, Map<string, string>> {
  const out = new Map(KNIP.map(([, kind]) => [kind, new Map<string, string>()]));
  for (const issue of report.issues ?? []) {
    const file = String(issue.file ?? "");
    for (const [, kind, keys] of KNIP) {
      for (const k of keys) {
        for (const item of (issue[k] as (KnipItem | KnipItem[])[] | undefined) ?? []) {
          const shown = knipShown(kind, file, item);
          out.get(kind)!.set(`${kind}:${shown}`, shown);
        }
      }
    }
  }
  return out;
}

/**
 * Код без потребителя — по отчёту knip: тест на каждый вид находок (файлы, экспорты, типы, зависимости, неустановленные
 * пакеты, нерезолвящиеся импорты) — упавший со списком находок. Отчёт — файл `knip --reporter json` (`report`) или
 * запуск knip проекта (`node_modules/.bin/knip`). Исключение — ключ находки (`file:src/legacy.ts`,
 * `export:src/math.ts#factorial`, `dependency:lodash`) с задачей: зелёное, пока knip его находит, иначе — «убери».
 */
export function deadCode(it: It, opts: { root: string; report?: string; args?: readonly string[]; exceptions?: readonly Exception[] }): void {
  let findings: Map<string, Map<string, string>> | null = null;
  const load = (): Map<string, Map<string, string>> => {
    if (findings) return findings;
    let text: string;
    if (opts.report) text = readFileSync(path.resolve(opts.root, opts.report), "utf8");
    else {
      const r = spawnSync(path.join(opts.root, "node_modules", ".bin", "knip"), ["--reporter", "json", ...(opts.args ?? [])], { cwd: opts.root, encoding: "utf8" });
      if (r.error) throw new Error(`knip не запустился: ${r.error.message} — установи knip в проект или передай report`);
      // 0 — чисто, 1 — есть находки; иное — сбой knip, а не «мёртвого кода нет»
      if (r.status !== 0 && r.status !== 1) throw new Error(`knip завершился с кодом ${r.status ?? r.signal}: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
      text = r.stdout;
    }
    try {
      findings = knipFindings(JSON.parse(text));
    } catch {
      throw new Error(`knip вывел не JSON — отчёт не разобрать: ${text.trim().slice(0, 300)}`);
    }
    return findings;
  };
  legacyExceptions(it);
  const excepted = new Map((opts.exceptions ?? []).map((e) => [e.item, e]));
  for (const [name, kind] of KNIP) {
    it(name, () => {
      const found = [...load().get(kind)!].filter(([key]) => !excepted.has(key)).map(([, shown]) => shown).sort();
      if (found.length) throw new Error(found.join("\n"));
    });
  }
  for (const e of [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    meta(`исключение: ${e.item} (#${e.issue})`, { issue: e.issue, reason: e.reason });
    it(`исключение: ${e.item} (#${e.issue})`, () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`у исключения ${e.item} нет задачи`);
      if (!e.reason.trim()) throw new Error(`у исключения ${e.item} нет причины`);
      const kind = e.item.split(":")[0]!;
      if (!load().get(kind)?.has(e.item)) throw new Error(`knip больше не находит ${e.item} — ${dropHint(e)} (#${e.issue})`);
    });
  }
}

const ENV_READ = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)|\bprocess\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)|\{([^{}]*)\}\s*=\s*process\.env\b/g;
const ENV_SERVICE = ["NODE_ENV", "CI", "TZ", "PORT", "HOME", "PATH", "PWD", "DEV", "PROD", "MODE", "SSR", "BASE_URL"];

/** Переменные окружения, которые читает код: имя → файлы. */
/** Имена переменных окружения, которые читает исходник. */
export function envNamesIn(source: string): string[] {
  const text = codeOnly(source);
  const out = new Set<string>();
  // process.env под другим именем: параметр по умолчанию `(env = process.env)` или `const e = process.env`
  for (const [, alias] of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*process\.env\b(?!\s*[.[])/g)) {
    const a = alias!.replace(/\$/g, "\\$");
    const reads = new RegExp(`(?<![\\w$.])${a}(?:\\.([A-Z_][A-Z0-9_]*)|\\[\\s*["']([A-Z_][A-Z0-9_]*)["']\\s*\\])`, "g");
    for (const m of text.matchAll(reads)) out.add(m[1] ?? m[2]!);
  }
  for (const m of text.matchAll(ENV_READ)) {
    const names = m[4] ? m[4].split(",").map((x) => x.split(":")[0]!.trim()).filter((x) => /^[A-Z_][A-Z0-9_]*$/.test(x)) : [m[1] ?? m[2] ?? m[3]!];
    for (const n of names) out.add(n);
  }
  return [...out];
}

function envReads(root: string, dirs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of codeFiles(root, dirs)) {
    for (const n of envNamesIn(readFileSync(path.join(root, file), "utf8"))) out.set(n, [...new Set([...(out.get(n) ?? []), file])]);
  }
  return out;
}

/**
 * Переменные окружения — объявлены и читаются: «<VAR> объявлена» на каждую, что читает код (`process.env.X`,
 * `process.env["X"]`, `import.meta.env.X`, `const { X } = process.env`), и «<VAR> читается в коде» на каждую
 * объявленную (`declared` — из схемы окружения проекта: zod, t3-env, .env.example). Служебные (NODE_ENV, CI, PORT…
 * и `ignore`) — вне проверки.
 */
export function envVars(
  it: It,
  opts: {
    root: string;
    dirs?: string[];
    declared: readonly string[];
    outside?: readonly { item: string; reason: string }[];
    /** Устарело: без причины и храповика — упавший тест «перенеси в outside». */
    ignore?: readonly string[];
    exceptions?: readonly Exception[];
  },
): void {
  const skip = new Set([...ENV_SERVICE, ...(opts.ignore ?? [])]);
  if (opts.ignore?.length) {
    it(`вне охвата без причины: ${[...opts.ignore].sort().join(", ")}`, () => {
      throw new Error("ignore не держит причину — перенеси в outside: [{ item, reason }] (причина — на странице, пропала — «убери из охвата»)");
    });
  }
  const reads = envReads(opts.root, opts.dirs ?? ["src"]);
  const declared = new Set(opts.declared);
  const readItems = [...reads.keys()].filter((v) => !skip.has(v));
  const declaredItems = [...declared].filter((v) => !skip.has(v));
  // исключение и «вне охвата» — у проверки, в чьём реестре есть переменная; нет ни в одном — у первой: там «убери»
  const inReads = new Set(readItems);
  const inDeclared = new Set(declaredItems);
  const forReads = <T extends { item: string }>(xs?: readonly T[]) => xs?.filter((x) => inReads.has(x.item) || !inDeclared.has(x.item));
  const forDeclared = <T extends { item: string }>(xs?: readonly T[]) => xs?.filter((x) => inDeclared.has(x.item));
  invariant(it, {
    registry: "переменные окружения в коде",
    items: readItems,
    name: (v) => `${v} объявлена`,
    key: (v) => v,
    check: (v) => {
      if (!declared.has(v)) throw new Error(`${v} читается в ${reads.get(v)!.join(", ")}, но не объявлена в схеме окружения`);
    },
    violator: { name: "переменная без объявления", item: "__НЕ_ОБЪЯВЛЕНА__" },
    exceptions: forReads(opts.exceptions),
    outside: forReads(opts.outside),
  });
  invariant(it, {
    registry: "объявленные переменные окружения",
    items: declaredItems,
    name: (v) => `${v} читается в коде`,
    key: (v) => v,
    check: (v) => {
      if (!reads.has(v)) throw new Error(`${v} объявлена, но не читается — убери из схемы окружения`);
    },
    violator: { name: "объявлена и не читается", item: "__НЕ_ЧИТАЕТСЯ__" },
    exceptions: forDeclared(opts.exceptions),
    outside: forDeclared(opts.outside),
  });
}
