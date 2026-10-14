"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");
const { spawnSync } = require("child_process");
const { findCursorApp, loadAvailableModelsMethod, findLostFields } = require("./cursor-proto");
const { MODEL_SPECS, buildInjectedModels } = require("../override/models");

const ROOT = path.resolve(__dirname, "..");
const PAYLOAD = path.join(ROOT, "override");
const TARGET_ID = "anysphere.cursor-always-local";
const HOOK_DIR = path.join("node_modules", "hook", "dist");
const HOOK_MAIN = "./node_modules/hook/dist/main.js";
// Payload file -> name inside node_modules/hook/dist of the override.
const PAYLOAD_FILES = { "hook.js": "main.js", "inject.js": "inject.js", "models.js": "models.js" };
// Files Cursor hash-checks before loading cursor-always-local; they must match the current build.
const VERIFIED_FILES = ["dist/main.js", "dist/915.js", "dist/gitWorker.js"];

const HOME = os.homedir();
const EXTENSIONS_DIR = path.resolve(process.env.CURSOR_EXTENSIONS_DIR || path.join(HOME, ".cursor", "extensions"));
const USER_DATA_DIR = path.resolve(process.env.CURSOR_USER_DATA_DIR || path.join(HOME, "Library", "Application Support", "Cursor"));
const EXTENSIONS_JSON = path.join(EXTENSIONS_DIR, "extensions.json");
const EXTENSIONS_CACHE = path.join(USER_DATA_DIR, "CachedProfilesData", "__default__profile__", "extensions.user.cache");
const STATE_DB = path.join(USER_DATA_DIR, "User", "globalStorage", "state.vscdb");
const STORAGE_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const BACKUP_DIR = path.join(ROOT, "backups");
const RELOAD_HINT = "在 Cursor 里按 Cmd+Shift+P，执行 Developer: Reload Window（或重启 Cursor）";

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function filesEqual(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function requireCursorApp() {
  const app = findCursorApp();
  if (!app) {
    fail("找不到 Cursor.app，请用 CURSOR_APP=/path/to/Cursor.app 指定。");
  }
  return app;
}

function cursorVersion(app) {
  return readJson(path.join(app, "Contents", "Resources", "app", "product.json")).version;
}

function builtinDir(app) {
  return path.join(app, "Contents", "Resources", "app", "extensions", "cursor-always-local");
}

// The user-folder copy wins over the built-in only when its version is strictly higher.
function bumpVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!match) {
    fail(`看不懂内置 ${TARGET_ID} 的版本号 "${version}"`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isManagedOverride(dir) {
  try {
    return readJson(path.join(dir, "package.json")).main === HOOK_MAIN && fs.existsSync(path.join(dir, HOOK_DIR, "main.js"));
  } catch {
    return false;
  }
}

function managedOverrideDirs() {
  return readDirSafe(EXTENSIONS_DIR)
    .filter((name) => name.toLowerCase().startsWith(`${TARGET_ID}-`))
    .map((name) => path.join(EXTENSIONS_DIR, name))
    .filter(isManagedOverride);
}

function readExtensionsJson() {
  return fs.existsSync(EXTENSIONS_JSON) ? readJson(EXTENSIONS_JSON) : [];
}

function writeExtensionsJson(entries) {
  if (fs.existsSync(EXTENSIONS_JSON)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(EXTENSIONS_JSON, path.join(BACKUP_DIR, "extensions.json.bak"));
  }
  const temp = path.join(EXTENSIONS_DIR, `.extensions.json.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(entries));
  fs.renameSync(temp, EXTENSIONS_JSON);
}

function hasTargetId(entry) {
  return Boolean(entry && entry.identifier && String(entry.identifier.id).toLowerCase() === TARGET_ID);
}

function entryDir(entry) {
  const location = entry.location || {};
  return path.resolve(location.fsPath || location.path || path.join(EXTENSIONS_DIR, entry.relativeLocation || ""));
}

function registeredOverride() {
  return readExtensionsJson().find(hasTargetId);
}

function clearExtensionsCache() {
  fs.rmSync(EXTENSIONS_CACHE, { force: true });
}

// Round-trips the injected models through the protobuf class shipped in this Cursor build.
function checkInjectedModels(app) {
  let method;
  try {
    method = loadAvailableModelsMethod(app);
  } catch (error) {
    return { status: "warn", message: `无法从 Cursor 里加载 protobuf 定义，跳过字段校验（${error.message}）` };
  }
  const models = buildInjectedModels();
  const decoded = method.O.fromBinary(new method.O({ models }).toBinary());
  const lost = new Set();
  models.forEach((model, index) => {
    for (const field of findLostFields(model, decoded.models[index], model.name)) {
      lost.add(field.replace(/\[\d+\]/g, "[]"));
    }
  });
  return lost.size === 0
    ? { status: "ok", message: `注入的 ${models.length} 个模型在当前 Cursor 的 AvailableModelsResponse 里字段完整` }
    : { status: "bad", message: `当前 Cursor 会丢弃这些字段，需要更新 override/models.js：${[...lost].join(", ")}` };
}

const MARK = { ok: "✓", warn: "!", bad: "✗" };

function install() {
  const app = requireCursorApp();
  const source = builtinDir(app);
  const builtin = readJson(path.join(source, "package.json"));
  const version = bumpVersion(builtin.version);
  const target = path.join(EXTENSIONS_DIR, `${TARGET_ID}-${version}`);
  console.log(`Cursor ${cursorVersion(app)}：内置 ${TARGET_ID} 是 ${builtin.version}，安装覆盖版本 ${version}`);

  const check = checkInjectedModels(app);
  console.log(`${MARK[check.status]} ${check.message}`);

  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  const staging = path.join(EXTENSIONS_DIR, `.cursor-opus-hack-staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(source, staging, { recursive: true });
  fs.mkdirSync(path.join(staging, HOOK_DIR), { recursive: true });
  for (const [from, to] of Object.entries(PAYLOAD_FILES)) {
    fs.copyFileSync(path.join(PAYLOAD, from), path.join(staging, HOOK_DIR, to));
  }
  fs.writeFileSync(
    path.join(staging, "node_modules", "hook", "package.json"),
    `${JSON.stringify({ name: "hook", private: true, main: "dist/main.js" }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify({ ...builtin, version, main: HOOK_MAIN }, null, 2)}\n`);

  for (const dir of managedOverrideDirs()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);

  const entries = readExtensionsJson().filter((entry) => !hasTargetId(entry));
  entries.push({
    identifier: { id: TARGET_ID },
    version,
    location: { $mid: 1, fsPath: target, external: url.pathToFileURL(target).href, path: target, scheme: "file" },
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
  writeExtensionsJson(entries);
  clearExtensionsCache();

  console.log(`已安装到 ${target}`);
  console.log(`下一步：${RELOAD_HINT}，然后运行 ./doctor.sh 确认生效。`);
}

function uninstall() {
  const dirs = managedOverrideDirs();
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`已删除 ${dir}`);
  }
  const entries = readExtensionsJson();
  const kept = entries.filter((entry) => !(hasTargetId(entry) && !fs.existsSync(entryDir(entry))));
  if (kept.length !== entries.length) {
    writeExtensionsJson(kept);
    console.log("已从 extensions.json 移除覆盖记录");
  }
  if (dirs.length === 0 && kept.length === entries.length) {
    console.log("没有找到已安装的覆盖。");
  }
  clearExtensionsCache();
  console.log(`完成。${RELOAD_HINT}后恢复为 Cursor 内置的 cursor-always-local。`);
}

function latestHookLog() {
  const logsRoot = path.join(USER_DATA_DIR, "logs");
  const session = readDirSafe(logsRoot).sort().pop();
  if (!session) return undefined;
  const files = [];
  for (const window of readDirSafe(path.join(logsRoot, session))) {
    const dir = path.join(logsRoot, session, window, "exthost", TARGET_ID);
    for (const name of readDirSafe(dir)) {
      if (name.startsWith("Cursor Opus Hack") && name.endsWith(".log")) files.push(path.join(dir, name));
    }
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return { session, file: files[0] };
}

function readApplicationStorage() {
  if (!fs.existsSync(STATE_DB)) return undefined;
  const result = spawnSync("sqlite3", ["-readonly", STATE_DB, `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}'`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function doctor() {
  let failures = 0;
  const report = (status, message) => {
    console.log(`${MARK[status]} ${message}`);
    if (status === "bad") failures += 1;
  };

  const app = findCursorApp();
  if (!app) {
    report("bad", "找不到 Cursor.app，请用 CURSOR_APP=/path/to/Cursor.app 指定");
    process.exitCode = 1;
    return;
  }
  const source = builtinDir(app);
  const builtinVersion = readJson(path.join(source, "package.json")).version;
  report("ok", `Cursor ${cursorVersion(app)}，内置 ${TARGET_ID} ${builtinVersion}`);

  const entry = registeredOverride();
  const dir = entry && entryDir(entry);
  if (!entry || !isManagedOverride(dir)) {
    report("bad", "没有安装覆盖，运行 ./install.sh");
  } else {
    const version = readJson(path.join(dir, "package.json")).version;
    if (compareVersions(version, builtinVersion) <= 0) {
      report("bad", `覆盖版本 ${version} 不高于内置 ${builtinVersion}，Cursor 会忽略它；运行 ./install.sh`);
    } else {
      report("ok", `覆盖 ${version} 已安装（${dir}）`);
    }
    const stale = VERIFIED_FILES.filter((file) => !filesEqual(path.join(dir, file), path.join(source, file)));
    if (stale.length > 0) {
      report("bad", `Cursor 升级过，覆盖里的 ${stale.join(", ")} 已过期，下次启动会校验失败；立刻运行 ./install.sh`);
    } else {
      report("ok", "覆盖里的 dist 文件与当前 Cursor 一致，能通过文件校验");
    }
    const outdated = Object.entries(PAYLOAD_FILES).filter(([from, to]) => !filesEqual(path.join(PAYLOAD, from), path.join(dir, HOOK_DIR, to)));
    if (outdated.length > 0) {
      report("warn", "项目里的 hook 比已安装的新，运行 ./install.sh 更新");
    }
  }

  const check = checkInjectedModels(app);
  report(check.status, check.message);

  const latest = latestHookLog();
  if (!latest || !latest.file) {
    report("warn", `当前 Cursor 会话里还没有 hook 日志：${RELOAD_HINT}`);
  } else {
    const lines = fs.readFileSync(latest.file, "utf8").split("\n").filter(Boolean);
    const last = (pattern) => [...lines].reverse().find((line) => pattern.test(line));
    const problem = last(/\[error\]/);
    const injection = last(/AvailableModels: server returned/);
    if (problem) report("bad", `hook 日志有错误：${problem}`);
    else if (injection) report("ok", `hook 日志：${injection}`);
    else report("warn", `hook 已加载，还没看到 AvailableModels 请求（模型列表约 5 分钟刷新一次）：${lines[lines.length - 1] || ""}`);
  }

  const storage = readApplicationStorage();
  const catalog = storage && storage.availableDefaultModels2;
  if (!Array.isArray(catalog)) {
    report("warn", "读不到 Cursor 缓存的模型列表（state.vscdb），跳过");
  } else {
    const ids = MODEL_SPECS.map((spec) => spec.id);
    const present = catalog.filter((model) => ids.includes(model.name));
    const missing = ids.filter((id) => !present.some((model) => model.name === id));
    if (missing.length === 0) {
      report("ok", `模型列表缓存（共 ${catalog.length} 个）包含 ${present.map((m) => `${m.name}（${(m.variants || []).length} 个变体）`).join("、")}`);
    } else {
      report("warn", `模型列表缓存（共 ${catalog.length} 个）缺少 ${missing.join(", ")}，重载窗口后会随下一次刷新补上`);
    }
    const preferences = (storage.aiSettings && storage.aiSettings.modelParameterPreferences) || {};
    for (const id of ids) {
      const saved = preferences[id];
      if (saved && Array.isArray(saved.parameters)) {
        console.log(`    ${id} 上次使用的参数：${saved.parameters.map((p) => `${p.id}=${p.value}`).join(", ")}`);
      }
    }
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

const COMMANDS = { install, uninstall, doctor };
const command = COMMANDS[process.argv[2]];
if (!command) {
  console.log("用法：scripts/run-node.sh scripts/manage.js <install|uninstall|doctor>");
  process.exit(process.argv[2] ? 1 : 0);
}
command();
// Loading Cursor's bundle for the protobuf check may leave timers behind; don't wait for them.
process.exit(process.exitCode || 0);
