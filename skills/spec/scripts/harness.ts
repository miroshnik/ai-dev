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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Model } from "./architecture.ts";
import { commentsOf, decisionFolder, EXCEPTIONS_DIR, exceptionFile, stringsOf } from "./speclib.ts";

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
   * Файл элемента от корня проекта (маршрут, скрипт, миграция): «вне охвата» и исключение элемента — отметкой в нём
   * (`marksIn`), а не записью в тесте. Удалили элемент — ушла и отметка; два PR не правят общий файл. `null` — своего
   * файла нет (строка схемы, запись роутера): `outside` и `exceptions/`.
   */
  fileOf?: (item: T) => string | null | undefined;
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
  /**
   * Соглашение (`rule` инварианта), к которому исключение относится; без него — ко всем инвариантам папки. Правила нет
   * ни у одного инварианта папки — упавший тест «исключения с rule — к правилам инвариантов папки» с путём файла.
   */
  rule?: string;
  /** Файл исключения — его ставит `exceptionsIn` или отметка: храповик называет, какой файл удалить или где отметка. */
  file?: string;
  /** Строка отметки в файле элемента — исключение отметкой, а не файлом в `exceptions/`. */
  line?: number;
}

/** «Вне охвата» элемента: ключ и причина; у отметки — её место. */
interface Outside {
  item: string;
  reason: string;
  file?: string;
  line?: number;
}

/**
 * Отметка в файле элемента — комментарий, как `eslint-disable` у линта: `spec-outside(<решение>[/<rule>]): причина`
 * или `spec-exception(<решение>[/<rule>]) #N: причина`. Решение — имя папки решения (`audit` — `tests/standards/audit`):
 * файл бывает элементом реестров разных папок, отметка называет свою; `rule` — инвариант папки, без него — ко всем.
 */
export interface Mark {
  kind: "outside" | "exception";
  decision: string;
  rule?: string;
  issue?: number;
  reason: string;
  file: string;
  line: number;
}

