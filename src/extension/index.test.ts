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
  assert.match(parameters.properties.name?.description ?? "", /human-readable bus name/);
  assert.match(parameters.properties.id?.description ?? "", /Bus id or name/);
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
  assert.deepEqual(parameters.properties.action?.enum, ["spawn", "status", "message", "close"]);
  assert.match(parameters.properties.action?.description ?? "", /spawn creates a new subagent/);
  assert.match(parameters.properties.task?.description ?? "", /Required for action=spawn/);
  assert.match(parameters.properties.busId?.description ?? "", /bus id or name/);
  assert.match(parameters.properties.name?.description ?? "", /subagent run name/);
  assert.match(parameters.properties.id?.description ?? "", /run id or name/);
  assert.match(parameters.properties.message?.description ?? "", /Required for action=message/);
});

test("workgroup parameters use an OpenAI-compatible root object schema", () => {
  const registeredTools = registerExtensionTools();

  const workgroup = registeredTools.find((tool) => tool.name === "workgroup");
  assert.ok(workgroup);

  const parameters = workgroup.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.match(parameters.properties.busId?.description ?? "", /Existing work bus id or name/);
  assert.match(parameters.properties.goal?.description ?? "", /Shared workgroup goal/);
  assert.deepEqual(parameters.properties.mode?.enum, ["explore", "council"]);
  assert.match(parameters.properties.members?.description ?? "", /workgroup members/);
});

test("waitBusSettled parameters use an OpenAI-compatible root object schema", () => {
  const registeredTools = registerExtensionTools();

  const waitBusSettled = registeredTools.find((tool) => tool.name === "waitBusSettled");
  assert.ok(waitBusSettled);

  const parameters = waitBusSettled.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.match(parameters.properties.busId?.description ?? "", /Work bus id or name to wait for/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /Defaults to 10 minutes/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /null to wait indefinitely/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /latest collected state/);
});

test("waitNextRun parameters use an OpenAI-compatible root object schema", () => {
  const registeredTools = registerExtensionTools();

  const waitNextRun = registeredTools.find((tool) => tool.name === "waitNextRun");
  assert.ok(waitNextRun);

  const parameters = waitNextRun.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.match(parameters.properties.busId?.description ?? "", /next current run/);
  assert.match(parameters.properties.excludeRunIds?.description ?? "", /already handled/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /Defaults to 10 minutes/);
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
