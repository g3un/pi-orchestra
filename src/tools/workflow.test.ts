import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { isTerminalAgentState, slugify } from "../utils.ts";
import { createWorkflowTool, type WorkflowTool, type WorkflowToolOutput } from "./workflow.ts";

const hangingFlowLeaderProfile: AgentProfile = {
  name: "hanging-flow-leader",
  systemPrompt: "Lead the adaptive workflow.",
  tools: ["workflow", "read"],
  model: undefined,
};

const hangingGroupLeaderProfile: AgentProfile = {
  name: "hanging-group-leader",
  systemPrompt: "Lead a child workgroup.",
  tools: ["workgroup", "read"],
  model: undefined,
};

const workerProfile: AgentProfile = {
  name: "worker",
  systemPrompt: "Do delegated work.",
  tools: ["read"],
  model: undefined,
};

const brokenProfile: AgentProfile = {
  name: "broken",
  systemPrompt: "Fail during spawn.",
  tools: ["read"],
  model: undefined,
};

test("workflow creates a flow leader on a private workflow bus", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  const output = await startWorkflow(workflowTool);

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "running");
  assert.equal(output.workflow.busId, "research-flow-flow-bus");
  assert.equal(output.workflow.leaderRunId, "flow-lead");
  assert.deepEqual(output.workflow.workgroupIds, []);
  assert.equal(output.workflow.statusLine, null);
  assert.equal(store.getBus(output.workflow.busId)?.state, "open");
  assert.equal(store.getRun("flow-lead")?.state, "running");
  const leaderTask = orchestra.spawned.find((spawn) => spawn.name === "flow-lead")?.task ?? "";
  assert.match(leaderTask, /Workflow name for workflowId: research-flow/);
  assert.match(leaderTask, /workflow action=update_status/);
  assert.match(leaderTask, /workflow action=spawn_workgroup/);
  assert.match(leaderTask, /workflow action=finish/);
});

test("flow leader creates led workgroups that reuse workgroup lifecycle", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);

  const output = await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "collect",
    goal: "Collect evidence from the codebase.",
    leader: { name: "collect-lead", profile: hangingGroupLeaderProfile, task: "Lead evidence collection." },
  });

  assert.equal(output.action, "spawn_workgroup");
  assert.equal(output.workflow.workgroupIds[0], output.workgroup.id);
  assertUuid7(output.workgroup.id);
  assert.equal(output.workgroup.name, "collect");
  assert.equal(output.workgroup.leaderRunId, "collect-lead");
  assert.equal(output.workgroup.state, "running");
  assert.equal(output.bus.id, "research-flow-collect-bus");
  assert.equal(store.getBus("research-flow-collect-bus")?.state, "open");
  assert.equal(store.getRun("collect-lead")?.busId, "research-flow-collect-bus");
  const groupLeaderTask = orchestra.spawned.find((spawn) => spawn.name === "collect-lead")?.task ?? "";
  assert.match(groupLeaderTask, /workgroup action=add_members/);
  assert.match(groupLeaderTask, /workgroup action=finish/);
  assert.match(groupLeaderTask, /Completed workflow workgroups before this one:[\s\S]*None\./);
});

test("workflow closes child workgroups when leader spawn fails", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "spawn_workgroup",
        workflowId: "research-flow",
        name: "broken-group",
        goal: "Try to launch a broken group.",
        leader: { name: "broken-lead", profile: brokenProfile, task: "Lead the broken group." },
      }),
    /Spawn failed\./,
  );

  const workgroup = findWorkgroupByName(store, "broken-group");
  assert.ok(workgroup);
  assert.equal(workgroup.state, "closed");
  assert.deepEqual(workgroup.result, { status: "failed", summary: "Spawn failed." });
  assert.equal(store.getBus("research-flow-broken-group-bus")?.state, "closed");
  assert.deepEqual(findWorkflowByName(store, "research-flow")?.workgroupIds, [workgroup.id]);
  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "spawn_workgroup",
        workflowId: "research-flow",
        name: "broken-group",
        goal: "Retry with the same name.",
        leader: { name: "retry-lead", profile: hangingGroupLeaderProfile, task: "Retry the group." },
      }),
    /Workflow workgroup name "broken-group" is already in use\./,
  );
});

