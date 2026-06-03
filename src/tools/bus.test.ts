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
import { toWaitRunResult } from "../utils.ts";
import { createBusTool } from "./bus.ts";

test("bus create allocates a standalone bus through orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });

  const output = await tool.execute({ action: "create" });

  assert.ok(output.bus);
  assert.equal(output.bus.id, "bus-1");
  assert.deepEqual(output.bus.messages, []);
  assert.equal(orchestra.getBus(output.bus.id), output.bus);
  assert.equal(output.message, "Created bus bus-1.");
});

test("bus status returns stored bus messages", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    messages: [{ id: "message-1", from: "main", message: "Initial context." }],
  };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "status", id: bus.id });
  const missingOutput = await tool.execute({ action: "status", id: "missing" });

  assert.equal(output.bus, bus);
  assert.equal(
    output.message,
    ["Bus bus-1 has 1 message(s).", "", "Messages:", "- message-1 from main:", "Initial context."].join("\n"),
  );
  assert.equal(missingOutput.bus, undefined);
  assert.equal(missingOutput.message, "Bus missing not found.");
});

test("bus publish delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus: Bus = { id: "bus-1", name: "bus-1", messages: [] };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "publish", id: bus.id, message: "New constraint." });

  assert.deepEqual(orchestra.published, {
    id: bus.id,
    message: "New constraint.",
    from: "main",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", message: "New constraint.", from: "main" });
  assert.deepEqual(orchestra.getBus(bus.id)?.messages, [{ id: "message-1", message: "New constraint.", from: "main" }]);
  assert.equal(output.message, "Published message to bus bus-1.\n\nMessages:\n- message-1 from main:\nNew constraint.");
});

test("bus publish preserves an explicit sender", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus: Bus = { id: "bus-1", name: "bus-1", messages: [] };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "publish", id: bus.id, message: "Peer context.", from: "agent-1" });

  assert.deepEqual(orchestra.published, {
    id: bus.id,
    message: "Peer context.",
    from: "agent-1",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", message: "Peer context.", from: "agent-1" });
});

test("bus wait_settled delegates to orchestra and formats terminal bus runs", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus = orchestra.createBus();
  const runs = [
    run({ id: "agent-1", busId: bus.id, state: "success", result: { status: "success", summary: "Done." } }),
    run({ id: "agent-2", busId: bus.id, state: "blocked", result: { status: "blocked", summary: "Needs input." } }),
    run({ id: "agent-3", busId: bus.id, state: "failed", result: { status: "failed", summary: "Failed." } }),
  ];
  for (const current of runs) orchestra.runs.set(current.id, current);

  const output = await tool.execute({ action: "wait_settled", id: bus.id, timeoutMs: 1000 });

  assert.deepEqual(orchestra.waitedSettled, { busId: bus.id, options: { timeoutMs: 1000 } });
  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, runs);
  assert.deepEqual(output.runResults, runs.map(toWaitRunResult));
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
  assert.equal(
    output.message,
    [
      `All 3 run(s) attached to bus ${bus.id} reached terminal state.`,
      "",
      "Runs:",
      "- agent-1: success result=success summary=Done.",
      "- agent-2: blocked result=blocked summary=Needs input.",
      "- agent-3: failed result=failed summary=Failed.",
    ].join("\n"),
  );
});

test("bus wait_settled formats timeout partial results", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus = orchestra.createBus();
  const idleRun = run({ id: "agent-1", busId: bus.id, state: "idle" });
  orchestra.runs.set(idleRun.id, idleRun);
  orchestra.nextSettledResult = {
    bus,
    runs: [idleRun],
    runResults: [toWaitRunResult(idleRun)],
    timedOut: true,
    pendingRunIds: [idleRun.id],
  };

  const output = await tool.execute({ action: "wait_settled", id: bus.id, timeoutMs: 1000 });

  assert.equal(output.timedOut, true);
  assert.deepEqual(output.runResults, [toWaitRunResult(idleRun)]);
  assert.deepEqual(output.pendingRunIds, [idleRun.id]);
  assert.equal(
    output.message,
    [`Timed out waiting for bus ${bus.id} to settle; 1 run(s) still pending.`, "", "Runs:", "- agent-1: idle"].join(
      "\n",
    ),
  );
});

