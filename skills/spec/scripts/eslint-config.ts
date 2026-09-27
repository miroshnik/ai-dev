/**
 * eslint-config — сборка правил ESLint из дерева спеки: у стандарта правило лежит фрагментом `eslint.ts` (default —
 * объект или массив flat config) в его папке, рядом с примерами и причиной, а `eslint.config.*` проекта только
 * собирает фрагменты — `lint` и редактор видят правило как обычно:
 *
 *   import { collectEslint } from "./.agents/skills/spec/scripts/eslint-config.ts";
 *   export default [...base, ...(await collectEslint(import.meta.dirname))];
 *
 * Пути `files` во фрагменте — от корня проекта. Порядок фрагментов — по пути: конфиг одинаков на любой машине.
 * `tests/lib` — хелперы, не фрагменты. Фрагмент `eslint.mts` Node грузит как ESM и в проекте без `"type": "module"`.
 * Только `node:`-API и стираемый TypeScript: фрагмент `.ts` импортирует Node ≥ 22.18 без сборки.
 *
 * Запрет стандарта — `restrict(...)`: своё правило `spec/<id>` на стандарт. Flat config опции одного правила не сливает:
 * два фрагмента с `no-restricted-syntax` на одни файлы — действует последний, запреты первого молча пропадают.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRAGMENT = new Set(["eslint.ts", "eslint.mts", "eslint.mjs", "eslint.js"]);
const SKIP = new Set(["node_modules", ".git"]);
// хелперы тестов, не спека: `spec-doc` их тоже пропускает
const SKIP_REL = new Set(["tests/lib"]);

/** Пути фрагментов `eslint.ts` в каталогах (по умолчанию `tests/`), по порядку. */
export function eslintFragments(root: string, dirs: string[] = ["tests"]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !SKIP_REL.has(path.relative(root, full).split(path.sep).join("/"))) walk(full);
      } else if (FRAGMENT.has(e.name)) out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out.sort();
}

/**
 * Фрагменты flat config из дерева спеки — для `eslint.config.*` проекта. Первым — храповик исключений: отключение
 * правила в коде, которое больше ничего не глушит, — ошибка (исключение надо убрать, долг только уменьшается).
 */
export async function collectEslint(root: string, dirs: string[] = ["tests"]): Promise<object[]> {
  const configs: object[] = [{ linterOptions: { reportUnusedDisableDirectives: "error" } }];
  for (const file of eslintFragments(root, dirs)) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: object | object[] };
    if (!mod.default) throw new Error(`${path.relative(root, file)}: нет export default — фрагмента flat config`);
    configs.push(...(Array.isArray(mod.default) ? mod.default : [mod.default]));
  }
  return configs;
}

type RuleContext = { report(d: { node: unknown; message: string }): void };

/** Общий плагин запретов стандартов: один объект на все фрагменты — ESLint не даёт переопределить плагин. */
const SPEC_PLUGIN: { meta: { name: string }; rules: Record<string, object> } = { meta: { name: "spec" }, rules: {} };

/**
 * Запрет стандарта по селекторам AST (как у `no-restricted-syntax`) — своим правилом `spec/<id>` в общем плагине `spec`:
 * запреты разных стандартов на одни файлы действуют все. Фрагмент `eslint.ts` стандарта:
 *
 *   export default restrict({ id: "no-alert", selectors: ["CallExpression[callee.name='alert']"], message: "…", files: ["src/**"] });
 */
export function restrict(o: { id: string; selectors: string[]; message: string; files: string[]; ignores?: string[] }): object[] {
  SPEC_PLUGIN.rules[o.id] = {
    meta: { type: "problem", schema: [], docs: { description: o.message } },
    create(context: RuleContext) {
      return Object.fromEntries(o.selectors.map((sel) => [sel, (node: unknown) => context.report({ node, message: o.message })]));
    },
  };
  return [{ files: o.files, ...(o.ignores ? { ignores: o.ignores } : {}), plugins: { spec: SPEC_PLUGIN }, rules: { [`spec/${o.id}`]: "error" } }];
}
