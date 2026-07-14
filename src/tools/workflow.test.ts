import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { OrchestraEventController, type OrchestraMainEvent } from "../extension/orchestra-events.ts";
import { slugify } from "../utils.ts";
import { closeWorkflowRun, createWorkflowTool, type WorkflowToolDeps } from "./workflow.ts";

const reviewerProfile: AgentProfile = {
  name: "reviewer",
  systemPrompt: "Review the work.",
  tools: ["read"],
  model: undefined,
};

function deps(orchestra: FakeOrchestra, parentRunId: string | null = null): WorkflowToolDeps {
  return {
    orchestra,
    store: orchestra.store,
    parentRunId,
    ownerSessionId: "session-1",
    onWorkgroupLaunching: undefined,
    onWorkgroupLaunched: undefined,
    onWorkgroupLaunchFailed: undefined,
  };
}

test("workflow create records flow-prefixed workflow, bus, and coordinator", async () => {
  const orchestra = new FakeOrchestra();
  const output = await createWorkflowTool(deps(orchestra)).execute({
    action: "create",
    name: "review",
    goal: "Run staged reviews.",
  });

  assert.equal(output.action, "create");
  assert.equal(output.workflow.name, "flow-review");
  assert.equal(output.bus.name, "bus-flow-review");
  assert.equal(output.coordinator.name, "agent-flow-review-coordinator");
  assert.deepEqual(output.coordinator.profile.tools, ["workflow", "publish_bus"]);
  assert.match(orchestra.messages[0]?.message ?? "", /is registered/);
});

test("workflow add_workgroup is coordinator-only and records child workgroup", async () => {
  const orchestra = new FakeOrchestra();
  const created = await createWorkflowTool(deps(orchestra)).execute({
    action: "create",
    name: "review",
    goal: "Run staged reviews.",
  });
  assert.equal(created.action, "create");
  await assert.rejects(
    () =>
      createWorkflowTool(deps(orchestra)).execute({
        action: "add_workgroup",
        id: created.workflow.id,
        name: "phase-one",
        goal: "Review phase one.",
        members: [{ name: "reviewer", profile: reviewerProfile, task: "Review." }],
      }),
    /Only coordinator/,
  );

  const output = await createWorkflowTool(deps(orchestra, created.workflow.coordinatorRunId)).execute({
    action: "add_workgroup",
    id: created.workflow.id,
    name: "phase-one",
    goal: "Review phase one.",
    members: [{ name: "reviewer", profile: reviewerProfile, task: "Review." }],
  });

  assert.equal(output.action, "add_workgroup");
  const workflow = requireWorkflow(orchestra, created.workflow.id);
  assert.deepEqual(workflow.workgroupIds, [output.workgroupId]);
  assert.equal(orchestra.store.getWorkgroup(output.workgroupId)?.name, "group-phase-one");
});

test("workflow cancel closes child workgroups, coordinator, and bus", async () => {
  const orchestra = new FakeOrchestra();
  const created = await createWorkflowTool(deps(orchestra)).execute({ action: "create", name: "review", goal: "Run." });
  assert.equal(created.action, "create");
  const added = await createWorkflowTool(deps(orchestra, created.workflow.coordinatorRunId)).execute({
    action: "add_workgroup",
    id: created.workflow.id,
    name: "phase-one",
    goal: "Review phase one.",
    members: [{ name: "reviewer", profile: reviewerProfile, task: "Review." }],
  });
  assert.equal(added.action, "add_workgroup");

  const cancelled = await createWorkflowTool(deps(orchestra)).execute({ action: "cancel", id: created.workflow.id });

  assert.equal(cancelled.action, "cancel");
  assert.equal(cancelled.workflow.state, "closed");
  assert.equal(orchestra.getRun(created.workflow.coordinatorRunId)?.state, "closed");
  assert.equal(orchestra.getBus(created.workflow.busId)?.state, "closed");
  assert.equal(orchestra.store.getWorkgroup(added.workgroupId)?.state, "closed");
});

