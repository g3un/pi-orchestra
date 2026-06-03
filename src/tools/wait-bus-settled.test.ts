import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type {
  OrchestraApi,
  PublishedBusMessage,
  WaitBusSettledOptions,
  WaitBusSettledResult,
  WaitNextRunOptions,
  WaitNextRunResult,
} from "../core/orchestra.ts";
import { createWaitBusSettledTool } from "./wait-bus-settled.ts";

test("waitBusSettled delegates to orchestra and formats terminal bus runs", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWaitBusSettledTool({ orchestra });
  const bus = orchestra.createBus();
  const runs = [
    run({ id: "agent-1", busId: bus.id, state: "finished", result: { status: "success", summary: "Done." } }),
    run({ id: "agent-2", busId: bus.id, state: "failed", result: { status: "failed", summary: "Failed." } }),
  ];
  for (const current of runs) orchestra.runs.set(current.id, current);

  const output = await tool.execute({ busId: bus.id, timeoutMs: 1000 });

  assert.deepEqual(orchestra.waitedSettled, { busId: bus.id, options: { timeoutMs: 1000 } });
  assert.equal(output.bus, bus);
  assert.deepEqual(output.runs, runs);
  assert.deepEqual(output.runResults, runs.map(toRunResult));
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.pendingRunIds, []);
  assert.equal(
    output.message,
    [
      `All 2 run(s) attached to bus ${bus.id} reached terminal state.`,
      "",
      "Runs:",
      "- agent-1: finished result=success summary=Done.",
      "- agent-2: failed result=failed summary=Failed.",
    ].join("\n"),
  );
});

test("waitBusSettled formats timeout partial results", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWaitBusSettledTool({ orchestra });
  const bus = orchestra.createBus();
  const runningRun = run({ id: "agent-1", busId: bus.id, state: "running" });
  orchestra.runs.set(runningRun.id, runningRun);
  orchestra.nextSettledResult = {
    bus,
    runs: [runningRun],
    runResults: [toRunResult(runningRun)],
    timedOut: true,
    pendingRunIds: [runningRun.id],
  };

  const output = await tool.execute({ busId: bus.id, timeoutMs: 1000 });

  assert.equal(output.timedOut, true);
  assert.deepEqual(output.runResults, [toRunResult(runningRun)]);
  assert.deepEqual(output.pendingRunIds, [runningRun.id]);
  assert.equal(
    output.message,
    [`Timed out waiting for bus ${bus.id} to settle; 1 run(s) still pending.`, "", "Runs:", "- agent-1: running"].join(
      "\n",
    ),
  );
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  waitedSettled?: { busId: string; options: WaitBusSettledOptions };
  nextSettledResult?: WaitBusSettledResult;

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
    const spawnedRun = run({ id: "agent-1", name: "agent-1", profile: profile.name, task, busId, state: "running" });
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
      this.nextSettledResult ?? { bus, runs, runResults: runs.map(toRunResult), timedOut: false, pendingRunIds: [] },
    );
  }

  waitNextRun(_busId: string, _options: WaitNextRunOptions = {}): Promise<WaitNextRunResult> {
    throw new Error("Not implemented.");
  }
}

function toRunResult(run: AgentRun): WaitBusSettledResult["runResults"][number] {
  const runResult: WaitBusSettledResult["runResults"][number] = {
    runId: run.id,
    name: run.name,
    profile: run.profile,
    state: run.state,
  };
  if (run.result !== undefined) runResult.result = run.result;
  return runResult;
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
