import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AGENT_RESULT_STATUS_VALUES,
  type AgentResult,
  type AgentResultStatus,
  type AgentRun,
} from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import { createWorkgroupIdentity, createWorkgroupRun, type WorkgroupRun } from "../core/workgroup.ts";
import { closeAgentRuns, formatError, normalizeEntityName, pluralize, resolveRunName } from "../utils.ts";
import {
  AgentProfileParams,
  spawnSubagent,
  SubagentRunNameParam,
  toAgentProfile,
  type RawAgentProfileParams,
  type SubagentSpawnInput,
  withDefaultProfileModelInput,
} from "./subagent.ts";

type WorkgroupMemberInput = Omit<SubagentSpawnInput, "action" | "busId">;

export type WorkgroupInput =
  | {
      action: "create";
      name: string;
      goal: string;
    }
  | {
      action: "add_members";
      id: string;
      members: WorkgroupMemberInput[];
    }
  | {
      action: "finish";
      id: string;
      result: AgentResult;
    }
  | {
      action: "cancel";
      id: string;
    }
  | {
      action: "status";
      id: string;
    };

export type WorkgroupOutput =
  | {
      action: "create";
      workgroup: WorkgroupRun;
      bus: Bus;
      runs: [];
      message: string;
    }
  | {
      action: "add_members";
      workgroup: WorkgroupRun;
      bus: Bus;
      runs: AgentRun[];
      message: string;
    }
  | {
      action: "finish";
      workgroup: WorkgroupRun;
    }
  | {
      action: "cancel";
      workgroup: WorkgroupRun;
      alreadyClosed: boolean;
      message: string;
    }
  | {
      action: "status";
      workgroup: WorkgroupRun;
      bus: Bus;
      runs: AgentRun[];
      message: string;
    }
  | {
      action: "not_found";
      id: string;
      runs: [];
      message: string;
    };

export interface WorkgroupTool {
  name: "workgroup";
  execute(input: WorkgroupInput): Promise<WorkgroupOutput>;
}

export interface WorkgroupLaunchEvent {
  input: Extract<WorkgroupInput, { action: "add_members" }>;
  workgroup: WorkgroupRun;
  bus: Bus;
  runIds: string[];
  runNames: string[];
}

export interface WorkgroupLaunchedEvent extends WorkgroupLaunchEvent {
  output: Extract<WorkgroupOutput, { action: "add_members" }>;
}

export interface WorkgroupLaunchFailedEvent extends WorkgroupLaunchEvent {
  error: unknown;
}

export interface WorkgroupToolDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
  onWorkgroupLaunching: ((event: WorkgroupLaunchEvent) => void) | undefined;
  onWorkgroupLaunched: ((event: WorkgroupLaunchedEvent) => void) | undefined;
  onWorkgroupLaunchFailed: ((event: WorkgroupLaunchFailedEvent) => void) | undefined;
}

const WorkgroupActionParams = Type.String({
  enum: ["create", "add_members", "finish", "cancel", "status"],
  description: "create/add_members/finish/cancel/status a workgroup.",
});

