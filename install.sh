#!/usr/bin/env bash
# Installs the /goal command + goal-enforcer plugin into OpenCode's global
# config directory by symlinking the files from this repo checkout.
#
# Usage:
#   bash install.sh          # symlink (default, recommended: `git pull` = instant update)
#   bash install.sh --copy   # copy instead of symlink

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

MODE="link"
if [[ "${1:-}" == "--copy" ]]; then
  MODE="copy"
fi

mkdir -p "$CONFIG_DIR/plugin" "$CONFIG_DIR/command"

install_one() {
  local src="$1"
  local dst="$2"

  rm -f "$dst"

  if [[ "$MODE" == "copy" ]]; then
    cp "$src" "$dst"
    echo "Copied  $src -> $dst"
  else
    ln -s "$src" "$dst"
    echo "Linked  $dst -> $src"
  fi
}

install_one "$REPO_ROOT/plugin/goal-enforcer.ts" "$CONFIG_DIR/plugin/goal-enforcer.ts"
install_one "$REPO_ROOT/command/goal.md" "$CONFIG_DIR/command/goal.md"

echo ""
echo "Done. Restart OpenCode (or start a new session) so it picks up the plugin."
