import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentResultStatus, AgentRun, AgentRunResult } from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import { WORKGROUP_STRATEGY_VALUES, type WorkgroupMember, type WorkgroupStrategy } from "../core/workgroup.ts";
import {
  closeAgentRuns,
  formatError,
  formatNamedEntityLabel,
  isTerminalAgentState,
  normalizeEntityName,
  slugify,
  toAgentRunResult,
} from "../utils.ts";
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
  workerResults: AgentRunResult[];
  /** Every terminal result observed while settling this workgroup. */
  completedResults: AgentRunResult[];
  winner?: AgentRunResult;
  pendingRunIds: string[];
}

export interface WorkgroupTool {
  name: "workgroup";
  execute(input: WorkgroupInput): Promise<WorkgroupOutput>;
}

export interface WorkgroupLaunchEvent {
  input: WorkgroupInput;
  bus: Bus;
}

export interface WorkgroupLaunchedEvent {
  input: WorkgroupInput;
  output: WorkgroupOutput;
}

export interface WorkgroupLaunchFailedEvent extends WorkgroupLaunchEvent {
  error: unknown;
}

export interface WorkgroupToolDeps {
  orchestra: OrchestraApi;
  onWorkgroupLaunching?: (event: WorkgroupLaunchEvent) => void;
  onWorkgroupLaunched?: (event: WorkgroupLaunchedEvent) => void;
  onWorkgroupLaunchFailed?: (event: WorkgroupLaunchFailedEvent) => void;
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

export function createWorkgroupTool({
  orchestra,
  onWorkgroupLaunching,
  onWorkgroupLaunched,
  onWorkgroupLaunchFailed,
}: WorkgroupToolDeps): WorkgroupTool {
  return {
    name: "workgroup",

    async execute(input) {
      if (input.members.length === 0) throw new Error("workgroup requires at least one member.");

      const bus = orchestra.getBus(input.busId);
      if (!bus) throw new Error(`Bus ${input.busId} not found.`);

      onWorkgroupLaunching?.({ input, bus });
      try {
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
        const output = {
          bus,
          runs,
          message: formatWorkgroupMessage(bus, preparedInput, runs),
        };
        onWorkgroupLaunched?.({ input, output });
        return output;
      } catch (error) {
        onWorkgroupLaunchFailed?.({ input, bus, error });
        throw error;
      }
    },
  };
}

export async function settleWorkgroupRuns(
  orchestra: OrchestraApi,
  store: AgentStore,
  busId: string,
  runIds: string[],
  strategy: WorkgroupStrategy,
): Promise<WorkgroupSettlement> {
  return await new WorkgroupSettlementCollector(orchestra, store, busId, runIds, strategy).settle();
}

export function defineWorkgroupPiTool(resolveTool: (ctx: ExtensionContext) => WorkgroupTool) {
  return defineTool({
    name: "workgroup",
    label: "Workgroup",
    description: "Spawn multiple subagents onto an existing bus; you lead and collect results.",
    promptSnippet: "Spawn a main-led workgroup on an existing bus; member finish events are delivered automatically.",
    promptGuidelines: [
      "Create a bus first; workgroup only spawns members.",
      "Use workgroup compete when one successful member is enough; close losers after a success event if appropriate.",
      "Use workgroup synthesize when members provide complementary findings; react to member finish events as they arrive.",
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

class WorkgroupSettlementCollector {
  private readonly runIds: Set<string>;
  private readonly completedRunIds = new Set<string>();
  private readonly completedResults: AgentRunResult[] = [];

  constructor(
    private readonly orchestra: OrchestraApi,
    private readonly store: AgentStore,
    private readonly busId: string,
    runIds: string[],
    private readonly strategy: WorkgroupStrategy,
  ) {
    this.runIds = new Set(runIds);
  }

  settle(): Promise<WorkgroupSettlement> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;

      const finish = (settlement: WorkgroupSettlement) => {
        if (settled) return;

        settled = true;
        unsubscribe();
        resolve(settlement);
      };

      const finishWithWinner = (winner: AgentRunResult) => {
        if (settled) return;

        settled = true;
        unsubscribe();
        void closeAgentRuns(this.orchestra, this.getPendingRunIds()).finally(() => {
          resolve({
            strategy: this.strategy,
            status: "success",
            workerResults: [winner],
            completedResults: this.completedResults,
            winner,
            pendingRunIds: [],
          });
        });
      };

      const finishFromCurrentState = () => {
        this.captureTerminalRuns();

        const winner = this.strategy === "compete" ? this.completedResults.find(isSuccessfulRunResult) : undefined;
        if (winner) {
          finishWithWinner(winner);
          return;
        }

        if (!this.isSettled()) return;

        finish({
          strategy: this.strategy,
          status: resolveWorkgroupStatus(this.completedResults),
          workerResults: this.completedResults,
          completedResults: this.completedResults,
          pendingRunIds: this.getPendingRunIds(),
        });
      };

      const observeRun = (run: AgentRun) => {
        if (settled || !this.runIds.has(run.id) || !isTerminalAgentState(run.state)) return;
        this.recordTerminalRun(run);
        finishFromCurrentState();
      };

      unsubscribe = this.store.subscribeRuns(observeRun, (run) => run.busId === this.busId && this.runIds.has(run.id));
      finishFromCurrentState();

      if (!settled && this.runIds.size === 0) {
        finish({
          strategy: this.strategy,
          status: "failed",
          workerResults: [],
          completedResults: [],
          pendingRunIds: [],
        });
      }
    });
  }

  private captureTerminalRuns(): void {
    for (const runId of this.runIds) {
      const run = this.store.getRun(runId);
      if (run) this.recordTerminalRun(run);
    }
  }

  private recordTerminalRun(run: AgentRun): void {
    if (!isTerminalAgentState(run.state) || this.completedRunIds.has(run.id)) return;

    this.completedRunIds.add(run.id);
    this.completedResults.push(toAgentRunResult(run));
  }

  private isSettled(): boolean {
    return [...this.runIds].every((runId) => {
      const run = this.store.getRun(runId);
      return run !== undefined && isTerminalAgentState(run.state);
    });
  }

  private getPendingRunIds(): string[] {
    return [...this.runIds].filter((runId) => this.store.getRun(runId)?.state === "idle");
  }
}

function isSuccessfulRunResult(result: AgentRunResult): boolean {
  return result.result?.status === "success";
}

function resolveWorkgroupStatus(results: AgentRunResult[]): AgentResultStatus {
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
    "Pi-orchestra will deliver workgroup.member_finished events as members finish.",
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
