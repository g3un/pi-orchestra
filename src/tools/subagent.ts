import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";

export type SubagentInput =
  | {
      action: "spawn";
      profile: AgentProfile;
      task: string;
      busId: string;
      name?: string;
    }
  | {
      action: "status";
      id: string;
      busId?: string;
    }
  | {
      action: "message";
      id: string;
      message: string;
      busId?: string;
    }
  | {
      action: "close";
      id: string;
      busId?: string;
    };

export interface SubagentOutput {
  run?: AgentRun;
  message: string;
}

export interface SubagentTool {
  name: "subagent";
  execute(input: SubagentInput): Promise<SubagentOutput>;
}

export interface SubagentToolDeps {
  orchestra: OrchestraApi;
}

export const AgentProfileParams = Type.Object(
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

export function createSubagentTool({ orchestra }: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const run = await orchestra.spawnAgent(input.profile, input.task, input.busId, { name: input.name });
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "status") {
        const run = orchestra.getRun(input.id, { busId: input.busId });
        if (!run) return { message: `Subagent ${input.id} not found.` };
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "message") {
        const run = await orchestra.messageAgent(input.id, input.message, { busId: input.busId });
        return {
          run,
          message: formatRunMessage(run, `Messaged subagent ${formatRunLabel(run)}; it is ${run.state}.`),
        };
      }

      const run = await orchestra.closeAgent(input.id, { busId: input.busId });
      return {
        run,
        message: run
          ? formatRunMessage(run, `Closed subagent ${formatRunLabel(run)}.`)
          : `Closed subagent ${input.id}.`,
      };
    },
  };
}

export function defineSubagentPiTool(resolveTool: (ctx: ExtensionContext) => SubagentTool) {
  return defineTool({
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
      "Use action=status before messaging or closing an existing subagent if its state is unclear.",
      "Use bus action=publish to send updated parent context to agents attached to a bus.",
    ],
    parameters: SubagentToolParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModel(toSubagentInput(params as RawSubagentParams), ctx);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
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

function withDefaultModel(input: SubagentInput, ctx: ExtensionContext): SubagentInput {
  if (input.action !== "spawn" || input.profile.model || !ctx.model) return input;
  return {
    ...input,
    profile: withDefaultProfileModel(input.profile, ctx),
  };
}

export function withDefaultProfileModel(profile: AgentProfile, ctx: ExtensionContext): AgentProfile {
  if (profile.model || !ctx.model) return profile;
  return {
    ...profile,
    model: formatModelId(ctx.model),
  };
}

function formatRunMessage(run: AgentRun, headline = `Subagent ${formatRunLabel(run)} is ${run.state}.`): string {
  if (!run.result) return headline;

  const parts = [headline, "", `Result: ${run.result.status}`, run.result.summary];
  if (run.result.data !== undefined) {
    parts.push("", "Data:", formatResultData(run.result.data));
  }
  return parts.join("\n");
}

function formatRunLabel(run: AgentRun): string {
  return run.name === run.id ? run.id : `${run.name} (${run.id})`;
}

function formatResultData(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2) ?? String(data);
}

function formatModelId(model: AgentProfileModel): string {
  return `${model.provider}/${model.id}`;
}

type RawSubagentParams = {
  action: "spawn" | "status" | "message" | "close";
  profile?: AgentProfile;
  task?: string;
  busId?: string;
  name?: string;
  id?: string;
  message?: string;
};

type AgentProfileModel = NonNullable<ExtensionContext["model"]>;
