import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";

test("store saves runs in insertion order and notifies matching subscribers", () => {
  const store = new InMemoryAgentStore();
  const first = run({ id: "agent-1" });
  const second = run({ id: "agent-2" });
  const observed: AgentRun[] = [];

  const unsubscribe = store.subscribeRun(first.id, (updatedRun) => observed.push(updatedRun));
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
  const unsubscribeFirst = store.subscribeRun("agent-1", (updatedRun) => firstObserved.push(updatedRun.state));
  const unsubscribeSecond = store.subscribeRun("agent-1", (updatedRun) => secondObserved.push(updatedRun.state));

  store.saveRun(run({ id: "agent-1", state: "success" }));
  unsubscribeFirst();
  store.saveRun(run({ id: "agent-1", state: "blocked" }));
  unsubscribeSecond();
  store.saveRun(run({ id: "agent-1", state: "failed" }));

  assert.deepEqual(firstObserved, ["success"]);
  assert.deepEqual(secondObserved, ["success", "blocked"]);
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

test("store saves workflows and notifies workflow subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const workflow = workflowRun({ id: "workflow-1", name: "Workflow 1" });
  const observed: WorkflowRun[] = [];
  const unsubscribe = store.subscribeWorkflow(workflow.id, (updatedWorkflow) => observed.push(updatedWorkflow));

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
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}
