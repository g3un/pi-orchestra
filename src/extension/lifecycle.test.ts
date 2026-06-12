import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage, RunLookupOptions, SpawnAgentOptions } from "../core/orchestra.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { closeRuntimeOwnedScopes } from "./lifecycle.ts";

test("closeRuntimeOwnedScopes closes only scopes owned by runtime run ids", () => {
  const store = new InMemoryAgentStore();
  const orchestra = new CloseBusOrchestra(store);
  store.saveBus(bus({ id: "owned-workflow-bus" }));
  store.saveBus(bus({ id: "owned-workgroup-bus" }));
  store.saveBus(bus({ id: "unowned-workflow-bus" }));
  store.saveBus(bus({ id: "unowned-workgroup-bus" }));
  store.saveRun(run({ id: "owned-leader", busId: "owned-workflow-bus" }));
  store.saveRun(run({ id: "owned-member", busId: "owned-workgroup-bus" }));
  store.saveWorkgroup(
    workgroupRun({ id: "owned-workgroup", busId: "owned-workgroup-bus", memberRunIds: ["owned-member"] }),
  );
  store.saveWorkflow(workflowRun({ id: "owned-workflow", busId: "owned-workflow-bus", leaderRunId: "owned-leader" }));
  store.saveWorkgroup(workgroupRun({ id: "unowned-workgroup", busId: "unowned-workgroup-bus" }));
  store.saveWorkflow(workflowRun({ id: "unowned-workflow", busId: "unowned-workflow-bus" }));

  closeRuntimeOwnedScopes(store, orchestra, ["owned-leader", "owned-member"]);

  assert.equal(store.getWorkflow("owned-workflow")?.state, "closed");
  assert.equal(
    store.getWorkflow("owned-workflow")?.result?.summary,
    "Pi session ended before this orchestration scope closed.",
  );
  assert.equal(store.getWorkgroup("owned-workgroup")?.state, "closed");
  assert.equal(
    store.getWorkgroup("owned-workgroup")?.result?.summary,
    "Pi session ended before this orchestration scope closed.",
  );
  assert.equal(store.getWorkflow("unowned-workflow")?.state, "running");
  assert.equal(store.getWorkgroup("unowned-workgroup")?.state, "running");
  assert.deepEqual(orchestra.closedBusIds.sort(), ["owned-workflow-bus", "owned-workgroup-bus"].sort());
});

class CloseBusOrchestra implements OrchestraApi {
  closedBusIds: string[] = [];

  constructor(private readonly store: InMemoryAgentStore) {}

  createBus(_options: { name: string | undefined }): Bus {
    throw new Error("not implemented");
  }

  getBus(id: string): Bus | undefined {
    return this.store.getBus(id);
  }

  closeBus(id: string): Bus | undefined {
    this.closedBusIds.push(id);
    return this.store.updateBus(id, (current) => ({ ...current, state: "closed" }));
  }

  publishBus(_id: string, _message: string, _from: string): Promise<PublishedBusMessage> {
    throw new Error("not implemented");
  }

  spawnAgent(_profile: AgentProfile, _task: string, _busId: string, _options: SpawnAgentOptions): Promise<AgentRun> {
    throw new Error("not implemented");
  }

  getRun(_id: string, _options: RunLookupOptions): AgentRun | undefined {
    throw new Error("not implemented");
  }

  listRuns(_options: { busId: string | undefined }): AgentRun[] {
    return [];
  }

  messageAgent(_id: string, _message: string, _options: RunLookupOptions): Promise<AgentRun> {
    throw new Error("not implemented");
  }

  closeAgent(_id: string, _options: RunLookupOptions): Promise<AgentRun | undefined> {
    throw new Error("not implemented");
  }
}

function bus(overrides: Partial<Bus> = {}): Bus {
  const id = overrides.id ?? "bus-1";
  return { id, name: overrides.name ?? id, state: "open", messages: [], ...overrides };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    parentRunId: overrides.parentRunId ?? null,
    state: "running",
    sessionFile: `.pi/orchestra/sessions/${id}.jsonl`,
    result: null,
    ...overrides,
  } as AgentRun;
}

function workgroupRun(overrides: Partial<WorkgroupRun> = {}): WorkgroupRun {
  const id = overrides.id ?? "workgroup-1";
  return {
    id,
    name: overrides.name ?? id,
    busId: "bus-1",
    goal: "Complete the workgroup.",
    leaderRunId: null,
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const id = overrides.id ?? "workflow-1";
  return {
    id,
    name: overrides.name ?? id,
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "running",
    busId: "bus-1",
    leaderRunId: null,
    workgroupIds: [],
    statusLine: null,
    result: null,
    ...overrides,
  };
}
