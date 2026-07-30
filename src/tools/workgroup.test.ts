import assert from "node:assert/strict";
import { test } from "vitest";
import { buildAgentRun } from "../../tests/helpers/agent-run-fixture.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { OrchestraApi, PublishedBusMessage } from "../core/orchestra.ts";
import { slugify } from "../utils.ts";
import {
  closeWorkgroupRun,
  createWorkgroupTool,
  defineWorkgroupPiTool,
  type WorkgroupOutput,
  type WorkgroupToolDeps,
} from "./workgroup.ts";

const securityProfile: AgentProfile = {
  name: "security",
  systemPrompt: "Review security risks.",
  tools: ["read", "bash"],
  model: undefined,
  thinkingLevel: undefined,
};

const backendProfile: AgentProfile = {
  name: "backend",
  systemPrompt: "Review backend design.",
  tools: ["read", "bash"],
  model: undefined,
  thinkingLevel: undefined,
};

const brokenProfile: AgentProfile = {
  name: "broken",
  systemPrompt: "Fail during spawn.",
  tools: ["read", "bash"],
  model: undefined,
  thinkingLevel: undefined,
};

function workgroupDeps(orchestra: OrchestraApi & { store: InMemoryAgentStore }): WorkgroupToolDeps {
  return {
    orchestra,
    store: orchestra.store,
    parentRunId: null,
    ownerSessionId: "session-1",
    resolveAgentHealth: undefined,
    onWorkgroupLaunching: undefined,
    onWorkgroupLaunched: undefined,
    onWorkgroupLaunchFailed: undefined,
  };
}

test("workgroup create records the creating child run as leader", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-child-leader",
    ownerSessionId: "session-1",
  });

  const created = await tool.execute({ action: "create", name: "child-led", goal: "Coordinate child work." });

  assert.equal(requireCreatedWorkgroup(created).leaderRunId, "agent-child-leader");
});

test("workgroup lookup prefers live prefixed records over closed legacy ids", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  orchestra.buses.set("closed-bus", {
    id: "closed-bus",
    name: "closed-bus",
    state: "closed",
    messages: [],
    nextMessageSeq: 1,
  });
  orchestra.buses.set("live-bus", { id: "live-bus", name: "live-bus", state: "open", messages: [], nextMessageSeq: 1 });
  orchestra.store.saveWorkgroup({
    id: "review",
    name: "review",
    busId: "closed-bus",
    goal: "Closed legacy group.",
    leaderRunId: null,
    memberRunIds: [],
    state: "closed",
    result: null,
    ownerSessionId: "session-1",
    createdAtMs: 1,
  });
  const live: WorkgroupRun = {
    id: "live",
    name: "group-review",
    busId: "live-bus",
    goal: "Live group.",
    leaderRunId: null,
    memberRunIds: [],
    state: "running",
    result: null,
    ownerSessionId: "session-1",
    createdAtMs: 2,
  };
  orchestra.store.saveWorkgroup(live);

  const output = await tool.execute({ action: "status", id: "review" });

  assert.equal(output.action, "status");
  assert.equal(output.workgroup?.id, live.id);
});

