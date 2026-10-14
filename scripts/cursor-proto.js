"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

function findCursorApp() {
  const candidates = [
    process.env.CURSOR_APP,
    "/Applications/Cursor.app",
    path.join(os.homedir(), "Applications", "Cursor.app"),
  ];
  return candidates.find((app) => app && fs.existsSync(path.join(app, "Contents", "Resources", "app", "product.json")));
}

function cursorAlwaysLocalBundle(cursorApp) {
  return path.join(cursorApp, "Contents", "Resources", "app", "extensions", "cursor-always-local", "dist", "main.js");
}

function stub() {
  return new Proxy(function () {}, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }
      if (property === Symbol.toPrimitive) {
        return () => "";
      }
      if (property === Symbol.iterator) {
        return function* () {};
      }
      return stub();
    },
    apply: () => stub(),
    construct: () => stub(),
  });
}

function withStubbedHostModules(fn) {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "vscode" || request === "electron") {
      return stub();
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

// Evaluates the cursor-always-local webpack bundle and hands back its internal
// __webpack_require__, which is the only way to reach Cursor's protobuf classes.
function loadWebpackRequire(bundlePath) {
  const source = fs.readFileSync(bundlePath, "utf8");
  const runtime = /function ([\w$]+)\(([\w$]+)\)\{var ([\w$]+)=([\w$]+)\[\2\];if\(void 0!==\3\)return \3\.exports;/.exec(source);
  if (!runtime) {
    throw new Error(`webpack runtime not found in ${bundlePath}`);
  }
  const key = `__cursorOpusHackWebpackRequire${process.pid}`;
  const patched = `${source.slice(0, runtime.index)}globalThis.${key}=${runtime[1]};${source.slice(runtime.index)}`;
  const bundle = new Module(bundlePath, module);
  bundle.filename = bundlePath;
  bundle.paths = Module._nodeModulePaths(path.dirname(bundlePath));
  withStubbedHostModules(() => {
    try {
      bundle._compile(patched, bundlePath);
    } catch {
      // The entry module needs a real extension host; the runtime is captured before it runs.
    }
  });
  const webpackRequire = globalThis[key];
  delete globalThis[key];
  if (typeof webpackRequire !== "function" || !webpackRequire.m) {
    throw new Error(`could not capture the webpack runtime of ${bundlePath}`);
  }
  return webpackRequire;
}

// Returns the aiserver.v1.AiService.availableModels method descriptor ({ name, I, O, kind })
// exactly as cursor-always-local passes it to its connect transport.
function loadAvailableModelsMethod(cursorApp = findCursorApp()) {
  if (!cursorApp) {
    throw new Error("Cursor.app not found; set CURSOR_APP=/path/to/Cursor.app");
  }
  const webpackRequire = loadWebpackRequire(cursorAlwaysLocalBundle(cursorApp));
  return withStubbedHostModules(() => {
    for (const id of Object.keys(webpackRequire.m)) {
      if (!String(webpackRequire.m[id]).includes('name:"AvailableModels"')) {
        continue;
      }
      const exports = webpackRequire(id);
      for (const name of Object.keys(exports)) {
        let value;
        try {
          value = exports[name];
        } catch {
          continue;
        }
        const method = value && value.methods && value.methods.availableModels;
        if (method && method.name === "AvailableModels" && typeof method.O === "function") {
          return method;
        }
      }
    }
    throw new Error("aiserver.v1.AiService.availableModels not found in the cursor-always-local bundle");
  });
}

// Paths of values set in `expected` that are missing or different in `actual`.
function findLostFields(expected, actual, at = "") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [`${at} (array length)`];
    }
    return expected.flatMap((item, index) => findLostFields(item, actual[index], `${at}[${index}]`));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") {
      return [at];
    }
    return Object.entries(expected).flatMap(([key, value]) =>
      findLostFields(value, actual[key], at ? `${at}.${key}` : key)
    );
  }
  return Object.is(expected, actual) ? [] : [at];
}

module.exports = {
  findCursorApp,
  cursorAlwaysLocalBundle,
  loadAvailableModelsMethod,
  findLostFields,
};
