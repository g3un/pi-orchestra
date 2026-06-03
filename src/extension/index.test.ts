import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piOrchestraExtension from "./index.ts";

test("extension registers the four target-oriented Pi tools", () => {
  const registeredTools = registerExtensionTools();

  assert.deepEqual(
    registeredTools.map((tool) => tool.name),
    ["bus", "subagent", "workgroup", "workflow"],
  );
});

test("bus parameters use an OpenAI-compatible root object schema with wait actions", () => {
  const registeredTools = registerExtensionTools();

  const bus = registeredTools.find((tool) => tool.name === "bus");
  assert.ok(bus);

  const parameters = bus.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, ["create", "status", "publish", "wait_settled", "wait_next"]);
  assert.match(parameters.properties.action?.description ?? "", /work grouping boundary/);
  assert.match(parameters.properties.action?.description ?? "", /wait_settled waits/);
  assert.match(parameters.properties.action?.description ?? "", /wait_next waits/);
  assert.match(parameters.properties.name?.description ?? "", /human-readable bus name/);
  assert.match(parameters.properties.id?.description ?? "", /Bus id or name/);
  assert.match(parameters.properties.message?.description ?? "", /work bus/);
  assert.match(parameters.properties.excludeRunIds?.description ?? "", /action=wait_next/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /action=wait_settled and action=wait_next/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /null to wait indefinitely/);
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
  assert.deepEqual(parameters.properties.strategy?.enum, ["compete", "synthesize"]);
  assert.match(parameters.properties.members?.description ?? "", /workgroup members/);
});

test("workflow parameters use an OpenAI-compatible root object schema with wait action", () => {
  const registeredTools = registerExtensionTools();

  const workflow = registeredTools.find((tool) => tool.name === "workflow");
  assert.ok(workflow);

  const parameters = workflow.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, ["start", "status", "cancel", "wait"]);
  assert.match(parameters.properties.action?.description ?? "", /wait waits for the workflow/);
  assert.match(parameters.properties.id?.description ?? "", /action=wait/);
  assert.match(parameters.properties.goal?.description ?? "", /Overall workflow goal/);
  assert.match(parameters.properties.stages?.description ?? "", /Linear stages/);
  assert.match(parameters.properties.timeoutMs?.description ?? "", /Optional for action=wait/);
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