test("workgroup status and cancel allow main/root recovery while preserving leader mutations", async () => {
  const orchestra = new FakeOrchestra();
  orchestra.runs.set("agent-flow-lead", agentRun({ id: "agent-flow-lead", name: "agent-flow-lead" }));
  orchestra.runs.set(
    "agent-group-lead",
    agentRun({
      id: "agent-group-lead",
      name: "agent-group-lead",
      parentRunId: "agent-flow-lead",
      ownerSessionId: "session-1",
    }),
  );
  const leaderTool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-group-lead",
    ownerSessionId: "session-1",
  });
  const supervisorTool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-flow-lead",
    ownerSessionId: "session-1",
  });
  const rootTool = createWorkgroupTool(workgroupDeps(orchestra));
  const strangerTool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-stranger",
    ownerSessionId: "session-1",
  });
  const created = await leaderTool.execute({ action: "create", name: "child-led", goal: "Coordinate child work." });
  const workgroup = requireCreatedWorkgroup(created);

  assert.equal((await rootTool.execute({ action: "status", id: workgroup.id })).action, "status");
  assert.equal((await leaderTool.execute({ action: "status", id: workgroup.id })).action, "status");
  assert.equal((await supervisorTool.execute({ action: "status", id: workgroup.id })).action, "status");
  await assert.rejects(
    () => strangerTool.execute({ action: "status", id: workgroup.id }),
    /Only a supervising parent can status workgroup group-child-led\./,
  );
  await assert.rejects(
    () =>
      strangerTool.execute({
        action: "add_members",
        id: workgroup.id,
        members: [{ name: "agent-stranger-member", profile: securityProfile, task: "Should not launch." }],
      }),
    /Only leader agent-group-lead can add_members workgroup group-child-led\./,
  );
  await assert.rejects(
    () =>
      rootTool.execute({
        action: "add_members",
        id: workgroup.id,
        members: [{ name: "agent-main-member", profile: securityProfile, task: "Should not launch." }],
      }),
    /Only leader agent-group-lead can add_members workgroup group-child-led\./,
  );
  await assert.rejects(
    () => strangerTool.execute({ action: "finish", id: workgroup.id, result: { status: "success", summary: "Done." } }),
    /Only leader agent-group-lead can finish workgroup group-child-led\./,
  );
  await assert.rejects(
    () => rootTool.execute({ action: "finish", id: workgroup.id, result: { status: "success", summary: "Done." } }),
    /Only leader agent-group-lead can finish workgroup group-child-led\./,
  );
  await assert.rejects(
    () => leaderTool.execute({ action: "cancel", id: workgroup.id }),
    /Only a supervising parent can cancel workgroup group-child-led\./,
  );
  await assert.rejects(
    () => strangerTool.execute({ action: "cancel", id: workgroup.id }),
    /Only a supervising parent can cancel workgroup group-child-led\./,
  );

  const cancelOutput = await rootTool.execute({ action: "cancel", id: workgroup.id });
  assert.equal(cancelOutput.action, "cancel");
  assert.equal(cancelOutput.workgroup.state, "closed");
  assert.equal(orchestra.runs.get("agent-flow-lead")?.state, "running");
});

test("main/root can recover status and cancel when child leader run is missing", async () => {
  const orchestra = new FakeOrchestra();
  const rootTool = createWorkgroupTool(workgroupDeps(orchestra));
  const strangerTool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-stranger",
    ownerSessionId: "session-1",
  });
  orchestra.buses.set("bus-child-led", {
    id: "bus-child-led",
    name: "bus-child-led",
    state: "open",
    messages: [],
    nextMessageSeq: 1,
  });
  orchestra.store.saveBus({
    id: "bus-child-led",
    name: "bus-child-led",
    state: "open",
    messages: [],
    nextMessageSeq: 1,
  });
  orchestra.store.saveWorkgroup({
    id: "group-child-led",
    name: "group-child-led",
    busId: "bus-child-led",
    goal: "Child-led workgroup.",
    leaderRunId: "missing-leader",
    memberRunIds: [],
    state: "running",
    result: null,
    ownerSessionId: "session-1",
    createdAtMs: 1_700_000_000_000,
  });

  assert.equal((await rootTool.execute({ action: "status", id: "group-child-led" })).action, "status");
  await assert.rejects(
    () => strangerTool.execute({ action: "status", id: "group-child-led" }),
    /Only a supervising parent can status workgroup group-child-led\./,
  );
  await assert.rejects(
    () => strangerTool.execute({ action: "cancel", id: "group-child-led" }),
    /Only a supervising parent can cancel workgroup group-child-led\./,
  );
  const cancelOutput = await rootTool.execute({ action: "cancel", id: "group-child-led" });
  assert.equal(cancelOutput.action, "cancel");
  assert.equal(orchestra.store.getWorkgroup("group-child-led")?.state, "closed");
});

