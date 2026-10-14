#!/usr/bin/env bash
# Removes the override installed by install.sh so Cursor goes back to its built-in cursor-always-local.
set -euo pipefail

APP="${CURSOR_APP:-/Applications/Cursor.app}"
if [ ! -x "$APP/Contents/MacOS/Cursor" ]; then
  echo "找不到 $APP，可以用 CURSOR_APP=/path/to/Cursor.app ./uninstall.sh 指定" >&2
  exit 1
fi

ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Cursor" - <<'EOF'
const fs = require("fs");
const os = require("os");
const path = require("path");

const id = "anysphere.cursor-always-local";
const extensionsDir = path.join(os.homedir(), ".cursor/extensions");
const registry = path.join(extensionsDir, "extensions.json");
const cache = path.join(os.homedir(), "Library/Application Support/Cursor/CachedProfilesData/__default__profile__/extensions.user.cache");

for (const name of fs.existsSync(extensionsDir) ? fs.readdirSync(extensionsDir) : []) {
  const dir = path.join(extensionsDir, name);
  if (name.startsWith(`${id}-`) && fs.existsSync(path.join(dir, "node_modules/hook/dist/main.js"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`已删除 ${dir}`);
  }
}
if (fs.existsSync(registry)) {
  const entries = JSON.parse(fs.readFileSync(registry, "utf8"));
  fs.writeFileSync(registry, JSON.stringify(entries.filter((entry) => entry.identifier.id.toLowerCase() !== id)));
}
fs.rmSync(cache, { force: true });

console.log("在 Cursor 里按 Cmd+Shift+P 执行 Developer: Reload Window 后恢复为内置版本。");
EOF
