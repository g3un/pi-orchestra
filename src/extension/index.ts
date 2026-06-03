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
import type { WaitBusSettledInput } from "../tools/wait-bus-settled.ts";
import { createWaitBusSettledTool, type WaitBusSettledTool } from "../tools/wait-bus-settled.ts";
import type { WaitNextRunInput } from "../tools/wait-next-run.ts";
import { createWaitNextRunTool, type WaitNextRunTool } from "../tools/wait-next-run.ts";
import type { WorkgroupInput, WorkgroupMode } from "../tools/workgroup.ts";
import { createWorkgroupTool, type WorkgroupTool } from "../tools/workgroup.ts";

const BusActionParams = Type.String({
  enum: ["create", "status", "publish"],
  description:
    "Action to perform. A bus is the work grouping boundary: create allocates one work bus, status inspects a work bus by id, and publish sends shared context to every active subagent attached to that bus.",
});

const BusToolParams = Type.Object(
  {
    action: BusActionParams,
    name: Type.Optional(
      Type.String({
        description:
          "Optional short, human-readable bus name for action=create. If omitted, a short name is generated.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Required for action=status and action=publish. Bus id or name returned by action=create; one bus groups the subagents for a delegated work item.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=publish. Shared context to add to the work bus for all attached agents.",
      }),
    ),
  },
  { additionalProperties: false },
);

