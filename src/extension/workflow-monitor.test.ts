import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { buildWorkflowMonitorLines, WorkflowMonitorController } from "./workflow-monitor.ts";

const WORKFLOW_STARTED_AT_MS = 1_700_000_000_000;
const MONITOR_NOW_MS = WORKFLOW_STARTED_AT_MS + 10_000;

test("workflow monitor renders workflow status, group activity, and agent activity", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "flow-leader", name: "flow-leader", busId: "workflow-bus", state: "running" }));
  store.saveRun(run({ id: "group-leader", name: "group-leader", state: "running" }));
  store.saveRun(run({ id: "collector", name: "collector", state: "running" }));
  store.saveRun(
    run({ id: "critic", name: "critic", state: "success", result: { status: "success", summary: "Done." } }),
  );
  store.saveWorkgroup(workgroupRun({ leaderRunId: "group-leader", memberRunIds: ["collector", "critic"] }));
  store.saveWorkflow(
    workflowRun({
      id: "research-flow",
      name: "Research Flow",
      leaderRunId: "flow-leader",
      workgroupIds: ["workgroup-1"],
      statusLine: "Analyzing child workgroup results.",
    }),
  );

  assert.deepEqual(buildWorkflowMonitorLines(store, MONITOR_NOW_MS), [
    "Research Flow [10s] — Analyzing child workgroup results.",
    "  groups active 1, done 0; agents active 3, done 1",
  ]);
});

test("workflow monitor counts closed workgroups and falls back before status is set", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "flow-leader", name: "flow-leader", busId: "workflow-bus", state: "running" }));
  store.saveRun(
    run({ id: "collector", name: "collector", state: "success", result: { status: "success", summary: "Done." } }),
  );
  store.saveWorkgroup(workgroupRun({ state: "closed", memberRunIds: ["collector"] }));
  store.saveWorkflow(workflowRun({ leaderRunId: "flow-leader", workgroupIds: ["workgroup-1"], statusLine: null }));

  assert.deepEqual(buildWorkflowMonitorLines(store, MONITOR_NOW_MS), [
    "workflow [10s] — waiting for flow leader status",
    "  groups active 0, done 1; agents active 1, done 1",
  ]);
});

test("workflow monitor controller updates the widget and clears it when workflows finish", () => {
  const store = new InMemoryAgentStore();
  const workflow = workflowRun({ leaderRunId: "flow-leader", statusLine: null });
  store.saveRun(run({ id: "flow-leader", name: "flow-leader", busId: "workflow-bus", state: "running" }));
  store.saveWorkflow(workflow);
  const widgets: Array<string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = workflowMonitorContext(widgets, statuses);
  const monitor = new WorkflowMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

  assert.equal(monitor.show(ctx), true);
  assert.deepEqual(widgets[0], [
    "workflow [10s] — waiting for flow leader status",
    "  groups active 0, done 0; agents active 1, done 0",
  ]);
  assert.deepEqual(statuses, []);

  store.saveWorkflow({ ...workflow, statusLine: "Collecting implementation evidence." });
  assert.deepEqual(widgets.at(-1), [
    "workflow [10s] — Collecting implementation evidence.",
    "  groups active 0, done 0; agents active 1, done 0",
  ]);

  store.saveWorkflow({ ...workflow, state: "closed" });

  assert.equal(widgets.at(-1), undefined);
  assert.deepEqual(statuses, []);
});

test("workflow monitor returns no lines when there are no active workflows", () => {
  const store = new InMemoryAgentStore();
  store.saveWorkflow(workflowRun({ state: "closed" }));

  assert.deepEqual(buildWorkflowMonitorLines(store), []);
});

function workflowMonitorContext(
  widgets: Array<string[] | undefined>,
  statuses: Array<string | undefined>,
): ExtensionContext {
  return {
    hasUI: true,
    cwd: "/workspace",
    ui: {
      setWidget(_key: string, content: string[] | undefined) {
        widgets.push(content);
      },
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text);
      },
    },
  } as unknown as ExtensionContext;
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "collector";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    parentRunId: overrides.parentRunId ?? null,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow",
    name: "workflow",
    goal: "Complete the workflow.",
    startedAtMs: WORKFLOW_STARTED_AT_MS,
    state: "running",
    busId: "workflow-bus",
    leaderRunId: null,
    workgroupIds: [],
    statusLine: null,
    result: null,
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
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: WORKFLOW_STARTED_AT_MS + 6_000,
    ...overrides,
  };
}