test("main/root can recover orphaned child-led workgroup while sibling remains unauthorized", async () => {
  const orchestra = new FakeOrchestra();
  orchestra.createBus({ name: "bus-orphan-workgroup" });
  orchestra.store.saveWorkgroup({
    id: "group-orphan",
    name: "group-orphan",
    busId: "bus-orphan-workgroup",
    goal: "Orphaned child workgroup.",
    leaderRunId: "agent-missing-group-lead",
    memberRunIds: [],
    state: "running",
    result: null,
    ownerSessionId: "session-1",
    createdAtMs: 1,
  });
  const rootTool = createWorkgroupTool(workgroupDeps(orchestra));
  const strangerTool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-stranger",
    ownerSessionId: "session-1",
  });

  assert.equal((await rootTool.execute({ action: "status", id: "group-orphan" })).action, "status");
  await assert.rejects(
    () => strangerTool.execute({ action: "status", id: "group-orphan" }),
    /Only a supervising parent can status workgroup group-orphan\./,
  );
  await assert.rejects(
    () => strangerTool.execute({ action: "cancel", id: "group-orphan" }),
    /Only a supervising parent can cancel workgroup group-orphan\./,
  );
  const cancelOutput = await rootTool.execute({ action: "cancel", id: "group-orphan" });
  assert.equal(cancelOutput.action, "cancel");
  assert.equal(orchestra.store.getWorkgroup("group-orphan")?.state, "closed");
});

test("workgroup member can read status but cannot mutate group", async () => {
  const orchestra = new FakeOrchestra();
  orchestra.createBus({ name: "bus-member-status" });
  orchestra.store.saveRun(
    agentRun({ id: "agent-leader", name: "agent-leader", busId: "bus-member-status", profile: backendProfile }),
  );
  orchestra.store.saveRun(
    agentRun({ id: "agent-member", name: "agent-member", busId: "bus-member-status", profile: backendProfile }),
  );
  orchestra.store.saveWorkgroup({
    id: "group-member-status",
    name: "group-member-status",
    busId: "bus-member-status",
    goal: "Member status access.",
    leaderRunId: "agent-leader",
    memberRunIds: ["agent-member"],
    state: "running",
    result: null,
    ownerSessionId: "session-1",
    createdAtMs: 1,
  });
  const memberTool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    parentRunId: "agent-member",
    ownerSessionId: "session-1",
  });

  assert.equal((await memberTool.execute({ action: "status", id: "group-member-status" })).action, "status");
  await assert.rejects(
    () =>
      memberTool.execute({
        action: "add_members",
        id: "group-member-status",
        members: [{ name: "extra", profile: backendProfile, task: "Do more work." }],
      }),
    /Only leader agent-leader can add_members workgroup group-member-status\./,
  );
  await assert.rejects(
    () =>
      memberTool.execute({
        action: "finish",
        id: "group-member-status",
        result: { status: "success", summary: "Done." },
      }),
    /Only leader agent-leader can finish workgroup group-member-status\./,
  );
  await assert.rejects(
    () => memberTool.execute({ action: "cancel", id: "group-member-status" }),
    /Only a supervising parent can cancel workgroup group-member-status\./,
  );
});

test("workgroup creates an internal bus and launches members on it", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "group-auth-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const bus = requireBus(orchestra, workgroup.busId);
  const output = await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "agent-security-review",
        profile: securityProfile,
        task: "Identify auth security risks.",
      },
      {
        name: "agent-backend-review",
        profile: backendProfile,
        task: "Assess API and data model changes.",
      },
    ],
  });

  assertMembersAdded(output);
  assert.equal(output.bus, bus);
  assert.equal(output.runs.length, 2);
  assertUuid(output.workgroup.id);
  assert.equal(output.workgroup.name, "group-auth-work-workgroup");
  assert.equal(output.workgroup.leaderRunId, null);
  assert.deepEqual(output.workgroup.memberRunIds, ["agent-security-review", "agent-backend-review"]);
  assert.deepEqual(orchestra.store.getWorkgroup(output.workgroup.id), output.workgroup);
  assert.deepEqual(
    orchestra.spawned.map((spawn) => ({ profile: spawn.profile, busId: spawn.busId, name: spawn.options?.name })),
    [
      { profile: securityProfile, busId: bus.id, name: "agent-security-review" },
      { profile: backendProfile, busId: bus.id, name: "agent-backend-review" },
    ],
  );
  assert.equal(orchestra.spawned[0]?.task, "Identify auth security risks.");
  assert.equal(
    output.message,
    [
      "Added 2 members to workgroup group-auth-work-workgroup on bus bus-group-auth-work-workgroup.",
      "",
      "Runs:",
      "- agent-security-review: running",
      "- agent-backend-review: running",
      "",
      "Pi-orchestra will deliver workgroup.member_finished events as members finish.",
    ].join("\n"),
  );
});

