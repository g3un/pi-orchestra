import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentHealth, type ResolveAgentHealth } from "../agent-health.ts";
import {
  AGENT_THINKING_LEVEL_VALUES,
  type AgentProfile,
  type AgentRun,
  type AgentThinkingLevel,
} from "../core/subagent.ts";
import { closeStandalonePrivateBusIfUnused } from "../core/auto-bus.ts";
import { createBusSubscription, maxMessageSeq, type Bus } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import { findRunningCoordinatedWorkflow } from "../core/workflow.ts";
import { findRunningLedWorkgroup } from "../core/workgroup.ts";
import { createBusNameFromOwnerName, createPrefixedName, getBusOwnerRawNameBudget } from "../naming.ts";
import { assertAgentRunNameAvailable, isAgentRunActive, normalizeEntityName, requireParam } from "../utils.ts";
import { boundResultData, formatResultData } from "../formatting.ts";
import { subscribeMainToBus } from "./bus.ts";

export interface SubagentSpawnInput {
  action: "spawn";
  profile: AgentProfile;
  task: string;
  busId?: string;
  name: string;
}

export type SubagentInput =
  | SubagentSpawnInput
  | {
      action: "status";
      id: string;
    }
  | {
      action: "message";
      id: string;
      message: string;
    }
  | {
      action: "close";
      id: string;
    };

export interface BusSummary {
  id: string;
  name: string;
  state: Bus["state"];
  metadata?: Bus["metadata"];
}

export interface SubagentOutput {
  run?: AgentRun;
  bus?: BusSummary;
  message: string;
}

export interface SubagentTool {
  name: "subagent";
  execute(input: SubagentInput): Promise<SubagentOutput>;
}

export interface SubagentToolDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
  parentRunId: string | null;
  ownerSessionId: string;
  resolveAgentHealth: ResolveAgentHealth | undefined;
}

export const SubagentRunNameParam = Type.String({
  description: "Unique readable name for this agent run.",
});

const AgentProfileToolsParam = Type.Array(Type.String(), {
  description: "Tool allowlist. finish/publish_bus are added automatically; do not include bus.",
});

const AgentProfileModelParam = Type.Optional(
  Type.String({
    description: "Optional exact provider/model id (provider/model). Omit to inherit the current Pi model.",
  }),
);

const AgentProfileThinkingLevelParam = Type.Optional(
  Type.String({
    enum: [...AGENT_THINKING_LEVEL_VALUES],
    description:
      "Optional Pi thinking level. Accepted values: off, minimal, low, medium, high, xhigh, max. Omit to keep Pi's default child-session behavior.",
  }),
);

export const AgentProfileParams = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        description: "Required. Readable role/profile name.",
      }),
    ),
    systemPrompt: Type.Optional(Type.String({ description: "Required. The child agent's system prompt." })),
    tools: AgentProfileToolsParam,
    model: AgentProfileModelParam,
    thinkingLevel: AgentProfileThinkingLevelParam,
  },
  {
    additionalProperties: false,
    description: "Required for spawn. Provide name, systemPrompt, and tools.",
  },
);

const SubagentActionParams = Type.String({
  enum: ["spawn", "status", "message", "close"],
  description: "spawn creates; status inspects; message steers; close disposes.",
});

export const SubagentSpawnParams = Type.Object(
  {
    action: Type.String({
      enum: ["spawn"],
      description: "spawn creates a subagent.",
    }),
    profile: AgentProfileParams,
    task: Type.String({
      description: "Required for spawn. Delegated task.",
    }),
    busId: Type.Optional(
      Type.String({
        description:
          "Optional for spawn. Existing bus name. Omit to create a private bus derived from the prefixed run name (for example bus-agent-review) and subscribe the owning scope (main or parent run).",
      }),
    ),
    name: SubagentRunNameParam,
  },
  { additionalProperties: false },
);

