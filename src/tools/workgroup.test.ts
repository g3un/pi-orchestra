import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { slugify } from "../utils.ts";
import { createWorkgroupTool, type WorkgroupOutput, type WorkgroupToolDeps } from "./workgroup.ts";

const securityProfile: AgentProfile = {
  name: "security",
  systemPrompt: "Review security risks.",
  tools: ["read", "bash"],
  model: undefined,
};

const backendProfile: AgentProfile = {
  name: "backend",
  systemPrompt: "Review backend design.",
  tools: ["read", "bash"],
  model: undefined,
};

const brokenProfile: AgentProfile = {
  name: "broken",
  systemPrompt: "Fail during spawn.",
  tools: ["read", "bash"],
  model: undefined,
};

function workgroupDeps(orchestra: OrchestraApi & { store: InMemoryAgentStore }): WorkgroupToolDeps {
  return {
    orchestra,
    store: orchestra.store,
    onWorkgroupLaunching: undefined,
    onWorkgroupLaunched: undefined,
    onWorkgroupLaunchFailed: undefined,
  };
}

test("workgroup creates an internal bus and launches members on it", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "auth-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const bus = requireBus(orchestra, workgroup.busId);
  const output = await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "security-review",
        profile: securityProfile,
        task: "Identify auth security risks.",
      },
      {
        name: "backend-review",
        profile: backendProfile,
        task: "Assess API and data model changes.",
      },
    ],
  });

  assertMembersAdded(output);
  assert.equal(output.bus, bus);
  assert.equal(output.runs.length, 2);
  assertUuid7(output.workgroup.id);
  assert.equal(output.workgroup.name, "auth-work-workgroup");
  assert.equal(output.workgroup.leaderRunId, null);
  assert.deepEqual(output.workgroup.memberRunIds, ["security-review", "backend-review"]);
  assert.deepEqual(orchestra.store.getWorkgroup(output.workgroup.id), output.workgroup);
  assert.deepEqual(
    orchestra.spawned.map((spawn) => ({ profile: spawn.profile, busId: spawn.busId, name: spawn.options?.name })),
    [
      { profile: securityProfile, busId: bus.id, name: "security-review" },
      { profile: backendProfile, busId: bus.id, name: "backend-review" },
    ],
  );
  assert.equal(orchestra.spawned[0]?.task, "Identify auth security risks.");
  assert.equal(
    output.message,
    [
      "Added 2 members to workgroup auth-work-workgroup on bus auth-work-workgroup-bus.",
      "",
      "Runs:",
      "- security-review: running",
      "- backend-review: running",
      "",
      "Pi-orchestra will deliver workgroup.member_finished events as members finish.",
    ].join("\n"),
  );
});

test("workgroup member task guides members to share useful context", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const created = await tool.execute({
    action: "create",
    name: "design-work-workgroup",
    goal: "Compare implementation options.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "option-a",
        profile: backendProfile,
        task: "Compare implementation option A.",
      },
    ],
  });

  const task = orchestra.spawned[0]?.task ?? "";
  assert.equal(task, "Compare implementation option A.");
});

test("workgroup uses explicit member names", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const created = await tool.execute({
    action: "create",
    name: "backend-work-workgroup",
    goal: "Review backend changes.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const output = await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        profile: backendProfile,
        name: "backend-a",
        task: "Review backend changes from one angle.",
      },
      {
        profile: backendProfile,
        name: "backend-b",
        task: "Review backend changes from another angle.",
      },
    ],
  });

  assertMembersAdded(output);
  assert.deepEqual(
    output.runs.map((run) => run.name),
    ["backend-a", "backend-b"],
  );
  assert.deepEqual(
    orchestra.spawned.map((spawn) => spawn.options?.name),
    ["backend-a", "backend-b"],
  );
});

test("workgroup create does not require a pre-existing bus", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const output = await tool.execute({
    action: "create",
    name: "new-workgroup",
    goal: "Plan the auth refactor.",
  });

  assert.equal(output.action, "create");
  if (output.action !== "create") throw new Error("Expected created workgroup output.");
  assert.equal(output.workgroup.busId, "new-workgroup-bus");
  assert.equal(orchestra.getBus(output.workgroup.busId)?.state, "open");
});

