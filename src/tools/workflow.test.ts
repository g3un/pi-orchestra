import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { isTerminalAgentState, slugify } from "../utils.ts";
import { createEvidenceSynthesizerProfile } from "../profiles/evidence-synthesizer.ts";
import { createWorkflowTool } from "./workflow.ts";

const leaderProfile: AgentProfile = {
  name: "leader",
  systemPrompt: "Lead stage members.",
  tools: ["read"],
  model: undefined,
};

const blockedLeaderProfile: AgentProfile = {
  name: "blocked-leader",
  systemPrompt: "Block the workflow.",
  tools: ["read", "bash"],
  model: undefined,
};

const failedLeaderProfile: AgentProfile = {
  name: "failed-leader",
  systemPrompt: "Fail the workflow.",
  tools: ["read", "bash"],
  model: undefined,
};

const hangingLeaderProfile: AgentProfile = {
  name: "hanging-leader",
  systemPrompt: "Wait for workgroup finish.",
  tools: ["workgroup"],
  model: undefined,
};

test("workflow runs linear stages and feeds leader output forward", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "research-flow",
    goal: "Research and analyze the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        leader: { name: "collect-lead", profile: leaderProfile },
      },
      {
        name: "analyze",
        goal: "Analyze collected material.",
        leader: { name: "analyze-lead", profile: leaderProfile },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "research-flow") };

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "success");
  assert.equal(output.workflow.stages.length, 2);
  assert.equal(output.workflow.stages[0]?.state, "success");
  assert.equal(output.workflow.stages[1]?.state, "success");
  assert.equal(output.workflow.result?.leaderRunId, "analyze-lead");
  assert.deepEqual(orchestra.spawned.find((spawn) => spawn.name === "collect-lead")?.profile.tools, ["read"]);
  assert.deepEqual(
    [...orchestra.buses.values()].flatMap((bus) => bus.messages),
    [],
  );
  const collectStage = output.workflow.stages[0];
  assert.ok(collectStage?.workgroupId);
  assert.equal(store.getWorkgroup(collectStage.workgroupId)?.leaderRunId, "collect-lead");
  const analyzeLeaderTask = orchestra.spawned.find((spawn) => spawn.name === "analyze-lead")?.task ?? "";
  assert.match(analyzeLeaderTask, /<stage_output name="collect">/);
  assert.match(analyzeLeaderTask, /collect-lead summary/);
  assert.match(analyzeLeaderTask, /Workgroup id:/);
  assert.match(analyzeLeaderTask, /action=add_members/);
});

test("workflow stage can finish from workgroup final output", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "workgroup-finish-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        leader: { name: "workgroup-finish-lead", profile: hangingLeaderProfile },
      },
    ],
  });

  await eventually(() => store.listWorkgroups().some((workgroup) => workgroup.leaderRunId === "workgroup-finish-lead"));
  const workgroup = store.listWorkgroups().find((current) => current.leaderRunId === "workgroup-finish-lead");
  assert.ok(workgroup);
  store.saveWorkgroup({
    ...workgroup,
    state: "closed",
    result: { status: "success", summary: "Workgroup chose option A.", data: { option: "A" } },
  });

  const output = { workflow: await waitForWorkflow(store, "workgroup-finish-flow") };

  assert.equal(output.workflow.state, "success");
  assert.equal(output.workflow.result?.summary, "Workgroup chose option A.");
  assert.deepEqual(output.workflow.result?.data, { option: "A" });
  assert.equal(orchestra.runs.get("workgroup-finish-lead")?.state, "closed");
});

test("workflow closes workgroup members and bus when the leader finishes first", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "leader-finish-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        leader: { name: "early-lead", profile: hangingLeaderProfile },
      },
    ],
  });

  await eventually(() => store.listWorkgroups().some((workgroup) => workgroup.leaderRunId === "early-lead"));
  const workgroup = store.listWorkgroups().find((current) => current.leaderRunId === "early-lead");
  assert.ok(workgroup);
  const memberRun: AgentRun = {
    id: "slow-member",
    name: "slow-member",
    profile: leaderProfile,
    task: "Slow member work.",
    busId: workgroup.busId,
    sessionFile: ".pi/orchestra/sessions/slow-member.jsonl",
    state: "running",
    result: null,
  };
  orchestra.runs.set(memberRun.id, memberRun);
  store.saveRun(memberRun);
  store.saveWorkgroup({ ...workgroup, memberRunIds: [memberRun.id] });
  const leaderRun = store.getRun("early-lead");
  assert.ok(leaderRun);
  const finishedLeader: AgentRun = {
    ...leaderRun,
    state: "success",
    result: { status: "success", summary: "Leader has enough evidence." },
  };
  orchestra.runs.set(finishedLeader.id, finishedLeader);
  store.saveRun(finishedLeader);

  const output = { workflow: await waitForWorkflow(store, "leader-finish-flow") };
  const closedWorkgroup = store.getWorkgroup(workgroup.id);

  assert.equal(output.workflow.state, "success");
  assert.deepEqual(output.workflow.result?.memberResults, []);
  assert.equal(closedWorkgroup?.state, "closed");
  assert.equal(store.getBus(workgroup.busId)?.state, "closed");
  assert.equal(orchestra.runs.get(memberRun.id)?.state, "closed");
});