test("workflow does not resurrect child workgroups closed during leader launch", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);
  const spawnStarted = createDeferred();
  const spawnDelay = createDeferred();
  orchestra.onSpawnStarted = () => spawnStarted.resolve();
  orchestra.spawnDelay = spawnDelay.promise;

  const spawnTask = workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "cancelled-group",
    goal: "Close while leader launch is pending.",
    leader: { name: "cancelled-lead", profile: hangingGroupLeaderProfile, task: "Lead the cancelled group." },
  });
  await spawnStarted.promise;
  const workgroup = findWorkgroupByName(store, "cancelled-group");
  assert.ok(workgroup);
  store.saveWorkgroup({
    ...workgroup,
    state: "closed",
    result: { status: "blocked", summary: "Closed during leader launch." },
  });
  spawnDelay.resolve();

  const output = await spawnTask;

  assert.equal(output.action, "spawn_workgroup");
  assert.equal(output.workgroup.state, "closed");
  assert.deepEqual(output.workgroup.result, { status: "blocked", summary: "Closed during leader launch." });
  assert.equal(findWorkgroupByName(store, "cancelled-group")?.state, "closed");
  assert.equal(store.getRun("cancelled-lead")?.state, "closed");
  assert.equal(store.getBus("research-flow-cancelled-group-bus")?.state, "closed");
});

test("workflow spawn_workgroup accepts workflow names as workflowId", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await workflowTool.execute({
    action: "create",
    name: "Research Flow",
    goal: "Research and analyze the topic.",
    leader: {
      name: "flow-lead",
      profile: hangingFlowLeaderProfile,
      task: "Coordinate the adaptive research workflow.",
    },
  });

  const output = await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "Research Flow",
    name: "collect",
    goal: "Collect evidence.",
    leader: { name: "collect-lead", profile: hangingGroupLeaderProfile, task: "Lead evidence collection." },
  });

  assert.equal(output.action, "spawn_workgroup");
  assertUuid7(output.workflow.id);
  assert.equal(output.workflow.name, "Research Flow");
  assert.equal(output.workgroup.name, "collect");
});

test("later workflow workgroups receive previous workgroup outputs", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);
  await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "collect",
    goal: "Collect evidence.",
    leader: { name: "collect-lead", profile: hangingGroupLeaderProfile, task: "Lead evidence collection." },
  });
  const collectWorkgroup = findWorkgroupByName(store, "collect");
  assert.ok(collectWorkgroup);
  store.saveWorkgroup({
    ...collectWorkgroup,
    state: "closed",
    result: { status: "success", summary: "Collected API facts.", data: { files: ["src/core/workgroup.ts"] } },
  });

  await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "analyze",
    goal: "Analyze collected evidence.",
    leader: { name: "analyze-lead", profile: hangingGroupLeaderProfile, task: "Lead analysis of collected evidence." },
  });

  const analyzeTask = orchestra.spawned.find((spawn) => spawn.name === "analyze-lead")?.task ?? "";
  assert.match(analyzeTask, /<workgroup_output name="collect">/);
  assert.match(analyzeTask, /Collected API facts\./);
  assert.match(analyzeTask, /src\/core\/workgroup\.ts/);
});

test("workflow finish closes child workgroups, buses, group leaders, members, and flow leader", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);
  await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "collect",
    goal: "Collect evidence.",
    leader: { name: "collect-lead", profile: hangingGroupLeaderProfile, task: "Lead evidence collection." },
  });
  const memberRun = run({ id: "collector", name: "collector", busId: "research-flow-collect-bus" });
  orchestra.runs.set(memberRun.id, memberRun);
  const workgroup = findWorkgroupByName(store, "collect");
  assert.ok(workgroup);
  store.saveWorkgroup({
    ...workgroup,
    memberRunIds: [memberRun.id],
    result: { status: "success", summary: "Collected enough evidence." },
  });

  await workflowTool.execute({
    action: "finish",
    workflowId: "research-flow",
    result: { status: "success", summary: "Workflow goal complete.", data: { decision: "ship" } },
  });
  const workflow = await waitForWorkflow(store, "research-flow");

  assert.equal(workflow.state, "closed");
  assert.equal(workflow.result?.status, "success");
  assert.deepEqual(workflow.result?.data, { decision: "ship" });
  assert.deepEqual(
    workflow.workgroupIds.map((workgroupId) => store.getWorkgroup(workgroupId)?.name),
    ["collect"],
  );
  assert.equal(findWorkgroupByName(store, "collect")?.state, "closed");
  assert.equal(store.getBus("research-flow-flow-bus")?.state, "closed");
  assert.equal(store.getBus("research-flow-collect-bus")?.state, "closed");
  assert.equal(orchestra.runs.get("flow-lead")?.state, "closed");
  assert.equal(orchestra.runs.get("collect-lead")?.state, "closed");
  assert.equal(orchestra.runs.get("collector")?.state, "closed");
});

