#!/usr/bin/env bash
# Overrides Cursor's built-in anysphere.cursor-always-local with a copy one patch version higher
# whose entry point is hook.js, then registers a LaunchAgent that reinstalls after Cursor updates.
# Runs with the Node.js bundled in Cursor.app.
set -euo pipefail

APP="${CURSOR_APP:-/Applications/Cursor.app}"
if [ ! -x "$APP/Contents/MacOS/Cursor" ]; then
  echo "找不到 $APP，可以用 CURSOR_APP=/path/to/Cursor.app ./install.sh 指定" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Cursor" - "$APP" "$HERE/hook.js" <<'EOF'
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

// Copied byte for byte: Cursor checks dist/*.js against hashes of its own build before loading
// the extension, and skips node_modules, which is where the hook goes. The copy is built aside
// and renamed into place because this may run while Cursor is starting up.
fs.mkdirSync(extensionsDir, { recursive: true });
const staging = path.join(extensionsDir, `.${id}-staging-${process.pid}`);
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(source, staging, { recursive: true });
fs.mkdirSync(path.join(staging, path.dirname(hookMain)), { recursive: true });
fs.copyFileSync(hook, path.join(staging, hookMain));
fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ ...manifest, version, main: `./${hookMain}` }, null, 2));

for (const name of fs.readdirSync(extensionsDir)) {
  const dir = path.join(extensionsDir, name);
  if (name.startsWith(`${id}-`) && dir !== target && fs.existsSync(path.join(dir, hookMain))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const previous = path.join(extensionsDir, `.${id}-previous-${process.pid}`);
if (fs.existsSync(target)) {
  fs.renameSync(target, previous);
}
fs.renameSync(staging, target);
fs.rmSync(previous, { recursive: true, force: true });

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
fs.writeFileSync(`${registry}.tmp`, JSON.stringify(others));
fs.renameSync(`${registry}.tmp`, registry);
fs.rmSync(cache, { force: true });

console.log(`内置 ${id} 是 ${manifest.version}，已安装覆盖版本 ${version}：${target}`);
EOF

# watch.sh calls this script from inside the LaunchAgent; reloading the agent there would kill it.
if [ -z "${CURSOR_OPUS_HACK_WATCHER:-}" ]; then
  LABEL="com.yzs-lab.cursor-opus-hack"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/cursor_opus_hack.log"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  # Fires when /Applications changes (ShipIt swaps Cursor.app in), plus every 5 minutes as a fallback.
  cat > "$PLIST.tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/watch.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CURSOR_APP</key>
    <string>$APP</string>
    <key>CURSOR_OPUS_HACK_WATCHER</key>
    <string>1</string>
  </dict>
  <key>WatchPaths</key>
  <array>
    <string>$(dirname "$APP")</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST
  if cmp -s "$PLIST.tmp" "$PLIST" && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    rm -f "$PLIST.tmp"
  else
    mv "$PLIST.tmp" "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  echo "已启用自动重装：Cursor 更新后会自动重新安装，日志在 $LOG"
fi

echo "在 Cursor 里按 Cmd+Shift+P 执行 Developer: Reload Window（或重启 Cursor）后生效。"
