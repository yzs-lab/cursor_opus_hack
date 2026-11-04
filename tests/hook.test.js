"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const app = process.env.CURSOR_APP || "/Applications/Cursor.app";
const appRoot = path.join(app, "Contents/Resources/app");
const { extractResponseSchema, generateResponseModule, loadResponseModule } = require("../schema.js");
const generatedSchema = generateResponseModule(appRoot);
const Response = loadResponseModule(generatedSchema);
class RawBytesPreEncodedMessage {
  constructor(bytes) { this.rawBytes = bytes; }
  static fromBinary(bytes) { return new this(bytes); }
  toBinary() { return this.rawBytes; }
}
const descriptor = { name: "AvailableModels", O: Response };
const rawDescriptor = { ...descriptor, O: RawBytesPreEncodedMessage };
const service = { typeName: "aiserver.v1.AiService", methods: { availableModels: descriptor } };
const strippedService = { ...service, methods: { availableModels: rawDescriptor } };
const expected = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-opus-4-8"];

function harness({ fallbackSchema = Response } = {}) {
  const logs = [];
  let schemaLoads = 0;
  const channel = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message) => logs.push({ level, message })]));
  const vscode = { window: { createOutputChannel: () => channel }, cursor: {} };
  Object.defineProperty(vscode.cursor, "registerConnectTransportProvider", {
    value: (provider) => provider, configurable: true, enumerable: true,
  });
  const context = {
    __dirname: "/test/node_modules/hook/dist", module: { exports: {} },
    require: (name) => {
      if (name === "vscode") return vscode;
      if (name === "path") return path;
      if (name === "./available-models.js") {
        schemaLoads++;
        if (!fallbackSchema) throw new Error("Generated Cursor model schema unavailable");
        return fallbackSchema;
      }
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../hook.js"), "utf8"), context);
  return { logs, get schemaLoads() { return schemaLoads; }, wrap: (provider) => vscode.cursor.registerConnectTransportProvider(provider) };
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
  const fixture = harness();
  const result = response(catalog());
  const original = result.message;
  const provider = fixture.wrap({ unary: async () => result });
  assert.equal(await provider.unary(service, descriptor), result);
  assert.equal(result.message, original);
  assertInjected(Response.fromBinary(result.message.toBinary()));
  assert.equal(result.message.composerModelConfig.defaultModel, "auto");
  assert.equal(fixture.schemaLoads, 0);
  assert.ok(fixture.logs.some((entry) => entry.message.includes("server returned 2 models; injected")));
});

for (const [label, targetService] of [
  ["typed service descriptor", service],
  ["raw service descriptor", strippedService],
  ["installation-provided descriptor", { ...service, methods: {} }],
]) {
  test(`${label}: raw bytes inject correctly and restore the original wrapper`, async () => {
    const fixture = harness();
    const original = catalog();
    const result = response(RawBytesPreEncodedMessage.fromBinary(original.toBinary()));
    const header = result.header;
    const trailer = result.trailer;
    const provider = fixture.wrap({ unary: async () => result });
    assert.equal(await provider.unary(targetService, rawDescriptor), result);
    assert.ok(result.message instanceof RawBytesPreEncodedMessage);
    assert.equal(result.header, header);
    assert.equal(result.trailer, trailer);
    const decoded = Response.fromBinary(result.message.toBinary());
    assertInjected(decoded);
    assert.deepEqual(decoded.composerModelConfig.toJson(), original.composerModelConfig.toJson());
    assert.deepEqual(decoded.subagentModelConfigs.reviewer.toJson(), original.subagentModelConfigs.reviewer.toJson());
    assert.deepEqual(decoded.displayConfiguration.toJson(), original.displayConfiguration.toJson());
    assert.equal(decoded.useModelParameters, true);
    assert.equal(fixture.schemaLoads, targetService === service ? 0 : 1);
    assert.equal(fixture.logs.filter((entry) => entry.level === "error").length, 0);
  });

  test(`${label}: unknown protobuf fields survive injection`, async () => {
    const { wrap } = harness();
    const unknownField = Uint8Array.from([0xa0, 0x06, 0x07]);
    const bytes = Buffer.concat([catalog().toBinary(), unknownField]);
    const result = response(RawBytesPreEncodedMessage.fromBinary(bytes));
    await wrap({ unary: async () => result }).unary(targetService, rawDescriptor);
    const decoded = result.message.toBinary();
    assert.deepEqual(Array.from(decoded.slice(-3)), Array.from(unknownField));
    assertInjected(Response.fromBinary(decoded));
  });

  test(`${label}: refreshes are idempotent and server-returned models remain untouched`, async () => {
    const { wrap } = harness();
    const original = catalog();
    original.models.splice(1, 0, new Response({ models: [{ name: expected[0], clientDisplayName: "Server Opus" }] }).models[0]);
    original.modelNames.push(expected[0]);
    const result = response(RawBytesPreEncodedMessage.fromBinary(original.toBinary()));
    const provider = wrap({ unary: async () => result });
    await provider.unary(targetService, rawDescriptor);
    const first = result.message.toBinary();
    await provider.unary(targetService, rawDescriptor);
    assert.deepEqual(result.message.toBinary(), first);
    const decoded = Response.fromBinary(first);
    assert.equal(decoded.models.find((model) => model.name === expected[0]).clientDisplayName, "Server Opus");
    assert.equal(new Set(decoded.modelNames).size, decoded.modelNames.length);
  });
}