test("bus wait_next delegates to orchestra and formats the terminal run", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus = orchestra.createBus();
  const completedRun = run({
    id: "agent-1",
    busId: bus.id,
    state: "success",
    result: { status: "success", summary: "Found a plan." },
  });
  orchestra.runs.set(completedRun.id, completedRun);
  orchestra.nextRunResult = {
    bus,
    run: completedRun,
    runResult: toWaitRunResult(completedRun),
    runs: [completedRun],
    runResults: [toWaitRunResult(completedRun)],
    timedOut: false,
    pendingRunIds: [],
  };

  const output = await tool.execute({
    action: "wait_next",
    id: bus.id,
    excludeRunIds: ["already-handled"],
    timeoutMs: 1000,
  });

  assert.deepEqual(orchestra.waitedNext, {
    busId: bus.id,
    options: { excludeRunIds: ["already-handled"], timeoutMs: 1000 },
  });
  assert.equal(output.run, completedRun);
  assert.deepEqual(output.runResult, toWaitRunResult(completedRun));
  assert.equal(
    output.message,
    [`Next terminal run on bus ${bus.id}: agent-1 is success.`, "", "Result: success", "Found a plan."].join("\n"),
  );
});

test("bus wait_next formats terminal runs without result payloads", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus = orchestra.createBus();
  const closedRun = run({ id: "agent-1", busId: bus.id, state: "closed" });
  orchestra.nextRunResult = {
    bus,
    run: closedRun,
    runResult: toWaitRunResult(closedRun),
    runs: [closedRun],
    runResults: [toWaitRunResult(closedRun)],
    timedOut: false,
    pendingRunIds: [],
  };

  const output = await tool.execute({ action: "wait_next", id: bus.id });

  assert.equal(
    output.message,
    [`Next terminal run on bus ${bus.id}: agent-1 is closed.`, "", "No result payload recorded."].join("\n"),
  );
});

test("bus wait_next formats timeout without a terminal run", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createBusTool({ orchestra });
  const bus = orchestra.createBus();
  const idleRun = run({ id: "agent-1", busId: bus.id, state: "idle" });
  orchestra.runs.set(idleRun.id, idleRun);
  orchestra.nextRunResult = {
    bus,
    runs: [idleRun],
    runResults: [toWaitRunResult(idleRun)],
    timedOut: true,
    pendingRunIds: [idleRun.id],
  };

  const output = await tool.execute({ action: "wait_next", id: bus.id, timeoutMs: 1000 });

  assert.equal(output.run, undefined);
  assert.equal(output.timedOut, true);
  assert.equal(output.message, `Timed out waiting for the next run on bus ${bus.id}; 1 run(s) still pending.`);
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  published?: { id: string; message: string; from: string };
  waitedSettled?: { busId: string; options: WaitBusSettledOptions };
  waitedNext?: { busId: string; options: WaitNextRunOptions };
  nextSettledResult?: WaitBusSettledResult;
  nextRunResult?: WaitNextRunResult;

  createBus(): Bus {
    const id = `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: id, messages: [] };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id);
  }

  async publishBus(id: string, message: string, from = "main"): Promise<PublishedBusMessage> {
    this.published = { id, message, from };
    const bus = this.buses.get(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);

    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, message, from };
    bus.messages.push(busMessage);
    return { bus, busMessage };
  }

  async spawnAgent(profile: AgentProfile, task: string, busId: string): Promise<AgentRun> {
    const spawnedRun = run({ id: "agent-1", name: "agent-1", profile: profile.name, task, busId, state: "idle" });
    this.runs.set(spawnedRun.id, spawnedRun);
    return spawnedRun;
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId?: string } = {}): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((current) => current.busId === options.busId);
  }

  async messageAgent(id: string, _message: string): Promise<AgentRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Agent ${id} not found.`);
    return current;
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    return this.runs.get(id);
  }

  waitBusSettled(busId: string, options: WaitBusSettledOptions = {}): Promise<WaitBusSettledResult> {
    this.waitedSettled = { busId, options };
    const bus = this.buses.get(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    const runs = this.listRuns({ busId });
    return Promise.resolve(
      this.nextSettledResult ?? {
        bus,
        runs,
        runResults: runs.map(toWaitRunResult),
        timedOut: false,
        pendingRunIds: [],
      },
    );
  }

  waitNextRun(busId: string, options: WaitNextRunOptions = {}): Promise<WaitNextRunResult> {
    this.waitedNext = { busId, options };
    const bus = this.buses.get(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    const runs = this.listRuns({ busId });
    return Promise.resolve(
      this.nextRunResult ?? { bus, runs, runResults: runs.map(toWaitRunResult), timedOut: false, pendingRunIds: [] },
    );
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
