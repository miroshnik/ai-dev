/**
 * knip-hints — репортер knip для `deadCode` харнесса: подсказки конфигурации (лишний `ignore`, `entry` без совпадений,
 * лишний воркспейс) строкой JSON `{ "configurationHints": [{ type, identifier, workspace, file? }] }`. Репортер `json`
 * knip их не выводит, а `--treat-config-hints-as-errors` даёт только код выхода — не видно, какие подсказки.
 *
 *   knip --reporter json --reporter .agents/skills/spec/scripts/knip-hints.cjs
 *
 * Вторая строка вывода — его: `deadCode` склеивает обе. CommonJS, а не TypeScript: харнесс берёт путь файла
 * (`report.file`) статическим импортом — `import.meta` в модуле, который Playwright и Jest грузят как CommonJS, —
 * синтаксическая ошибка (tests/standards/harness-load); knip грузит его и под Node, и под Bun. Типы — `knip-hints.d.cts`.
 */
"use strict";

const path = require("node:path");

/**
 * Подсказки, как их собрал knip (`ReporterOptions.configurationHints`): идентификатор бывает регуляркой (шаблон
 * `ignore`), путь файла — абсолютный; `--no-config-hints` — проект сам отказался от подсказок.
 */
function report(options) {
  const hints = options.isDisableConfigHints
    ? []
    : options.configurationHints.map((h) => ({
        type: h.type,
        identifier: h.identifier instanceof RegExp ? h.identifier.source.replaceAll("\\/", "/") : String(h.identifier),
        workspace: h.workspaceName ?? ".",
        ...(h.filePath ? { file: path.relative(options.cwd, path.resolve(options.cwd, h.filePath)).split(path.sep).join("/") } : {}),
      }));
  process.stdout.write(JSON.stringify({ configurationHints: hints }) + "\n");
}

report.file = __filename;
module.exports = report;