test("workflow names conflict while open and can be reused after close", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkflowTool(deps(orchestra));
  const first = await tool.execute({ action: "create", name: "review", goal: "Run." });
  assert.equal(first.action, "create");

  await assert.rejects(() => tool.execute({ action: "create", name: "review", goal: "Run again." }), /already in use/);
  await closeWorkflowRun(orchestra, orchestra.store, first.workflow, {
    includeCoordinator: true,
    result: { status: "blocked", summary: "Closed for reuse." },
  });

  const second = await tool.execute({ action: "create", name: "review", goal: "Run again." });
  assert.equal(second.action, "create");
  assert.equal(second.workflow.name, "flow-review");
  assert.notEqual(second.workflow.id, first.workflow.id);
});

test("closeWorkflowRun cleans up already closed workflow resources", async () => {
  const orchestra = new FakeOrchestra();
  const created = await createWorkflowTool(deps(orchestra)).execute({ action: "create", name: "review", goal: "Run." });
  assert.equal(created.action, "create");
  orchestra.store.saveWorkflow({
    ...created.workflow,
    state: "closed",
    result: { status: "blocked", summary: "Marked closed." },
  });

  await closeWorkflowRun(orchestra, orchestra.store, created.workflow, { includeCoordinator: true, result: undefined });

  assert.equal(orchestra.getRun(created.workflow.coordinatorRunId)?.state, "closed");
  assert.equal(orchestra.getBus(created.workflow.busId)?.state, "closed");
});

test("workflow create keeps saved workflow when registration message fails", async () => {
  const orchestra = new FakeOrchestra();
  orchestra.failMessages = true;

  const created = await createWorkflowTool(deps(orchestra)).execute({ action: "create", name: "review", goal: "Run." });

  assert.equal(created.action, "create");
  assert.equal(orchestra.store.getWorkflow(created.workflow.id)?.state, "running");
  assert.equal(orchestra.getRun(created.workflow.coordinatorRunId)?.state, "running");
  assert.equal(orchestra.getBus(created.workflow.busId)?.state, "open");
});

test("workflow create rolls back coordinator when workflow save fails", async () => {
  const orchestra = new SaveWorkflowFailureOrchestra();

  await assert.rejects(
    () => createWorkflowTool(deps(orchestra)).execute({ action: "create", name: "review", goal: "Run." }),
    /Save workflow failed/,
  );

  assert.equal(orchestra.store.listRuns()[0]?.state, "closed");
  assert.equal(orchestra.store.listBuses()[0]?.state, "closed");
});

test("workflow.finished event is emitted when workflow closes", () => {
  const store = new InMemoryAgentStore();
  const events: OrchestraMainEvent[] = [];
  const controller = new OrchestraEventController({
    store,
    sendEvents: (sent) => events.push(...sent),
    isRunWaiting: undefined,
    flushDelayMs: 0,
  });
  const workflow: WorkflowRun = {
    id: "workflow-1",
    name: "flow-review",
    busId: "bus-flow-review",
    ownerSessionId: "session-1",
    goal: "Run.",
    ownerRunId: null,
    coordinatorRunId: "agent-flow-review-coordinator",
    workgroupIds: [],
    state: "running",
    result: null,
    createdAtMs: 1,
  };

  store.saveWorkflow(workflow);
  store.saveWorkflow({ ...workflow, state: "closed", result: { status: "success", summary: "Done." } });
  controller.dispose();

  assert.equal(events.at(-1)?.type, "workflow.finished");
});

