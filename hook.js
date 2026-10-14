"use strict";

// Entry point of the anysphere.cursor-always-local override (install.sh copies it to
// node_modules/hook/dist/main.js). It runs as cursor-always-local itself, so require("vscode")
// returns the same API object the real extension gets: patch it, then load the real code.

const path = require("path");
const vscode = require("vscode");

const EFFORTS = [
  { value: "low", displayName: "Low", label: "low" },
  { value: "medium", displayName: "Medium", label: "medium" },
  { value: "high", displayName: "High", label: "high" },
  { value: "xhigh", displayName: "Extra High", label: "extra high" },
  { value: "max", displayName: "Max", label: "max" },
];
const DEFAULT_EFFORT = EFFORTS[2];
const CONTEXT_200K = { value: "200k", displayName: "200K", tokens: 200000 };
const CONTEXT_300K = { value: "300k", displayName: "300K", tokens: 300000 };
const CONTEXT_1M = { value: "1m", displayName: "1M", tokens: 1000000 };

const MODEL_SPECS = [
  {
    id: "claude-opus-5-5",
    title: "Claude Opus 5.5",
    description: "Anthropic's most intelligent model for complex agentic coding and reasoning.",
    context: CONTEXT_300K,
    fast: true,
    defaultOn: true,
    recommendedForBackgroundComposer: true,
    aliases: ["opus-5.5", "opus-5-5", "claude-opus-5.5"],
  },
  {
    id: "claude-sonnet-5-5",
    title: "Claude Sonnet 5.5",
    description: "Anthropic's fast, capable model for everyday coding.",
    context: CONTEXT_200K,
    defaultOn: true,
    aliases: ["sonnet-5.5", "sonnet-5-5", "claude-sonnet-5.5"],
  },
  {
    id: "claude-opus-5",
    title: "Claude Opus 5",
    description: "Anthropic model.",
    context: CONTEXT_300K,
    thinking: true,
    fast: true,
    defaultOn: false,
  },
  {
    id: "claude-opus-4-8",
    title: "Claude Opus 4.8",
    description: "Anthropic model.",
    context: CONTEXT_300K,
    thinking: true,
    fast: true,
    defaultOn: false,
  },
];

// Injected models go right before this entry, or at index 4 when it is missing.
const INSERT_BEFORE_MODEL = "gpt-5.6-sol";

function tooltip(markdownContent) {
  return {
    primaryText: "",
    secondaryText: "",
    secondaryWarningText: false,
    icon: "",
    tertiaryText: "",
    tertiaryTextUrl: "",
    markdownContent,
  };
}

function booleanParameter(id, name, markdownTooltip, enabledValue) {
  return {
    id,
    name,
    markdownTooltip,
    parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true", ...enabledValue }] } },
    isCycleableByHotkey: false,
  };
}

function contextParameter(base) {
  return {
    id: "context",
    name: "Context",
    markdownTooltip: "Context size the model has available.",
    parameterType: {
      enumParameter: {
        values: [
          { value: base.value, displayName: base.displayName, modelPickerBadges: [] },
          { value: CONTEXT_1M.value, displayName: CONTEXT_1M.displayName, increasesModelCost: true, modelPickerBadges: [] },
        ],
      },
    },
  };
}

function effortParameter() {
  return {
    id: "effort",
    name: "Effort",
    markdownTooltip: "Effort the model uses to generate its response.",
    parameterType: {
      enumParameter: {
        values: EFFORTS.map((effort) => ({ value: effort.value, displayName: effort.displayName, modelPickerBadges: [] })),
      },
    },
    isCycleableByHotkey: true,
  };
}

function buildVariant(spec, { thinking, context, effort, fast }) {
  const parameterValues = [];
  if (thinking !== undefined) {
    parameterValues.push({ id: "thinking", value: String(thinking) });
  }
  parameterValues.push({ id: "context", value: context.value }, { id: "effort", value: effort.value });
  if (fast !== undefined) {
    parameterValues.push({ id: "fast", value: String(fast) });
  }

  const label = [context.isMaxMode ? context.displayName : "", effort.displayName, thinking ? "Thinking" : "", fast ? "Fast" : ""]
    .filter(Boolean)
    .join(" ");
  const displayName = `${spec.title} <span style="color: var(--cursor-text-tertiary);">${label}</span>`;
  const isDefault = effort === DEFAULT_EFFORT && !fast && thinking !== false;
  const fastNote = fast
    ? `<br /><br /><span style="color:var(--vscode-editorWarning-foreground);">The same ${spec.title} model, using Anthropic's fast priority processing.</span>`
    : "";

  return {
    parameterValues,
    displayName,
    displayNameOutsidePicker: displayName,
    isMaxMode: context.isMaxMode,
    ...(isDefault ? { [context.isMaxMode ? "isDefaultMaxConfig" : "isDefaultNonMaxConfig"]: true } : {}),
    tooltipData: tooltip(
      `**${spec.title}${fast ? " (fast)" : ""}**<br />${spec.description}<br /><br />${context.displayName} context window${fastNote}<br /><br />*Version: ${effort.label} effort*`
    ),
    variantStringRepresentation: `${spec.id}[${parameterValues.map((p) => `${p.id}=${p.value}`).join(",")}]`,
    legacySlug: `${spec.id}${thinking ? "-thinking" : ""}-${effort.value}${fast ? "-fast" : ""}`,
  };
}

