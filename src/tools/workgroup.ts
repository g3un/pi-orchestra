import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentHealth, type ResolveAgentHealth } from "../agent-health.ts";
import {
  AGENT_RESULT_STATUS_VALUES,
  type AgentResult,
  type AgentResultStatus,
  type AgentRun,
} from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import {
  createWorkgroupIdentity,
  createWorkgroupRun,
  WORKGROUP_NAME_MAX_LENGTH,
  type WorkgroupRun,
} from "../core/workgroup.ts";
import { createBusNameFromOwnerName, createPrefixedName } from "../naming.ts";
import {
  closeAgentRuns,
  assertAgentRunNameAvailable,
  findEntity,
  formatError,
  pluralize,
  requireParam,
  resolveRunName,
} from "../utils.ts";
import { DETAIL_MAX_COLLECTION_ITEMS, boundDetailValue, boundResultData } from "../formatting.ts";
import {
  AgentProfileParams,
  spawnSubagent,
  SubagentRunNameParam,
  toAgentProfile,
  type RawAgentProfileParams,
  type SubagentSpawnInput,
  withDefaultProfileModelInput,
} from "./subagent.ts";
import { boundBusDetails } from "./bus.ts";

export type WorkgroupMemberInput = Omit<SubagentSpawnInput, "action" | "busId">;

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
  parentRunId: string | null;
  ownerSessionId: string;
  resolveAgentHealth: ResolveAgentHealth | undefined;
}