const WorkgroupToolParams = Type.Object(
  {
    action: WorkgroupActionParams,
    name: Type.Optional(
      Type.String({
        description: "Required for create. Unique workgroup name.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Required for add_members/finish/cancel/status. Workgroup name.",
      }),
    ),
    goal: Type.Optional(
      Type.String({
        description: "Required for create. Shared goal.",
      }),
    ),
    members: Type.Optional(
      Type.Array(
        Type.Object(
          {
            profile: AgentProfileParams,
            task: Type.String({
              description: "Task to delegate to this workgroup member.",
            }),
            name: SubagentRunNameParam,
          },
          {
            additionalProperties: false,
            description: "Required for add_members. Member profile/task/name.",
          },
        ),
        {
          description: "Required for add_members. Member subagents.",
          minItems: 1,
        },
      ),
    ),
    status: Type.Optional(
      Type.String({
        enum: [...AGENT_RESULT_STATUS_VALUES],
        description: "Required for finish. Result status.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description: "Required for finish. Concise summary.",
      }),
    ),
    data: Type.Optional(
      Type.Unknown({
        description: "Optional finish data.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface SpawnSuccess {
  member: SubagentSpawnInput;
  run: AgentRun;
}

interface SpawnFailure {
  member: SubagentSpawnInput;
  error: unknown;
}

interface WorkgroupCancellation {
  workgroup: WorkgroupRun;
  alreadyClosed: boolean;
}

const WORKGROUP_CANCELLED_SUMMARY = "Workgroup cancelled.";

export function createWorkgroupTool({
  orchestra,
  store,
  onWorkgroupLaunching,
  onWorkgroupLaunched,
  onWorkgroupLaunchFailed,
}: WorkgroupToolDeps): WorkgroupTool {
  return {
    name: "workgroup",

    async execute(input) {
      if (input.action === "create") {
        const identity = createWorkgroupIdentity(input.name, store.listWorkgroups());
        const bus = orchestra.createBus({ name: `${identity.name}-bus` });

        const workgroup = createWorkgroupRun({
          identity,
          busId: bus.id,
          goal: input.goal,
          leaderRunId: null,
        });
        store.saveWorkgroup(workgroup);
        return {
          action: "create",
          workgroup,
          bus,
          runs: [],
          message: formatWorkgroupStatusMessage(store, workgroup, bus),
        };
      }

      const workgroup = findWorkgroup(store, input.id);
      if (!workgroup)
        return { action: "not_found", id: input.id, runs: [], message: formatWorkgroupNotFound(input.id) };
      const bus = orchestra.getBus(workgroup.busId);
      if (!bus) throw new Error(`Bus ${workgroup.busId} not found.`);

      if (input.action === "status") {
        return {
          action: "status",
          workgroup,
          bus,
          runs: collectWorkgroupMemberRuns(store, workgroup),
          message: formatWorkgroupStatusMessage(store, workgroup, bus),
        };
      }

      if (input.action === "finish") {
        if (workgroup.state !== "running") throw new Error(`Workgroup ${workgroup.name} is ${workgroup.state}.`);
        const closedWorkgroup = await closeWorkgroupRun(orchestra, store, workgroup, {
          includeLeader: false,
          result: input.result,
        });
        return {
          action: "finish",
          workgroup: closedWorkgroup,
        };
      }

      if (input.action === "cancel") {
        const cancellation = await cancelWorkgroup(orchestra, store, workgroup);
        return {
          action: "cancel",
          ...cancellation,
          message: formatWorkgroupCancelMessage(cancellation),
        };
      }

      if (workgroup.state !== "running") throw new Error(`Workgroup ${workgroup.name} is ${workgroup.state}.`);
      if (input.members.length === 0) throw new Error("workgroup action=add_members requires members.");

      const members = prepareMembers(input.members, orchestra.listRuns({ busId: undefined }), bus);

      const runNames = members.map((member) => member.name);
      onWorkgroupLaunching?.({ input, workgroup, bus, runIds: [], runNames });
      let launchFailedNotified = false;
      try {
        const spawnResults = await Promise.allSettled(
          members.map(async (member): Promise<SpawnSuccess> => {
            const run = await spawnSubagent(orchestra, member);
            return { member, run };
          }),
        );

        const successes = collectSpawnSuccesses(spawnResults);
        const failures = collectSpawnFailures(members, spawnResults);
        if (failures.length > 0) {
          const runIds = successes.map((success) => success.run.id);
          onWorkgroupLaunchFailed?.({
            input,
            workgroup,
            bus,
            runIds,
            runNames,
            error: new Error("Failed to launch every workgroup member."),
          });
          launchFailedNotified = true;
          const cleanupResults = await Promise.allSettled(
            successes.map((success) => orchestra.closeAgent(success.run.id, { busId: undefined })),
          );
          throw new Error(formatLaunchFailure(failures, successes, cleanupResults));
        }

        const runs = successes.map((success) => success.run);
        const latestWorkgroup = store.getWorkgroup(workgroup.id);
        if (!latestWorkgroup || latestWorkgroup.state !== "running") {
          const runIds = runs.map((run) => run.id);
          const error = new Error(
            latestWorkgroup
              ? `Workgroup ${latestWorkgroup.name} is ${latestWorkgroup.state}.`
              : `Workgroup ${workgroup.name} not found.`,
          );
          onWorkgroupLaunchFailed?.({
            input,
            workgroup: latestWorkgroup ?? workgroup,
            bus,
            runIds,
            runNames,
            error,
          });
          launchFailedNotified = true;
          await closeAgentRuns(orchestra, runIds);
          throw error;
        }

        const updatedWorkgroup = {
          ...latestWorkgroup,
          memberRunIds: [...new Set([...latestWorkgroup.memberRunIds, ...runs.map((run) => run.id)])],
        };
        store.saveWorkgroup(updatedWorkgroup);
        const output: Extract<WorkgroupOutput, { action: "add_members" }> = {
          action: "add_members",
          workgroup: updatedWorkgroup,
          bus,
          runs,
          message: formatWorkgroupMembersAddedMessage(bus, updatedWorkgroup, runs),
        };
        onWorkgroupLaunched?.({
          input,
          workgroup: updatedWorkgroup,
          bus,
          runIds: runs.map((run) => run.id),
          runNames,
          output,
        });
        return output;
      } catch (error) {
        if (!launchFailedNotified) onWorkgroupLaunchFailed?.({ input, workgroup, bus, runIds: [], runNames, error });
        throw error;
      }
    },
  };
}

export interface CloseWorkgroupRunOptions {
  includeLeader: boolean;
  /** undefined preserves the current result; null clears it. */
  result: AgentResult | null | undefined;
}

export async function closeWorkgroupRun(
  orchestra: OrchestraApi,
  store: AgentStore,
  workgroup: WorkgroupRun,
  options: CloseWorkgroupRunOptions,
): Promise<WorkgroupRun> {
  const latestWorkgroup = store.getWorkgroup(workgroup.id) ?? workgroup;
  const runIds = collectWorkgroupCloseRunIds(latestWorkgroup, options.includeLeader);

  if (latestWorkgroup.state === "closed") {
    await closeAgentRuns(orchestra, runIds);
    orchestra.closeBus(latestWorkgroup.busId);
    return latestWorkgroup;
  }

  const result = options.result === undefined ? latestWorkgroup.result : options.result;
  const closingWorkgroup: WorkgroupRun = { ...latestWorkgroup, state: "closing", result };
  store.saveWorkgroup(closingWorkgroup);
  await closeAgentRuns(orchestra, runIds);
  orchestra.closeBus(latestWorkgroup.busId);

  const latestAfterCleanup = store.getWorkgroup(workgroup.id) ?? closingWorkgroup;
  const initiallyClosedRunIds = new Set(runIds);
  const addedRunIds = collectWorkgroupCloseRunIds(latestAfterCleanup, options.includeLeader).filter(
    (runId) => !initiallyClosedRunIds.has(runId),
  );
  await closeAgentRuns(orchestra, addedRunIds);

  const closedWorkgroup: WorkgroupRun = { ...latestAfterCleanup, state: "closed", result };
  store.saveWorkgroup(closedWorkgroup);
  return closedWorkgroup;
}

function collectWorkgroupCloseRunIds(workgroup: WorkgroupRun, includeLeader: boolean): string[] {
  return [...workgroup.memberRunIds, ...(includeLeader && workgroup.leaderRunId ? [workgroup.leaderRunId] : [])];
}

async function cancelWorkgroup(
  orchestra: OrchestraApi,
  store: AgentStore,
  workgroup: WorkgroupRun,
): Promise<WorkgroupCancellation> {
  const latestWorkgroup = store.getWorkgroup(workgroup.id) ?? workgroup;
  const alreadyClosed = latestWorkgroup.state === "closed";
  const result: AgentResult = latestWorkgroup.result ?? {
    status: "blocked",
    summary: WORKGROUP_CANCELLED_SUMMARY,
  };
  const closedWorkgroup = await closeWorkgroupRun(orchestra, store, latestWorkgroup, {
    includeLeader: true,
    result,
  });
  return { workgroup: closedWorkgroup, alreadyClosed };
}

export function defineWorkgroupPiTool(resolveTool: (ctx: ExtensionContext) => WorkgroupTool) {
  return defineTool({
    name: "workgroup",
    label: "Workgroup",
    description: "Coordinate a led subagent workgroup.",
    promptSnippet: "Create a workgroup, add members, then finish it.",
    promptGuidelines: [
      "Use workgroup create first; it creates the private bus.",
      "Use workgroup add_members with member profile/task/name only.",
      "Only the workgroup leader calls workgroup finish.",
      "Use workgroup cancel from a supervising parent scope to abort a workgroup and dispose all resources.",
    ],
    parameters: WorkgroupToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModelsForWorkgroup(toWorkgroupInput(params as RawWorkgroupParams), ctx);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: formatWorkgroupOutputMessage(output) }],
        details: output,
      };
    },
  });
}