// отметка — с начала текста комментария; причина — до конца строки, без закрытия блочного комментария
const MARK = /^spec-(outside|exception)\(([^()\s]*)\)\s*(?:#(\d+))?\s*:?\s*(.*?)\s*(?:\*\/|-->)?\s*$/;
// файл не JS: отметка сразу после начала комментария — //, /*, * блока, #, --, <!--, ;
const MARK_LINE = /(?:^|\s)(?:\/\/|\/\*+|\*|#|--|<!--|;)\s*(spec-(?:outside|exception)\(.*)$/;

function markOf(file: string, line: number, text: string): Mark | null {
  const m = MARK.exec(text);
  if (!m) return null;
  const [decision, ...rule] = m[2]!.split("/");
  return { kind: m[1] as Mark["kind"], decision: decision!, ...(rule.length ? { rule: rule.join("/") } : {}), ...(m[3] ? { issue: Number(m[3]) } : {}), reason: m[4]!, file, line };
}

/**
 * Отметки в файле: в коде JS/TS — только в комментариях (строки, шаблоны, регулярки — мимо, разбор парсером), в
 * остальных файлах (SQL, shell, HTML) — сразу после начала комментария. Отметка — с начала текста комментария:
 * упоминание формата посреди прозы — не отметка.
 */
export function marksIn(file: string, text: string): Mark[] {
  const out: Mark[] = [];
  if (!CODE.test(file)) {
    text.split("\n").forEach((l, i) => {
      const m = MARK_LINE.exec(l);
      const mark = m && markOf(file, i + 1, m[1]!);
      if (mark) out.push(mark);
    });
    return out;
  }
  for (const [at, comment] of commentsOf(text, file)) {
    if (!comment.includes("spec-")) continue;
    const first = text.slice(0, at).split("\n").length;
    comment.split("\n").forEach((l, i) => {
      const mark = markOf(file, first + i, l.replace(/^\s*(?:\/\/+|\/\*+|\*+)?\s*/, ""));
      if (mark) out.push(mark);
    });
  }
  return out;
}

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
  return file && folderOf(file);
}

/** Папка решения файла теста от корня проекта: `tests/<вид>/<имя>`, вне `tests/` — каталог файла. */
function folderOf(file: string): string {
  const parts = file.split("/");
  return parts[0] === "tests" && parts.length > 3 ? parts.slice(0, 3).join("/") : path.posix.dirname(file);
}

/** Файлы под каталогом от корня проекта, по порядку; скрытые и зависимости — мимо. */
function filesUnder(rel: string): string[] {
  let entries;
  try {
    entries = readdirSync(path.resolve(process.cwd(), rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => (e.isDirectory() ? filesUnder(`${rel}/${e.name}`) : [`${rel}/${e.name}`]))
    .sort();
}

/**
 * Исключения папки вызывающего теста не там или не в том виде (правило `exceptionFile`): прежний `exceptions.ts`
 * папки или подпапки — упавший тест с подсказкой переноса, каталог `exceptions/` в подпапке и не JSON в каталоге —
 * упавший тест с путями. Один на папку за прогон; проверка регистрирует его сама — проект, который ещё импортирует
 * `exceptions.ts`, `exceptionsIn` не зовёт. Исключения названий spec-doc (`names.exceptions/`) проверяет spec-doc.
 */
function legacyExceptions(it: It): void {
  const folder = callerFolder();
  if (folder === null || decisionFolder(`${folder}/_`) !== folder || seen.has(`legacy\0${folder}`)) return;
  seen.add(`legacy\0${folder}`);
  const found = filesUnder(folder).flatMap((f) => {
    const x = exceptionFile(f);
    return x?.dir === EXCEPTIONS_DIR ? [{ f, x }] : [];
  });
  const legacy = found.filter(({ x }) => x.legacy).map(({ f, x }) => `${f}: исключения — файл на элемент в ${x.folder}/${EXCEPTIONS_DIR}/ — ${MIGRATE}`);
  const misplaced = found.filter(({ x }) => x.error).map(({ f, x }) => `${f}: ${x.error}`);
  if (legacy.length) {
    it("исключения — файлом на элемент в exceptions/, а не в exceptions.ts", () => {
      throw new Error(legacy.join("\n"));
    });
  }
  if (misplaced.length) {
    it("исключения — файлы <элемент>.json в exceptions/ папки решения", () => {
      throw new Error(misplaced.join("\n"));
    });
  }
}

/** Правила инвариантов файла теста за прогон, исключения и отметки, которые инвариант не взял: у них `rule` другого правила. */
interface RuleLedger {
  rules: Set<string>;
  skipped: Exception[];
  marks: Mark[];
}

// по `it` и файлу теста: сборщик тестов в тесте харнесса — свой `it`, и его сверка не смешивается с чужой
const ledgers = new WeakMap<It, Map<string, RuleLedger>>();

/**
 * Исключение или отметка с `rule`, которого нет ни у одного инварианта папки (опечатка, правило переименовали или
 * удалили), не берёт ни один инвариант: храповик их не видит, долг молча выпадает из спеки. Инвариант отложил
 * исключение или отметку с чужим `rule` — регистрируется тест сверки, свой на исключения и на отметки, один на файл; он
 * идёт после сбора файла и знает правила всех его инвариантов.
 * Правила других файлов папки (подпапки с общим `exceptions/`) идут в другом процессе или позже — их сверка ищет
 * строкой в коде этих файлов.
 */
function unknownRules(it: It, rule: string | undefined, exceptions: readonly Exception[], marks: readonly Mark[]): void {
  const file = callerTest(process.cwd()) ?? "";
  const byFile = ledgers.get(it) ?? new Map<string, RuleLedger>();
  ledgers.set(it, byFile);
  const ledger = byFile.get(file) ?? { rules: new Set<string>(), skipped: [], marks: [] };
  byFile.set(file, ledger);
  if (rule) ledger.rules.add(rule);
  const reconcile = <X extends { rule?: string }>(list: X[], add: readonly X[], name: string, id: (x: X) => string, line: (x: X, have: string) => string): void => {
    if (!add.length) return;
    const first = !list.length;
    list.push(...add);
    if (!first) return;
    it(name, () => {
      const lost = new Map<string, X>();
      let elsewhere: Set<string> | null = null;
      for (const x of list) {
        if (ledger.rules.has(x.rule!)) continue;
        elsewhere ??= file ? stringsBeside(file) : new Set();
        if (!elsewhere.has(x.rule!)) lost.set(id(x), x);
      }
      if (!lost.size) return;
      const rules = [...ledger.rules].sort();
      const have = rules.length ? `у инвариантов файла: ${rules.join(", ")}` : "инварианты файла — без rule";
      throw new Error([...lost.values()].map((x) => line(x, have)).join("\n"));
    });
  };
  reconcile(
    ledger.skipped,
    exceptions.filter((e) => e.rule && e.rule !== rule),
    "исключения с rule — к правилам инвариантов папки",
    (e) => e.file ?? `${e.rule}\0${e.item}`,
    (e, have) => `${e.file ?? `исключение ${e.item}`}: правила «${e.rule}» нет ни у одного инварианта папки (${have}) — поправь rule или ${e.file ? "удали файл" : "убери исключение"}`,
  );
  reconcile(ledger.marks, marks, "отметки с rule — к правилам инвариантов папки", (m) => `${m.file}:${m.line}`, (m, have) => `${m.file}:${m.line}: правила «${m.rule}» нет ни у одного инварианта папки (${have}) — поправь отметку или убери её`);
}

/** Строки в коде других файлов папки решения теста: правила их инвариантов, которых этот прогон не видит. */
function stringsBeside(file: string): Set<string> {
  const out = new Set<string>();
  for (const f of filesUnder(folderOf(file))) {
    if (f === file || !CODE.test(f)) continue;
    for (const s of stringsOf(readFileSync(path.resolve(process.cwd(), f), "utf8"), f)) out.add(s);
  }
  return out;
}

/** Что сделать с ненужным исключением: убрать отметку, удалить файл исключения, а исключение без файла — убрать из списка. */
const dropHint = (e: Exception): string => (e.line ? `убери отметку в ${e.file}:${e.line}` : e.file ? `убери исключение: удали ${e.file}` : "убери исключение");

/**
 * Отметки папки в файлах элементов (`fileOf`): «вне охвата» и исключения по ключу элемента; отметки с `rule` другого
 * инварианта — сверке правил. Отметку в файле двух элементов не берёт ни один — упавший тест: к какому, неизвестно.
 */
function elementMarks<T>(it: It, spec: Invariant<T>, key: (item: T) => string, tag: string): { outside: Outside[]; exceptions: Exception[]; skipped: Mark[] } {
  const out = { outside: [] as Outside[], exceptions: [] as Exception[], skipped: [] as Mark[] };
  const folder = spec.fileOf && callerFolder();
  if (!folder) return out;
  const decision = path.posix.basename(folder);
  const byFile = new Map<string, string[]>();
  for (const item of spec.items) {
    const f = spec.fileOf!(item);
    if (f) byFile.set(f, [...(byFile.get(f) ?? []), key(item)]);
  }
  const shared: string[] = [];
  for (const [file, keys] of byFile) {
    let text: string;
    try {
      text = readFileSync(path.resolve(process.cwd(), file), "utf8");
    } catch {
      continue; // файла нет — нет и отметок
    }
    if (!text.includes("spec-")) continue;
    const mine = marksIn(file, text).filter((m) => m.decision === decision);
    out.skipped.push(...mine.filter((m) => m.rule && m.rule !== spec.rule));
    const marks = mine.filter((m) => !m.rule || m.rule === spec.rule);
    if (!marks.length) continue;
    if (keys.length > 1) {
      shared.push(`${file}:${marks[0]!.line}: отметку читают элементы ${keys.join(", ")} — к какому, неизвестно: элементу без своего файла — outside и exceptions/`);
      continue;
    }
    for (const m of marks) {
      if (m.kind === "outside") out.outside.push({ item: keys[0]!, reason: m.reason, file, line: m.line });
      else out.exceptions.push({ item: keys[0]!, issue: m.issue ?? 0, reason: m.reason, ...(m.rule ? { rule: m.rule } : {}), file, line: m.line });
    }
  }
  if (shared.length) {
    it(`отметка — в файле одного элемента${tag}`, () => {
      throw new Error(shared.join("\n"));
    });
  }
  return out;
}

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
  // отметка в файле элемента — его запись; та же запись ещё и в тесте или exceptions/ — упавший тест, действует отметка
  const marks = elementMarks(it, spec, key, tag);
  const marked = new Map<string, string>();
  const twice: string[] = [];
  for (const m of [...marks.outside, ...marks.exceptions]) {
    const at = `${m.file}:${m.line}`;
    if (marked.has(m.item)) twice.push(`${m.item}: отметки ${marked.get(m.item)} и ${at} — оставь одну`);
    else marked.set(m.item, at);
  }
  // исключение без правила — ко всем соглашениям папки, с правилом — только к своему
  const listed = [...(spec.exceptions ?? []).filter((e) => !e.rule || e.rule === spec.rule), ...(spec.outside ?? [])] as (Exception | Outside)[];
  for (const x of listed.filter((x) => marked.has(x.item))) twice.push(`${x.item}: отметка ${marked.get(x.item)} и ${x.file ?? "outside в тесте"} — оставь одно`);
  if (twice.length) {
    it(`у элемента одна запись — отметка или exceptions/ и outside${tag}`, () => {
      throw new Error(twice.join("\n"));
    });
  }
  const unmarked = <X extends { item: string }>(xs: readonly X[] | undefined): X[] => (xs ?? []).filter((x) => !marked.has(x.item));
  const excepted = new Map([...unmarked(spec.exceptions).filter((e) => !e.rule || e.rule === spec.rule), ...marks.exceptions].map((e) => [e.item, e]));
  const outside = new Map<string, Outside>([...unmarked(spec.outside), ...marks.outside].map((o) => [o.item, o]));
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
      if (!o.reason.trim()) throw new Error(`у элемента вне охвата ${o.item} нет причины${o.line ? ` — допиши причину в отметку ${o.file}:${o.line}` : ""}`);
      if (!byKey.has(o.item)) throw new Error(`элемента ${o.item} в реестре «${spec.registry}» нет — убери из охвата`);
    });
  }
  // храповик: исключение живёт, пока элемент нарушает соглашение; начал соблюдать — исключение убрать
  const exceptions = [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  for (const e of exceptions) {
    meta(`исключение${tag}: ${e.item} (#${e.issue})`, { issue: e.issue, reason: e.reason });
    it(`исключение${tag}: ${e.item} (#${e.issue})`, async () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`у исключения ${e.item} нет задачи — ${e.line ? `допиши #N в отметку ${e.file}:${e.line}` : "issue: номер задачи, которая снимет долг"}`);
      if (!e.reason.trim()) throw new Error(`у исключения ${e.item} нет причины${e.line ? ` — допиши причину в отметку ${e.file}:${e.line}` : ""}`);
      if (!byKey.has(e.item)) throw new Error(`элемента ${e.item} в реестре «${spec.registry}» нет — ${dropHint(e)}`);
      try {
        await spec.check(byKey.get(e.item)!);
      } catch {
        return;
      }
      throw new Error(`${e.item} уже соблюдает соглашение — ${dropHint(e)} (#${e.issue})`);
    });
  }
  unknownRules(it, spec.rule, spec.exceptions ?? [], marks.skipped);
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
 * Реестр файлов кода в каталогах и файлах (от корня; файл — конфиг в корне пакета, `vite.config.ts`): список дешёвый,
 * текст читается при первом обращении — разбор всего `src/` идёт в проверке элемента, а не при сборе тестов.
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

