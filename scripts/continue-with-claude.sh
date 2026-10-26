#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed or not available on PATH." >&2
  exit 1
fi

exec claude --permission-mode acceptEdits "Read CLAUDE.md, AGENTS.md, docs/ARCHITECTURE.md, docs/HARDWARE_LIMITATIONS.md, and docs/agent/CURRENT_STATUS.md completely. Inspect the current checkout and run the verification gate. Then implement only the single Next task in CURRENT_STATUS.md. Keep all real-TV transports disabled and update CURRENT_STATUS.md with exact evidence before stopping."

