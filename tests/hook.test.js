"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const app = process.env.CURSOR_APP || "/Applications/Cursor.app";
const appRoot = path.join(app, "Contents/Resources/app");
const { proto3 } = require(path.join(appRoot, "node_modules/@bufbuild/protobuf"));
const source = fs.readFileSync(path.join(appRoot, "out/vs/workbench/api/node/extensionHostProcess.js"), "utf8");

// Load only generated schema constructors and their referenced types, not the extension host.
// This makes the regression run against the installed Cursor's actual wire format.
function loadResponseType() {
  const root = source.match(/([\w$]+)=([\w$]+)\.makeMessageType\("aiserver\.v1\.AvailableModelsResponse"/);
  assert.ok(root, "Cursor AvailableModelsResponse schema not found");
  const declarations = new Map();
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function collect(symbol) {
    if (declarations.has(symbol)) return;
    const match = new RegExp(`(?<![\\w$])${escape(symbol)}=${escape(root[2])}\\.make(?:MessageType|Enum)\\(`).exec(source);
    assert.ok(match, `Cursor schema dependency not found: ${symbol}`);
    const start = match.index;
    let depth = 1;
    let quote;
    let end = start + match[0].length;
    for (; end < source.length && depth > 0; end++) {
      const char = source[end];
      if (quote) {
        if (char === "\\") end++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    assert.equal(depth, 0, `Unterminated schema declaration: ${symbol}`);
    const declaration = source.slice(start, end);
    declarations.set(symbol, declaration);
    const references = declaration.matchAll(/\bT:([a-zA-Z_$][\w$]*)(?=[,}])|\.getEnumType\(([a-zA-Z_$][\w$]*)\)/g);
    for (const reference of references) collect(reference[1] || reference[2]);
  }
  collect(root[1]);
  const context = { [root[2]]: proto3 };
  vm.runInNewContext(`${[...declarations.values()].map((value) => `var ${value};`).join("\n")}\nResponse = ${root[1]};`, context);
  return context.Response;
}

const Response = loadResponseType();
class RawBytesPreEncodedMessage {
  constructor(bytes) { this.rawBytes = bytes; }
  static fromBinary(bytes) { return new this(bytes); }
  toBinary() { return this.rawBytes; }
}
const descriptor = { name: "AvailableModels", O: Response };
const rawDescriptor = { ...descriptor, O: RawBytesPreEncodedMessage };
const service = { typeName: "aiserver.v1.AiService", methods: { availableModels: descriptor } };
const expected = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-opus-4-8"];

function harness() {
  const logs = [];
  const channel = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message) => logs.push({ level, message })]));
  const vscode = { window: { createOutputChannel: () => channel }, cursor: {} };
  Object.defineProperty(vscode.cursor, "registerConnectTransportProvider", {
    value: (provider) => provider, configurable: true, enumerable: true,
  });
  const context = {
    __dirname: "/test/node_modules/hook/dist", module: { exports: {} },
    require: (name) => name === "vscode" ? vscode : name === "path" ? path : {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../hook.js"), "utf8"), context);
  return { logs, wrap: (provider) => vscode.cursor.registerConnectTransportProvider(provider) };
}

function catalog() {
  return new Response({
    models: [{ name: "auto" }, { name: "gpt-5.6-sol", clientDisplayName: "GPT" }],
    modelNames: ["auto", "gpt-5.6-sol"], useModelParameters: true,
    composerModelConfig: { defaultModel: "auto", fallbackModels: ["gpt-5.6-sol"] },
    subagentModelConfigs: { reviewer: { defaultModel: "gpt-5.6-sol" } },
    displayConfiguration: { hideSearchBar: false },
  });
}

function response(message) {
  return { message, header: new Headers({ "x-request-id": "test" }), trailer: new Headers(), stream: false };
}

function assertInjected(message) {
  assert.deepEqual(message.models.map((model) => model.name), ["auto", ...expected, "gpt-5.6-sol"]);
  assert.deepEqual(message.modelNames, ["auto", "gpt-5.6-sol", ...expected]);
  const opus = message.models.find((model) => model.name === expected[0]);
  assert.equal(opus.defaultOn, true);
  assert.equal(opus.vendor.displayName, "Anthropic");
  assert.equal(opus.variants.length, 20);
  assert.ok(opus.variants.some((variant) => variant.isDefaultMaxConfig));
  assert.ok(opus.variants.some((variant) => variant.isDefaultNonMaxConfig));
  assert.deepEqual(opus.parameterDefinitions.map((parameter) => parameter.id), ["context", "effort", "fast"]);
  assert.equal(opus.variants.find((variant) => variant.isDefaultMaxConfig).parameterValues.find((value) => value.id === "context").value, "1m");
}

test("legacy typed response injects models and retains server configuration", async () => {
  const { wrap, logs } = harness();
  const result = response(catalog());
  const original = result.message;
  const provider = wrap({ unary: async () => result });
  assert.equal(await provider.unary(service, descriptor), result);
  assert.equal(result.message, original);
  assertInjected(Response.fromBinary(result.message.toBinary()));
  assert.equal(result.message.composerModelConfig.defaultModel, "auto");
  assert.ok(logs.some((entry) => entry.message.includes("server returned 2 models; injected")));
});

test("Cursor raw byte bridge decodes real schema and restores the raw wrapper", async () => {
  const { wrap, logs } = harness();
  const original = catalog();
  const result = response(RawBytesPreEncodedMessage.fromBinary(original.toBinary()));
  const header = result.header;
  const trailer = result.trailer;
  const provider = wrap({ unary: async () => result });
  assert.equal(await provider.unary(service, rawDescriptor), result);
  assert.ok(result.message instanceof RawBytesPreEncodedMessage);
  assert.equal(result.header, header);
  assert.equal(result.trailer, trailer);
  const decoded = Response.fromBinary(result.message.toBinary());
  assertInjected(decoded);
  assert.deepEqual(decoded.composerModelConfig.toJson(), original.composerModelConfig.toJson());
  assert.deepEqual(decoded.subagentModelConfigs.reviewer.toJson(), original.subagentModelConfigs.reviewer.toJson());
  assert.deepEqual(decoded.displayConfiguration.toJson(), original.displayConfiguration.toJson());
  assert.equal(decoded.useModelParameters, true);
  assert.equal(logs.filter((entry) => entry.level === "error").length, 0);
});

test("raw response preserves unknown protobuf fields", async () => {
  const { wrap } = harness();
  const unknownField = Uint8Array.from([0xa0, 0x06, 0x07]);
  const bytes = Buffer.concat([catalog().toBinary(), unknownField]);
  const result = response(RawBytesPreEncodedMessage.fromBinary(bytes));
  await wrap({ unary: async () => result }).unary(service, rawDescriptor);
  const decoded = result.message.toBinary();
  assert.deepEqual(Array.from(decoded.slice(-3)), Array.from(unknownField));
  assertInjected(Response.fromBinary(decoded));
});

test("refreshes are idempotent and already-returned models stay untouched", async () => {
  const { wrap } = harness();
  const original = catalog();
  original.models.splice(1, 0, new Response({ models: [{ name: expected[0], clientDisplayName: "Server Opus" }] }).models[0]);
  original.modelNames.push(expected[0]);
  const result = response(RawBytesPreEncodedMessage.fromBinary(original.toBinary()));
  const provider = wrap({ unary: async () => result });
  await provider.unary(service, rawDescriptor);
  const first = result.message.toBinary();
  await provider.unary(service, rawDescriptor);
  assert.deepEqual(result.message.toBinary(), first);
  const decoded = Response.fromBinary(first);
  assert.equal(decoded.models.find((model) => model.name === expected[0]).clientDisplayName, "Server Opus");
  assert.equal(new Set(decoded.modelNames).size, decoded.modelNames.length);
});

test("CppService's same-named method and unrelated RPCs pass through unchanged", async () => {
  const { wrap, logs } = harness();
  const result = response(catalog());
  const original = result.message.toBinary();
  const provider = wrap({ unary: async () => result });
  await provider.unary({ ...service, typeName: "aiserver.v1.CppService" }, descriptor);
  await provider.unary(service, { ...descriptor, name: "HealthCheck" });
  assert.deepEqual(result.message.toBinary(), original);
  assert.ok(!logs.some((entry) => entry.message.startsWith("AvailableModels:")));
});

test("unsupported raw schema and malformed bytes log errors without breaking transport", async () => {
  for (const bytes of [catalog().toBinary(), Uint8Array.from([0xff])]) {
    const { wrap, logs } = harness();
    const result = response(RawBytesPreEncodedMessage.fromBinary(bytes));
    const original = result.message;
    const targetService = bytes[0] === 0xff ? service : { ...service, methods: {} };
    assert.equal(await wrap({ unary: async () => result }).unary(targetService, rawDescriptor), result);
    assert.equal(result.message, original);
    assert.ok(logs.some((entry) => entry.level === "error" && entry.message.startsWith("Failed to inject models:")));
  }
});

test("original transport errors, receiver and arguments are preserved", async () => {
  const { wrap } = harness();
  const error = new Error("network unavailable");
  const args = [service, descriptor, undefined, 1000, { test: "header" }, { request: true }, {}];
  const provider = { unary: async function (...received) { assert.equal(this, provider); assert.deepEqual(received, args); throw error; } };
  await assert.rejects(wrap(provider).unary(...args), (received) => received === error);
});
