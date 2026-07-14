import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiAgentRuntime } from "../adapters/pi-runtime.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { createProjectSqliteDebugLog } from "../adapters/sqlite-debug-log.ts";
import { Orchestra } from "../core/orchestra.ts";
import { boundResultData, formatBusMessageText } from "../formatting.ts";
import { createBusTool, defineBusPiTool, type BusTool } from "../tools/bus.ts";
import { createSubagentTool, defineSubagentPiTool, type SubagentTool } from "../tools/subagent.ts";
import { createWorkgroupTool, defineWorkgroupPiTool, type WorkgroupTool } from "../tools/workgroup.ts";
import { closeWorkflowRun, createWorkflowTool, defineWorkflowPiTool, type WorkflowTool } from "../tools/workflow.ts";
import { closeRuntimeOwnedStandalonePrivateBuses } from "../core/auto-bus.ts";
import type { AgentResult } from "../core/subagent.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { closeAgentRuns } from "../utils.ts";
import { ORCHESTRA_EVENT_CUSTOM_TYPE, OrchestraEventController, type OrchestraMainEvent } from "./orchestra-events.ts";
import { OrchestraMonitorController } from "./orchestra-monitor.ts";

interface ToolBundle {
  busTool: BusTool;
  subagentTool: SubagentTool;
  workgroupTool: WorkgroupTool;
  workflowTool: WorkflowTool;
  orchestraMonitor: OrchestraMonitorController;
  orchestraEvents: OrchestraEventController;
  runtime: PiAgentRuntime;
  store: InMemoryAgentStore;
  createSubagentTool(parentRunId: string | null): SubagentTool;
  createWorkgroupTool(parentRunId: string | null): WorkgroupTool;
  createWorkflowTool(parentRunId: string | null): WorkflowTool;
  dispose(): Promise<void>;
}

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  const bundles = new Map<string, ToolBundle>();
  const getToolBundle = (ctx: ExtensionContext) => getBundle(pi, bundles, ctx);

  pi.registerTool(defineBusPiTool((ctx) => getToolBundle(ctx).busTool));
  pi.registerTool(defineSubagentPiTool((ctx) => getToolBundle(ctx).subagentTool));
  pi.registerTool(defineWorkgroupPiTool((ctx) => getToolBundle(ctx).workgroupTool));
  pi.registerTool(defineWorkflowPiTool((ctx) => getToolBundle(ctx).workflowTool));

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.isError || !["subagent", "workgroup", "workflow"].includes(event.toolName)) return;
    getToolBundle(ctx).orchestraMonitor.show(ctx);
  });

  pi.registerCommand("orchestra-monitor", {
    description: "Show the active pi-orchestra status widget.",
    handler: async (_args, ctx) => {
      const monitor = getToolBundle(ctx).orchestraMonitor;
      if (monitor.show(ctx) !== false) return;
      ctx.ui.notify("No active pi-orchestra scopes.", "info");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await bundles.get(ctx.cwd)?.dispose();
    bundles.delete(ctx.cwd);
  });
}

