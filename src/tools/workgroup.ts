import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import { AgentProfileParams, withDefaultProfileModel } from "./subagent.ts";

export type WorkgroupMode = "explore" | "council";

export interface WorkgroupMember {
  profile: AgentProfile;
  /** Optional globally unique short run name. If omitted, one is generated from the profile name. */
  name?: string;
  /** Member-specific assignment or focus within the shared goal. */
  assignment?: string;
}

export interface WorkgroupInput {
  busId: string;
  goal: string;
  mode: WorkgroupMode;
  members: WorkgroupMember[];
}

export interface WorkgroupOutput {
  bus: Bus;
  runs: AgentRun[];
  message: string;
}

export interface WorkgroupTool {
  name: "workgroup";
  execute(input: WorkgroupInput): Promise<WorkgroupOutput>;
}

export interface WorkgroupToolDeps {
  orchestra: OrchestraApi;
}

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
          const run = await orchestra.spawnAgent(member.profile, buildMemberTask(preparedInput, member), bus.id, {
            name: member.name,
          });
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

export function defineWorkgroupPiTool(resolveTool: (ctx: ExtensionContext) => WorkgroupTool) {
  return defineTool({
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
      const input = withDefaultModelsForWorkgroup(toWorkgroupInput(params as RawWorkgroupParams), ctx);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
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

function withDefaultModelsForWorkgroup(input: WorkgroupInput, ctx: ExtensionContext): WorkgroupInput {
  return {
    ...input,
    members: input.members.map((member) => ({
      ...member,
      profile: withDefaultProfileModel(member.profile, ctx),
    })),
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
        ? normalizeMemberName(member.name)
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

function normalizeMemberName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Workgroup member name must not be empty.");
  if (trimmed.length > 64) throw new Error("Workgroup member name must be 64 characters or fewer.");
  return trimmed;
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
        parts.push(`- ${formatRunLabel(success.run)}: failed to close (${formatError(cleanupResult.reason)})`);
      } else {
        parts.push(`- ${formatRunLabel(success.run)}: closed`);
      }
    }
  }

  return parts.join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildMemberTask(input: PreparedWorkgroupInput, member: PreparedWorkgroupMember): string {
  const parts = [
    "You are participating in a workgroup on a shared peer-reference bus.",
    "The main agent is the workgroup leader, but it is outside the bus: publish_bus is for sibling reference data, not for requesting leader action.",
    "If you need the leader to decide, approve, unblock, or act, call finish with status blocked so the leader can receive it via waitNextRun and respond with subagent message.",
    "",
    `Workgroup mode: ${input.mode}`,
    "Shared goal:",
    input.goal,
    "",
    "Your assignment:",
    member.assignment ?? `Apply your profile "${member.profile.name}" to the shared goal.`,
    "",
    "Workgroup members:",
    ...input.members.map(formatRosterMember),
    "",
    ...buildModeGuidelines(input.mode),
  ];

  return parts.join("\n");
}

function buildModeGuidelines(mode: WorkgroupMode): string[] {
  if (mode === "explore") {
    return [
      "Explore mode guidelines:",
      "- Pursue your assigned approach independently; do not follow sibling agents' conclusions or recommendations.",
      "- Use publish_bus only for facts, evidence, dead ends, constraints, or blockers that may help sibling agents.",
      "- Keep your conclusions and recommendations private until finish so sibling agents do not converge too early.",
      "- Treat sibling bus messages as claims to verify, challenge, or refute; keep developing your own approach independently.",
      "- In finish, summarize your approach, evidence, tradeoffs, risks, and recommendation.",
    ];
  }

  return [
    "Council mode guidelines:",
    "- Act as a domain expert advising the main-agent leader from your assigned perspective.",
    "- Use publish_bus for important findings, questions, blockers, context, conclusions, or rebuttals that sibling experts should see.",
    "- If you need leader action, approval, or a decision, finish with status blocked instead of publishing that request to the bus.",
    "- Engage critically with sibling experts' conclusions and counterarguments; council mode should converge through open debate.",
    "- In finish, summarize your expert findings, open questions, risks, and recommended next actions.",
  ];
}

function formatRosterMember(member: PreparedWorkgroupMember): string {
  return `- ${member.name} (${member.profile.name})${member.assignment ? `: ${member.assignment}` : ""}`;
}

function formatWorkgroupMessage(bus: Bus, input: PreparedWorkgroupInput, runs: AgentRun[]): string {
  return [
    `Launched ${input.mode} workgroup on bus ${formatBusLabel(bus)} with ${runs.length} run(s).`,
    "",
    "Runs:",
    ...runs.map((run) => `- ${formatRunLabel(run)}: ${run.state}`),
    "",
    "Use waitNextRun to handle member results as they finish, or waitBusSettled for full fan-in.",
  ].join("\n");
}

function formatBusLabel(bus: Bus): string {
  return bus.name === bus.id ? bus.id : `${bus.name} (${bus.id})`;
}

function formatRunLabel(run: AgentRun): string {
  return run.name === run.id ? run.id : `${run.name} (${run.id})`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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
