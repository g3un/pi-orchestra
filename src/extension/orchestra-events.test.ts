import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { OrchestraEventController, type OrchestraMainEvent } from "./orchestra-events.ts";

test("orchestra event controller emits standalone subagent finish events", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const idleRun = run({ state: "idle" });
  store.saveRun(idleRun);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveRun({ ...idleRun, state: "success", result: { status: "success", summary: "Done." } });

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

test("orchestra event controller emits only non-terminal to finished run transitions", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const idleRun = run({ state: "idle" });
  store.saveRun(idleRun);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  const firstFinished = {
    ...idleRun,
    state: "success" as const,
    result: { status: "success" as const, summary: "Done." },
  };
  store.saveRun(firstFinished);
  store.saveRun({ ...firstFinished, result: { status: "success", summary: "Saved again." } });
  store.saveRun({ ...firstFinished, state: "closed" });
  store.saveRun({ ...firstFinished, state: "idle", result: undefined });
  store.saveRun({ ...firstFinished, result: { status: "success", summary: "Done again." } });

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
  const firstRun = run({ id: "first", name: "first", busId: "bus-1", state: "idle" });
  const secondRun = run({ id: "second", name: "second", busId: "bus-1", state: "idle" });
  store.saveRun(firstRun);
  store.saveRun(secondRun);
  const controller = new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });
  controller.registerWorkgroup({ busId: "bus-1", strategy: "synthesize", runIds: [firstRun.id, secondRun.id] });

  store.saveRun({ ...firstRun, state: "blocked", result: { status: "blocked", summary: "Need input." } });

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
  const memberRun = run({ id: "fast", name: "fast", state: "idle" });
  store.saveRun(memberRun);

  store.saveRun({ ...memberRun, state: "success", result: { status: "success", summary: "Won." } });
  controller.registerWorkgroup({ busId: "bus-1", strategy: "compete", runIds: [memberRun.id] });

  assert.equal(sent.batches.length, 1);
  const event = sent.batches[0]?.events[0];
  assert.equal(event?.type, "workgroup.member_finished");
  if (event?.type !== "workgroup.member_finished") throw new Error("Expected workgroup event.");
  assert.equal(event.strategy, "compete");
  assert.equal(event.run.runId, memberRun.id);
});

test("orchestra event controller suppresses workflow-internal run finishes and emits workflow finish", () => {
  const store = new InMemoryAgentStore();
  const sent = createEventSink();
  const workflow = workflowRun({ state: "idle", stages: [{ ...stageRun(), busId: "workflow-bus" }] });
  store.saveWorkflow(workflow);
  const workflowRunAgent = run({ id: "stage-worker", name: "stage-worker", busId: "workflow-bus", state: "idle" });
  store.saveRun(workflowRunAgent);
  new OrchestraEventController({ store, sendEvents: sent.send, flushDelayMs: 0 });

  store.saveRun({
    ...workflowRunAgent,
    state: "success",
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
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
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
    strategy: "synthesize" as const,
    members: [],
    leader: { profile: { name: "leader", systemPrompt: "Lead." } },
    state: "idle" as const,
    workerRunIds: [],
  };
}
