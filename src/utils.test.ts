import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentRun } from "./core/subagent.ts";
import type { WorkflowRun } from "./core/workflow.ts";
import { InMemoryAgentStore } from "./adapters/in-memory-store.ts";
import {
  closeAgentRuns,
  createEntityIdentity,
  findWorkflow,
  formatError,
  formatNamedEntityLabel,
  indent,
  isTerminalAgentState,
  normalizeEntityName,
  requireWorkflow,
  slugify,
  toAgentRunResult,
} from "./utils.ts";

test("slugify and normalizeEntityName validate stable short names", () => {
  assert.equal(slugify("  Frontend Audit!! "), "frontend-audit");
  assert.equal(normalizeEntityName("  Reviewer A  ", "Agent"), "Reviewer A");
  assert.throws(() => normalizeEntityName("   ", "Agent"), /Agent name must not be empty\./);
  assert.throws(() => normalizeEntityName("x".repeat(65), "Agent"), /Agent name must be 64 characters or fewer\./);
});

test("createEntityIdentity accepts unique requested names and rejects duplicates", () => {
  const existing = [{ id: "reviewer", name: "Reviewer" }];

  assert.deepEqual(createEntityIdentity("Security Lead", "agent", existing, "Agent"), {
    id: "security-lead",
    name: "Security Lead",
  });
  assert.throws(() => createEntityIdentity("Reviewer", "agent", existing, "Agent"), /already in use/);
  assert.throws(() => createEntityIdentity("!!!", "agent", existing, "Agent"), /must contain letters or numbers/);
});

test("createEntityIdentity generates collision-free names from auto seeds", () => {
  const existing = [
    { id: "researcher", name: "researcher" },
    { id: "researcher-2", name: "researcher-2" },
  ];

  assert.deepEqual(createEntityIdentity(undefined, "Researcher", existing, "Agent"), {
    id: "researcher-3",
    name: "researcher-3",
  });
});

test("format helpers handle names, indentation, and unknown errors", () => {
  assert.equal(formatNamedEntityLabel({ id: "agent-1", name: "Reviewer" }), "Reviewer (agent-1)");
  assert.equal(formatNamedEntityLabel({ id: "agent-1", name: "agent-1" }), "agent-1");
  assert.equal(indent("one\ntwo", "> "), "> one\n> two");
  assert.equal(formatError(new Error("Boom")), "Boom");
  assert.equal(formatError("plain"), "plain");
});

test("terminal agent state matches the shared AgentState model", () => {
  assert.equal(isTerminalAgentState("idle"), false);
  assert.equal(isTerminalAgentState("running"), false);
  assert.equal(isTerminalAgentState("success"), true);
  assert.equal(isTerminalAgentState("blocked"), true);
  assert.equal(isTerminalAgentState("failed"), true);
  assert.equal(isTerminalAgentState("closed"), true);
});

test("workflow lookup helpers resolve by id or name", () => {
  const store = new InMemoryAgentStore();
  const workflow = workflowRun({ id: "research-flow", name: "Research Flow" });
  store.saveWorkflow(workflow);

  assert.equal(findWorkflow(store, workflow.id), workflow);
  assert.equal(findWorkflow(store, workflow.name), workflow);
  assert.equal(requireWorkflow(store, workflow.id), workflow);
  assert.throws(() => requireWorkflow(store, "missing"), /Workflow missing not found\./);
});

test("toAgentRunResult copies result payloads only when present", () => {
  const idleRun = run({ state: "idle" });
  const successRun = run({
    id: "agent-2",
    state: "idle",
    result: { status: "success", summary: "Done.", data: { file: "src/index.ts" } },
  });

  assert.deepEqual(toAgentRunResult(idleRun), {
    runId: idleRun.id,
    name: idleRun.name,
    profile: idleRun.profile,
    state: "idle",
  });
  assert.deepEqual(toAgentRunResult(successRun), {
    runId: successRun.id,
    name: successRun.name,
    profile: successRun.profile,
    state: "idle",
    result: { status: "success", summary: "Done.", data: { file: "src/index.ts" } },
  });
});

test("closeAgentRuns closes unique run ids and tolerates close failures", async () => {
  const closedIds: string[] = [];
  await closeAgentRuns(
    {
      closeAgent(id: string, _options: { busId: string | undefined }) {
        closedIds.push(id);
        if (id === "broken") throw new Error("Close failed.");
        return Promise.resolve(undefined);
      },
    } as unknown as Parameters<typeof closeAgentRuns>[0],
    ["agent-1", "agent-1", "broken", "agent-2"],
  );

  assert.deepEqual(closedIds, ["agent-1", "broken", "agent-2"]);
});

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
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}
