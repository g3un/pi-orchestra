import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { buildOrchestraMonitorLines, OrchestraMonitorController } from "./orchestra-monitor.ts";

const STARTED_AT_MS = 1_700_000_000_000;
const MONITOR_NOW_MS = STARTED_AT_MS + 10_000;
const MONITOR_OPTIONS = { now: () => MONITOR_NOW_MS, resolveAgentHealth: undefined, tickMs: 0 };

test("orchestra monitor shows root scopes without duplicating workflow and workgroup children", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "flow-leader", busId: "workflow-bus" }));
  store.saveRun(run({ id: "group-leader", busId: "workflow-group-bus" }));
  store.saveRun(run({ id: "collector", busId: "workflow-group-bus" }));
  store.saveRun(
    run({
      id: "critic",
      busId: "workflow-group-bus",
      state: "success",
      result: { status: "success", summary: "Done." },
    }),
  );
  store.saveRun(run({ id: "standalone-member", busId: "standalone-group-bus" }));
  store.saveRun(run({ id: "standalone-agent", busId: "standalone-bus", profileName: "code-reviewer" }));
  store.saveWorkgroup(
    workgroupRun({
      id: "workflow-group",
      name: "workflow-group",
      busId: "workflow-group-bus",
      leaderRunId: "group-leader",
      memberRunIds: ["collector", "critic"],
    }),
  );
  store.saveWorkgroup(
    workgroupRun({
      id: "standalone-group",
      name: "standalone-group",
      busId: "standalone-group-bus",
      memberRunIds: ["standalone-member"],
      goal: "Review the API.",
    }),
  );
  store.saveWorkflow(
    workflowRun({
      name: "research-flow",
      coordinatorRunId: "flow-leader",
      workgroupIds: ["workflow-group"],
      goal: "Comparing findings.",
    }),
  );

  assert.deepEqual(buildOrchestraMonitorLines(store, MONITOR_NOW_MS), [
    "FLOW   research-flow [10s] | groups 0/1 | agents 1/4 | Comparing findings.",
    "GROUP  standalone-group [10s] | agents 0/1 | Review the API.",
    "AGENT  standalone-agent | code-reviewer | Inspect the code.",
  ]);
});

test("orchestra monitor limits its height before resolving health", () => {
  const store = new InMemoryAgentStore();
  for (let index = 1; index <= 5; index++) {
    store.saveRun(run({ id: `agent-${index}`, busId: `bus-${index}` }));
  }
  let healthCalls = 0;

  const lines = buildOrchestraMonitorLines(store, MONITOR_NOW_MS, () => {
    healthCalls++;
    return { phase: "active" };
  });

  assert.deepEqual(lines, [
    "AGENT  agent-1 | researcher | Inspect the code.",
    "AGENT  agent-2 | researcher | Inspect the code.",
    "AGENT  agent-3 | researcher | Inspect the code.",
    "       +2 more active scopes",
  ]);
  assert.equal(healthCalls, 3);
});

test("orchestra monitor omits failures for waiting agents", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "waiting-agent", busId: "waiting-group-bus" }));
  store.saveWorkgroup(
    workgroupRun({
      id: "waiting-group",
      name: "waiting-group",
      busId: "waiting-group-bus",
      memberRunIds: ["waiting-agent"],
    }),
  );

  const lines = buildOrchestraMonitorLines(store, MONITOR_NOW_MS, () => ({ phase: "waiting" }));

  assert.match(lines[0] ?? "", /\[health waiting=1\]/);
  assert.doesNotMatch(lines[0] ?? "", /failures=/);
});

