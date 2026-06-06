import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus, BusSubscription } from "../core/bus.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";

test("store saves runs in insertion order and notifies matching subscribers", () => {
  const store = new InMemoryAgentStore();
  const first = run({ id: "agent-1" });
  const second = run({ id: "agent-2" });
  const observed: AgentRun[] = [];

  const unsubscribe = store.subscribeRuns(
    (updatedRun) => observed.push(updatedRun),
    (updatedRun) => updatedRun.id === first.id,
  );
  store.saveRun(first);
  store.saveRun(second);

  assert.equal(store.getRun(first.id), first);
  assert.deepEqual(store.listRuns(), [first, second]);
  assert.deepEqual(observed, [first]);

  const updatedFirst = { ...first, state: "success" as const };
  unsubscribe();
  store.saveRun(updatedFirst);

  assert.equal(store.getRun(first.id), updatedFirst);
  assert.deepEqual(observed, [first]);
});

test("store supports multiple run subscribers and removes them independently", () => {
  const store = new InMemoryAgentStore();
  const firstObserved: string[] = [];
  const secondObserved: string[] = [];
  const agentFilter = (updatedRun: AgentRun) => updatedRun.id === "agent-1";
  const unsubscribeFirst = store.subscribeRuns((updatedRun) => firstObserved.push(updatedRun.state), agentFilter);
  const unsubscribeSecond = store.subscribeRuns((updatedRun) => secondObserved.push(updatedRun.state), agentFilter);

  store.saveRun(run({ id: "agent-1", state: "success" }));
  unsubscribeFirst();
  store.saveRun(run({ id: "agent-1", state: "blocked" }));
  unsubscribeSecond();
  store.saveRun(run({ id: "agent-1", state: "failed" }));

  assert.deepEqual(firstObserved, ["success"]);
  assert.deepEqual(secondObserved, ["success", "blocked"]);
});

test("store notifies global run subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const observed: string[] = [];
  const unsubscribe = store.subscribeRuns((updatedRun) => observed.push(updatedRun.id), undefined);

  store.saveRun(run({ id: "agent-1" }));
  store.saveRun(run({ id: "agent-2" }));
  unsubscribe();
  store.saveRun(run({ id: "agent-3" }));

  assert.deepEqual(observed, ["agent-1", "agent-2"]);
});

test("store appends and replaces bus messages by id", () => {
  const store = new InMemoryAgentStore();
  const bus: Bus = { id: "bus-1", name: "Bus 1", messages: [] };
  store.saveBus(bus);

  store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Initial." });
  store.addBusMessage(bus.id, { id: "message-2", from: "agent", message: "Follow-up." });
  store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Updated." });

  assert.deepEqual(store.listBuses(), [bus]);
  assert.deepEqual(store.getBus(bus.id)?.messages, [
    { id: "message-1", from: "main", message: "Updated." },
    { id: "message-2", from: "agent", message: "Follow-up." },
  ]);
});

test("store rejects bus messages for missing buses", () => {
  const store = new InMemoryAgentStore();

  assert.throws(
    () => store.addBusMessage("missing", { id: "message-1", from: "main", message: "No bus." }),
    /Bus missing not found\./,
  );
});

test("store notifies bus message subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const bus: Bus = { id: "bus-1", name: "Bus 1", messages: [] };
  const observed: string[] = [];
  store.saveBus(bus);
  store.saveBus({ id: "bus-2", name: "Bus 2", messages: [] });
  const unsubscribe = store.subscribeBusMessages(
    (event) => observed.push(event.message.id),
    (event) => event.busId === bus.id,
  );

  store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Initial." });
  store.addBusMessage("bus-2", { id: "message-2", from: "main", message: "Ignored." });
  unsubscribe();
  store.addBusMessage(bus.id, { id: "message-3", from: "main", message: "After unsubscribe." });

  assert.deepEqual(observed, ["message-1"]);
});

test("store saves, lists, and deletes bus subscriptions", () => {
  const store = new InMemoryAgentStore();
  store.saveBusSubscription(busSubscription({ id: "sub-1", busId: "bus-1", subscriberId: "agent-1" }));
  store.saveBusSubscription(busSubscription({ id: "sub-2", busId: "bus-2", subscriberId: "agent-1" }));
  store.saveBusSubscription(
    busSubscription({ id: "sub-3", busId: "bus-1", subscriberId: "main", subscriberKind: "main" }),
  );

  assert.deepEqual(
    store
      .listBusSubscriptions({ busId: "bus-1", subscriberId: undefined, subscriberKind: undefined })
      .map((sub) => sub.id),
    ["sub-1", "sub-3"],
  );
  assert.deepEqual(
    store
      .listBusSubscriptions({ busId: undefined, subscriberId: "agent-1", subscriberKind: "agent" })
      .map((sub) => sub.id),
    ["sub-1", "sub-2"],
  );

  store.deleteBusSubscription("sub-1");

  assert.equal(store.getBusSubscription("sub-1"), undefined);
});

test("store saves workflows and notifies workflow subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const workflow = workflowRun({ id: "workflow-1", name: "Workflow 1" });
  const observed: WorkflowRun[] = [];
  const unsubscribe = store.subscribeWorkflows(
    (updatedWorkflow) => observed.push(updatedWorkflow),
    (updatedWorkflow) => updatedWorkflow.id === workflow.id,
  );

  store.saveWorkflow(workflow);
  const succeeded = { ...workflow, state: "success" as const };
  store.saveWorkflow(succeeded);
  unsubscribe();
  const closed = { ...succeeded, state: "closed" as const };
  store.saveWorkflow(closed);

  assert.equal(store.getWorkflow(workflow.id), closed);
  assert.deepEqual(store.listWorkflows(), [closed]);
  assert.deepEqual(observed, [workflow, succeeded]);
});

test("store notifies global workflow subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const observed: string[] = [];
  const unsubscribe = store.subscribeWorkflows((workflow) => observed.push(workflow.id), undefined);

  store.saveWorkflow(workflowRun({ id: "workflow-1" }));
  store.saveWorkflow(workflowRun({ id: "workflow-2" }));
  unsubscribe();
  store.saveWorkflow(workflowRun({ id: "workflow-3" }));

  assert.deepEqual(observed, ["workflow-1", "workflow-2"]);
});

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
  };
}

function busSubscription(overrides: Partial<BusSubscription> = {}): BusSubscription {
  return {
    id: "sub-1",
    busId: "bus-1",
    subscriberId: "agent-1",
    subscriberKind: "agent",
    deliveredMessageIds: [],
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}
