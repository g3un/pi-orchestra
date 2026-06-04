import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { PiAgentRuntime } from "../adapters/pi-runtime.ts";
import { Orchestra } from "../core/orchestra.ts";
import { createBusTool, defineBusPiTool, type BusTool } from "../tools/bus.ts";
import { createSubagentTool, defineSubagentPiTool, type SubagentTool } from "../tools/subagent.ts";
import { createWorkflowTool, defineWorkflowPiTool, type WorkflowTool } from "../tools/workflow.ts";
import { createWorkgroupTool, defineWorkgroupPiTool, type WorkgroupTool } from "../tools/workgroup.ts";
import { WorkflowMonitorController } from "./workflow-monitor.ts";

interface ToolBundle {
  busTool: BusTool;
  subagentTool: SubagentTool;
  workgroupTool: WorkgroupTool;
  workflowTool: WorkflowTool;
  workflowMonitor: WorkflowMonitorController;
}

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  const bundles = new Map<string, ToolBundle>();
  const getToolBundle = (ctx: ExtensionContext) => getBundle(bundles, ctx);

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
    description: "Show the active pi-orchestra workflow progress widget.",
    handler: async (_args, ctx) => {
      const monitor = getToolBundle(ctx).workflowMonitor;
      if (monitor.show(ctx)) return;
      ctx.ui.notify("No active pi-orchestra workflows.", "info");
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    bundles.get(ctx.cwd)?.workflowMonitor.dispose();
  });
}

function getBundle(bundles: Map<string, ToolBundle>, ctx: ExtensionContext): ToolBundle {
  const existing = bundles.get(ctx.cwd);
  if (existing) return existing;

  const store = new InMemoryAgentStore();
  const runtime = new PiAgentRuntime({
    store,
    cwd: ctx.cwd,
    resolveModel: (model) => resolveModel(ctx, model),
  });
  const orchestra = new Orchestra({ runtime, store });
  const bundle = {
    busTool: createBusTool({ orchestra }),
    subagentTool: createSubagentTool({ orchestra }),
    workgroupTool: createWorkgroupTool({ orchestra }),
    workflowTool: createWorkflowTool({ orchestra, store }),
    workflowMonitor: new WorkflowMonitorController(store),
  };
  bundles.set(ctx.cwd, bundle);
  return bundle;
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
