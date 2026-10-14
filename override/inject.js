"use strict";

const { buildInjectedModels, INSERT_BEFORE_MODEL, FALLBACK_INSERT_INDEX } = require("./models");

const WRAPPED = Symbol.for("cursor-opus-hack.wrapped");
const PATCHED = Symbol.for("cursor-opus-hack.patched");

// Adds the Claude models the server left out of an AvailableModels response, using the
// response's own protobuf class so the result serializes exactly like a server model.
function injectModels(method, message, log) {
  if (!message || !Array.isArray(message.models) || typeof method.O !== "function") {
    return;
  }
  const serverCount = message.models.length;
  const returned = new Set(message.models.map((model) => model && model.name));
  // Built fresh every time: the protobuf constructor keeps references to repeated scalar arrays.
  const missing = buildInjectedModels().filter((model) => !returned.has(model.name));

  if (missing.length > 0) {
    const built = new method.O({ models: missing }).models;
    let index = message.models.findIndex((model) => model && model.name === INSERT_BEFORE_MODEL);
    if (index < 0) {
      index = Math.min(FALLBACK_INSERT_INDEX, serverCount);
    }
    message.models.splice(index, 0, ...built);
    if (Array.isArray(message.modelNames)) {
      for (const model of built) {
        if (!message.modelNames.includes(model.name)) {
          message.modelNames.push(model.name);
        }
      }
    }
  }

  if (log) {
    const summary =
      missing.length > 0 ? `injected ${missing.map((model) => model.name).join(", ")}` : "server already returned every injected model";
    log(`AvailableModels: server returned ${serverCount} models; ${summary}`);
  }
}

function wrapProvider(provider, { log, onError } = {}) {
  if (!provider || typeof provider.unary !== "function" || provider[WRAPPED]) {
    return provider;
  }
  const unary = provider.unary;
  try {
    provider.unary = async function (service, method) {
      const response = await unary.apply(provider, arguments);
      if (method && method.name === "AvailableModels") {
        try {
          injectModels(method, response && response.message, log);
        } catch (error) {
          if (onError) onError(error);
        }
      }
      return response;
    };
    provider[WRAPPED] = true;
  } catch (error) {
    if (onError) onError(error);
    return provider;
  }
  if (log) log("Wrapped the connect transport provider");
  return provider;
}

// Cursor defines vscode.cursor.* as configurable but not writable, so this uses defineProperty.
function patchCursorNamespace(vscode, hooks = {}) {
  const cursor = vscode && vscode.cursor;
  if (!cursor || cursor[PATCHED]) {
    return false;
  }
  const register = cursor.registerConnectTransportProvider;
  if (typeof register !== "function") {
    if (hooks.onError) hooks.onError(new Error("vscode.cursor.registerConnectTransportProvider is missing"));
    return false;
  }
  Object.defineProperty(cursor, "registerConnectTransportProvider", {
    value: function registerConnectTransportProvider(provider) {
      return register.call(this, wrapProvider(provider, hooks));
    },
    configurable: true,
    enumerable: true,
    writable: true,
  });
  Object.defineProperty(cursor, PATCHED, { value: true, configurable: true });
  return true;
}

module.exports = { injectModels, wrapProvider, patchCursorNamespace };
