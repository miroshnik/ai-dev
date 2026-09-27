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
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  /** Заведомый нарушитель: проверка обязана на нём упасть — иначе она ничего не проверяет. */
  violator: { name: string; item: T };
  /** Ключ элемента для исключений — стабильный идентификатор (имя, путь); по умолчанию — название теста. */
  key?: (item: T) => string;
  /** Исключения — из `exceptions.ts` папки решения: элемент, задача, которая его снимет, и причина. */
  exceptions?: readonly Exception[];
}

/** Исключение из соглашения: ключ элемента, номер задачи, которая снимет долг, и причина. */
export interface Exception {
  item: string;
  issue: number;
  reason: string;
}

/**
 * Тесты соглашения: «реестр не пуст» (опечатка в пути не проходит молча), «нарушитель не проходит» (проверка умеет
 * падать) и по тесту на элемент. В названиях нет счётчиков: реестр растёт — в диффе спеки только новые элементы.
 */
export function invariant<T>(it: It, spec: Invariant<T>): void {
  it(`реестр «${spec.registry}» не пуст`, () => {
    if (!spec.items.length) throw new Error(`реестр «${spec.registry}» пуст — проверять нечего: путь или выборка реестра ошибочны`);
  });
  it(`нарушитель не проходит: ${spec.violator.name}`, async () => {
    try {
      await spec.check(spec.violator.item);
    } catch {
      return;
    }
    throw new Error(`проверка прошла на нарушителе «${spec.violator.name}» — она ничего не проверяет`);
  });
  const key = spec.key ?? spec.name;
  const excepted = new Map((spec.exceptions ?? []).map((e) => [e.item, e]));
  const byKey = new Map(spec.items.map((item) => [key(item), item]));
  // по названию, а не в порядке реестра: порядок файлов и запросов зависит от машины, а спека — нет
  const named = spec.items.filter((item) => !excepted.has(key(item))).map((item) => ({ name: spec.name(item), item }));
  named.sort(byName);
  for (const { name, item } of named) {
    it(name, async () => {
      await spec.check(item);
    });
  }
  // храповик: исключение живёт, пока элемент нарушает соглашение; начал соблюдать — исключение убрать
  const exceptions = [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  for (const e of exceptions) {
    it(`исключение: ${e.item} (#${e.issue})`, async () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`у исключения ${e.item} нет задачи — issue: номер задачи, которая снимет долг`);
      if (!e.reason.trim()) throw new Error(`у исключения ${e.item} нет причины`);
      if (!byKey.has(e.item)) throw new Error(`элемента ${e.item} в реестре «${spec.registry}» нет — убери исключение из exceptions.ts`);
      try {
        await spec.check(byKey.get(e.item)!);
      } catch {
        return;
      }
      throw new Error(`${e.item} уже соблюдает соглашение — убери исключение из exceptions.ts (#${e.issue})`);
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
}

/** Пример к правилу: название (утверждение), путь от корня проекта и код. */
export interface Example {
  name: string;
  path: string;
  code: string;
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
  if (!spec.bad.length) {
    it(`у правила ${spec.rule} есть пример «нельзя»`, () => {
      throw new Error(`у правила ${spec.rule} нет примера «нельзя» — доказать, что оно умеет падать, нечем`);
    });
  }
  for (const e of spec.bad) {
    it(`нельзя: ${e.name}`, async () => {
      if (!(await fires(e)).length) throw new Error(`правило ${spec.rule} не сработало: ${e.path}`);
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
export function eslintLinter(opts: { cwd?: string; module?: string } = {}): Linter {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  type Engine = { lintText(code: string, o: { filePath: string }): Promise<{ messages: LintMessage[] }[]> };
  let engine: Promise<Engine> | null = null;
  const load = async (): Promise<Engine> => {
    const entry = opts.module ?? createRequire(path.join(cwd, "package.json")).resolve("eslint");
    const { ESLint } = (await import(pathToFileURL(entry).href)) as { ESLint: new (o: { cwd: string }) => Engine };
    return new ESLint({ cwd });
  };
  return {
    async lint(code, filePath) {
      engine ??= load();
      const [result] = await (await engine).lintText(code, { filePath: path.join(cwd, filePath) });
      return (result?.messages ?? []).map((m) => ({ ruleId: m.ruleId, message: m.message, fatal: m.fatal }));
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
const DIRECTIVE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?=\s|\*\/|$)([^\n]*?)(?:\*\/|$)/gm;

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

/** Отключения линт-правил в файле: `// eslint-disable-next-line a, b -- #12 причина` и такие же блочные комментарии. */
export function disablesIn(file: string, text: string): Disable[] {
  const out: Disable[] = [];
  for (const m of text.matchAll(DIRECTIVE)) {
    const [head, ...desc] = m[1]!.split(/\s--\s|\s--$/);
    out.push({
      file,
      line: text.slice(0, m.index).split("\n").length,
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
    it(`исключения в ${file}: ${rules.join(", ")}`, () => {
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
const STACK_FILE = /(?:\(|\bat\s+)(?:file:\/\/)?(\/[^()\n]*?\.(?:test|spec|e2e)\.[cm]?[jt]sx?)(?=:\d+:\d+)/g;
const seen = new Set<string>();
let journalFile: string | null = null;

/** Файл теста, из которого идёт вызов, от корня проекта — по стеку; не из теста — null. */
function callerTest(root: string): string | null {
  for (const m of (new Error().stack ?? "").matchAll(STACK_FILE)) {
    const abs = m[1]!;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!rel.startsWith("..")) return rel;
    const i = abs.indexOf("/tests/");
    if (i >= 0) return abs.slice(i + 1);
  }
  return null;
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

// виды находок knip (knip.dev, «Reporters», JSON) → тест и префикс ключа исключения
const KNIP: [string, string, string[]][] = [
  ["нет файлов без потребителя", "file", ["files"]],
  ["нет экспортов без потребителя", "export", ["exports", "nsExports"]],
  ["нет типов без потребителя", "type", ["types", "nsTypes"]],
  ["нет зависимостей без импорта", "dependency", ["dependencies", "devDependencies", "optionalPeerDependencies"]],
  ["нет импортов неустановленных пакетов", "unlisted", ["unlisted"]],
  ["нет нерезолвящихся импортов", "unresolved", ["unresolved"]],
];

/** Находки knip по видам: ключ вида (`file:…`, `export:<файл>#<имя>`, `dependency:<пакет>`) → то, что показать. */
function knipFindings(report: { issues?: Record<string, unknown>[] }): Map<string, Map<string, string>> {
  const out = new Map(KNIP.map(([, kind]) => [kind, new Map<string, string>()]));
  for (const issue of report.issues ?? []) {
    const file = String(issue.file ?? "");
    for (const [, kind, keys] of KNIP) {
      for (const k of keys) {
        for (const item of (issue[k] as { name: string }[] | undefined) ?? []) {
          const shown = kind === "file" ? item.name : kind === "dependency" || kind === "unlisted" ? item.name : `${file}#${item.name}`;
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
export function deadCode(it: It, opts: { root: string; report?: string; exceptions?: readonly Exception[] }): void {
  let findings: Map<string, Map<string, string>> | null = null;
  const load = (): Map<string, Map<string, string>> => {
    if (findings) return findings;
    let text: string;
    if (opts.report) text = readFileSync(path.resolve(opts.root, opts.report), "utf8");
    else {
      const r = spawnSync(path.join(opts.root, "node_modules", ".bin", "knip"), ["--reporter", "json"], { cwd: opts.root, encoding: "utf8" });
      if (r.error) throw new Error(`knip не запустился: ${r.error.message} — установи knip в проект или передай report`);
      text = r.stdout;
    }
    findings = knipFindings(JSON.parse(text || "{}"));
    return findings;
  };
  const excepted = new Map((opts.exceptions ?? []).map((e) => [e.item, e]));
  for (const [name, kind] of KNIP) {
    it(name, () => {
      const found = [...load().get(kind)!].filter(([key]) => !excepted.has(key)).map(([, shown]) => shown).sort();
      if (found.length) throw new Error(found.join("\n"));
    });
  }
  for (const e of [...excepted.values()].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    it(`исключение: ${e.item} (#${e.issue})`, () => {
      if (!Number.isInteger(e.issue) || e.issue <= 0) throw new Error(`у исключения ${e.item} нет задачи`);
      if (!e.reason.trim()) throw new Error(`у исключения ${e.item} нет причины`);
      const kind = e.item.split(":")[0]!;
      if (!load().get(kind)?.has(e.item)) throw new Error(`knip больше не находит ${e.item} — убери исключение (#${e.issue})`);
    });
  }
}

const ENV_READ = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)|\bprocess\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)|\{([^{}]*)\}\s*=\s*process\.env\b/g;
const ENV_SERVICE = ["NODE_ENV", "CI", "TZ", "PORT", "HOME", "PATH", "PWD", "DEV", "PROD", "MODE", "SSR", "BASE_URL"];

/** Переменные окружения, которые читает код: имя → файлы. */
function envReads(root: string, dirs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of codeFiles(root, dirs)) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(ENV_READ)) {
      const names = m[4] ? m[4].split(",").map((x) => x.split(":")[0]!.trim()).filter((x) => /^[A-Z_][A-Z0-9_]*$/.test(x)) : [m[1] ?? m[2] ?? m[3]!];
      for (const n of names) out.set(n, [...new Set([...(out.get(n) ?? []), file])]);
    }
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
  opts: { root: string; dirs?: string[]; declared: readonly string[]; ignore?: readonly string[]; exceptions?: readonly Exception[] },
): void {
  const skip = new Set([...ENV_SERVICE, ...(opts.ignore ?? [])]);
  const reads = envReads(opts.root, opts.dirs ?? ["src"]);
  const declared = new Set(opts.declared);
  invariant(it, {
    registry: "переменные окружения в коде",
    items: [...reads.keys()].filter((v) => !skip.has(v)),
    name: (v) => `${v} объявлена`,
    key: (v) => v,
    check: (v) => {
      if (!declared.has(v)) throw new Error(`${v} читается в ${reads.get(v)!.join(", ")}, но не объявлена в схеме окружения`);
    },
    violator: { name: "переменная без объявления", item: "__НЕ_ОБЪЯВЛЕНА__" },
    exceptions: opts.exceptions,
  });
  invariant(it, {
    registry: "объявленные переменные окружения",
    items: [...declared].filter((v) => !skip.has(v)),
    name: (v) => `${v} читается в коде`,
    key: (v) => v,
    check: (v) => {
      if (!reads.has(v)) throw new Error(`${v} объявлена, но не читается — убери из схемы окружения`);
    },
    violator: { name: "объявлена и не читается", item: "__НЕ_ЧИТАЕТСЯ__" },
    exceptions: opts.exceptions,
  });
}
