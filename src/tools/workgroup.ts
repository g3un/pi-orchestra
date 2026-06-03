import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { AgentResultStatus } from "../core/subagent.ts";
import type { OrchestraApi, WaitRunResult } from "../core/orchestra.ts";
import { WORKGROUP_STRATEGY_VALUES, type WorkgroupMember, type WorkgroupStrategy } from "../core/workgroup.ts";
import { closeAgentRuns, formatError, formatNamedEntityLabel, normalizeEntityName, slugify } from "../utils.ts";
import {
  AgentProfileParams,
  spawnSubagent,
  SubagentRunNameParam,
  type SubagentSpawnInput,
  withDefaultProfileModel,
} from "./subagent.ts";

export type { WorkgroupMember, WorkgroupStrategy } from "../core/workgroup.ts";

export interface WorkgroupInput {
  busId: string;
  goal: string;
  strategy: WorkgroupStrategy;
  members: WorkgroupMember[];
}

export interface WorkgroupOutput {
  bus: Bus;
  runs: AgentRun[];
  message: string;
}

export interface WorkgroupSettlement {
  strategy: WorkgroupStrategy;
  status: AgentResultStatus;
  /** Results that should be consumed by downstream orchestration. For compete, this is the winning result when present. */
  workerResults: WaitRunResult[];
  /** Every terminal result observed while settling this workgroup. */
  completedResults: WaitRunResult[];
  winner?: WaitRunResult;
  pendingRunIds: string[];
}

export interface WorkgroupTool {
  name: "workgroup";
  execute(input: WorkgroupInput): Promise<WorkgroupOutput>;
}

export interface WorkgroupToolDeps {
  orchestra: OrchestraApi;
}

