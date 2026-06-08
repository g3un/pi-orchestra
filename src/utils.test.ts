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

test("createEntityIdentity accepts unique requested names, assigns UUIDv7 ids, and rejects duplicates", () => {
  const existing = [{ id: "reviewer", name: "Reviewer" }];

  const identity = createEntityIdentity("Security Lead", "agent", existing, "Agent");
  assertUuid7(identity.id);
  assert.equal(identity.name, "Security Lead");
  assert.notEqual(identity.id, "security-lead");
  assert.throws(() => createEntityIdentity("Reviewer", "agent", existing, "Agent"), /already in use/);
  assert.throws(() => createEntityIdentity("reviewer", "agent", existing, "Agent"), /already in use/);
});

test("createEntityIdentity generates collision-free names from auto seeds", () => {
  const existing = [
    { id: "researcher", name: "researcher" },
    { id: "researcher-2", name: "researcher-2" },
  ];

  const identity = createEntityIdentity(undefined, "Researcher", existing, "Agent");
  assertUuid7(identity.id);
  assert.equal(identity.name, "researcher-3");
});

test("format helpers handle indentation and unknown errors", () => {
  assert.equal(indent("one\ntwo", "> "), "> one\n> two");
  assert.equal(formatError(new Error("Boom")), "Boom");
  assert.equal(formatError("plain"), "plain");
});

test("terminal agent state matches the shared AgentState model", () => {
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

  assert.deepEqual(findWorkflow(store, workflow.id), workflow);
  assert.deepEqual(findWorkflow(store, workflow.name), workflow);
  assert.deepEqual(requireWorkflow(store, workflow.id), workflow);
  assert.deepEqual(requireWorkflow(store, workflow.name), workflow);
  assert.throws(() => requireWorkflow(store, "missing"), /Workflow missing not found\./);
});

test("toAgentRunResult copies result payloads with explicit null when absent", () => {
  const idleRun = run({ state: "running" });
  const successRun = run({
    id: "agent-2",
    state: "success",
    result: { status: "success", summary: "Done.", data: { file: "src/index.ts" } },
  });

  assert.deepEqual(toAgentRunResult(idleRun), {
    runId: idleRun.id,
    name: idleRun.name,
    profile: idleRun.profile.name,
    state: "running",
    result: null,
  });
  assert.deepEqual(toAgentRunResult(successRun), {
    runId: successRun.id,
    name: successRun.name,
    profile: successRun.profile.name,
    state: "success",
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

function assertUuid7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "running",
    busId: "workflow-bus",
    leaderRunId: null,
    workgroupIds: [],
    statusLine: null,
    result: null,
    ...overrides,
  };
}
