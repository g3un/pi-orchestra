import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { formatOrchestraRecoveryReport } from "./recovery.ts";

test("recovery report says when no persisted active records exist", () => {
  const store = new InMemoryAgentStore();

  assert.equal(
    formatOrchestraRecoveryReport(store),
    ["Pi-orchestra recovery report:", "", "No persisted active pi-orchestra records were found."].join("\n"),
  );
});

test("recovery report lists active records without mutating them", () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Main Bus", state: "open", messages: [] });
  store.saveRun(run({ id: "parent", name: "Parent", busId: "bus-1" }));
  store.saveRun(run({ id: "child", name: "Child", busId: "bus-1", parentRunId: "parent" }));
  store.saveWorkgroup(workgroupRun({ leaderRunId: "parent", memberRunIds: ["child"] }));
  store.saveWorkflow(workflowRun({ leaderRunId: "parent", workgroupIds: ["workgroup-1"] }));

  assert.equal(
    formatOrchestraRecoveryReport(store),
    [
      "Pi-orchestra recovery report:",
      "",
      "These persisted records are active in the local store. They may still belong to another live Pi session; pi-orchestra does not auto-close them.",
      "If they belong to an abandoned session, recover explicitly with subagent close, workgroup cancel, or workflow cancel.",
      "",
      "Runs:",
      "- Parent (running, bus=Main Bus, parent=main)",
      "- Child (running, bus=Main Bus, parent=Parent)",
      "Workgroups:",
      "- workgroup-1 (running, bus=Main Bus, leader=Parent, members=1)",
      "Workflows:",
      "- workflow-1 (running, bus=Main Bus, leader=Parent, workgroups=1)",
    ].join("\n"),
  );
  assert.equal(store.getRun("child")?.state, "running");
});

test("recovery report includes non-closed runs, current session ownership, and stale-scope hints", () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "closed-bus", name: "Closed Bus", state: "closed", messages: [] });
  store.saveBus({ id: "workflow-bus", name: "Workflow Bus", state: "open", messages: [] });
  store.saveRun(
    run({
      id: "failed-leader",
      name: "Failed Leader",
      busId: "closed-bus",
      state: "failed",
      result: { status: "failed", summary: "Crashed before cleanup." },
    }),
  );
  store.saveRun(run({ id: "child", name: "Child", busId: "missing-bus", parentRunId: "missing-parent" }));
  store.saveWorkgroup(
    workgroupRun({
      id: "stale-group",
      name: "stale-group",
      busId: "closed-bus",
      leaderRunId: "missing-leader",
      state: "closing",
    }),
  );
  store.saveWorkflow(
    workflowRun({
      id: "stale-flow",
      name: "stale-flow",
      busId: "workflow-bus",
      leaderRunId: "failed-leader",
      workgroupIds: ["stale-group", "missing-group"],
      state: "closing",
    }),
  );

  assert.equal(
    formatOrchestraRecoveryReport(store, { liveRunIds: ["failed-leader"] }),
    [
      "Pi-orchestra recovery report:",
      "",
      "These persisted records are active in the local store. They may still belong to another live Pi session; pi-orchestra does not auto-close them.",
      "If they belong to an abandoned session, recover explicitly with subagent close, workgroup cancel, or workflow cancel.",
      "",
      "Runs:",
      "- Failed Leader (failed, bus=Closed Bus, parent=main, session=current, hints=bus closed)",
      "- Child (running, bus=missing-bus, parent=missing-parent, hints=bus missing; parent missing)",
      "Workgroups:",
      "- stale-group (closing, bus=Closed Bus, leader=missing-leader, members=0, hints=bus closed; closing cleanup incomplete; leader missing)",
      "Workflows:",
      "- stale-flow (closing, bus=Workflow Bus, leader=Failed Leader, workgroups=2, session=current, hints=closing cleanup incomplete; workgroup missing:missing-group)",
    ].join("\n"),
  );
});

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    parentRunId: overrides.parentRunId ?? null,
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
    goal: "Complete the workgroup.",
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
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "running",
    busId: "bus-1",
    leaderRunId: null,
    workgroupIds: [],
    statusLine: null,
    result: null,
    ...overrides,
  };
}
