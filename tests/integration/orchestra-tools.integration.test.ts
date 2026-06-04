import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentResult } from "../../src/core/subagent.ts";
import { InMemoryAgentStore } from "../../src/adapters/in-memory-store.ts";
import { Orchestra } from "../../src/core/orchestra.ts";
import { createBusTool } from "../../src/tools/bus.ts";
import { createSubagentTool } from "../../src/tools/subagent.ts";
import { OrchestraEventController, type OrchestraMainEvent } from "../../src/extension/orchestra-events.ts";
import { createWorkflowTool } from "../../src/tools/workflow.ts";
import { isTerminalAgentState } from "../../src/utils.ts";
import { ControllableRuntime } from "../helpers/controllable-runtime.ts";

const researcherProfile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned area.",
  tools: ["read", "bash"],
  model: undefined,
};

const reviewerProfile: AgentProfile = {
  name: "reviewer",
  systemPrompt: "Review the assigned area.",
  tools: ["read", "bash"],
  model: undefined,
};

test("tools coordinate buses, subagents, messages, and completion events through the shared store", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new ControllableRuntime({ store });
  const orchestra = new Orchestra({ runtime, store });
  const busTool = createBusTool({ orchestra });
  const subagentTool = createSubagentTool({ orchestra });
  const eventBatches: OrchestraMainEvent[][] = [];
  new OrchestraEventController({
    store,
    flushDelayMs: 0,
    sendEvents: (events) => eventBatches.push(events),
  });
  const createdBus = await busTool.execute({ action: "create", name: "Review Work" });
  const firstSpawn = await subagentTool.execute({
    action: "spawn",
    profile: researcherProfile,
    task: "Find risky code paths.",
    busId: "Review Work",
    name: "researcher-a",
  });
  const secondSpawn = await subagentTool.execute({
    action: "spawn",
    profile: reviewerProfile,
    task: "Review the proposed changes.",
    busId: "review-work",
    name: "reviewer-b",
  });

  assert.equal(createdBus.bus?.id, "review-work");
  assert.equal(firstSpawn.run?.busId, "review-work");
  assert.equal(secondSpawn.run?.name, "reviewer-b");
  assert.deepEqual(
    runtime.spawned.map((spawn) => ({ name: spawn.options.name, busId: spawn.busId })),
    [
      { name: "researcher-a", busId: "review-work" },
      { name: "reviewer-b", busId: "review-work" },
    ],
  );

  runtime.completeRun("reviewer-b", successResult("Reviewer finished first."));

  assert.equal(eventBatches[0]?.[0]?.type, "subagent.finished");
  assert.equal(
    eventBatches[0]?.[0]?.type === "subagent.finished" ? eventBatches[0][0].run.runId : undefined,
    "reviewer-b",
  );

  const published = await busTool.execute({
    action: "publish",
    name: "Review Work",
    message: "Also check strict-mode behavior.",
    from: "main",
  });

  assert.equal(published.busMessage?.id, "message-1");
  assert.deepEqual(runtime.published, [
    { busId: "review-work", message: "Also check strict-mode behavior.", from: "main" },
  ]);
  assert.deepEqual(store.getBus("review-work")?.messages, [
    { id: "message-1", message: "Also check strict-mode behavior.", from: "main" },
  ]);

  const messaged = await subagentTool.execute({
    action: "message",
    id: "reviewer-b",
    busId: "Review Work",
    message: "Re-check with the new strict-mode constraint.",
  });

  assert.equal(messaged.run?.state, "running");
  assert.equal(messaged.run?.result, undefined);
  assert.deepEqual(runtime.messaged, [{ id: "reviewer-b", message: "Re-check with the new strict-mode constraint." }]);

  runtime.completeRun("researcher-a", { status: "blocked", summary: "Need a product decision." });
  runtime.completeRun("reviewer-b", successResult("Strict mode looks safe."));

  assert.deepEqual(
    eventBatches
      .slice(1)
      .flatMap((events) => events.map((event) => (event.type === "subagent.finished" ? event.run.runId : event.type))),
    ["researcher-a", "reviewer-b"],
  );
});

test("workflow runs end-to-end through real tools, orchestra, store, and runtime", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new ControllableRuntime({
    store,
    onSpawn: (run) => ({ ...run, state: "idle", result: successResult(`${run.name} completed.`) }),
  });
  const orchestra = new Orchestra({ runtime, store });
  const workflowTool = createWorkflowTool({ orchestra, store });

  const started = await workflowTool.execute({
    action: "start",
    name: "release-flow",
    goal: "Prepare a release readiness summary.",
    stages: [
      {
        name: "collect",
        goal: "Collect readiness signals.",
        strategy: "synthesize",
        members: [{ name: "collect-worker", profile: researcherProfile, assignment: undefined }],
        leader: { name: "collect-leader", profile: reviewerProfile, assignment: undefined },
      },
      {
        name: "summarize",
        goal: "Summarize release readiness.",
        strategy: "synthesize",
        members: [{ name: "summary-worker", profile: reviewerProfile, assignment: undefined }],
        leader: { name: "summary-leader", profile: reviewerProfile, assignment: undefined },
      },
    ],
  });

  await waitForWorkflow(store, "release-flow");
  const completed = await workflowTool.execute({ action: "status", id: "release-flow" });

  assert.equal(started.workflow?.id, "release-flow");
  assert.equal(completed.workflow?.state, "success");
  assert.equal(completed.workflow?.result?.leaderRunId, "summary-leader");
  assert.deepEqual(
    completed.workflow?.stages.map((stage) => ({ name: stage.name, state: stage.state, busId: stage.busId })),
    [
      { name: "collect", state: "success", busId: "release-flow-collect" },
      { name: "summarize", state: "success", busId: "release-flow-summarize" },
    ],
  );
  assert.deepEqual(
    store.listBuses().map((bus) => bus.id),
    ["release-flow-collect", "release-flow-summarize"],
  );
  assert.deepEqual(
    runtime.spawned.map((spawn) => spawn.options.name),
    ["collect-worker", "collect-leader", "summary-worker", "summary-leader"],
  );

  const summaryWorkerTask = runtime.spawned.find((spawn) => spawn.options.name === "summary-worker")?.task ?? "";
  assert.match(summaryWorkerTask, /<previous_stage_outputs>/);
  assert.match(summaryWorkerTask, /<stage_output name="collect">/);
  assert.match(summaryWorkerTask, /collect-leader completed\./);

  const summaryLeaderTask = runtime.spawned.find((spawn) => spawn.options.name === "summary-leader")?.task ?? "";
  assert.match(summaryLeaderTask, /<worker_results>/);
  assert.match(summaryLeaderTask, /summary-worker completed\./);
  assert.match(completed.message, /Workflow release-flow is success\./);
});

async function waitForWorkflow(store: InMemoryAgentStore, id: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const workflow = store.getWorkflow(id);
    if (workflow && isTerminalAgentState(workflow.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const workflow = store.getWorkflow(id);
  assert.ok(workflow && isTerminalAgentState(workflow.state));
}

function successResult(summary: string): AgentResult {
  return { status: "success", summary };
}