test("orchestra monitor adds bounded standalone and aggregate health", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run({ id: "healthy-agent", busId: "health-bus" }));
  store.saveRun(run({ id: "group-agent", busId: "health-group-bus" }));
  store.saveRun(
    run({
      id: "failed-group-agent",
      busId: "health-group-bus",
      state: "failed",
      result: { status: "failed", summary: "Provider failed." },
    }),
  );
  store.saveWorkgroup(
    workgroupRun({
      id: "health-group",
      name: "health-group",
      busId: "health-group-bus",
      memberRunIds: ["group-agent", "failed-group-agent"],
    }),
  );
  const resolveHealth = (id: string) =>
    id === "healthy-agent"
      ? {
          phase: "active" as const,
          contextPercent: 50,
          finalError: "provider failure ".repeat(30),
        }
      : id === "group-agent"
        ? { phase: "retrying" as const, contextPercent: 80 }
        : undefined;

  const lines = buildOrchestraMonitorLines(store, MONITOR_NOW_MS, resolveHealth);
  assert.match(lines[0] ?? "", /\[health retrying=1 failures=1 ctx<=80%\]/);
  assert.match(lines[1] ?? "", /\[ctx=50% error=provider failure/);
  assert.ok((lines[1]?.length ?? 0) < 220);
});

test("orchestra monitor shows closing state and omits closed scopes", () => {
  const store = new InMemoryAgentStore();
  store.saveWorkgroup(workgroupRun({ id: "closing-group", name: "closing-group", state: "closing" }));
  store.saveWorkflow(workflowRun({ id: "closed-flow", name: "closed-flow", state: "closed" }));

  assert.deepEqual(buildOrchestraMonitorLines(store, MONITOR_NOW_MS), [
    "GROUP  closing-group [10s] | agents 0/0 | closing",
  ]);
});

test("orchestra monitor controller updates and clears the widget when work finishes", async () => {
  const store = new InMemoryAgentStore();
  const agent = run({ id: "reviewer", busId: "review-bus" });
  store.saveRun(agent);
  const widgets: Array<string[] | undefined> = [];
  const monitor = new OrchestraMonitorController(store, MONITOR_OPTIONS);

  assert.equal(monitor.show(monitorContext(widgets)), true);
  assert.deepEqual(widgets[0], [" AGENT  reviewer | researcher | Inspect the code."]);

  store.saveRun({
    ...agent,
    state: "success",
    result: { status: "success", summary: "Done." },
  });
  await flushMicrotasks();

  assert.equal(widgets.at(-1), undefined);
});

test("orchestra monitor truncates every scope to one terminal line", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(
    run({
      id: "매우-긴-검토-에이전트-이름",
      name: "매우-긴-검토-에이전트-이름",
      task: "Inspect every authentication path.\nThen review authorization in the repository.",
    }),
  );
  const widgets: Array<string[] | undefined> = [];
  const monitor = new OrchestraMonitorController(store, MONITOR_OPTIONS);

  assert.equal(monitor.show(monitorContext(widgets, [], 36)), true);
  assert.equal(widgets[0]?.length, 1);
  assert.doesNotMatch(widgets[0]?.[0] ?? "", /\r|\n/);
  assert.ok(visibleWidth(widgets[0]?.[0] ?? "") <= 36);
});

test("orchestra monitor reports and stops when a coalesced render throws", async () => {
  const store = new ThrowingStore();
  const agent = run({ id: "reviewer" });
  store.saveRun(agent);
  const widgets: Array<string[] | undefined> = [];
  const notifications: string[] = [];
  const monitor = new OrchestraMonitorController(store, MONITOR_OPTIONS);

  assert.equal(monitor.show(monitorContext(widgets, notifications)), true);
  store.throwOnList = true;
  store.saveRun({ ...agent, task: "Trigger render failure." });
  await flushMicrotasks();

  assert.deepEqual(notifications, ["error:Pi-orchestra monitor stopped: listWorkflows failed"]);
  assert.equal(widgets.at(-1), undefined);
});

test("orchestra monitor surfaces and cleans up initial UI failures", async () => {
  vi.useFakeTimers();
  try {
    const store = new InMemoryAgentStore();
    const agent = run({ id: "reviewer" });
    store.saveRun(agent);
    const notifications: string[] = [];
    const monitor = new OrchestraMonitorController(store, { ...MONITOR_OPTIONS, tickMs: 1_000 });
    const ctx = monitorContext([], notifications);
    ctx.ui.setWidget = () => {
      throw new Error("setWidget failed");
    };

    assert.throws(() => monitor.show(ctx), /setWidget failed/);
    assert.equal(vi.getTimerCount(), 0);
    store.saveRun({ ...agent, task: "Must not rerender." });
    await flushMicrotasks();
    assert.deepEqual(notifications, []);
  } finally {
    vi.useRealTimers();
  }
});

