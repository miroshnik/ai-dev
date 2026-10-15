/**
 * locale — the project language and the names in it, one module for the scripts of all skills and the installer: `est`,
 * `spec` and `dashboard` import it from `github` — there's one dictionary, in this skill's `locales/`, and `github`
 * doesn't depend on them; the installer in `bin/` imports it from its own package.
 *
 * The language is `language` in `.agents/elves.json` of the project root (the nearest directory up with `.git`,
 * otherwise the directory itself), until `update` moves it — in the former manifest (`FORMER_MANIFEST`): a manifest
 * without the field (an install of a previous version) — `ru`, no manifest — `en`. Names are `locales/<language>.json`,
 * the same keys for each language; no dictionary for the language — `en`. Scripts write in the project language and parse the names of any dictionary language (`everyNames`):
 * a project that changed its language and tasks of other repositories are read without knowing their language.
 *
 * The dictionaries are static JSON imports, not a read of the `locales/` directory: the module is imported by the `spec`
 * harness, which a project's test loads under the project's runner — Playwright and Jest load it as CommonJS, where
 * `import.meta` and top-level `await` are syntax errors, and ESM under Node has no `__dirname`
 * (tests/standards/harness-load); a static import is resolved from the module itself by any loader. For the same
 * runners — only erasable TypeScript and `node:` APIs, and `scripts/package.json` with `"type": "module"`: under Node a
 * project with `"type": "commonjs"` would otherwise load the copy as CommonJS.
 *
 * The `LOCALES` map is typed by `Names`: tsc checks every dictionary against it; a new `locales/<language>.json` is a
 * language only once it's in the map (the flow-english standard holds that every file is).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import en from "../locales/en.json" with { type: "json" };
import ru from "../locales/ru.json" with { type: "json" };

/** Word forms for a number by CLDR; a language without a form has the same as other. */
export interface Plural {
  one: string;
  few: string;
  many: string;
  other: string;
}

/**
 * Names the scripts write to GitHub, to the project's documents and tests, and parse from there: the shape of
 * `locales/en.json`, each language has the same keys (the flow-english standard).
 */
