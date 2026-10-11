/**
 * knip-hints — a knip reporter for the harness's `deadCode`: configuration hints (a redundant `ignore`, an `entry`
 * without matches, a redundant workspace) as a JSON line
 * `{ "configurationHints": [{ type, identifier, workspace, file? }] }`. knip's `json` reporter doesn't print them,
 * and `--treat-config-hints-as-errors` gives only an exit code — the hints themselves aren't visible.
 *
 *   knip --reporter json --reporter .agents/skills/spec/scripts/knip-hints.cjs
 *
 * The second output line is its own: `deadCode` joins both. CommonJS, not TypeScript: the harness takes the file
 * path (`report.file`) with a static import — `import.meta` in a module that Playwright and Jest load as CommonJS is
 * a syntax error (tests/standards/harness-load); knip loads it under both Node and Bun. Types — `knip-hints.d.cts`.
 */
"use strict";

const path = require("node:path");

/**
 * Hints as knip collected them (`ReporterOptions.configurationHints`): an identifier may be a regex (an `ignore`
 * pattern), a file path is absolute; `--no-config-hints` — the project itself opted out of hints.
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