test("orchestra monitor contains stale context failures", async () => {
  const store = new InMemoryAgentStore();
  const agent = run({ id: "reviewer" });
  store.saveRun(agent);
  const monitor = new OrchestraMonitorController(store, MONITOR_OPTIONS);
  const notifications: string[] = [];
  const ctx = monitorContext([], notifications);
  const ui = ctx.ui;
  let stale = false;
  Object.defineProperties(ctx, {
    hasUI: {
      get: () => {
        if (stale) throw new Error("context is stale");
        return true;
      },
    },
    ui: {
      get: () => {
        if (stale) throw new Error("context is stale");
        return ui;
      },
    },
  });

  assert.equal(monitor.show(ctx), true);
  stale = true;
  store.saveRun({ ...agent, task: "Trigger stale context." });
  await flushMicrotasks();

  assert.deepEqual(notifications, []);
});

test("orchestra monitor idle ticks refresh uptime and health without querying the store", () => {
  vi.useFakeTimers();
  try {
    const store = new CountingStore();
    store.saveWorkflow(workflowRun());
    store.saveRun(run({ id: "workflow-agent", busId: "workflow-bus" }));
    const widgets: Array<string[] | undefined> = [];
    let nowMs = MONITOR_NOW_MS;
    let healthCalls = 0;
    let healthPhase: "active" | "waiting" = "active";
    let contextPercent = 10;
    const monitor = new OrchestraMonitorController(store, {
      now: () => nowMs,
      resolveAgentHealth: () => {
        healthCalls++;
        return { phase: healthPhase, contextPercent };
      },
      tickMs: 1_000,
    });

    assert.equal(monitor.show(monitorContext(widgets)), true);
    assert.deepEqual(widgets.at(-1), [
      " FLOW   workflow [10s] | groups 0/0 | agents 0/1 | [health ctx<=10%] | Complete the workflow.",
    ]);
    const listCallsAfterShow = store.listCalls;
    const healthCallsAfterShow = healthCalls;
    nowMs += 1_000;
    healthPhase = "waiting";
    contextPercent = 20;
    vi.advanceTimersByTime(1_000);

    assert.deepEqual(store.listCalls, listCallsAfterShow);
    assert.equal(healthCalls, healthCallsAfterShow + 1);
    assert.deepEqual(widgets.at(-1), [
      " FLOW   workflow [11s] | groups 0/0 | agents 0/1 | [health waiting=1 ctx<=20%] | Complete the workflow.",
    ]);
    monitor.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("orchestra monitor snapshots only renderable store entries", () => {
  const store = new InMemoryAgentStore();
  for (let index = 0; index < 10; index++) {
    store.saveRun(run({ id: `closed-agent-${index}`, state: "closed" }));
    store.saveWorkgroup(workgroupRun({ id: `closed-group-${index}`, state: "closed" }));
    store.saveWorkflow(workflowRun({ id: `closed-flow-${index}`, state: "closed" }));
  }
  store.saveRun(run({ id: "active-agent" }));
  const clone = vi.spyOn(globalThis, "structuredClone");

  const lines = buildOrchestraMonitorLines(store, MONITOR_NOW_MS);
  const cloneCount = clone.mock.calls.length;
  clone.mockRestore();

  assert.equal(cloneCount, 1);
  assert.deepEqual(lines, ["AGENT  active-agent | researcher | Inspect the code."]);
});

test("orchestra monitor coalesces store updates before rerendering", async () => {
  const store = new CountingStore();
  const agent = run({ id: "reviewer" });
  store.saveRun(agent);
  const widgets: Array<string[] | undefined> = [];
  const monitor = new OrchestraMonitorController(store, MONITOR_OPTIONS);

  assert.equal(monitor.show(monitorContext(widgets)), true);
  const listCallsAfterShow = store.listWorkflowsCalls;
  store.saveRun({ ...agent, task: "First update." });
  store.saveRun({ ...agent, task: "Second update." });

  assert.equal(store.listWorkflowsCalls, listCallsAfterShow);
  await flushMicrotasks();

  assert.equal(store.listWorkflowsCalls, listCallsAfterShow + 1);
  assert.deepEqual(widgets.at(-1), [" AGENT  reviewer | researcher | Second update."]);
});

test("orchestra monitor is disabled without UI", () => {
  const store = new InMemoryAgentStore();
  store.saveRun(run());
  const monitor = new OrchestraMonitorController(store, MONITOR_OPTIONS);

  assert.equal(monitor.show({ hasUI: false } as unknown as ExtensionContext), false);
});

class ThrowingStore extends InMemoryAgentStore {
  throwOnList = false;

  override listWorkflows(filter?: (workflow: WorkflowRun) => boolean): WorkflowRun[] {
    if (this.throwOnList) throw new Error("listWorkflows failed");
    return super.listWorkflows(filter);
  }
}

class CountingStore extends InMemoryAgentStore {
  listRunsCalls = 0;
  listWorkgroupsCalls = 0;
  listWorkflowsCalls = 0;

  get listCalls(): [number, number, number] {
    return [this.listRunsCalls, this.listWorkgroupsCalls, this.listWorkflowsCalls];
  }

  override listRuns(filter?: (run: AgentRun) => boolean): AgentRun[] {
    this.listRunsCalls++;
    return super.listRuns(filter);
  }

  override listWorkgroups(filter?: (workgroup: WorkgroupRun) => boolean): WorkgroupRun[] {
    this.listWorkgroupsCalls++;
    return super.listWorkgroups(filter);
  }

  override listWorkflows(filter?: (workflow: WorkflowRun) => boolean): WorkflowRun[] {
    this.listWorkflowsCalls++;
    return super.listWorkflows(filter);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

function monitorContext(
  widgets: Array<string[] | undefined>,
  notifications: string[] = [],
  width = 120,
): ExtensionContext {
  return {
    hasUI: true,
    cwd: "/workspace",
    ui: {
      setWidget(_key: string, content: unknown) {
        if (content === undefined || Array.isArray(content)) {
          widgets.push(content as string[] | undefined);
          return;
        }
        const factory = content as (
          tui: unknown,
          theme: { fg: (_color: string, text: string) => string },
        ) => { render(width: number): string[] };
        widgets.push(factory({}, { fg: (_color, text) => text }).render(width));
      },
      notify(message: string, type: string) {
        notifications.push(`${type}:${message}`);
      },
    },
  } as unknown as ExtensionContext;
}

function run(overrides: Partial<AgentRun> & { profileName?: string; task?: string } = {}): AgentRun {
  const { profileName, ...runOverrides } = overrides;
  const id = runOverrides.id ?? "agent-1";
  return {
    id,
    name: runOverrides.name ?? id,
    profile: {
      name: profileName ?? "researcher",
      systemPrompt: "Research.",
      tools: [],
      model: undefined,
      thinkingLevel: undefined,
    },
    task: runOverrides.task ?? "Inspect the code.",
    busId: runOverrides.busId ?? "bus-1",
    ownerSessionId: runOverrides.ownerSessionId ?? "session-1",
    state: "running",
    ...runOverrides,
    parentRunId: runOverrides.parentRunId ?? null,
    result: runOverrides.result ?? null,
  } as AgentRun;
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow",
    name: "workflow",
    busId: "workflow-bus",
    ownerSessionId: "session-1",
    goal: "Complete the workflow.",
    ownerRunId: null,
    coordinatorRunId: "flow-leader",
    workgroupIds: [],
    state: "running",
    result: null,
    createdAtMs: STARTED_AT_MS,
    ...overrides,
  };
}

function workgroupRun(overrides: Partial<WorkgroupRun> = {}): WorkgroupRun {
  return {
    id: "workgroup",
    name: "workgroup",
    busId: "workgroup-bus",
    ownerSessionId: "session-1",
    goal: "Complete the workgroup.",
    leaderRunId: null,
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: STARTED_AT_MS,
    ...overrides,
  };
}