// Plain-object aiserver.v1.AvailableModelsResponse.AvailableModel; the protobuf class silently
// drops keys it does not know, so field names must match Cursor's schema exactly.
function buildModel(spec) {
  const contexts = [
    { ...spec.context, isMaxMode: false },
    { ...CONTEXT_1M, isMaxMode: true },
  ];
  const variants = [];
  for (const thinking of spec.thinking ? [false, true] : [undefined]) {
    for (const context of contexts) {
      for (const effort of EFFORTS) {
        for (const fast of spec.fast ? [false, true] : [undefined]) {
          variants.push(buildVariant(spec, { thinking, context, effort, fast }));
        }
      }
    }
  }
  const summary = (context) =>
    tooltip(`**${spec.title}**<br />${spec.description}<br /><br />${context.displayName} context window<br /><br />*Version: ${DEFAULT_EFFORT.label} effort*`);

  return {
    name: spec.id,
    defaultOn: spec.defaultOn,
    supportsAgent: true,
    degradationStatus: 0,
    tooltipData: summary(spec.context),
    tooltipDataForMaxMode: summary(CONTEXT_1M),
    supportsThinking: true,
    supportsImages: true,
    supportsMaxMode: true,
    supportsNonMaxMode: true,
    contextTokenLimit: spec.context.tokens,
    contextTokenLimitForMaxMode: CONTEXT_1M.tokens,
    clientDisplayName: spec.title,
    serverModelName: spec.id,
    isRecommendedForBackgroundComposer: Boolean(spec.recommendedForBackgroundComposer),
    supportsPlanMode: true,
    supportsSandboxing: true,
    inputboxShortModelName: spec.title,
    parameterDefinitions: [
      ...(spec.thinking ? [booleanParameter("thinking", "Thinking", "Enable extended thinking before responding.", { displayName: "Thinking" })] : []),
      contextParameter(spec.context),
      effortParameter(),
      ...(spec.fast
        ? [booleanParameter("fast", "Fast", "Significantly faster priority processing.", { displayName: "Fast", increasesModelCost: true })]
        : []),
    ],
    variants,
    legacySlugs: [...new Set(variants.map((variant) => variant.legacySlug))],
    idAliases: spec.aliases || [],
    namedModelSectionIndex: 1,
    vendorName: "anthropic",
    vendor: { id: 1, displayName: "Anthropic" },
    cloudAgentEffortModes: [],
    modelPickerBadges: [],
  };
}

let channel;
try {
  channel = vscode.window.createOutputChannel("Cursor Opus Hack", { log: true });
} catch {
  channel = undefined;
}

function log(level, message) {
  if (channel && channel[level]) {
    channel[level](message);
  }
}

let lastLine;

function injectModels(method, message) {
  if (!message || !Array.isArray(message.models) || typeof method.O !== "function") {
    return;
  }
  const serverCount = message.models.length;
  const returned = new Set(message.models.map((model) => model && model.name));
  // Built fresh for every response: the protobuf constructor keeps references to repeated scalar arrays.
  const missing = MODEL_SPECS.filter((spec) => !returned.has(spec.id)).map(buildModel);

  if (missing.length > 0) {
    const built = new method.O({ models: missing }).models;
    let index = message.models.findIndex((model) => model && model.name === INSERT_BEFORE_MODEL);
    if (index < 0) {
      index = Math.min(4, serverCount);
    }
    message.models.splice(index, 0, ...built);
    if (Array.isArray(message.modelNames)) {
      message.modelNames.push(...built.map((model) => model.name).filter((name) => !message.modelNames.includes(name)));
    }
  }

  const summary = missing.length > 0 ? `injected ${missing.map((model) => model.name).join(", ")}` : "server already returned every injected model";
  const line = `AvailableModels: server returned ${serverCount} models; ${summary}`;
  // The model list refreshes every few minutes; only log when the outcome changes.
  if (line !== lastLine) {
    lastLine = line;
    log("info", line);
  }
}

function wrapProvider(provider) {
  if (!provider || typeof provider.unary !== "function") {
    return provider;
  }
  const unary = provider.unary;
  provider.unary = async function (service, method) {
    const response = await unary.apply(provider, arguments);
    if (method && method.name === "AvailableModels") {
      try {
        injectModels(method, response && response.message);
      } catch (error) {
        log("error", `Failed to inject models: ${(error && error.stack) || error}`);
      }
    }
    return response;
  };
  log("info", "Wrapped the connect transport provider");
  return provider;
}

try {
  const register = vscode.cursor.registerConnectTransportProvider;
  // Cursor defines vscode.cursor.* as configurable but not writable, so plain assignment fails.
  Object.defineProperty(vscode.cursor, "registerConnectTransportProvider", {
    value: (provider) => register.call(vscode.cursor, wrapProvider(provider)),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  log("info", "Patched vscode.cursor.registerConnectTransportProvider");
} catch (error) {
  log("error", `Failed to patch vscode.cursor: ${(error && error.stack) || error}`);
}

module.exports = require(path.join(__dirname, "..", "..", "..", "dist", "main.js"));