test("workgroup status shows member model and thinkingLevel", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const created = await tool.execute({
    action: "create",
    name: "model-debug-workgroup",
    goal: "Debug member model choices.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "agent-codex-mini-medium",
        profile: { ...backendProfile, model: "openai-codex/gpt-5.4-mini", thinkingLevel: "high" },
        task: "Inspect model selection.",
      },
    ],
  });

  const status = await tool.execute({ action: "status", id: workgroup.id });

  assert.equal(status.action, "status");
  assert.match(status.message, /- agent-codex-mini-medium: running — openai-codex\/gpt-5\.4-mini, thinking high/);
});

test("workgroup add_members forwards member profile.thinkingLevel to orchestra.spawnAgent", async () => {
  const orchestra = new FakeOrchestra();
  const tool = defineWorkgroupPiTool(() => createWorkgroupTool(workgroupDeps(orchestra)));

  await tool.execute(
    "call-create",
    {
      action: "create",
      name: "group-review",
      goal: "Review the change.",
    },
    new AbortController().signal,
    undefined,
    {} as never,
  );

  await tool.execute(
    "call-add-members",
    {
      action: "add_members",
      id: "group-review",
      members: [
        {
          name: "reviewer",
          task: "Review the change.",
          profile: {
            name: "reviewer",
            systemPrompt: "Review the change.",
            tools: ["read"],
            thinkingLevel: "low",
          },
        },
      ],
    },
    new AbortController().signal,
    undefined,
    {} as never,
  );

  assert.equal(orchestra.spawned.at(-1)?.profile.thinkingLevel, "low");
});

test("workgroup status reports member health", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool({
    ...workgroupDeps(orchestra),
    resolveAgentHealth: (runId) =>
      runId === "agent-health-check"
        ? { phase: "compacting", contextPercent: 92.6, finalError: "Context limit reached." }
        : undefined,
  });
  const created = await tool.execute({
    action: "create",
    name: "health-workgroup",
    goal: "Inspect member health.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [{ name: "health-check", profile: backendProfile, task: "Inspect health." }],
  });

  const status = await tool.execute({ action: "status", id: workgroup.id });

  assert.equal(status.action, "status");
  assert.match(
    status.message,
    /- agent-health-check: running — inherited model \[compacting ctx=93% error=Context limit reached\.\]/,
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
        name: "agent-backend-a",
        task: "Review backend changes from one angle.",
      },
      {
        profile: backendProfile,
        name: "agent-backend-b",
        task: "Review backend changes from another angle.",
      },
    ],
  });

  assertMembersAdded(output);
  assert.deepEqual(
    output.runs.map((run) => run.name),
    ["agent-backend-a", "agent-backend-b"],
  );
  assert.deepEqual(
    orchestra.spawned.map((spawn) => spawn.options?.name),
    ["agent-backend-a", "agent-backend-b"],
  );
});

test("workgroup Pi tool guidance reserves finish for leaders and cancel for supervisors", () => {
  const tool = defineWorkgroupPiTool(() => ({
    name: "workgroup",
    async execute() {
      throw new Error("not executed");
    },
  }));
  assert.ok(tool.promptGuidelines);
  const guidance = tool.promptGuidelines.join("\n");

  assert.match(guidance, /Only the workgroup leader calls workgroup finish/);
  assert.match(guidance, /workgroup cancel from a supervising parent scope/);
  assert.doesNotMatch(guidance, /leader calls workgroup cancel/i);
});