function getBundle(pi: ExtensionAPI, bundles: Map<string, ToolBundle>, ctx: ExtensionContext): ToolBundle {
  const existing = bundles.get(ctx.cwd);
  if (existing) return existing;

  const store = new InMemoryAgentStore();
  const debugLog = createProjectSqliteDebugLog(ctx.cwd);
  debugLog.attach(store);
  const ownerSessionId = crypto.randomUUID();
  let resolveChildCustomTools: (runId: string) => ToolDefinition[] = () => [];
  const runtime = new PiAgentRuntime({
    store,
    cwd: ctx.cwd,
    resolveModel: (model) => resolveModel(ctx, model),
    resolveCustomTools: (runId) => resolveChildCustomTools(runId),
    ownerSessionId,
    onRunRollback: (runId) => orchestraEvents.suppressRunFinish(runId),
  });
  const orchestra = new Orchestra({ runtime, store });
  const orchestraEvents = new OrchestraEventController({
    store,
    sendEvents: (events, content) => sendOrchestraEvents(pi, events, content),
    sendAgentEvents: (runId, _events, content) => {
      if (!runtime.listRunIds().includes(runId)) return false;
      void orchestra.messageAgent(runId, content, { busId: undefined }).catch(() => undefined);
      return true;
    },
    isRunWaiting: (runId) => runtime.getHealthSnapshot(runId)?.phase === "waiting",
    flushDelayMs: undefined,
  });
  const createScopedWorkgroupTool = (parentRunId: string | null) =>
    createWorkgroupTool({
      orchestra,
      store,
      parentRunId,
      ownerSessionId,
      onWorkgroupLaunching: ({ bus, workgroup, runIds, runNames }) =>
        orchestraEvents.beginWorkgroup({ busId: bus.id, leaderRunId: workgroup.leaderRunId, runIds, runNames }),
      onWorkgroupLaunched: ({ bus, workgroup, output }) =>
        orchestraEvents.registerWorkgroup({
          busId: bus.id,
          leaderRunId: workgroup.leaderRunId,
          runIds: output.runs.map((run) => run.id),
        }),
      onWorkgroupLaunchFailed: ({ bus, runIds }) =>
        orchestraEvents.cancelWorkgroupLaunch(bus.id, { suppressRunIds: runIds }),
    });
  const createScopedSubagentTool = (parentRunId: string | null) =>
    createSubagentTool({ orchestra, store, parentRunId, ownerSessionId });
  const createScopedWorkflowTool = (parentRunId: string | null) =>
    createWorkflowTool({
      orchestra,
      store,
      parentRunId,
      ownerSessionId,
      onWorkgroupLaunching: ({ bus, workgroup, runIds, runNames }) =>
        orchestraEvents.beginWorkgroup({ busId: bus.id, leaderRunId: workgroup.leaderRunId, runIds, runNames }),
      onWorkgroupLaunched: ({ bus, workgroup, output }) =>
        orchestraEvents.registerWorkgroup({
          busId: bus.id,
          leaderRunId: workgroup.leaderRunId,
          runIds: output.runs.map((run) => run.id),
        }),
      onWorkgroupLaunchFailed: ({ bus, runIds }) =>
        orchestraEvents.cancelWorkgroupLaunch(bus.id, { suppressRunIds: runIds }),
    });
  const bundle = {
    busTool: createBusTool({ orchestra, store }),
    subagentTool: createScopedSubagentTool(null),
    workgroupTool: createScopedWorkgroupTool(null),
    workflowTool: createScopedWorkflowTool(null),
    orchestraMonitor: new OrchestraMonitorController(store, {
      now: undefined,
      resolveAgentHealth: (runId) => runtime.getHealthSnapshot(runId),
      tickMs: undefined,
    }),
    orchestraEvents,
    runtime,
    store,
    createSubagentTool: createScopedSubagentTool,
    createWorkgroupTool: createScopedWorkgroupTool,
    createWorkflowTool: createScopedWorkflowTool,
    async dispose() {
      const disposers: Array<() => Promise<void> | void> = [
        () => this.orchestraMonitor.dispose(),
        () => this.orchestraEvents.dispose(),
      ];
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          // Keep disposing so shutdown can close owned scopes and the store.
        }
      }
      try {
        await closeRuntimeOwnedScopes(store, orchestra, ownerSessionId);
      } finally {
        try {
          this.runtime.dispose();
        } finally {
          debugLog.dispose();
          store.dispose();
        }
      }
    },
  };
  resolveChildCustomTools = (runId) => defineBundlePiTools(bundle, runId);
  bundles.set(ctx.cwd, bundle);
  return bundle;
}

function defineBundlePiTools(bundle: ToolBundle, parentRunId: string): ToolDefinition[] {
  return [
    defineSubagentPiTool(() => bundle.createSubagentTool(parentRunId)),
    defineWorkgroupPiTool(() => bundle.createWorkgroupTool(parentRunId)),
    defineWorkflowPiTool(() => bundle.createWorkflowTool(parentRunId)),
  ];
}

