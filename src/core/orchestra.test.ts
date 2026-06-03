import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "./agent.ts";
import type { BusMessage } from "./bus.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { Orchestra } from "./orchestra.ts";
import type { AgentRuntime, SpawnAgentRuntimeOptions } from "./runtime.ts";
import type { AgentStore } from "./store.ts";

const profile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned task.",
};

test("orchestra creates buses in the store", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const bus = orchestra.createBus();

  assert.equal(store.getBus(bus.id), bus);
  assert.equal(bus.id, "bus");
  assert.equal(bus.name, "bus");
  assert.deepEqual(bus.messages, []);
});

test("orchestra accepts short names for buses and agent runs", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const bus = orchestra.createBus({ name: "Frontend Audit" });
  const run = await orchestra.spawnAgent(profile, "Inspect the code.", bus.name, { name: "Reviewer A" });

  assert.equal(bus.id, "frontend-audit");
  assert.equal(bus.name, "Frontend Audit");
  assert.equal(orchestra.getBus(bus.name), bus);
  assert.equal(run.id, "reviewer-a");
  assert.equal(run.name, "Reviewer A");
  assert.equal(orchestra.getRun(run.name), run);
});

test("orchestra keeps agent run names globally unique", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });

  const firstBus = orchestra.createBus({ name: "Frontend Audit" });
  const secondBus = orchestra.createBus({ name: "Backend Audit" });
  const namedRun = await orchestra.spawnAgent(profile, "Inspect frontend code.", firstBus.id, { name: "Reviewer" });
  const firstAutoRun = await orchestra.spawnAgent(profile, "Research frontend code.", firstBus.id);
  const secondAutoRun = await orchestra.spawnAgent(profile, "Research backend code.", secondBus.id);

  assert.equal(namedRun.id, "reviewer");
  assert.equal(namedRun.name, "Reviewer");
  assert.equal(firstAutoRun.id, "researcher");
  assert.equal(firstAutoRun.name, "researcher");
  assert.equal(secondAutoRun.id, "researcher-2");
  assert.equal(secondAutoRun.name, "researcher-2");
  assert.equal(orchestra.getRun("Reviewer"), namedRun);
  await assert.rejects(
    () => orchestra.spawnAgent(profile, "Inspect backend code.", secondBus.id, { name: "Reviewer" }),
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

  assert.deepEqual(orchestra.listRuns(), [firstRun, secondRun]);
  assert.deepEqual(orchestra.listRuns({ busId: "bus-1" }), [firstRun]);
});

test("orchestra resolves global run names for lifecycle actions", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus({ name: "Frontend Audit" });
  const run = await orchestra.spawnAgent(profile, "Inspect frontend code.", bus.id, { name: "Reviewer" });
  store.saveRun({ ...run, state: "finished" });

  const messagedRun = await orchestra.messageAgent("Reviewer", "Continue.");
  const closedRun = await orchestra.closeAgent("Reviewer");

  assert.deepEqual(runtime.messaged, { id: run.id, message: "Continue." });
  assert.deepEqual(runtime.closedIds, [run.id]);
  assert.equal(messagedRun.id, run.id);
  assert.equal(closedRun?.id, run.id);
});

test("orchestra delegates agent lifecycle while store remains the source of truth", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();

  const run = await orchestra.spawnAgent(profile, "Inspect the code.", bus.id);
  store.saveRun({ ...run, state: "finished" });
  const messagedRun = await orchestra.messageAgent(run.id, "Continue.");
  const closedRun = await orchestra.closeAgent(run.id);

  assert.deepEqual(runtime.spawned, { profile, task: "Inspect the code.", busId: bus.id });
  assert.deepEqual(runtime.messaged, { id: run.id, message: "Continue." });
  assert.deepEqual(runtime.closedIds, [run.id]);
  assert.equal(orchestra.getRun(run.id), closedRun);
  assert.equal(store.getRun(run.id), closedRun);
  assert.equal(messagedRun.state, "running");
  assert.equal(closedRun?.state, "closed");
});

test("orchestra publishes bus messages through runtime and reads updated store state", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();

  const output = await orchestra.publishBus(bus.id, "New constraint.");

  assert.deepEqual(runtime.published, { busId: bus.id, message: "New constraint.", from: "main" });
  assert.deepEqual(output.bus.messages, [output.busMessage]);
  assert.equal(store.getBus(bus.id), output.bus);
});

test("orchestra messages running agents", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const runningRun = run({ id: "agent-1", state: "running" });
  store.saveRun(runningRun);

  const output = await orchestra.messageAgent(runningRun.id, "Continue.");

  assert.deepEqual(runtime.messaged, { id: runningRun.id, message: "Continue." });
  assert.equal(output, runningRun);
});

