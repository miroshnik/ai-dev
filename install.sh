#!/usr/bin/env bash
# Ставит симлинки из ~/.claude на файлы этого репозитория (идемпотентно).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
link() { # link <путь-в-репо> <путь-в-~/.claude>
  mkdir -p "$(dirname "$2")"
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "!! $2 уже существует и это не симлинк — разберись вручную"; return 1
  fi
  ln -sfn "$here/$1" "$2"; echo "$2 → $here/$1"
}
link claude/CLAUDE.md "$HOME/.claude/CLAUDE.md"
for s in "$here"/skills/*/; do
  [ -d "$s" ] || continue; n="$(basename "$s")"
  link "skills/$n" "$HOME/.claude/skills/$n"      # Claude Code
  link "skills/$n" "$HOME/.agents/skills/$n"      # Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp
done
