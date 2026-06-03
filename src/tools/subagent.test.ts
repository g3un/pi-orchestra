import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { AgentRuntime } from "../core/runtime.ts";
import type { AgentStore } from "../core/store.ts";
import { createSubagentTool } from "./subagent.ts";

const profile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned task.",
};

test("subagent spawn creates a bus, starts the runtime, and stores the run", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createSubagentTool({ runtime, store });

  const output = await tool.execute({ action: "spawn", profile, task: "Inspect the code." });

  assert.ok(output.run);
  assert.equal(output.run.id, "agent-1");
  assert.equal(output.run.busId, runtime.created?.bus.id);
  assert.match(output.run.busId, uuid7Pattern);
  assert.deepEqual(runtime.created, {
    profile,
    task: "Inspect the code.",
    bus: store.savedBuses[0],
  });
  assert.deepEqual(store.savedRuns, [output.run]);
});

test("subagent status prefers runtime state and falls back to store state", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createSubagentTool({ runtime, store });
  const runtimeRun = run({ id: "same-id", state: "running" });
  const storeRun = run({ id: "same-id", state: "failed" });
  const fallbackRun = run({
    id: "store-only",
    state: "finished",
    result: {
      status: "success",
      summary: "Found the relevant implementation.",
      data: { file: "src/tools/subagent.ts" },
    },
  });

  runtime.runs.set(runtimeRun.id, runtimeRun);
  store.saveRun(storeRun);
  store.saveRun(fallbackRun);

  const runtimeOutput = await tool.execute({ action: "status", id: "same-id" });
  const fallbackOutput = await tool.execute({ action: "status", id: "store-only" });
  const missingOutput = await tool.execute({ action: "status", id: "missing" });

  assert.equal(runtimeOutput.run, runtimeRun);
  assert.equal(fallbackOutput.run, fallbackRun);
  assert.equal(
    fallbackOutput.message,
    [
      "Subagent store-only is finished.",
      "",
      "Result: success",
      "Found the relevant implementation.",
      "",
      "Data:",
      '{\n  "file": "src/tools/subagent.ts"\n}',
    ].join("\n"),
  );
  assert.equal(missingOutput.run, undefined);
  assert.equal(missingOutput.message, "Subagent missing not found.");
});

test("subagent resume delegates to runtime and stores the returned run", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createSubagentTool({ runtime, store });
  const existing = run({ id: "agent-1", state: "finished" });
  runtime.runs.set(existing.id, existing);

  const output = await tool.execute({ action: "resume", id: existing.id, message: "Continue." });

  assert.deepEqual(runtime.resumed, { id: existing.id, message: "Continue." });
  assert.ok(output.run);
  assert.equal(output.run.state, "running");
  assert.equal(store.getRun(existing.id), output.run);
});

test("subagent push_bus sends parent messages as main and stores the bus message", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createSubagentTool({ runtime, store });
  const existing = run({ id: "agent-1", busId: "bus-1", state: "running" });
  runtime.runs.set(existing.id, existing);
  store.saveRun(existing);
  store.saveBus({ id: existing.busId, messages: [] });

  const output = await tool.execute({
    action: "push_bus",
    id: existing.id,
    message: "New constraint.",
  });

  assert.deepEqual(runtime.pushed, {
    id: existing.id,
    message: "New constraint.",
    from: "main",
  });
  assert.ok(output.run);
  assert.deepEqual(store.busMessagesAdded, [
    {
      busId: existing.busId,
      message: { id: "message-1", message: "New constraint.", from: "main" },
    },
  ]);
  assert.deepEqual(store.getBus(existing.busId)?.messages, [
    { id: "message-1", message: "New constraint.", from: "main" },
  ]);
});

test("subagent close delegates to runtime and records the closed state", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createSubagentTool({ runtime, store });
  const existing = run({ id: "agent-1", state: "finished" });
  store.saveRun(existing);

  const output = await tool.execute({ action: "close", id: existing.id });

  assert.deepEqual(runtime.closedIds, [existing.id]);
  assert.ok(output.run);
  assert.equal(output.run.state, "closed");
  assert.equal(store.getRun(existing.id)?.state, "closed");
});

const uuid7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FakeRuntime implements AgentRuntime {
  runs = new Map<string, AgentRun>();
  created?: { profile: AgentProfile; task: string; bus: Bus };
  resumed?: { id: string; message: string };
  pushed?: { id: string; message: string; from: string };
  closedIds: string[] = [];

  async create(profile: AgentProfile, task: string, bus: Bus): Promise<AgentRun> {
    this.created = { profile, task, bus };
    const createdRun = run({
      id: "agent-1",
      profile: profile.name,
      task,
      busId: bus.id,
      state: "running",
    });
    this.runs.set(createdRun.id, createdRun);
    return createdRun;
  }

  async resume(id: string, message: string): Promise<AgentRun> {
    this.resumed = { id, message };
    const current = this.runs.get(id) ?? run({ id });
    const resumedRun = { ...current, state: "running" as const };
    this.runs.set(id, resumedRun);
    return resumedRun;
  }

  async pushBus(id: string, message: string, from: string): Promise<BusMessage> {
    this.pushed = { id, message, from };
    return { id: "message-1", message, from };
  }

  async close(id: string): Promise<void> {
    this.closedIds.push(id);
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }
}

class FakeStore implements AgentStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly buses = new Map<string, Bus>();
  savedRuns: AgentRun[] = [];
  savedBuses: Bus[] = [];
  busMessagesAdded: Array<{ busId: string; message: BusMessage }> = [];

  saveRun(run: AgentRun): void {
    this.savedRuns.push(run);
    this.runs.set(run.id, run);
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  saveBus(bus: Bus): void {
    this.savedBuses.push(bus);
    this.buses.set(bus.id, bus);
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id);
  }

  addBusMessage(busId: string, message: BusMessage): void {
    this.busMessagesAdded.push({ busId, message });
    const bus = this.buses.get(busId);
    if (!bus) return;
    const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
    if (existingIndex >= 0) {
      bus.messages[existingIndex] = message;
    } else {
      bus.messages.push(message);
    }
  }
}

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: "agent-1",
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
  };
}
