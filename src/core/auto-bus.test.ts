import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { Bus } from "./bus.ts";
import { closeRuntimeOwnedStandalonePrivateBuses, closeStandalonePrivateBusIfUnused } from "./auto-bus.ts";
import type { OrchestraApi } from "./orchestra.ts";
import type { AgentRun } from "./subagent.ts";
import { buildAgentRun } from "../../tests/helpers/agent-run-fixture.ts";

test("standalone private bus stays open while finished owner remains messageable", () => {
  const store = new InMemoryAgentStore();
  store.saveBus(privateBus());
  const owner = run({ state: "success", result: { status: "success", summary: "Done." } });
  store.saveRun(owner);

  const closed = closeStandalonePrivateBusIfUnused(store, closeBus(store), owner.busId);

  assert.equal(closed, undefined);
  assert.equal(store.getBus("bus-1")?.state, "open");
});

test("standalone private bus closes after the owner run is closed", () => {
  const store = new InMemoryAgentStore();
  store.saveBus(privateBus());
  const owner = run({ state: "closed" });
  store.saveRun(owner);

  const closed = closeStandalonePrivateBusIfUnused(store, closeBus(store), owner.busId);

  assert.equal(closed?.state, "closed");
  assert.equal(store.getBus("bus-1")?.state, "closed");
});

test("standalone private bus waits for sibling runs to be closed", () => {
  const store = new InMemoryAgentStore();
  store.saveBus(privateBus());
  const owner = run({ id: "owner", name: "owner", state: "closed" });
  const sibling = run({
    id: "sibling",
    name: "sibling",
    state: "success",
    result: { status: "success", summary: "Done." },
  });
  store.saveRun(owner);
  store.saveRun(sibling);

  const closed = closeStandalonePrivateBusIfUnused(store, closeBus(store), owner.busId);

  assert.equal(closed, undefined);
  assert.equal(store.getBus("bus-1")?.state, "open");
});

test("explicit lookalike bus is not auto-closed", () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "bus-agent-owner", state: "open", messages: [], nextMessageSeq: 1 });
  const owner = run({ state: "closed" });
  store.saveRun(owner);

  const closed = closeStandalonePrivateBusIfUnused(store, closeBus(store), owner.busId);

  assert.equal(closed, undefined);
  assert.equal(store.getBus("bus-1")?.state, "open");
});

test("standalone private bus waits for off-bus live subscribers with unread messages", () => {
  const store = new InMemoryAgentStore();
  store.saveBus({
    ...privateBus(),
    messages: [{ id: "message-1", seq: 1, from: "owner", message: "Unread context." }],
    nextMessageSeq: 2,
  });
  const owner = run({ id: "owner", name: "owner", state: "closed" });
  const subscriber = run({ id: "subscriber", name: "subscriber", busId: "bus-2", state: "running" });
  store.saveRun(owner);
  store.saveRun(subscriber);
  store.saveBusSubscription({
    id: "subscription-1",
    busId: "bus-1",
    subscriberId: "subscriber",
    subscriberKind: "agent",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
  });

  const closed = closeStandalonePrivateBusIfUnused(store, closeBus(store), owner.busId);

  assert.equal(closed, undefined);
  assert.equal(store.getBus("bus-1")?.state, "open");
});

test("orphan standalone private bus closes when no runs or live subscribers remain", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus(privateBus({ metadata: { autoClose: "standalone-subagent-private", ownerSessionId: "session-1" } }));

  await closeRuntimeOwnedStandalonePrivateBuses(
    store,
    {
      closeAgent: async () => undefined,
      closeBus: closeBus(store),
      listRuns: () => [],
    } as unknown as OrchestraApi,
    "session-1",
  );

  assert.equal(store.getBus("bus-1")?.state, "closed");
});

function closeBus(store: InMemoryAgentStore): (busId: string) => Bus | undefined {
  return (busId) => store.updateBus(busId, (current) => ({ ...current, state: "closed" }));
}

function privateBus(overrides: Partial<Bus> = {}): Bus {
  return {
    id: "bus-1",
    name: "bus-agent-owner",
    state: "open",
    messages: [],
    metadata: { autoClose: "standalone-subagent-private", ownerSessionId: "session-1" },
    ...overrides,
    nextMessageSeq: overrides.nextMessageSeq ?? 1,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return buildAgentRun({
    id: "owner",
    name: "owner",
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Research.",
    busId: "bus-1",
    parentRunId: null,
    state: "running",
    result: null,
    sessionFile: ".pi/orchestra/sessions/agent.jsonl",
    ...overrides,
    ownerSessionId: overrides.ownerSessionId ?? "session-1",
  });
}
