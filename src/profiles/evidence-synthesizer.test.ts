import assert from "node:assert/strict";
import { test } from "vitest";
import { createEvidenceSynthesizerProfile } from "./evidence-synthesizer.ts";

test("evidence synthesizer profile is restricted by default and accepts name/model overrides", () => {
  const defaultProfile = createEvidenceSynthesizerProfile();
  const customProfile = createEvidenceSynthesizerProfile({ name: "analysis-synthesizer", model: "mock/model" });

  assert.equal(defaultProfile.name, "evidence-synthesizer");
  assert.equal(defaultProfile.model, undefined);
  assert.deepEqual(defaultProfile.tools, []);
  assert.match(defaultProfile.systemPrompt, /evidence synthesizer/);
  assert.match(defaultProfile.systemPrompt, /do not research, inspect files, run commands/);
  assert.match(defaultProfile.systemPrompt, /Use only supplied context/);
  assert.match(defaultProfile.systemPrompt, /blocked if context is insufficient/);

  assert.equal(customProfile.name, "analysis-synthesizer");
  assert.equal(customProfile.model, "mock/model");
  assert.deepEqual(customProfile.tools, []);
});