function toWorkgroupInput(params: RawWorkgroupParams): WorkgroupInput {
  if (params.action === "create") {
    if (!params.name) throw new Error("workgroup action=create requires name.");
    if (!params.goal) throw new Error("workgroup action=create requires goal.");
    return { action: "create", name: params.name, goal: params.goal };
  }

  if (params.action === "add_members") {
    if (!params.id) throw new Error("workgroup action=add_members requires id.");
    if (!params.members || params.members.length === 0)
      throw new Error("workgroup action=add_members requires members.");
    return {
      action: "add_members",
      id: params.id,
      members: params.members.map((member, index) => toWorkgroupMemberInput(member, `workgroup member ${index + 1}`)),
    };
  }

  if (params.action === "finish") {
    if (!params.id) throw new Error("workgroup action=finish requires id.");
    if (!params.status) throw new Error("workgroup action=finish requires status.");
    if (!params.summary) throw new Error("workgroup action=finish requires summary.");
    const result: AgentResult = { status: params.status, summary: params.summary };
    if (params.data !== undefined) result.data = params.data;
    return { action: "finish", id: params.id, result };
  }

  if (params.action === "cancel") {
    if (!params.id) throw new Error("workgroup action=cancel requires id.");
    return { action: "cancel", id: params.id };
  }

  if (!params.id) throw new Error("workgroup action=status requires id.");
  return { action: "status", id: params.id };
}