test("workgroup create validates names before creating the internal bus", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  await assert.rejects(
    () => tool.execute({ action: "create", name: " ", goal: "Invalid empty workgroup name." }),
    /Workgroup name must not be empty\./,
  );
  assert.equal(orchestra.buses.size, 0);

  const longName = "a".repeat(61);
  await assert.rejects(
    () => tool.execute({ action: "create", name: longName, goal: "Invalid long workgroup name." }),
    /Workgroup name must be 60 characters or fewer\./,
  );
  assert.equal(orchestra.buses.size, 0);

  await tool.execute({ action: "create", name: "duplicate-workgroup", goal: "Create once." });
  await assert.rejects(
    () => tool.execute({ action: "create", name: "duplicate-workgroup", goal: "Create twice." }),
    /Workgroup name "duplicate-workgroup" is already in use\./,
  );
  assert.deepEqual([...orchestra.buses.keys()], ["duplicate-workgroup-bus"]);
});

test("workgroup member name checks are global", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const otherBus = orchestra.createBus({ name: "other-work" });
  orchestra.runs.set("security-review", {
    id: "security-review",
    name: "security-review",
    profile: securityProfile,
    task: "Existing work.",
    busId: otherBus.id,
    sessionFile: ".pi/orchestra/sessions/security-review.jsonl",
    state: "closed",
    result: null,
  });

  const created = await tool.execute({
    action: "create",
    name: "target-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);

  await assert.rejects(
    () =>
      tool.execute({
        action: "add_members",
        id: workgroup.id,
        members: [
          {
            name: "security-review",
            profile: securityProfile,
            task: "Review security.",
          },
        ],
      }),
    /Workgroup member name "security-review" is already in use\./,
  );
});

test("workgroup finish closes members and the bus and records final output", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "auth-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "security-review",
        profile: securityProfile,
        task: "Review security.",
      },
      {
        name: "backend-review",
        profile: backendProfile,
        task: "Review backend.",
      },
    ],
  });

  const output = await tool.execute({
    action: "finish",
    id: requireCreatedWorkgroupId(created),
    result: { status: "success", summary: "Auth refactor plan is ready.", data: { risk: "medium" } },
  });

  assert.equal(output.action, "finish");
  if (output.action !== "finish") throw new Error("Expected finish output.");
  assert.equal(output.workgroup.state, "closed");
  assert.deepEqual(output.workgroup.result, {
    status: "success",
    summary: "Auth refactor plan is ready.",
    data: { risk: "medium" },
  });
  assert.equal("bus" in output, false);
  assert.equal("message" in output, false);
  assert.equal(orchestra.getBus(workgroup.busId)?.state, "closed");
  assert.deepEqual(orchestra.closedIds, ["security-review", "backend-review"]);
  assert.equal(orchestra.runs.get("security-review")?.state, "closed");
  assert.equal(orchestra.runs.get("backend-review")?.state, "closed");
});

test("workgroup cancel disposes members, bus, and leader", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "blocked-work-workgroup",
    goal: "Cancel the group when blocked.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const added = await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "security-review",
        profile: securityProfile,
        task: "Review security.",
      },
      {
        name: "backend-review",
        profile: backendProfile,
        task: "Review backend.",
      },
    ],
  });
  assertMembersAdded(added);

  orchestra.runs.set("workgroup-lead", {
    id: "workgroup-lead",
    name: "workgroup-lead",
    profile: securityProfile,
    task: "Lead the group.",
    busId: workgroup.busId,
    sessionFile: ".pi/orchestra/sessions/workgroup-lead.jsonl",
    state: "running",
    result: null,
  });
  orchestra.store.saveWorkgroup({ ...added.workgroup, leaderRunId: "workgroup-lead" });

  const output = await tool.execute({ action: "cancel", id: workgroup.id });

  assert.equal(output.action, "cancel");
  if (output.action !== "cancel") throw new Error("Expected cancel output.");
  assert.equal(output.alreadyClosed, false);
  assert.equal(output.workgroup.state, "closed");
  assert.deepEqual(output.workgroup.result, {
    status: "blocked",
    summary: "Workgroup cancelled.",
  });
  assert.equal(
    output.message,
    [
      "Cancelled workgroup blocked-work-workgroup.",
      "",
      "Status: blocked",
      "Summary: Workgroup cancelled.",
      "",
      "Pi-orchestra recorded the final output and will deliver any applicable workgroup.finished event.",
    ].join("\n"),
  );
  assert.equal(orchestra.getBus(workgroup.busId)?.state, "closed");
  assert.deepEqual(orchestra.closedIds, ["security-review", "backend-review", "workgroup-lead"]);
  assert.equal(orchestra.runs.get("security-review")?.state, "closed");
  assert.equal(orchestra.runs.get("backend-review")?.state, "closed");
  assert.equal(orchestra.runs.get("workgroup-lead")?.state, "closed");
});