test("orchestra waitBusSettled resolves immediately for terminal bus runs", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const finishedRun = run({ id: "agent-1", busId: bus.id, state: "finished" });
  const failedRun = run({ id: "agent-2", busId: bus.id, state: "failed" });
  const otherBusRun = run({ id: "agent-3", busId: "other-bus", state: "running" });
  store.saveRun(finishedRun);
  store.saveRun(failedRun);
  store.saveRun(otherBusRun);

  const output = await orchestra.waitBusSettled(bus.id);

  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, [finishedRun, failedRun]);
  assert.deepEqual(output.runResults, [
    { runId: finishedRun.id, name: finishedRun.name, profile: finishedRun.profile, state: finishedRun.state },
    { runId: failedRun.id, name: failedRun.name, profile: failedRun.profile, state: failedRun.state },
  ]);
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
});

test("orchestra waitBusSettled waits for every current bus run to become terminal", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  const finishedRun = run({ id: "agent-2", busId: bus.id, state: "finished" });
  store.saveRun(runningRun);
  store.saveRun(finishedRun);

  const waitPromise = orchestra.waitBusSettled(bus.id, { timeoutMs: 1000 });
  const completedRun = { ...runningRun, state: "finished" as const };
  store.saveRun(completedRun);

  const output = await waitPromise;

  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, [completedRun, finishedRun]);
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
});

test("orchestra waitBusSettled returns partial results on timeout", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  store.saveRun(runningRun);

  const output = await orchestra.waitBusSettled(bus.id, { timeoutMs: 1 });

  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, [runningRun]);
  assert.deepEqual(output.runResults, [
    { runId: runningRun.id, name: runningRun.name, profile: runningRun.profile, state: runningRun.state },
  ]);
  assert.equal(output.timedOut, true);
  assert.deepEqual(output.pendingRunIds, [runningRun.id]);
});

test("orchestra waitBusSettled rejects non-positive timeouts", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();

  assert.throws(() => orchestra.waitBusSettled(bus.id, { timeoutMs: 0 }), /timeoutMs must be positive/);
});

test("orchestra waitBusSettled accepts null timeout to wait indefinitely", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  store.saveRun(runningRun);

  const waitPromise = orchestra.waitBusSettled(bus.id, { timeoutMs: null });
  const completedRun = { ...runningRun, state: "finished" as const };
  store.saveRun(completedRun);

  const output = await waitPromise;

  assert.deepEqual(output.runs, [completedRun]);
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
});

test("orchestra waitNextRun returns an already completed unexcluded run", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const firstRun = run({ id: "agent-1", busId: bus.id, state: "finished" });
  const secondRun = run({ id: "agent-2", busId: bus.id, state: "finished" });
  store.saveRun(firstRun);
  store.saveRun(secondRun);

  const output = await orchestra.waitNextRun(bus.id, { excludeRunIds: [firstRun.id] });

  assert.equal(output.run, secondRun);
  assert.deepEqual(output.runResult, {
    runId: secondRun.id,
    name: secondRun.name,
    profile: secondRun.profile,
    state: secondRun.state,
  });
  assert.equal(output.timedOut, false);
});

test("orchestra waitNextRun waits for the next unexcluded run", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const excludedRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  const targetRun = run({ id: "agent-2", busId: bus.id, state: "running" });
  store.saveRun(excludedRun);
  store.saveRun(targetRun);

  const waitPromise = orchestra.waitNextRun(bus.id, { excludeRunIds: [excludedRun.id], timeoutMs: 1000 });
  store.saveRun({ ...excludedRun, state: "finished" });
  const completedTargetRun = { ...targetRun, state: "finished" as const };
  store.saveRun(completedTargetRun);

  const output = await waitPromise;

  assert.equal(output.run, completedTargetRun);
  assert.equal(output.timedOut, false);
});

test("orchestra waitNextRun returns latest state on timeout", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  store.saveRun(runningRun);

  const output = await orchestra.waitNextRun(bus.id, { timeoutMs: 1 });

  assert.equal(output.run, undefined);
  assert.equal(output.timedOut, true);
  assert.deepEqual(output.pendingRunIds, [runningRun.id]);
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
      profile: profile.name,
      task,
      busId,
      state: "running",
    };
    this.store.saveRun(run);
    return run;
  }

  async message(id: string, message: string): Promise<AgentRun> {
    this.messaged = { id, message };
    const run = this.store.getRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    if (run.state === "running") return run;

    const messagedRun: AgentRun = { ...run, state: "running", result: undefined };
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

function run(overrides: Partial<AgentRun>): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
  };
}
