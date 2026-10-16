#!/usr/bin/env bash
# Run by the LaunchAgent that install.sh registers. When a Cursor update has replaced the built-in
# cursor-always-local, reinstall right away: Cursor refuses to load a stale override and does not
# fall back to the built-in one, which leaves it without a model connection.
set -uo pipefail

APP="${CURSOR_APP:-/Applications/Cursor.app}"
SRC="$APP/Contents/Resources/app/extensions/cursor-always-local"

override=""
for dir in "$HOME"/.cursor/extensions/anysphere.cursor-always-local-*; do
  if [ -f "$dir/node_modules/hook/dist/main.js" ]; then
    override="$dir"
  fi
done
[ -n "$override" ] || exit 0

# ShipIt swaps the app bundle with two renames; wait if this run landed in between.
for _ in $(seq 30); do
  [ -d "$SRC/dist" ] && break
  sleep 1
done
[ -d "$SRC/dist" ] || exit 0
diff -rq "$SRC/dist" "$override/dist" >/dev/null 2>&1 && exit 0

version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)
echo "$(date '+%F %T') Cursor $version 的内置 cursor-always-local 已变化，重新安装"
if "$(dirname "$0")/install.sh"; then
  message="已为 Cursor $version 重新安装。如果 Cursor 已经打开，执行一次 Developer: Reload Window。"
else
  message="为 Cursor $version 重新安装失败，详见 ~/Library/Logs/cursor_opus_hack.log"
fi
osascript -e "display notification \"$message\" with title \"Cursor Opus Hack\"" >/dev/null 2>&1 || true