test("workgroup cancel completes cleanup for closing workgroups", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "cleanup-work-workgroup",
    goal: "Resume cleanup for a closing group.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const added = await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "cleanup-review",
        profile: securityProfile,
        task: "Review cleanup.",
      },
    ],
  });
  assertMembersAdded(added);

  orchestra.runs.set("cleanup-lead", {
    id: "cleanup-lead",
    name: "cleanup-lead",
    profile: securityProfile,
    task: "Lead cleanup.",
    busId: workgroup.busId,
    sessionFile: ".pi/orchestra/sessions/cleanup-lead.jsonl",
    state: "running",
    result: null,
  });
  orchestra.store.saveWorkgroup({ ...added.workgroup, leaderRunId: "cleanup-lead", state: "closing" });

  const output = await tool.execute({ action: "cancel", id: workgroup.id });

  assert.equal(output.action, "cancel");
  if (output.action !== "cancel") throw new Error("Expected cancel output.");
  assert.equal(output.alreadyClosed, false);
  assert.equal(output.workgroup.state, "closed");
  assert.equal(orchestra.getBus(workgroup.busId)?.state, "closed");
  assert.deepEqual(orchestra.closedIds, ["cleanup-review", "cleanup-lead"]);
});

test("workgroup cancel preserves already finished results", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "finished-work-workgroup",
    goal: "Finish before cancellation is requested.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "finish",
    id: workgroup.id,
    result: { status: "success", summary: "Workgroup already completed." },
  });

  const output = await tool.execute({ action: "cancel", id: workgroup.id });

  assert.equal(output.action, "cancel");
  if (output.action !== "cancel") throw new Error("Expected cancel output.");
  assert.equal(output.alreadyClosed, true);
  assert.deepEqual(output.workgroup.result, { status: "success", summary: "Workgroup already completed." });
  assert.equal(
    output.message,
    [
      "Workgroup finished-work-workgroup was already closed.",
      "",
      "Status: success",
      "Summary: Workgroup already completed.",
      "",
      "No cancellation was needed; existing result was preserved.",
    ].join("\n"),
  );
  assert.equal(orchestra.getBus(workgroup.busId)?.state, "closed");
});

test("workgroup rejects adding members after finish", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "auth-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "finish",
    id: workgroup.id,
    result: { status: "blocked", summary: "No useful path found." },
  });

  await assert.rejects(
    () =>
      tool.execute({
        action: "add_members",
        id: workgroup.id,
        members: [
          {
            name: "late-review",
            profile: securityProfile,
            task: "Review security.",
          },
        ],
      }),
    /Workgroup auth-work-workgroup is closed\./,
  );
});

test("workgroup closes successfully spawned members when launch is incomplete", async () => {
  const orchestra = new FakeOrchestra();
  const eventOrder: string[] = [];
  orchestra.onClose = (id) => eventOrder.push(`close:${id}`);
  const tool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    onWorkgroupLaunchFailed: () => eventOrder.push("launch_failed"),
  });

  const created = await tool.execute({
    action: "create",
    name: "auth-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);

  await assert.rejects(
    () =>
      tool.execute({
        action: "add_members",
        id: workgroup.id,
        members: [
          {
            name: "security-review",
            profile: securityProfile,
            task: "Review security.",
          },
          {
            name: "broken-review",
            profile: brokenProfile,
            task: "Trigger spawn failure.",
          },
        ],
      }),
    /Failed to launch every workgroup member\./,
  );

  assert.deepEqual(eventOrder, ["launch_failed", "close:security-review"]);
  assert.deepEqual(orchestra.closedIds, ["security-review"]);
  assert.equal(orchestra.runs.get("security-review")?.state, "closed");
});

test("workgroup add_members does not resurrect a workgroup closed during member launch", async () => {
  const orchestra = new FakeOrchestra();
  const spawnStarted = createDeferred();
  const spawnDelay = createDeferred();
  const launchFailedRunIds: string[][] = [];
  orchestra.onSpawnStarted = () => spawnStarted.resolve();
  orchestra.spawnDelay = spawnDelay.promise;
  const tool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    onWorkgroupLaunchFailed: ({ runIds }) => launchFailedRunIds.push(runIds),
  });

  const created = await tool.execute({
    action: "create",
    name: "race-work-workgroup",
    goal: "Close while launch is pending.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const addTask = tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [{ name: "late-member", profile: securityProfile, task: "Start after closure." }],
  });
  await spawnStarted.promise;

  await tool.execute({ action: "cancel", id: workgroup.id });
  spawnDelay.resolve();

  await assert.rejects(addTask, /Workgroup race-work-workgroup is closed\./);
  assert.equal(orchestra.store.getWorkgroup(workgroup.id)?.state, "closed");
  assert.deepEqual(orchestra.store.getWorkgroup(workgroup.id)?.memberRunIds, []);
  assert.deepEqual(orchestra.closedIds, ["late-member"]);
  assert.equal(orchestra.runs.get("late-member")?.state, "closed");
  assert.deepEqual(launchFailedRunIds, [["late-member"]]);
});

