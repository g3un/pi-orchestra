import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { createWaitWorkflowTool } from "./wait-workflow.ts";

test("waitWorkflow returns missing workflow status", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWaitWorkflowTool({ store });

  const output = await tool.execute({ id: "missing" });

  assert.equal(output.workflow, undefined);
  assert.equal(output.timedOut, false);
  assert.equal(output.message, "Workflow missing not found.");
});

test("waitWorkflow resolves immediately for terminal workflows", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWaitWorkflowTool({ store });
  const workflow = workflowRun({
    id: "research-flow",
    name: "Research Flow",
    state: "finished",
    result: {
      status: "success",
      summary: "Final synthesis.",
      leaderRunId: "final-lead",
      workerResults: [],
    },
  });
  store.saveWorkflow(workflow);

  const output = await tool.execute({ id: workflow.name });

  assert.equal(output.workflow, workflow);
  assert.equal(output.timedOut, false);
  assert.equal(
    output.message,
    "Workflow reached terminal state: Research Flow (research-flow); state=finished result=success.",
  );
});

test("waitWorkflow waits for workflow terminal state", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWaitWorkflowTool({ store });
  const workflow = workflowRun({ state: "running" });
  store.saveWorkflow(workflow);

  const waitPromise = tool.execute({ id: workflow.id, timeoutMs: null });
  const finishedWorkflow = { ...workflow, state: "finished" as const };
  store.saveWorkflow(finishedWorkflow);

  const output = await waitPromise;

  assert.equal(output.workflow, finishedWorkflow);
  assert.equal(output.timedOut, false);
});

test("waitWorkflow returns latest workflow on timeout", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWaitWorkflowTool({ store });
  const workflow = workflowRun({ state: "running" });
  store.saveWorkflow(workflow);

  const output = await tool.execute({ id: workflow.id, timeoutMs: 1 });

  assert.equal(output.workflow, workflow);
  assert.equal(output.timedOut, true);
  assert.equal(output.message, "Timed out waiting for workflow; state=running.");
});

test("waitWorkflow rejects non-positive timeouts", async () => {
  const store = new InMemoryAgentStore();
  const tool = createWaitWorkflowTool({ store });
  const workflow = workflowRun({ state: "running" });
  store.saveWorkflow(workflow);

  await assert.rejects(
    () => tool.execute({ id: workflow.id, timeoutMs: 0 }),
    /waitWorkflow timeoutMs must be positive/,
  );
});

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow",
    name: "workflow",
    goal: "Complete the workflow.",
    state: "running",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}
