import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piOrchestraExtension from "../../src/extension/index.ts";
import type { BusOutput } from "../../src/tools/bus.ts";

test("registered Pi tools execute a bus workflow through the extension boundary", async () => {
  const tools = registerExtensionTools();
  const busTool = requireTool(tools, "bus");
  const ctx = createExtensionContext("/tmp/pi-orchestra-e2e-main");

  const created = await executeTool(busTool, { action: "create", name: "Release Plan" }, ctx);
  const createdDetails = created.details as BusOutput;

  assert.equal(createdDetails.bus?.id, "release-plan");
  assert.match(firstText(created), /Created bus Release Plan\./);

  const published = await executeTool(
    busTool,
    { action: "publish", name: "Release Plan", message: "Coordinate feature flags before rollout." },
    ctx,
  );
  const publishedDetails = published.details as BusOutput;

  assert.ok(publishedDetails.busMessage?.id);
  assert.equal(publishedDetails.busMessage?.from, "main");
  assert.equal(publishedDetails.bus?.messages.length, 1);
  assert.equal(publishedDetails.bus?.messages[0]?.message, "Coordinate feature flags before rollout.");

  const status = await executeTool(busTool, { action: "status", name: "Release Plan" }, ctx);

  assert.match(firstText(status), /Bus Release Plan has 1 message\(s\)\./);
  assert.match(firstText(status), /Coordinate feature flags before rollout\./);
});

test("extension keeps orchestration state isolated per cwd", async () => {
  const tools = registerExtensionTools();
  const busTool = requireTool(tools, "bus");
  const firstCwd = createExtensionContext("/tmp/pi-orchestra-e2e-first");
  const secondCwd = createExtensionContext("/tmp/pi-orchestra-e2e-second");

  await executeTool(busTool, { action: "create", name: "Shared Name" }, firstCwd);

  const sameCwdStatus = await executeTool(busTool, { action: "status", name: "Shared Name" }, firstCwd);
  const otherCwdStatus = await executeTool(busTool, { action: "status", name: "Shared Name" }, secondCwd);

  assert.match(firstText(sameCwdStatus), /Bus Shared Name has 0 message\(s\)\./);
  assert.equal(firstText(otherCwdStatus), "Bus Shared Name not found.");
});

function registerExtensionTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  piOrchestraExtension({
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand() {
      return undefined;
    },
    on() {
      return undefined;
    },
  } as unknown as ExtensionAPI);
  return tools;
}

function requireTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((current) => current.name === name);
  assert.ok(tool, `Expected tool ${name} to be registered.`);
  return tool;
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
  return await tool.execute("tool-call", params, undefined, undefined, ctx);
}

function createExtensionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    model: undefined,
    modelRegistry: {
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function firstText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}
