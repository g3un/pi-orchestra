import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRun } from "../core/subagent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import type {
  WorkflowRun,
  WorkflowStageAgentSpec,
  WorkflowStageOutput,
  WorkflowStageRun,
  WorkflowStageSpec,
} from "../core/workflow.ts";
import { createWorkgroupRun, type WorkgroupRun } from "../core/workgroup.ts";
import {
  closeAgentRuns,
  createEntityIdentity,
  formatError,
  findWorkflow,
  formatNamedEntityLabel,
  isAgentRunFinished,
  isTerminalAgentState,
  normalizeEntityName,
  requireWorkflow,
  slugify,
} from "../utils.ts";
import {
  AgentProfileParams,
  SubagentRunNameParam,
  toAgentProfile,
  type RawAgentProfileParams,
  withDefaultProfileModelInput,
} from "./subagent.ts";

export type WorkflowInput =
  | {
      action: "start";
      name: string | undefined;
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

export interface WorkflowPiToolOptions {
  onWorkflowInput: ((ctx: ExtensionContext, input: WorkflowInput) => void) | undefined;
  onWorkflowOutput: ((ctx: ExtensionContext, output: WorkflowOutput) => void) | undefined;
}

const WorkflowLeaderParams = Type.Object(
  {
    profile: AgentProfileParams,
    name: SubagentRunNameParam,
  },
  { additionalProperties: false },
);

const WorkflowStageParams = Type.Object(
  {
    name: Type.String({
      description: "Short unique stage name within this linear workflow.",
    }),
    goal: Type.String({
      description: "Stage-specific goal.",
    }),
    leader: WorkflowLeaderParams,
  },
  { additionalProperties: false },
);

const WorkflowActionParams = Type.String({
  enum: ["start", "status", "cancel"],
  description: "start launches; status inspects progress or results; cancel closes active runs.",
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
        description: "Required for status/cancel. Workflow id/name.",
      }),
    ),
    goal: Type.Optional(
      Type.String({
        description: "Required for start. Overall workflow goal.",
      }),
    ),
    stages: Type.Optional(
      Type.Array(WorkflowStageParams, {
        description:
          "Required for action=start. Linear stages executed in order; each stage specifies a leader that creates its own workgroup members.",
        minItems: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createWorkflowTool({ orchestra, store }: WorkflowToolDeps): WorkflowTool {
  const runnerTasks = new Map<string, Promise<void>>();

  const startRunner = (workflowId: string) => {
    const task = runWorkflow(workflowId, { orchestra, store })
      .catch((error) => failWorkflow(store, workflowId, formatError(error)))
      .finally(() => runnerTasks.delete(workflowId));
    runnerTasks.set(workflowId, task);
  };

  return {
    name: "workflow",

    async execute(input) {
      if (input.action === "start") {
        const workflow = createWorkflowRun(input, store.listWorkflows(), store.listRuns());
        store.saveWorkflow(workflow);
        startRunner(workflow.id);
        const startedWorkflow = store.getWorkflow(workflow.id) ?? workflow;
        return { workflow: startedWorkflow, message: formatWorkflowMessage(startedWorkflow) };
      }

      const workflow = findWorkflow(store, input.id);
      if (!workflow) return { message: formatWorkflowNotFound(input.id) };

      if (input.action === "status") return { workflow, message: formatWorkflowMessage(workflow) };

      const closedWorkflow = await closeWorkflow(orchestra, store, workflow);
      return { workflow: closedWorkflow, message: formatWorkflowMessage(closedWorkflow, "Workflow cancelled.") };
    },
  };
}

export function defineWorkflowPiTool(
  resolveTool: (ctx: ExtensionContext) => WorkflowTool,
  options: WorkflowPiToolOptions = { onWorkflowInput: undefined, onWorkflowOutput: undefined },
) {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: "Run linear workgroup stages, each with a leader that creates and coordinates its members.",
    promptSnippet: "Launch a multi-stage workflow; stage leaders create workgroup members as needed.",
    promptGuidelines: [
      "Use workflow for ordered multi-stage work; not branching/DAG plans.",
      "Each stage gets its own bus and requires an explicit leader; the leader creates workgroup members as needed and previous stage outputs feed the next stage.",
      "Give each stage leader the workgroup tool so it can add members; include any inspection/search tools it needs to lead the stage.",
      "Prefer profile.preset with explicit tools when a built-in profile fits; use custom systemPrompt only for one-off roles.",
      "The stage leader decides whether to run competing alternatives, complementary research, reviews, or follow-ups.",
      "Use workflow status for progress; workflow.finished events deliver terminal success/blocked/failed/closed results.",
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
}

async function runWorkflow(workflowId: string, deps: WorkflowRunnerDeps): Promise<void> {
  for (;;) {
    const workflow = deps.store.getWorkflow(workflowId);
    if (!workflow || isTerminalAgentState(workflow.state)) return;

    const stageIndex = workflow.stages.findIndex((stage) => stage.state === "idle" && !stage.phase);
    if (stageIndex < 0) {
      if (workflow.state === "running")
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
  const workgroup = createWorkgroupRun({
    name: undefined,
    autoNameSeed: `${workflow.name}-${stage.name}-workgroup`,
    existingWorkgroups: deps.store.listWorkgroups(),
    busId: bus.id,
    goal: buildStageWorkgroupGoal(workflow, stageIndex),
    leaderRunId: null,
  });
  deps.store.saveWorkgroup(workgroup);
  updateStage(deps.store, workflow, stageIndex, {
    state: "running",
    phase: "leader",
    startedAtMs: Date.now(),
    busId: bus.id,
    workgroupId: workgroup.id,
  });

  const leaderRun = await deps.orchestra.spawnAgent(
    stage.leader.profile,
    buildStageLeaderTask(workflow, stageIndex, workgroup),
    bus.id,
    { name: stage.leader.name },
  );
  if (isWorkflowClosed(deps.store, workflowId)) {
    await deps.orchestra.closeAgent(leaderRun.id, { busId: undefined });
    return;
  }

  const leaderWorkgroup = { ...workgroup, leaderRunId: leaderRun.id };
  deps.store.saveWorkgroup(leaderWorkgroup);
  updateStage(deps.store, requireWorkflow(deps.store, workflowId), stageIndex, {
    state: "running",
    phase: "leader",
    leaderRunId: leaderRun.id,
    workgroupId: leaderWorkgroup.id,
  });

  const outcome = await Promise.race([
    terminalWorkgroupEvent(deps.store, leaderWorkgroup.id).then((workgroup) => ({
      type: "workgroup" as const,
      workgroup,
    })),
    terminalRunEvent(deps.store, leaderRun.id).then((run) => ({ type: "leader" as const, run })),
  ]);
  if (isWorkflowClosed(deps.store, workflowId)) return;

  const latestWorkgroup = deps.store.getWorkgroup(leaderWorkgroup.id) ?? leaderWorkgroup;
  if (outcome.type === "workgroup") {
    await deps.orchestra.closeAgent(leaderRun.id, { busId: undefined });
    finishStage(
      deps.store,
      requireWorkflow(deps.store, workflowId),
      stageIndex,
      buildStageOutputFromWorkgroup(
        outcome.workgroup,
        leaderRun.id,
        collectWorkgroupRunResults(deps.store, outcome.workgroup),
      ),
    );
    return;
  }

  const closedWorkgroup = await closeWorkgroupAfterLeaderFinished(
    deps.orchestra,
    deps.store,
    latestWorkgroup,
    outcome.run,
  );
  const output = buildStageOutput(outcome.run, leaderRun.id, collectWorkgroupRunResults(deps.store, closedWorkgroup));
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
  existingRuns: AgentRun[],
): WorkflowRun {
  validateStages(input.stages, existingRuns);
  const identity = createEntityIdentity(input.name, "workflow", existingWorkflows, "Workflow");
  const startedAtMs = Date.now();
  return {
    ...identity,
    goal: input.goal,
    startedAtMs,
    state: "running",
    currentStageIndex: 0,
    stages: input.stages.map((stage) => ({
      ...stage,
      name: normalizeEntityName(stage.name, "Workflow stage"),
      state: "idle" as const,
      startedAtMs,
    })),
  };
}

function validateStages(stages: WorkflowStageSpec[], existingRuns: AgentRun[]): void {
  if (stages.length === 0) throw new Error("workflow requires at least one stage.");

  const names = new Set<string>();
  const reservedLeaderNames = new Set<string>();
  for (const run of existingRuns) {
    reservedLeaderNames.add(run.id);
    reservedLeaderNames.add(run.name);
  }

  for (const stage of stages) {
    const name = normalizeEntityName(stage.name, "Workflow stage");
    if (names.has(name)) throw new Error(`Workflow stage name "${name}" is already in use.`);
    names.add(name);
    if (!stage.leader) throw new Error(`workflow stage ${name} requires a leader.`);

    const leaderName = normalizeEntityName(stage.leader.name, "Workflow leader");
    const leaderId = slugify(leaderName);
    if (!leaderId) throw new Error(`Workflow leader name "${leaderName}" must contain letters or numbers.`);
    if (reservedLeaderNames.has(leaderName) || reservedLeaderNames.has(leaderId)) {
      throw new Error(`Workflow leader name "${leaderName}" is already in use.`);
    }
    reservedLeaderNames.add(leaderName);
    reservedLeaderNames.add(leaderId);
  }
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
  if (!stage.leader) throw new Error(`workflow stage ${stage.name} requires a leader.`);

  return {
    name: stage.name,
    goal: stage.goal,
    leader: toWorkflowLeaderSpec(stage.leader, "workflow leader"),
  };
}

function toWorkflowLeaderSpec(leader: RawWorkflowLeaderParams, label: string): WorkflowStageAgentSpec {
  if (!leader.profile) throw new Error(`${label} requires profile.`);
  if (!leader.name) throw new Error(`${label} requires name.`);
  return { profile: toAgentProfile(leader.profile), name: leader.name };
}

function withDefaultModels(input: WorkflowInput, ctx: ExtensionContext): WorkflowInput {
  if (input.action !== "start") return input;
  return {
    ...input,
    stages: input.stages.map((stage) => ({
      ...stage,
      leader: withDefaultProfileModelInput(stage.leader, ctx),
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
  return workflow.stages.map((stage) => stage.leaderRunId).filter((runId): runId is string => runId !== undefined);
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

function buildStageWorkgroupGoal(workflow: WorkflowRun, stageIndex: number): string {
  const stage = workflow.stages[stageIndex];
  return [
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
  ].join("\n");
}

function buildStageLeaderTask(workflow: WorkflowRun, stageIndex: number, workgroup: WorkgroupRun): string {
  const stage = workflow.stages[stageIndex];

  return [
    "You are the leader for this workflow stage.",
    "Decide whether the stage needs competing alternatives, complementary research, reviews, or follow-ups.",
    "You own the stage workgroup; create and steer members as needed.",
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    `Current stage: ${stage.name}`,
    "Stage goal:",
    stage.goal,
    "",
    `Workgroup id: ${workgroup.id}`,
    "Use workgroup action=add_members with this workgroup id whenever you need member subagents.",
    "For add_members, each member needs profile, task, and name only; do not provide subagent action or busId.",
    "Use workgroup action=finish with this workgroup id as your final stage output when the stage has enough evidence; it closes the workgroup bus and members.",
    "Member finish events are routed to you; main only needs your final stage output.",
    "",
    "Previous stage outputs:",
    "<previous_stage_outputs>",
    formatPreviousStageOutputs(workflow, stageIndex),
    "</previous_stage_outputs>",
    "",
    "Finish:",
    "- Prefer workgroup action=finish once with concise summary and useful data for the next stage.",
    "- Base the final output on member results and bus context; note gaps or conflicts.",
    "- Prefer status=success if any useful output exists; blocked if insufficient, failed if stage leadership fails.",
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

function formatStageOutputForPrompt(output: WorkflowStageOutput): string {
  const parts = [`status: ${output.status}`, "summary:", output.summary];
  if (output.data !== undefined) parts.push("data_json:", formatJsonData(output.data));
  return parts.join("\n");
}

function formatJsonData(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? String(data);
}

async function closeWorkgroupAfterLeaderFinished(
  orchestra: OrchestraApi,
  store: AgentStore,
  workgroup: WorkgroupRun,
  leaderRun: AgentRun,
): Promise<WorkgroupRun> {
  if (workgroup.state !== "running") return workgroup;

  const result = leaderRun.result ?? {
    status: "failed" as const,
    summary: `Stage leader ${leaderRun.id} reached ${leaderRun.state} without a result payload.`,
  };
  const closingWorkgroup: WorkgroupRun = { ...workgroup, state: "closing", result };
  store.saveWorkgroup(closingWorkgroup);
  await Promise.allSettled(workgroup.memberRunIds.map((runId) => orchestra.closeAgent(runId, { busId: undefined })));
  orchestra.closeBus(workgroup.busId);
  const closedWorkgroup: WorkgroupRun = { ...closingWorkgroup, state: "closed" };
  store.saveWorkgroup(closedWorkgroup);
  return closedWorkgroup;
}

function collectWorkgroupRunResults(store: AgentStore, workgroup: WorkgroupRun) {
  return workgroup.memberRunIds.flatMap((runId) => {
    const run = store.getRun(runId);
    return run?.result ? [toWorkflowRunResult(run)] : [];
  });
}

function buildStageOutputFromWorkgroup(
  workgroup: WorkgroupRun,
  leaderRunId: string,
  memberResults: WorkflowStageOutput["memberResults"],
): WorkflowStageOutput {
  if (workgroup.result === null) {
    return {
      status: "failed",
      summary: `Workgroup ${workgroup.id} closed without a result payload.`,
      leaderRunId,
      memberResults,
    };
  }

  const output: WorkflowStageOutput = {
    status: workgroup.result.status,
    summary: workgroup.result.summary,
    leaderRunId,
    memberResults,
  };
  if (workgroup.result.data !== undefined) output.data = workgroup.result.data;
  return output;
}

function buildStageOutput(
  leaderRun: AgentRun,
  leaderRunId: string,
  memberResults: WorkflowStageOutput["memberResults"],
): WorkflowStageOutput {
  if (leaderRun.result === null) {
    return {
      status: "failed",
      summary: `Stage leader ${leaderRunId} reached ${leaderRun.state} without a result payload.`,
      leaderRunId,
      memberResults,
    };
  }

  const output: WorkflowStageOutput = {
    status: leaderRun.result.status,
    summary: leaderRun.result.summary,
    leaderRunId,
    memberResults,
  };
  if (leaderRun.result.data !== undefined) output.data = leaderRun.result.data;
  return output;
}

function toWorkflowRunResult(run: AgentRun) {
  return {
    runId: run.id,
    name: run.name,
    profile: run.profile.name,
    state: run.state,
    result: run.result,
  };
}

function formatStageOutput(output: WorkflowStageOutput): string {
  const parts = [`status: ${output.status}`, `summary: ${output.summary}`];
  if (output.data !== undefined) parts.push("data:", formatJsonData(output.data));
  return parts.join("\n");
}

function terminalWorkgroupEvent(store: AgentStore, workgroupId: string): Promise<WorkgroupRun> {
  const initialWorkgroup = store.getWorkgroup(workgroupId);
  if (initialWorkgroup?.state === "closed") return Promise.resolve(initialWorkgroup);

  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    unsubscribe = store.subscribeWorkgroups(
      (workgroup) => {
        if (workgroup.state !== "closed") return;

        unsubscribe();
        resolve(workgroup);
      },
      (workgroup) => workgroup.id === workgroupId,
    );
  });
}

function terminalRunEvent(store: AgentStore, runId: string): Promise<AgentRun> {
  const initialRun = store.getRun(runId);
  if (initialRun && isAgentRunFinished(initialRun)) return Promise.resolve(initialRun);

  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    unsubscribe = store.subscribeRuns(
      (run) => {
        if (!isAgentRunFinished(run)) return;

        unsubscribe();
        resolve(run);
      },
      (run) => run.id === runId,
    );
  });
}

function formatWorkflowNotFound(id: string): string {
  return `Workflow ${id} not found.`;
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

type RawWorkflowLeaderParams = {
  profile?: RawAgentProfileParams;
  name?: string;
};

type RawWorkflowStageParams = {
  name?: string;
  goal?: string;
  leader?: RawWorkflowLeaderParams;
};
