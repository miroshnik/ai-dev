/**
 * locale — the project language and the names in it, one module for the scripts of all skills and the installer: `est`,
 * `spec` and `dashboard` import it from `github` — there's one dictionary, in this skill's `locales/`, and `github`
 * doesn't depend on them; `bin/ai-dev.mjs` imports it from its own package.
 *
 * The language is `language` in `.agents/ai-dev.json` of the project root (the nearest directory up with `.git`,
 * otherwise the directory itself): a manifest without the field (an install of a previous version) — `ru`, no
 * manifest — `en`. Names are `locales/<language>.json`, the same keys for each language; no file for the language —
 * `en`. Scripts write in the project language and parse the names of any dictionary language (`everyNames`): a
 * project that changed its language and tasks of other repositories are read without knowing their language.
 *
 * CommonJS, not TypeScript: the dictionary is looked up from `__dirname`, and the `spec` harness that imports the
 * module is loaded by Playwright and Jest as CommonJS — `import.meta` is a syntax error there
 * (tests/standards/harness-load); npx runs the installer from node_modules, where Node doesn't strip types. Types are
 * in `locale.d.cts`.
 */
"use strict";

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

/** A BCP 47 language code: the language and optional subtags — `ru`, `en`, `pt-BR`, `zh-Hant`. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const DEFAULT_LANGUAGE = "en";
/**
 * The language of an install of a previous version — a manifest without the `language` field: before the field the flow
 * worked only in Russian.
 */
const LEGACY_LANGUAGE = "ru";
const LOCALES = path.join(__dirname, "..", "locales");

/**
 * The project root: the nearest directory up with `.git` (a directory or a worktree file), otherwise the directory
 * itself.
 */
function projectRoot(dir) {
  const start = path.resolve(dir);
  for (let d = start; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return start;
  }
}

/** The project language of the `dir` directory (by default — the current one). */
function projectLanguage(dir = process.cwd()) {
  const file = path.join(projectRoot(dir), ".agents", "ai-dev.json");
  if (!existsSync(file)) return DEFAULT_LANGUAGE;
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    // a broken manifest — like a manifest without the field
  }
  return typeof manifest.language === "string" && LANGUAGE_CODE.test(manifest.language) ? manifest.language : LEGACY_LANGUAGE;
}

const cache = new Map();

/** The names of a language: `locales/<language>.json`, no file — `en`. */
function names(language) {
  const lang = existsSync(path.join(LOCALES, `${language}.json`)) ? language : DEFAULT_LANGUAGE;
  if (!cache.has(lang)) cache.set(lang, JSON.parse(readFileSync(path.join(LOCALES, `${lang}.json`), "utf8")));
  return cache.get(lang);
}

/** The dictionary's languages — the `locales/*.json` files, `en` first. */
function languages() {
  const all = readdirSync(LOCALES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
  return [DEFAULT_LANGUAGE, ...all.filter((l) => l !== DEFAULT_LANGUAGE)];
}

/** The names of all dictionary languages — for parsing. */
function everyNames() {
  return languages().map(names);
}

/** One name in all dictionary languages without repeats: `every((n) => n.sections.questions)`. */
function every(pick) {
  return [...new Set(everyNames().map(pick))];
}

/** Substitutes `{var}` in a name template; an unknown variable stays as is. */
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

/** The word form for a number by the language's rules (CLDR: one, few, many, other); no such form — other. */
function plural(language, forms, n) {
  const form = new Intl.PluralRules(language).select(n);
  return forms[form] ?? forms.other;
}

/** "12 tests": the number and the word form. */
function count(language, forms, n) {
  return `${n} ${plural(language, forms, n)}`;
}

/** A regex from a name: special characters escaped. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { LANGUAGE_CODE, DEFAULT_LANGUAGE, LEGACY_LANGUAGE, projectRoot, projectLanguage, names, languages, everyNames, every, fill, plural, count, escapeRe };
