// Types of the `knip-hints.cjs` reporter: without them a project's TypeScript with `checkJs` would check the file.

/** A configuration hint as knip collected it. */
interface Hint {
  type: string;
  identifier: string | RegExp;
  workspaceName?: string;
  filePath?: string;
}

/** knip reporter: configuration hints as a JSON line on stdout. */
declare function report(options: { cwd: string; configurationHints: Hint[]; isDisableConfigHints?: boolean }): void;
declare namespace report {
  /** Path of the reporter file — for `knip --reporter`. */
  const file: string;
}
export = report;
