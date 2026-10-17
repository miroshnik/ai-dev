/**
 * The package's script as a command — one form for package.json, CI, the harness's hints and the help of
 * `elves <script>`: `bun` reads the bin itself, past its shebang, and without the flag would load the project's env
 * files into it — the script would pass their keys on to `gh`, `git` and the checked command
 * (tests/standards/no-env-file, #596); a step of GitHub Actions doesn't see `node_modules/.bin`, and `bunx elves`
 * without the package in node_modules would fetch someone else's `elves` from npm (#558, question 2). The installer
 * imports it, and so does the harness — a module of the package built for Node: a constant without imports, the
 * installer's start doesn't load the harness's parser.
 */
export const PACKAGE_RUN = "bun --no-env-file node_modules/.bin/elves";
