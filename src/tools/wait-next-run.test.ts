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
import { createWaitNextRunTool } from "./wait-next-run.ts";

test("waitNextRun delegates to orchestra and formats the terminal run", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWaitNextRunTool({ orchestra });
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

  const output = await tool.execute({ busId: bus.id, excludeRunIds: ["already-handled"], timeoutMs: 1000 });

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

test("waitNextRun formats terminal runs without result payloads", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWaitNextRunTool({ orchestra });
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

  const output = await tool.execute({ busId: bus.id });

  assert.equal(
    output.message,
    [`Next terminal run on bus ${bus.id}: agent-1 is closed.`, "", "No result payload recorded."].join("\n"),
  );
});

test("waitNextRun formats timeout without a terminal run", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWaitNextRunTool({ orchestra });
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

  const output = await tool.execute({ busId: bus.id, timeoutMs: 1000 });

  assert.equal(output.run, undefined);
  assert.equal(output.timedOut, true);
  assert.equal(output.message, `Timed out waiting for the next run on bus ${bus.id}; 1 run(s) still pending.`);
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  waitedNext?: { busId: string; options: WaitNextRunOptions };
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

  waitBusSettled(_busId: string, _options: WaitBusSettledOptions = {}): Promise<WaitBusSettledResult> {
    throw new Error("Not implemented.");
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
