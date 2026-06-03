import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { createWorkflowTool } from "./workflow.ts";

test("workflow wait returns missing workflow status", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWorkflowTool({ orchestra: {} as OrchestraApi, store });

  const output = await tool.execute({ action: "wait", id: "missing" });

  assert.equal(output.workflow, undefined);
  assert.equal(output.timedOut, false);
  assert.equal(output.message, "Workflow missing not found.");
});

test("workflow wait resolves immediately for terminal workflows", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWorkflowTool({ orchestra: {} as OrchestraApi, store });
  const workflow = workflowRun({
    id: "research-flow",
    name: "Research Flow",
    state: "success",
    result: {
      status: "success",
      summary: "Final synthesis.",
      leaderRunId: "final-lead",
      workerResults: [],
    },
  });
  store.saveWorkflow(workflow);

  const output = await tool.execute({ action: "wait", id: workflow.name });

  assert.equal(output.workflow, workflow);
  assert.equal(output.timedOut, false);
  assert.equal(
    output.message,
    "Workflow reached terminal state: Research Flow (research-flow); state=success result=success.",
  );
});

test("workflow wait resolves immediately for blocked workflows", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWorkflowTool({ orchestra: {} as OrchestraApi, store });
  const workflow = workflowRun({
    id: "blocked-flow",
    state: "blocked",
    result: { status: "blocked", summary: "Needs approval.", workerResults: [] },
  });
  store.saveWorkflow(workflow);

  const output = await tool.execute({ action: "wait", id: workflow.id });

  assert.equal(output.workflow, workflow);
  assert.equal(output.timedOut, false);
  assert.equal(output.message, "Workflow reached terminal state: blocked-flow; state=blocked result=blocked.");
});

test("workflow wait waits for workflow terminal state", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWorkflowTool({ orchestra: {} as OrchestraApi, store });
  const workflow = workflowRun({ state: "idle" });
  store.saveWorkflow(workflow);

  const waitPromise = tool.execute({ action: "wait", id: workflow.id, timeoutMs: null });
  const successWorkflow = { ...workflow, state: "success" as const };
  store.saveWorkflow(successWorkflow);

  const output = await waitPromise;

  assert.equal(output.workflow, successWorkflow);
  assert.equal(output.timedOut, false);
});

test("workflow wait returns latest workflow on timeout", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWorkflowTool({ orchestra: {} as OrchestraApi, store });
  const workflow = workflowRun({ state: "idle" });
  store.saveWorkflow(workflow);

  const output = await tool.execute({ action: "wait", id: workflow.id, timeoutMs: 1 });

  assert.equal(output.workflow, workflow);
  assert.equal(output.timedOut, true);
  assert.equal(output.message, "Timed out waiting for workflow; state=idle.");
});

test("workflow wait rejects non-positive timeouts", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWorkflowTool({ orchestra: {} as OrchestraApi, store });
  const workflow = workflowRun({ state: "idle" });
  store.saveWorkflow(workflow);

  await assert.rejects(
    () => tool.execute({ action: "wait", id: workflow.id, timeoutMs: 0 }),
    /workflow wait timeoutMs must be positive/,
  );
});

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow",
    name: "workflow",
    goal: "Complete the workflow.",
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}