/**
 * Файлы кода в каталогах (от корня), по порядку, без повторов; элемент `dirs` — каталог или файл кода (конфиг в корне
 * пакета); которого нет — пропускается.
 */
export function codeFiles(root: string, dirs: string[]): string[] {
  const out = new Set<string>();
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      // не каталог — файл кода сам по себе
      if ((e as { code?: string }).code === "ENOTDIR" && CODE.test(rel)) out.add(rel);
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
      } else if (CODE.test(e.name)) out.add(child);
    }
  };
  for (const d of dirs) walk(d.replace(/\/+$/, ""));
  return [...out].sort();
}

/**
 * Текст без комментариев (заменены пробелами, переводы строк сохранены): сканеры кода не видят прозу и старый код.
 * Комментарии — по разбору парсером, как у сканера названий: `//` в строке или тексте JSX — не комментарий. `file` —
 * путь для разбора по расширению (`.tsx` — с JSX; нет — TypeScript, затем TSX); исходник, который не разобрать, — ошибка.
 */
export function codeOnly(text: string, file?: string): string {
  let out = "";
  let at = 0;
  for (const [i, c] of commentsOf(text, file)) {
    out += text.slice(at, i) + c.replace(/[^\n]/g, " ");
    at = i + c.length;
  }
  return out + text.slice(at);
}

