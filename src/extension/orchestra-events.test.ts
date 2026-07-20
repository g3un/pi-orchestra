import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { OrchestraEventController, type OrchestraMainEvent } from "./orchestra-events.ts";

const profile = { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined };

test.each([
  { label: "waiting", waiting: true, delivered: true },
  { label: "active", waiting: false, delivered: false },
])("closed workgroup delivery to a $label leader is $delivered", (expected) => {
  const store = new InMemoryAgentStore();
  const mainEvents: OrchestraMainEvent[] = [];
  const leaderEvents: OrchestraMainEvent[] = [];
  const controller = new OrchestraEventController({
    store,
    sendEvents: (events) => mainEvents.push(...events),
    sendAgentEvents: (runId, events) => {
      assert.equal(runId, "leader");
      leaderEvents.push(...events);
      return true;
    },
    isRunWaiting: () => expected.waiting,
    flushDelayMs: 0,
  });
  const leader = run("leader", null);
  const member = run("member", leader.id);
  const workgroup: WorkgroupRun = {
    id: "workgroup-1",
    name: "group-review",
    busId: "bus-1",
    ownerSessionId: "session-1",
    goal: "Review.",
    leaderRunId: leader.id,
    memberRunIds: [member.id],
    state: "running",
    result: null,
    createdAtMs: 1,
  };
  store.saveRun(leader);
  store.saveRun(member);
  store.saveWorkgroup(workgroup);

  store.saveWorkgroup({ ...workgroup, state: "closing" });
  store.saveRun({ ...member, state: "closed" });
  assert.deepEqual(leaderEvents, []);

  const closedWorkgroup: WorkgroupRun = {
    ...workgroup,
    state: "closed",
    result: { status: "blocked", summary: "Cancelled." },
  };
  store.saveWorkgroup(closedWorkgroup);
  controller.dispose();

  assert.deepEqual(
    leaderEvents,
    expected.delivered ? [{ type: "workgroup.finished", workgroup: closedWorkgroup }] : [],
  );
  assert.deepEqual(mainEvents, [{ type: "workgroup.finished", workgroup: closedWorkgroup }]);
});

function run(id: string, parentRunId: string | null): AgentRun {
  return {
    id,
    name: id,
    profile,
    task: "Task.",
    busId: "bus-1",
    ownerSessionId: "session-1",
    parentRunId,
    state: "running",
    result: null,
  };
}
