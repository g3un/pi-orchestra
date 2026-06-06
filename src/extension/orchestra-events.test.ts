import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { createBusSubscriptionId } from "../core/bus.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { OrchestraEventController, type OrchestraMainEvent } from "./orchestra-events.ts";

test("orchestra event controller emits standalone subagent finish events", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const runningRun = run({ state: "running" });
  store.saveRun(runningRun);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveRun({ ...runningRun, state: "success", result: { status: "success", summary: "Done." } });

  assert.equal(sent.batches.length, 1);
  assert.deepEqual(sent.batches[0]?.events[0], {
    type: "subagent.finished",
    busId: "bus-1",
    run: {
      runId: "agent-1",
      name: "agent-1",
      profile: "researcher",
      state: "success",
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
    state: "success" as const,
    result: { status: "success" as const, summary: "Done." },
  };
  store.saveRun(firstFinished);
  store.saveRun({ ...firstFinished, result: { status: "success", summary: "Saved again." } });
  store.saveRun({ ...firstFinished, state: "closed" });
  store.saveRun({ ...firstFinished, state: "running", result: null });
  store.saveRun({ ...firstFinished, state: "success", result: { status: "success", summary: "Done again." } });

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
  controller.registerWorkgroup({ busId: "bus-1", leaderRunId: null, runIds: [firstRun.id, secondRun.id] });

  store.saveRun({ ...firstRun, state: "blocked", result: { status: "blocked", summary: "Need input." } });

  assert.equal(sent.batches.length, 1);
  const event = sent.batches[0]?.events[0];
  assert.equal(event?.type, "workgroup.member_finished");
  if (event?.type !== "workgroup.member_finished") throw new Error("Expected workgroup event.");
  assert.equal(event.run.runId, firstRun.id);
  assert.deepEqual(event.pendingRunIds, [secondRun.id]);
  assert.match(sent.batches[0]?.content ?? "", /Pending workgroup run ids: second/);
});

test("orchestra event controller routes workgroup finishes during launch before final registration", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const memberRun = run({ id: "fast", name: "fast", state: "running" });
  const controller = new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });
  controller.beginWorkgroup({ busId: "bus-1", leaderRunId: null, runIds: [memberRun.id] });
  store.saveRun(memberRun);

  store.saveRun({ ...memberRun, state: "success", result: { status: "success", summary: "Won." } });
  controller.registerWorkgroup({ busId: "bus-1", leaderRunId: null, runIds: [memberRun.id] });

  assert.equal(sent.batches.length, 1);
  const event = sent.batches[0]?.events[0];
  assert.equal(event?.type, "workgroup.member_finished");
  if (event?.type !== "workgroup.member_finished") throw new Error("Expected workgroup event.");
  assert.equal(event.run.runId, memberRun.id);
});

test("orchestra event controller routes agent-led workgroup finishes during launch to the leader", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const agentEvents: Array<{ runId: string; events: OrchestraMainEvent[]; content: string }> = [];
  const leaderRun = run({ id: "leader", name: "leader", busId: "bus-1", state: "running" });
  const memberRun = run({ id: "fast", name: "fast", busId: "bus-1", state: "running" });
  store.saveRun(leaderRun);
  const controller = new OrchestraEventController({
    store,
    sendEvents: sent.send,
    sendAgentEvents: (runId, events, content) => agentEvents.push({ runId, events, content }),
    flushDelayMs: 0,
  });
  controller.beginWorkgroup({ busId: "bus-1", leaderRunId: leaderRun.id, runIds: [memberRun.id] });
  store.saveRun(memberRun);

  store.saveRun({ ...memberRun, state: "success", result: { status: "success", summary: "Won." } });
  controller.registerWorkgroup({ busId: "bus-1", leaderRunId: leaderRun.id, runIds: [memberRun.id] });

  assert.equal(sent.batches.length, 0);
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0]?.runId, "leader");
  assert.equal(agentEvents[0]?.events[0]?.type, "workgroup.member_finished");
});

test("orchestra event controller routes persisted agent-led workgroup member finishes to the leader", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const agentEvents: Array<{ runId: string; events: OrchestraMainEvent[]; content: string }> = [];
  const leaderRun = run({ id: "leader", name: "leader", busId: "bus-1", state: "running" });
  const memberRun = run({ id: "member", name: "member", busId: "bus-1", state: "running" });
  store.saveRun(leaderRun);
  store.saveRun(memberRun);
  store.saveWorkgroup(workgroupRun({ leaderRunId: "leader", memberRunIds: [memberRun.id] }));
  new OrchestraEventController({
    store,
    sendEvents: sent.send,
    sendAgentEvents: (runId, events, content) => agentEvents.push({ runId, events, content }),
    flushDelayMs: 0,
  });

  store.saveRun({ ...memberRun, state: "success", result: { status: "success", summary: "Done." } });

  assert.equal(sent.batches.length, 0);
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0]?.runId, "leader");
  assert.equal(agentEvents[0]?.events[0]?.type, "workgroup.member_finished");
  assert.match(agentEvents[0]?.content ?? "", /Workgroup member finished/);
});

