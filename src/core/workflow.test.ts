import assert from "node:assert/strict";
import { test } from "vitest";
import { createWorkflowIdentity, createWorkflowRun } from "./workflow.ts";

test("workflow run starts running with flow-prefixed identity", () => {
  const identity = createWorkflowIdentity("flow-review", []);
  const workflow = createWorkflowRun({
    identity,
    busId: "bus-flow-review",
    ownerSessionId: "session-1",
    goal: "Review staged work.",
    ownerRunId: null,
    coordinatorRunId: "agent-flow-review-coordinator",
  });

  assert.equal(workflow.name, "flow-review");
  assert.equal(workflow.state, "running");
  assert.equal(workflow.result, null);
  assert.deepEqual(workflow.workgroupIds, []);
});

test("workflow names conflict only while active", () => {
  const active = createWorkflowRun({
    identity: { id: "workflow-1", name: "flow-review" },
    busId: "bus-flow-review",
    ownerSessionId: "session-1",
    goal: "Review.",
    ownerRunId: null,
    coordinatorRunId: "agent-flow-review-coordinator",
  });

  assert.throws(() => createWorkflowIdentity("flow-review", [active]), /already in use/);
  assert.doesNotThrow(() => createWorkflowIdentity("flow-review", [{ ...active, state: "closed" }]));
});
