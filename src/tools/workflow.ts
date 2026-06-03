import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRun } from "../core/subagent.ts";
import type { OrchestraApi, WaitRunResult } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun, WorkflowStageOutput, WorkflowStageRun, WorkflowStageSpec } from "../core/workflow.ts";
import { WORKGROUP_MODE_VALUES, type WorkgroupMember, type WorkgroupMode } from "../core/workgroup.ts";
import { createStageLeaderProfile } from "../profiles/stage-leader.ts";
import {
  closeAgentRuns,
  createEntityIdentity,
  formatError,
  findWorkflow,
  formatNamedEntityLabel,
  indent,
  isDefined,
  isTerminalWorkflowState,
  normalizeEntityName,
  requireWorkflow,
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
    };

export interface WorkflowOutput {
  workflow?: WorkflowRun;
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

const WorkflowStageParams = Type.Object(
  {
    name: Type.String({
      description: "Short unique stage name within this linear workflow.",
    }),
    goal: Type.String({
      description: "Stage-specific goal. Previous stage leader outputs are supplied automatically.",
    }),
    mode: Type.String({
      enum: [...WORKGROUP_MODE_VALUES],
      description:
        "Stage mode. Workflow executes stage settlement automatically. Use compete when workers are substitutable and any one successful result satisfies the stage goal; workflow races to first success, closes the rest, then a restricted stage leader condenses the winner. Use synthesize when workers are complementary and their findings/tradeoffs must be combined or compared; workflow waits for all workers, then a restricted stage leader synthesizes them.",
    }),
    members: Type.Array(WorkgroupMemberParams, {
      description:
        "Worker subagents for this stage. In compete they should pursue substitutable alternatives where one success is enough; in synthesize they should provide complementary findings to combine or compare.",
      minItems: 1,
    }),
    leader: Type.Optional(WorkgroupMemberParams),
  },
  { additionalProperties: false },
);

const WorkflowActionParams = Type.String({
  enum: ["start", "status", "cancel"],
  description:
    "Action to perform. start launches a linear multi-stage workflow, status inspects it, and cancel closes active stage runs.",
});

const WorkflowToolParams = Type.Object(
  {
    action: WorkflowActionParams,
    name: Type.Optional(
      Type.String({
        description: "Optional globally unique workflow name. If omitted, a short name is generated.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Required for action=status and action=cancel. Workflow id or name returned by action=start.",
      }),
    ),
    goal: Type.Optional(
      Type.String({
        description: "Required for action=start. Overall workflow goal shared with every stage.",
      }),
    ),
    stages: Type.Optional(
      Type.Array(WorkflowStageParams, {
        description:
          "Required for action=start. Linear stages executed automatically in order. Choose compete for substitutable attempts where one success satisfies the stage goal; workflow races/settles that stage and condenses the winner via a restricted leader. Choose synthesize for complementary work where findings, reviews, or tradeoffs must be combined. Both modes use a restricted leader and get a default one when omitted.",
        minItems: 1,
      }),
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
      if (!workflow) return { message: `Workflow ${input.id} not found.` };

      if (input.action === "status") {
        return { workflow, message: formatWorkflowMessage(workflow) };
      }

      const closedWorkflow = await closeWorkflow(orchestra, store, workflow);
      return { workflow: closedWorkflow, message: formatWorkflowMessage(closedWorkflow, "Workflow cancelled.") };
    },
  };
}

export function defineWorkflowPiTool(resolveTool: (ctx: ExtensionContext) => WorkflowTool) {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a deterministic linear sequence of workgroup stages. Workflow owns stage execution and uses automatic restricted stage leaders instead of requiring the main agent to lead each workgroup.",
    promptSnippet:
      "Launch an automatically executed multi-stage workflow; each stage runs workers and a restricted stage leader settles their output.",
    promptGuidelines: [
      "Use workflow for complex multi-stage work such as collect research, analyze findings, then synthesize a final report.",
      "Workflow stages execute strictly in order; do not use workflow for branching or DAG plans.",
      "Unlike workgroup, workflow leads each stage for you: it waits/races workers, closes losers in compete mode, and invokes a restricted stage leader to produce canonical stage output.",
      "Use mode=compete when worker approaches are substitutable and any one success satisfies the stage goal; workflow automatically races to the first success, closes the rest, and has the stage leader condense the winner. This is for finding one working fix, repro, or answer, not for comparing alternatives.",
      "Use mode=synthesize when worker contributions are complementary and value comes from combining or comparing them, such as multi-angle review, research fan-out, or design tradeoff analysis; workflow waits for all workers, then has the stage leader synthesize them.",
      "Workflow automatically creates a separate bus per stage and injects previous stage outputs directly into the next stage's worker prompts.",
      "Use workflow status to inspect progress, or waitWorkflow to wait for the whole workflow to become finished, failed, or closed.",
    ],
    parameters: WorkflowToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await resolveTool(ctx).execute(
        withDefaultModels(toWorkflowInput(params as RawWorkflowParams), ctx),
      );

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
    if (!workflow || workflow.state === "closed") return;

    const stageIndex = workflow.stages.findIndex((stage) => stage.state === "idle");
    if (stageIndex < 0) {
      if (workflow.state === "running")
        saveWorkflow(deps.store, {
          ...workflow,
          state: "finished",
          currentStageIndex: workflow.stages.length - 1,
          result: workflow.result,
        });
      return;
    }

    await runStage(workflowId, stageIndex, deps);

    const updatedWorkflow = deps.store.getWorkflow(workflowId);
    if (!updatedWorkflow || isTerminalWorkflowState(updatedWorkflow.state)) return;
  }
}

