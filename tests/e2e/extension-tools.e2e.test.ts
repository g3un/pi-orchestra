import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piOrchestraExtension from "../../src/extension/index.ts";
import type { BusOutput } from "../../src/tools/bus.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

test("registered Pi tools execute a bus workflow through the extension boundary", async () => {
  const { tools, handlers } = registerExtensionTools();
  const busTool = requireTool(tools, "bus");
  const ctx = createExtensionContext();

  try {
    const created = await executeTool(busTool, { action: "create", name: "Release Plan" }, ctx);
    const createdDetails = created.details as BusOutput;

    assert.ok(createdDetails.bus);
    assertUuid7(createdDetails.bus.id);
    assert.equal(createdDetails.bus.name, "Release Plan");
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
  } finally {
    disposeContext(handlers, ctx);
  }
});

test("extension keeps orchestration state isolated per cwd", async () => {
  const { tools, handlers } = registerExtensionTools();
  const busTool = requireTool(tools, "bus");
  const firstCwd = createExtensionContext();
  const secondCwd = createExtensionContext();

  try {
    await executeTool(busTool, { action: "create", name: "Shared Name" }, firstCwd);

    const sameCwdStatus = await executeTool(busTool, { action: "status", name: "Shared Name" }, firstCwd);
    const otherCwdStatus = await executeTool(busTool, { action: "status", name: "Shared Name" }, secondCwd);

    assert.match(firstText(sameCwdStatus), /Bus Shared Name has 0 message\(s\)\./);
    assert.equal(firstText(otherCwdStatus), "Bus Shared Name not found.");
  } finally {
    disposeContext(handlers, firstCwd);
    disposeContext(handlers, secondCwd);
  }
});

function assertUuid7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function registerExtensionTools(): { tools: ToolDefinition[]; handlers: Record<string, EventHandler[]> } {
  const tools: ToolDefinition[] = [];
  const handlers: Record<string, EventHandler[]> = {};
  piOrchestraExtension({
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand() {
      return undefined;
    },
    on(eventName: string, handler: EventHandler) {
      handlers[eventName] ??= [];
      handlers[eventName].push(handler);
      return undefined;
    },
  } as unknown as ExtensionAPI);
  return { tools, handlers };
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

function createExtensionContext(): ExtensionContext {
  return {
    cwd: mkdtempSync(join(tmpdir(), "pi-orchestra-e2e-")),
    model: undefined,
    modelRegistry: {
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function disposeContext(handlers: Record<string, EventHandler[]>, ctx: ExtensionContext): void {
  for (const handler of handlers.session_shutdown ?? []) handler({}, ctx);
  rmSync(ctx.cwd, { recursive: true, force: true });
}

function firstText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}
