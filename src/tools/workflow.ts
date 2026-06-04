import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentResultStatus, AgentRun } from "../core/subagent.ts";
import type { OrchestraApi, WaitRunResult } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun, WorkflowStageOutput, WorkflowStageRun, WorkflowStageSpec } from "../core/workflow.ts";
import { WORKGROUP_STRATEGY_VALUES, type WorkgroupMember, type WorkgroupStrategy } from "../core/workgroup.ts";
import { createStageLeaderProfile } from "../profiles/stage-leader.ts";
import {
  closeAgentRuns,
  createEntityIdentity,
  formatError,
  findWorkflow,
  formatNamedEntityLabel,
  isTerminalAgentState,
  normalizeEntityName,
  requireWorkflow,
  resolveWaitTimeoutMs,
} from "../utils.ts";
import {
  createWorkgroupTool,
  settleWorkgroupRuns,
  toWorkgroupMember,
  type RawWorkgroupMemberParams,
  withDefaultModelForWorkgroupMember,
  withDefaultModelsForWorkgroupMembers,
  WorkgroupMemberParams,
} from "./workgroup.ts";

export type WorkflowInput =
  | {
      action: "start";
      name?: string;
      goal: string;
      stages: WorkflowStageSpec[];
    }
  | {
      action: "status";
      id: string;
    }
  | {
      action: "cancel";
      id: string;
    }
  | {
      action: "wait";
      id: string;
      /** Defaults to 10 minutes. Use null to wait indefinitely. */
      timeoutMs?: number | null;
    };

export interface WorkflowOutput {
  workflow?: WorkflowRun;
  timedOut?: boolean;
  message: string;
}

export interface WorkflowTool {
  name: "workflow";
  execute(input: WorkflowInput): Promise<WorkflowOutput>;
}

export interface WorkflowToolDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
}

export interface WorkflowPiToolOptions {
  onWorkflowInput?: (ctx: ExtensionContext, input: WorkflowInput) => void;
  onWorkflowOutput?: (ctx: ExtensionContext, output: WorkflowOutput) => void;
}

const WorkflowStageParams = Type.Object(
  {
    name: Type.String({
      description: "Short unique stage name within this linear workflow.",
    }),
    goal: Type.String({
      description: "Stage-specific goal.",
    }),
    strategy: Type.String({
      enum: [...WORKGROUP_STRATEGY_VALUES],
      description: "compete = one success is enough; synthesize = combine complementary findings.",
    }),
    members: Type.Array(WorkgroupMemberParams, {
      description: "Worker subagents for this stage.",
      minItems: 1,
    }),
    leader: Type.Optional(WorkgroupMemberParams),
  },
  { additionalProperties: false },
);

const WorkflowActionParams = Type.String({
  enum: ["start", "status", "cancel", "wait"],
  description: "start launches; status inspects; cancel closes active runs; wait awaits terminal workflow state.",
});

