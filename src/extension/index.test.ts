import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createProjectSqliteAgentStore, getProjectSqliteStorePath } from "../adapters/sqlite-store.ts";
import piOrchestraExtension from "./index.ts";

test("extension registers the four target-oriented Pi tools", () => {
  const { registeredTools } = registerExtension();

  assert.deepEqual(
    registeredTools.map((tool) => tool.name),
    ["bus", "subagent", "workgroup", "workflow"],
  );
});

test("extension registers a workflow monitor command", () => {
  const { registeredCommands } = registerExtension();

  assert.deepEqual(
    registeredCommands.map((command) => command.name),
    ["orchestra-workflows", "orchestra-recovery"],
  );
});

test("bus parameters use an OpenAI-compatible root object schema without wait actions", () => {
  const { registeredTools } = registerExtension();

  const bus = registeredTools.find((tool) => tool.name === "bus");
  assert.ok(bus);

  const parameters = bus.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, [
    "create",
    "status",
    "publish",
    "subscribe",
    "unsubscribe",
    "compact",
  ]);
  assert.match(parameters.properties.action?.description ?? "", /Manage shared buses/);
  assert.match(parameters.properties.name?.description ?? "", /status\/publish/);
  assert.equal(parameters.properties.id, undefined);
  assert.match(parameters.properties.message?.description ?? "", /Shared context/);
  assert.equal(parameters.properties.excludeRunIds, undefined);
  assert.equal(parameters.properties.timeoutMs, undefined);
});

test("subagent parameters use an OpenAI-compatible root object schema", () => {
  const { registeredTools } = registerExtension();

  const subagent = registeredTools.find((tool) => tool.name === "subagent");
  assert.ok(subagent);

  const parameters = subagent.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, ["spawn", "status", "message", "close"]);
  assert.match(parameters.properties.action?.description ?? "", /spawn creates/);
  assert.match(parameters.properties.task?.description ?? "", /Required for spawn/);
  assert.match(parameters.properties.busId?.description ?? "", /bus name/);
  assert.match(parameters.properties.name?.description ?? "", /readable name/);
  assert.match(parameters.properties.id?.description ?? "", /run name/);
  assert.match(parameters.properties.message?.description ?? "", /Required for message/);
});

test("workgroup parameters use an OpenAI-compatible root object schema", () => {
  const { registeredTools } = registerExtension();

  const workgroup = registeredTools.find((tool) => tool.name === "workgroup");
  assert.ok(workgroup);

  const parameters = workgroup.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.equal(parameters.properties.busId, undefined);
  assert.match(parameters.properties.goal?.description ?? "", /Shared goal/);
  assert.equal(parameters.properties.strategy, undefined);
  assert.match(parameters.properties.members?.description ?? "", /subagents/);
  assert.ok(parameters.properties.members?.items?.properties);
  assert.equal(parameters.properties.members.items.properties.action, undefined);
  assert.equal(parameters.properties.members.items.properties.busId, undefined);
  assert.ok(parameters.properties.members.items.properties.profile);
  assert.ok(parameters.properties.members.items.properties.task);
  assert.ok(parameters.properties.members.items.properties.name);
});

test("workflow parameters use an OpenAI-compatible root object schema without wait action", () => {
  const { registeredTools } = registerExtension();

  const workflow = registeredTools.find((tool) => tool.name === "workflow");
  assert.ok(workflow);

  const parameters = workflow.parameters as JsonSchemaObject;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.ok(parameters.properties);
  assert.deepEqual(parameters.properties.action?.enum, [
    "create",
    "spawn_workgroup",
    "update_status",
    "finish",
    "status",
    "cancel",
  ]);
  assert.match(parameters.properties.action?.description ?? "", /update_status/);
  assert.equal(parameters.properties.id, undefined);
  assert.match(
    parameters.properties.workflowId?.description ?? "",
    /spawn_workgroup\/update_status\/finish\/status\/cancel/,
  );
  assert.match(parameters.properties.goal?.description ?? "", /create\/spawn_workgroup/);
  assert.match(parameters.properties.statusLine?.description ?? "", /update_status/);
  assert.equal(parameters.properties.stages, undefined);
  assert.ok(parameters.properties.leader);
  assert.equal(parameters.properties.timeoutMs, undefined);
});

test("extension backs tools with a project-local SQLite store", async () => {
  const { registeredTools, registeredHandlers } = registerExtension();
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-extension-"));
  const ctx = createExtensionContext(cwd);

  try {
    const bus = registeredTools.find((tool) => tool.name === "bus");
    assert.ok(bus);

    await bus.execute(
      "tool-call-1",
      { action: "create", name: "Persistent Bus" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(existsSync(getProjectSqliteStorePath(cwd)), true);
    const store = createProjectSqliteAgentStore(cwd);
    try {
      const persistedBus = store.listBuses().find((current) => current.name === "Persistent Bus");
      assert.ok(persistedBus);
      assertUuid7(persistedBus.id);
      assert.deepEqual(persistedBus, {
        id: persistedBus.id,
        name: "Persistent Bus",
        state: "open",
        messages: [],
      });
    } finally {
      store.dispose();
    }
  } finally {
    for (const handler of registeredHandlers.session_shutdown ?? []) handler({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

function assertUuid7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function registerExtension(): {
  registeredTools: ToolDefinition[];
  registeredCommands: RegisteredCommand[];
  registeredHandlers: Record<string, RegisteredEventHandler[]>;
} {
  const registeredTools: ToolDefinition[] = [];
  const registeredCommands: RegisteredCommand[] = [];
  const registeredHandlers: Record<string, RegisteredEventHandler[]> = {};

  piOrchestraExtension({
    registerTool(tool: ToolDefinition) {
      registeredTools.push(tool);
    },
    registerCommand(name: string, command: RegisteredCommandOptions) {
      registeredCommands.push({ name, ...command });
    },
    on(eventName: string, handler: RegisteredEventHandler) {
      registeredHandlers[eventName] ??= [];
      registeredHandlers[eventName].push(handler);
      return undefined;
    },
    sendMessage() {
      return undefined;
    },
  } as unknown as ExtensionAPI);

  return { registeredTools, registeredCommands, registeredHandlers };
}

type RegisteredEventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createExtensionContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

interface RegisteredCommand extends RegisteredCommandOptions {
  name: string;
}

interface RegisteredCommandOptions {
  description?: string;
  handler: (...args: unknown[]) => unknown;
}

interface JsonSchemaObject {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaProperty>;
}

interface JsonSchemaProperty {
  enum?: string[];
  description?: string;
  items?: JsonSchemaObject;
}
