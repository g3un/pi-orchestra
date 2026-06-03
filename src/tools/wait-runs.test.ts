import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage, WaitRunsOptions } from "../core/orchestra.ts";
import { createWaitRunsTool } from "./wait-runs.ts";

test("waitRuns delegates to orchestra and formats terminal runs", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWaitRunsTool({ orchestra });
  const runs = [
    run({ id: "agent-1", state: "finished", result: { status: "success", summary: "Done." } }),
    run({ id: "agent-2", state: "failed", result: { status: "failed", summary: "Failed." } }),
  ];
  for (const current of runs) orchestra.runs.set(current.id, current);

  const output = await tool.execute({ runIds: ["agent-1", "agent-2"], timeoutMs: 1000 });

  assert.deepEqual(orchestra.waited, { runIds: ["agent-1", "agent-2"], options: { timeoutMs: 1000 } });
  assert.deepEqual(output.runs, runs);
  assert.equal(
    output.message,
    [
      "All 2 run(s) reached terminal state.",
      "",
      "Runs:",
      "- agent-1: finished result=success",
      "- agent-2: failed result=failed",
    ].join("\n"),
  );
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  waited?: { runIds: string[]; options: WaitRunsOptions };

  createBus(): Bus {
    const bus: Bus = { id: `bus-${this.buses.size + 1}`, messages: [] };
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
    const spawnedRun = run({ id: "agent-1", profile: profile.name, task, busId, state: "running" });
    this.runs.set(spawnedRun.id, spawnedRun);
    return spawnedRun;
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId?: string } = {}): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async resumeAgent(id: string, _message: string): Promise<AgentRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Agent ${id} not found.`);
    return current;
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    return this.runs.get(id);
  }

  waitRuns(runIds: string[], options: WaitRunsOptions = {}): Promise<AgentRun[]> {
    this.waited = { runIds, options };
    return Promise.resolve(
      runIds.map((id) => this.runs.get(id)).filter((current): current is AgentRun => current !== undefined),
    );
  }
}

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: "agent-1",
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
  };
}
