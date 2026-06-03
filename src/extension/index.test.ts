import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piOrchestraExtension from "./index.ts";

test("bus parameters use an OpenAI-compatible root object schema", () => {
  const registeredTools = registerExtensionTools();

  const bus = registeredTools.find((tool) => tool.name === "bus");
  assert.ok(bus);

  const parameters = bus.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, ["create", "status", "publish"]);
  assert.match(parameters.properties.action?.description ?? "", /work grouping boundary/);
  assert.match(parameters.properties.id?.description ?? "", /one bus groups the subagents/);
  assert.match(parameters.properties.message?.description ?? "", /work bus/);
});

test("subagent parameters use an OpenAI-compatible root object schema", () => {
  const registeredTools = registerExtensionTools();

  const subagent = registeredTools.find((tool) => tool.name === "subagent");
  assert.ok(subagent);

  const parameters = subagent.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, ["spawn", "status", "resume", "close"]);
  assert.match(parameters.properties.action?.description ?? "", /spawn creates a new subagent/);
  assert.match(parameters.properties.task?.description ?? "", /Required for action=spawn/);
  assert.match(parameters.properties.busId?.description ?? "", /Required for action=spawn/);
  assert.match(parameters.properties.id?.description ?? "", /Required for action=status/);
  assert.match(parameters.properties.message?.description ?? "", /Required for action=resume/);
});

test("waitBus parameters use an OpenAI-compatible root object schema", () => {
  const registeredTools = registerExtensionTools();

  const waitBus = registeredTools.find((tool) => tool.name === "waitBus");
  assert.ok(waitBus);

  const parameters = waitBus.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.match(parameters.properties.busId?.description ?? "", /Work bus id to wait for/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /Defaults to 10 minutes/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /null to wait indefinitely/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /latest collected state/);
});

function registerExtensionTools(): ToolDefinition[] {
  const registeredTools: ToolDefinition[] = [];

  piOrchestraExtension({
    registerTool(tool: ToolDefinition) {
      registeredTools.push(tool);
    },
  } as unknown as ExtensionAPI);

  return registeredTools;
}

interface JsonSchemaObject {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaProperty>;
}

interface JsonSchemaProperty {
  enum?: string[];
  description?: string;
}
