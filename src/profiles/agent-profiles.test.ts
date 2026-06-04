import assert from "node:assert/strict";
import { test } from "vitest";
import { createCodeReviewerProfile, createExternalResearcherProfile, createSourceCodeQaProfile } from "./index.ts";

test("source code QA profile uses caller-provided tools and local-code answer contract", () => {
  const tools = ["read", "bash"];
  const profile = createSourceCodeQaProfile({ name: undefined, tools, model: undefined });
  const customProfile = createSourceCodeQaProfile({
    name: "repo-answerer",
    tools: ["read"],
    model: "mock/model",
  });

  tools.push("edit");

  assert.equal(profile.name, "source-code-qa");
  assert.deepEqual(profile.tools, ["read", "bash"]);
  assert.equal(profile.model, undefined);
  assert.match(profile.systemPrompt, /source-code QA agent/);
  assert.match(profile.systemPrompt, /repository files and explicit task context as authoritative/);
  assert.match(profile.systemPrompt, /do not perform external research or modify files/);
  assert.match(profile.systemPrompt, /blocked when required code\/context\/tools are unavailable/);

  assert.equal(customProfile.name, "repo-answerer");
  assert.deepEqual(customProfile.tools, ["read"]);
  assert.equal(customProfile.model, "mock/model");
});

test("external researcher profile uses caller-provided tools and source discipline", () => {
  const profile = createExternalResearcherProfile({
    name: "project-researcher",
    tools: ["search", "fetch"],
    model: "mock/model",
  });

  assert.equal(profile.name, "project-researcher");
  assert.deepEqual(profile.tools, ["search", "fetch"]);
  assert.equal(profile.model, "mock/model");
  assert.match(profile.systemPrompt, /external research agent/);
  assert.match(profile.systemPrompt, /prefer official and primary sources/);
  assert.match(profile.systemPrompt, /publication or version dates/);
  assert.match(profile.systemPrompt, /required search\/fetch\/browse tools/);
  assert.match(profile.systemPrompt, /finish with status=blocked instead of guessing/);
});

test("code reviewer profile uses caller-provided tools and findings-first contract", () => {
  const profile = createCodeReviewerProfile({ name: undefined, tools: ["read", "bash"], model: undefined });

  assert.equal(profile.name, "code-reviewer");
  assert.deepEqual(profile.tools, ["read", "bash"]);
  assert.equal(profile.model, undefined);
  assert.match(profile.systemPrompt, /code reviewer/);
  assert.match(profile.systemPrompt, /Prioritize findings over summary/);
  assert.match(profile.systemPrompt, /severity, affected file\/symbol or line reference/);
  assert.match(profile.systemPrompt, /Do not modify files/);
  assert.match(profile.systemPrompt, /no material issues are found/);
  assert.match(profile.systemPrompt, /blocked when the target\/diff\/context\/tools are insufficient/);
});
