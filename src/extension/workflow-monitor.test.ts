import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun, WorkflowStageRun } from "../core/workflow.ts";
import { buildWorkflowMonitorLines, WorkflowMonitorController } from "./workflow-monitor.ts";

const WORKFLOW_STARTED_AT_MS = 1_700_000_000_000;
const STAGE_STARTED_AT_MS = WORKFLOW_STARTED_AT_MS + 6_000;
const MONITOR_NOW_MS = WORKFLOW_STARTED_AT_MS + 10_000;

test("workflow monitor renders the current stage progress", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "collector", name: "collector", state: "idle" }));
  store.saveRun(run({ id: "critic", name: "critic", state: "success" }));
  store.saveWorkflow(
    workflowRun({
      id: "research-flow",
      name: "Research Flow",
      stages: [
        stageRun({
          name: "collect",
          phase: "workers",
          busId: "bus-1",
          workerRunIds: ["collector", "critic"],
        }),
        stageRun({ name: "analyze" }),
      ],
    }),
  );

  assert.deepEqual(buildWorkflowMonitorLines(store, MONITOR_NOW_MS), [
    "Research Flow [10s] | collect [4s] (1/2) | agents (1/2)",
  ]);
});

test("workflow monitor counts the stage leader while synthesizing", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "collector", name: "collector", state: "success" }));
  store.saveRun(run({ id: "collect-leader", name: "collect-leader", state: "idle" }));
  store.saveWorkflow(
    workflowRun({
      stages: [
        stageRun({
          phase: "leader",
          workerRunIds: ["collector"],
          leaderRunId: "collect-leader",
        }),
      ],
    }),
  );

  assert.deepEqual(buildWorkflowMonitorLines(store, MONITOR_NOW_MS), [
    "workflow [10s] | collect [4s] (1/1) | agents (1/2)",
  ]);
});

test("workflow monitor controller updates the widget and clears it when workflows finish", () => {
  const store = new InMemoryAgentStore();
  const workflow = workflowRun({ stages: [stageRun({ phase: "workers", busId: "bus-1" })] });
  store.saveWorkflow(workflow);
  const widgets: Array<string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = workflowMonitorContext(widgets, statuses);
  const monitor = new WorkflowMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

  assert.equal(monitor.show(ctx), true);
  assert.equal(widgets[0]?.[0], "workflow [10s] | collect [4s] (1/1) | agents (0/1)");
  assert.deepEqual(statuses, []);

  store.saveRun(run({ id: "collector", name: "collector" }));
  assert.equal(widgets.at(-1)?.at(-1), "workflow [10s] | collect [4s] (1/1) | agents (0/1)");

  store.saveWorkflow({ ...workflow, state: "success" });

  assert.equal(widgets.at(-1), undefined);
  assert.deepEqual(statuses, []);
});

test("workflow monitor returns no lines when there are no active workflows", () => {
  const store = new InMemoryAgentStore();
  store.saveWorkflow(workflowRun({ state: "success" }));

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
    goal: "Complete the workflow.",
    startedAtMs: WORKFLOW_STARTED_AT_MS,
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}

function stageRun(overrides: Partial<WorkflowStageRun> = {}): WorkflowStageRun {
  return {
    name: "collect",
    goal: "Collect evidence.",
    strategy: "synthesize",
    members: [
      {
        profile: {
          name: "researcher",
          systemPrompt: "Research.",
          tools: [],
        },
      },
    ],
    leader: {
      profile: {
        name: "leader",
        systemPrompt: "Synthesize.",
        tools: [],
      },
    },
    state: "idle",
    startedAtMs: STAGE_STARTED_AT_MS,
    workerRunIds: [],
    ...overrides,
  };
}