export interface CreateAndLaunchWorkgroupOptions extends WorkgroupToolDeps {
  name: string;
  goal: string;
  members: WorkgroupMemberInput[];
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
  parentRunId,
  ownerSessionId,
  resolveAgentHealth,
}: WorkgroupToolDeps): WorkgroupTool {
  return {
    name: "workgroup",

    async execute(input) {
      if (input.action === "create") {
        const identity = createWorkgroupIdentity(
          createPrefixedName("group", input.name, "Workgroup", WORKGROUP_NAME_MAX_LENGTH),
          store.listWorkgroups(),
        );
        const bus = orchestra.createBus({ name: createBusNameFromOwnerName(identity.name) });

        const workgroup = createWorkgroupRun({
          identity,
          busId: bus.id,
          ownerSessionId,
          goal: input.goal,
          leaderRunId: parentRunId,
        });
        try {
          store.saveWorkgroup(workgroup);
        } catch (error) {
          orchestra.closeBus(bus.id);
          throw error;
        }
        return {
          action: "create",
          workgroup,
          bus,
          runs: [],
          message: formatWorkgroupStatusMessage(store, workgroup, bus, undefined),
        };
      }

      const workgroup = findWorkgroup(store, input.id);
      if (!workgroup)
        return { action: "not_found", id: input.id, runs: [], message: formatWorkgroupNotFound(input.id) };
      const bus = orchestra.getBus(workgroup.busId);
      if (!bus) throw new Error(`Bus ${workgroup.busId} not found.`);

      if (input.action === "status") {
        requireWorkgroupParticipant(store, workgroup, parentRunId, "status");
        return {
          action: "status",
          workgroup,
          bus,
          runs: collectWorkgroupMemberRuns(store, workgroup),
          message: formatWorkgroupStatusMessage(store, workgroup, bus, resolveAgentHealth),
        };
      }

      if (input.action === "finish") {
        requireWorkgroupLeader(workgroup, parentRunId, "finish");
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
        requireWorkgroupSupervisor(store, workgroup, parentRunId, "cancel");
        const cancellation = await cancelWorkgroup(orchestra, store, workgroup);
        return {
          action: "cancel",
          ...cancellation,
          message: formatWorkgroupCancelMessage(cancellation),
        };
      }

      requireWorkgroupLeader(workgroup, parentRunId, "add_members");
      if (workgroup.state !== "running") throw new Error(`Workgroup ${workgroup.name} is ${workgroup.state}.`);
      if (input.members.length === 0) throw new Error("workgroup action=add_members requires members.");

      const members = prepareMembers(input.members, orchestra.listRuns({ busId: undefined }), bus);

      const runNames = members.map((member) => member.name);
      onWorkgroupLaunching?.({ input, workgroup, bus, runIds: [], runNames });
      let launchFailedNotified = false;
      try {
        const spawnResults = await Promise.allSettled(
          members.map(async (member): Promise<SpawnSuccess> => {
            const run = await spawnSubagent(orchestra, member, workgroup.leaderRunId);
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

export async function createAndLaunchWorkgroup({
  name,
  goal,
  members,
  ...deps
}: CreateAndLaunchWorkgroupOptions): Promise<Extract<WorkgroupOutput, { action: "add_members" }>> {
  if (members.length === 0) throw new Error("workflow add_workgroup requires members.");

  const tool = createWorkgroupTool(deps);
  const created = await tool.execute({ action: "create", name, goal });
  if (created.action !== "create") throw new Error(`Unexpected workgroup ${created.action} output from create.`);

  const workgroup = created.workgroup;
  try {
    const launched = await tool.execute({ action: "add_members", id: workgroup.id, members });
    if (launched.action !== "add_members")
      throw new Error(`Unexpected workgroup ${launched.action} output from add_members.`);
    return launched;
  } catch (error) {
    await closeWorkgroupRun(deps.orchestra, deps.store, workgroup, {
      includeLeader: false,
      result: { status: "failed", summary: formatError(error) },
    });
    throw error;
  }
}

export interface CloseWorkgroupRunOptions {
  includeLeader: boolean;
  /** undefined keeps the current result; null clears it. */
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

export function workgroupOwnsLeaderRun(store: AgentStore, workgroup: WorkgroupRun): boolean {
  if (!workgroup.leaderRunId) return false;
  return store.getRun(workgroup.leaderRunId)?.busId === workgroup.busId;
}

export async function cancelWorkgroup(
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
    includeLeader: workgroupOwnsLeaderRun(store, latestWorkgroup),
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
      "Use workgroup cancel from a supervising parent scope, or from main/root during recovery, to abort a workgroup and dispose all resources.",
    ],
    parameters: WorkgroupToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModelsForWorkgroup(toWorkgroupInput(params as RawWorkgroupParams), ctx);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: formatWorkgroupOutputMessage(output) }],
        details: boundWorkgroupOutputDetails(output),
      };
    },
  });
}

export function boundWorkgroupOutputDetails(output: WorkgroupOutput): unknown {
  const bounded = boundWorkgroupResultData(output);
  const withBus = "bus" in bounded ? { ...bounded, bus: boundBusDetails(bounded.bus) } : bounded;
  if (!("runs" in withBus)) return withBus;
  const visibleRuns = withBus.runs.slice(0, DETAIL_MAX_COLLECTION_ITEMS).map(boundDetailValue);
  return {
    ...withBus,
    runs: visibleRuns,
    omittedRunsCount: Math.max(0, withBus.runs.length - visibleRuns.length),
  };
}

function boundWorkgroupResultData<T extends WorkgroupOutput>(output: T): T {
  if (!("workgroup" in output)) return output;
  const workgroup = boundWorkgroupRunDetails(output.workgroup);
  return workgroup === output.workgroup ? output : { ...output, workgroup };
}

export function boundWorkgroupRunDetails(workgroup: WorkgroupRun): WorkgroupRun {
  return boundResultData(workgroup);
}

function toWorkgroupInput(params: RawWorkgroupParams): WorkgroupInput {
  if (params.action === "create") {
    return {
      action: "create",
      name: requireParam(params, "name", "workgroup action=create"),
      goal: requireParam(params, "goal", "workgroup action=create"),
    };
  }

  if (params.action === "add_members") {
    const members = requireParam(params, "members", "workgroup action=add_members");
    if (members.length === 0) throw new Error("workgroup action=add_members requires members.");
    return {
      action: "add_members",
      id: requireParam(params, "id", "workgroup action=add_members"),
      members: members.map((member, index) => toWorkgroupMemberInput(member, `workgroup member ${index + 1}`)),
    };
  }

  if (params.action === "finish") {
    const result: AgentResult = {
      status: requireParam(params, "status", "workgroup action=finish"),
      summary: requireParam(params, "summary", "workgroup action=finish"),
    };
    if (params.data !== undefined) result.data = params.data;
    return { action: "finish", id: requireParam(params, "id", "workgroup action=finish"), result };
  }

  if (params.action === "cancel")
    return { action: "cancel", id: requireParam(params, "id", "workgroup action=cancel") };

  return { action: "status", id: requireParam(params, "id", "workgroup action=status") };
}

function toWorkgroupMemberInput(params: RawWorkgroupMemberParams, label: string): WorkgroupMemberInput {
  const profile = requireParam(params, "profile", label);
  const task = requireParam(params, "task", label);
  const name = requireParam(params, "name", label);
  return {
    profile: toAgentProfile(profile),
    task,
    name,
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

function requireWorkgroupLeader(workgroup: WorkgroupRun, parentRunId: string | null, action: string): void {
  if (parentRunId === null && workgroup.leaderRunId === null) return;
  if (parentRunId !== null && parentRunId === workgroup.leaderRunId) return;
  throw new Error(`Only leader ${workgroup.leaderRunId ?? "main"} can ${action} workgroup ${workgroup.name}.`);
}

function requireWorkgroupParticipant(
  store: AgentStore,
  workgroup: WorkgroupRun,
  parentRunId: string | null,
  action: string,
): void {
  if (parentRunId === null) return;
  if (parentRunId === workgroup.leaderRunId) return;
  if (parentRunId !== null && workgroup.memberRunIds.includes(parentRunId)) return;
  requireWorkgroupSupervisor(store, workgroup, parentRunId, action);
}

function requireWorkgroupSupervisor(
  store: AgentStore,
  workgroup: WorkgroupRun,
  parentRunId: string | null,
  action: string,
): void {
  if (parentRunId === null) return;
  if (!workgroup.leaderRunId) throw new Error(`Only a supervising parent can ${action} workgroup ${workgroup.name}.`);

  const leaderRun = store.getRun(workgroup.leaderRunId);
  if (leaderRun && parentRunId === leaderRun.parentRunId) return;
  throw new Error(`Only a supervising parent can ${action} workgroup ${workgroup.name}.`);
}

function findWorkgroup(store: AgentStore, id: string): WorkgroupRun | undefined {
  return findEntity(
    id,
    "group",
    (workgroupId) => store.getWorkgroup(workgroupId),
    () => store.listWorkgroups(),
    (workgroup) => workgroup.state !== "closed",
  );
}

function collectWorkgroupMemberRuns(store: AgentStore, workgroup: WorkgroupRun): AgentRun[] {
  return workgroup.memberRunIds.flatMap((runId) => {
    const run = store.getRun(runId);
    return run ? [run] : [];
  });
}

function prepareMembers(
  members: WorkgroupMemberInput[],
  existingRuns: Array<Pick<AgentRun, "id" | "name" | "state">>,
  bus: Bus,
): SubagentSpawnInput[] {
  const reservableRuns = [...existingRuns];

  return members.map((member) => {
    const name = createPrefixedName("agent", member.name, "Workgroup member");
    assertAgentRunNameAvailable(name, reservableRuns, "Workgroup member");

    reservableRuns.push({ id: name, name, state: "running" });
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

function formatWorkgroupStatusMessage(
  store: AgentStore,
  workgroup: WorkgroupRun,
  bus: Bus,
  resolveAgentHealth: ResolveAgentHealth | undefined,
): string {
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
    ...(runs.length > 0 ? runs.map((run) => formatWorkgroupMemberStatusLine(run, resolveAgentHealth)) : ["- none"]),
  ].join("\n");
}

function formatWorkgroupMemberStatusLine(run: AgentRun, resolveAgentHealth: ResolveAgentHealth | undefined): string {
  const health = formatAgentHealth(resolveAgentHealth?.(run.id));
  return `- ${run.name}: ${run.state} — ${formatWorkgroupMemberRuntime(run)}${health ? ` ${health}` : ""}`;
}

function formatWorkgroupMemberRuntime(run: AgentRun): string {
  return [
    run.profile.model ?? "inherited model",
    run.profile.thinkingLevel ? `thinking ${run.profile.thinkingLevel}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
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