test("CppService's same-named method and unrelated RPCs pass through unchanged", async () => {
  const fixture = harness();
  const result = response(catalog());
  const original = result.message.toBinary();
  const provider = fixture.wrap({ unary: async () => result });
  await provider.unary({ ...service, typeName: "aiserver.v1.CppService" }, descriptor);
  await provider.unary(service, { ...descriptor, name: "HealthCheck" });
  const rawResult = response(RawBytesPreEncodedMessage.fromBinary(original));
  await fixture.wrap({ unary: async () => rawResult }).unary({ ...strippedService, typeName: "aiserver.v1.CppService" }, rawDescriptor);
  assert.deepEqual(rawResult.message.toBinary(), original);
  assert.deepEqual(result.message.toBinary(), original);
  assert.equal(fixture.schemaLoads, 0);
  assert.ok(!fixture.logs.some((entry) => entry.message.startsWith("AvailableModels:")));
});

test("invalid inputs leave the transport response unchanged", async () => {
  for (const [message, options] of [
    [RawBytesPreEncodedMessage.fromBinary(catalog().toBinary()), { fallbackSchema: null }],
    [RawBytesPreEncodedMessage.fromBinary(Uint8Array.from([0xff])), {}],
    [{ unexpectedShape: true }, {}],
  ]) {
    const { wrap, logs } = harness(options);
    const result = response(message);
    assert.equal(await wrap({ unary: async () => result }).unary(strippedService, rawDescriptor), result);
    assert.equal(result.message, message);
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

test("schema extractor excludes application startup code and matches whole symbols", () => {
  const source = [
    'throw new Error("application startup must never run");',
    'R=P.makeMessageType("aiserver.v1.AvailableModelsResponse",()=>[{no:2,name:"models",kind:"message",T:M,repeated:!0}]);',
    'notM=P.makeMessageType("WrongSuffix",()=>[]);',
    'M=P.makeMessageType("AvailableModel",()=>[{no:1,name:"name",kind:"scalar",T:9}]);',
  ].join("\n");
  const extracted = extractResponseSchema(source);
  const code = extracted.declarations.join("\n");
  assert.equal(extracted.declarations.length, 2);
  assert.ok(!code.includes("application startup"));
  assert.ok(!code.includes("WrongSuffix"));
  assert.ok(code.includes('M=P.makeMessageType("AvailableModel"'));
});

test("schema extractor validates input format and dependencies", () => {
  assert.throws(() => extractResponseSchema("// no full schema"), /schema not found/);
  assert.throws(() => extractResponseSchema('R=P.makeMessageType("aiserver.v1.AvailableModelsResponse",()=>['), /Unterminated/);
  assert.throws(() => extractResponseSchema('R=P.makeMessageType("aiserver.v1.AvailableModelsResponse",()=>[{T:Missing}]);'), /dependency not found/);
});
