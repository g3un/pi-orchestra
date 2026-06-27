import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiAgentRuntime } from "../adapters/pi-runtime.ts";
import { createProjectSqliteAgentStore } from "../adapters/sqlite-store.ts";
import { Orchestra } from "../core/orchestra.ts";
import { createBusTool, defineBusPiTool, type BusTool } from "../tools/bus.ts";
import {
  createSubagentTool,
  defineSubagentPiTool,
  formatAvailableModelSelectionGuide,
  type SubagentTool,
} from "../tools/subagent.ts";
import { createWorkflowTool, defineWorkflowPiTool, type WorkflowTool } from "../tools/workflow.ts";
import {
  closeWorkgroupRun,
  createWorkgroupTool,
  defineWorkgroupPiTool,
  type WorkgroupTool,
} from "../tools/workgroup.ts";
import { closeRuntimeOwnedScopes } from "./lifecycle.ts";
import { ORCHESTRA_EVENT_CUSTOM_TYPE, OrchestraEventController, type OrchestraMainEvent } from "./orchestra-events.ts";
import { formatOrchestraRecoveryReport } from "./recovery.ts";
import { WorkflowMonitorController } from "./workflow-monitor.ts";

interface ToolBundle {
  busTool: BusTool;
  subagentTool: SubagentTool;
  workgroupTool: WorkgroupTool;
  workflowTool: WorkflowTool;
  workflowMonitor: WorkflowMonitorController;
  orchestraEvents: OrchestraEventController;
  runtime: PiAgentRuntime;
  store: ReturnType<typeof createProjectSqliteAgentStore>;
  createSubagentTool(parentRunId: string | null): SubagentTool;
  dispose(): void;
}

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  const bundles = new Map<string, ToolBundle>();
  const getToolBundle = (ctx: ExtensionContext) => getBundle(pi, bundles, ctx);

  pi.registerTool(defineBusPiTool((ctx) => getToolBundle(ctx).busTool));
  pi.registerTool(defineSubagentPiTool((ctx) => getToolBundle(ctx).subagentTool));
  pi.registerTool(defineWorkgroupPiTool((ctx) => getToolBundle(ctx).workgroupTool));
  pi.registerTool(
    defineWorkflowPiTool((ctx) => getToolBundle(ctx).workflowTool, {
      onWorkflowInput: (ctx) => getToolBundle(ctx).workflowMonitor.show(ctx),
      onWorkflowOutput: (ctx) => getToolBundle(ctx).workflowMonitor.show(ctx),
    }),
  );

  pi.registerCommand("orchestra-workflows", {
    description: "Show the active pi-orchestra workflow status widget.",
    handler: async (_args, ctx) => {
      const monitor = getToolBundle(ctx).workflowMonitor;
      if (monitor.show(ctx)) return;
      ctx.ui.notify("No active pi-orchestra workflows.", "info");
    },
  });

  pi.registerCommand("orchestra-recovery", {
    description: "Show persisted active pi-orchestra records for explicit recovery.",
    handler: async (_args, ctx) => {
      const bundle = getToolBundle(ctx);
      const report = formatOrchestraRecoveryReport(bundle.store, { liveRunIds: bundle.runtime.listRunIds() });
      sendOrchestraRecoveryReport(pi, report);
    },
  });

  pi.registerCommand("orchestra-models", {
    description: "Show available Pi model ids for pi-orchestra child profiles.",
    handler: async (args, ctx) => {
      sendOrchestraModelGuide(pi, formatAvailableModelSelectionGuide(ctx, args));
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    bundles.get(ctx.cwd)?.dispose();
    bundles.delete(ctx.cwd);
  });
}

function getBundle(pi: ExtensionAPI, bundles: Map<string, ToolBundle>, ctx: ExtensionContext): ToolBundle {
  const existing = bundles.get(ctx.cwd);
  if (existing) return existing;

  const store = createProjectSqliteAgentStore(ctx.cwd);
  let resolveChildCustomTools: (runId: string) => ToolDefinition[] = () => [];
  const runtime = new PiAgentRuntime({
    store,
    cwd: ctx.cwd,
    resolveModel: (model) => resolveModel(ctx, model),
    resolveCustomTools: (runId) => resolveChildCustomTools(runId),
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
    onWorkgroupLeaderFailed: ({ workgroup, run }) => {
      const result = run.result ?? {
        status: "failed" as const,
        summary: `Workgroup leader ${run.name} reached ${run.state} without finishing workgroup ${workgroup.name}.`,
      };
      void closeWorkgroupRun(orchestra, store, workgroup, { includeLeader: true, result }).catch(() => undefined);
    },
    flushDelayMs: undefined,
  });
  const workgroupTool = createWorkgroupTool({
    orchestra,
    store,
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
  const createScopedSubagentTool = (parentRunId: string | null) => createSubagentTool({ orchestra, parentRunId });
  const bundle = {
    busTool: createBusTool({ orchestra, store }),
    subagentTool: createScopedSubagentTool(null),
    workgroupTool,
    workflowTool: createWorkflowTool({ orchestra, store }),
    workflowMonitor: new WorkflowMonitorController(store),
    orchestraEvents,
    runtime,
    store,
    createSubagentTool: createScopedSubagentTool,
    dispose() {
      this.workflowMonitor.dispose();
      this.orchestraEvents.dispose();
      this.workflowTool.dispose();
      closeRuntimeOwnedScopes(store, orchestra, this.runtime.listRunIds());
      this.runtime.dispose();
      store.dispose();
    },
  };
  resolveChildCustomTools = (runId) => defineBundlePiTools(bundle, runId);
  bundles.set(ctx.cwd, bundle);
  return bundle;
}

function defineBundlePiTools(bundle: ToolBundle, parentRunId: string): ToolDefinition[] {
  return [
    defineSubagentPiTool(() => bundle.createSubagentTool(parentRunId)),
    defineWorkgroupPiTool(() => bundle.workgroupTool),
    defineWorkflowPiTool(() => bundle.workflowTool, {
      onWorkflowInput: (ctx) => bundle.workflowMonitor.show(ctx),
      onWorkflowOutput: (ctx) => bundle.workflowMonitor.show(ctx),
    }),
  ];
}

function sendOrchestraModelGuide(pi: ExtensionAPI, content: string): void {
  pi.sendMessage(
    {
      customType: "pi-orchestra.models",
      content,
      display: true,
    },
    { deliverAs: "steer" },
  );
}

function sendOrchestraRecoveryReport(pi: ExtensionAPI, content: string): void {
  pi.sendMessage(
    {
      customType: "pi-orchestra.recovery",
      content,
      display: true,
    },
    { deliverAs: "steer" },
  );
}

function sendOrchestraEvents(pi: ExtensionAPI, events: OrchestraMainEvent[], content: string): void {
  pi.sendMessage(
    {
      customType: ORCHESTRA_EVENT_CUSTOM_TYPE,
      content,
      display: true,
      details: { events },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
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
