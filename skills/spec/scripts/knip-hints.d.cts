// Типы репортера `knip-hints.cjs`: без них TypeScript проекта с `checkJs` проверял бы сам файл.

/** Подсказка конфигурации, как её собрал knip. */
interface Hint {
  type: string;
  identifier: string | RegExp;
  workspaceName?: string;
  filePath?: string;
}

/** Репортер knip: подсказки конфигурации строкой JSON в stdout. */
declare function report(options: { cwd: string; configurationHints: Hint[]; isDisableConfigHints?: boolean }): void;
declare namespace report {
  /** Путь файла репортера — для `knip --reporter`. */
  const file: string;
}
export = report;
