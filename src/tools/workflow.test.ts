import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type {
  OrchestraApi,
  PublishedBusMessage,
  WaitBusSettledOptions,
  WaitBusSettledResult,
  WaitNextRunOptions,
  WaitNextRunResult,
} from "../core/orchestra.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { isTerminalAgentState, slugify, toWaitRunResult } from "../utils.ts";
import { createWaitWorkflowTool } from "./wait-workflow.ts";
import { createWorkflowTool } from "./workflow.ts";

const workerProfile: AgentProfile = {
  name: "worker",
  systemPrompt: "Do worker tasks.",
};

const leaderProfile: AgentProfile = {
  name: "leader",
  systemPrompt: "Synthesize worker output.",
  tools: ["read"],
};

const blockedWorkerProfile: AgentProfile = {
  name: "blocked-worker-profile",
  systemPrompt: "Block the worker task.",
};

const failedWorkerProfile: AgentProfile = {
  name: "failed-worker-profile",
  systemPrompt: "Fail the worker task.",
};

const hangingWorkerProfile: AgentProfile = {
  name: "hanging-worker-profile",
  systemPrompt: "Keep working until cancelled.",
};

const blockedLeaderProfile: AgentProfile = {
  name: "blocked-leader",
  systemPrompt: "Block the workflow.",
};

const failedLeaderProfile: AgentProfile = {
  name: "failed-leader",
  systemPrompt: "Fail the workflow.",
};

test("workflow runs linear stages and feeds leader output forward", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "research-flow",
    goal: "Research and analyze the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        strategy: "synthesize",
        members: [{ name: "collect-worker", profile: workerProfile }],
        leader: { name: "collect-lead", profile: leaderProfile },
      },
      {
        name: "analyze",
        goal: "Analyze collected material.",
        strategy: "synthesize",
        members: [{ name: "analyze-worker", profile: workerProfile }],
        leader: { name: "analyze-lead", profile: leaderProfile },
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "research-flow", timeoutMs: null });

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "success");
  assert.equal(output.workflow.stages.length, 2);
  assert.equal(output.workflow.stages[0]?.state, "success");
  assert.equal(output.workflow.stages[1]?.state, "success");
  assert.equal(output.workflow.result?.leaderRunId, "analyze-lead");
  assert.deepEqual(orchestra.spawned.find((spawn) => spawn.name === "collect-lead")?.profile.tools, []);
  assert.deepEqual(
    [...orchestra.buses.values()].flatMap((bus) => bus.messages),
    [],
  );
  assert.match(orchestra.spawned.find((spawn) => spawn.name === "analyze-worker")?.task ?? "", /Stage collect output:/);
  assert.match(orchestra.spawned.find((spawn) => spawn.name === "analyze-worker")?.task ?? "", /collect-lead summary/);
  const analyzeLeaderTask = orchestra.spawned.find((spawn) => spawn.name === "analyze-lead")?.task ?? "";
  assert.match(analyzeLeaderTask, /Stage collect:/);
  assert.match(analyzeLeaderTask, /collect-lead summary/);
  assert.match(analyzeLeaderTask, /bus reference context as stage deliberation evidence/);
  assert.match(analyzeLeaderTask, /explicitly note unresolved gaps/);
});

test("workflow compete stage races to first success then uses a leader", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "compete-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        strategy: "compete",
        members: [
          { name: "option-worker", profile: workerProfile },
          { name: "slow-option", profile: hangingWorkerProfile },
        ],
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "compete-flow", timeoutMs: null });

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "success");
  assert.equal(output.workflow.result?.leaderRunId, "compete-flow-options-leader");
  assert.equal(output.workflow.result?.workerResults[0]?.runId, "option-worker");
  assert.equal(orchestra.runs.get("slow-option")?.state, "closed");
  const leaderTask = orchestra.spawned.find((spawn) => spawn.name === "compete-flow-options-leader")?.task ?? "";
  assert.match(leaderTask, /This stage uses the compete strategy/);
  assert.match(leaderTask, /Condense the winning result into a concise canonical stage output/);
  assert.match(leaderTask, /drop verbose detail and redundancy/);
  assert.match(leaderTask, /Call finish exactly once when done/);
  assert.match(leaderTask, /option-worker summary/);
});

