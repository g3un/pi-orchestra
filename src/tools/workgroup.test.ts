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
import { createWorkgroupTool } from "./workgroup.ts";

const securityProfile: AgentProfile = {
  name: "security",
  systemPrompt: "Review security risks.",
};

const backendProfile: AgentProfile = {
  name: "backend",
  systemPrompt: "Review backend design.",
};

const brokenProfile: AgentProfile = {
  name: "broken",
  systemPrompt: "Fail during spawn.",
};

test("workgroup launches members on an existing bus", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "auth-work" });

  const output = await tool.execute({
    busId: bus.name,
    goal: "Plan the auth refactor.",
    mode: "council",
    members: [
      { name: "security-review", profile: securityProfile, assignment: "Identify auth security risks." },
      { name: "backend-review", profile: backendProfile, assignment: "Assess API and data model changes." },
    ],
  });

  assert.equal(output.bus, bus);
  assert.equal(output.runs.length, 2);
  assert.deepEqual(
    orchestra.spawned.map((spawn) => ({ profile: spawn.profile, busId: spawn.busId, name: spawn.options?.name })),
    [
      { profile: securityProfile, busId: bus.id, name: "security-review" },
      { profile: backendProfile, busId: bus.id, name: "backend-review" },
    ],
  );
  assert.match(orchestra.spawned[0]?.task ?? "", /Workgroup mode: council/);
  assert.match(orchestra.spawned[0]?.task ?? "", /Shared goal:\nPlan the auth refactor\./);
  assert.match(orchestra.spawned[0]?.task ?? "", /Identify auth security risks\./);
  assert.match(
    orchestra.spawned[0]?.task ?? "",
    /publish_bus is for sibling reference data, not for requesting leader action/,
  );
  assert.match(orchestra.spawned[0]?.task ?? "", /finish with status blocked/);
  assert.match(orchestra.spawned[0]?.task ?? "", /Council mode guidelines/);
  assert.equal(
    output.message,
    [
      "Launched council workgroup on bus auth-work with 2 run(s).",
      "",
      "Runs:",
      "- security-review: running",
      "- backend-review: running",
      "",
      "Use waitNextRun to handle member results as they finish, or waitBusSettled for full fan-in.",
    ].join("\n"),
  );
});

test("workgroup explore mode guides members to share facts without herding", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "design-explore" });

  await tool.execute({
    busId: bus.id,
    goal: "Compare implementation options.",
    mode: "explore",
    members: [{ name: "option-a", profile: backendProfile }],
  });

  const task = orchestra.spawned[0]?.task ?? "";
  assert.match(
    task,
    /Use publish_bus only for facts, evidence, dead ends, constraints, or blockers that may help sibling agents/,
  );
  assert.match(task, /Keep your conclusions and recommendations private until finish/);
  assert.match(task, /Treat sibling bus messages as claims to verify, challenge, or refute/);
});

test("workgroup rejects missing buses", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });

  await assert.rejects(
    () =>
      tool.execute({
        busId: "missing",
        goal: "Plan the auth refactor.",
        mode: "explore",
        members: [{ profile: securityProfile }],
      }),
    /Bus missing not found\./,
  );
});

test("workgroup member name checks are global", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const targetBus = orchestra.createBus({ name: "target-work" });
  const otherBus = orchestra.createBus({ name: "other-work" });
  orchestra.runs.set("security-review", {
    id: "security-review",
    name: "security-review",
    profile: "security",
    task: "Existing work.",
    busId: otherBus.id,
    state: "running",
  });

  await assert.rejects(
    () =>
      tool.execute({
        busId: targetBus.id,
        goal: "Plan the auth refactor.",
        mode: "explore",
        members: [{ name: "security-review", profile: securityProfile }],
      }),
    /Workgroup member name "security-review" is already in use\./,
  );
});

test("workgroup closes successfully spawned members when launch is incomplete", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({ orchestra });
  const bus = orchestra.createBus({ name: "auth-work" });

  await assert.rejects(
    () =>
      tool.execute({
        busId: bus.id,
        goal: "Plan the auth refactor.",
        mode: "council",
        members: [
          { name: "security-review", profile: securityProfile },
          { name: "broken-review", profile: brokenProfile },
        ],
      }),
    /Failed to launch every workgroup member\./,
  );

  assert.deepEqual(orchestra.closedIds, ["security-review"]);
  assert.equal(orchestra.runs.get("security-review")?.state, "closed");
});

class FakeOrchestra implements OrchestraApi {
  buses = new Map<string, Bus>();
  runs = new Map<string, AgentRun>();
  spawned: Array<{ profile: AgentProfile; task: string; busId: string; options?: { name?: string } }> = [];
  closedIds: string[] = [];

  createBus(options: { name?: string } = {}): Bus {
    const id = options.name ?? `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: options.name ?? id, messages: [] };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id) ?? [...this.buses.values()].find((bus) => bus.name === id);
  }

  async publishBus(id: string, message: string, from = "main"): Promise<PublishedBusMessage> {
    const bus = this.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, message, from };
    bus.messages.push(busMessage);
    return { bus, busMessage };
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: { name?: string } = {},
  ): Promise<AgentRun> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    if (profile.name === "broken") throw new Error("Spawn failed.");

    this.spawned.push({ profile, task, busId: bus.id, options });
    const name = options.name ?? profile.name;
    const id = slugify(name);
    const run: AgentRun = {
      id,
      name,
      profile: profile.name,
      task,
      busId: bus.id,
      state: "running",
    };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId?: string } = {}): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async messageAgent(id: string, _message: string): Promise<AgentRun> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    this.closedIds.push(id);
    const run = this.runs.get(id);
    if (!run) return undefined;

    const closedRun = { ...run, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
  }

  waitBusSettled(_busId: string, _options: WaitBusSettledOptions = {}): Promise<WaitBusSettledResult> {
    throw new Error("Not implemented.");
  }

  waitNextRun(_busId: string, _options: WaitNextRunOptions = {}): Promise<WaitNextRunResult> {
    throw new Error("Not implemented.");
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
