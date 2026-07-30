import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "./subagent.ts";
import type { BusMessage } from "./bus.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { Orchestra } from "./orchestra.ts";
import type { AgentRuntime, SpawnAgentRuntimeOptions } from "./runtime.ts";
import type { AgentStore } from "./store.ts";
import { buildAgentRun } from "../../tests/helpers/agent-run-fixture.ts";

const profile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned task.",
  tools: ["read", "bash"],
  model: undefined,
  thinkingLevel: undefined,
};

test("orchestra creates buses in the store", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const bus = orchestra.createBus({ name: undefined });

  assert.deepEqual(store.getBus(bus.id), bus);
  assertUuid(bus.id);
  assert.equal(bus.name, "bus");
  assert.equal(bus.state, "open");
  assert.deepEqual(bus.messages, []);
});

test("orchestra closes buses, clears subscriptions, and rejects new work", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: "Close Me" });
  store.saveBusSubscription({
    id: "sub-1",
    busId: bus.id,
    subscriberId: "main",
    subscriberKind: "main",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
  });

  const closedBus = orchestra.closeBus(bus.name);

  assert.equal(closedBus?.state, "closed");
  assert.equal(store.getBus(bus.id)?.state, "closed");
  assert.deepEqual(
    store.listBusSubscriptions({ busId: bus.id, subscriberId: undefined, subscriberKind: undefined }),
    [],
  );
  await assert.rejects(() => orchestra.publishBus(bus.id, "Too late.", "main"), /Bus Close Me is closed\./);
  await assert.rejects(
    () => orchestra.spawnAgent(profile, "Too late.", bus.id, { name: "late-agent", parentRunId: null }),
    /Bus Close Me is closed\./,
  );
});

test("orchestra accepts short names for buses and agent runs", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const bus = orchestra.createBus({ name: "Frontend Audit" });
  const run = await orchestra.spawnAgent(profile, "Inspect the code.", bus.name, {
    name: "Reviewer A",
    parentRunId: null,
  });

  assertUuid(bus.id);
  assert.equal(bus.name, "Frontend Audit");
  assert.deepEqual(orchestra.getBus(bus.name), bus);
  assertUuid(run.id);
  assert.equal(run.name, "Reviewer A");
  assert.deepEqual(orchestra.getRun(run.name, { busId: undefined }), run);
});

test("orchestra keeps agent run names globally unique", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const firstBus = orchestra.createBus({ name: "Frontend Audit" });
  const secondBus = orchestra.createBus({ name: "Backend Audit" });
  const namedRun = await orchestra.spawnAgent(profile, "Inspect frontend code.", firstBus.id, {
    name: "Reviewer",
    parentRunId: null,
  });
  const firstAutoRun = await orchestra.spawnAgent(profile, "Research frontend code.", firstBus.id, {
    name: undefined,
    parentRunId: null,
  });
  const secondAutoRun = await orchestra.spawnAgent(profile, "Research backend code.", secondBus.id, {
    name: undefined,
    parentRunId: null,
  });

  assertUuid(namedRun.id);
  assert.equal(namedRun.name, "Reviewer");
  assertUuid(firstAutoRun.id);
  assert.equal(firstAutoRun.name, "researcher");
  assertUuid(secondAutoRun.id);
  assert.equal(secondAutoRun.name, "researcher-2");
  assert.deepEqual(orchestra.getRun("Reviewer", { busId: undefined }), namedRun);
  await assert.rejects(
    () => orchestra.spawnAgent(profile, "Inspect backend code.", secondBus.id, { name: "Reviewer", parentRunId: null }),
    /Agent name "Reviewer" is already in use\./,
  );

  store.saveRun({ ...namedRun, state: "success", result: { status: "success", summary: "Done." } });
  await assert.rejects(
    () => orchestra.spawnAgent(profile, "Inspect backend code.", secondBus.id, { name: "Reviewer", parentRunId: null }),
    /Agent name "Reviewer" is already in use\./,
  );
});

test("orchestra lists runs and filters by bus", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const firstBus = orchestra.createBus({ name: "bus-1" });
  const secondBus = orchestra.createBus({ name: "bus-2" });
  const firstRun = run({ id: "agent-1", name: "agent-1", busId: firstBus.id });
  const secondRun = run({ id: "agent-2", name: "agent-2", busId: secondBus.id });
  store.saveRun(firstRun);
  store.saveRun(secondRun);

  assert.deepEqual(orchestra.listRuns({ busId: undefined }), [firstRun, secondRun]);
  assert.deepEqual(orchestra.listRuns({ busId: "bus-1" }), [firstRun]);
});