const WaitBusSettledToolParams = Type.Object(
  {
    busId: Type.String({
      description:
        "Work bus id or name to wait for. The tool returns when every current run attached to this bus is finished, failed, or closed.",
    }),
    timeoutMs: Type.Optional(
      Type.Union(
        [
          Type.Number({
            exclusiveMinimum: 0,
          }),
          Type.Null(),
        ],
        {
          description:
            "Optional positive timeout in milliseconds. Defaults to 10 minutes. Use null to wait indefinitely. On timeout, waitBusSettled returns the latest collected state for current runs attached to the bus.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

const WaitNextRunToolParams = Type.Object(
  {
    busId: Type.String({
      description:
        "Work bus id or name to wait for. The tool returns the next current run on this bus that reaches a terminal state.",
    }),
    excludeRunIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional run ids or names to ignore because the leader has already handled them.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Union(
        [
          Type.Number({
            exclusiveMinimum: 0,
          }),
          Type.Null(),
        ],
        {
          description:
            "Optional positive timeout in milliseconds. Defaults to 10 minutes. Use null to wait indefinitely. On timeout, waitNextRun returns the latest collected state without a completed run.",
        },
      ),
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

const WorkgroupMemberParams = Type.Object(
  {
    profile: AgentProfileParams,
    name: Type.Optional(
      Type.String({
        description: "Optional short, human-readable globally unique run name for this workgroup member.",
      }),
    ),
    assignment: Type.Optional(
      Type.String({
        description: "Optional member-specific assignment or focus within the shared goal.",
      }),
    ),
  },
  { additionalProperties: false },
);

const WorkgroupToolParams = Type.Object(
  {
    busId: Type.String({
      description:
        "Existing work bus id or name. Workgroup does not create buses; create one with bus action=create first.",
    }),
    goal: Type.String({
      description: "Shared workgroup goal that every member should contribute to.",
    }),
    mode: Type.String({
      enum: ["explore", "council"],
      description:
        "Coordination style. explore fans out diverse approaches; council asks domain experts to advise the main-agent leader.",
    }),
    members: Type.Array(WorkgroupMemberParams, {
      description: "Subagents to spawn onto the existing bus as workgroup members.",
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

const SubagentActionParams = Type.String({
  enum: ["spawn", "status", "message", "close"],
  description:
    "Action to perform. spawn creates a new subagent with profile, task, and an existing busId. status inspects an existing subagent by id or name. message sends an instruction by id or name, steering a running subagent or restarting a finished one. close disposes a subagent by id or name.",
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
        description: "Required for action=spawn. Existing bus id or name returned by bus action=create.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Optional short, human-readable globally unique subagent run name for action=spawn. If omitted, a short name is generated from the profile name.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Required for action=status, action=message, and action=close. Subagent run id or name returned by spawn.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=message. Instruction to send to the subagent.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface ToolBundle {
  busTool: BusTool;
  subagentTool: SubagentTool;
  workgroupTool: WorkgroupTool;
  waitBusSettledTool: WaitBusSettledTool;
  waitNextRunTool: WaitNextRunTool;
}

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  const bundles = new Map<string, ToolBundle>();

  pi.registerTool(
    defineTool({
      name: "bus",
      label: "Bus",
      description:
        "Create, inspect, and publish shared context buses. A bus is the work grouping boundary: one delegated task or team should share one bus, with one or more subagents attached to it.",
      promptSnippet:
        "Create one bus per delegated work item, spawn related subagents on it, then publish shared context to that bus.",
      promptGuidelines: [
        "Use action=create before spawning a subagent or agent team; the returned bus is the work grouping boundary.",
        "Give each bus a short name when useful, and pass the returned bus id or name as subagent action=spawn busId so each subagent joins that work group.",
        "Multiple subagents can attach to the same bus when they are cooperating on the same delegated work item.",
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
      promptSnippet: "Delegate isolated work to subagent and inspect, message, or close it later.",
      promptGuidelines: [
        "Use subagent for isolated research, inspection, or implementation tasks.",
        "Create a bus first with bus action=create; the bus is the work grouping boundary for one delegated task or team.",
        "Use action=spawn to create a new isolated subagent and attach it to an existing bus via busId; optionally provide a globally unique short run name.",
        "Attach multiple subagents to the same bus when they are cooperating on the same work item.",
        "Run names are globally unique; use the returned run id or name for status/message/close.",
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
      name: "workgroup",
      label: "Workgroup",
      description:
        "Launch multiple subagents onto an existing work bus so the main agent can lead exploration or expert coordination.",
      promptSnippet:
        "Attach several subagents to an existing bus for explore fan-out or council-style expert collaboration.",
      promptGuidelines: [
        "Create a bus first with bus action=create; workgroup requires an existing busId and never creates a bus automatically.",
        "Use mode=explore to fan out diverse approaches: members may share facts, evidence, dead ends, and constraints with siblings, but should keep conclusions/recommendations until finish.",
        "Use mode=council when the main agent should act as leader and coordinate domain experts that actively exchange conclusions, rebuttals, and next actions.",
        "Treat publish_bus as a peer-reference channel between members, not as a live channel to the leader.",
        "Use waitNextRun to receive finished or blocked members; if a member needs leader action, respond with subagent message.",
      ],
      parameters: WorkgroupToolParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const bundle = getBundle(bundles, ctx);
        const input = withDefaultModelsForWorkgroup(toWorkgroupInput(params as RawWorkgroupParams), ctx);
        const output = await bundle.workgroupTool.execute(input);

        return {
          content: [{ type: "text", text: output.message }],
          details: output,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "waitBusSettled",
      label: "Wait Bus Settled",
      description: "Wait until all current agent runs attached to a work bus reach a terminal state.",
      promptSnippet: "Wait for every current subagent on a bus to finish before collecting their statuses.",
      promptGuidelines: [
        "Use waitBusSettled when you need the whole bus work group to finish before continuing.",
        "Pass the busId for the delegated work item; the tool waits for every current run attached to that bus.",
        "By default waitBusSettled times out after 10 minutes. Set timeoutMs to a positive millisecond value, or null to wait indefinitely.",
        "On timeout, the tool returns the latest collected run states for the bus instead of failing.",
      ],
      parameters: WaitBusSettledToolParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const bundle = getBundle(bundles, ctx);
        const output = await bundle.waitBusSettledTool.execute(
          toWaitBusSettledInput(params as RawWaitBusSettledParams),
        );

        return {
          content: [{ type: "text", text: output.message }],
          details: output,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "waitNextRun",
      label: "Wait Next Run",
      description: "Wait for the next current run attached to a work bus to reach a terminal state.",
      promptSnippet: "Wait for one more subagent on a bus to finish so the leader can react and coordinate.",
      promptGuidelines: [
        "Use waitNextRun when acting as a workgroup leader and you want to handle subagent results as they arrive.",
        "Pass excludeRunIds with run ids or names you have already handled to avoid receiving the same terminal run again.",
        "By default waitNextRun times out after 10 minutes. Set timeoutMs to a positive millisecond value, or null to wait indefinitely.",
      ],
      parameters: WaitNextRunToolParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const bundle = getBundle(bundles, ctx);
        const output = await bundle.waitNextRunTool.execute(toWaitNextRunInput(params as RawWaitNextRunParams));

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
  name?: string;
  id?: string;
  message?: string;
};

type RawSubagentParams = {
  action: "spawn" | "status" | "message" | "close";
  profile?: AgentProfile;
  task?: string;
  busId?: string;
  name?: string;
  id?: string;
  message?: string;
};

type RawWorkgroupParams = {
  busId?: string;
  goal?: string;
  mode?: WorkgroupMode;
  members?: Array<{
    profile?: AgentProfile;
    name?: string;
    assignment?: string;
  }>;
};

type RawWaitBusSettledParams = {
  busId?: string;
  timeoutMs?: number | null;
};

type RawWaitNextRunParams = {
  busId?: string;
  excludeRunIds?: string[];
  timeoutMs?: number | null;
};

function toBusInput(params: RawBusParams): BusInput {
  if (params.action === "create") return { action: "create", name: params.name };

  if (params.action === "status") {
    if (!params.id) throw new Error("bus action=status requires id.");
    return { action: "status", id: params.id };
  }

  if (!params.id) throw new Error("bus action=publish requires id.");
  if (!params.message) throw new Error("bus action=publish requires message.");
  return { action: "publish", id: params.id, message: params.message };
}

function toWorkgroupInput(params: RawWorkgroupParams): WorkgroupInput {
  if (!params.busId) throw new Error("workgroup requires busId.");
  if (!params.goal) throw new Error("workgroup requires goal.");
  if (!params.mode) throw new Error("workgroup requires mode.");
  if (!params.members || params.members.length === 0) throw new Error("workgroup requires members.");

  return {
    busId: params.busId,
    goal: params.goal,
    mode: params.mode,
    members: params.members.map((member, index) => {
      if (!member.profile) throw new Error(`workgroup member ${index + 1} requires profile.`);
      return { profile: member.profile, name: member.name, assignment: member.assignment };
    }),
  };
}

function toWaitBusSettledInput(params: RawWaitBusSettledParams): WaitBusSettledInput {
  if (!params.busId) throw new Error("waitBusSettled requires busId.");
  return { busId: params.busId, timeoutMs: params.timeoutMs };
}

function toWaitNextRunInput(params: RawWaitNextRunParams): WaitNextRunInput {
  if (!params.busId) throw new Error("waitNextRun requires busId.");
  return { busId: params.busId, excludeRunIds: params.excludeRunIds, timeoutMs: params.timeoutMs };
}

function toSubagentInput(params: RawSubagentParams): SubagentInput {
  if (params.action === "spawn") {
    if (!params.profile) throw new Error("subagent action=spawn requires profile.");
    if (!params.task) throw new Error("subagent action=spawn requires task.");
    if (!params.busId) throw new Error("subagent action=spawn requires busId.");
    return { action: "spawn", profile: params.profile, task: params.task, busId: params.busId, name: params.name };
  }

  if (params.action === "status") {
    if (!params.id) throw new Error("subagent action=status requires id.");
    return { action: "status", id: params.id, busId: params.busId };
  }

  if (params.action === "message") {
    if (!params.id) throw new Error("subagent action=message requires id.");
    if (!params.message) throw new Error("subagent action=message requires message.");
    return { action: "message", id: params.id, message: params.message, busId: params.busId };
  }

  if (!params.id) throw new Error("subagent action=close requires id.");
  return { action: "close", id: params.id, busId: params.busId };
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

function withDefaultModel(input: SubagentInput, ctx: ExtensionContext): SubagentInput {
  if (input.action !== "spawn" || input.profile.model || !ctx.model) return input;
  return {
    ...input,
    profile: withDefaultProfileModel(input.profile, ctx),
  };
}

function withDefaultModelsForWorkgroup(input: WorkgroupInput, ctx: ExtensionContext): WorkgroupInput {
  return {
    ...input,
    members: input.members.map((member) => ({
      ...member,
      profile: withDefaultProfileModel(member.profile, ctx),
    })),
  };
}

function withDefaultProfileModel(profile: AgentProfile, ctx: ExtensionContext): AgentProfile {
  if (profile.model || !ctx.model) return profile;
  return {
    ...profile,
    model: formatModelId(ctx.model),
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