test("workflow cancel closes active workflow resources with a cancellation result", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);
  await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "collect",
    goal: "Collect evidence.",
    leader: { name: "collect-lead", profile: hangingGroupLeaderProfile, task: "Lead evidence collection." },
  });

  const output = await workflowTool.execute({ action: "cancel", workflowId: "research-flow" });

  assert.equal(output.action, "cancel");
  assert.equal(output.workflow.state, "closed");
  assert.equal(output.workflow.result?.status, "blocked");
  assert.equal(output.workflow.result?.summary, "Workflow cancelled.");
  assert.equal(findWorkgroupByName(store, "collect")?.state, "closed");
  assert.equal(store.getBus("research-flow-flow-bus")?.state, "closed");
  assert.equal(store.getBus("research-flow-collect-bus")?.state, "closed");
  assert.equal(orchestra.runs.get("flow-lead")?.state, "closed");
  assert.equal(orchestra.runs.get("collect-lead")?.state, "closed");
});

test("workflow status returns latest adaptive workflow by name", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);

  const output = await workflowTool.execute({ action: "status", workflowId: "research-flow" });

  assert.equal(output.action, "status");
  assert.equal(output.workflow.state, "running");
  assert.equal(output.workflow.leaderRunId, "flow-lead");
  assert.deepEqual(output.workflow.workgroupIds, []);
});

test("workflow update_status records the flow leader monitor line", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  await startWorkflow(workflowTool);

  const output = await workflowTool.execute({
    action: "update_status",
    workflowId: "research-flow",
    statusLine: "Collecting codebase evidence.",
  });

  assert.equal(output.action, "update_status");
  assert.equal(output.workflow.statusLine, "Collecting codebase evidence.");
  assert.equal(findWorkflowByName(store, "research-flow")?.statusLine, "Collecting codebase evidence.");
  assert.equal(
    workflowTool.formatOutput(output),
    "Updated workflow research-flow monitor status.\n\nCollecting codebase evidence.",
  );
});

test("workflow validates leader names and workgroup names", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  store.saveRun(run({ id: "existing-lead", name: "existing-lead" }));

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "create",
        name: "duplicate-leader-flow",
        goal: "Research the topic.",
        leader: { profile: hangingFlowLeaderProfile, name: "existing-lead", task: "Lead the duplicate workflow." },
      }),
    /Workflow leader name "existing-lead" is already in use\./,
  );

  await startWorkflow(workflowTool);
  await workflowTool.execute({
    action: "spawn_workgroup",
    workflowId: "research-flow",
    name: "collect",
    goal: "Collect evidence.",
    leader: { name: "collect-lead", profile: hangingGroupLeaderProfile, task: "Lead evidence collection." },
  });

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "spawn_workgroup",
        workflowId: "research-flow",
        name: "collect",
        goal: "Collect duplicate evidence.",
        leader: {
          name: "collect-lead-2",
          profile: hangingGroupLeaderProfile,
          task: "Lead duplicate evidence collection.",
        },
      }),
    /Workflow workgroup name "collect" is already in use\./,
  );
});

test("workflow runs an explicitly provided custom flow leader", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  const profile: AgentProfile = {
    name: "release-leader",
    systemPrompt: "Coordinate release readiness workgroups.",
    tools: ["workflow", "read"],
    model: undefined,
  };

  await workflowTool.execute({
    action: "create",
    name: "custom-leader-flow",
    goal: "Research the topic.",
    leader: { name: "custom-flow-lead", profile, task: "Coordinate the custom workflow." },
  });

  const leaderSpawn = orchestra.spawned.find((spawn) => spawn.name === "custom-flow-lead");
  assert.ok(leaderSpawn);
  assert.equal(leaderSpawn.profile.name, "release-leader");
  assert.deepEqual(leaderSpawn.profile.tools, ["workflow", "read"]);
});

test("workflow status and cancel report missing workflows", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  const statusOutput = await workflowTool.execute({ action: "status", workflowId: "missing-flow" });
  const cancelOutput = await workflowTool.execute({ action: "cancel", workflowId: "missing-flow" });

  assert.equal(statusOutput.action, "not_found");
  assert.equal(statusOutput.workflowId, "missing-flow");
  assert.equal(cancelOutput.action, "not_found");
  assert.equal(cancelOutput.workflowId, "missing-flow");
});