const SubagentToolParams = Type.Object(
  {
    action: SubagentActionParams,
    profile: Type.Optional(AgentProfileParams),
    task: Type.Optional(
      Type.String({
        description: "Required for spawn. Delegated task.",
      }),
    ),
    busId: Type.Optional(
      Type.String({
        description:
          "Optional for spawn. Existing bus name. Omit to create a private bus derived from the prefixed run name (for example bus-agent-review) and subscribe the owning scope (main or parent run).",
      }),
    ),
    name: Type.Optional(SubagentRunNameParam),
    id: Type.Optional(
      Type.String({
        description: "Required for status/message/close. Subagent run name.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for message. Instruction to send.",
      }),
    ),
  },
  { additionalProperties: false },
);

export async function spawnSubagent(
  orchestra: OrchestraApi,
  input: SubagentSpawnInput,
  parentRunId: string | null,
): Promise<AgentRun> {
  if (!input.busId) throw new Error("spawnSubagent requires busId after normalization.");
  return await orchestra.spawnAgent(input.profile, input.task, input.busId, { name: input.name, parentRunId });
}

export function createSubagentTool({
  orchestra,
  store,
  parentRunId,
  ownerSessionId,
  resolveAgentHealth,
}: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const preparedInput = prepareStandaloneSubagentSpawn(orchestra, store, input, parentRunId, ownerSessionId);
        try {
          const run = await spawnSubagent(orchestra, preparedInput.input, parentRunId);
          return {
            run,
            bus: summarizeBus(store.getBus(preparedInput.bus.id) ?? preparedInput.bus),
            message: formatRunMessage(run),
          };
        } catch (error) {
          if (input.busId === undefined) orchestra.closeBus(preparedInput.bus.id);
          throw error;
        }
      }

      if (input.action === "status") {
        const run = orchestra.getRun(input.id, { busId: undefined });
        if (!run) return { message: formatMissingSubagentMessage(input.id) };
        requireSubagentTargetAuthorized(store, run, parentRunId, "status");
        const health = formatAgentHealth(resolveAgentHealth?.(run.id));
        return { run, message: formatRunMessage(run, undefined, health) };
      }

      if (input.action === "message") {
        const targetRun = orchestra.getRun(input.id, { busId: undefined });
        if (!targetRun) return { message: formatMissingSubagentMessage(input.id) };
        requireSubagentTargetAuthorized(store, targetRun, parentRunId, "message");
        const run = await orchestra.messageAgent(targetRun.id, input.message, { busId: undefined });
        return {
          run,
          message: formatRunMessage(run, `Messaged subagent ${run.name}; it is ${run.state}.`),
        };
      }

      const targetRun = orchestra.getRun(input.id, { busId: undefined });
      if (!targetRun) return { message: formatMissingSubagentMessage(input.id) };
      requireSubagentTargetAuthorized(store, targetRun, parentRunId, "close");
      requireSubagentCloseable(store, targetRun, parentRunId);
      const run = await orchestra.closeAgent(targetRun.id, { busId: undefined });
      if (run) closeStandalonePrivateBusIfUnused(store, (busId) => orchestra.closeBus(busId), run.busId);
      return {
        run,
        message: run ? formatRunMessage(run, `Closed subagent ${run.name}.`) : formatMissingSubagentMessage(input.id),
      };
    },
  };
}

export function defineSubagentPiTool(resolveTool: (ctx: ExtensionContext) => SubagentTool) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn and manage subagents.",
    promptSnippet: "Spawn, inspect, message, or close named subagents.",
    promptGuidelines: [
      "Omit busId for the default private bus; pass busId only when related agents should share an existing bus.",
      "Use subagent status/message/close with the returned run name.",
      "Use subagent close only after active descendants, any led workgroup, and any coordinated workflow are closed; it never cascades.",
      "For deeper trees, message the target child to clean up its descendants; use main/root for bottom-up recovery if it cannot.",
    ],
    parameters: SubagentToolParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = toSubagentInput(params as RawSubagentParams);
      const output = await resolveTool(ctx).execute(
        input.action === "spawn" ? withDefaultProfileModelInput(input, ctx) : input,
      );

      return {
        content: [{ type: "text", text: output.message }],
        details: boundSubagentOutputDetails(output),
      };
    },
  });
}

