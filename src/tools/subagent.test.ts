import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import { createSubagentTool, defineSubagentPiTool } from "./subagent.ts";

test("subagent spawn forwards profile.thinkingLevel to orchestra.spawnAgent", async () => {
  const orchestra = new FakeOrchestra();
  const tool = defineSubagentPiTool(() =>
    createSubagentTool({
      orchestra: orchestra as unknown as OrchestraApi,
      store: new InMemoryAgentStore(),
      parentRunId: null,
      ownerSessionId: "session-1",
      resolveAgentHealth: undefined,
    }),
  );

  await tool.execute(
    "call-1",
    {
      action: "spawn",
      name: "reviewer",
      task: "Review the change.",
      profile: {
        name: "reviewer",
        systemPrompt: "Review the change.",
        tools: ["read"],
        thinkingLevel: "max",
      },
    },
    new AbortController().signal,
    undefined,
    {} as never,
  );

  assert.equal(orchestra.spawned.at(-1)?.profile.thinkingLevel, "max");
});

class FakeOrchestra {
  buses = new Map<string, Bus>();
  spawned: Array<{
    profile: AgentProfile;
    task: string;
    busId: string;
    options: { name: string | undefined; parentRunId: string | null };
  }> = [];

  createBus(options: { name: string | undefined }): Bus {
    const id = options.name ?? `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: options.name ?? id, state: "open", messages: [], nextMessageSeq: 1 };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id) ?? [...this.buses.values()].find((bus) => bus.name === id);
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: { name: string | undefined; parentRunId: string | null },
  ): Promise<AgentRun> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    this.spawned.push({ profile, task, busId: bus.id, options });
    return {
      id: options.name ?? profile.name,
      name: options.name ?? profile.name,
      profile,
      task,
      busId: bus.id,
      parentRunId: options.parentRunId,
      ownerSessionId: "session-1",
      state: "running",
      result: null,
    };
  }
}
