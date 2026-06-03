import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { PiAgentRuntime } from "../adapters/pi-runtime.ts";
import { Orchestra } from "../core/orchestra.ts";
import { createBusTool, defineBusPiTool, type BusTool } from "../tools/bus.ts";
import { createSubagentTool, defineSubagentPiTool, type SubagentTool } from "../tools/subagent.ts";
import {
  createWaitBusSettledTool,
  defineWaitBusSettledPiTool,
  type WaitBusSettledTool,
} from "../tools/wait-bus-settled.ts";
import { createWaitNextRunTool, defineWaitNextRunPiTool, type WaitNextRunTool } from "../tools/wait-next-run.ts";
import { createWorkgroupTool, defineWorkgroupPiTool, type WorkgroupTool } from "../tools/workgroup.ts";

interface ToolBundle {
  busTool: BusTool;
  subagentTool: SubagentTool;
  workgroupTool: WorkgroupTool;
  waitBusSettledTool: WaitBusSettledTool;
  waitNextRunTool: WaitNextRunTool;
}

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  const bundles = new Map<string, ToolBundle>();
  const getToolBundle = (ctx: ExtensionContext) => getBundle(bundles, ctx);

  pi.registerTool(defineBusPiTool((ctx) => getToolBundle(ctx).busTool));
  pi.registerTool(defineSubagentPiTool((ctx) => getToolBundle(ctx).subagentTool));
  pi.registerTool(defineWorkgroupPiTool((ctx) => getToolBundle(ctx).workgroupTool));
  pi.registerTool(defineWaitBusSettledPiTool((ctx) => getToolBundle(ctx).waitBusSettledTool));
  pi.registerTool(defineWaitNextRunPiTool((ctx) => getToolBundle(ctx).waitNextRunTool));
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
    waitBusSettledTool: createWaitBusSettledTool({ orchestra }),
    waitNextRunTool: createWaitNextRunTool({ orchestra }),
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
