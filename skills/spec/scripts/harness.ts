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
  // по названию, а не в порядке реестра: порядок файлов и запросов зависит от машины, а спека — нет
  const named = spec.items.map((item) => ({ name: spec.name(item), item }));
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, item } of named) {
    it(name, async () => {
      await spec.check(item);
    });
  }
}

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