test("workgroup Pi details window member runs and preserve raw output data", async () => {
  const runs = Array.from({ length: 12 }, (_, index) =>
    agentRun({ id: `agent-${index + 1}`, name: `agent-${index + 1}` }),
  );
  const workgroup: WorkgroupRun = {
    id: "group-1",
    name: "group-1",
    busId: "bus-1",
    goal: "Coordinate.",
    leaderRunId: null,
    memberRunIds: runs.map((run) => run.id),
    state: "running",
    result: null,
    ownerSessionId: "session-1",
    createdAtMs: 1,
  };
  const bus: Bus = { id: "bus-1", name: "bus-1", state: "open", messages: [], nextMessageSeq: 1 };
  const rawOutput: WorkgroupOutput = { action: "status", workgroup, bus, runs, message: "status" };
  const tool = defineWorkgroupPiTool(() => ({
    name: "workgroup",
    async execute() {
      return rawOutput;
    },
  }));

  const output = await tool.execute(
    "call-1",
    { action: "status", id: workgroup.id },
    new AbortController().signal,
    undefined,
    {} as never,
  );

  const details = output.details as { runs: AgentRun[]; omittedRunsCount: number };
  assert.equal(details.runs.length, 10);
  assert.equal(details.omittedRunsCount, 2);
  assert.equal(rawOutput.runs.length, 12);
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
  assert.equal(output.workgroup.busId, "bus-group-new-workgroup");
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
    /Workgroup name "group-duplicate-workgroup" is already in use\./,
  );
  assert.deepEqual([...orchestra.buses.keys()], ["bus-group-duplicate-workgroup"]);
});

test("workgroup member name checks reserve finished revivable runs", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const otherBus = orchestra.createBus({ name: "other-work" });
  orchestra.runs.set(
    "agent-security-review",
    agentRun({
      id: "agent-security-review",
      name: "agent-security-review",
      busId: otherBus.id,
      state: "success",
      result: { status: "success", summary: "Done." },
    }),
  );

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
        members: [{ name: "security-review", profile: securityProfile, task: "Review security." }],
      }),
    /Workgroup member name "agent-security-review" is already in use\./,
  );
});

test("workgroup member name checks are global", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const otherBus = orchestra.createBus({ name: "other-work" });
  orchestra.runs.set("agent-security-review", {
    id: "agent-security-review",
    name: "agent-security-review",
    profile: securityProfile,
    task: "Existing work.",
    busId: otherBus.id,
    parentRunId: null,
    ownerSessionId: "session-1",
    state: "running",
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
            name: "agent-security-review",
            profile: securityProfile,
            task: "Review security.",
          },
        ],
      }),
    /Workgroup member name "agent-security-review" is already in use\./,
  );
});

test("workgroup finish closes members and the bus and records final output", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "group-auth-work-workgroup",
    goal: "Plan the auth refactor.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "agent-security-review",
        profile: securityProfile,
        task: "Review security.",
      },
      {
        name: "agent-backend-review",
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
  assert.deepEqual(orchestra.closedIds, ["agent-security-review", "agent-backend-review"]);
  assert.equal(orchestra.runs.get("agent-security-review")?.state, "closed");
  assert.equal(orchestra.runs.get("agent-backend-review")?.state, "closed");
});

test("workgroup cancel disposes members, bus, and leader", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "group-blocked-work-workgroup",
    goal: "Cancel the group when blocked.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const added = await tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [
      {
        name: "agent-security-review",
        profile: securityProfile,
        task: "Review security.",
      },
      {
        name: "agent-backend-review",
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
    parentRunId: null,
    ownerSessionId: "session-1",
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
      "Cancelled workgroup group-blocked-work-workgroup.",
      "",
      "Status: blocked",
      "Summary: Workgroup cancelled.",
      "",
      "Pi-orchestra recorded the final output and will deliver any applicable workgroup.finished event.",
    ].join("\n"),
  );
  assert.equal(orchestra.getBus(workgroup.busId)?.state, "closed");
  assert.deepEqual(orchestra.closedIds, ["agent-security-review", "agent-backend-review", "workgroup-lead"]);
  assert.equal(orchestra.runs.get("agent-security-review")?.state, "closed");
  assert.equal(orchestra.runs.get("agent-backend-review")?.state, "closed");
  assert.equal(orchestra.runs.get("workgroup-lead")?.state, "closed");
});