function toSubagentInput(params: RawSubagentParams): SubagentInput {
  if (params.action === "spawn") {
    return toSubagentSpawnInput({
      action: params.action,
      profile: params.profile,
      task: params.task,
      busId: params.busId,
      name: params.name,
    });
  }

  if (params.action === "status") return { action: "status", id: requireParam(params, "id", "subagent action=status") };

  if (params.action === "message") {
    return {
      action: "message",
      id: requireParam(params, "id", "subagent action=message"),
      message: requireParam(params, "message", "subagent action=message"),
    };
  }

  return { action: "close", id: requireParam(params, "id", "subagent action=close") };
}

export function toSubagentSpawnInput(
  params: RawSubagentSpawnParams,
  label = "subagent action=spawn",
): SubagentSpawnInput {
  if (params.action !== "spawn") throw new Error(`${label} requires action=spawn.`);
  const profile = requireParam(params, "profile", label);
  const task = requireParam(params, "task", label);
  const name = requireParam(params, "name", label);
  return {
    action: "spawn",
    profile: toAgentProfile(profile),
    task,
    busId: params.busId === undefined ? undefined : normalizeBusIdParam(params.busId),
    name: createPrefixedName("agent", name, "Subagent"),
  };
}

function prepareStandaloneSubagentSpawn(
  orchestra: OrchestraApi,
  store: AgentStore,
  input: SubagentSpawnInput,
  parentRunId: string | null,
  ownerSessionId: string,
): { input: SubagentSpawnInput & { busId: string }; bus: Bus } {
  const runName = createPrefixedName("agent", input.name, "Subagent");
  assertAgentRunNameAvailable(runName, store.listRuns(), "Subagent");
  const explicitBusId = input.busId === undefined ? undefined : normalizeBusIdParam(input.busId);
  if (explicitBusId !== undefined) {
    const bus = orchestra.getBus(explicitBusId);
    if (!bus) throw new Error(`Bus ${explicitBusId} not found.`);
    return { input: { ...input, name: runName, busId: bus.id }, bus };
  }

  validateStandalonePrivateBusNameBudget(input.name);
  const bus = orchestra.createBus({
    name: createStandalonePrivateBusName(input.name),
    metadata: { autoClose: "standalone-subagent-private", ownerSessionId },
  });
  try {
    subscribeStandaloneBusOwner(store, bus, parentRunId);
    return { input: { ...input, name: runName, busId: bus.id }, bus };
  } catch (error) {
    orchestra.closeBus(bus.id);
    throw error;
  }
}

function createStandalonePrivateBusName(requestedName: string): string {
  return createBusNameFromOwnerName(createPrefixedName("agent", requestedName, "Subagent"));
}

function validateStandalonePrivateBusNameBudget(requestedName: string): void {
  try {
    createStandalonePrivateBusName(requestedName);
  } catch {
    const maxLength = getBusOwnerRawNameBudget("agent");
    throw new Error(
      `Subagent name must be ${maxLength} characters or fewer when busId is omitted because the private bus name includes bus-agent-.`,
    );
  }
}

function normalizeBusIdParam(busId: string): string {
  return normalizeEntityName(busId, "subagent busId");
}

function subscribeStandaloneBusOwner(store: AgentStore, bus: Bus, parentRunId: string | null): void {
  if (!parentRunId) {
    subscribeMainToBus(store, bus);
    return;
  }

  store.saveBusSubscription(
    createBusSubscription({
      busId: bus.id,
      subscriberId: parentRunId,
      subscriberKind: "agent",
      lastDeliveredSeq: maxMessageSeq(bus.messages),
      deliveredSeqs: [],
    }),
  );
}

function summarizeBus(bus: Bus): BusSummary {
  return {
    id: bus.id,
    name: bus.name,
    state: bus.state,
    ...(bus.metadata ? { metadata: bus.metadata } : {}),
  };
}

export function toAgentProfile(profile: RawAgentProfileParams): AgentProfile {
  if (!Array.isArray(profile.tools)) throw new Error(`Profile "${profile.name ?? "custom"}" requires tools.`);
  if (profile.name === undefined) throw new Error("Profile requires name.");
  if (profile.systemPrompt === undefined) throw new Error(`Profile "${profile.name}" requires systemPrompt.`);
  return {
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
  };
}