test("workflow compete stage blocks when no worker succeeds and one blocks", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "blocked-compete-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        strategy: "compete",
        members: [
          { name: "blocked-option", profile: blockedWorkerProfile },
          { name: "failed-option", profile: failedWorkerProfile },
        ],
      },
      {
        name: "never",
        goal: "Should not run.",
        strategy: "compete",
        members: [{ name: "never-after-blocked-compete", profile: workerProfile }],
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "blocked-compete-flow", timeoutMs: null });

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

test("workflow compete stage fails when every worker fails", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "failed-compete-flow",
    goal: "Generate alternatives.",
    stages: [
      {
        name: "options",
        goal: "Produce independent options.",
        strategy: "compete",
        members: [{ name: "failed-only-option", profile: failedWorkerProfile }],
      },
      {
        name: "never",
        goal: "Should not run.",
        strategy: "compete",
        members: [{ name: "never-after-failed-compete", profile: workerProfile }],
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "failed-compete-flow", timeoutMs: null });

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
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "status-flow",
    goal: "Research the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        strategy: "synthesize",
        members: [{ name: "status-worker", profile: workerProfile }],
      },
    ],
  });
  await waitWorkflowTool.execute({ id: "status-flow", timeoutMs: null });

  const output = await workflowTool.execute({ action: "status", id: "status-flow" });

  assert.equal(output.workflow?.state, "success");
  assert.match(output.message, /Workflow status-flow is success\./);
  assert.match(output.message, /- collect: success/);
});

test("workflow start validates unique stage names and non-empty members", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
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
            strategy: "synthesize",
            members: [{ profile: workerProfile }],
          },
          {
            name: "collect",
            goal: "Collect more material.",
            strategy: "synthesize",
            members: [{ profile: workerProfile }],
          },
        ],
      }),
    /Workflow stage name "collect" is already in use\./,
  );

  await assert.rejects(
    () =>
      workflowTool.execute({
        action: "start",
        name: "empty-members-flow",
        goal: "Research the topic.",
        stages: [{ name: "collect", goal: "Collect source material.", strategy: "synthesize", members: [] }],
      }),
    /Workflow stage "collect" requires at least one member\./,
  );
});

test("workflow uses a default restricted leader when omitted", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "default-leader-flow",
    goal: "Research the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        strategy: "synthesize",
        members: [{ name: "default-worker", profile: workerProfile }],
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "default-leader-flow", timeoutMs: null });
  const leaderSpawn = orchestra.spawned.find((spawn) => spawn.name === "default-leader-flow-collect-leader");

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "success");
  assert.ok(leaderSpawn);
  assert.deepEqual(leaderSpawn.profile.tools, []);
  assert.match(leaderSpawn.profile.systemPrompt, /Do not perform new research/);
  assert.match(leaderSpawn.profile.systemPrompt, /bus reference context as stage deliberation evidence/);
  assert.match(leaderSpawn.profile.systemPrompt, /explicitly note unresolved gaps/);
});

test("workflow status and cancel report missing workflows", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });

  const statusOutput = await workflowTool.execute({ action: "status", id: "missing-flow" });
  const cancelOutput = await workflowTool.execute({ action: "cancel", id: "missing-flow" });

  assert.equal(statusOutput.workflow, undefined);
  assert.equal(statusOutput.message, "Workflow missing-flow not found.");
  assert.equal(cancelOutput.workflow, undefined);
  assert.equal(cancelOutput.message, "Workflow missing-flow not found.");
});

test("workflow cancel closes workers spawned during cancellation race", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const delayedSpawn = orchestra.delaySpawn("slow-worker");

  await workflowTool.execute({
    action: "start",
    name: "cancel-flow",
    goal: "Research the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        strategy: "compete",
        members: [{ name: "slow-worker", profile: workerProfile }],
      },
    ],
  });

  await delayedSpawn.started;
  const cancelOutput = await workflowTool.execute({ action: "cancel", id: "cancel-flow" });
  delayedSpawn.release();
  await eventually(() => orchestra.runs.get("slow-worker")?.state === "closed");

  assert.equal(cancelOutput.workflow?.state, "closed");
  assert.equal(store.getWorkflow("cancel-flow")?.state, "closed");
  assert.equal(orchestra.runs.get("slow-worker")?.state, "closed");
});

