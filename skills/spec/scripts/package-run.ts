/**
 * The package's script as a command — one form for package.json, CI, the harness's hints and the help of
 * `elves <script>`: `bun` reads the bin itself, past its shebang, and without the flag would load the project's env
 * files into it — the script would pass their keys on to `gh`, `git` and the checked command
 * (tests/standards/no-env-file, #596); a step of GitHub Actions doesn't see `node_modules/.bin`, and `bunx elves`
 * without the package in node_modules would fetch someone else's `elves` from npm (#558, question 2). The installer
 * imports it, and so does the harness — a module of the package built for Node: constants without imports, the
 * installer's start doesn't load the harness's parser.
 */
export const PACKAGE_RUN = "bun --no-env-file node_modules/.bin/elves";

/**
 * The package of the project's version through bunx — where `node_modules/.bin/elves` isn't there or doesn't run: a CI
 * job without the project's dependencies (#597) and a project on Yarn 2+ (#608). Yarn 2+ has no `node_modules` with
 * PnP, and with any `nodeLinker` it runs a `.ts` bin by Node, past its shebang — Node doesn't strip types under
 * `node_modules`; bunx runs the bin by its shebang, under Bun without env files (#592). Needs `jq`; `$(…)` works in
 * Yarn's shell too. The first run fetches the package of that version into Bun's cache.
 */
export const PACKAGE_BUNX = `bunx @miroshnik/elves@"$(jq -r '.devDependencies["@miroshnik/elves"]' package.json)"`;

/** The package's script in a project: on Yarn 2+ (`berry` of the github skill's `packageManager`) — `PACKAGE_BUNX`. */
export const packageRun = (berry: boolean) => (berry ? PACKAGE_BUNX : PACKAGE_RUN);
