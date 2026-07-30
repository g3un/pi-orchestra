import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import { createSubagentTool } from "./subagent.ts";
import { buildAgentRun } from "../../tests/helpers/agent-run-fixture.ts";

test("child subagent status is scoped to self or direct children", async () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "parent", name: "parent", parentRunId: null }));
  store.saveRun(run({ id: "child", name: "child", parentRunId: "parent" }));
  store.saveRun(run({ id: "stranger", name: "stranger", parentRunId: "other" }));

  const tool = createSubagentTool({
    orchestra: { getRun: (id: string) => store.getRun(id) } as unknown as OrchestraApi,
    store,
    parentRunId: "parent",
    ownerSessionId: "session-1",
    resolveAgentHealth: undefined,
  });

  assert.equal((await tool.execute({ action: "status", id: "parent" })).run?.id, "parent");
  assert.equal((await tool.execute({ action: "status", id: "child" })).run?.id, "child");
  await assert.rejects(
    () => tool.execute({ action: "status", id: "stranger" }),
    /Only main or direct parent parent can status subagent stranger\./,
  );
});

test("subagent status reports run health", async () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "child", name: "child", parentRunId: null }));
  const tool = createSubagentTool({
    orchestra: { getRun: (id: string) => store.getRun(id) } as unknown as OrchestraApi,
    store,
    parentRunId: null,
    ownerSessionId: "session-1",
    resolveAgentHealth: () => ({
      phase: "retrying",
      contextPercent: 87.6,
      finalError: "Provider unavailable.",
    }),
  });

  const output = await tool.execute({ action: "status", id: "child" });

  assert.equal(output.message, "Subagent child is running. [retrying ctx=88% error=Provider unavailable.]");
});

test("explicit close rejects transitive descendants and supports main bottom-up recovery", async () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "parent", name: "parent", parentRunId: null }));
  store.saveRun(
    run({
      id: "child",
      name: "child",
      parentRunId: "parent",
      state: "success",
      result: { status: "success", summary: "Delegated cleanup." },
    }),
  );
  store.saveRun(
    run({
      id: "finished-descendant",
      name: "finished-descendant",
      parentRunId: "child",
      state: "success",
      result: { status: "success", summary: "Waiting for nested work." },
    }),
  );
  store.saveRun(run({ id: "active-descendant", name: "active-descendant", parentRunId: "finished-descendant" }));
  const closedRunIds: string[] = [];
  const orchestra = lifecycleOrchestra(store, closedRunIds);
  const parentTool = createSubagentTool({
    orchestra,
    store,
    parentRunId: "parent",
    ownerSessionId: "session-1",
    resolveAgentHealth: undefined,
  });

  await assert.rejects(
    () => parentTool.execute({ action: "close", id: "child" }),
    /Agent child has active descendant active-descendant; message child to close its descendants, or ask main\/root to clean them up bottom-up before closing the agent\./,
  );
  assert.deepEqual(closedRunIds, []);

  const mainTool = createSubagentTool({
    orchestra,
    store,
    parentRunId: null,
    ownerSessionId: "session-1",
    resolveAgentHealth: undefined,
  });
  await mainTool.execute({ action: "close", id: "active-descendant" });
  await mainTool.execute({ action: "close", id: "finished-descendant" });
  await parentTool.execute({ action: "close", id: "child" });

  assert.deepEqual(closedRunIds, ["active-descendant", "finished-descendant", "child"]);
});

test("explicit close rejects a running led workgroup but allows scope teardown", async () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "leader", name: "leader", parentRunId: "parent" }));
  store.saveWorkgroup({
    id: "workgroup-1",
    name: "group-review",
    busId: "workgroup-bus",
    ownerSessionId: "session-1",
    goal: "Review the change.",
    leaderRunId: "leader",
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: Date.now(),
  });
  const closedRunIds: string[] = [];
  const tool = createSubagentTool({
    orchestra: lifecycleOrchestra(store, closedRunIds),
    store,
    parentRunId: "parent",
    ownerSessionId: "session-1",
    resolveAgentHealth: undefined,
  });

  await assert.rejects(
    () => tool.execute({ action: "close", id: "leader" }),
    /Agent leader leads running workgroup group-review; finish or cancel it before closing the agent\./,
  );
  assert.deepEqual(closedRunIds, []);

  const workgroup = store.getWorkgroup("workgroup-1");
  assert.ok(workgroup);
  store.saveWorkgroup({ ...workgroup, state: "closing" });
  await tool.execute({ action: "close", id: "leader" });
  assert.deepEqual(closedRunIds, ["leader"]);
});

test("explicit close rejects a running coordinated workflow but allows scope teardown", async () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "coordinator", name: "coordinator", parentRunId: "parent" }));
  const workflow = {
    id: "workflow-1",
    name: "flow-review",
    busId: "workflow-bus",
    ownerSessionId: "session-1",
    goal: "Review the change.",
    ownerRunId: "parent",
    coordinatorRunId: "coordinator",
    workgroupIds: [],
    state: "running" as const,
    result: null,
    createdAtMs: Date.now(),
  };
  store.saveWorkflow(workflow);
  const closedRunIds: string[] = [];
  const tool = createSubagentTool({
    orchestra: lifecycleOrchestra(store, closedRunIds),
    store,
    parentRunId: "parent",
    ownerSessionId: "session-1",
    resolveAgentHealth: undefined,
  });

  await assert.rejects(
    () => tool.execute({ action: "close", id: "coordinator" }),
    /Agent coordinator coordinates running workflow flow-review; cancel it before closing the agent\./,
  );
  assert.deepEqual(closedRunIds, []);

  store.saveWorkflow({ ...workflow, state: "closing" });
  await tool.execute({ action: "close", id: "coordinator" });
  assert.deepEqual(closedRunIds, ["coordinator"]);
});

function lifecycleOrchestra(store: InMemoryAgentStore, closedRunIds: string[]): OrchestraApi {
  return {
    getRun: (id: string) => store.getRun(id),
    closeAgent: async (id: string) => {
      const current = store.getRun(id);
      if (!current) return undefined;
      const closed: AgentRun = { ...current, state: "closed" };
      closedRunIds.push(id);
      store.saveRun(closed);
      return closed;
    },
  } as unknown as OrchestraApi;
}

function run(overrides: Partial<AgentRun>): AgentRun {
  const id = overrides.id ?? "agent";
  return buildAgentRun({
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined, thinkingLevel: undefined },
    task: "Research.",
    busId: overrides.busId ?? "bus-1",
    ownerSessionId: "session-1",
    parentRunId: overrides.parentRunId ?? null,
    state: overrides.state ?? "running",
    result: overrides.result ?? null,
  });
}
