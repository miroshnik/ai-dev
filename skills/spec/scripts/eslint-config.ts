/**
 * eslint-config — assembling ESLint rules from the spec tree: a standard's rule lives as an `eslint.ts` fragment
 * (default — a flat config object or array) in its folder, next to the examples and the reason, and the project's
 * `eslint.config.*` only collects the fragments — `lint` and the editor see the rule as usual:
 *
 *   import { collectEslint } from "./.agents/skills/spec/scripts/eslint-config.ts";
 *   export default [...base, ...(await collectEslint(import.meta.dirname))];
 *
 * `files` paths in a fragment are from the project root. Fragments go in path order: the config is the same on any
 * machine. `tests/lib` holds helpers, not fragments. Node loads an `eslint.mts` fragment as ESM even in a project
 * without `"type": "module"`. Only `node:` APIs and erasable TypeScript: Node ≥ 22.18 imports a `.ts` fragment without
 * a build.
 *
 * A standard's ban is `restrict(...)`: its own rule `spec/<id>` per standard. Flat config doesn't merge one rule's
 * options: with two fragments setting `no-restricted-syntax` on the same files, the last one wins and the first one's
 * bans silently vanish.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRAGMENT = new Set(["eslint.ts", "eslint.mts", "eslint.mjs", "eslint.js"]);
const SKIP = new Set(["node_modules", ".git"]);
// test helpers, not the spec: `spec-doc` skips them too
const SKIP_REL = new Set(["tests/lib"]);

/** Paths of `eslint.ts` fragments in the directories (by default `tests/`), in order. */
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
 * Flat config fragments from the spec tree — for the project's `eslint.config.*`. First — the exceptions ratchet: a rule
 * disabled in code that no longer silences anything is an error (the exception must go, the debt only shrinks).
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

/** The shared plugin of standards' bans: one object for all fragments — ESLint doesn't allow redefining a plugin. */
const SPEC_PLUGIN: { meta: { name: string }; rules: Record<string, object> } = { meta: { name: "spec" }, rules: {} };

/**
 * A standard's ban by AST selectors (as in `no-restricted-syntax`) — as its own rule `spec/<id>` in the shared `spec`
 * plugin: bans of different standards on the same files all apply. A standard's `eslint.ts` fragment:
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