test("workgroup cancel spares an external creator leader on its own bus", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const created = await tool.execute({
    action: "create",
    name: "external-leader-workgroup",
    goal: "Cancel without killing the creator.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const member = agentRun({ id: "agent-member", name: "agent-member", busId: workgroup.busId, parentRunId: "creator" });
  const creator = agentRun({ id: "creator", name: "creator", busId: "creator-bus", parentRunId: null });
  orchestra.runs.set(member.id, member);
  orchestra.runs.set(creator.id, creator);
  orchestra.store.saveRun(member);
  orchestra.store.saveRun(creator);
  orchestra.store.saveWorkgroup({ ...workgroup, leaderRunId: creator.id, memberRunIds: [member.id] });
  const supervisorTool = createWorkgroupTool(workgroupDeps(orchestra));

  const output = await supervisorTool.execute({ action: "cancel", id: workgroup.id });

  assert.equal(output.action, "cancel");
  assert.deepEqual(orchestra.closedIds, ["agent-member"]);
  assert.equal(orchestra.runs.get("creator")?.state, "running");
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
        name: "agent-cleanup-review",
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
    parentRunId: null,
    ownerSessionId: "session-1",
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
  assert.deepEqual(orchestra.closedIds, ["agent-cleanup-review", "cleanup-lead"]);
});

test("workgroup close cleans up runs added during cleanup", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));
  const closeDelay = createDeferred();
  const created = await tool.execute({
    action: "create",
    name: "late-cleanup-workgroup",
    goal: "Close runs that appear during cleanup.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const initialRun = agentRun({ id: "initial-member", name: "initial-member", busId: workgroup.busId });
  const lateLeaderRun = agentRun({ id: "late-leader", name: "late-leader", busId: workgroup.busId });
  orchestra.runs.set(initialRun.id, initialRun);
  orchestra.runs.set(lateLeaderRun.id, lateLeaderRun);
  orchestra.store.saveWorkgroup({ ...workgroup, memberRunIds: [initialRun.id] });
  orchestra.closeDelay = closeDelay.promise;
  orchestra.onClose = (id) => {
    if (id !== initialRun.id) return;
    const latestWorkgroup = orchestra.store.getWorkgroup(workgroup.id);
    assert.ok(latestWorkgroup);
    orchestra.store.saveWorkgroup({ ...latestWorkgroup, leaderRunId: lateLeaderRun.id });
    closeDelay.resolve();
  };

  const closedWorkgroup = await closeWorkgroupRun(
    orchestra,
    orchestra.store,
    requireWorkgroup(orchestra, workgroup.id),
    {
      includeLeader: true,
      result: { status: "blocked", summary: "Stopping." },
    },
  );

  assert.equal(closedWorkgroup.state, "closed");
  assert.equal(closedWorkgroup.leaderRunId, lateLeaderRun.id);
  assert.deepEqual(orchestra.closedIds, [initialRun.id, lateLeaderRun.id]);
  assert.equal(orchestra.runs.get(initialRun.id)?.state, "closed");
  assert.equal(orchestra.runs.get(lateLeaderRun.id)?.state, "closed");
});

