import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWeaverExtension from "./index.ts";

test("subagent parameters use an OpenAI-compatible root object schema", () => {
	const registeredTools: ToolDefinition[] = [];

	piWeaverExtension({
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
	} as unknown as ExtensionAPI);

	const subagent = registeredTools.find((tool) => tool.name === "subagent");
	assert.ok(subagent);

	const parameters = subagent.parameters as JsonSchemaObject;
	assert.equal(parameters.type, "object");
	assert.equal(parameters.additionalProperties, false);
	assert.ok(parameters.properties);
	assert.deepEqual(parameters.properties.action?.enum, ["spawn", "status", "resume", "push_bus", "close"]);
	assert.match(parameters.properties.action?.description ?? "", /spawn creates a new subagent/);
	assert.match(parameters.properties.task?.description ?? "", /Required for action=spawn/);
	assert.match(parameters.properties.id?.description ?? "", /Required for action=status/);
	assert.match(parameters.properties.message?.description ?? "", /Required for action=resume/);
});

interface JsonSchemaObject {
	type?: string;
	additionalProperties?: boolean;
	properties?: Record<string, JsonSchemaProperty>;
}

interface JsonSchemaProperty {
	enum?: string[];
	description?: string;
}
