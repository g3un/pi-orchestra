import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import { createBusSubscriptionId, type Bus, type BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { createBusTool } from "./bus.ts";

test("bus create allocates a standalone bus through orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra, store: new InMemoryAgentStore() });

  const output = await tool.execute({ action: "create", name: undefined });

  assert.ok(output.bus);
  assert.equal(output.bus.id, "bus-1");
  assert.deepEqual(output.bus.messages, []);
  assert.equal(orchestra.getBus(output.bus.id), output.bus);
  assert.equal(output.message, "Created bus bus-1.");
});

test("bus status returns stored bus messages", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    messages: [
      { id: "message-1", from: "main", message: "Initial context." },
      { id: "message-2", from: "agent-1", message: "Agent context." },
    ],
  };
  orchestra.buses.set(bus.id, bus);
  store.saveRun(run({ id: "agent-1", name: "Researcher A" }));

  const output = await tool.execute({ action: "status", name: bus.name });
  const missingOutput = await tool.execute({ action: "status", name: "missing" });

  assert.equal(output.bus, bus);
  assert.equal(
    output.message,
    [
      "Bus bus-1 has 2 message(s).",
      "",
      "Messages:",
      "- message-1 from main:",
      "Initial context.",
      "- message-2 from Researcher A:",
      "Agent context.",
    ].join("\n"),
  );
  assert.equal(missingOutput.bus, undefined);
  assert.equal(missingOutput.message, "Bus missing not found.");
});

test("bus publish delegates with the bus name", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra, store: new InMemoryAgentStore() });
  const bus: Bus = { id: "shared-context", name: "Shared Context", messages: [] };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "publish", name: bus.name, message: "New constraint.", from: "main" });

  assert.deepEqual(orchestra.published, {
    id: bus.name,
    message: "New constraint.",
    from: "main",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", message: "New constraint.", from: "main" });
  assert.deepEqual(orchestra.getBus(bus.id)?.messages, [{ id: "message-1", message: "New constraint.", from: "main" }]);
  assert.equal(
    output.message,
    "Published message to bus Shared Context.\n\nMessages:\n- message-1 from main:\nNew constraint.",
  );
});

test("bus publish preserves an explicit sender", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const bus: Bus = { id: "bus-1", name: "bus-1", messages: [] };
  orchestra.buses.set(bus.id, bus);
  store.saveRun(run({ id: "agent-1", name: "Researcher A" }));

  const output = await tool.execute({ action: "publish", name: bus.name, message: "Peer context.", from: "agent-1" });

  assert.deepEqual(orchestra.published, {
    id: bus.id,
    message: "Peer context.",
    from: "agent-1",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", message: "Peer context.", from: "agent-1" });
  assert.equal(
    output.message,
    "Published message to bus bus-1.\n\nMessages:\n- message-1 from Researcher A:\nPeer context.",
  );
});

test("bus subscribe and unsubscribe manage the main bus subscription", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    messages: [{ id: "message-1", from: "agent-1", message: "Existing context." }],
  };
  orchestra.buses.set(bus.id, bus);

  const subscribeOutput = await tool.execute({ action: "subscribe", name: bus.name });
  const subscriptionId = createBusSubscriptionId(bus.id, "main", "main");

  assert.equal(subscribeOutput.message, "Subscribed main to bus bus-1 for new messages.");
  assert.deepEqual(store.getBusSubscription(subscriptionId), {
    id: subscriptionId,
    busId: bus.id,
    subscriberId: "main",
    subscriberKind: "main",
    deliveredMessageIds: ["message-1"],
  });

  const unsubscribeOutput = await tool.execute({ action: "unsubscribe", name: bus.name });

  assert.equal(unsubscribeOutput.message, "Unsubscribed main from bus bus-1.");
  assert.equal(store.getBusSubscription(subscriptionId), undefined);
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  published?: { id: string; message: string; from: string };

  createBus(_options: { name: string | undefined }): Bus {
    const id = `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: id, messages: [] };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.findBus(id);
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
    this.published = { id, message, from };
    const bus = this.findBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);

    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, message, from };
    bus.messages.push(busMessage);
    return { bus, busMessage };
  }

  private findBus(id: string): Bus | undefined {
    return this.buses.get(id) ?? [...this.buses.values()].find((bus) => bus.name === id);
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    _options: { name: string | undefined },
  ): Promise<AgentRun> {
    const spawnedRun = run({ id: "agent-1", name: "agent-1", profile, task, busId, state: "running" });
    this.runs.set(spawnedRun.id, spawnedRun);
    return spawnedRun;
  }

  getRun(id: string, _options: { busId: string | undefined }): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId: string | undefined }): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((current) => current.busId === options.busId);
  }

  async messageAgent(id: string, _message: string, _options: { busId: string | undefined }): Promise<AgentRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Agent ${id} not found.`);
    return current;
  }

  async closeAgent(id: string, _options: { busId: string | undefined }): Promise<AgentRun | undefined> {
    return this.runs.get(id);
  }
}

function run(overrides: Partial<AgentRun>): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}