function toWorkgroupMemberInput(params: RawWorkgroupMemberParams, label: string): WorkgroupMemberInput {
  if (!params.profile) throw new Error(`${label} requires profile.`);
  if (!params.task) throw new Error(`${label} requires task.`);
  if (!params.name) throw new Error(`${label} requires name.`);
  return {
    profile: toAgentProfile(params.profile),
    task: params.task,
    name: params.name,
  };
}

function withDefaultModelsForWorkgroup(input: WorkgroupInput, ctx: ExtensionContext): WorkgroupInput {
  if (input.action !== "add_members") return input;
  return {
    ...input,
    members: withDefaultModelsForSubagentSpawns(input.members, ctx),
  };
}

function withDefaultModelsForSubagentSpawns(
  members: WorkgroupMemberInput[],
  ctx: ExtensionContext,
): WorkgroupMemberInput[] {
  return members.map((member) => withDefaultProfileModelInput(member, ctx));
}

function findWorkgroup(store: AgentStore, id: string): WorkgroupRun | undefined {
  return store.getWorkgroup(id) ?? store.getWorkgroupByName(id);
}

function collectWorkgroupMemberRuns(store: AgentStore, workgroup: WorkgroupRun): AgentRun[] {
  return workgroup.memberRunIds.flatMap((runId) => {
    const run = store.getRun(runId);
    return run ? [run] : [];
  });
}

function prepareMembers(members: WorkgroupMemberInput[], existingRuns: AgentRun[], bus: Bus): SubagentSpawnInput[] {
  const reservedNames = new Set<string>();
  for (const run of existingRuns) {
    reservedNames.add(run.id);
    reservedNames.add(run.name);
  }

  return members.map((member) => {
    const name = normalizeEntityName(member.name, "Workgroup member");
    if (reservedNames.has(name)) {
      throw new Error(`Workgroup member name "${name}" is already in use.`);
    }

    reservedNames.add(name);
    return { action: "spawn", ...member, busId: bus.id, name };
  });
}

function collectSpawnSuccesses(results: Array<PromiseSettledResult<SpawnSuccess>>): SpawnSuccess[] {
  return results
    .filter((result): result is PromiseFulfilledResult<SpawnSuccess> => result.status === "fulfilled")
    .map((result) => result.value);
}

function collectSpawnFailures(
  members: SubagentSpawnInput[],
  results: Array<PromiseSettledResult<SpawnSuccess>>,
): SpawnFailure[] {
  return results.flatMap((result, index) =>
    result.status === "rejected" ? [{ member: members[index], error: result.reason }] : [],
  );
}