test("workflow stage leader decides how to create members", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "compete-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        leader: { name: "compete-lead", profile: leaderProfile },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "compete-flow") };

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "success");
  assert.equal(output.workflow.result?.leaderRunId, "compete-lead");
  assert.deepEqual(output.workflow.result?.memberResults, []);
  assert.equal(orchestra.runs.get("slow-option"), undefined);
  const leaderTask = orchestra.spawned.find((spawn) => spawn.name === "compete-lead")?.task ?? "";
  assert.match(leaderTask, /Decide whether the stage needs competing alternatives/);
  assert.match(leaderTask, /action=add_members/);
  assert.match(leaderTask, /action=finish once/);
});

test("workflow stage blocks when the leader blocks", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "blocked-compete-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        leader: { name: "blocked-compete-lead", profile: blockedLeaderProfile },
      },
      {
        name: "never",
        goal: "Should not run.",
        leader: { name: "never-blocked-compete-lead", profile: leaderProfile },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "blocked-compete-flow") };

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "blocked");
  assert.equal(output.workflow.result?.status, "blocked");
  assert.equal(output.workflow.stages[0]?.state, "blocked");
  assert.equal(output.workflow.stages[1]?.state, "idle");
  assert.equal(
    orchestra.spawned.some((spawn) => spawn.name === "never-after-blocked-compete"),
    false,
  );
});

test("workflow stage fails when the leader fails", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "failed-compete-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        leader: { name: "failed-compete-lead", profile: failedLeaderProfile },
      },
      {
        name: "never",
        goal: "Should not run.",
        leader: { name: "never-failed-compete-lead", profile: leaderProfile },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "failed-compete-flow") };

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "failed");
  assert.equal(output.workflow.result?.status, "failed");
  assert.equal(output.workflow.stages[0]?.state, "failed");
  assert.equal(output.workflow.stages[1]?.state, "idle");
  assert.equal(
    orchestra.spawned.some((spawn) => spawn.name === "never-after-failed-compete"),
    false,
  );
});

test("workflow status returns the latest workflow by name", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "status-flow",
    goal: "Research the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        leader: { name: "status-lead", profile: leaderProfile },
      },
    ],
  });
  await waitForWorkflow(store, "status-flow");

  const output = await workflowTool.execute({ action: "status", id: "status-flow" });

  assert.equal(output.workflow?.state, "success");
  assert.match(output.message, /Workflow status-flow is success\./);
  assert.match(output.message, /- collect: success/);
});

test("workflow start validates unique stage names and required leaders", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "start",
        name: "duplicate-stage-flow",
        goal: "Research the topic.",
        stages: [
          {
            name: "collect",
            goal: "Collect source material.",
            leader: { profile: leaderProfile, name: "collect-lead" },
          },
          {
            name: "collect",
            goal: "Collect more material.",
            leader: { profile: leaderProfile, name: "collect-lead-2" },
          },
        ],
      }),
    /Workflow stage name "collect" is already in use\./,
  );

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "start",
        name: "duplicate-leader-flow",
        goal: "Research the topic.",
        stages: [
          {
            name: "collect",
            goal: "Collect source material.",
            leader: { profile: leaderProfile, name: "same-lead" },
          },
          {
            name: "analyze",
            goal: "Analyze source material.",
            leader: { profile: leaderProfile, name: "same-lead" },
          },
        ],
      }),
    /Workflow leader name "same-lead" is already in use\./,
  );

  store.saveRun({
    id: "existing-lead",
    name: "existing-lead",
    profile: leaderProfile,
    task: "Existing work.",
    busId: "bus-1",
    sessionFile: ".pi/orchestra/sessions/existing-lead.jsonl",
    state: "running",
    result: null,
  });
  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "start",
        name: "existing-leader-flow",
        goal: "Research the topic.",
        stages: [
          {
            name: "collect",
            goal: "Collect source material.",
            leader: { profile: leaderProfile, name: "existing-lead" },
          },
        ],
      }),
    /Workflow leader name "existing-lead" is already in use\./,
  );

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "start",
        name: "missing-leader-flow",
        goal: "Research the topic.",
        stages: [
          {
            name: "collect",
            goal: "Collect source material.",
          } as never,
        ],
      }),
    /workflow stage collect requires a leader\./,
  );
});

test("workflow runs an explicitly provided evidence synthesizer leader", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "synth-leader-flow",
    goal: "Research the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        leader: {
          name: "collect-synth",
          profile: createEvidenceSynthesizerProfile({ name: undefined, tools: ["read", "bash"], model: undefined }),
        },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "synth-leader-flow") };
  const leaderSpawn = orchestra.spawned.find((spawn) => spawn.name === "collect-synth");

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "success");
  assert.equal(output.workflow.result?.leaderRunId, "collect-synth");
  assert.ok(leaderSpawn);
  assert.equal(leaderSpawn.profile.name, "evidence-synthesizer");
  assert.deepEqual(leaderSpawn.profile.tools, ["read", "bash"]);
});

