"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { MODEL_SPECS, INSERT_BEFORE_MODEL } = require("../override/models");
const { wrapProvider, patchCursorNamespace } = require("../override/inject");
const { findCursorApp, loadAvailableModelsMethod } = require("../scripts/cursor-proto");

const INJECTED = MODEL_SPECS.map((spec) => spec.id);
const SERVER_MODELS = Object.freeze(["auto-smart", "composer-2.5", "gpt-5.6-sol", "gemini-4-argon", "gpt-5.5"]);

class FakeAvailableModelsResponse {
  constructor(init = {}) {
    this.models = (init.models || []).map((model) => ({ ...model }));
    this.modelNames = [...(init.modelNames || [])];
  }
}

const availableModels = findCursorApp()
  ? loadAvailableModelsMethod()
  : { name: "AvailableModels", O: FakeAvailableModelsResponse };

function serverProvider(serverModels = SERVER_MODELS) {
  return {
    async unary(_service, method) {
      if (method.name !== "AvailableModels") {
        return { message: { untouched: true } };
      }
      // Decoded wire messages own their arrays; the protobuf constructor would alias serverModels.
      const models = serverModels.map((name) => ({ name, defaultOn: true }));
      return { message: new availableModels.O({ models, modelNames: [...serverModels] }) };
    },
  };
}

// Same shape as Cursor: cursor.* functions are configurable but not writable.
function fakeCursorApi() {
  const registered = [];
  const cursor = {};
  Object.defineProperty(cursor, "registerConnectTransportProvider", {
    value: (provider) => registered.push(provider),
    enumerable: true,
    configurable: true,
  });
  return { api: { cursor }, registered };
}

test("injects the missing Claude models into AvailableModels responses", async () => {
  const provider = wrapProvider(serverProvider());
  const { message } = await provider.unary({}, availableModels, undefined, 0, {}, {});
  const at = SERVER_MODELS.indexOf(INSERT_BEFORE_MODEL);
  assert.deepEqual(
    message.models.map((model) => model.name),
    [...SERVER_MODELS.slice(0, at), ...INJECTED, ...SERVER_MODELS.slice(at)]
  );
  assert.deepEqual(message.modelNames, [...SERVER_MODELS, ...INJECTED]);
  const opus = message.models.find((model) => model.name === "claude-opus-5-5");
  assert.equal(opus.variants.length, 20);
  assert.equal(opus.constructor, message.models[0].constructor);
});

test("keeps models the server already returns instead of duplicating them", async () => {
  const provider = wrapProvider(serverProvider([...SERVER_MODELS, "claude-opus-5-5"]));
  const { message } = await provider.unary({}, availableModels);
  const opus = message.models.filter((model) => model.name === "claude-opus-5-5");
  assert.equal(opus.length, 1);
  assert.equal(opus[0].variants.length, 0, "the server's own entry should be kept");
  assert.equal(message.models.length, SERVER_MODELS.length + INJECTED.length);
});

test("gives every response its own copy of the injected models", async () => {
  const provider = wrapProvider(serverProvider());
  const first = await provider.unary({}, availableModels);
  first.message.models.find((model) => model.name === "claude-opus-5-5").legacySlugs.push("mutated");
  const second = await provider.unary({}, availableModels);
  assert.ok(!second.message.models.find((model) => model.name === "claude-opus-5-5").legacySlugs.includes("mutated"));
});

test("wraps a provider only once", async () => {
  const provider = serverProvider();
  wrapProvider(provider);
  const wrapped = provider.unary;
  wrapProvider(provider);
  assert.equal(provider.unary, wrapped);
  const { message } = await provider.unary({}, availableModels);
  assert.equal(message.models.length, SERVER_MODELS.length + INJECTED.length);
});

test("leaves other RPCs untouched", async () => {
  const provider = wrapProvider(serverProvider());
  const response = await provider.unary({}, { name: "StreamChat", O: availableModels.O });
  assert.deepEqual(response.message, { untouched: true });
});

test("returns the server response unchanged when injection throws", async () => {
  const errors = [];
  const provider = wrapProvider(serverProvider(), { onError: (error) => errors.push(error) });
  const broken = {
    name: "AvailableModels",
    O: class {
      constructor() {
        throw new Error("boom");
      }
    },
  };
  const { message } = await provider.unary({}, broken);
  assert.deepEqual(
    message.models.map((model) => model.name),
    SERVER_MODELS
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /boom/);
});

test("patches the non-writable vscode.cursor.registerConnectTransportProvider once", async () => {
  const { api, registered } = fakeCursorApi();
  assert.equal(patchCursorNamespace(api), true);
  assert.equal(patchCursorNamespace(api), false);

  const provider = serverProvider();
  api.cursor.registerConnectTransportProvider(provider);
  assert.equal(registered.length, 1);
  assert.equal(registered[0], provider);
  const { message } = await provider.unary({}, availableModels);
  assert.equal(message.models.length, SERVER_MODELS.length + INJECTED.length);
});

test("hook.js patches vscode, then loads and re-exports the real cursor-always-local", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-opus-hack-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hookDir = path.join(root, "node_modules", "hook", "dist");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(path.join(root, "dist"));
  for (const [from, to] of [
    ["hook.js", "main.js"],
    ["inject.js", "inject.js"],
    ["models.js", "models.js"],
  ]) {
    fs.copyFileSync(path.join(__dirname, "..", "override", from), path.join(hookDir, to));
  }
  // Stands in for the real webpack bundle: grabs vscode at load time, registers in activate().
  fs.writeFileSync(
    path.join(root, "dist", "main.js"),
    'const vscode = require("vscode");\nexports.real = true;\nexports.activate = (provider) => vscode.cursor.registerConnectTransportProvider(provider);\n'
  );

  const { api, registered } = fakeCursorApi();
  const logLines = [];
  api.window = { createOutputChannel: () => ({ info: (m) => logLines.push(m), error: (m) => logLines.push(`ERROR ${m}`) }) };
  const logFile = path.join(root, "hook.log");
  process.env.CURSOR_OPUS_HACK_LOG = logFile;
  const previousLoad = Module._load;
  Module._load = function (request) {
    return request === "vscode" ? api : previousLoad.apply(this, arguments);
  };
  t.after(() => {
    Module._load = previousLoad;
    delete process.env.CURSOR_OPUS_HACK_LOG;
  });

  const exported = require(path.join(hookDir, "main.js"));
  assert.equal(exported.real, true);

  const provider = serverProvider();
  exported.activate(provider);
  assert.equal(registered[0], provider);
  const { message } = await provider.unary({}, availableModels);
  assert.ok(message.models.some((model) => model.name === "claude-opus-5-5"));

  assert.ok(logLines.some((line) => line.startsWith("Patched vscode.cursor")));
  assert.ok(logLines.some((line) => line.includes("injected claude-opus-5-5")));
  assert.match(fs.readFileSync(logFile, "utf8"), /\[info\] Patched vscode\.cursor/);
});
