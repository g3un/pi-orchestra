import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
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

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  published?: { id: string; message: string; from: string };

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
