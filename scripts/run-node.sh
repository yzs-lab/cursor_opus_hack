#!/usr/bin/env bash
# Runs Node.js scripts with the runtime bundled in Cursor.app (the same one the extension host uses),
# falling back to `node` on PATH. Override with CURSOR_OPUS_HACK_NODE=/path/to/node.
set -euo pipefail

if [[ -z "${CURSOR_APP:-}" ]]; then
  for candidate in "/Applications/Cursor.app" "$HOME/Applications/Cursor.app"; do
    if [[ -d "$candidate" ]]; then
      CURSOR_APP="$candidate"
      break
    fi
  done
fi
export CURSOR_APP="${CURSOR_APP:-}"

if [[ -n "${CURSOR_OPUS_HACK_NODE:-}" ]]; then
  exec "$CURSOR_OPUS_HACK_NODE" "$@"
fi
if [[ -n "$CURSOR_APP" && -x "$CURSOR_APP/Contents/MacOS/Cursor" ]]; then
  ELECTRON_RUN_AS_NODE=1 exec "$CURSOR_APP/Contents/MacOS/Cursor" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi
echo "找不到 Cursor.app，也找不到 node。请用 CURSOR_APP=/path/to/Cursor.app 指定 Cursor 的位置。" >&2
exit 1
