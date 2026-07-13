import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { buildOrchestraMonitorLines, OrchestraMonitorController } from "./orchestra-monitor.ts";

const STARTED_AT_MS = 1_700_000_000_000;
const MONITOR_NOW_MS = STARTED_AT_MS + 10_000;

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

test("orchestra monitor limits its height and reports hidden scopes", () => {
  const store = new InMemoryAgentStore();
  for (let index = 1; index <= 5; index++) {
    store.saveRun(run({ id: `agent-${index}`, busId: `bus-${index}` }));
  }

  assert.deepEqual(buildOrchestraMonitorLines(store, MONITOR_NOW_MS), [
    "AGENT  agent-1 | researcher | Inspect the code.",
    "AGENT  agent-2 | researcher | Inspect the code.",
    "AGENT  agent-3 | researcher | Inspect the code.",
    "       +2 more active scopes",
  ]);
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
  const monitor = new OrchestraMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

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
  const monitor = new OrchestraMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

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
  const monitor = new OrchestraMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

  assert.equal(monitor.show(monitorContext(widgets, notifications)), true);
  store.throwOnList = true;
  store.saveRun({ ...agent, task: "Trigger render failure." });
  await flushMicrotasks();

  assert.deepEqual(notifications, ["error:Pi-orchestra monitor stopped: listWorkflows failed"]);
  assert.equal(widgets.at(-1), undefined);
});

test("orchestra monitor coalesces store updates before rerendering", async () => {
  const store = new CountingStore();
  const agent = run({ id: "reviewer" });
  store.saveRun(agent);
  const widgets: Array<string[] | undefined> = [];
  const monitor = new OrchestraMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

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
  const monitor = new OrchestraMonitorController(store, { now: () => MONITOR_NOW_MS, tickMs: 0 });

  assert.equal(monitor.show({ hasUI: false } as unknown as ExtensionContext), false);
});

class ThrowingStore extends InMemoryAgentStore {
  throwOnList = false;

  override listWorkflows(): WorkflowRun[] {
    if (this.throwOnList) throw new Error("listWorkflows failed");
    return super.listWorkflows();
  }
}

class CountingStore extends InMemoryAgentStore {
  listWorkflowsCalls = 0;

  override listWorkflows(): WorkflowRun[] {
    this.listWorkflowsCalls++;
    return super.listWorkflows();
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
    },
    task: runOverrides.task ?? "Inspect the code.",
    busId: runOverrides.busId ?? "bus-1",
    ownerSessionId: runOverrides.ownerSessionId ?? "session-1",
    state: "running",
    ...runOverrides,
    parentRunId: runOverrides.parentRunId ?? null,
    sessionFile: runOverrides.sessionFile ?? `.pi/orchestra/sessions/${id}.jsonl`,
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