export interface Names {
  issueTypes: { task: string; bug: string; epic: string };
  sections: { questions: string; scenarios: string };
  /**
   * `questions` — a task with open questions in its description (`questionsDescription` — the label's description when
   * `task new` creates it); `externalBlocker` — a task waiting for something outside the repository that isn't an issue:
   * `task queue` skips it.
   */
  labels: { questions: string; questionsDescription: string; epicDescription: string; externalBlocker: string };
  status: { backlog: string; inProgress: string; done: string };
  fields: { estimate: string; actual: string; tokens: string; cost: string };
  views: { board: string; table: string; roadmap: string };
  labelMarkers: { decision: string; slice: string; architecturePath: string };
  /** `externalBlocker` — the start of the comment with the reason of the label of the same name. */
  comments: { state: string; actual: string; closedByPr: string; externalBlocker: string };
  subagentPrompt: { task: string; epic: string };
  /** A bug about a red default branch: the title "<base> is red: <checks>". */
  mainRed: { title: string; check: string; checks: string };
  /**
   * The epic refresh (`github task actualize`): the subagent's prompt (`lead`, `fetch`), its assignment (`--assignment`)
   * and the line of the script's own fixes in a comment on the epic (`mechanics` of `unblocked`, `unlabeled`,
   * `milestone`). `linkWords` — phrases before `#N` that copy a dependency into text, separated by `|`; the phrases of
   * all languages are parsed.
   */
  actualize: {
    lead: string;
    fetch: string;
    shipped: string;
    prs: string;
    noPr: string;
    files: string;
    epic: string;
    openTasks: string;
    openTask: string;
    noBody: string;
    copies: string;
    copy: string;
    answers: string;
    commentAnswer: string;
    checks: string;
    scope: string;
    comment: string;
    answer: string;
    linkWords: string;
    mechanics: string;
    unblocked: string;
    unlabeled: string;
    milestone: string;
  };
  /** The dispatcher's executor (`task queue`): its prompt and its whole assignment (`--assignment`), lines in order. */
  queue: {
    prompt: string;
    epic: string;
    lead: string;
    resume: string;
    subagent: string;
    session: string;
    wait: string;
    git: string;
    subagents: string;
    /** The executor's answer waits for its own subagents (#565). */
    live: string;
    found: string;
    question: string;
    answer: string;
    /** The assignment refused: the task's previous executor or its subagent is alive (#565). */
    alive: string;
  };
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
      /** The actual's split by waits, minutes (est, #518): {ci}, {merged}, {checks}, {slot} — `waitsSlot` or empty, {rest}. */
      waits: string;
      waitsSlot: string;
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
  /** The description of a flow copy commit that `update` suggests: "Elves flow <tag>"; nothing parses it back. */
  updateCommit: string;
  /**
   * The title of the project's flow update task that `check` suggests: "Update the Elves flow" — constant, so
   * `task new` refuses a second open one.
   */
  updateTask: string;
  /**
   * Names before the flow's rename to Elves (#544) that scripts still recognise: `updateTask` — `task new` of the update
   * task refuses while an open one has the former title, so a project doesn't get a second one.
   */
  formerly: { updateTask: string };
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
    notStatements: string;
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
    partialReport: string;
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

/** A BCP 47 language code: the language and optional subtags — `ru`, `en`, `pt-BR`, `zh-Hant`. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const DEFAULT_LANGUAGE = "en";
/**
 * The language of an install of a previous version — a manifest without the `language` field: before the field the flow
 * worked only in Russian.
 */
const LEGACY_LANGUAGE = "ru";
/** The install manifest of the project root. */
const MANIFEST = path.join(".agents", "elves.json");
/**
 * The manifest of an install made before the flow was renamed to Elves: `update` moves it to `MANIFEST`, until then the
 * project language is read from it.
 */
const FORMER_MANIFEST = path.join(".agents", "ai-dev.json");
/** The dictionary: language → names, one entry per `locales/<language>.json`. */
const LOCALES: Record<string, Names> = { en, ru };

/**
 * The project root: the nearest directory up with `.git` (a directory or a worktree file), otherwise the directory
 * itself.
 */
function projectRoot(dir: string): string {
  const start = path.resolve(dir);
  for (let d = start; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return start;
  }
}

/**
 * The project language of the `dir` directory (by default — the current one): the manifest's `language` (`MANIFEST`,
 * otherwise `FORMER_MANIFEST`), no field — ru, no manifest — en.
 */
function projectLanguage(dir: string = process.cwd()): string {
  const root = projectRoot(dir);
  const file = [MANIFEST, FORMER_MANIFEST].map((m) => path.join(root, m)).find((f) => existsSync(f));
  if (!file) return DEFAULT_LANGUAGE;
  let manifest: { language?: unknown } = {};
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    // a broken manifest — like a manifest without the field
  }
  return typeof manifest.language === "string" && LANGUAGE_CODE.test(manifest.language) ? manifest.language : LEGACY_LANGUAGE;
}

/** The names of a language: `locales/<language>.json`, no dictionary for the language — `en`. */
function names(language: string): Names {
  return Object.hasOwn(LOCALES, language) ? LOCALES[language]! : en;
}

/** The dictionary's languages, `en` first. */
function languages(): string[] {
  return [DEFAULT_LANGUAGE, ...Object.keys(LOCALES).filter((l) => l !== DEFAULT_LANGUAGE).sort()];
}

/** The names of all dictionary languages — for parsing. */
function everyNames(): Names[] {
  return languages().map(names);
}

/** One name in all dictionary languages without repeats: `every((n) => n.sections.questions)`. */
function every(pick: (n: Names) => string): string[] {
  return [...new Set(everyNames().map(pick))];
}

/** Substitutes `{var}` in a name template; an unknown variable stays as is. */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** The word form for a number by the language's rules (CLDR: one, few, many, other); no such form — other. */
function plural(language: string, forms: Plural, n: number): string {
  const form = new Intl.PluralRules(language).select(n);
  return (forms as Partial<Record<Intl.LDMLPluralRule, string>>)[form] ?? forms.other;
}

/** "12 tests": the number and the word form. */
function count(language: string, forms: Plural, n: number): string {
  return `${n} ${plural(language, forms, n)}`;
}

/** A regex from a name: special characters escaped. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default { LANGUAGE_CODE, DEFAULT_LANGUAGE, LEGACY_LANGUAGE, projectRoot, projectLanguage, names, languages, everyNames, every, fill, plural, count, escapeRe };
