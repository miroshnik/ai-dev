/**
 * The installer under its name before the rename (#544) — `bin/elves.ts` itself: `update -g` of a release before the
 * rename pulls a `--link` clone and runs `<clone>/bin/ai-dev.ts install -g --link` with the clone's code, and this file
 * keeps that run working — the links, the SessionStart hook and the clone's origin come from the updated clone. Not a
 * command of the package (`bin` in package.json has only `elves`).
 */
import "./elves.ts";
