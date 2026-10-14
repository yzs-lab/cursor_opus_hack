"use strict";

// Installed as node_modules/hook/dist/main.js inside the anysphere.cursor-always-local override.
// It runs as cursor-always-local itself, so require("vscode") returns the same API object the
// real extension gets; patching it before loading the real code is enough.

const fs = require("fs");
const path = require("path");
const { patchCursorNamespace } = require("./inject");

const REAL_MAIN = path.join(__dirname, "..", "..", "..", "dist", "main.js");

function createLogger() {
  const file = process.env.CURSOR_OPUS_HACK_LOG;
  let channel;
  try {
    channel = require("vscode").window.createOutputChannel("Cursor Opus Hack", { log: true });
  } catch {
    channel = undefined;
  }
  const write = (level, message) => {
    if (file) {
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`);
      } catch {
        // Diagnostics only.
      }
    }
    if (channel && typeof channel[level] === "function") {
      channel[level](message);
    }
  };
  return { info: (m) => write("info", m), error: (m) => write("error", m) };
}

const log = createLogger();
let lastLine;
try {
  const patched = patchCursorNamespace(require("vscode"), {
    // AvailableModels refreshes every few minutes; only log when the outcome changes.
    log: (line) => {
      if (line !== lastLine) {
        lastLine = line;
        log.info(line);
      }
    },
    onError: (error) => log.error((error && error.stack) || String(error)),
  });
  log.info(patched ? "Patched vscode.cursor.registerConnectTransportProvider" : "vscode.cursor was already patched or unavailable");
} catch (error) {
  log.error(`Failed to patch vscode.cursor: ${(error && error.stack) || error}`);
}

module.exports = require(REAL_MAIN);
