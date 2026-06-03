import assert from "node:assert/strict";
import { test } from "vitest";
import { createStageLeaderProfile } from "./stage-leader.ts";

test("stage leader profile is restricted by default and accepts name/model overrides", () => {
  const defaultProfile = createStageLeaderProfile();
  const customProfile = createStageLeaderProfile({ name: "analysis-leader", model: "mock/model" });

  assert.equal(defaultProfile.name, "stage-leader");
  assert.equal(defaultProfile.model, undefined);
  assert.deepEqual(defaultProfile.tools, []);
  assert.match(defaultProfile.systemPrompt, /workflow stage leader/);
  assert.match(defaultProfile.systemPrompt, /do not research, inspect files, run commands/);
  assert.match(defaultProfile.systemPrompt, /Use only supplied context/);
  assert.match(defaultProfile.systemPrompt, /blocked if context is insufficient/);

  assert.equal(customProfile.name, "analysis-leader");
  assert.equal(customProfile.model, "mock/model");
  assert.deepEqual(customProfile.tools, []);
});
