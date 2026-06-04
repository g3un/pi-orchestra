import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import { formatNamedEntityLabel } from "../utils.ts";

export interface SubagentSpawnInput {
  action: "spawn";
  profile: AgentProfile;
  task: string;
  busId: string;
  name: string | undefined;
}

export type SubagentInput =
  | SubagentSpawnInput
  | {
      action: "status";
      id: string;
      busId: string | undefined;
    }
  | {
      action: "message";
      id: string;
      message: string;
      busId: string | undefined;
    }
  | {
      action: "close";
      id: string;
      busId: string | undefined;
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

export const SubagentRunNameParam = Type.String({
  description: "Optional globally unique short run name.",
});

export const AgentProfileParams = Type.Object(
  {
    name: Type.String({ description: "Short role/name for the subagent." }),
    systemPrompt: Type.String({ description: "System prompt for the subagent." }),
    tools: Type.Array(Type.String(), {
      description:
        "Explicit tool allowlist for the subagent. Use [] for no work tools; finish and publish_bus are added automatically.",
    }),
    model: Type.Optional(
      Type.String({
        description: "Optional provider/model id.",
      }),
    ),
  },
  { description: "Required for action=spawn. Defines the subagent role." },
);

const SubagentActionParams = Type.String({
  enum: ["spawn", "status", "message", "close"],
  description: "spawn creates; status inspects; message steers/restarts; close disposes by id/name.",
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
        description: "Required for action=spawn. Existing bus id/name.",
      }),
    ),
    name: Type.Optional(SubagentRunNameParam),
    id: Type.Optional(
      Type.String({
        description: "Required for status/message/close. Subagent run id/name.",
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

export async function spawnSubagent(orchestra: OrchestraApi, input: SubagentSpawnInput): Promise<AgentRun> {
  return await orchestra.spawnAgent(input.profile, input.task, input.busId, { name: input.name });
}

export function createSubagentTool({ orchestra }: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const run = await spawnSubagent(orchestra, input);
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "status") {
        const run = orchestra.getRun(input.id, { busId: input.busId });
        if (!run) return { message: formatMissingSubagentMessage(input.id) };
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "message") {
        const run = await orchestra.messageAgent(input.id, input.message, { busId: input.busId });
        return {
          run,
          message: formatRunMessage(run, `Messaged subagent ${formatNamedEntityLabel(run)}; it is ${run.state}.`),
        };
      }

      const run = await orchestra.closeAgent(input.id, { busId: input.busId });
      return {
        run,
        message: run
          ? formatRunMessage(run, `Closed subagent ${formatNamedEntityLabel(run)}.`)
          : formatClosedMissingSubagentMessage(input.id),
      };
    },
  };
}

export function defineSubagentPiTool(resolveTool: (ctx: ExtensionContext) => SubagentTool) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: "Create and manage isolated subagents.",
    promptSnippet: "Spawn a subagent on an existing bus, then status/message/close it later.",
    promptGuidelines: [
      "Create a bus first; spawn attaches the subagent via busId.",
      "Attach cooperating subagents to the same bus.",
      "Use returned run id/name for status, message, or close.",
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
    return {
      action: "spawn",
      profile: toAgentProfile(params.profile),
      task: params.task,
      busId: params.busId,
      name: params.name,
    };
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

export function toAgentProfile(profile: RawAgentProfileParams): AgentProfile {
  if (!Array.isArray(profile.tools)) throw new Error(`Profile "${profile.name}" requires tools.`);
  return {
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    model: profile.model,
  };
}

export function withDefaultProfileModel(profile: AgentProfile, ctx: ExtensionContext): AgentProfile {
  if (profile.model || !ctx.model) return profile;
  return {
    ...profile,
    model: formatModelId(ctx.model),
  };
}

function formatMissingSubagentMessage(id: string): string {
  return `Subagent ${id} not found.`;
}

function formatClosedMissingSubagentMessage(id: string): string {
  return `Closed subagent ${id}.`;
}

function formatRunMessage(
  run: AgentRun,
  headline = `Subagent ${formatNamedEntityLabel(run)} is ${run.state}.`,
): string {
  if (!run.result) return headline;

  const parts = [headline, "", `Result: ${run.result.status}`, run.result.summary];
  if (run.result.data !== undefined) {
    parts.push("", "Data:", formatResultData(run.result.data));
  }
  return parts.join("\n");
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
  profile?: RawAgentProfileParams;
  task?: string;
  busId?: string;
  name?: string;
  id?: string;
  message?: string;
};

export type RawAgentProfileParams = Omit<AgentProfile, "model"> & Partial<Pick<AgentProfile, "model">>;

type AgentProfileModel = NonNullable<ExtensionContext["model"]>;
