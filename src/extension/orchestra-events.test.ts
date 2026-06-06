import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { createBusSubscriptionId } from "../core/bus.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { OrchestraEventController, type OrchestraMainEvent } from "./orchestra-events.ts";

test("orchestra event controller emits standalone subagent finish events", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const runningRun = run({ state: "running" });
  store.saveRun(runningRun);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveRun({ ...runningRun, state: "idle", result: { status: "success", summary: "Done." } });

  assert.equal(sent.batches.length, 1);
  assert.deepEqual(sent.batches[0]?.events[0], {
    type: "subagent.finished",
    busId: "bus-1",
    run: {
      runId: "agent-1",
      name: "agent-1",
      profile: "researcher",
      state: "idle",
      result: { status: "success", summary: "Done." },
    },
  });
  assert.match(sent.batches[0]?.content ?? "", /Subagent finished on bus bus-1/);
});

test("orchestra event controller emits only active to finished run transitions", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const runningRun = run({ state: "running" });
  store.saveRun(runningRun);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  const firstFinished = {
    ...runningRun,
    state: "idle" as const,
    result: { status: "success" as const, summary: "Done." },
  };
  store.saveRun(firstFinished);
  store.saveRun({ ...firstFinished, result: { status: "success", summary: "Saved again." } });
  store.saveRun({ ...firstFinished, state: "closed" });
  store.saveRun({ ...firstFinished, state: "running", result: undefined });
  store.saveRun({ ...firstFinished, state: "idle", result: { status: "success", summary: "Done again." } });

  assert.equal(sent.batches.length, 2);
  assert.equal(sent.batches[0]?.events[0]?.type, "subagent.finished");
  assert.equal(sent.batches[1]?.events[0]?.type, "subagent.finished");
  assert.equal(
    sent.batches[1]?.events[0]?.type === "subagent.finished" ? sent.batches[1].events[0].run.result?.summary : "",
    "Done again.",
  );
});

test("orchestra event controller routes registered workgroup member finish events with pending run ids", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const firstRun = run({ id: "first", name: "first", busId: "bus-1", state: "running" });
  const secondRun = run({ id: "second", name: "second", busId: "bus-1", state: "running" });
  store.saveRun(firstRun);
  store.saveRun(secondRun);
  const controller = new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });
  controller.registerWorkgroup({ busId: "bus-1", strategy: "synthesize", runIds: [firstRun.id, secondRun.id] });

  store.saveRun({ ...firstRun, state: "idle", result: { status: "blocked", summary: "Need input." } });

  assert.equal(sent.batches.length, 1);
  const event = sent.batches[0]?.events[0];
  assert.equal(event?.type, "workgroup.member_finished");
  if (event?.type !== "workgroup.member_finished") throw new Error("Expected workgroup event.");
  assert.equal(event.strategy, "synthesize");
  assert.equal(event.run.runId, firstRun.id);
  assert.deepEqual(event.pendingRunIds, [secondRun.id]);
  assert.match(sent.batches[0]?.content ?? "", /Pending workgroup run ids: second/);
});

test("orchestra event controller routes workgroup finishes during launch before final registration", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const controller = new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });
  controller.beginWorkgroup("bus-1", "compete");
  const memberRun = run({ id: "fast", name: "fast", state: "running" });
  store.saveRun(memberRun);

  store.saveRun({ ...memberRun, state: "idle", result: { status: "success", summary: "Won." } });
  controller.registerWorkgroup({ busId: "bus-1", strategy: "compete", runIds: [memberRun.id] });

  assert.equal(sent.batches.length, 1);
  const event = sent.batches[0]?.events[0];
  assert.equal(event?.type, "workgroup.member_finished");
  if (event?.type !== "workgroup.member_finished") throw new Error("Expected workgroup event.");
  assert.equal(event.strategy, "compete");
  assert.equal(event.run.runId, memberRun.id);
});

test("orchestra event controller emits subscribed main bus messages", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  store.saveBusSubscription({
    id: createBusSubscriptionId("bus-1", "main", "main"),
    busId: "bus-1",
    subscriberId: "main",
    subscriberKind: "main",
    deliveredMessageIds: [],
  });
  store.saveRun(run({ id: "agent-1", name: "Researcher A" }));
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.addBusMessage("bus-1", { id: "message-1", from: "agent-1", message: "Shared fact." });
  store.addBusMessage("bus-1", { id: "message-2", from: "main", message: "Own fact." });

  assert.equal(sent.batches.length, 1);
  assert.deepEqual(sent.batches[0]?.events[0], {
    type: "bus.message",
    busId: "bus-1",
    message: { id: "message-1", from: "agent-1", message: "Shared fact." },
  });
  assert.match(sent.batches[0]?.content ?? "", /Bus message on bus-1 from Researcher A/);
  assert.doesNotMatch(sent.batches[0]?.content ?? "", /from agent-1/);
  assert.deepEqual(store.getBusSubscription(createBusSubscriptionId("bus-1", "main", "main"))?.deliveredMessageIds, [
    "message-1",
  ]);
});

test("orchestra event controller does not mark queued main bus messages delivered before flush", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const subscriptionId = createBusSubscriptionId("bus-1", "main", "main");
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  store.saveBusSubscription({
    id: subscriptionId,
    busId: "bus-1",
    subscriberId: "main",
    subscriberKind: "main",
    deliveredMessageIds: [],
  });
  const controller = new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 10_000 });

  store.addBusMessage("bus-1", { id: "message-1", from: "agent-1", message: "Shared fact." });

  assert.deepEqual(store.getBusSubscription(subscriptionId)?.deliveredMessageIds, []);
  assert.equal(sent.batches.length, 0);

  controller.dispose();

  assert.deepEqual(store.getBusSubscription(subscriptionId)?.deliveredMessageIds, []);
});

test("orchestra event controller suppresses workflow-internal run finishes and emits workflow finish", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const workflow = workflowRun({ state: "running", stages: [{ ...stageRun(), busId: "workflow-bus" }] });
  store.saveWorkflow(workflow);
  const workflowRunAgent = run({ id: "stage-worker", name: "stage-worker", busId: "workflow-bus", state: "running" });
  store.saveRun(workflowRunAgent);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveRun({
    ...workflowRunAgent,
    state: "idle",
    result: { status: "success", summary: "Worker done." },
  });
  store.saveWorkflow({
    ...workflow,
    state: "success",
    result: { status: "success", summary: "Workflow done.", workerResults: [] },
  });

  assert.equal(sent.batches.length, 1);
  assert.deepEqual(sent.batches[0]?.events[0], {
    type: "workflow.finished",
    workflow: {
      ...workflow,
      state: "success",
      result: { status: "success", summary: "Workflow done.", workerResults: [] },
    },
  });
});

function createEventSink(): { batches: EventBatch[]; send: (events: OrchestraMainEvent[], content: string) => void } {
  const batches: EventBatch[] = [];
  return {
    batches,
    send(events, content) {
      batches.push({ events, content });
    },
  };
}

interface EventBatch {
  events: OrchestraMainEvent[];
  content: string;
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow",
    name: "workflow",
    goal: "Complete workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}

function stageRun() {
  return {
    name: "collect",
    goal: "Collect data.",
    strategy: "synthesize" as const,
    members: [],
    leader: {
      profile: { name: "leader", systemPrompt: "Lead.", tools: [], model: undefined },
      name: undefined,
      assignment: undefined,
    },
    state: "idle" as const,
    startedAtMs: 1_700_000_000_000,
    workerRunIds: [],
  };
}