export const WorkgroupMemberParams = Type.Object(
  {
    profile: AgentProfileParams,
    name: Type.Optional(SubagentRunNameParam),
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
      description: "Existing bus id/name; create with bus action=create first.",
    }),
    goal: Type.String({
      description: "Shared workgroup goal.",
    }),
    strategy: Type.String({
      enum: [...WORKGROUP_STRATEGY_VALUES],
      description: "compete = one success is enough; synthesize = combine complementary findings.",
    }),
    members: Type.Array(WorkgroupMemberParams, {
      description: "Subagents to spawn.",
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

interface PreparedWorkgroupMember extends WorkgroupMember {
  name: string;
}

interface PreparedWorkgroupInput extends Omit<WorkgroupInput, "members"> {
  members: PreparedWorkgroupMember[];
}

interface SpawnSuccess {
  member: PreparedWorkgroupMember;
  run: AgentRun;
}

interface SpawnFailure {
  member: PreparedWorkgroupMember;
  error: unknown;
}

export function createWorkgroupTool({ orchestra }: WorkgroupToolDeps): WorkgroupTool {
  return {
    name: "workgroup",

    async execute(input) {
      if (input.members.length === 0) throw new Error("workgroup requires at least one member.");

      const bus = orchestra.getBus(input.busId);
      if (!bus) throw new Error(`Bus ${input.busId} not found.`);

      const preparedInput: PreparedWorkgroupInput = {
        ...input,
        members: prepareMembers(input.members, orchestra.listRuns()),
      };
      const spawnResults = await Promise.allSettled(
        preparedInput.members.map(async (member): Promise<SpawnSuccess> => {
          const run = await spawnSubagent(orchestra, toSubagentSpawnInput(preparedInput, member, bus.id));
          return { member, run };
        }),
      );

      const successes = collectSpawnSuccesses(spawnResults);
      const failures = collectSpawnFailures(preparedInput.members, spawnResults);
      if (failures.length > 0) {
        const cleanupResults = await Promise.allSettled(
          successes.map((success) => orchestra.closeAgent(success.run.id)),
        );
        throw new Error(formatLaunchFailure(failures, successes, cleanupResults));
      }

      const runs = successes.map((success) => success.run);
      return {
        bus,
        runs,
        message: formatWorkgroupMessage(bus, preparedInput, runs),
      };
    },
  };
}

export async function settleWorkgroupRuns(
  orchestra: OrchestraApi,
  busId: string,
  strategy: WorkgroupStrategy,
): Promise<WorkgroupSettlement> {
  if (strategy === "compete") return await settleCompeteWorkgroupRuns(orchestra, busId);

  const settled = await orchestra.waitBusSettled(busId, { timeoutMs: null });
  return {
    strategy,
    status: resolveWorkgroupStatus(settled.runResults),
    workerResults: settled.runResults,
    completedResults: settled.runResults,
    pendingRunIds: settled.pendingRunIds,
  };
}

export function defineWorkgroupPiTool(resolveTool: (ctx: ExtensionContext) => WorkgroupTool) {
  return defineTool({
    name: "workgroup",
    label: "Workgroup",
    description: "Spawn multiple subagents onto an existing bus; you lead and collect results.",
    promptSnippet: "Spawn a main-led workgroup on an existing bus, then collect results with bus wait actions.",
    promptGuidelines: [
      "Create a bus first; workgroup only spawns members.",
      "Use compete when one successful member is enough; use wait_next, then close losers and summarize.",
      "Use synthesize when members provide complementary findings to combine; wait_settled usually fits.",
      "publish_bus is peer-reference context, not a leader-request channel.",
    ],
    parameters: WorkgroupToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModelsForWorkgroup(toWorkgroupInput(params as RawWorkgroupParams), ctx);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

async function settleCompeteWorkgroupRuns(orchestra: OrchestraApi, busId: string): Promise<WorkgroupSettlement> {
  const completedResults: WaitRunResult[] = [];
  const excludeRunIds: string[] = [];

  for (;;) {
    const nextRun = await orchestra.waitNextRun(busId, { excludeRunIds, timeoutMs: null });
    if (!nextRun.runResult) {
      return {
        strategy: "compete",
        status: resolveWorkgroupStatus(completedResults),
        workerResults: completedResults,
        completedResults,
        pendingRunIds: nextRun.pendingRunIds,
      };
    }

    completedResults.push(nextRun.runResult);
    excludeRunIds.push(nextRun.runResult.runId);
    if (nextRun.runResult.result?.status === "success") {
      await closeAgentRuns(orchestra, nextRun.pendingRunIds);
      return {
        strategy: "compete",
        status: "success",
        workerResults: [nextRun.runResult],
        completedResults,
        winner: nextRun.runResult,
        pendingRunIds: [],
      };
    }
  }
}

function resolveWorkgroupStatus(results: WaitRunResult[]): AgentResultStatus {
  const statuses = results.map((result) => result.result?.status);
  if (statuses.includes("success")) return "success";
  if (statuses.includes("blocked")) return "blocked";
  return "failed";
}

function toWorkgroupInput(params: RawWorkgroupParams): WorkgroupInput {
  if (!params.busId) throw new Error("workgroup requires busId.");
  if (!params.goal) throw new Error("workgroup requires goal.");
  if (!params.strategy) throw new Error("workgroup requires strategy.");
  if (!params.members || params.members.length === 0) throw new Error("workgroup requires members.");

  return {
    busId: params.busId,
    goal: params.goal,
    strategy: params.strategy,
    members: params.members.map((member, index) => toWorkgroupMember(member, `workgroup member ${index + 1}`)),
  };
}

export function toWorkgroupMember(member: RawWorkgroupMemberParams, label: string): WorkgroupMember {
  if (!member.profile) throw new Error(`${label} requires profile.`);
  return { profile: member.profile, name: member.name, assignment: member.assignment };
}

function withDefaultModelsForWorkgroup(input: WorkgroupInput, ctx: ExtensionContext): WorkgroupInput {
  return {
    ...input,
    members: withDefaultModelsForWorkgroupMembers(input.members, ctx),
  };
}

export function withDefaultModelsForWorkgroupMembers(
  members: WorkgroupMember[],
  ctx: ExtensionContext,
): WorkgroupMember[] {
  return members.map((member) => withDefaultModelForWorkgroupMember(member, ctx));
}

export function withDefaultModelForWorkgroupMember(member: WorkgroupMember, ctx: ExtensionContext): WorkgroupMember {
  return {
    ...member,
    profile: withDefaultProfileModel(member.profile, ctx),
  };
}

function prepareMembers(members: WorkgroupMember[], existingRuns: AgentRun[]): PreparedWorkgroupMember[] {
  const reservedNames = new Set<string>();
  for (const run of existingRuns) {
    reservedNames.add(run.id);
    reservedNames.add(run.name);
  }

  return members.map((member, index) => {
    const name =
      member.name !== undefined
        ? normalizeEntityName(member.name, "Workgroup member")
        : nextGeneratedMemberName(member.profile.name, index, reservedNames);
    const id = slugify(name);
    if (!id) throw new Error(`Workgroup member name "${name}" must contain letters or numbers.`);
    if (reservedNames.has(name) || reservedNames.has(id)) {
      throw new Error(`Workgroup member name "${name}" is already in use.`);
    }

    reservedNames.add(name);
    reservedNames.add(id);
    return { ...member, name };
  });
}

function nextGeneratedMemberName(profileName: string, index: number, reservedNames: Set<string>): string {
  const base = slugify(profileName) || `member-${index + 1}`;
  for (let suffix = 1; ; suffix++) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    if (!reservedNames.has(name)) return name;
  }
}

function collectSpawnSuccesses(results: Array<PromiseSettledResult<SpawnSuccess>>): SpawnSuccess[] {
  return results
    .filter((result): result is PromiseFulfilledResult<SpawnSuccess> => result.status === "fulfilled")
    .map((result) => result.value);
}

function collectSpawnFailures(
  members: PreparedWorkgroupMember[],
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
        parts.push(`- ${formatNamedEntityLabel(success.run)}: failed to close (${formatError(cleanupResult.reason)})`);
      } else {
        parts.push(`- ${formatNamedEntityLabel(success.run)}: closed`);
      }
    }
  }

  return parts.join("\n");
}

function toSubagentSpawnInput(
  input: PreparedWorkgroupInput,
  member: PreparedWorkgroupMember,
  busId: string,
): SubagentSpawnInput {
  return {
    action: "spawn",
    profile: member.profile,
    task: buildMemberTask(input, member),
    busId,
    name: member.name,
  };
}

function buildMemberTask(input: PreparedWorkgroupInput, member: PreparedWorkgroupMember): string {
  return [
    "You are a workgroup member on a shared peer-reference bus.",
    "Use publish_bus for sibling context; use finish(status=blocked) for leader action or decisions.",
    "",
    "## Workgroup context",
    `Workgroup strategy: ${input.strategy}`,
    "Shared goal:",
    "<shared_goal>",
    input.goal,
    "</shared_goal>",
    "",
    "Your assignment:",
    "<assignment>",
    member.assignment ?? `Apply your profile "${member.profile.name}" to the shared goal.`,
    "</assignment>",
    "",
    "Workgroup members:",
    "<workgroup_members>",
    ...input.members.map(formatRosterMember),
    "</workgroup_members>",
    "",
    ...buildStrategyGuidelines(input.strategy),
  ].join("\n");
}

function buildStrategyGuidelines(strategy: WorkgroupStrategy): string[] {
  if (strategy === "compete") {
    return [
      "Compete guidelines:",
      "- Work independently; keep conclusions/recommendations until finish.",
      "- publish_bus only facts, evidence, blockers, or useful constraints.",
      "- finish with approach, evidence, risks, and recommendation.",
    ];
  }

  return [
    "Synthesize guidelines:",
    "- Contribute your expert angle and engage peer findings.",
    "- publish_bus important findings, questions, blockers, or rebuttals.",
    "- finish with findings, gaps/risks, and next actions.",
  ];
}

function formatRosterMember(member: PreparedWorkgroupMember): string {
  return `- ${member.name} (${member.profile.name})${member.assignment ? `: ${member.assignment}` : ""}`;
}

function formatWorkgroupMessage(bus: Bus, input: PreparedWorkgroupInput, runs: AgentRun[]): string {
  return [
    `Launched ${input.strategy} workgroup on bus ${formatNamedEntityLabel(bus)} with ${runs.length} run(s).`,
    "",
    "Runs:",
    ...runs.map((run) => `- ${formatNamedEntityLabel(run)}: ${run.state}`),
    "",
    "Use bus action=wait_next to handle member results as they finish, or bus action=wait_settled for full fan-in.",
  ].join("\n");
}

type RawWorkgroupParams = {
  busId?: string;
  goal?: string;
  strategy?: WorkgroupStrategy;
  members?: RawWorkgroupMemberParams[];
};

export type RawWorkgroupMemberParams = {
  profile?: AgentProfile;
  name?: string;
  assignment?: string;
};