export function withDefaultProfileModel(profile: AgentProfile, ctx: ExtensionContext): AgentProfile {
  // Keep an explicit profile.model as-is; the runtime resolves it, or throws on
  // an unknown id, at spawn time. Omit it to inherit the current Pi model.
  if (profile.model) return profile;
  if (!ctx.model) return profile;
  return {
    ...profile,
    model: formatModelId(ctx.model),
  };
}

export function withDefaultProfileModelInput<T extends { profile: AgentProfile }>(input: T, ctx: ExtensionContext): T {
  return {
    ...input,
    profile: withDefaultProfileModel(input.profile, ctx),
  };
}

function requireSubagentTargetAuthorized(
  store: AgentStore,
  targetRun: AgentRun,
  parentRunId: string | null,
  action: string,
): void {
  if (parentRunId === null) return;
  if (action === "status" && targetRun.id === parentRunId) return;
  if (targetRun.parentRunId === parentRunId) return;
  throw new Error(`Only main or direct parent ${parentRunId} can ${action} subagent ${targetRun.name}.`);
}

function requireSubagentCloseable(store: AgentStore, targetRun: AgentRun, parentRunId: string | null): void {
  if (targetRun.state === "closed") return;

  const ledWorkgroup = findRunningLedWorkgroup(store.listWorkgroups(), targetRun.id);
  if (ledWorkgroup) {
    throw new Error(
      `Agent ${targetRun.name} leads running workgroup ${ledWorkgroup.name}; finish or cancel it before closing the agent.`,
    );
  }

  const coordinatedWorkflow = findRunningCoordinatedWorkflow(store.listWorkflows(), targetRun.id);
  if (coordinatedWorkflow) {
    throw new Error(
      `Agent ${targetRun.name} coordinates running workflow ${coordinatedWorkflow.name}; cancel it before closing the agent.`,
    );
  }

  const activeDescendant = findActiveDescendant(store.listRuns(), targetRun.id);
  if (!activeDescendant) return;
  const recovery =
    parentRunId === null
      ? "close active descendants bottom-up before closing the agent."
      : `message ${targetRun.name} to close its descendants, or ask main/root to clean them up bottom-up before closing the agent.`;
  throw new Error(`Agent ${targetRun.name} has active descendant ${activeDescendant.name}; ${recovery}`);
}

function findActiveDescendant(runs: AgentRun[], runId: AgentRun["id"]): AgentRun | undefined {
  const parentRunIds = new Map(runs.map((run) => [run.id, run.parentRunId]));
  return runs.find((run) => {
    if (run.id === runId || !isAgentRunActive(run)) return false;

    const visited = new Set<string>();
    for (
      let parentRunId = run.parentRunId;
      parentRunId && !visited.has(parentRunId);
      parentRunId = parentRunIds.get(parentRunId) ?? null
    ) {
      if (parentRunId === runId) return true;
      visited.add(parentRunId);
    }
    return false;
  });
}

function formatMissingSubagentMessage(id: string): string {
  return `Subagent ${id} not found.`;
}

function formatRunMessage(run: AgentRun, headline = `Subagent ${run.name} is ${run.state}.`, suffix?: string): string {
  const fullHeadline = suffix ? `${headline} ${suffix}` : headline;
  if (run.result === null) return fullHeadline;

  const parts = [fullHeadline, "", `Result: ${run.result.status}`, run.result.summary];
  if (run.result.data !== undefined) {
    parts.push("", "Data:", formatResultData(run.result.data));
  }
  return parts.join("\n");
}

function boundSubagentOutputDetails(output: SubagentOutput): SubagentOutput {
  return output.run ? { ...output, run: boundResultData(output.run) } : output;
}

function formatModelId(model: AgentProfileModel): string {
  return `${model.provider}/${model.id}`;
}

export type RawSubagentSpawnParams = {
  action?: "spawn";
  profile?: RawAgentProfileParams;
  task?: string;
  busId?: string;
  name?: string;
};

type RawSubagentParams = {
  action: "spawn" | "status" | "message" | "close";
  profile?: RawAgentProfileParams;
  task?: string;
  busId?: string;
  name?: string;
  id?: string;
  message?: string;
};

export type RawAgentProfileParams = {
  name?: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
};

type AgentProfileModel = NonNullable<ExtensionContext["model"]>;
