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

test("orchestra waitRuns resolves immediately for terminal runs", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const finishedRun = run({ id: "agent-1", state: "finished" });
  const failedRun = run({ id: "agent-2", state: "failed" });
  store.saveRun(finishedRun);
  store.saveRun(failedRun);

  const runs = await orchestra.waitRuns([finishedRun.id, failedRun.id]);

  assert.deepEqual(runs, [finishedRun, failedRun]);
});

test("orchestra waitRuns waits for every run to become terminal", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const runningRun = run({ id: "agent-1", state: "running" });
  const finishedRun = run({ id: "agent-2", state: "finished" });
  store.saveRun(runningRun);
  store.saveRun(finishedRun);

  const waitPromise = orchestra.waitRuns([runningRun.id, finishedRun.id], { timeoutMs: 1000 });
  const completedRun = { ...runningRun, state: "finished" as const };
  store.saveRun(completedRun);

  const runs = await waitPromise;

  assert.deepEqual(runs, [completedRun, finishedRun]);
});

test("orchestra waitRuns rejects on timeout", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new FakeRuntime(store);
  const orchestra = new Orchestra({ runtime, store });
  const runningRun = run({ id: "agent-1", state: "running" });
  store.saveRun(runningRun);

  await assert.rejects(
    () => orchestra.waitRuns([runningRun.id], { timeoutMs: 0 }),
    /Timed out waiting for agent run\(s\): agent-1\./,
  );
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
