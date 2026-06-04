import assert from "node:assert/strict";
import { test } from "vitest";
import { defineAgentProfile } from "./profile.ts";

test("profile helper applies name/model overrides and copies tools", () => {
  const tools = ["read"];
  const profile = defineAgentProfile({
    defaultName: "default-profile",
    systemPrompt: ["Line one.", "Line two."],
    tools,
    options: { name: "custom-profile", model: "mock/model" },
  });

  tools.push("bash");

  assert.deepEqual(profile, {
    name: "custom-profile",
    systemPrompt: "Line one.\nLine two.",
    tools: ["read"],
    model: "mock/model",
  });
});

test("profile helper uses default name and undefined model when not overridden", () => {
  const profile = defineAgentProfile({
    defaultName: "default-profile",
    systemPrompt: ["Prompt."],
    tools: [],
    options: { name: undefined, model: undefined },
  });

  assert.equal(profile.name, "default-profile");
  assert.equal(profile.model, undefined);
  assert.deepEqual(profile.tools, []);
});
