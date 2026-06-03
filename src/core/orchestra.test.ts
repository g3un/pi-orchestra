import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "./agent.ts";
import type { BusMessage } from "./bus.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { Orchestra } from "./orchestra.ts";
import type { AgentRuntime } from "./runtime.ts";
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
  assert.deepEqual(bus.messages, []);
});

test("orchestra lists runs and filters by bus", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const firstRun = run({ id: "agent-1", busId: "bus-1" });
  const secondRun = run({ id: "agent-2", busId: "bus-2" });
  store.saveRun(firstRun);
  store.saveRun(secondRun);

  assert.deepEqual(orchestra.listRuns(), [firstRun, secondRun]);
  assert.deepEqual(orchestra.listRuns({ busId: "bus-1" }), [firstRun]);
});

test("orchestra delegates agent lifecycle while store remains the source of truth", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();

  const run = await orchestra.spawnAgent(profile, "Inspect the code.", bus.id);
  store.saveRun({ ...run, state: "finished" });
  const resumedRun = await orchestra.resumeAgent(run.id, "Continue.");
  const closedRun = await orchestra.closeAgent(run.id);

  assert.deepEqual(runtime.spawned, { profile, task: "Inspect the code.", busId: bus.id });
  assert.deepEqual(runtime.resumed, { id: run.id, message: "Continue." });
  assert.deepEqual(runtime.closedIds, [run.id]);
  assert.equal(orchestra.getRun(run.id), closedRun);
  assert.equal(store.getRun(run.id), closedRun);
  assert.equal(resumedRun.state, "running");
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

test("orchestra rejects resume for running agents", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const runningRun = run({ id: "agent-1", state: "running" });
  store.saveRun(runningRun);

  await assert.rejects(() => orchestra.resumeAgent(runningRun.id, "Continue."), /Agent agent-1 is already running\./);
  assert.equal(runtime.resumed, undefined);
});

test("orchestra waitBus resolves immediately for terminal bus runs", async () => {
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

  const output = await orchestra.waitBus(bus.id);

  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, [finishedRun, failedRun]);
  assert.deepEqual(output.runResults, [
    { runId: finishedRun.id, profile: finishedRun.profile, state: finishedRun.state },
    { runId: failedRun.id, profile: failedRun.profile, state: failedRun.state },
  ]);
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
});

test("orchestra waitBus waits for every current bus run to become terminal", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  const finishedRun = run({ id: "agent-2", busId: bus.id, state: "finished" });
  store.saveRun(runningRun);
  store.saveRun(finishedRun);

  const waitPromise = orchestra.waitBus(bus.id, { timeoutMs: 1000 });
  const completedRun = { ...runningRun, state: "finished" as const };
  store.saveRun(completedRun);

  const output = await waitPromise;

  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, [completedRun, finishedRun]);
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
});

test("orchestra waitBus returns partial results on timeout", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  store.saveRun(runningRun);

  const output = await orchestra.waitBus(bus.id, { timeoutMs: 1 });

  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, [runningRun]);
  assert.deepEqual(output.runResults, [{ runId: runningRun.id, profile: runningRun.profile, state: runningRun.state }]);
  assert.equal(output.timedOut, true);
  assert.deepEqual(output.pendingRunIds, [runningRun.id]);
});

test("orchestra waitBus rejects non-positive timeouts", () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();

  assert.throws(() => orchestra.waitBus(bus.id, { timeoutMs: 0 }), /timeoutMs must be positive/);
});

test("orchestra waitBus accepts null timeout to wait indefinitely", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  store.saveRun(runningRun);

  const waitPromise = orchestra.waitBus(bus.id, { timeoutMs: null });
  const completedRun = { ...runningRun, state: "finished" as const };
  store.saveRun(completedRun);

  const output = await waitPromise;

  assert.deepEqual(output.runs, [completedRun]);
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
});

class FakeRuntime implements AgentRuntime {
  private readonly store: AgentStore;
  spawned?: { profile: AgentProfile; task: string; busId: string };
  resumed?: { id: string; message: string };
  published?: { busId: string; message: string; from: string };
  closedIds: string[] = [];

  constructor(store: AgentStore) {
    this.store = store;
  }

  async spawn(profile: AgentProfile, task: string, busId: string): Promise<AgentRun> {
    this.spawned = { profile, task, busId };
    const run: AgentRun = {
      id: "agent-1",
      profile: profile.name,
      task,
      busId,
      state: "running",
    };
    this.store.saveRun(run);
    return run;
  }

  async resume(id: string, message: string): Promise<AgentRun> {
    this.resumed = { id, message };
    const run = this.store.getRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);

    const resumedRun: AgentRun = { ...run, state: "running", result: undefined };
    this.store.saveRun(resumedRun);
    return resumedRun;
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
  return {
    id: "agent-1",
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
  };
}
