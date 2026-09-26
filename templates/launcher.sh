#!/bin/sh
# boomerang launcher. A stable path for the status line and the proxy agents,
# because the plugin folder changes on every update. Managed by the boomerang plugin.
DATA_DIR="__BOOMERANG_DATA_DIR__"
ROOT="$(cat "$DATA_DIR/plugin_root" 2>/dev/null)"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/scripts/run.mjs" ]; then
  [ "${1:-}" = "statusline" ] && { echo; exit 0; }
  echo "boomerang: plugin not found. Start a new Claude Code session so the plugin can register itself." >&2
  exit 1
fi
BOOMERANG_DATA_DIR="$DATA_DIR" exec node --no-warnings "$ROOT/scripts/run.mjs" "$@"
