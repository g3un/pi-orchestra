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
  });

  assert.equal((await tool.execute({ action: "status", id: "parent" })).run?.id, "parent");
  assert.equal((await tool.execute({ action: "status", id: "child" })).run?.id, "child");
  await assert.rejects(
    () => tool.execute({ action: "status", id: "stranger" }),
    /Only main or direct parent parent can status subagent stranger\./,
  );
});

function run(overrides: Partial<AgentRun>): AgentRun {
  const id = overrides.id ?? "agent";
  return buildAgentRun({
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Research.",
    busId: overrides.busId ?? "bus-1",
    ownerSessionId: "session-1",
    parentRunId: overrides.parentRunId ?? null,
    sessionFile: `.pi/orchestra/sessions/${id}.jsonl`,
    state: overrides.state ?? "running",
    result: overrides.result ?? null,
  });
}