test("orchestra event controller falls back to main when an agent-led workgroup leader is inactive", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const agentEvents: Array<{ runId: string; events: OrchestraMainEvent[]; content: string }> = [];
  const leaderRun = run({
    id: "leader",
    name: "leader",
    busId: "bus-1",
    state: "success",
    result: { status: "success", summary: "Done." },
  });
  const memberRun = run({ id: "member", name: "member", busId: "bus-1", state: "running" });
  store.saveRun(leaderRun);
  store.saveRun(memberRun);
  store.saveWorkgroup(workgroupRun({ leaderRunId: "leader", memberRunIds: [memberRun.id] }));
  new OrchestraEventController({
    store,
    sendEvents: sent.send,
    sendAgentEvents: (runId, events, content) => agentEvents.push({ runId, events, content }),
    flushDelayMs: 0,
  });

  store.saveRun({ ...memberRun, state: "success", result: { status: "success", summary: "Late member done." } });

  assert.equal(agentEvents.length, 0);
  assert.equal(sent.batches.length, 1);
  assert.equal(sent.batches[0]?.events[0]?.type, "workgroup.member_finished");
});

test("orchestra event controller suppresses cancelled launch cleanup run finishes", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const memberRun = run({ id: "fast", name: "fast", state: "running" });
  store.saveRun(memberRun);
  const controller = new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });
  controller.beginWorkgroup({ busId: "bus-1", leaderRunId: null, runIds: [memberRun.id] });

  controller.cancelWorkgroupLaunch("bus-1", { suppressRunIds: [memberRun.id] });
  store.saveRun({ ...memberRun, state: "closed", result: null });

  assert.equal(sent.batches.length, 0);
});

test("orchestra event controller emits workgroup finished events on closed transition", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const workgroup = workgroupRun({ state: "running", result: null });
  store.saveWorkgroup(workgroup);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveWorkgroup({ ...workgroup, state: "closing", result: { status: "success", summary: "Almost done." } });
  store.saveWorkgroup({ ...workgroup, state: "closed", result: { status: "success", summary: "Done." } });
  store.saveWorkgroup({ ...workgroup, state: "closed", result: { status: "success", summary: "Saved again." } });

  assert.equal(sent.batches.length, 1);
  assert.deepEqual(sent.batches[0]?.events[0], {
    type: "workgroup.finished",
    workgroup: { ...workgroup, state: "closed", result: { status: "success", summary: "Done." } },
  });
  assert.match(sent.batches[0]?.content ?? "", /Workgroup finished/);
});

test("orchestra event controller suppresses member close events while workgroup is closing", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const memberRun = run({ id: "member", name: "member", busId: "bus-1", state: "running" });
  const workgroup = workgroupRun({ state: "running", memberRunIds: [memberRun.id] });
  store.saveRun(memberRun);
  store.saveWorkgroup(workgroup);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveWorkgroup({ ...workgroup, state: "closing", result: { status: "success", summary: "Done." } });
  store.saveRun({ ...memberRun, state: "closed", result: null });
  store.saveWorkgroup({ ...workgroup, state: "closed", result: { status: "success", summary: "Done." } });

  assert.equal(sent.batches.length, 1);
  assert.equal(sent.batches[0]?.events[0]?.type, "workgroup.finished");
});

test("orchestra event controller emits subscribed main bus messages", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
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
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
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
  const workflowRunAgent = run({ id: "stage-member", name: "stage-member", busId: "workflow-bus", state: "running" });
  store.saveRun(workflowRunAgent);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveRun({
    ...workflowRunAgent,
    state: "success",
    result: { status: "success", summary: "Member done." },
  });
  store.saveWorkflow({
    ...workflow,
    state: "success",
    result: { status: "success", summary: "Workflow done.", memberResults: [] },
  });

  assert.equal(sent.batches.length, 1);
  assert.deepEqual(sent.batches[0]?.events[0], {
    type: "workflow.finished",
    workflow: {
      ...workflow,
      state: "success",
      result: { status: "success", summary: "Workflow done.", memberResults: [] },
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
    state: "running",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}

function workgroupRun(overrides: Partial<WorkgroupRun> = {}): WorkgroupRun {
  return {
    id: "workgroup-1",
    name: "workgroup-1",
    busId: "bus-1",
    goal: "Complete workgroup.",
    leaderRunId: null,
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
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
    leader: {
      profile: { name: "leader", systemPrompt: "Lead.", tools: [], model: undefined },
      name: "leader",
    },
    state: "idle" as const,
    startedAtMs: 1_700_000_000_000,
  };
}
