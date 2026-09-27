/**
 * eslint-config — сборка правил ESLint из дерева спеки: у стандарта правило лежит фрагментом `eslint.ts` (default —
 * объект или массив flat config) в его папке, рядом с примерами и причиной, а `eslint.config.*` проекта только
 * собирает фрагменты — `lint` и редактор видят правило как обычно:
 *
 *   import { collectEslint } from "./.agents/skills/spec/scripts/eslint-config.ts";
 *   export default [...base, ...(await collectEslint(import.meta.dirname))];
 *
 * Пути `files` во фрагменте — от корня проекта. Порядок фрагментов — по пути: конфиг одинаков на любой машине.
 * Только `node:`-API и стираемый TypeScript: фрагмент `.ts` импортирует Node ≥ 22.18 без сборки.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRAGMENT = new Set(["eslint.ts", "eslint.mjs", "eslint.js"]);
const SKIP = new Set(["node_modules", ".git"]);

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
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path.join(dir, e.name));
      } else if (FRAGMENT.has(e.name)) out.push(path.join(dir, e.name));
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
