import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { createSubagentTool } from "./subagent.ts";

const profile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned task.",
};

test("subagent spawn uses an existing bus and delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra });
  const bus: Bus = { id: "bus-1", messages: [] };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({ action: "spawn", profile, task: "Inspect the code.", busId: bus.id });

  assert.ok(output.run);
  assert.equal(output.run.id, "agent-1");
  assert.equal(output.run.busId, bus.id);
  assert.deepEqual(orchestra.spawned, {
    profile,
    task: "Inspect the code.",
    busId: bus.id,
  });
});

test("subagent spawn rejects missing buses", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra });

  await assert.rejects(
    () => tool.execute({ action: "spawn", profile, task: "Inspect the code.", busId: "missing" }),
    /Bus missing not found\./,
  );
});

test("subagent status reads orchestra state", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra });
  const finishedRun = run({
    id: "agent-1",
    state: "finished",
    result: {
      status: "success",
      summary: "Found the relevant implementation.",
      data: { file: "src/tools/subagent.ts" },
    },
  });
  orchestra.runs.set(finishedRun.id, finishedRun);

  const output = await tool.execute({ action: "status", id: finishedRun.id });
  const missingOutput = await tool.execute({ action: "status", id: "missing" });

  assert.equal(output.run, finishedRun);
  assert.equal(
    output.message,
    [
      "Subagent agent-1 is finished.",
      "",
      "Result: success",
      "Found the relevant implementation.",
      "",
      "Data:",
      '{\n  "file": "src/tools/subagent.ts"\n}',
    ].join("\n"),
  );
  assert.equal(missingOutput.run, undefined);
  assert.equal(missingOutput.message, "Subagent missing not found.");
});

test("subagent resume delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra });
  const existing = run({ id: "agent-1", state: "finished" });
  orchestra.runs.set(existing.id, existing);

  const output = await tool.execute({ action: "resume", id: existing.id, message: "Continue." });

  assert.deepEqual(orchestra.resumed, { id: existing.id, message: "Continue." });
  assert.ok(output.run);
  assert.equal(output.run.state, "running");
  assert.equal(orchestra.getRun(existing.id), output.run);
});

test("subagent close delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra });
  const existing = run({ id: "agent-1", state: "finished" });
  orchestra.runs.set(existing.id, existing);

  const output = await tool.execute({ action: "close", id: existing.id });

  assert.deepEqual(orchestra.closedIds, [existing.id]);
  assert.ok(output.run);
  assert.equal(output.run.state, "closed");
  assert.equal(orchestra.getRun(existing.id)?.state, "closed");
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  spawned?: { profile: AgentProfile; task: string; busId: string };
  resumed?: { id: string; message: string };
  closedIds: string[] = [];

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
    if (!this.buses.has(busId)) throw new Error(`Bus ${busId} not found.`);

    this.spawned = { profile, task, busId };
    const spawnedRun = run({
      id: "agent-1",
      profile: profile.name,
      task,
      busId,
      state: "running",
    });
    this.runs.set(spawnedRun.id, spawnedRun);
    return spawnedRun;
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  async resumeAgent(id: string, message: string): Promise<AgentRun> {
    this.resumed = { id, message };
    const current = this.runs.get(id) ?? run({ id });
    const resumedRun = { ...current, state: "running" as const };
    this.runs.set(id, resumedRun);
    return resumedRun;
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    this.closedIds.push(id);
    const current = this.runs.get(id);
    if (!current) return undefined;

    const closedRun = { ...current, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
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