test("workflow marks start failure when the flow leader cannot spawn", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "create",
        name: "broken-flow",
        goal: "Research the topic.",
        leader: { name: "broken-lead", profile: brokenProfile, task: "Try to lead the broken workflow." },
      }),
    /Spawn failed\./,
  );

  assert.equal(findWorkflowByName(store, "broken-flow")?.state, "closed");
  assert.equal(findWorkflowByName(store, "broken-flow")?.result?.status, "failed");
  assert.equal(store.getBus("broken-flow-flow-bus")?.state, "closed");
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs: SyncedRunMap;
  spawned: Array<{ profile: AgentProfile; task: string; busId: string; name: string }> = [];
  spawnDelay: Promise<void> | undefined;
  onSpawnStarted: (() => void) | undefined;

  constructor(private readonly store: InMemoryAgentStore) {
    this.runs = new SyncedRunMap(store);
  }

  createBus(options: { name: string | undefined }): Bus {
    const id = slugify(options.name ?? `bus-${this.buses.size + 1}`);
    const bus: Bus = { id, name: options.name ?? id, state: "open", messages: [] };
    this.buses.set(bus.id, bus);
    this.store.saveBus(bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id) ?? [...this.buses.values()].find((bus) => bus.name === id);
  }

  closeBus(id: string): Bus | undefined {
    const bus = this.getBus(id);
    if (!bus) return undefined;
    const closedBus: Bus = { ...bus, state: "closed" };
    this.buses.set(bus.id, closedBus);
    this.store.saveBus(closedBus);
    return closedBus;
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
    const bus = this.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, message, from };
    bus.messages.push(busMessage);
    this.store.addBusMessage(bus.id, busMessage);
    return { bus, busMessage };
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: { name: string | undefined },
  ): Promise<AgentRun> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    if (profile.name === "broken") throw new Error("Spawn failed.");

    this.onSpawnStarted?.();
    if (this.spawnDelay) await this.spawnDelay;

    const name = options.name ?? profile.name;
    this.spawned.push({ profile, task, busId: bus.id, name });
    const createdRun = run({ id: slugify(name), name, profile, task, busId: bus.id });
    this.runs.set(createdRun.id, createdRun);
    return createdRun;
  }

  getRun(id: string, _options: { busId: string | undefined }): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId: string | undefined }): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async messageAgent(id: string, _message: string, _options: { busId: string | undefined }): Promise<AgentRun> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  async closeAgent(id: string, _options: { busId: string | undefined }): Promise<AgentRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;

    const closedRun = { ...run, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
  }
}

class SyncedRunMap extends Map<string, AgentRun> {
  constructor(private readonly store: InMemoryAgentStore) {
    super();
  }

  set(key: string, value: AgentRun): this {
    this.store.saveRun(value);
    return super.set(key, value);
  }
}

function createDeferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function startWorkflow(workflowTool: WorkflowTool): Promise<Extract<WorkflowToolOutput, { action: "create" }>> {
  const output = await workflowTool.execute({
    action: "create",
    name: "research-flow",
    goal: "Research and analyze the topic.",
    leader: {
      name: "flow-lead",
      profile: hangingFlowLeaderProfile,
      task: "Coordinate the adaptive research workflow.",
    },
  });
  assert.equal(output.action, "create");
  return output;
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: overrides.profile ?? workerProfile,
    task: overrides.task ?? "Inspect the code.",
    busId: overrides.busId ?? "bus-1",
    state: "running",
    ...overrides,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}

function assertUuid7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function findWorkflowByName(store: InMemoryAgentStore, name: string): ReturnType<InMemoryAgentStore["getWorkflow"]> {
  return store.listWorkflows().find((workflow) => workflow.name === name);
}

function findWorkgroupByName(store: InMemoryAgentStore, name: string): ReturnType<InMemoryAgentStore["getWorkgroup"]> {
  return store.listWorkgroups().find((workgroup) => workgroup.name === name);
}

async function waitForWorkflow(
  store: InMemoryAgentStore,
  name: string,
): Promise<NonNullable<ReturnType<InMemoryAgentStore["getWorkflow"]>>> {
  await eventually(() => {
    const workflow = findWorkflowByName(store, name);
    return workflow !== undefined && isTerminalAgentState(workflow.state);
  });
  const workflow = findWorkflowByName(store, name);
  assert.ok(workflow);
  return workflow;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(predicate());
}