function formatLaunchFailure(
  failures: SpawnFailure[],
  successes: SpawnSuccess[],
  cleanupResults: Array<PromiseSettledResult<AgentRun | undefined>>,
): string {
  const parts = ["Failed to launch every workgroup member.", "", "Failures:"];
  for (const failure of failures) {
    parts.push(`- ${failure.member.name}: ${formatError(failure.error)}`);
  }

  if (successes.length > 0) {
    parts.push("", "Cleanup:");
    for (let index = 0; index < successes.length; index++) {
      const success = successes[index];
      const cleanupResult = cleanupResults[index];
      if (cleanupResult?.status === "rejected") {
        parts.push(`- ${success.run.name}: failed to close (${formatError(cleanupResult.reason)})`);
      } else {
        parts.push(`- ${success.run.name}: closed`);
      }
    }
  }

  return parts.join("\n");
}

function formatWorkgroupOutputMessage(output: WorkgroupOutput): string {
  if (output.action === "finish") return formatWorkgroupTerminalMessage("Finished", output.workgroup);
  if (output.action === "cancel") return output.message;
  return output.message;
}

function formatWorkgroupTerminalMessage(verb: string, workgroup: WorkgroupRun): string {
  return [
    `${verb} workgroup ${workgroup.name}.`,
    "",
    ...formatWorkgroupResultLines(workgroup),
    "",
    "Pi-orchestra recorded the final output and will deliver any applicable workgroup.finished event.",
  ].join("\n");
}

function formatWorkgroupCancelMessage(cancellation: WorkgroupCancellation): string {
  const { workgroup } = cancellation;
  if (cancellation.alreadyClosed) {
    return [
      `Workgroup ${workgroup.name} was already closed.`,
      "",
      ...formatWorkgroupResultLines(workgroup),
      "",
      "No cancellation was needed; existing result was preserved.",
    ].join("\n");
  }

  return formatWorkgroupTerminalMessage("Cancelled", workgroup);
}

function formatWorkgroupResultLines(workgroup: WorkgroupRun): string[] {
  return [`Status: ${workgroup.result?.status ?? "unknown"}`, `Summary: ${workgroup.result?.summary ?? "None."}`];
}

function formatWorkgroupMembersAddedMessage(bus: Bus, workgroup: WorkgroupRun, runs: AgentRun[]): string {
  return [
    `Added ${runs.length} ${pluralize("member", runs.length)} to workgroup ${workgroup.name} on bus ${bus.name}.`,
    "",
    "Runs:",
    ...runs.map((run) => `- ${run.name}: ${run.state}`),
    "",
    "Pi-orchestra will deliver workgroup.member_finished events as members finish.",
  ].join("\n");
}

function formatWorkgroupStatusMessage(store: AgentStore, workgroup: WorkgroupRun, bus: Bus): string {
  const runs = collectWorkgroupMemberRuns(store, workgroup);
  return [
    `Workgroup ${workgroup.name} on bus ${bus.name}.`,
    "",
    `Goal: ${workgroup.goal}`,
    `State: ${workgroup.state}`,
    `Result: ${workgroup.result ? `${workgroup.result.status} — ${workgroup.result.summary}` : "none"}`,
    `Leader: ${formatWorkgroupLeaderName(store, workgroup)}`,
    "",
    `Members (${runs.length}):`,
    ...(runs.length > 0 ? runs.map((run) => `- ${run.name}: ${run.state}`) : ["- none"]),
  ].join("\n");
}

function formatWorkgroupLeaderName(store: AgentStore, workgroup: WorkgroupRun): string {
  if (!workgroup.leaderRunId) return "main";
  return resolveRunName(store, workgroup.leaderRunId);
}

function formatWorkgroupNotFound(id: string): string {
  return `Workgroup ${id} not found.`;
}

type RawWorkgroupParams = {
  action: "create" | "add_members" | "finish" | "cancel" | "status";
  name?: string;
  id?: string;
  goal?: string;
  members?: RawWorkgroupMemberParams[];
  status?: AgentResultStatus;
  summary?: string;
  data?: unknown;
};

type RawWorkgroupMemberParams = {
  profile?: RawAgentProfileParams;
  task?: string;
  name?: string;
};