function sendOrchestraEvents(pi: ExtensionAPI, events: OrchestraMainEvent[], content: string): void {
  pi.sendMessage(
    {
      customType: ORCHESTRA_EVENT_CUSTOM_TYPE,
      content,
      display: true,
      details: { events: events.map(boundOrchestraEventDetails) },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function boundOrchestraEventDetails(event: OrchestraMainEvent): unknown {
  if (event.type === "bus.message")
    return { ...event, message: { ...event.message, message: formatBusMessageText(event.message.message) } };
  if (event.type === "subagent.finished" || event.type === "workgroup.member_finished") {
    return { ...event, run: boundScopeResultDetails(event.run) };
  }
  if (event.type === "workgroup.finished" || event.type === "workflow.workgroup_finished")
    return { ...event, workgroup: boundScopeResultDetails(event.workgroup) };
  if (event.type === "workflow.finished") return { ...event, workflow: boundScopeResultDetails(event.workflow) };
  return event;
}

function boundScopeResultDetails<T extends { result: { data?: unknown } | null }>(scope: T): T {
  return boundResultData(scope);
}

const SESSION_SHUTDOWN_RESULT: AgentResult = {
  status: "blocked",
  summary: "Pi session ended before this orchestration scope closed.",
};

async function closeRuntimeOwnedScopes(
  store: InMemoryAgentStore,
  orchestra: Orchestra,
  ownerSessionId: string,
): Promise<void> {
  const ownWorkflows = store
    .listWorkflows()
    .filter(
      (workflow) =>
        workflow.ownerSessionId === ownerSessionId &&
        (workflow.state !== "closed" || store.getBus(workflow.busId)?.state === "open"),
    );
  await Promise.allSettled(ownWorkflows.map(async (workflow) => await closeWorkflowRecord(store, orchestra, workflow)));

  const ownWorkgroups = store
    .listWorkgroups()
    .filter(
      (workgroup) =>
        workgroup.ownerSessionId === ownerSessionId &&
        (workgroup.state !== "closed" || store.getBus(workgroup.busId)?.state === "open"),
    );
  await Promise.allSettled(
    ownWorkgroups.map(async (workgroup) => await closeWorkgroupRecord(store, orchestra, workgroup)),
  );

  await closeRuntimeOwnedStandalonePrivateBuses(store, orchestra, ownerSessionId);
}

async function closeWorkflowRecord(
  store: InMemoryAgentStore,
  orchestra: Orchestra,
  workflow: WorkflowRun,
): Promise<void> {
  const latestWorkflow = store.getWorkflow(workflow.id) ?? workflow;
  if (latestWorkflow.state === "closed" && store.getBus(latestWorkflow.busId)?.state !== "open") return;
  await closeWorkflowRun(orchestra, store, latestWorkflow, {
    includeCoordinator: true,
    result: latestWorkflow.result ?? SESSION_SHUTDOWN_RESULT,
  });
}

async function closeWorkgroupRecord(
  store: InMemoryAgentStore,
  orchestra: Orchestra,
  workgroup: WorkgroupRun,
): Promise<void> {
  const latestWorkgroup = store.getWorkgroup(workgroup.id) ?? workgroup;
  if (latestWorkgroup.state === "closed" && store.getBus(latestWorkgroup.busId)?.state !== "open") return;

  if (latestWorkgroup.state !== "closed") {
    store.saveWorkgroup({
      ...latestWorkgroup,
      state: "closed",
      result: latestWorkgroup.result ?? SESSION_SHUTDOWN_RESULT,
    });
  }
  await closeAgentRuns(orchestra, [
    ...latestWorkgroup.memberRunIds,
    ...(latestWorkgroup.leaderRunId ? [latestWorkgroup.leaderRunId] : []),
  ]);
  orchestra.closeBus(latestWorkgroup.busId);
}

function resolveModel(ctx: ExtensionContext, model: string): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
  const slashIndex = model.indexOf("/");
  if (slashIndex < 0) {
    const currentProvider = ctx.model?.provider;
    return currentProvider ? ctx.modelRegistry.find(currentProvider, model) : undefined;
  }

  const provider = model.slice(0, slashIndex);
  const modelId = model.slice(slashIndex + 1);
  return provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
}
