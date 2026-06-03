import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { AgentRuntime } from "../core/runtime.ts";
import type { AgentStore } from "../core/store.ts";
import { createBusTool } from "./bus.ts";

const uuid7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("bus create allocates and stores a standalone bus", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createBusTool({ runtime, store });

  const output = await tool.execute({ action: "create" });

  assert.ok(output.bus);
  assert.match(output.bus.id, uuid7Pattern);
  assert.deepEqual(output.bus.messages, []);
  assert.equal(store.getBus(output.bus.id), output.bus);
  assert.deepEqual(store.savedBuses, [output.bus]);
  assert.equal(output.message, `Created bus ${output.bus.id}.`);
});

test("bus status returns stored bus messages", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createBusTool({ runtime, store });
  const bus: Bus = {
    id: "bus-1",
    messages: [{ id: "message-1", from: "main", message: "Initial context." }],
  };
  store.saveBus(bus);

  const output = await tool.execute({ action: "status", id: bus.id });
  const missingOutput = await tool.execute({ action: "status", id: "missing" });

  assert.equal(output.bus, bus);
  assert.equal(
    output.message,
    ["Bus bus-1 has 1 message(s).", "", "Messages:", "- message-1 from main:", "  Initial context."].join("\n"),
  );
  assert.equal(missingOutput.bus, undefined);
  assert.equal(missingOutput.message, "Bus missing not found.");
});

test("bus publish delegates to runtime and stores the message", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const tool = createBusTool({ runtime, store });
  const bus: Bus = { id: "bus-1", messages: [] };
  store.saveBus(bus);

  const output = await tool.execute({ action: "publish", id: bus.id, message: "New constraint." });

  assert.deepEqual(runtime.published, {
    bus,
    message: "New constraint.",
    from: "main",
  });
  assert.deepEqual(output.busMessage, { id: "message-1", message: "New constraint.", from: "main" });
  assert.deepEqual(store.busMessagesAdded, [
    {
      busId: bus.id,
      message: { id: "message-1", message: "New constraint.", from: "main" },
    },
  ]);
  assert.deepEqual(store.getBus(bus.id)?.messages, [{ id: "message-1", message: "New constraint.", from: "main" }]);
  assert.equal(
    output.message,
    "Published message to bus bus-1.\n\nMessages:\n- message-1 from main:\n  New constraint.",
  );
});

class FakeRuntime implements AgentRuntime {
  runs = new Map<string, AgentRun>();
  published?: { bus: Bus; message: string; from: string };

  async spawn(profile: AgentProfile, task: string, bus: Bus): Promise<AgentRun> {
    const spawnedRun: AgentRun = {
      id: "agent-1",
      profile: profile.name,
      task,
      busId: bus.id,
      state: "running",
    };
    this.runs.set(spawnedRun.id, spawnedRun);
    return spawnedRun;
  }

  async resume(id: string, message: string): Promise<AgentRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Agent ${id} not found: ${message}`);
    return current;
  }

  async publishBus(bus: Bus, message: string, from: string): Promise<BusMessage> {
    this.published = { bus, message, from };
    return { id: "message-1", message, from };
  }

  async close(_id: string): Promise<void> {}

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }
}

class FakeStore implements AgentStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly buses = new Map<string, Bus>();
  savedBuses: Bus[] = [];
  busMessagesAdded: Array<{ busId: string; message: BusMessage }> = [];

  saveRun(run: AgentRun): void {
    this.runs.set(run.id, run);
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  saveBus(bus: Bus): void {
    this.savedBuses.push(bus);
    this.buses.set(bus.id, bus);
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id);
  }

  addBusMessage(busId: string, message: BusMessage): void {
    this.busMessagesAdded.push({ busId, message });
    const bus = this.buses.get(busId);
    if (!bus) return;

    const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
    if (existingIndex >= 0) {
      bus.messages[existingIndex] = message;
      return;
    }

    bus.messages.push(message);
  }
}
