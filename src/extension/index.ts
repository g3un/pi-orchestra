import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "../core/agent.ts";
import { InMemoryAgentStore } from "../adapters/in-memory-store.ts";
import { PiAgentRuntime } from "../adapters/pi-runtime.ts";
import { Orchestra } from "../core/orchestra.ts";
import type { BusInput } from "../tools/bus.ts";
import { createBusTool, type BusTool } from "../tools/bus.ts";
import type { SubagentInput } from "../tools/subagent.ts";
import { createSubagentTool, type SubagentTool } from "../tools/subagent.ts";
import type { WaitRunsInput } from "../tools/wait-runs.ts";
import { createWaitRunsTool, type WaitRunsTool } from "../tools/wait-runs.ts";

const BusActionParams = Type.String({
  enum: ["create", "status", "publish"],
  description:
    "Action to perform. create allocates a standalone bus. status inspects a bus by id. publish sends shared context to every active subagent attached to the bus.",
});

const BusToolParams = Type.Object(
  {
    action: BusActionParams,
    id: Type.Optional(
      Type.String({
        description: "Required for action=status and action=publish. Bus id returned by action=create.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=publish. Shared context to add to the bus.",
      }),
    ),
  },
  { additionalProperties: false },
);

const WaitRunsToolParams = Type.Object(
  {
    runIds: Type.Array(Type.String(), {
      description: "Run ids to wait for. The tool returns when every listed run is finished, failed, or closed.",
      minItems: 1,
    }),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Optional timeout in milliseconds for waiting for all runs.",
      }),
    ),
  },
  { additionalProperties: false },
);

const AgentProfileParams = Type.Object(
  {
    name: Type.String({ description: "Short role/name for the subagent." }),
    systemPrompt: Type.String({ description: "System prompt for the subagent." }),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist for the subagent." })),
    model: Type.Optional(
      Type.String({
        description: "Optional provider/model id, for example anthropic/claude-sonnet-4-5.",
      }),
    ),
  },
  { description: "Required for action=spawn. Defines the subagent role." },
);

const SubagentActionParams = Type.String({
  enum: ["spawn", "status", "resume", "close"],
  description:
    "Action to perform. spawn creates a new subagent with profile, task, and an existing busId. status inspects an existing subagent by id. resume sends a follow-up instruction by id. close disposes a subagent by id.",
});