test("workflow fails when a stage leader fails", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "failed-flow",
    goal: "Research and analyze the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        strategy: "synthesize",
        members: [{ name: "failed-worker", profile: workerProfile }],
        leader: { name: "failed-lead", profile: failedLeaderProfile },
      },
      {
        name: "analyze",
        goal: "Analyze collected material.",
        strategy: "synthesize",
        members: [{ name: "never-failed-worker", profile: workerProfile }],
        leader: { name: "never-failed-lead", profile: leaderProfile },
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "failed-flow", timeoutMs: null });

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "failed");
  assert.equal(output.workflow.result?.status, "failed");
  assert.equal(output.workflow.stages[0]?.state, "failed");
  assert.equal(output.workflow.stages[1]?.state, "idle");
  assert.equal(
    orchestra.spawned.some((spawn) => spawn.name === "never-failed-worker"),
    false,
  );
});

test("workflow stops when a stage leader blocks", async () => {
  const store = new InMemoryAgentStore();
  const orchestra = new FakeOrchestra();
  const workflowTool = createWorkflowTool({ orchestra, store });
  const waitWorkflowTool = createWaitWorkflowTool({ store });

  await workflowTool.execute({
    action: "start",
    name: "blocked-flow",
    goal: "Research and analyze the topic.",
    stages: [
      {
        name: "collect",
        goal: "Collect source material.",
        strategy: "synthesize",
        members: [{ name: "blocked-worker", profile: workerProfile }],
        leader: { name: "blocked-lead", profile: blockedLeaderProfile },
      },
      {
        name: "analyze",
        goal: "Analyze collected material.",
        strategy: "synthesize",
        members: [{ name: "never-worker", profile: workerProfile }],
        leader: { name: "never-lead", profile: leaderProfile },
      },
    ],
  });

  const output = await waitWorkflowTool.execute({ id: "blocked-flow", timeoutMs: null });

  assert.ok(output.workflow);
  assert.equal(output.workflow.state, "blocked");
  assert.equal(output.workflow.result?.status, "blocked");
  assert.equal(output.workflow.stages[0]?.state, "blocked");
  assert.equal(output.workflow.stages[0]?.output?.status, "blocked");
  assert.equal(output.workflow.stages[1]?.state, "idle");
  assert.equal(
    orchestra.spawned.some((spawn) => spawn.name === "never-worker"),
    false,
  );
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  spawned: Array<{ profile: AgentProfile; task: string; busId: string; name: string }> = [];
  private readonly spawnDelays = new Map<string, SpawnDelay>();

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

  createBus(options: { name?: string } = {}): Bus {
    const id = slugify(options.name ?? `bus-${this.buses.size + 1}`);
    const bus: Bus = { id, name: options.name ?? id, messages: [] };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id) ?? [...this.buses.values()].find((bus) => bus.name === id);
  }

  async publishBus(id: string, message: string, from = "main"): Promise<PublishedBusMessage> {
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
    options: { name?: string } = {},
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
          profile: profile.name,
          task,
          busId: bus.id,
          state: "idle",
        }
      : {
          id: name,
          name,
          profile: profile.name,
          task,
          busId: bus.id,
          state: resultStatus,
          result: {
            status: resultStatus,
            summary: `${name} summary`,
          },
        };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId?: string } = {}): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async messageAgent(id: string, _message: string): Promise<AgentRun> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;

    const closedRun = { ...run, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
  }

  waitBusSettled(busId: string, _options: WaitBusSettledOptions = {}): Promise<WaitBusSettledResult> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    const runs = this.listRuns({ busId: bus.id });
    return Promise.resolve({
      bus,
      runs,
      runResults: runs.map(toWaitRunResult),
      timedOut: false,
      pendingRunIds: [],
    });
  }

  waitNextRun(busId: string, options: WaitNextRunOptions = {}): Promise<WaitNextRunResult> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);

    const runs = this.listRuns({ busId: bus.id });
    const excludedRunIds = new Set(options.excludeRunIds ?? []);
    const run = runs.find(
      (current) =>
        !excludedRunIds.has(current.id) && !excludedRunIds.has(current.name) && isTerminalAgentState(current.state),
    );
    return Promise.resolve({
      bus,
      run,
      runResult: run ? toWaitRunResult(run) : undefined,
      runs,
      runResults: runs.map(toWaitRunResult),
      timedOut: false,
      pendingRunIds: runs
        .filter((current) => !excludedRunIds.has(current.id) && !isTerminalAgentState(current.state))
        .map((current) => current.id),
    });
  }
}

interface SpawnDelay {
  markStarted(): void;
  released: Promise<void>;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(predicate());
}