test("workflow status and cancel report missing workflows", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  const statusOutput = await workflowTool.execute({ action: "status", id: "missing-flow" });
  const cancelOutput = await workflowTool.execute({ action: "cancel", id: "missing-flow" });

  assert.equal(statusOutput.workflow, undefined);
  assert.equal(statusOutput.message, "Workflow missing-flow not found.");
  assert.equal(cancelOutput.workflow, undefined);
  assert.equal(cancelOutput.message, "Workflow missing-flow not found.");
});

test("workflow cancel closes leaders spawned during cancellation race", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });
  const delayedSpawn = orchestra.delaySpawn("cancel-lead");

  await workflowTool.execute({
    action: "start",
    name: "cancel-flow",
    goal: "Research the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        leader: { name: "cancel-lead", profile: leaderProfile },
      },
    ],
  });

  await delayedSpawn.started;
  const cancelOutput = await workflowTool.execute({ action: "cancel", id: "cancel-flow" });
  delayedSpawn.release();
  await eventually(() => orchestra.runs.get("cancel-lead")?.state === "closed");

  assert.equal(cancelOutput.workflow?.state, "closed");
  assert.equal(store.getWorkflow("cancel-flow")?.state, "closed");
  assert.equal(orchestra.runs.get("cancel-lead")?.state, "closed");
});

test("workflow fails when a stage synthesizer fails", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "failed-flow",
    goal: "Research and analyze the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        leader: { name: "failed-lead", profile: failedLeaderProfile },
      },
      {
        name: "analyze",
        goal: "Analyze collected material.",
        leader: { name: "never-failed-lead", profile: leaderProfile },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "failed-flow") };

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "failed");
  assert.equal(output.workflow.result?.status, "failed");
  assert.equal(output.workflow.stages[0]?.state, "failed");
  assert.equal(output.workflow.stages[1]?.state, "idle");
  assert.equal(
    orchestra.spawned.some((spawn) => spawn.name === "never-failed-lead"),
    false,
  );
});

test("workflow stops when a stage synthesizer blocks", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra(store);
  const workflowTool = createWorkflowTool({ orchestra, store });

  await workflowTool.execute({
    action: "start",
    name: "blocked-flow",
    goal: "Research and analyze the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        leader: { name: "blocked-lead", profile: blockedLeaderProfile },
      },
      {
        name: "analyze",
        goal: "Analyze collected material.",
        leader: { name: "never-lead", profile: leaderProfile },
      },
    ],
  });

  const output = { workflow: await waitForWorkflow(store, "blocked-flow") };

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "blocked");
  assert.equal(output.workflow.result?.status, "blocked");
  assert.equal(output.workflow.stages[0]?.state, "blocked");
  assert.equal(output.workflow.stages[0]?.output?.status, "blocked");
  assert.equal(output.workflow.stages[1]?.state, "idle");
  assert.equal(
    orchestra.spawned.some((spawn) => spawn.name === "never-lead"),
    false,
  );
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  spawned: Array<{ profile: AgentProfile; task: string; busId: string; name: string }> = [];
  private readonly spawnDelays = new Map<string, SpawnDelay>();

  constructor(private readonly store: InMemoryAgentStore) {}

  delaySpawn(name: string): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.spawnDelays.set(name, { markStarted, released });
    return { started, release };
  }

  createBus(options: { name: string | undefined }): Bus {
    const id = slugify(options.name ?? `bus-${this.buses.size + 1}`);
    const bus: Bus = { id, name: options.name ?? id, state: "open", messages: [] };
    this.buses.set(bus.id, bus);
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

    const name = options.name ?? profile.name;
    const delay = this.spawnDelays.get(name);
    if (delay) {
      delay.markStarted();
      await delay.released;
      this.spawnDelays.delete(name);
    }

    this.spawned.push({ profile, task, busId: bus.id, name });
    const resultStatus = profile.name.includes("blocked")
      ? "blocked"
      : profile.name.includes("failed")
        ? "failed"
        : "success";
    const run: AgentRun = profile.name.includes("hanging")
      ? {
          id: name,
          name,
          profile,
          task,
          busId: bus.id,
          state: "running",
          sessionFile: `.pi/orchestra/sessions/${name}.jsonl`,
          result: null,
        }
      : {
          id: name,
          name,
          profile,
          task,
          busId: bus.id,
          state: resultStatus,
          sessionFile: `.pi/orchestra/sessions/${name}.jsonl`,
          result: {
            status: resultStatus,
            summary: `${name} summary`,
          },
        };
    this.runs.set(run.id, run);
    this.store.saveRun(run);
    return run;
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
    this.store.saveRun(closedRun);
    return closedRun;
  }
}

interface SpawnDelay {
  markStarted(): void;
  released: Promise<void>;
}

async function waitForWorkflow(
  store: InMemoryAgentStore,
  id: string,
): Promise<NonNullable<ReturnType<InMemoryAgentStore["getWorkflow"]>>> {
  await eventually(() => {
    const workflow = store.getWorkflow(id);
    return workflow !== undefined && isTerminalAgentState(workflow.state);
  });
  const workflow = store.getWorkflow(id);
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
