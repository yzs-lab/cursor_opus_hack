"use strict";

// Plain-object versions of aiserver.v1.AvailableModelsResponse.AvailableModel. The protobuf
// class silently drops keys it does not know, so test/models.test.js round-trips these
// through Cursor's real message class to catch renamed or removed fields.

const EFFORTS = [
  { value: "low", displayName: "Low", label: "low" },
  { value: "medium", displayName: "Medium", label: "medium" },
  { value: "high", displayName: "High", label: "high" },
  { value: "xhigh", displayName: "Extra High", label: "extra high" },
  { value: "max", displayName: "Max", label: "max" },
];
const DEFAULT_EFFORT = EFFORTS.find((effort) => effort.value === "high");

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

// Injected models go right before this entry, or at FALLBACK_INSERT_INDEX when it is absent.
const INSERT_BEFORE_MODEL = "gpt-5.6-sol";
const FALLBACK_INSERT_INDEX = 4;

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
    parameterType: {
      booleanParameter: {
        values: [{ value: "false" }, { value: "true", ...enabledValue }],
      },
    },
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
          {
            value: CONTEXT_1M.value,
            displayName: CONTEXT_1M.displayName,
            increasesModelCost: true,
            modelPickerBadges: [],
          },
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
        values: EFFORTS.map((effort) => ({
          value: effort.value,
          displayName: effort.displayName,
          modelPickerBadges: [],
        })),
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

  const label = [
    context.isMaxMode ? context.displayName : "",
    effort.displayName,
    thinking ? "Thinking" : "",
    fast ? "Fast" : "",
  ]
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
    tooltip(
      `**${spec.title}**<br />${spec.description}<br /><br />${context.displayName} context window<br /><br />*Version: ${DEFAULT_EFFORT.label} effort*`
    );

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
      ...(spec.thinking
        ? [booleanParameter("thinking", "Thinking", "Enable extended thinking before responding.", { displayName: "Thinking" })]
        : []),
      contextParameter(spec.context),
      effortParameter(),
      ...(spec.fast
        ? [
            booleanParameter("fast", "Fast", "Significantly faster priority processing.", {
              displayName: "Fast",
              increasesModelCost: true,
            }),
          ]
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

function buildInjectedModels() {
  return MODEL_SPECS.map(buildModel);
}

module.exports = {
  MODEL_SPECS,
  INSERT_BEFORE_MODEL,
  FALLBACK_INSERT_INDEX,
  buildModel,
  buildInjectedModels,
};