const WorkflowToolParams = Type.Object(
  {
    action: WorkflowActionParams,
    name: Type.Optional(
      Type.String({
        description: "Optional workflow name.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Required for status/cancel/wait. Workflow id/name.",
      }),
    ),
    goal: Type.Optional(
      Type.String({
        description: "Required for start. Overall workflow goal.",
      }),
    ),
    stages: Type.Optional(
      Type.Array(WorkflowStageParams, {
        description: "Required for action=start. Linear stages executed in order with automatic stage leaders.",
        minItems: 1,
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
          description: "Optional for action=wait. Positive ms; default 10 min; null waits indefinitely.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export function createWorkflowTool({ orchestra, store }: WorkflowToolDeps): WorkflowTool {
  const workgroupTool = createWorkgroupTool({ orchestra });
  const runnerTasks = new Map<string, Promise<void>>();

  const startRunner = (workflowId: string) => {
    const task = runWorkflow(workflowId, { orchestra, store, workgroupTool })
      .catch((error) => failWorkflow(store, workflowId, formatError(error)))
      .finally(() => runnerTasks.delete(workflowId));
    runnerTasks.set(workflowId, task);
  };

  return {
    name: "workflow",

    async execute(input) {
      if (input.action === "start") {
        const workflow = createWorkflowRun(input, store.listWorkflows());
        store.saveWorkflow(workflow);
        startRunner(workflow.id);
        const startedWorkflow = store.getWorkflow(workflow.id) ?? workflow;
        return { workflow: startedWorkflow, message: formatWorkflowMessage(startedWorkflow) };
      }

      const workflow = findWorkflow(store, input.id);
      if (!workflow) {
        return input.action === "wait"
          ? { timedOut: false, message: formatWorkflowNotFound(input.id) }
          : { message: formatWorkflowNotFound(input.id) };
      }

      if (input.action === "status") {
        return { workflow, message: formatWorkflowMessage(workflow) };
      }

      if (input.action === "wait") {
        const result = await waitWorkflow(store, workflow.id, input.timeoutMs);
        return {
          workflow: result.workflow,
          timedOut: result.timedOut,
          message: formatWaitWorkflowMessage(result.workflow, result.timedOut, input.id),
        };
      }

      const closedWorkflow = await closeWorkflow(orchestra, store, workflow);
      return { workflow: closedWorkflow, message: formatWorkflowMessage(closedWorkflow, "Workflow cancelled.") };
    },
  };
}

export function defineWorkflowPiTool(
  resolveTool: (ctx: ExtensionContext) => WorkflowTool,
  options: WorkflowPiToolOptions = {},
) {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: "Run linear workgroup stages with automatic restricted stage leaders.",
    promptSnippet: "Launch a multi-stage workflow, then use workflow wait/status for progress and final output.",
    promptGuidelines: [
      "Use workflow for ordered multi-stage work; not branching/DAG plans.",
      "Each stage gets its own bus and automatic leader; previous outputs feed the next stage.",
      "Use compete when one worker success is enough; use synthesize when findings must be combined.",
      "Use status for progress, wait for terminal success/blocked/failed/closed.",
    ],
    parameters: WorkflowToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModels(toWorkflowInput(params as RawWorkflowParams), ctx);
      options.onWorkflowInput?.(ctx, input);

      const output = await resolveTool(ctx).execute(input);
      if (output.workflow) options.onWorkflowOutput?.(ctx, output);

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

interface WorkflowRunnerDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
  workgroupTool: ReturnType<typeof createWorkgroupTool>;
}

async function runWorkflow(workflowId: string, deps: WorkflowRunnerDeps): Promise<void> {
  for (;;) {
    const workflow = deps.store.getWorkflow(workflowId);
    if (!workflow || isTerminalAgentState(workflow.state)) return;

    const stageIndex = workflow.stages.findIndex((stage) => stage.state === "idle" && !stage.phase);
    if (stageIndex < 0) {
      if (workflow.state === "idle")
        deps.store.saveWorkflow({
          ...workflow,
          state: "success",
          currentStageIndex: workflow.stages.length - 1,
          result: workflow.result,
        });
      return;
    }

    await runStage(workflowId, stageIndex, deps);

    const updatedWorkflow = deps.store.getWorkflow(workflowId);
    if (!updatedWorkflow || isTerminalAgentState(updatedWorkflow.state)) return;
  }
}

async function runStage(workflowId: string, stageIndex: number, deps: WorkflowRunnerDeps): Promise<void> {
  const workflow = requireWorkflow(deps.store, workflowId);
  const stage = workflow.stages[stageIndex];
  const bus = deps.orchestra.createBus({ name: `${workflow.name}-${stage.name}` });
  updateStage(deps.store, workflow, stageIndex, { state: "idle", phase: "workers", busId: bus.id });

  const workgroupOutput = await deps.workgroupTool.execute({
    busId: bus.id,
    goal: buildStageWorkerGoal(workflow, stageIndex),
    strategy: stage.strategy as WorkgroupStrategy,
    members: stage.members as WorkgroupMember[],
  });
  if (isWorkflowClosed(deps.store, workflowId)) {
    await closeAgentRuns(
      deps.orchestra,
      workgroupOutput.runs.map((run) => run.id),
    );
    return;
  }

  updateStage(deps.store, requireWorkflow(deps.store, workflowId), stageIndex, {
    workerRunIds: workgroupOutput.runs.map((run) => run.id),
  });

  const settledWorkgroup = await settleWorkgroupRuns(deps.orchestra, bus.id, stage.strategy);
  if (isWorkflowClosed(deps.store, workflowId)) return;

  if (stage.strategy === "compete" && !settledWorkgroup.winner) {
    const output = buildCompeteNoWinnerOutput(settledWorkgroup.completedResults);
    finishStage(deps.store, requireWorkflow(deps.store, workflowId), stageIndex, output);
    return;
  }

  await runStageLeader(workflowId, stageIndex, bus.id, settledWorkgroup.workerResults, deps);
}

async function runStageLeader(
  workflowId: string,
  stageIndex: number,
  busId: string,
  workerResults: WaitRunResult[],
  deps: WorkflowRunnerDeps,
): Promise<void> {
  const workflow = requireWorkflow(deps.store, workflowId);
  const stage = workflow.stages[stageIndex];
  const leaderRun = await deps.orchestra.spawnAgent(
    stage.leader.profile,
    buildLeaderTask(workflow, stageIndex, workerResults),
    busId,
    { name: stage.leader.name },
  );
  if (isWorkflowClosed(deps.store, workflowId)) {
    await deps.orchestra.closeAgent(leaderRun.id);
    return;
  }

  updateStage(deps.store, requireWorkflow(deps.store, workflowId), stageIndex, {
    state: "idle",
    phase: "leader",
    leaderRunId: leaderRun.id,
  });

  const leaderSettled = await deps.orchestra.waitBusSettled(busId, { timeoutMs: null });
  if (isWorkflowClosed(deps.store, workflowId)) return;

  const latestLeaderRun = leaderSettled.runs.find((run) => run.id === leaderRun.id) ?? leaderRun;
  const output = buildStageOutput(latestLeaderRun, leaderRun.id, workerResults);
  finishStage(deps.store, requireWorkflow(deps.store, workflowId), stageIndex, output);
}

async function closeWorkflow(orchestra: OrchestraApi, store: AgentStore, workflow: WorkflowRun): Promise<WorkflowRun> {
  const closedWorkflow = markWorkflowClosed(workflow);
  store.saveWorkflow(closedWorkflow);

  const runIds = collectWorkflowRunIds(workflow);
  const busRunIds = workflow.stages.flatMap((stage) =>
    stage.busId ? orchestra.listRuns({ busId: stage.busId }).map((run) => run.id) : [],
  );
  await closeAgentRuns(orchestra, [...new Set([...runIds, ...busRunIds])]);

  const latestWorkflow = store.getWorkflow(workflow.id) ?? closedWorkflow;
  const latestClosedWorkflow = markWorkflowClosed(latestWorkflow);
  store.saveWorkflow(latestClosedWorkflow);
  return latestClosedWorkflow;
}

function createWorkflowRun(
  input: Extract<WorkflowInput, { action: "start" }>,
  existingWorkflows: WorkflowRun[],
): WorkflowRun {
  validateStages(input.stages);
  const identity = createEntityIdentity(input.name, "workflow", existingWorkflows, "Workflow");
  return {
    ...identity,
    goal: input.goal,
    state: "idle",
    currentStageIndex: 0,
    stages: input.stages.map((stage) => {
      const stageRun = {
        ...stage,
        name: normalizeEntityName(stage.name, "Workflow stage"),
        state: "idle" as const,
        workerRunIds: [],
      };
      return { ...stageRun, leader: resolveStageLeader(stage, identity.name) };
    }),
  };
}

function validateStages(stages: WorkflowStageSpec[]): void {
  if (stages.length === 0) throw new Error("workflow requires at least one stage.");

  const names = new Set<string>();
  for (const stage of stages) {
    const name = normalizeEntityName(stage.name, "Workflow stage");
    if (names.has(name)) throw new Error(`Workflow stage name "${name}" is already in use.`);
    names.add(name);
    if (stage.members.length === 0) throw new Error(`Workflow stage "${name}" requires at least one member.`);
  }
}

function resolveStageLeader(stage: WorkflowStageSpec, workflowName: string): WorkgroupMember {
  const stageName = normalizeEntityName(stage.name, "Workflow stage");
  const leader = stage.leader ?? {
    profile: createStageLeaderProfile({ name: `${workflowName}-${stageName}-leader` }),
  };
  return {
    ...leader,
    profile: {
      ...leader.profile,
      tools: [],
    },
  };
}

function toWorkflowInput(params: RawWorkflowParams): WorkflowInput {
  if (params.action === "start") {
    if (!params.goal) throw new Error("workflow action=start requires goal.");
    if (!params.stages || params.stages.length === 0) throw new Error("workflow action=start requires stages.");
    return { action: "start", name: params.name, goal: params.goal, stages: params.stages.map(toWorkflowStageSpec) };
  }

  if (!params.id) throw new Error(`workflow action=${params.action} requires id.`);
  if (params.action === "wait") return { action: "wait", id: params.id, timeoutMs: params.timeoutMs };
  return { action: params.action, id: params.id };
}

function toWorkflowStageSpec(stage: RawWorkflowStageParams): WorkflowStageSpec {
  if (!stage.name) throw new Error("workflow stage requires name.");
  if (!stage.goal) throw new Error(`workflow stage ${stage.name} requires goal.`);
  if (!stage.strategy) throw new Error(`workflow stage ${stage.name} requires strategy.`);
  if (!stage.members || stage.members.length === 0) throw new Error(`workflow stage ${stage.name} requires members.`);

  const spec: WorkflowStageSpec = {
    name: stage.name,
    goal: stage.goal,
    strategy: stage.strategy,
    members: stage.members.map((member, index) => toWorkgroupMember(member, `workflow member ${index + 1}`)),
  };
  if (stage.leader) spec.leader = toWorkgroupMember(stage.leader, "workflow leader");
  return spec;
}

function withDefaultModels(input: WorkflowInput, ctx: ExtensionContext): WorkflowInput {
  if (input.action !== "start") return input;
  return {
    ...input,
    stages: input.stages.map((stage) => ({
      ...stage,
      members: withDefaultModelsForWorkgroupMembers(stage.members, ctx),
      leader: stage.leader ? withDefaultModelForWorkgroupMember(stage.leader, ctx) : undefined,
    })),
  };
}

function updateStage(
  store: AgentStore,
  workflow: WorkflowRun,
  stageIndex: number,
  updates: Partial<WorkflowStageRun>,
): void {
  if (isWorkflowClosed(store, workflow.id)) return;

  const stages = workflow.stages.map((stage, index) => (index === stageIndex ? { ...stage, ...updates } : stage));
  store.saveWorkflow({ ...workflow, currentStageIndex: stageIndex, stages });
}

function finishStage(store: AgentStore, workflow: WorkflowRun, stageIndex: number, output: WorkflowStageOutput): void {
  updateStage(store, workflow, stageIndex, { state: output.status, phase: undefined, output });

  const updatedWorkflow = requireWorkflow(store, workflow.id);
  const isLastStage = stageIndex === updatedWorkflow.stages.length - 1;
  if (output.status !== "success" || isLastStage) {
    store.saveWorkflow({
      ...updatedWorkflow,
      state: output.status,
      result: output,
    });
  }
}

function markWorkflowClosed(workflow: WorkflowRun): WorkflowRun {
  return {
    ...workflow,
    state: "closed",
    stages: workflow.stages.map((stage) => (isTerminalAgentState(stage.state) ? stage : { ...stage, state: "closed" })),
  };
}

function collectWorkflowRunIds(workflow: WorkflowRun): string[] {
  return workflow.stages
    .flatMap((stage) => [stage.leaderRunId, ...stage.workerRunIds])
    .filter((runId): runId is string => runId !== undefined);
}

function failWorkflow(store: AgentStore, workflowId: string, error: string): void {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow || isTerminalAgentState(workflow.state)) return;

  const stages = workflow.stages.map((stage, index) =>
    index === workflow.currentStageIndex && !isTerminalAgentState(stage.state)
      ? { ...stage, state: "failed" as const, error }
      : stage,
  );
  store.saveWorkflow({ ...workflow, state: "failed", stages, error });
}

function isWorkflowClosed(store: AgentStore, id: string): boolean {
  return store.getWorkflow(id)?.state === "closed";
}

function buildStageWorkerGoal(workflow: WorkflowRun, stageIndex: number): string {
  const stage = workflow.stages[stageIndex];
  const parts = [
    "Workflow stage context",
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    `Current stage: ${stage.name}`,
    "Stage goal:",
    stage.goal,
    "",
    "Previous stage outputs:",
    "<previous_stage_outputs>",
    formatPreviousStageOutputs(workflow, stageIndex),
    "</previous_stage_outputs>",
  ];
  return parts.join("\n");
}

function buildLeaderTask(workflow: WorkflowRun, stageIndex: number, workerResults: WaitRunResult[]): string {
  const stage = workflow.stages[stageIndex];
  const strategyInstructions =
    stage.strategy === "compete"
      ? ["Compete: condense the winning worker result; do not broaden scope."]
      : ["Synthesize: reconcile worker results into one canonical stage output."];

  return [
    "You are the leader for this workflow stage.",
    ...strategyInstructions,
    "Use supplied context only; prefer finish results over bus context.",
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    `Current stage: ${stage.name}`,
    "Stage goal:",
    stage.goal,
    "",
    "Previous stage outputs:",
    "<previous_stage_outputs>",
    formatPreviousStageOutputs(workflow, stageIndex),
    "</previous_stage_outputs>",
    "",
    "Worker results for this stage:",
    "<worker_results>",
    formatWorkerResults(workerResults),
    "</worker_results>",
    "",
    "Finish:",
    "- Call finish once with concise summary and useful data for the next stage.",
    "- Use blocked/failed worker results as evidence; note gaps.",
    "- Prefer status=success if any useful output exists; blocked if insufficient, failed if synthesis fails.",
  ].join("\n");
}

function formatPreviousStageOutputs(workflow: WorkflowRun, stageIndex: number): string {
  const outputs = workflow.stages
    .slice(0, stageIndex)
    .flatMap((stage) => (stage.output ? [formatPreviousStageOutput(stage.name, stage.output)] : []));
  return outputs.length > 0 ? outputs.join("\n\n") : "None.";
}

function formatPreviousStageOutput(stageName: string, output: WorkflowStageOutput): string {
  return [`<stage_output name="${stageName}">`, formatStageOutputForPrompt(output), "</stage_output>"].join("\n");
}

function formatWorkerResults(workerResults: WaitRunResult[]): string {
  if (workerResults.length === 0) return "None.";
  return workerResults.map(formatWorkerResult).join("\n\n");
}

function formatWorkerResult(result: WaitRunResult): string {
  const lines = [
    `<worker_result run_id="${result.runId}" name="${result.name}" profile="${result.profile}" state="${result.state}">`,
  ];
  if (result.result) {
    lines.push(`result: ${result.result.status}`, "summary:", result.result.summary);
    if (result.result.data !== undefined) lines.push("data_json:", formatJsonData(result.result.data));
  } else {
    lines.push("No result payload recorded.");
  }
  lines.push("</worker_result>");
  return lines.join("\n");
}

function formatStageOutputForPrompt(output: WorkflowStageOutput): string {
  const parts = [`status: ${output.status}`, "summary:", output.summary];
  if (output.data !== undefined) parts.push("data_json:", formatJsonData(output.data));
  return parts.join("\n");
}

function formatJsonData(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? String(data);
}

function buildCompeteNoWinnerOutput(workerResults: WaitRunResult[]): WorkflowStageOutput {
  const status = workerResults.some((worker) => worker.result?.status === "blocked") ? "blocked" : "failed";
  const counts = countWorkerResultStatuses(workerResults);
  const workflowRunResults = workerResults.map(toWorkflowRunResult);
  return {
    status,
    summary: `Compete strategy stage ended without a successful worker result: ${counts.blocked} blocked, ${counts.failed} failed.`,
    data: { workerResults: workflowRunResults },
    workerResults: workflowRunResults,
  };
}

function countWorkerResultStatuses(workerResults: WaitRunResult[]): Record<AgentResultStatus, number> {
  const counts: Record<AgentResultStatus, number> = { success: 0, blocked: 0, failed: 0 };
  for (const worker of workerResults) {
    if (worker.result) counts[worker.result.status]++;
  }
  return counts;
}

function buildStageOutput(
  leaderRun: AgentRun,
  leaderRunId: string,
  workerResults: WaitRunResult[],
): WorkflowStageOutput {
  if (!leaderRun.result) {
    return {
      status: "failed",
      summary: `Stage leader ${leaderRunId} reached ${leaderRun.state} without a result payload.`,
      leaderRunId,
      workerResults: workerResults.map(toWorkflowRunResult),
    };
  }

  const output: WorkflowStageOutput = {
    status: leaderRun.result.status,
    summary: leaderRun.result.summary,
    leaderRunId,
    workerResults: workerResults.map(toWorkflowRunResult),
  };
  if (leaderRun.result.data !== undefined) output.data = leaderRun.result.data;
  return output;
}

function toWorkflowRunResult(result: WaitRunResult) {
  const output = {
    runId: result.runId,
    name: result.name,
    profile: result.profile,
    state: result.state,
  };
  return result.result === undefined ? output : { ...output, result: result.result };
}

function formatStageOutput(output: WorkflowStageOutput): string {
  const parts = [`status: ${output.status}`, `summary: ${output.summary}`];
  if (output.data !== undefined) parts.push("data:", formatJsonData(output.data));
  return parts.join("\n");
}

function waitWorkflow(
  store: AgentStore,
  workflowId: string,
  timeoutMs: number | null | undefined,
): Promise<{ workflow: WorkflowRun; timedOut: boolean }> {
  const resolvedTimeoutMs = resolveWaitTimeoutMs("workflow wait", timeoutMs);
  const initialWorkflow = requireWorkflow(store, workflowId);
  if (isTerminalAgentState(initialWorkflow.state)) {
    return Promise.resolve({ workflow: initialWorkflow, timedOut: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let latestWorkflow = initialWorkflow;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    };

    const unsubscribe = store.subscribeWorkflows(
      (workflow) => {
        if (settled) return;
        latestWorkflow = workflow;
        if (!isTerminalAgentState(workflow.state)) return;

        settled = true;
        cleanup();
        resolve({ workflow, timedOut: false });
      },
      (workflow) => workflow.id === workflowId,
    );

    if (resolvedTimeoutMs !== null) {
      timeout = setTimeout(() => {
        if (settled) return;

        settled = true;
        cleanup();
        resolve({ workflow: latestWorkflow, timedOut: true });
      }, resolvedTimeoutMs);
    }
  });
}

function formatWorkflowNotFound(id: string): string {
  return `Workflow ${id} not found.`;
}

function formatWaitWorkflowMessage(workflow: WorkflowRun | undefined, timedOut: boolean, requestedId?: string): string {
  if (!workflow) return formatWorkflowNotFound(requestedId ?? "");
  const label = requestedId === workflow.id ? workflow.id : formatNamedEntityLabel(workflow);
  const prefix = timedOut ? "Timed out waiting for" : "Workflow reached terminal state:";
  const result = workflow.result ? ` result=${workflow.result.status}` : "";
  return `${prefix} ${label}; state=${workflow.state}${result}.`;
}

function formatWorkflowMessage(
  workflow: WorkflowRun,
  headline = `Workflow ${formatNamedEntityLabel(workflow)} is ${workflow.state}.`,
): string {
  const parts = [headline, "", `Goal: ${workflow.goal}`, "", "Stages:"];
  for (const [index, stage] of workflow.stages.entries()) {
    const current = index === workflow.currentStageIndex && workflow.state === "idle" ? " current" : "";
    parts.push(`- ${stage.name}: ${stage.state}${current}${stage.busId ? ` bus=${stage.busId}` : ""}`);
  }
  if (workflow.result) parts.push("", "Result:", formatStageOutput(workflow.result));
  if (workflow.error) parts.push("", `Error: ${workflow.error}`);
  return parts.join("\n");
}

type RawWorkflowParams = {
  action: "start" | "status" | "cancel" | "wait";
  name?: string;
  id?: string;
  goal?: string;
  stages?: RawWorkflowStageParams[];
  timeoutMs?: number | null;
};

type RawWorkflowStageParams = {
  name?: string;
  goal?: string;
  strategy?: WorkgroupStrategy;
  members?: RawWorkgroupMemberParams[];
  leader?: RawWorkgroupMemberParams;
};
