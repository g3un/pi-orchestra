import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { Bus } from "../core/bus.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";

test("updateBus clones once and isolates stored state from caller mutations", () => {
  const store = new InMemoryAgentStore();
  const bus: Bus = {
    id: "bus-1",
    name: "bus-1",
    state: "open",
    messages: [{ id: "message-1", seq: 1, from: "main", message: "Original." }],
    nextMessageSeq: 2,
  };
  store.saveBus(bus);
  bus.messages[0]!.message = "Mutated save input.";
  assert.equal(store.getBus(bus.id)?.messages[0]?.message, "Original.");

  const addedMessage = { id: "message-2", seq: 2, from: "agent-1", message: "Added." };
  const clone = vi.spyOn(globalThis, "structuredClone");
  const updated = store.updateBus(bus.id, (current) => ({
    ...current,
    messages: [...current.messages, addedMessage],
    nextMessageSeq: 3,
  }));
  const cloneCount = clone.mock.calls.length;
  clone.mockRestore();

  assert.equal(cloneCount, 1);
  assert.ok(updated);
  addedMessage.message = "Mutated update input.";
  updated.messages[0]!.message = "Mutated return value.";
  assert.deepEqual(store.getBus(bus.id)?.messages, [
    { id: "message-1", seq: 1, from: "main", message: "Original." },
    { id: "message-2", seq: 2, from: "agent-1", message: "Added." },
  ]);
});
