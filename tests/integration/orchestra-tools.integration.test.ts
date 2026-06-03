import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentResult } from "../../src/core/subagent.ts";
import { InMemoryAgentStore } from "../../src/adapters/in-memory-store.ts";
import { Orchestra } from "../../src/core/orchestra.ts";
import { createBusTool } from "../../src/tools/bus.ts";
import { createSubagentTool } from "../../src/tools/subagent.ts";
import { createWaitBusSettledTool } from "../../src/tools/wait-bus-settled.ts";
import { createWaitNextRunTool } from "../../src/tools/wait-next-run.ts";
import { createWaitWorkflowTool } from "../../src/tools/wait-workflow.ts";
import { createWorkflowTool } from "../../src/tools/workflow.ts";
import { ControllableRuntime } from "../helpers/controllable-runtime.ts";

const researcherProfile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned area.",
};

const reviewerProfile: AgentProfile = {
  name: "reviewer",
  systemPrompt: "Review the assigned area.",
};

test("tools coordinate buses, subagents, messages, and waits through the shared store", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new ControllableRuntime({ store });
  const orchestra = new Orchestra({ runtime, store });
  const busTool = createBusTool({ orchestra });
  const subagentTool = createSubagentTool({ orchestra });
  const waitNextRunTool = createWaitNextRunTool({ orchestra });
  const waitBusSettledTool = createWaitBusSettledTool({ orchestra });

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

  const waitNextRun = waitNextRunTool.execute({ busId: "Review Work", timeoutMs: null });
  runtime.completeRun("reviewer-b", successResult("Reviewer finished first."));
  const nextRun = await waitNextRun;

  assert.equal(nextRun.run?.id, "reviewer-b");
  assert.deepEqual(nextRun.pendingRunIds, ["researcher-a"]);
  assert.equal(nextRun.timedOut, false);
  assert.match(nextRun.message, /Next terminal run on bus Review Work \(review-work\): reviewer-b is success/);

  const published = await busTool.execute({
    action: "publish",
    id: "Review Work",
    message: "Also check strict-mode behavior.",
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

  assert.equal(messaged.run?.state, "idle");
  assert.equal(messaged.run?.result, undefined);
  assert.deepEqual(runtime.messaged, [{ id: "reviewer-b", message: "Re-check with the new strict-mode constraint." }]);

  const waitSettled = waitBusSettledTool.execute({ busId: "Review Work", timeoutMs: null });
  runtime.completeRun("researcher-a", { status: "blocked", summary: "Need a product decision." });
  runtime.completeRun("reviewer-b", successResult("Strict mode looks safe."));
  const settled = await waitSettled;

  assert.equal(settled.timedOut, false);
  assert.deepEqual(
    settled.runResults.map((result) => ({ runId: result.runId, status: result.result?.status })),
    [
      { runId: "researcher-a", status: "blocked" },
      { runId: "reviewer-b", status: "success" },
    ],
  );
  assert.deepEqual(settled.pendingRunIds, []);
  assert.match(settled.message, /All 2 run\(s\) attached to bus Review Work \(review-work\) reached terminal state/);
});

test("workflow runs end-to-end through real tools, orchestra, store, and runtime", async () => {
  const store = new InMemoryAgentStore();
  const runtime = new ControllableRuntime({
    store,
    onSpawn: (run) => ({ ...run, state: "success", result: successResult(`${run.name} completed.`) }),
  });
  const orchestra = new Orchestra({ runtime, store });
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  const started = await workflowTool.execute({
    action: "start",
    name: "release-flow",
    goal: "Prepare a release readiness summary.",
    stages: [
      {
        name: "collect",
        goal: "Collect readiness signals.",
        strategy: "synthesize",
        members: [{ name: "collect-worker", profile: researcherProfile }],
        leader: { name: "collect-leader", profile: reviewerProfile },
      },
      {
        name: "summarize",
        goal: "Summarize release readiness.",
        strategy: "synthesize",
        members: [{ name: "summary-worker", profile: reviewerProfile }],
        leader: { name: "summary-leader", profile: reviewerProfile },
      },
    ],
  });

  const completed = await waitWorkflowTool.execute({ id: "release-flow", timeoutMs: null });

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
  assert.match(summaryWorkerTask, /Previous stage outputs:/);
  assert.match(summaryWorkerTask, /Stage collect output:/);
  assert.match(summaryWorkerTask, /collect-leader completed\./);

  const summaryLeaderTask = runtime.spawned.find((spawn) => spawn.options.name === "summary-leader")?.task ?? "";
  assert.match(summaryLeaderTask, /Worker results for this stage:/);
  assert.match(summaryLeaderTask, /summary-worker completed\./);
  assert.match(completed.message, /Workflow reached terminal state: release-flow; state=success result=success\./);
});

function successResult(summary: string): AgentResult {
  return { status: "success", summary };
}
