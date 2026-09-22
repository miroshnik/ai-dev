#!/usr/bin/env bash
# Подключает правила (AGENTS.md) и скиллы (skills/*) ко всем агентам, которые есть на
# машине. Идемпотентно: симлинки обновляются; чужой непустой файл не трогается — о нём
# сообщается; каталоги агентов, которых нет, не создаются.
#
#   ./install.sh                                   — всё, что нашлось
#   AI_DEV_PRIVATE=~/Projects/ai-dev-private ./install.sh — плюс личная конфигурация
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
note() { printf '%s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }

link() { # link <путь-в-репо> <куда>
  local src="$here/$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    if [ -f "$dst" ] && [ ! -s "$dst" ]; then rm "$dst"      # пустой обычный файл — заменяем
    else warn "$dst уже существует и это не симлинк — оставлен как есть"; return 0; fi
  fi
  ln -sfn "$src" "$dst"; note "$dst → $src"
}

skills() { # skills <каталог-скиллов-агента>
  local s n
  for s in "$here"/skills/*/; do
    [ -d "$s" ] || continue; n="$(basename "$s")"
    link "skills/$n" "$1/$n"
  done
}

# Claude Code: CLAUDE.md импортирует ../AGENTS.md; скиллы в ~/.claude/skills
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then
  link claude/CLAUDE.md "$HOME/.claude/CLAUDE.md"
  skills "$HOME/.claude/skills"
fi

# Общая точка скиллов для остальных агентов (Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp)
skills "$HOME/.agents/skills"

# Глобальные файлы правил остальных агентов — симлинк на AGENTS.md
[ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1 && link AGENTS.md "$HOME/.codex/AGENTS.md"
[ -d "$HOME/.gemini" ] && link AGENTS.md "$HOME/.gemini/GEMINI.md"
[ -d "$HOME/.copilot" ] && link AGENTS.md "$HOME/.copilot/copilot-instructions.md"
[ -d "$HOME/.config/opencode" ] && link AGENTS.md "$HOME/.config/opencode/AGENTS.md"
[ -d "$HOME/.config/amp" ] && link AGENTS.md "$HOME/.config/amp/AGENTS.md"

# Cursor: глобального файла правил нет
[ -d "$HOME/.cursor" ] && note "Cursor: глобального файла правил нет — вставь содержимое AGENTS.md в Settings → Rules → User Rules один раз; скиллы он видит в ~/.agents/skills"

# Codex: глобальный AGENTS.md вне бюджета, но как файл проекта он ограничен 32 КиБ
size=$(wc -c < "$here/AGENTS.md" | tr -d " ")
if [ "$size" -gt 32768 ] && { [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; }; then
  note "Codex: AGENTS.md — $size байт; как файл проекта он не влезет в project_doc_max_bytes (32 КиБ) — подключён глобально, для проектов подними лимит в ~/.codex/config.toml"
fi

# Личная конфигурация (приватный репозиторий или каталог)
if [ -n "${AI_DEV_PRIVATE:-}" ]; then
  mkdir -p "$HOME/.config"
  if [ -e "$HOME/.config/ai-dev" ] && [ ! -L "$HOME/.config/ai-dev" ]; then
    warn "$HOME/.config/ai-dev уже существует и это не симлинк — перенеси его содержимое в $AI_DEV_PRIVATE и удали"
  else
    ln -sfn "$AI_DEV_PRIVATE" "$HOME/.config/ai-dev"; note "$HOME/.config/ai-dev → $AI_DEV_PRIVATE"
  fi
fi