async function runStage(workflowId: string, stageIndex: number, deps: WorkflowRunnerDeps): Promise<void> {
  const workflow = requireWorkflow(deps.store, workflowId);
  const stage = workflow.stages[stageIndex];
  const bus = deps.orchestra.createBus({ name: `${workflow.name}-${stage.name}` });
  updateStage(deps.store, workflow, stageIndex, { state: "running", phase: "workers", busId: bus.id });

  const workgroupOutput = await deps.workgroupTool.execute({
    busId: bus.id,
    goal: buildStageWorkerGoal(workflow, stageIndex),
    mode: stage.mode as WorkgroupMode,
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

  const settledWorkgroup = await settleWorkgroupRuns(deps.orchestra, bus.id, stage.mode);
  if (isWorkflowClosed(deps.store, workflowId)) return;

  if (stage.mode === "compete" && !settledWorkgroup.winner) {
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
  const stage = requireWorkflowStage(requireWorkflow(deps.store, workflowId), stageIndex);
  const leader = requireStageLeader(stage);
  const leaderRun = await deps.orchestra.spawnAgent(
    leader.profile,
    buildLeaderTask(requireWorkflow(deps.store, workflowId), stageIndex, workerResults),
    busId,
    { name: leader.name },
  );
  if (isWorkflowClosed(deps.store, workflowId)) {
    await deps.orchestra.closeAgent(leaderRun.id);
    return;
  }

  updateStage(deps.store, requireWorkflow(deps.store, workflowId), stageIndex, {
    state: "running",
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
  saveWorkflow(store, closedWorkflow);

  const runIds = collectWorkflowRunIds(workflow);
  const busRunIds = workflow.stages.flatMap((stage) =>
    stage.busId ? orchestra.listRuns({ busId: stage.busId }).map((run) => run.id) : [],
  );
  await closeAgentRuns(orchestra, [...new Set([...runIds, ...busRunIds])]);

  const latestWorkflow = store.getWorkflow(workflow.id) ?? closedWorkflow;
  const latestClosedWorkflow = markWorkflowClosed(latestWorkflow);
  saveWorkflow(store, latestClosedWorkflow);
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
    state: "running",
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

function requireWorkflowStage(workflow: WorkflowRun, stageIndex: number): WorkflowStageRun {
  const stage = workflow.stages.at(stageIndex);
  if (!stage) throw new Error(`Workflow ${workflow.name} stage index ${stageIndex} not found.`);
  return stage;
}

function requireStageLeader(stage: WorkflowStageRun): WorkgroupMember {
  const leader = (stage as { leader?: WorkgroupMember }).leader;
  if (!leader) throw new Error(`Workflow stage "${stage.name}" is missing a resolved leader.`);
  return leader;
}

function toWorkflowInput(params: RawWorkflowParams): WorkflowInput {
  if (params.action === "start") {
    if (!params.goal) throw new Error("workflow action=start requires goal.");
    if (!params.stages || params.stages.length === 0) throw new Error("workflow action=start requires stages.");
    return { action: "start", name: params.name, goal: params.goal, stages: params.stages.map(toWorkflowStageSpec) };
  }

  if (!params.id) throw new Error(`workflow action=${params.action} requires id.`);
  return { action: params.action, id: params.id };
}

function toWorkflowStageSpec(stage: RawWorkflowStageParams): WorkflowStageSpec {
  if (!stage.name) throw new Error("workflow stage requires name.");
  if (!stage.goal) throw new Error(`workflow stage ${stage.name} requires goal.`);
  if (!stage.mode) throw new Error(`workflow stage ${stage.name} requires mode.`);
  if (!stage.members || stage.members.length === 0) throw new Error(`workflow stage ${stage.name} requires members.`);

  const spec: WorkflowStageSpec = {
    name: stage.name,
    goal: stage.goal,
    mode: stage.mode,
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
  if (store.getWorkflow(workflow.id)?.state === "closed") return;

  const stages = workflow.stages.map((stage, index) => (index === stageIndex ? { ...stage, ...updates } : stage));
  saveWorkflow(store, { ...workflow, currentStageIndex: stageIndex, stages });
}

function finishStage(store: AgentStore, workflow: WorkflowRun, stageIndex: number, output: WorkflowStageOutput): void {
  const stageState = output.status === "success" || output.status === "blocked" ? "finished" : "failed";
  const workflowState = output.status === "success" ? "running" : output.status === "blocked" ? "finished" : "failed";
  const result = stageIndex === workflow.stages.length - 1 ? output : undefined;
  updateStage(store, workflow, stageIndex, { state: stageState, phase: undefined, output });

  const updatedWorkflow = requireWorkflow(store, workflow.id);
  if (workflowState !== "running" || stageIndex === updatedWorkflow.stages.length - 1) {
    saveWorkflow(store, {
      ...updatedWorkflow,
      state:
        stageIndex === updatedWorkflow.stages.length - 1 && workflowState === "running" ? "finished" : workflowState,
      result: result ?? output,
    });
  }
}

function markWorkflowClosed(workflow: WorkflowRun): WorkflowRun {
  return {
    ...workflow,
    state: "closed",
    stages: workflow.stages.map((stage) =>
      stage.state === "finished" || stage.state === "failed" ? stage : { ...stage, state: "closed" },
    ),
  };
}

function collectWorkflowRunIds(workflow: WorkflowRun): string[] {
  return workflow.stages.flatMap((stage) => [stage.leaderRunId, ...stage.workerRunIds]).filter(isDefined);
}

function failWorkflow(store: AgentStore, workflowId: string, error: string): void {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow || workflow.state === "closed") return;

  const stages = workflow.stages.map((stage, index) =>
    index === workflow.currentStageIndex && stage.state !== "finished"
      ? { ...stage, state: "failed" as const, error }
      : stage,
  );
  saveWorkflow(store, { ...workflow, state: "failed", stages, error });
}

function saveWorkflow(store: AgentStore, workflow: WorkflowRun): void {
  store.saveWorkflow(workflow);
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
  ];

  const previousOutputs = workflow.stages
    .slice(0, stageIndex)
    .flatMap((previousStage) =>
      previousStage.output ? [`Stage ${previousStage.name} output:`, formatStageOutput(previousStage.output)] : [],
    );
  if (previousOutputs.length > 0) parts.push("", "Previous stage outputs:", ...previousOutputs);
  return parts.join("\n");
}

function buildLeaderTask(workflow: WorkflowRun, stageIndex: number, workerResults: WaitRunResult[]): string {
  const stage = workflow.stages[stageIndex];
  const modeInstructions =
    stage.mode === "compete"
      ? [
          "This is a compete stage. One worker has produced a successful winning result.",
          "Condense the winning result into a concise canonical stage output: keep what the next stage needs, drop verbose detail and redundancy.",
          "Do not broaden the scope, add new content, or merge unrelated alternatives.",
        ]
      : [
          "This is a synthesize stage. Deduplicate, reconcile, and synthesize all worker results into one canonical stage output for the next stage.",
        ];

  return [
    "You are the leader for this workflow stage.",
    ...modeInstructions,
    "Use only the provided previous stage outputs, current worker results, and any bus reference context delivered with this task; do not ask for or require external data.",
    "Treat bus reference context as stage deliberation evidence from workers, but prefer finish results when they conflict.",
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    `Current stage: ${stage.name}`,
    "Stage goal:",
    stage.goal,
    "",
    "Previous stage outputs:",
    ...formatPreviousStageOutputs(workflow, stageIndex),
    "",
    "Worker results for this stage:",
    formatWorkerResults(workerResults),
    "",
    "Finish requirements:",
    "- Call finish exactly once when done.",
    "- Treat blocked or failed worker results as available evidence to reconcile; synthesize usable findings from them and explicitly note unresolved gaps.",
    "- Do not propagate blocked/failed worker status automatically.",
    "- Use status=success whenever a useful canonical output can be produced from the provided results.",
    "- Use status=blocked only when the provided results are insufficient to produce any useful stage output.",
    "- Use status=failed only for unrecoverable synthesis failure.",
    "- Any non-success status will terminate the workflow at this stage, so prefer success when useful synthesis is possible.",
    "- Include a concise summary and structured data if useful for the next stage.",
  ].join("\n");
}

function formatPreviousStageOutputs(workflow: WorkflowRun, stageIndex: number): string[] {
  const outputs = workflow.stages
    .slice(0, stageIndex)
    .flatMap((stage) => (stage.output ? [`Stage ${stage.name}:`, formatStageOutput(stage.output)] : []));
  return outputs.length > 0 ? outputs : ["None."];
}

function formatWorkerResults(workerResults: WaitRunResult[]): string {
  if (workerResults.length === 0) return "None.";
  return workerResults.map(formatWorkerResult).join("\n\n");
}

function formatWorkerResult(result: WaitRunResult): string {
  const lines = [`- ${result.name} (${result.runId})`, `  profile: ${result.profile}`, `  state: ${result.state}`];
  if (result.result) {
    lines.push(`  result: ${result.result.status}`, indent(result.result.summary));
    if (result.result.data !== undefined) lines.push("  data:", indent(JSON.stringify(result.result.data, null, 2)));
  }
  return lines.join("\n");
}

function buildCompeteNoWinnerOutput(workerResults: WaitRunResult[]): WorkflowStageOutput {
  const status = workerResults.some((worker) => worker.result?.status === "blocked") ? "blocked" : "failed";
  const counts = countWorkerResultStatuses(workerResults);
  const workflowRunResults = workerResults.map(toWorkflowRunResult);
  return {
    status,
    summary: `Compete stage ended without a successful worker result: ${counts.blocked} blocked, ${counts.failed} failed.`,
    data: { workerResults: workflowRunResults },
    workerResults: workflowRunResults,
  };
}

function countWorkerResultStatuses(workerResults: WaitRunResult[]): Record<"success" | "blocked" | "failed", number> {
  return {
    success: workerResults.filter((worker) => worker.result?.status === "success").length,
    blocked: workerResults.filter((worker) => worker.result?.status === "blocked").length,
    failed: workerResults.filter((worker) => worker.result?.status === "failed").length,
  };
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
  if (output.data !== undefined) parts.push("data:", JSON.stringify(output.data, null, 2));
  return parts.join("\n");
}

function formatWorkflowMessage(
  workflow: WorkflowRun,
  headline = `Workflow ${formatNamedEntityLabel(workflow)} is ${workflow.state}.`,
): string {
  const parts = [headline, "", `Goal: ${workflow.goal}`, "", "Stages:"];
  for (const [index, stage] of workflow.stages.entries()) {
    const current = index === workflow.currentStageIndex && workflow.state === "running" ? " current" : "";
    parts.push(`- ${stage.name}: ${stage.state}${current}${stage.busId ? ` bus=${stage.busId}` : ""}`);
  }
  if (workflow.result) parts.push("", "Result:", formatStageOutput(workflow.result));
  if (workflow.error) parts.push("", `Error: ${workflow.error}`);
  return parts.join("\n");
}

type RawWorkflowParams = {
  action: "start" | "status" | "cancel";
  name?: string;
  id?: string;
  goal?: string;
  stages?: RawWorkflowStageParams[];
};

type RawWorkflowStageParams = {
  name?: string;
  goal?: string;
  mode?: WorkgroupMode;
  members?: RawWorkgroupMemberParams[];
  leader?: RawWorkgroupMemberParams;
};
