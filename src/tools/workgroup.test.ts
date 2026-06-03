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
import { isTerminalAgentState, slugify, toWaitRunResult } from "../utils.ts";
import { createWorkgroupTool, settleWorkgroupRuns } from "./workgroup.ts";

const securityProfile: AgentProfile = {
  name: "security",
  systemPrompt: "Review security risks.",
};

const backendProfile: AgentProfile = {
  name: "backend",
  systemPrompt: "Review backend design.",
};

const brokenProfile: AgentProfile = {
  name: "broken",
  systemPrompt: "Fail during spawn.",
};

test("workgroup launches members on an existing bus", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "auth-work" });

  const output = await tool.execute({
    busId: bus.name,
    goal: "Plan the auth refactor.",
    strategy: "synthesize",
    members: [
      { name: "security-review", profile: securityProfile, assignment: "Identify auth security risks." },
      { name: "backend-review", profile: backendProfile, assignment: "Assess API and data model changes." },
    ],
  });

  assert.equal(output.bus, bus);
  assert.equal(output.runs.length, 2);
  assert.deepEqual(
    orchestra.spawned.map((spawn) => ({ profile: spawn.profile, busId: spawn.busId, name: spawn.options?.name })),
    [
      { profile: securityProfile, busId: bus.id, name: "security-review" },
      { profile: backendProfile, busId: bus.id, name: "backend-review" },
    ],
  );
  assert.match(orchestra.spawned[0]?.task ?? "", /Workgroup strategy: synthesize/);
  assert.match(orchestra.spawned[0]?.task ?? "", /Shared goal:\nPlan the auth refactor\./);
  assert.match(orchestra.spawned[0]?.task ?? "", /Identify auth security risks\./);
  assert.match(
    orchestra.spawned[0]?.task ?? "",
    /publish_bus is for sibling reference data, not for requesting leader action/,
  );
  assert.match(orchestra.spawned[0]?.task ?? "", /finish with status blocked/);
  assert.match(orchestra.spawned[0]?.task ?? "", /Synthesize strategy guidelines/);
  assert.equal(
    output.message,
    [
      "Launched synthesize workgroup on bus auth-work with 2 run(s).",
      "",
      "Runs:",
      "- security-review: idle",
      "- backend-review: idle",
      "",
      "Use bus action=wait_next to handle member results as they finish, or bus action=wait_settled for full fan-in.",
    ].join("\n"),
  );
});

test("workgroup compete strategy guides members to share facts without herding", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "design-compete" });

  await tool.execute({
    busId: bus.id,
    goal: "Compare implementation options.",
    strategy: "compete",
    members: [{ name: "option-a", profile: backendProfile }],
  });

  const task = orchestra.spawned[0]?.task ?? "";
  assert.match(
    task,
    /Use publish_bus only for facts, evidence, dead ends, constraints, or blockers that may help sibling agents/,
  );
  assert.match(task, /Keep your conclusions and recommendations private until finish/);
  assert.match(task, /Treat sibling bus messages as claims to verify, challenge, or refute/);
});

test("workgroup generates unique member names from duplicate profile names", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "backend-work" });

  const output = await tool.execute({
    busId: bus.id,
    goal: "Review backend changes.",
    strategy: "synthesize",
    members: [{ profile: backendProfile }, { profile: backendProfile }],
  });

  assert.deepEqual(
    output.runs.map((run) => run.name),
    ["backend", "backend-2"],
  );
  assert.deepEqual(
    orchestra.spawned.map((spawn) => spawn.options?.name),
    ["backend", "backend-2"],
  );
});

test("workgroup rejects missing buses", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });

  await assert.rejects(
    () =>
      tool.execute({
        busId: "missing",
        goal: "Plan the auth refactor.",
        strategy: "compete",
        members: [{ profile: securityProfile }],
      }),
    /Bus missing not found\./,
  );
});

test("workgroup member name checks are global", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const targetBus = orchestra.createBus({ name: "target-work" });
  const otherBus = orchestra.createBus({ name: "other-work" });
  orchestra.runs.set("security-review", {
    id: "security-review",
    name: "security-review",
    profile: "security",
    task: "Existing work.",
    busId: otherBus.id,
    state: "idle",
  });

  await assert.rejects(
    () =>
      tool.execute({
        busId: targetBus.id,
        goal: "Plan the auth refactor.",
        strategy: "compete",
        members: [{ name: "security-review", profile: securityProfile }],
      }),
    /Workgroup member name "security-review" is already in use\./,
  );
});

test("workgroup compete settlement closes pending runs after first success", async () => {
  const orchestra = new FakeOrchestra();
  const bus = orchestra.createBus({ name: "compete-work" });
  const winner = run({
    id: "winner",
    name: "winner",
    busId: bus.id,
    state: "success",
    result: { status: "success", summary: "Found input." },
  });
  const pending = run({ id: "pending", name: "pending", busId: bus.id, state: "idle" });
  orchestra.runs.set(winner.id, winner);
  orchestra.runs.set(pending.id, pending);

  const output = await settleWorkgroupRuns(orchestra, bus.id, "compete");

  assert.equal(output.status, "success");
  assert.equal(output.winner?.runId, winner.id);
  assert.deepEqual(
    output.workerResults.map((result) => result.runId),
    [winner.id],
  );
  assert.deepEqual(orchestra.closedIds, [pending.id]);
  assert.equal(orchestra.runs.get(pending.id)?.state, "closed");
});