/**
 * Отключения линт-правил в файле: `// eslint-disable-next-line a, b -- #12 причина` и такие же блочные комментарии.
 * ESLint читает директивы только в комментариях: `// eslint-disable` в строке — фикстура или сообщение, не отключение.
 */
export function disablesIn(file: string, text: string): Disable[] {
  const out: Disable[] = [];
  for (const [at, comment] of commentsOf(text, file)) {
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
const journaled = new Set<string>();
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
 * (`SPEC_JOURNAL` — другой каталог, у каждого раннера свой: `.spec-journal/unit`); сверку с реестром делает
 * `spec-claims` после прогона всех тестов и шардов.
 */
export function journal(id: string, opts: { test?: string; root?: string } = {}): void {
  const root = opts.root ?? process.cwd();
  const test = opts.test ? path.relative(root, path.resolve(root, opts.test)).split(path.sep).join("/") : callerTest(root);
  const key = `${id}\0${test}`;
  if (journaled.has(key)) return;
  journaled.add(key);
  if (!journalFile) {
    const dir = journalDir(root);
    mkdirSync(dir, { recursive: true });
    journalFile = path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  }
  appendFileSync(journalFile, JSON.stringify({ id, test }) + "\n");
}

const journalDir = (root: string): string => path.resolve(root, process.env.SPEC_JOURNAL ?? ".spec-journal");

/**
 * Начало прогона — журналы прежних прогонов долой: иначе удалённый тест продолжает «вызывать» точку входа. Зовётся раз
 * на прогон раннера, до тестов (globalSetup Vitest и Playwright, preload bun test); стирает `*.jsonl` своего каталога
 * (`SPEC_JOURNAL`), подкаталоги — журналы других раннеров — не трогает.
 */
export function resetJournal(opts: { root?: string } = {}): void {
  const dir = journalDir(opts.root ?? process.cwd());
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) rmSync(path.join(dir, f), { force: true });
  }
  journalFile = null;
  journaled.clear();
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

/**
 * Имена переменных окружения, которые читает исходник. Параметр один: проект зовёт `sources.flatMap(envNamesIn)`, а
 * второй необязательный получил бы индекс `flatMap` — ошибка типов (#303). Файл известен — `envNamesInCode`.
 */
export function envNamesIn(source: string): string[] {
  return envNamesInCode(codeOnly(source));
}

/** То же по коду без комментариев — `codeOnly(text, file)`: набор плагинов разбора по расширению файла. */
export function envNamesInCode(text: string): string[] {
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

/** Переменные окружения, которые читает код: имя → файлы. */
function envReads(root: string, dirs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of codeFiles(root, dirs)) {
    for (const n of envNamesInCode(codeOnly(readFileSync(path.join(root, file), "utf8"), file))) out.set(n, [...new Set([...(out.get(n) ?? []), file])]);
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