const SubagentToolParams = Type.Object(
  {
    action: SubagentActionParams,
    profile: Type.Optional(AgentProfileParams),
    task: Type.Optional(
      Type.String({
        description: "Required for action=spawn. Task to delegate to the new subagent.",
      }),
    ),
    busId: Type.Optional(
      Type.String({
        description: "Required for action=spawn. Existing bus id returned by bus action=create.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Required for action=status, action=resume, and action=close. Subagent id returned by spawn.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=resume. Follow-up instruction for the subagent.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface ToolBundle {
  busTool: BusTool;
  subagentTool: SubagentTool;
  waitRunsTool: WaitRunsTool;
}

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  const bundles = new Map<string, ToolBundle>();

  pi.registerTool(
    defineTool({
      name: "bus",
      label: "Bus",
      description: "Create, inspect, and publish shared context buses for orchestrated agents.",
      promptSnippet: "Create a bus before spawning related subagents, then publish shared context to it.",
      promptGuidelines: [
        "Use action=create before spawning a subagent or agent team that needs shared context.",
        "Pass the returned bus id as subagent action=spawn busId.",
        "Use action=publish to send updated parent context to every active subagent attached to the bus.",
        "Use action=status to inspect the messages already published on a bus.",
      ],
      parameters: BusToolParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const bundle = getBundle(bundles, ctx);
        const output = await bundle.busTool.execute(toBusInput(params as RawBusParams));

        return {
          content: [{ type: "text", text: output.message }],
          details: output,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "subagent",
      label: "Subagent",
      description: "Create and manage an isolated subagent without polluting the parent context.",
      promptSnippet: "Delegate isolated work to subagent and inspect or resume it later.",
      promptGuidelines: [
        "Use subagent for isolated research, inspection, or implementation tasks.",
        "Create a bus first with bus action=create, then pass its id as busId when spawning related subagents.",
        "Use action=spawn to create a new isolated subagent for a delegated task on an existing bus.",
        "Use action=status before resuming or closing an existing subagent if its state is unclear.",
        "Use bus action=publish to send updated parent context to agents attached to a bus.",
      ],
      parameters: SubagentToolParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const bundle = getBundle(bundles, ctx);
        const input = withDefaultModel(toSubagentInput(params as RawSubagentParams), ctx);
        const output = await bundle.subagentTool.execute(input);

        return {
          content: [{ type: "text", text: output.message }],
          details: output,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "waitRuns",
      label: "Wait Runs",
      description: "Wait until one or more agent runs reach a terminal state.",
      promptSnippet: "Wait for spawned subagents or agent team runs to finish before collecting their status.",
      promptGuidelines: [
        "Use waitRuns after spawning one or more subagents when you need their final results before continuing.",
        "Pass all run ids in runIds; the tool returns when every run is finished, failed, or closed.",
        "Use timeoutMs to avoid waiting indefinitely when a run may be stuck.",
      ],
      parameters: WaitRunsToolParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const bundle = getBundle(bundles, ctx);
        const output = await bundle.waitRunsTool.execute(toWaitRunsInput(params as RawWaitRunsParams));

        return {
          content: [{ type: "text", text: output.message }],
          details: output,
        };
      },
    }),
  );
}

type RawBusParams = {
  action: "create" | "status" | "publish";
  id?: string;
  message?: string;
};

type RawSubagentParams = {
  action: "spawn" | "status" | "resume" | "close";
  profile?: AgentProfile;
  task?: string;
  busId?: string;
  id?: string;
  message?: string;
};

type RawWaitRunsParams = {
  runIds?: string[];
  timeoutMs?: number;
};

function toBusInput(params: RawBusParams): BusInput {
  if (params.action === "create") return { action: "create" };

  if (params.action === "status") {
    if (!params.id) throw new Error("bus action=status requires id.");
    return { action: "status", id: params.id };
  }

  if (!params.id) throw new Error("bus action=publish requires id.");
  if (!params.message) throw new Error("bus action=publish requires message.");
  return { action: "publish", id: params.id, message: params.message };
}

function toWaitRunsInput(params: RawWaitRunsParams): WaitRunsInput {
  if (!params.runIds || params.runIds.length === 0) throw new Error("waitRuns requires runIds.");
  return { runIds: params.runIds, timeoutMs: params.timeoutMs };
}

function toSubagentInput(params: RawSubagentParams): SubagentInput {
  if (params.action === "spawn") {
    if (!params.profile) throw new Error("subagent action=spawn requires profile.");
    if (!params.task) throw new Error("subagent action=spawn requires task.");
    if (!params.busId) throw new Error("subagent action=spawn requires busId.");
    return { action: "spawn", profile: params.profile, task: params.task, busId: params.busId };
  }

  if (params.action === "status") {
    if (!params.id) throw new Error("subagent action=status requires id.");
    return { action: "status", id: params.id };
  }

  if (params.action === "resume") {
    if (!params.id) throw new Error("subagent action=resume requires id.");
    if (!params.message) throw new Error("subagent action=resume requires message.");
    return { action: "resume", id: params.id, message: params.message };
  }

  if (!params.id) throw new Error("subagent action=close requires id.");
  return { action: "close", id: params.id };
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
    waitRunsTool: createWaitRunsTool({ orchestra }),
  };
  bundles.set(ctx.cwd, bundle);
  return bundle;
}

function withDefaultModel(input: SubagentInput, ctx: ExtensionContext): SubagentInput {
  if (input.action !== "spawn" || input.profile.model || !ctx.model) return input;
  return {
    ...input,
    profile: {
      ...input.profile,
      model: formatModelId(ctx.model),
    },
  };
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

function formatModelId(model: AgentProfileModel): string {
  return `${model.provider}/${model.id}`;
}

type AgentProfileModel = NonNullable<ExtensionContext["model"]>;
