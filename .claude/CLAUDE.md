# Elves clone

The canon is this repository's `AGENTS.md` and `claude/CLAUDE.md`. Claude
Code loads it from the machine — `~/.claude/rules/elves.md` and
`elves-claude.md` (`bun bin/elves.ts install -g --link`: symlinks to the
clone). This file keeps Claude Code from reading the root `AGENTS.md` a
second time: without a `CLAUDE.md` it reads `AGENTS.md` itself. No such
rules on the machine — read both files yourself and ask the owner to run
that command.
