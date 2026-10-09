/**
 * locale — язык проекта и названия на нём, один модуль на скрипты всех скиллов и установщик: `est`, `spec` и
 * `dashboard` импортируют его из `github` — словарь один, в `locales/` этого скилла, а `github` от них не зависит;
 * `bin/ai-dev.mjs` — из своего пакета.
 *
 * Язык — `language` в `.agents/ai-dev.json` корня проекта (ближайший вверх каталог с `.git`, иначе сам каталог):
 * манифест без поля (установка прошлой версии) — `ru`, манифеста нет — `en`. Названия — `locales/<язык>.json`, одни
 * ключи у каждого языка; файла языка нет — `en`. Пишут скрипты на языке проекта, разбирают — названия любого языка словаря (`everyNames`): проект,
 * сменивший язык, и задачи чужих репозиториев читаются без знания их языка.
 *
 * CommonJS, а не TypeScript: словарь ищется от `__dirname`, а харнесс `spec`, который импортирует модуль, Playwright и
 * Jest грузят как CommonJS — там `import.meta` синтаксическая ошибка (tests/standards/harness-load); установщик npx
 * запускает из node_modules, где Node не стирает типы. Типы — `locale.d.cts`.
 */
"use strict";

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

/** Код языка BCP 47: язык и необязательные подтеги — `ru`, `en`, `pt-BR`, `zh-Hant`. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const DEFAULT_LANGUAGE = "en";
/** Язык установки прошлой версии — манифест без поля `language`: флоу до поля работал только по-русски. */
const LEGACY_LANGUAGE = "ru";
const LOCALES = path.join(__dirname, "..", "locales");

/** Корень проекта: ближайший вверх каталог с `.git` (каталог или файл worktree), иначе сам каталог. */
function projectRoot(dir) {
  const start = path.resolve(dir);
  for (let d = start; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return start;
  }
}

/** Язык проекта каталога `dir` (по умолчанию — текущего). */
function projectLanguage(dir = process.cwd()) {
  const file = path.join(projectRoot(dir), ".agents", "ai-dev.json");
  if (!existsSync(file)) return DEFAULT_LANGUAGE;
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    // битый манифест — как манифест без поля
  }
  return typeof manifest.language === "string" && LANGUAGE_CODE.test(manifest.language) ? manifest.language : LEGACY_LANGUAGE;
}

const cache = new Map();

/** Названия языка: `locales/<язык>.json`, файла нет — `en`. */
function names(language) {
  const lang = existsSync(path.join(LOCALES, `${language}.json`)) ? language : DEFAULT_LANGUAGE;
  if (!cache.has(lang)) cache.set(lang, JSON.parse(readFileSync(path.join(LOCALES, `${lang}.json`), "utf8")));
  return cache.get(lang);
}

/** Языки словаря — файлы `locales/*.json`, `en` первым. */
function languages() {
  const all = readdirSync(LOCALES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
  return [DEFAULT_LANGUAGE, ...all.filter((l) => l !== DEFAULT_LANGUAGE)];
}

/** Названия всех языков словаря — для разбора. */
function everyNames() {
  return languages().map(names);
}

/** Одно название во всех языках словаря без повторов: `every((n) => n.sections.questions)`. */
function every(pick) {
  return [...new Set(everyNames().map(pick))];
}

/** Подстановка `{имя}` в шаблон названия; неизвестное имя остаётся как есть. */
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

/** Форма слова для числа по правилам языка (CLDR: one, few, many, other); формы нет — other. */
function plural(language, forms, n) {
  const form = new Intl.PluralRules(language).select(n);
  return forms[form] ?? forms.other;
}

/** «12 тестов»: число и форма слова. */
function count(language, forms, n) {
  return `${n} ${plural(language, forms, n)}`;
}

/** Регулярка из названия: спецсимволы экранированы. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { LANGUAGE_CODE, DEFAULT_LANGUAGE, LEGACY_LANGUAGE, projectRoot, projectLanguage, names, languages, everyNames, every, fill, plural, count, escapeRe };