test("workgroup compete settlement keeps waiting after blocked results until success", async () => {
  const orchestra = new FakeOrchestra();
  const bus = orchestra.createBus({ name: "blocked-then-success" });
  const blocked = run({
    id: "blocked",
    name: "blocked",
    busId: bus.id,
    state: "blocked",
    result: { status: "blocked", summary: "Need input." },
  });
  const winner = run({
    id: "winner",
    name: "winner",
    busId: bus.id,
    state: "success",
    result: { status: "success", summary: "Solved." },
  });
  const pending = run({ id: "pending", name: "pending", busId: bus.id, state: "idle" });
  orchestra.runs.set(blocked.id, blocked);
  orchestra.runs.set(winner.id, winner);
  orchestra.runs.set(pending.id, pending);

  const output = await settleWorkgroupRuns(orchestra, bus.id, "compete");

  assert.equal(output.status, "success");
  assert.equal(output.winner?.runId, winner.id);
  assert.deepEqual(
    output.completedResults.map((result) => result.runId),
    [blocked.id, winner.id],
  );
  assert.deepEqual(
    output.workerResults.map((result) => result.runId),
    [winner.id],
  );
  assert.deepEqual(orchestra.closedIds, [pending.id]);
});

test("workgroup synthesize settlement waits for every run", async () => {
  const orchestra = new FakeOrchestra();
  const bus = orchestra.createBus({ name: "synthesize-work" });
  const first = run({
    id: "first",
    name: "first",
    busId: bus.id,
    state: "success",
    result: { status: "success", summary: "First." },
  });
  const second = run({
    id: "second",
    name: "second",
    busId: bus.id,
    state: "failed",
    result: { status: "failed", summary: "Second." },
  });
  orchestra.runs.set(first.id, first);
  orchestra.runs.set(second.id, second);

  const output = await settleWorkgroupRuns(orchestra, bus.id, "synthesize");

  assert.equal(output.status, "success");
  assert.deepEqual(
    output.workerResults.map((result) => result.runId),
    [first.id, second.id],
  );
  assert.deepEqual(orchestra.closedIds, []);
});

test("workgroup synthesize settlement reports blocked when no run succeeds", async () => {
  const orchestra = new FakeOrchestra();
  const bus = orchestra.createBus({ name: "blocked-synthesize" });
  const blocked = run({
    id: "blocked",
    name: "blocked",
    busId: bus.id,
    state: "blocked",
    result: { status: "blocked", summary: "Need decision." },
  });
  const failed = run({
    id: "failed",
    name: "failed",
    busId: bus.id,
    state: "failed",
    result: { status: "failed", summary: "Could not finish." },
  });
  orchestra.runs.set(blocked.id, blocked);
  orchestra.runs.set(failed.id, failed);

  const output = await settleWorkgroupRuns(orchestra, bus.id, "synthesize");

  assert.equal(output.status, "blocked");
  assert.deepEqual(
    output.workerResults.map((result) => result.runId),
    [blocked.id, failed.id],
  );
});

test("workgroup closes successfully spawned members when launch is incomplete", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "auth-work" });

  await assert.rejects(
    () =>
      tool.execute({
        busId: bus.id,
        goal: "Plan the auth refactor.",
        strategy: "synthesize",
        members: [
          { name: "security-review", profile: securityProfile },
          { name: "broken-review", profile: brokenProfile },
        ],
      }),
    /Failed to launch every workgroup member\./,
  );

  assert.deepEqual(orchestra.closedIds, ["security-review"]);
  assert.equal(orchestra.runs.get("security-review")?.state, "closed");
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  spawned: Array<{ profile: AgentProfile; task: string; busId: string; options?: { name?: string } }> = [];
  closedIds: string[] = [];

  createBus(options: { name?: string } = {}): Bus {
    const id = options.name ?? `bus-${this.buses.size + 1}`;
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
    if (profile.name === "broken") throw new Error("Spawn failed.");

    this.spawned.push({ profile, task, busId: bus.id, options });
    const name = options.name ?? profile.name;
    const id = slugify(name);
    const run: AgentRun = {
      id,
      name,
      profile: profile.name,
      task,
      busId: bus.id,
      state: "idle",
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
    this.closedIds.push(id);
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
      pendingRunIds: runs.filter((current) => !isTerminalAgentState(current.state)).map((current) => current.id),
    });
  }

  waitNextRun(busId: string, options: WaitNextRunOptions = {}): Promise<WaitNextRunResult> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);

    const excludedRunIds = new Set(options.excludeRunIds ?? []);
    const runs = this.listRuns({ busId: bus.id });
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

function run(overrides: Partial<AgentRun>): AgentRun {
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
