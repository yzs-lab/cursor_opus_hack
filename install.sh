#!/usr/bin/env bash
# Overrides Cursor's built-in anysphere.cursor-always-local with a copy one patch version higher
# whose entry point is hook.js. Runs with the Node.js bundled in Cursor.app.
set -euo pipefail

APP="${CURSOR_APP:-/Applications/Cursor.app}"
if [ ! -x "$APP/Contents/MacOS/Cursor" ]; then
  echo "找不到 $APP，可以用 CURSOR_APP=/path/to/Cursor.app ./install.sh 指定" >&2
  exit 1
fi
HOOK="$(cd "$(dirname "$0")" && pwd)/hook.js"

ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Cursor" - "$APP" "$HOOK" <<'EOF'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const [app, hook] = process.argv.slice(2);
const id = "anysphere.cursor-always-local";
const hookMain = "node_modules/hook/dist/main.js";
const source = path.join(app, "Contents/Resources/app/extensions/cursor-always-local");
const extensionsDir = path.join(os.homedir(), ".cursor/extensions");
const registry = path.join(extensionsDir, "extensions.json");
const cache = path.join(os.homedir(), "Library/Application Support/Cursor/CachedProfilesData/__default__profile__/extensions.user.cache");

// A user-folder copy replaces the built-in extension only when its version is strictly higher.
const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
const [major, minor, patch] = manifest.version.split(".").map(Number);
const version = `${major}.${minor}.${patch + 1}`;
const target = path.join(extensionsDir, `${id}-${version}`);

fs.mkdirSync(extensionsDir, { recursive: true });
for (const name of fs.readdirSync(extensionsDir)) {
  const dir = path.join(extensionsDir, name);
  if (name.startsWith(`${id}-`) && fs.existsSync(path.join(dir, hookMain))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Copied byte for byte: Cursor checks dist/*.js against hashes of its own build before loading
// the extension, and skips node_modules, which is where the hook goes.
fs.cpSync(source, target, { recursive: true });
fs.mkdirSync(path.join(target, path.dirname(hookMain)), { recursive: true });
fs.copyFileSync(hook, path.join(target, hookMain));
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ ...manifest, version, main: `./${hookMain}` }, null, 2));

const entries = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, "utf8")) : [];
const others = entries.filter((entry) => entry.identifier.id.toLowerCase() !== id);
others.push({
  identifier: { id },
  version,
  location: { $mid: 1, fsPath: target, external: pathToFileURL(target).href, path: target, scheme: "file" },
  relativeLocation: path.basename(target),
  metadata: {
    isApplicationScoped: true,
    isMachineScoped: false,
    isBuiltin: true,
    installedTimestamp: Date.now(),
    pinned: true,
    source: "gallery",
    publisherDisplayName: "Anysphere",
    targetPlatform: "undefined",
    updated: true,
    private: true,
    isPreReleaseVersion: false,
    hasPreReleaseVersion: false,
    preRelease: false,
  },
});
fs.writeFileSync(registry, JSON.stringify(others));
fs.rmSync(cache, { force: true });

console.log(`内置 ${id} 是 ${manifest.version}，已安装覆盖版本 ${version}：${target}`);
console.log("在 Cursor 里按 Cmd+Shift+P 执行 Developer: Reload Window（或重启 Cursor）后生效。");
EOF
