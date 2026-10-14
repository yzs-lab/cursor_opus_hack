"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MODEL_SPECS, buildInjectedModels } = require("../override/models");
const { findCursorApp, loadAvailableModelsMethod, findLostFields } = require("../scripts/cursor-proto");

const models = buildInjectedModels();

test("every spec produces one uniquely named model", () => {
  assert.deepEqual(
    models.map((model) => model.name),
    MODEL_SPECS.map((spec) => spec.id)
  );
  assert.equal(new Set(models.map((model) => model.name)).size, models.length);
});

for (const [index, model] of models.entries()) {
  const spec = MODEL_SPECS[index];

  test(`${model.name}: variants cover every parameter combination`, () => {
    const expected = 2 * 5 * (spec.fast ? 2 : 1) * (spec.thinking ? 2 : 1);
    assert.equal(model.variants.length, expected);
    assert.equal(new Set(model.variants.map((v) => v.variantStringRepresentation)).size, expected);
  });

  test(`${model.name}: exactly one default variant per mode`, () => {
    const nonMax = model.variants.filter((v) => v.isDefaultNonMaxConfig);
    const max = model.variants.filter((v) => v.isDefaultMaxConfig);
    assert.equal(nonMax.length, 1);
    assert.equal(max.length, 1);
    assert.equal(nonMax[0].isMaxMode, false);
    assert.equal(max[0].isMaxMode, true);
    for (const variant of [nonMax[0], max[0]]) {
      const values = Object.fromEntries(variant.parameterValues.map((p) => [p.id, p.value]));
      assert.equal(values.effort, "high");
      assert.notEqual(values.fast, "true");
      assert.notEqual(values.thinking, "false");
    }
  });

  test(`${model.name}: variant parameters match the parameter definitions`, () => {
    const definitions = model.parameterDefinitions;
    for (const variant of model.variants) {
      assert.deepEqual(
        variant.parameterValues.map((p) => p.id),
        definitions.map((d) => d.id)
      );
      for (const [i, { value }] of variant.parameterValues.entries()) {
        const type = definitions[i].parameterType;
        const allowed = (type.enumParameter || type.booleanParameter).values.map((v) => v.value);
        assert.ok(allowed.includes(value), `${variant.variantStringRepresentation}: ${value} not in ${allowed}`);
      }
      assert.equal(variant.isMaxMode, variant.parameterValues.some((p) => p.id === "context" && p.value === "1m"));
    }
  });

  test(`${model.name}: legacy slugs are unique and cover every variant`, () => {
    assert.equal(new Set(model.legacySlugs).size, model.legacySlugs.length);
    for (const variant of model.variants) {
      assert.ok(model.legacySlugs.includes(variant.legacySlug), variant.legacySlug);
    }
  });
}

test("injected models survive Cursor's real AvailableModelsResponse encoding", (t) => {
  if (!findCursorApp()) {
    t.skip("Cursor.app not found");
    return;
  }
  const method = loadAvailableModelsMethod();
  const decoded = method.O.fromBinary(new method.O({ models }).toBinary());
  assert.deepEqual(findLostFields(models, decoded.models), []);
});
