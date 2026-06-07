import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus, BusSubscription } from "../core/bus.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
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

  assert.deepEqual(store.getRun(first.id), first);
  assert.deepEqual(store.getRunByName(first.name), first);
  assert.notEqual(store.getRun(first.id), first);
  assert.deepEqual(store.listRuns(), [first, second]);
  assert.deepEqual(observed, [first]);

  const updatedFirst = { ...first, state: "closed" as const };
  unsubscribe();
  store.saveRun(updatedFirst);

  assert.deepEqual(store.getRun(first.id), updatedFirst);
  assert.deepEqual(observed, [first]);
});

test("store snapshots saved and returned orchestration state", () => {
  const store = new InMemoryAgentStore();
  const savedRun = run({ id: "agent-1" });
  const savedWorkgroup = workgroupRun({ id: "workgroup-1", memberRunIds: ["member-1"] });

  store.saveRun(savedRun);
  store.saveWorkgroup(savedWorkgroup);

  savedRun.profile.tools.push("bash");
  savedWorkgroup.memberRunIds.push("member-2");

  const returnedRun = store.getRun(savedRun.id);
  const returnedWorkgroup = store.getWorkgroup(savedWorkgroup.id);
  assert.deepEqual(returnedRun?.profile.tools, []);
  assert.deepEqual(returnedWorkgroup?.memberRunIds, ["member-1"]);

  (returnedRun?.profile.tools as string[] | undefined)?.push("read");
  returnedWorkgroup?.memberRunIds.push("member-3");
  assert.deepEqual(store.getRun(savedRun.id)?.profile.tools, []);
  assert.deepEqual(store.getWorkgroup(savedWorkgroup.id)?.memberRunIds, ["member-1"]);
});

test("store supports multiple run subscribers and removes them independently", () => {
  const store = new InMemoryAgentStore();
  const firstObserved: string[] = [];
  const secondObserved: string[] = [];
  const agentFilter = (updatedRun: AgentRun) => updatedRun.id === "agent-1";
  const unsubscribeFirst = store.subscribeRuns((updatedRun) => firstObserved.push(updatedRun.state), agentFilter);
  const unsubscribeSecond = store.subscribeRuns((updatedRun) => secondObserved.push(updatedRun.state), agentFilter);

  store.saveRun(run({ id: "agent-1", state: "running", result: null }));
  unsubscribeFirst();
  store.saveRun(run({ id: "agent-1", state: "closed", result: null }));
  unsubscribeSecond();
  store.saveRun(run({ id: "agent-1", state: "failed", result: { status: "failed", summary: "Done." } }));

  assert.deepEqual(firstObserved, ["running"]);
  assert.deepEqual(secondObserved, ["running", "closed"]);
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
  const bus: Bus = { id: "bus-1", name: "Bus 1", state: "open", messages: [] };
  store.saveBus(bus);

  store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Initial." });
  store.addBusMessage(bus.id, { id: "message-2", from: "agent", message: "Follow-up." });
  store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Updated." });

  const expectedMessages = [
    { id: "message-1", from: "main", message: "Updated." },
    { id: "message-2", from: "agent", message: "Follow-up." },
  ];
  assert.deepEqual(store.listBuses(), [{ ...bus, messages: expectedMessages }]);
  assert.deepEqual(store.getBusByName(bus.name)?.messages, expectedMessages);
  assert.deepEqual(store.getBus(bus.id)?.messages, expectedMessages);
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
  const bus: Bus = { id: "bus-1", name: "Bus 1", state: "open", messages: [] };
  const observed: string[] = [];
  store.saveBus(bus);
  store.saveBus({ id: "bus-2", name: "Bus 2", state: "open", messages: [] });
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

test("store saves workgroups and notifies workgroup subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const workgroup = workgroupRun({ id: "workgroup-1", name: "Workgroup 1" });
  const observed: WorkgroupRun[] = [];
  const unsubscribe = store.subscribeWorkgroups(
    (updatedWorkgroup) => observed.push(updatedWorkgroup),
    (updatedWorkgroup) => updatedWorkgroup.id === workgroup.id,
  );

  store.saveWorkgroup(workgroup);
  const expanded = { ...workgroup, memberRunIds: [...workgroup.memberRunIds, "member-2"] };
  store.saveWorkgroup(expanded);
  unsubscribe();
  const renamed = { ...expanded, name: "Renamed Workgroup" };
  store.saveWorkgroup(renamed);

  assert.deepEqual(store.getWorkgroup(workgroup.id), renamed);
  assert.equal(store.getWorkgroupByName(workgroup.name), undefined);
  assert.deepEqual(store.getWorkgroupByName(renamed.name), renamed);
  assert.deepEqual(store.listWorkgroups(), [renamed]);
  assert.deepEqual(observed, [workgroup, expanded]);
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
  const closing = { ...workflow, state: "closing" as const };
  store.saveWorkflow(closing);
  unsubscribe();
  const closed = { ...closing, state: "closed" as const };
  store.saveWorkflow(closed);

  assert.deepEqual(store.getWorkflow(workflow.id), closed);
  assert.deepEqual(store.getWorkflowByName(workflow.name), closed);
  assert.deepEqual(store.listWorkflows(), [closed]);
  assert.deepEqual(observed, [workflow, closing]);
});

test("store notifies global workgroup subscribers until unsubscribed", () => {
  const store = new InMemoryAgentStore();
  const observed: string[] = [];
  const unsubscribe = store.subscribeWorkgroups((workgroup) => observed.push(workgroup.id), undefined);

  store.saveWorkgroup(workgroupRun({ id: "workgroup-1" }));
  store.saveWorkgroup(workgroupRun({ id: "workgroup-2" }));
  unsubscribe();
  store.saveWorkgroup(workgroupRun({ id: "workgroup-3" }));

  assert.deepEqual(observed, ["workgroup-1", "workgroup-2"]);
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
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
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

function workgroupRun(overrides: Partial<WorkgroupRun> = {}): WorkgroupRun {
  return {
    id: "workgroup-1",
    name: "workgroup-1",
    busId: "bus-1",
    goal: "Complete the workgroup.",
    leaderRunId: null,
    memberRunIds: ["member-1"],
    state: "running",
    result: null,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "running",
    busId: "workflow-bus",
    leaderRunId: null,
    workgroupIds: [],
    result: null,
    ...overrides,
  };
}
