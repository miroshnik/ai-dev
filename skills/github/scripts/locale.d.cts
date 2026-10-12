// Types of the `locale.cjs` module: without them a project's TypeScript with `checkJs` would check the file itself.
// Names is the shape of `locales/en.json`; each language has the same keys (the flow-english standard), the dictionary
// typing is checked by its test.

declare namespace locale {
  /** Word forms for a number by CLDR; a language without a form has the same as other. */
  interface Plural {
    one: string;
    few: string;
    many: string;
    other: string;
  }

  /** Names the scripts write to GitHub, to the project's documents and tests, and parse from there. */
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
    /** A bug about a red default branch: the title "<base> is red: <checks>". */
    mainRed: { title: string; check: string; checks: string };
    /** The assignment for the epic-refresh subagent (`github task actualize`). */
    actualize: { lead: string; shipped: string; prs: string; noPr: string; epic: string; openTask: string; checks: string; scope: string; comment: string; answer: string };
    /** The est skill's "Estimate" and "Actual" comments and the lines a human appends to them. */
    est: {
      answer: string;
      manual: string;
      reason: string;
      hours: string;
      /**
       * Words with which a PR or commit text closes a task (`Closes #N`), space-separated; the words of all languages
       * are parsed.
       */
      closingWords: string;
      /** Service words of a title for picking analogs, space-separated; the words of all languages are dropped. */
      stopWords: string;
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
    /** The description of a flow copy commit that `update` suggests: "ai-dev flow <tag>". */
    updateCommit: string;
    standardIssue: string;
    autoAnswer: string;
    lastLine: { done: string; questions: string; remaining: string };
    prSpecSection: string;
    spec: SpecNames;
  }

  /** Names of the spec skill: the `spec-doc` documentation, the `spec-diff` PR section, `c4` diagrams, harness tests. */
  interface SpecNames {
    /** "12 tests" — the spec-doc and spec-diff counters. */
    tests: Plural;
    /** Disabling the linter: without rules — all of them, without a description — no reason. */
    lint: { allRules: string; noReason: string };
    /** Names of the tests the harness registers (`harness.ts`): these are the project's `it`. */
    harness: {
      registryNotEmpty: string;
      registryFinds: string;
      violator: string;
      oneRecord: string;
      markOneElement: string;
      elementFiles: string;
      outside: string;
      exception: string;
      exceptionFiles: string;
      exceptionJson: string;
      exceptionRules: string;
      markRules: string;
      badExample: string;
      bad: string;
      good: string;
      outsideExample: string;
      codeFiles: string;
      lintExceptions: string;
      knip: {
        files: string;
        exports: string;
        types: string;
        dependencies: string;
        unlisted: string;
        unresolved: string;
        enumMembers: string;
        nsMembers: string;
        duplicates: string;
        binaries: string;
        catalog: string;
        catalogReferences: string;
        known: string;
        hints: string;
      };
      ignoreNoReason: string;
      env: { inCode: string; declaredName: string; undeclared: string; declared: string; readName: string; unread: string };
    };
    /** Registries, test names and offenders of the architecture model check (`architecture.ts`). */
    architecture: {
      dirsRegistry: string;
      dirName: string;
      dirViolator: string;
      workspaceRegistry: string;
      workspaceName: string;
      workspaceViolator: string;
      importsRegistry: string;
      importsName: string;
      importsViolator: string;
      allowedRegistry: string;
      allowedName: string;
      allowedViolator: string;
      containersRegistry: string;
      libraryName: string;
      moduleName: string;
      containersViolator: string;
      edgesRegistry: string;
      edgeName: string;
      edgeViolator: string;
      unitsRegistry: string;
      unitName: string;
      unitViolator: string;
      clientsRegistry: string;
      clientName: string;
      clientViolator: string;
      hostsRegistry: string;
      hostName: string;
      hostPerimeter: string;
      hostViolator: string;
      inAdapter: string;
      inAdapters: string;
      packagesRegistry: string;
      packageName: string;
      packagePerimeter: string;
      packageViolator: string;
      withAdapter: string;
      withAdapters: string;
      envRegistry: string;
      envNoun: string;
      headersRegistry: string;
      headerNoun: string;
      readName: string;
      readNameMany: string;
      readPerimeter: string;
      readViolator: string;
    };
    /** The `docs/spec` documentation: the header mark, headings, sections of the three roots, test counters and marks. */
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
    /** The architecture page and C4 diagrams from the model. */
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
    /**
     * The `spec-diff` PR section: test lists, moving into the tree, the summary, decisions outside names, the scenarios
     * check.
     */
    diff: {
      base: string;
      unchanged: string;
      removed: string;
      changed: string;
      added: string;
      empty: string;
      outsideMark: string;
      moved: string;
      movedFolder: string;
      files: Plural;
      summary: string;
      folder: string;
      harnessColumn: string;
      total: string;
      outsideFiles: string;
      scenarios: string;
      noScenarios: string;
      becameTests: string;
      noTest: string;
      extraMark: string;
      extraTitle: string;
      extraListed: string;
      extraFull: string;
      harnessCheck: string;
      fromReport: string;
      harnessNote: string;
      harnessGap: string;
      noSpecBase: string;
      modelModule: string;
      modelDependency: string;
      modelPackage: string;
      registry: string;
      registryNamed: string;
      rule: string;
      ruleNamed: string;
      deadCode: string;
      deadCodeNamed: string;
      architecture: string;
      nameException: string;
      modelTitle: string;
      exceptionsTitle: string;
      checksTitle: string;
      removedKind: string;
      addedKind: string;
      summarized: string;
    };
    /**
     * Tests of the `spec-claims` entry points check: describe, registry and names; "not empty" and exception are
     * harness names.
     */
    claims: {
      describe: string;
      registry: string;
      unique: string;
      called: string;
      known: string;
    };
  }

  const LANGUAGE_CODE: RegExp;
  const DEFAULT_LANGUAGE: string;
  const LEGACY_LANGUAGE: string;
  /** The project root: the nearest directory up with `.git`, otherwise the directory itself. */
  function projectRoot(dir: string): string;
  /**
   * The project language of a directory (by default — the current one): the manifest's `language`, no field — ru, no
   * manifest — en.
   */
  function projectLanguage(dir?: string): string;
  /** The names of a language; no file for the language — en. */
  function names(language: string): Names;
  /** The dictionary's languages, en first. */
  function languages(): string[];
  /** The names of all dictionary languages — for parsing. */
  function everyNames(): Names[];
  /** One name in all dictionary languages without repeats. */
  function every(pick: (n: Names) => string): string[];
  /** Substitutes `{var}` in a template. */
  function fill(template: string, vars: Record<string, string | number>): string;
  /** The word form for a number by the language's rules. */
  function plural(language: string, forms: Plural, n: number): string;
  /** The number and the word form: "12 tests". */
  function count(language: string, forms: Plural, n: number): string;
  /** A name for a regex: special characters escaped. */
  function escapeRe(text: string): string;
}

export = locale;