test("workflow finish waits for child workgroups", async () => {
  const orchestra = new FakeOrchestra();
  const created = await createWorkflowTool(deps(orchestra)).execute({ action: "create", name: "review", goal: "Run." });
  assert.equal(created.action, "create");
  const coordinatorTool = createWorkflowTool(deps(orchestra, created.workflow.coordinatorRunId));
  const added = await coordinatorTool.execute({
    action: "add_workgroup",
    id: created.workflow.id,
    name: "phase-one",
    goal: "Review phase one.",
    members: [{ name: "reviewer", profile: reviewerProfile, task: "Review." }],
  });
  assert.equal(added.action, "add_workgroup");

  await assert.rejects(
    () =>
      coordinatorTool.execute({
        action: "finish",
        id: created.workflow.id,
        result: { status: "success", summary: "Done." },
      }),
    /still has running workgroups/,
  );

  const workgroup = orchestra.store.getWorkgroup(added.workgroupId);
  assert.ok(workgroup);
  orchestra.store.saveWorkgroup({ ...workgroup, state: "closed", result: { status: "success", summary: "Done." } });
  const finished = await coordinatorTool.execute({
    action: "finish",
    id: created.workflow.id,
    result: { status: "success", summary: "Done." },
  });

  assert.equal(finished.action, "finish");
  assert.equal(finished.workflow.state, "closed");
  assert.equal(orchestra.getBus(created.workflow.busId)?.state, "closed");
});

class FakeOrchestra implements OrchestraApi {
  store = new InMemoryAgentStore();
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  messages: Array<{ id: string; message: string }> = [];
  failMessages = false;

  createBus(options: { name: string | undefined }): Bus {
    const id = options.name ?? `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: options.name ?? id, state: "open", messages: [], nextMessageSeq: 1 };
    this.buses.set(bus.id, bus);
    this.store.saveBus(bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.store.getBus(id) ?? this.store.listBuses().find((bus) => bus.name === id);
  }

  closeBus(id: string): Bus | undefined {
    const bus = this.getBus(id);
    if (!bus) return undefined;
    const closed: Bus = { ...bus, state: "closed" };
    this.buses.set(bus.id, closed);
    this.store.saveBus(closed);
    return closed;
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
    const bus = this.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, seq: bus.nextMessageSeq, message, from };
    return { bus, busMessage };
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: { name: string | undefined; parentRunId: string | null },
  ): Promise<AgentRun> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    const name = options.name ?? profile.name;
    const id = slugify(name);
    const run: AgentRun = {
      id,
      name,
      profile,
      task,
      busId: bus.id,
      parentRunId: options.parentRunId,
      ownerSessionId: "session-1",
      sessionFile: `.pi/orchestra/sessions/${id}.jsonl`,
      state: "running",
      result: null,
    };
    this.runs.set(run.id, run);
    this.store.saveRun(run);
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    return this.store.getRun(id) ?? this.store.listRuns().find((run) => run.name === id);
  }

  listRuns(options: { busId: string | undefined }): AgentRun[] {
    const runs = this.store.listRuns();
    return options.busId ? runs.filter((run) => run.busId === options.busId) : runs;
  }

  async messageAgent(id: string, message = ""): Promise<AgentRun> {
    const run = this.getRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    if (this.failMessages) throw new Error("Message failed.");
    this.messages.push({ id: run.id, message });
    return run;
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    const run = this.getRun(id);
    if (!run) return undefined;
    const closed: AgentRun = { ...run, state: "closed" };
    this.runs.set(run.id, closed);
    this.store.saveRun(closed);
    return closed;
  }
}

class SaveWorkflowFailureStore extends InMemoryAgentStore {
  override saveWorkflow(workflow: WorkflowRun): void {
    if (workflow.state === "running") throw new Error("Save workflow failed.");
    super.saveWorkflow(workflow);
  }
}

class SaveWorkflowFailureOrchestra extends FakeOrchestra {
  override store = new SaveWorkflowFailureStore();
}

function requireWorkflow(orchestra: FakeOrchestra, id: string): WorkflowRun {
  const workflow = orchestra.store.getWorkflow(id);
  assert.ok(workflow);
  return workflow;
}