test("orchestra reuses closed bus names while open buses still conflict", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const first = orchestra.createBus({ name: undefined });
  orchestra.closeBus(first.id);

  const second = orchestra.createBus({ name: undefined });

  assert.equal(second.name, first.name);
  assert.equal(second.name, "bus");
  assert.notEqual(second.id, first.id);
  assert.throws(() => orchestra.createBus({ name: second.name }), /Bus name "bus" is already in use\./);
});

test("orchestra bus lookup prefers live prefixed names over closed legacy ids", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  store.saveBus({ id: "review", name: "review", state: "closed", messages: [], nextMessageSeq: 1 });
  const live = orchestra.createBus({ name: "bus-review" });

  assert.deepEqual(orchestra.getBus("review"), live);
  assert.deepEqual(
    (await orchestra.publishBus("review", "Live fact.", "main")).busMessage,
    store.getBus(live.id)?.messages[0],
  );
});

test("orchestra resolves agent-prefixed run names from unprefixed ids", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: "Frontend Audit" });
  const run = await orchestra.spawnAgent(profile, "Inspect frontend code.", bus.id, {
    name: "agent-reviewer",
    parentRunId: null,
  });

  assert.deepEqual(orchestra.getRun("reviewer", { busId: undefined }), run);
  assert.deepEqual(orchestra.getRun("reviewer", { busId: bus.name }), run);
});

test("orchestra resolves global run names for lifecycle actions", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: "Frontend Audit" });
  const run = await orchestra.spawnAgent(profile, "Inspect frontend code.", bus.id, {
    name: "Reviewer",
    parentRunId: null,
  });
  store.saveRun({ ...run, state: "success", result: { status: "success", summary: "Done." } });

  const messagedRun = await orchestra.messageAgent("Reviewer", "Continue.", { busId: undefined });
  const closedRun = await orchestra.closeAgent("Reviewer", { busId: undefined });

  assert.deepEqual(runtime.messaged, { id: run.id, message: "Continue." });
  assert.deepEqual(runtime.closedIds, [run.id]);
  assert.equal(messagedRun.id, run.id);
  assert.equal(closedRun?.id, run.id);
});

test("orchestra delegates agent lifecycle while store remains the source of truth", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: undefined });

  const run = await orchestra.spawnAgent(profile, "Inspect the code.", bus.id, { name: undefined, parentRunId: null });
  store.saveRun({ ...run, state: "success", result: { status: "success", summary: "Done." } });
  const messagedRun = await orchestra.messageAgent(run.id, "Continue.", { busId: undefined });
  const closedRun = await orchestra.closeAgent(run.id, { busId: undefined });

  assert.deepEqual(runtime.spawned, { profile, task: "Inspect the code.", busId: bus.id });
  assert.deepEqual(runtime.messaged, { id: run.id, message: "Continue." });
  assert.deepEqual(runtime.closedIds, [run.id]);
  assert.deepEqual(orchestra.getRun(run.id, { busId: undefined }), closedRun);
  assert.deepEqual(store.getRun(run.id), closedRun);
  assert.equal(messagedRun.state, "running");
  assert.equal(closedRun?.state, "closed");
});

test.each([
  run({
    id: crypto.randomUUID(),
    name: "delivery-target",
    state: "success",
    result: { status: "success", summary: "Finished during delivery." },
  }),
  run({
    id: crypto.randomUUID(),
    name: "delivery-target",
    state: "blocked",
    result: { status: "blocked", summary: "Blocked during delivery." },
  }),
  run({
    id: crypto.randomUUID(),
    name: "delivery-target",
    state: "failed",
    result: { status: "failed", summary: "Failed during delivery." },
  }),
  run({ id: crypto.randomUUID(), name: "delivery-target", state: "closed", result: null }),
])("orchestra returns the latest $state run after message delivery", async (latestRun) => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  store.saveBus({ id: latestRun.busId, name: "target-bus", state: "open", messages: [], nextMessageSeq: 1 });
  store.saveBus({ id: "other-bus", name: "other-bus", state: "open", messages: [], nextMessageSeq: 1 });
  const idleRun: AgentRun = {
    ...latestRun,
    state: "blocked",
    result: { status: "blocked", summary: "Waiting for input." },
  };
  store.saveRun(idleRun);

  const messageTask = orchestra.messageAgent(idleRun.id, "Continue.", { busId: idleRun.busId });
  assert.equal(store.getRun(idleRun.id)?.state, "running");
  store.saveRun(latestRun);
  if (latestRun.state === "closed") {
    // A closed run ID may be reused as another active run's name.
    store.saveRun(run({ id: crypto.randomUUID(), name: latestRun.id, busId: "other-bus" }));
  }

  const output = await messageTask;

  assert.notEqual(output.state, "running");
  assert.deepEqual(output, latestRun);
  assert.deepEqual(output, store.getRun(idleRun.id));
});

