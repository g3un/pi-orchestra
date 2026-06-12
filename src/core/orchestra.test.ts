import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "./subagent.ts";
import type { BusMessage } from "./bus.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { Orchestra } from "./orchestra.ts";
import type { AgentRuntime, SpawnAgentRuntimeOptions } from "./runtime.ts";
import type { AgentStore } from "./store.ts";

const profile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned task.",
  tools: ["read", "bash"],
  model: undefined,
};

test("orchestra creates buses in the store", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const bus = orchestra.createBus({ name: undefined });

  assert.deepEqual(store.getBus(bus.id), bus);
  assertUuid7(bus.id);
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
    lastDeliveredMessageId: null,
    deliveredMessageIds: [],
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

  assertUuid7(bus.id);
  assert.equal(bus.name, "Frontend Audit");
  assert.deepEqual(orchestra.getBus(bus.name), bus);
  assertUuid7(run.id);
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

  assertUuid7(namedRun.id);
  assert.equal(namedRun.name, "Reviewer");
  assertUuid7(firstAutoRun.id);
  assert.equal(firstAutoRun.name, "researcher");
  assertUuid7(secondAutoRun.id);
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
      sessionFile: `.pi/orchestra/sessions/${options.id}.jsonl`,
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
    const busMessage: BusMessage = { id: "message-1", message, from };
    this.store.addBusMessage(busId, busMessage);
    return busMessage;
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

function assertUuid7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
    parentRunId: overrides.parentRunId ?? null,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}
