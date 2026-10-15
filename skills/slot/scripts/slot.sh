# slot.sh — the machine queue for a package.json check of the project (the slot skill); install wraps a script as
#
#   ". .agents/skills/slot/scripts/slot.sh && <command>"
#
# Sourced, not run: slot.ts takes a slot for the script's own shell ($$) — the slot is held until that shell exits —
# and the shell exports the queue variables to the command. The command stays a plain command of the script: tools
# that read package.json scripts (knip) see its binary and arguments, which a command passed to slot.ts as a string
# hid. slot.ts failed — the script fails with its code, the command doesn't run. Paths are from the project root: npm
# and bun run a script there.
ELVES_SLOT_EXPORT=$(bun --no-env-file .agents/skills/slot/scripts/slot.ts --for $$) || exit
eval "$ELVES_SLOT_EXPORT"
unset ELVES_SLOT_EXPORT