test("workgroup add_members merges member ids from concurrent launches", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const created = await tool.execute({
    action: "create",
    name: "merge-work-workgroup",
    goal: "Merge concurrent additions.",
  });
  const workgroup = requireCreatedWorkgroup(created);

  await Promise.all([
    tool.execute({
      action: "add_members",
      id: workgroup.id,
      members: [{ name: "first-member", profile: securityProfile, task: "Do the first part." }],
    }),
    tool.execute({
      action: "add_members",
      id: workgroup.id,
      members: [{ name: "second-member", profile: backendProfile, task: "Do the second part." }],
    }),
  ]);

  assert.deepEqual(
    new Set(orchestra.store.getWorkgroup(workgroup.id)?.memberRunIds),
    new Set(["first-member", "second-member"]),
  );
});

function assertUuid7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function requireCreatedWorkgroupId(output: WorkgroupOutput): string {
  return requireCreatedWorkgroup(output).id;
}

function requireCreatedWorkgroup(output: WorkgroupOutput): WorkgroupRun {
  assert.equal(output.action, "create");
  if (output.action !== "create") throw new Error("Expected created workgroup output.");
  return output.workgroup;
}

function requireBus(orchestra: FakeOrchestra, id: string): Bus {
  const bus = orchestra.getBus(id);
  assert.ok(bus);
  return bus;
}

function assertMembersAdded(
  output: WorkgroupOutput,
): asserts output is Extract<WorkgroupOutput, { action: "add_members" }> {
  assert.equal(output.action, "add_members");
}

class FakeOrchestra implements OrchestraApi {
  store = new InMemoryAgentStore();
  buses = new Map<string, Bus>();
  runs = new SyncedRunMap(this.store);
  spawned: Array<{ profile: AgentProfile; task: string; busId: string; options: { name: string | undefined } }> = [];
  closedIds: string[] = [];
  spawnDelay: Promise<void> | undefined;
  onClose: ((id: string) => void) | undefined;
  onSpawnStarted: (() => void) | undefined;

  createBus(options: { name: string | undefined }): Bus {
    const id = options.name ?? `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: options.name ?? id, state: "open", messages: [] };
    this.buses.set(bus.id, bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id) ?? [...this.buses.values()].find((bus) => bus.name === id);
  }

  closeBus(id: string): Bus | undefined {
    const bus = this.getBus(id);
    if (!bus) return undefined;
    const closedBus: Bus = { ...bus, state: "closed" };
    this.buses.set(bus.id, closedBus);
    return closedBus;
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
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
    options: { name: string | undefined },
  ): Promise<AgentRun> {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);
    if (profile.name === "broken") throw new Error("Spawn failed.");

    this.onSpawnStarted?.();
    if (this.spawnDelay) await this.spawnDelay;

    this.spawned.push({ profile, task, busId: bus.id, options });
    const name = options.name ?? profile.name;
    const id = slugify(name);
    const run: AgentRun = {
      id,
      name,
      profile,
      task,
      busId: bus.id,
      state: "running",
      sessionFile: `.pi/orchestra/sessions/${id}.jsonl`,
      result: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(id: string, _options: { busId: string | undefined }): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(options: { busId: string | undefined }): AgentRun[] {
    const runs = [...this.runs.values()];
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async messageAgent(id: string, _message: string, _options: { busId: string | undefined }): Promise<AgentRun> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  async closeAgent(id: string, _options: { busId: string | undefined }): Promise<AgentRun | undefined> {
    this.closedIds.push(id);
    this.onClose?.(id);
    const run = this.runs.get(id);
    if (!run) return undefined;

    const closedRun = { ...run, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
  }
}

function createDeferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class SyncedRunMap extends Map<string, AgentRun> {
  constructor(private readonly store: InMemoryAgentStore) {
    super();
  }

  set(key: string, value: AgentRun): this {
    this.store.saveRun(value);
    return super.set(key, value);
  }
}
