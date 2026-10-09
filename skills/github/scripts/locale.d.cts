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
    labels: { questions: string; epicDescription: string };
    status: { backlog: string; inProgress: string; done: string };
    fields: { estimate: string; actual: string; tokens: string; cost: string };
    views: { board: string; table: string; roadmap: string };
    labelMarkers: { decision: string; slice: string; architecturePath: string };
    comments: { state: string; actual: string; closedByPr: string };
    subagentPrompt: { task: string; epic: string };
    /** Баг на красную основную ветку: заголовок «<base> is red: <чеки>». */
    mainRed: { title: string; check: string; checks: string };
    /** Задание субагенту актуализации блока (`github task actualize`). */
    actualize: { lead: string; shipped: string; prs: string; noPr: string; epic: string; openTask: string; checks: string; scope: string; comment: string; answer: string };
    /** Комментарии «Оценка» и «Факт» скилла est и строки, которые в них дописывает человек. */
    est: {
      answer: string;
      manual: string;
      reason: string;
      hours: string;
      fact: {
        unavailable: string;
        body: string;
        estimate: string;
        noEstimate: string;
        sessions: Plural;
        prompts: Plural;
        subagents: Plural;
        commits: Plural;
        prs: string;
        noPr: string;
        diff: string;
        diffLines: string;
        diffNa: string;
        shared: string;
        commitUnit: string;
        taken: string;
        overlap: string;
        cloudMissing: string;
        tokens: string;
        tokensSplit: string;
        cost: string;
        unpriced: string;
        steps: string;
        and: string;
        cloudAgent: string;
      };
      cloud: { actual: string; body: string; tokens: string; cost: string; fields: string; unavailable: string; session: string };
      estimate: {
        headline: string;
        tokens: string;
        partial: string;
        body: string;
        auto: string;
        forecast: string;
        expertOver: string;
        expert: string;
        spread: string;
        correction: string;
        tokCorrection: string;
        k: string;
        noK: string;
        levelRepo: string;
        levelAll: string;
        none: string;
        otherProject: string;
        analog: string;
        unknown: string;
        partialCoverage: string;
        notInProject: string;
        labels: Plural;
        type: string;
        words: Plural;
        size: string;
      };
    };
    /** Описание коммита копии флоу, который подсказывает `update`: «ai-dev flow <тег>». */
    updateCommit: string;
    standardIssue: string;
    autoAnswer: string;
    lastLine: { done: string; questions: string; remaining: string };
    prSpecSection: string;
    spec: SpecNames;
  }

  /** Названия скилла spec: документация `spec-doc`, раздел PR `spec-diff`, схемы `c4`, тесты харнесса. */
  interface SpecNames {
    /** «12 тестов» — счётчики spec-doc и spec-diff. */
    tests: Plural;
    /** Отключение линта: без правил — все, без описания — без причины. */
    lint: { allRules: string; noReason: string };
    /** Документация `docs/spec`: шапка-метка, заголовки, разделы трёх корней, счётчики и пометки тестов. */
    doc: {
      mark: string;
      title: string;
      intro: string;
      capabilities: string;
      architecture: string;
      standards: string;
      skippedCount: Plural;
      failingCount: Plural;
      variants: Plural;
      skipped: string;
      failing: string;
      todo: string;
      outside: string;
      outsideIntro: string;
      nameDebt: string;
      nameReason: string;
      none: string;
      rules: string;
    };
    /** Страница архитектуры и схемы C4 из модели. */
    c4: {
      title: string;
      intro: string;
      system: string;
      context: string;
      containers: string;
      components: string;
      perimeter: string;
      viaModule: string;
      viaModules: string;
      uses: string;
      dependsOn: string;
      calls: string;
      library: string;
      table: string;
      summary: string;
      moduleCount: Plural;
      containerCount: Plural;
      externalCount: Plural;
    };
  }

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