test("orchestra closeAgent honors bus narrowing", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const firstBus = orchestra.createBus({ name: "bus-a" });
  const secondBus = orchestra.createBus({ name: "bus-b" });
  const runOnSecondBus = run({ id: "agent-1", name: "agent-1", busId: secondBus.id });
  store.saveRun(runOnSecondBus);

  const closedRun = await orchestra.closeAgent(runOnSecondBus.id, { busId: firstBus.id });

  assert.equal(closedRun, undefined);
  assert.deepEqual(runtime.closedIds, []);
  assert.deepEqual(store.getRun(runOnSecondBus.id), runOnSecondBus);
});

test("orchestra publishes bus messages through runtime and reads updated store state", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: undefined });

  const output = await orchestra.publishBus(bus.id, "New constraint.", "main");

  assert.deepEqual(runtime.published, { busId: bus.id, message: "New constraint.", from: "main" });
  assert.deepEqual(output.bus.messages, [output.busMessage]);
  assert.deepEqual(store.getBus(bus.id), output.bus);
});

test("orchestra marks sender bus subscriptions delivered after publish", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: "bus-1" });
  const subscriptionId = "main:main:bus:" + bus.id;
  store.saveBusSubscription({
    id: subscriptionId,
    busId: bus.id,
    subscriberId: "main",
    subscriberKind: "main",
    lastDeliveredSeq: 1,
    deliveredSeqs: [],
  });
  store.addBusMessage(bus.id, { id: "message-1", from: "agent-1", message: "Already delivered." });

  const published = await orchestra.publishBus(bus.id, "Main-owned context.", "main");

  assert.equal(published.busMessage.seq, 2);
  assert.deepEqual(store.getBusSubscription(subscriptionId), {
    id: subscriptionId,
    busId: bus.id,
    subscriberId: "main",
    subscriberKind: "main",
    lastDeliveredSeq: 2,
    deliveredSeqs: [],
  });
});

test("orchestra messages reusable finished agents", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const idleRun = run({ id: "agent-1", state: "blocked", result: { status: "blocked", summary: "Need input." } });
  store.saveRun(idleRun);

  const output = await orchestra.messageAgent(idleRun.id, "Continue.", { busId: undefined });

  assert.deepEqual(runtime.messaged, { id: idleRun.id, message: "Continue." });
  assert.equal(output.state, "running");
  assert.equal(output.result, null);
});

class FakeRuntime implements AgentRuntime {
  private readonly store: AgentStore;
  spawned?: { profile: AgentProfile; task: string; busId: string };
  messaged?: { id: string; message: string };
  published?: { busId: string; message: string; from: string };
  closedIds: string[] = [];

  constructor(store: AgentStore) {
    this.store = store;
  }

  async spawn(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: SpawnAgentRuntimeOptions,
  ): Promise<AgentRun> {
    this.spawned = { profile, task, busId };
    const run: AgentRun = {
      id: options.id,
      name: options.name,
      profile,
      task,
      busId,
      parentRunId: options.parentRunId ?? null,
      state: "running",
      ownerSessionId: "session-1",
      result: null,
    };
    this.store.saveRun(run);
    return run;
  }

  async message(id: string, message: string): Promise<AgentRun> {
    this.messaged = { id, message };
    const run = this.store.getRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    if (run.state === "running") return run;

    const messagedRun: AgentRun = { ...run, state: "running", result: null };
    this.store.saveRun(messagedRun);
    return messagedRun;
  }

  async publishBus(busId: string, message: string, from: string): Promise<BusMessage> {
    this.published = { busId, message, from };
    return this.store.addBusMessage(busId, {
      id: `message-${this.store.getBus(busId)?.nextMessageSeq ?? 1}`,
      message,
      from,
    });
  }

  async close(id: string): Promise<AgentRun | undefined> {
    this.closedIds.push(id);
    const run = this.store.getRun(id);
    if (!run) return undefined;

    const closedRun: AgentRun = { ...run, state: "closed" };
    this.store.saveRun(closedRun);
    return closedRun;
  }
}

function assertUuid(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function run(overrides: Partial<AgentRun>): AgentRun {
  const id = overrides.id ?? "agent-1";
  return buildAgentRun({
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined, thinkingLevel: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    parentRunId: overrides.parentRunId ?? null,
    result: overrides.result ?? null,
    ownerSessionId: overrides.ownerSessionId ?? "session-1",
  });
}
