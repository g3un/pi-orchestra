import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { createSubagentTool, toAgentProfile, type RawAgentProfileParams } from "./subagent.ts";

const profile: AgentProfile = {
  name: "researcher",
  systemPrompt: "Research the assigned task.",
  tools: ["read", "bash"],
  model: undefined,
};

test("agent profile params resolve presets with overrides", () => {
  const resolvedProfile = toAgentProfile({
    preset: "source-code-qa",
    tools: ["read"],
    name: "repo-qa",
    model: "mock/model",
  });

  assert.equal(resolvedProfile.name, "repo-qa");
  assert.equal(resolvedProfile.model, "mock/model");
  assert.deepEqual(resolvedProfile.tools, ["read"]);
  assert.match(resolvedProfile.systemPrompt, /source-code QA agent/);
});

test("agent profile params require explicit tools", () => {
  assert.throws(
    () =>
      toAgentProfile({
        name: "researcher",
        systemPrompt: "Research the assigned task.",
      } as unknown as RawAgentProfileParams),
    /Profile "researcher" requires tools\./,
  );
  assert.throws(
    () => toAgentProfile({ preset: "code-reviewer" } as unknown as RawAgentProfileParams),
    /Profile preset "code-reviewer" requires tools\./,
  );
  assert.throws(
    () =>
      toAgentProfile({
        preset: "code-reviewer",
        systemPrompt: "Custom prompt.",
        tools: [],
      } as RawAgentProfileParams),
    /Profile preset "code-reviewer" must not include systemPrompt/,
  );
  assert.throws(() => toAgentProfile({ tools: [] } as RawAgentProfileParams), /Custom profile requires name\./);
});

test("subagent spawn uses an existing bus and delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: "parent-run" });
  const bus: Bus = { id: "bus-1", name: "bus-1", state: "open", messages: [] };
  orchestra.buses.set(bus.id, bus);

  const output = await tool.execute({
    action: "spawn",
    profile,
    task: "Inspect the code.",
    busId: bus.id,
    name: "agent-1",
  });

  assert.ok(output.run);
  assert.equal(output.run.id, "agent-1");
  assert.equal(output.run.busId, bus.id);
  assert.equal(output.run.parentRunId, "parent-run");
  assert.deepEqual(orchestra.spawned, {
    profile,
    task: "Inspect the code.",
    busId: bus.id,
    parentRunId: "parent-run",
  });
});

test("subagent spawn rejects missing buses", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: null });

  await assert.rejects(
    () =>
      tool.execute({ action: "spawn", profile, task: "Inspect the code.", busId: "missing", name: "missing-agent" }),
    /Bus missing not found\./,
  );
});

test("subagent status reads orchestra state", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: null });
  const successRun = run({
    id: "agent-1",
    state: "success",
    result: {
      status: "success",
      summary: "Found the relevant implementation.",
      data: { file: "src/tools/subagent.ts" },
    },
  });
  orchestra.runs.set(successRun.id, successRun);

  const output = await tool.execute({ action: "status", id: successRun.id });
  const missingOutput = await tool.execute({ action: "status", id: "missing" });

  assert.equal(output.run, successRun);
  assert.equal(
    output.message,
    [
      "Subagent agent-1 is success.",
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

test("subagent status formats blocked results", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: null });
  const blockedRun = run({
    id: "agent-1",
    state: "blocked",
    result: { status: "blocked", summary: "Need a decision from the leader." },
  });
  orchestra.runs.set(blockedRun.id, blockedRun);

  const output = await tool.execute({ action: "status", id: blockedRun.id });

  assert.equal(
    output.message,
    ["Subagent agent-1 is blocked.", "", "Result: blocked", "Need a decision from the leader."].join("\n"),
  );
});

test("subagent message delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: null });
  const existing = run({ id: "agent-1", state: "success", result: { status: "success", summary: "Done." } });
  orchestra.runs.set(existing.id, existing);

  const output = await tool.execute({ action: "message", id: existing.id, message: "Continue." });

  assert.deepEqual(orchestra.messaged, { id: existing.id, message: "Continue." });
  assert.ok(output.run);
  assert.equal(output.run.state, "running");
  assert.deepEqual(orchestra.getRun(existing.id, { busId: undefined }), output.run);
});

test("subagent close delegates to orchestra", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: null });
  const existing = run({ id: "agent-1", state: "success", result: { status: "success", summary: "Done." } });
  orchestra.runs.set(existing.id, existing);

  const output = await tool.execute({ action: "close", id: existing.id });

  assert.deepEqual(orchestra.closedIds, [existing.id]);
  assert.ok(output.run);
  assert.equal(output.run.state, "closed");
  assert.equal(orchestra.getRun(existing.id, { busId: undefined })?.state, "closed");
});

test("subagent close handles missing runs", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createSubagentTool({ orchestra, parentRunId: null });

  const output = await tool.execute({ action: "close", id: "missing" });

  assert.equal(output.run, undefined);
  assert.equal(output.message, "Subagent missing not found.");
  assert.deepEqual(orchestra.closedIds, []);
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  spawned?: { profile: AgentProfile; task: string; busId: string; parentRunId: string | null };
  messaged?: { id: string; message: string };
  closedIds: string[] = [];

  createBus(_options: { name: string | undefined }): Bus {
    const id = `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: id, state: "open", messages: [] };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id);
  }

  closeBus(id: string): Bus | undefined {
    const bus = this.buses.get(id);
    if (!bus) return undefined;
    const closedBus: Bus = { ...bus, state: "closed" };
    this.buses.set(id, closedBus);
    return closedBus;
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
    const bus = this.buses.get(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, message, from };
    bus.messages.push(busMessage);
    return { bus, busMessage };
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: { name: string | undefined; parentRunId: string | null },
  ): Promise<AgentRun> {
    if (!this.buses.has(busId)) throw new Error(`Bus ${busId} not found.`);

    this.spawned = { profile, task, busId, parentRunId: options.parentRunId };
    const spawnedRun = run({
      id: "agent-1",
      name: "agent-1",
      profile,
      task,
      busId,
      parentRunId: options.parentRunId,
      state: "running",
    });
    this.runs.set(spawnedRun.id, spawnedRun);
    return spawnedRun;
  }

  getRun(id: string, _options: { busId: string | undefined }): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId: string | undefined }): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async messageAgent(id: string, message: string, _options: { busId: string | undefined }): Promise<AgentRun> {
    this.messaged = { id, message };
    const current = this.runs.get(id) ?? run({ id });
    const messagedRun = { ...current, state: "running" as const, result: null };
    this.runs.set(id, messagedRun);
    return messagedRun;
  }

  async closeAgent(id: string, _options: { busId: string | undefined }): Promise<AgentRun | undefined> {
    const current = this.runs.get(id);
    if (!current) return undefined;

    this.closedIds.push(id);
    const closedRun = { ...current, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
  }
}

function run(overrides: Partial<AgentRun>): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
    task: "Inspect the code.",
    busId: "bus-1",
    state: "running",
    ...overrides,
    parentRunId: overrides.parentRunId ?? null,
    sessionFile: overrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
    result: overrides.result ?? null,
  } as AgentRun;
}
