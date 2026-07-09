import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import { createBusSubscriptionId, type Bus, type BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { createBusTool, defineBusPiTool } from "./bus.ts";
import { buildAgentRun } from "../../tests/helpers/agent-run-fixture.ts";

test("bus create allocates a standalone bus through orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra, store: new InMemoryAgentStore() });

  const output = await tool.execute({ action: "create", name: undefined });

  assert.ok(output.bus);
  assert.equal(output.bus.id, "bus-1");
  assert.deepEqual(output.bus.messages, []);
  assert.deepEqual(orchestra.getBus(output.bus.id), output.bus);
  assert.equal(output.message, "Created bus bus-1.\nState: open\nSubscribers: 0");
});

test("bus status returns stored bus messages", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    state: "open",
    messages: [
      { id: "message-1", seq: 1, from: "main", message: "Initial context." },
      { id: "message-2", seq: 2, from: "agent-1", message: "Agent context." },
    ],
    nextMessageSeq: 3,
  };
  orchestra.buses.set(bus.id, bus);
  store.saveRun(run({ id: "agent-1", name: "Researcher A" }));
  store.saveBusSubscription({
    id: createBusSubscriptionId(bus.id, "main", "main"),
    busId: bus.id,
    subscriberId: "main",
    subscriberKind: "main",
    lastDeliveredSeq: 1,
    deliveredSeqs: [],
  });

  const output = await tool.execute({ action: "status", name: bus.name });
  const missingOutput = await tool.execute({ action: "status", name: "missing" });

  assert.equal(output.bus, bus);
  assert.equal(
    output.message,
    [
      "Bus bus-1 has 2 message(s).",
      "State: open",
      "Subscribers: 1",
      "",
      "Messages:",
      "- from main:",
      "Initial context.",
      "- from Researcher A:",
      "Agent context.",
    ].join("\n"),
  );
  assert.equal(missingOutput.bus, undefined);
  assert.equal(missingOutput.message, "Bus missing not found.");
});

test("bus status shows a compact bounded latest-message view", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const hugeMessage = "x".repeat(5_000);
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    state: "open",
    messages: Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index + 1}`,
      seq: index + 1,
      from: "main",
      message: index === 11 ? hugeMessage : `Message ${index + 1}.`,
    })),
    nextMessageSeq: 1,
  };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "status", name: bus.name });

  assert.match(output.message, /Messages \(latest 10 of 12\):/);
  assert.doesNotMatch(output.message, /Message 1\./);
  assert.match(output.message, /… truncated;/);
  assert.equal(output.message.includes(hugeMessage), false);
  assert.ok(output.message.length < 5_000);

  const piTool = defineBusPiTool(() => tool);
  const piOutput = await piTool.execute(
    "call-1",
    { action: "status", name: bus.name },
    new AbortController().signal,
    undefined,
    {} as never,
  );
  const details = piOutput.details as { bus: Bus };
  assert.equal(details.bus.messages.length, 10);
  assert.equal(
    details.bus.messages.some((message) => message.message.includes(hugeMessage)),
    false,
  );
  assert.match(details.bus.messages.at(-1)?.message ?? "", /… truncated;/);
  assert.equal(orchestra.getBus(bus.id)?.messages.at(-1)?.message, hugeMessage);
});

test("bus Pi tool bounds publish details without mutating stored bus history", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const bus: Bus = { id: "bus-1", name: "bus-1", state: "open", messages: [], nextMessageSeq: 1 };
  const hugeMessage = "x".repeat(5_000);
  orchestra.buses.set(bus.id, bus);
  const piTool = defineBusPiTool(() => createBusTool({ orchestra, store }));

  const output = await piTool.execute(
    "call-1",
    { action: "publish", name: bus.name, message: hugeMessage },
    new AbortController().signal,
    undefined,
    {} as never,
  );

  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  assert.match(text, /… truncated;/);
  assert.equal(text.includes(hugeMessage), false);
  const details = output.details as { bus: Bus; busMessage: BusMessage };
  assert.match(details.busMessage.message, /… truncated;/);
  assert.equal(details.busMessage.message.includes(hugeMessage), false);
  assert.equal(details.bus.messages[0]?.message.includes(hugeMessage), false);
  assert.equal(orchestra.getBus(bus.id)?.messages[0]?.message, hugeMessage);
});

test("bus publish delegates with the bus name", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra, store: new InMemoryAgentStore() });
  const bus: Bus = { id: "shared-context", name: "Shared Context", state: "open", messages: [], nextMessageSeq: 1 };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "publish", name: bus.name, message: "New constraint.", from: "main" });

  assert.deepEqual(orchestra.published, {
    id: bus.name,
    message: "New constraint.",
    from: "main",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", seq: 1, message: "New constraint.", from: "main" });
  assert.deepEqual(orchestra.getBus(bus.id)?.messages, [
    { id: "message-1", seq: 1, message: "New constraint.", from: "main" },
  ]);
  assert.equal(
    output.message,
    "Published message to bus Shared Context.\nState: open\nSubscribers: 0\n\nMessages:\n- from main:\nNew constraint.",
  );
});

test("bus publish preserves an explicit sender", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const bus: Bus = { id: "bus-1", name: "bus-1", state: "open", messages: [], nextMessageSeq: 1 };
  orchestra.buses.set(bus.id, bus);
  store.saveRun(run({ id: "agent-1", name: "Researcher A" }));

  const output = await tool.execute({ action: "publish", name: bus.name, message: "Peer context.", from: "agent-1" });

  assert.deepEqual(orchestra.published, {
    id: bus.id,
    message: "Peer context.",
    from: "agent-1",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", seq: 1, message: "Peer context.", from: "agent-1" });
  assert.equal(
    output.message,
    "Published message to bus bus-1.\nState: open\nSubscribers: 0\n\nMessages:\n- from Researcher A:\nPeer context.",
  );
});

test("bus subscribe and unsubscribe manage the main bus subscription", async () => {
  const orchestra = new FakeOrchestra();
  const store = new InMemoryAgentStore();
  const tool = createBusTool({ orchestra, store });
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    state: "open",
    messages: [{ id: "message-1", seq: 1, from: "agent-1", message: "Existing context." }],
    nextMessageSeq: 2,
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
    lastDeliveredSeq: 1,
    deliveredSeqs: [],
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
    const bus: Bus = { id, name: id, state: "open", messages: [], nextMessageSeq: 1 };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.findBus(id);
  }

  closeBus(id: string): Bus | undefined {
    const bus = this.findBus(id);
    if (!bus) return undefined;
    const closedBus: Bus = { ...bus, state: "closed" };
    this.buses.set(bus.id, closedBus);
    return closedBus;
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
    this.published = { id, message, from };
    const bus = this.findBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);

    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, seq: bus.nextMessageSeq, message, from };
    bus.nextMessageSeq += 1;
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
    _options: { name: string | undefined; parentRunId: string | null; ownerSessionId: "session-1" },
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
  return buildAgentRun({
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    parentRunId: overrides.parentRunId ?? null,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
    ownerSessionId: overrides.ownerSessionId ?? "session-1",
  });
}
