// Типы модуля `locale.cjs`: без них TypeScript проекта с `checkJs` проверял бы сам файл. Names — форма
// `locales/en.json`; у каждого языка те же ключи (стандарт flow-english), типизацию словаря сверяет его тест.

declare namespace locale {
  /** Формы слова для числа по CLDR; у языка без формы — та же, что other. */
  interface Plural {
    one: string;
    few: string;
    many: string;
    other: string;
  }

  /** Названия, которые скрипты пишут в GitHub, в документы и тесты проекта и разбирают оттуда. */
  interface Names {
    issueTypes: { task: string; bug: string; epic: string };
    sections: { questions: string; scenarios: string };
    labels: { questions: string };
    status: { backlog: string; inProgress: string; done: string };
    fields: { estimate: string; actual: string; tokens: string; cost: string };
    views: { board: string; table: string; roadmap: string };
    labelMarkers: { decision: string; slice: string };
    comments: { state: string; actual: string };
    subagentPrompt: { task: string; epic: string };
    standardIssue: string;
    autoAnswer: string;
    lastLine: { done: string; questions: string; remaining: string };
    prSpecSection: string;
    spec: SpecNames;
  }

  /** Названия скилла spec: документация `spec-doc`, раздел PR `spec-diff`, схемы `c4`, тесты харнесса. */
  interface SpecNames {}

  const LANGUAGE_CODE: RegExp;
  const DEFAULT_LANGUAGE: string;
  const LEGACY_LANGUAGE: string;
  /** Корень проекта: ближайший вверх каталог с `.git`, иначе сам каталог. */
  function projectRoot(dir: string): string;
  /** Язык проекта каталога (по умолчанию — текущего): `language` манифеста, без поля — ru, без манифеста — en. */
  function projectLanguage(dir?: string): string;
  /** Названия языка; файла языка нет — en. */
  function names(language: string): Names;
  /** Языки словаря, en первым. */
  function languages(): string[];
  /** Названия всех языков словаря — для разбора. */
  function everyNames(): Names[];
  /** Одно название во всех языках словаря без повторов. */
  function every(pick: (n: Names) => string): string[];
  /** Подстановка `{имя}` в шаблон. */
  function fill(template: string, vars: Record<string, string | number>): string;
  /** Форма слова для числа по правилам языка. */
  function plural(language: string, forms: Plural, n: number): string;
  /** Число и форма слова: «12 тестов». */
  function count(language: string, forms: Plural, n: number): string;
  /** Название для регулярки: спецсимволы экранированы. */
  function escapeRe(text: string): string;
}

export = locale;