test("workgroup cancel preserves already finished results", async () => {
  const orchestra = new FakeOrchestra();
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  const created = await tool.execute({
    action: "create",
    name: "group-finished-work-workgroup",
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
      "Workgroup group-finished-work-workgroup was already closed.",
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
    name: "group-auth-work-workgroup",
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
    /Workgroup group-auth-work-workgroup is closed\./,
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
    name: "group-auth-work-workgroup",
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
            name: "agent-security-review",
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

  assert.deepEqual(eventOrder, ["launch_failed", "close:agent-security-review"]);
  assert.deepEqual(orchestra.closedIds, ["agent-security-review"]);
  assert.equal(orchestra.runs.get("agent-security-review")?.state, "closed");
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
    name: "group-race-work-workgroup",
    goal: "Close while launch is pending.",
  });
  const workgroup = requireCreatedWorkgroup(created);
  const addTask = tool.execute({
    action: "add_members",
    id: workgroup.id,
    members: [{ name: "agent-late-member", profile: securityProfile, task: "Start after closure." }],
  });
  await spawnStarted.promise;

  await tool.execute({ action: "cancel", id: workgroup.id });
  spawnDelay.resolve();

  await assert.rejects(addTask, /Workgroup group-race-work-workgroup is closed\./);
  assert.equal(orchestra.store.getWorkgroup(workgroup.id)?.state, "closed");
  assert.deepEqual(orchestra.store.getWorkgroup(workgroup.id)?.memberRunIds, []);
  assert.deepEqual(orchestra.closedIds, ["agent-late-member"]);
  assert.equal(orchestra.runs.get("agent-late-member")?.state, "closed");
  assert.deepEqual(launchFailedRunIds, [["agent-late-member"]]);
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
      members: [{ name: "agent-first-member", profile: securityProfile, task: "Do the first part." }],
    }),
    tool.execute({
      action: "add_members",
      id: workgroup.id,
      members: [{ name: "agent-second-member", profile: backendProfile, task: "Do the second part." }],
    }),
  ]);

  assert.deepEqual(
    new Set(orchestra.store.getWorkgroup(workgroup.id)?.memberRunIds),
    new Set(["agent-first-member", "agent-second-member"]),
  );
});

test("workgroup create closes internal bus when persisting the workgroup fails", async () => {
  const orchestra = new FakeOrchestra();
  orchestra.store = new SaveWorkgroupFailureStore();
  orchestra.runs = new SyncedRunMap(orchestra.store);
  const tool = createWorkgroupTool(workgroupDeps(orchestra));

  await assert.rejects(
    () => tool.execute({ action: "create", name: "persist-fails", goal: "Exercise rollback." }),
    /save workgroup failed/,
  );

  assert.equal(orchestra.getBus("bus-group-persist-fails")?.state, "closed");
  assert.deepEqual(orchestra.store.listWorkgroups(), []);
});

class SaveWorkgroupFailureStore extends InMemoryAgentStore {
  override saveWorkgroup(_workgroup: WorkgroupRun): void {
    throw new Error("save workgroup failed.");
  }
}

function assertUuid(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
  spawned: Array<{
    profile: AgentProfile;
    task: string;
    busId: string;
    options: { name: string | undefined; parentRunId: string | null; ownerSessionId: "session-1" };
  }> = [];
  closedIds: string[] = [];
  spawnDelay: Promise<void> | undefined;
  closeDelay: Promise<void> | undefined;
  onClose: ((id: string) => void) | undefined;
  onSpawnStarted: (() => void) | undefined;

  createBus(options: { name: string | undefined }): Bus {
    const id = options.name ?? `bus-${this.buses.size + 1}`;
    const bus: Bus = { id, name: options.name ?? id, state: "open", messages: [], nextMessageSeq: 1 };
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
    const busMessage: BusMessage = { id: `message-${bus.messages.length + 1}`, seq: bus.nextMessageSeq, message, from };
    bus.nextMessageSeq += 1;
    bus.messages.push(busMessage);
    return { bus, busMessage };
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: { name: string | undefined; parentRunId: string | null; ownerSessionId: "session-1" },
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
      parentRunId: options.parentRunId,
      state: "running",
      ownerSessionId: "session-1",
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
    if (this.closeDelay) await this.closeDelay;

    const run = this.runs.get(id);
    if (!run) return undefined;

    const closedRun = { ...run, state: "closed" as const };
    this.runs.set(id, closedRun);
    return closedRun;
  }
}

function requireWorkgroup(orchestra: FakeOrchestra, id: string): WorkgroupRun {
  const workgroup = orchestra.store.getWorkgroup(id);
  assert.ok(workgroup);
  return workgroup;
}

function agentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return buildAgentRun({
    id,
    name: overrides.name ?? id,
    profile: overrides.profile ?? securityProfile,
    task: overrides.task ?? "Inspect the code.",
    busId: overrides.busId ?? "bus-1",
    state: "running",
    ...overrides,
    parentRunId: overrides.parentRunId ?? null,
    result: overrides.result ?? null,
    ownerSessionId: overrides.ownerSessionId ?? "session-1",
  });
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
