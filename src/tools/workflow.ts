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
import type { WorkflowRun } from "../core/workflow.ts";
import { createWorkgroupRun, type WorkgroupRun } from "../core/workgroup.ts";
import {
  closeAgentRuns,
  createEntityIdentity,
  findWorkflow,
  formatError,
  formatNamedEntityLabel,
  isAgentRunFinished,
  normalizeEntityName,
  requireWorkflow,
  slugify,
  type NamedEntity,
} from "../utils.ts";
import {
  AgentProfileParams,
  formatResultData,
  SubagentRunNameParam,
  toAgentProfile,
  type RawAgentProfileParams,
  type SubagentSpawnInput,
  withDefaultProfileModelInput,
} from "./subagent.ts";
import { closeWorkgroupRun } from "./workgroup.ts";

type WorkflowLeaderInput = Omit<SubagentSpawnInput, "action" | "busId">;

export type WorkflowInput =
  | {
      action: "create";
      name: string;
      goal: string;
      leader: WorkflowLeaderInput;
    }
  | {
      action: "spawn_workgroup";
      workflowId: string;
      name: string;
      goal: string;
      leader: WorkflowLeaderInput;
    }
  | {
      action: "finish";
      workflowId: string;
      result: AgentResult;
    }
  | {
      action: "status";
      workflowId: string;
    }
  | {
      action: "cancel";
      workflowId: string;
    };

export type WorkflowToolOutput =
  | {
      action: "create";
      workflow: WorkflowRun;
      bus: Bus;
    }
  | {
      action: "spawn_workgroup";
      workflow: WorkflowRun;
      workgroup: WorkgroupRun;
      bus: Bus;
    }
  | {
      action: "finish";
      workflow: WorkflowRun;
    }
  | {
      action: "status";
      workflow: WorkflowRun;
    }
  | {
      action: "cancel";
      workflow: WorkflowRun;
    }
  | {
      action: "not_found";
      workflowId: string;
    };

export interface WorkflowTool {
  name: "workflow";
  execute(input: WorkflowInput): Promise<WorkflowToolOutput>;
}

export interface WorkflowToolDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
}

export interface WorkflowPiToolOptions {
  onWorkflowInput: ((ctx: ExtensionContext, input: WorkflowInput) => void) | undefined;
  onWorkflowOutput: ((ctx: ExtensionContext, output: WorkflowToolOutput) => void) | undefined;
}

const WorkflowLeaderParams = Type.Object(
  {
    profile: AgentProfileParams,
    task: Type.String({
      description: "Leader task. The workflow fills action and private bus id automatically.",
    }),
    name: SubagentRunNameParam,
  },
  {
    additionalProperties: false,
    description: "Required for create and spawn_workgroup. The flow leader or child workgroup leader.",
  },
);

const WorkflowActionParams = Type.String({
  enum: ["create", "spawn_workgroup", "finish", "status", "cancel"],
  description:
    "create launches a flow leader; spawn_workgroup lets the flow leader spawn a led workgroup; finish is for the flow leader's final output; status inspects; cancel is for the supervising parent/main to close active workflow resources.",
});

const WorkflowToolParams = Type.Object(
  {
    action: WorkflowActionParams,
    name: Type.Optional(
      Type.String({
        description: "Required for create and spawn_workgroup. Unique workflow or child workgroup name.",
      }),
    ),
    workflowId: Type.Optional(
      Type.String({
        description: "Required for spawn_workgroup/finish/status/cancel. Workflow id/name.",
      }),
    ),
    goal: Type.Optional(
      Type.String({
        description: "Required for create and spawn_workgroup. Overall workflow goal or child workgroup goal.",
      }),
    ),
    leader: Type.Optional(WorkflowLeaderParams),
    status: Type.Optional(
      Type.String({
        enum: [...AGENT_RESULT_STATUS_VALUES],
        description: "Required for action=finish. Final workflow result status.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description: "Required for action=finish. Concise final workflow summary for main.",
      }),
    ),
    data: Type.Optional(
      Type.Unknown({
        description: "Optional structured final workflow output for action=finish.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createWorkflowTool({ orchestra, store }: WorkflowToolDeps): WorkflowTool {
  const runnerTasks = new Map<string, Promise<void>>();

  const startRunner = (workflowId: string) => {
    if (runnerTasks.has(workflowId)) return;

    const task = runWorkflow(workflowId, { orchestra, store })
      .catch((error) => failWorkflow(store, workflowId, formatError(error)))
      .finally(() => runnerTasks.delete(workflowId));
    runnerTasks.set(workflowId, task);
  };

  return {
    name: "workflow",

    async execute(input) {
      if (input.action === "create") {
        const { workflow, bus } = await startWorkflow(input, { orchestra, store });
        startRunner(workflow.id);
        return { action: "create", workflow, bus };
      }

      const workflow = findWorkflow(store, input.workflowId);
      if (!workflow) {
        return {
          action: "not_found",
          workflowId: input.workflowId,
        };
      }

      if (input.action === "status") return { action: "status", workflow };

      if (input.action === "cancel") {
        const closedWorkflow = await closeWorkflow(orchestra, store, workflow);
        return {
          action: "cancel",
          workflow: closedWorkflow,
        };
      }

      if (input.action === "finish") {
        const closingWorkflow = requestWorkflowFinish(store, workflow, input.result);
        startRunner(closingWorkflow.id);
        return {
          action: "finish",
          workflow: closingWorkflow,
        };
      }

      const output = await spawnWorkflowWorkgroup(workflow, input, { orchestra, store });
      startRunner(output.workflow.id);
      return output;
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
    description:
      "Run an adaptive workflow led by a flow leader. The flow leader creates led workgroups as needed and finishes the workflow.",
    promptSnippet: "Launch or lead an adaptive workflow with flow-leader-created workgroups.",
    promptGuidelines: [
      "Use workflow action=create for an adaptive multi-step goal; provide one explicit flow leader.",
      "The flow leader should have the workflow tool and any inspection/search tools needed to decide the plan.",
      "As the flow leader, use workflow action=spawn_workgroup to spawn the next led workgroup when useful; each workgroup gets its own private bus.",
      "Give each workgroup leader the workgroup tool so it can add members and finish its own workgroup.",
      "Use workgroup.finished events from child groups as the evidence for deciding the next workgroup or final answer.",
      "As the flow leader, use workflow action=finish exactly once when the overall goal is achieved or blocked; this closes child workgroups, buses, and the flow leader before main receives workflow.finished.",
      "Only the flow leader should call workflow action=finish; parent/main should wait for workflow.finished rather than finishing for it.",
      "Only the supervising parent/main should call workflow action=cancel; a flow leader should finish with blocked or failed instead of cancelling its own workflow.",
      "Use workflow status for progress; workflow.finished events deliver the closed workflow plus final result status to main.",
    ],
    parameters: WorkflowToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModels(toWorkflowInput(params as RawWorkflowParams), ctx);
      options.onWorkflowInput?.(ctx, input);

      const output = await resolveTool(ctx).execute(input);
      if (output.action !== "not_found") options.onWorkflowOutput?.(ctx, output);

      return {
        content: [{ type: "text", text: formatWorkflowOutputMessage(output) }],
        details: output,
      };
    },
  });
}

interface WorkflowRunnerDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
}

async function startWorkflow(
  input: Extract<WorkflowInput, { action: "create" }>,
  deps: WorkflowRunnerDeps,
): Promise<{ workflow: WorkflowRun; bus: Bus }> {
  validateLeaderName(input.leader.name, "Workflow leader", deps.store.listRuns());

  const identity = createEntityIdentity(input.name, "workflow", deps.store.listWorkflows(), "Workflow");
  const bus = deps.orchestra.createBus({ name: `${identity.name}-flow-bus` });
  const workflow = createWorkflowRun(input, identity, bus.id);
  deps.store.saveWorkflow(workflow);

  try {
    const leaderRun = await deps.orchestra.spawnAgent(
      input.leader.profile,
      buildFlowLeaderTask(workflow, input.leader.task),
      workflow.busId,
      { name: input.leader.name },
    );
    const workflowWithLeader: WorkflowRun = { ...requireWorkflow(deps.store, workflow.id), leaderRunId: leaderRun.id };
    deps.store.saveWorkflow(workflowWithLeader);
    return { workflow: workflowWithLeader, bus };
  } catch (error) {
    deps.orchestra.closeBus(workflow.busId);
    const failedWorkflow: WorkflowRun = {
      ...workflow,
      state: "closed",
      error: formatError(error),
      result: {
        status: "failed",
        summary: formatError(error),
      },
    };
    deps.store.saveWorkflow(failedWorkflow);
    throw error;
  }
}

async function runWorkflow(workflowId: string, deps: WorkflowRunnerDeps): Promise<void> {
  for (;;) {
    const workflow = deps.store.getWorkflow(workflowId);
    if (!workflow || workflow.state === "closed") return;
    if (workflow.state === "closing") {
      if (workflow.result) await finalizeClosingWorkflow(deps.orchestra, deps.store, workflow);
      return;
    }
    if (!workflow.leaderRunId) return;

    const outcome = await Promise.race([
      workflowNotRunningEvent(deps.store, workflowId).then((updatedWorkflow) => ({
        type: "workflow" as const,
        workflow: updatedWorkflow,
      })),
      terminalRunEvent(deps.store, workflow.leaderRunId).then((run) => ({ type: "leader" as const, run })),
    ]);

    const latestWorkflow = deps.store.getWorkflow(workflowId);
    if (!latestWorkflow || latestWorkflow.state === "closed") return;

    if (outcome.type === "workflow" || latestWorkflow.state === "closing") {
      if (latestWorkflow.state === "closing" && latestWorkflow.result) {
        await finalizeClosingWorkflow(deps.orchestra, deps.store, latestWorkflow);
      }
      return;
    }

    await finishWorkflowFromLeader(deps.orchestra, deps.store, latestWorkflow, outcome.run);
    return;
  }
}

async function spawnWorkflowWorkgroup(
  workflow: WorkflowRun,
  input: Extract<WorkflowInput, { action: "spawn_workgroup" }>,
  deps: WorkflowRunnerDeps,
): Promise<Extract<WorkflowToolOutput, { action: "spawn_workgroup" }>> {
  if (workflow.state !== "running") throw new Error(`Workflow ${input.workflowId} is ${workflow.state}.`);

  validateLeaderName(input.leader.name, "Workflow workgroup leader", deps.store.listRuns());
  validateWorkgroupName(input.name, deps.store.listWorkgroups());

  const bus = deps.orchestra.createBus({ name: `${workflow.name}-${input.name}-bus` });
  const workgroup = createWorkgroupRun({
    name: input.name,
    autoNameSeed: `${workflow.name}-${input.name}-workgroup`,
    existingWorkgroups: deps.store.listWorkgroups(),
    busId: bus.id,
    goal: buildWorkflowWorkgroupGoal(deps.store, workflow, input.goal),
    leaderRunId: null,
  });
  deps.store.saveWorkgroup(workgroup);

  const workflowWithWorkgroup = appendWorkflowWorkgroupId(deps.store, workflow, workgroup.id);
  const leaderRun = await deps.orchestra.spawnAgent(
    input.leader.profile,
    buildWorkgroupLeaderTask(deps.store, workflowWithWorkgroup, workgroup, input.goal, input.leader.task),
    bus.id,
    { name: input.leader.name },
  );

  const latestWorkflow = deps.store.getWorkflow(workflow.id);
  if (!latestWorkflow || latestWorkflow.state !== "running") {
    const latestWorkgroup = deps.store.getWorkgroup(workgroup.id) ?? workgroup;
    const ledWorkgroup = { ...latestWorkgroup, leaderRunId: leaderRun.id };
    deps.store.saveWorkgroup(ledWorkgroup);
    const closedWorkgroup = await closeWorkgroupRun(deps.orchestra, deps.store, ledWorkgroup, {
      includeLeader: true,
      result: undefined,
    });
    return {
      action: "spawn_workgroup",
      workflow: latestWorkflow ?? workflowWithWorkgroup,
      workgroup: closedWorkgroup,
      bus,
    };
  }

  const ledWorkgroup: WorkgroupRun = { ...workgroup, leaderRunId: leaderRun.id };
  deps.store.saveWorkgroup(ledWorkgroup);
  const latestWorkflowWithLeader = deps.store.getWorkflow(workflow.id) ?? latestWorkflow;
  return {
    action: "spawn_workgroup",
    workflow: latestWorkflowWithLeader,
    workgroup: ledWorkgroup,
    bus,
  };
}

async function finishWorkflowFromLeader(
  orchestra: OrchestraApi,
  store: AgentStore,
  workflow: WorkflowRun,
  leaderRun: AgentRun,
): Promise<WorkflowRun> {
  const result = leaderRun.result ?? {
    status: "failed" as const,
    summary: `Flow leader ${leaderRun.id} reached ${leaderRun.state} without a result payload.`,
  };
  const closingWorkflow = requestWorkflowFinish(store, workflow, result);
  return await finalizeClosingWorkflow(orchestra, store, closingWorkflow);
}

function requestWorkflowFinish(store: AgentStore, workflow: WorkflowRun, result: AgentResult): WorkflowRun {
  const latestWorkflow = store.getWorkflow(workflow.id) ?? workflow;
  if (latestWorkflow.state === "closed") return latestWorkflow;
  if (latestWorkflow.state === "closing") return latestWorkflow;

  const closingWorkflow: WorkflowRun = {
    ...latestWorkflow,
    state: "closing",
    result,
  };
  store.saveWorkflow(closingWorkflow);
  return closingWorkflow;
}

async function finalizeClosingWorkflow(
  orchestra: OrchestraApi,
  store: AgentStore,
  workflow: WorkflowRun,
): Promise<WorkflowRun> {
  const latestWorkflow = store.getWorkflow(workflow.id) ?? workflow;
  if (latestWorkflow.state === "closed") return latestWorkflow;

  const result = latestWorkflow.result ?? {
    status: "failed" as const,
    summary: `Workflow ${latestWorkflow.id} entered closing without a result payload.`,
  };
  const closingWorkflow: WorkflowRun = { ...latestWorkflow, state: "closing", result };
  store.saveWorkflow(closingWorkflow);
  await closeWorkflowResources(orchestra, store, closingWorkflow);

  const afterClose = store.getWorkflow(workflow.id) ?? closingWorkflow;
  const finishedWorkflow: WorkflowRun = {
    ...afterClose,
    state: "closed",
    result,
  };
  store.saveWorkflow(finishedWorkflow);
  return finishedWorkflow;
}

async function closeWorkflow(orchestra: OrchestraApi, store: AgentStore, workflow: WorkflowRun): Promise<WorkflowRun> {
  const latestWorkflow = store.getWorkflow(workflow.id) ?? workflow;
  if (latestWorkflow.state === "closed") return latestWorkflow;
  if (latestWorkflow.state === "closing") return latestWorkflow;

  const result = latestWorkflow.result ?? { status: "blocked" as const, summary: "Workflow cancelled." };
  const closingWorkflow: WorkflowRun = { ...latestWorkflow, state: "closing", result };
  store.saveWorkflow(closingWorkflow);
  await closeWorkflowResources(orchestra, store, closingWorkflow);

  const afterClose = store.getWorkflow(workflow.id) ?? closingWorkflow;
  const closedWorkflow: WorkflowRun = { ...afterClose, state: "closed", result: afterClose.result ?? result };
  store.saveWorkflow(closedWorkflow);
  return closedWorkflow;
}

async function closeWorkflowResources(
  orchestra: OrchestraApi,
  store: AgentStore,
  workflow: WorkflowRun,
): Promise<void> {
  const latestWorkflow = store.getWorkflow(workflow.id) ?? workflow;
  const extraRunIds = new Set<string>();

  for (const workgroupId of latestWorkflow.workgroupIds) {
    const workgroup = store.getWorkgroup(workgroupId);
    if (!workgroup) continue;

    for (const run of orchestra.listRuns({ busId: workgroup.busId })) extraRunIds.add(run.id);
    await closeWorkgroupRun(orchestra, store, workgroup, { includeLeader: true, result: undefined });
  }

  for (const run of orchestra.listRuns({ busId: latestWorkflow.busId })) extraRunIds.add(run.id);
  if (latestWorkflow.leaderRunId) extraRunIds.add(latestWorkflow.leaderRunId);
  await closeAgentRuns(orchestra, [...extraRunIds]);

  orchestra.closeBus(latestWorkflow.busId);
}

function createWorkflowRun(
  input: Extract<WorkflowInput, { action: "create" }>,
  identity: NamedEntity,
  busId: string,
): WorkflowRun {
  return {
    ...identity,
    goal: input.goal,
    startedAtMs: Date.now(),
    state: "running",
    busId,
    leaderRunId: null,
    workgroupIds: [],
    result: null,
  };
}

function validateLeaderName(name: string, label: string, existingRuns: AgentRun[]): void {
  const normalizedName = normalizeEntityName(name, label);
  const leaderId = slugify(normalizedName);
  if (!leaderId) throw new Error(`${label} name "${normalizedName}" must contain letters or numbers.`);

  for (const run of existingRuns) {
    if (run.id === leaderId || run.name === normalizedName) {
      throw new Error(`${label} name "${normalizedName}" is already in use.`);
    }
  }
}

function validateWorkgroupName(name: string, existingWorkgroups: WorkgroupRun[]): void {
  const normalizedName = normalizeEntityName(name, "Workflow workgroup");
  const id = slugify(normalizedName);
  if (!id) throw new Error(`Workflow workgroup name "${normalizedName}" must contain letters or numbers.`);

  if (existingWorkgroups.some((workgroup) => workgroup.id === id || workgroup.name === normalizedName)) {
    throw new Error(`Workflow workgroup name "${normalizedName}" is already in use.`);
  }
}

function toWorkflowInput(params: RawWorkflowParams): WorkflowInput {
  if (params.action === "create") {
    if (!params.name) throw new Error("workflow action=create requires name.");
    if (!params.goal) throw new Error("workflow action=create requires goal.");
    if (!params.leader) throw new Error("workflow action=create requires leader.");
    return {
      action: "create",
      name: params.name,
      goal: params.goal,
      leader: toWorkflowLeaderInput(params.leader, "workflow leader"),
    };
  }

  if (params.action === "spawn_workgroup") {
    if (!params.workflowId) throw new Error("workflow action=spawn_workgroup requires workflowId.");
    if (!params.name) throw new Error("workflow action=spawn_workgroup requires name.");
    if (!params.goal) throw new Error("workflow action=spawn_workgroup requires goal.");
    if (!params.leader) throw new Error("workflow action=spawn_workgroup requires leader.");
    return {
      action: "spawn_workgroup",
      workflowId: params.workflowId,
      name: params.name,
      goal: params.goal,
      leader: toWorkflowLeaderInput(params.leader, "workflow workgroup leader"),
    };
  }

  if (params.action === "finish") {
    if (!params.workflowId) throw new Error("workflow action=finish requires workflowId.");
    if (!params.status) throw new Error("workflow action=finish requires status.");
    if (!params.summary) throw new Error("workflow action=finish requires summary.");
    const result: AgentResult = { status: params.status, summary: params.summary };
    if (params.data !== undefined) result.data = params.data;
    return { action: "finish", workflowId: params.workflowId, result };
  }

  if (!params.workflowId) throw new Error(`workflow action=${params.action} requires workflowId.`);
  return { action: params.action, workflowId: params.workflowId };
}

function toWorkflowLeaderInput(leader: RawWorkflowLeaderParams, label: string): WorkflowLeaderInput {
  if (!leader.profile) throw new Error(`${label} requires profile.`);
  if (!leader.task) throw new Error(`${label} requires task.`);
  if (!leader.name) throw new Error(`${label} requires name.`);
  return { profile: toAgentProfile(leader.profile), task: leader.task, name: leader.name };
}

function withDefaultModels(input: WorkflowInput, ctx: ExtensionContext): WorkflowInput {
  if (input.action !== "create" && input.action !== "spawn_workgroup") return input;
  return {
    ...input,
    leader: withDefaultProfileModelInput(input.leader, ctx),
  };
}

function appendWorkflowWorkgroupId(store: AgentStore, workflow: WorkflowRun, workgroupId: string): WorkflowRun {
  const latestWorkflow = requireWorkflow(store, workflow.id);
  if (latestWorkflow.workgroupIds.includes(workgroupId)) return latestWorkflow;

  const updatedWorkflow = { ...latestWorkflow, workgroupIds: [...latestWorkflow.workgroupIds, workgroupId] };
  store.saveWorkflow(updatedWorkflow);
  return updatedWorkflow;
}

function failWorkflow(store: AgentStore, workflowId: string, error: string): void {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow || workflow.state === "closed") return;

  const failedWorkflow: WorkflowRun = {
    ...workflow,
    state: "closed",
    error,
    result: {
      status: "failed",
      summary: error,
    },
  };
  store.saveWorkflow(failedWorkflow);
}

function buildFlowLeaderTask(workflow: WorkflowRun, leaderTask: string): string {
  return [
    "You are the flow leader for an adaptive workflow.",
    "Plan the next useful workgroup, inspect child workgroup results, and decide when the overall goal is done.",
    "",
    "Assigned task:",
    leaderTask,
    "Do not create all groups up front unless the goal clearly requires parallel independent tracks.",
    "Use one workgroup when one focused group is enough; create another only when the previous result shows it is useful.",
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    `Workflow id/name for workflowId: ${workflow.id}`,
    "Use workflow action=spawn_workgroup with this workflowId to spawn a child workgroup led by a group leader.",
    "Each spawn_workgroup call needs name, goal, and leader. Give the group leader the workgroup tool.",
    "Child workgroup buses are created internally. Workgroup member events go to the group leader; workgroup.finished events come back to you.",
    "Use workflow action=finish with this workflowId when the final goal is achieved, blocked, or failed.",
    "Do not call workflow action=cancel for your own workflow; cancellation is reserved for the supervising parent/main.",
    "",
    "Finalization rules:",
    "- Base the workflow final output on child workgroup results and your own reasoning.",
    "- Prefer status=success if the goal has a useful answer; blocked if external input is required; failed if execution failed.",
    "- Do not call your own finish until the workflow has been finished or closed.",
  ].join("\n");
}

function buildWorkflowWorkgroupGoal(store: AgentStore, workflow: WorkflowRun, workgroupGoal: string): string {
  return [
    "Workflow child workgroup",
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    "Workgroup goal:",
    workgroupGoal,
    "",
    "Completed workgroup outputs so far:",
    "<completed_workgroups>",
    formatCompletedWorkgroupOutputs(store, workflow),
    "</completed_workgroups>",
  ].join("\n");
}

function buildWorkgroupLeaderTask(
  store: AgentStore,
  workflow: WorkflowRun,
  workgroup: WorkgroupRun,
  workgroupGoal: string,
  leaderTask: string,
): string {
  return [
    "You are the leader for a workflow child workgroup.",
    "Create and coordinate member subagents only within this workgroup.",
    "",
    "Assigned task:",
    leaderTask,
    "",
    "Workflow goal:",
    workflow.goal,
    "",
    "Your workgroup goal:",
    workgroupGoal,
    "",
    `Workgroup id: ${workgroup.id}`,
    "Use workgroup action=add_members with this workgroup id whenever you need member subagents.",
    "For add_members, each member needs profile, task, and name only; do not provide subagent action or busId.",
    "Use workgroup action=finish with this workgroup id as your final group output when the group has enough evidence.",
    "Only you, the workgroup leader, should finish this workgroup; the flow leader receives the final workgroup.finished event instead of finishing it for you.",
    "After workgroup action=finish succeeds, call finish for your own run with the same status and summary.",
    "Member finish events are routed to you. The flow leader receives only the final workgroup.finished event.",
    "",
    "Completed workflow workgroups before this one:",
    "<completed_workgroups>",
    formatCompletedWorkgroupOutputs(store, workflow),
    "</completed_workgroups>",
  ].join("\n");
}

function formatCompletedWorkgroupOutputs(store: AgentStore, workflow: WorkflowRun): string {
  const outputs = collectWorkflowWorkgroups(store, workflow).filter((workgroup) => workgroup.result !== null);
  return outputs.length > 0
    ? outputs.map((workgroup) => formatWorkflowWorkgroupForPrompt(workgroup)).join("\n\n")
    : "None.";
}

function formatWorkflowWorkgroupForPrompt(workgroup: WorkgroupRun): string {
  const parts = [
    `<workgroup_output name="${workgroup.name}" id="${workgroup.id}">`,
    `status: ${workgroup.result?.status ?? workgroup.state}`,
    "summary:",
    workgroup.result?.summary ?? "No result payload.",
  ];
  if (workgroup.result?.data !== undefined) parts.push("data_json:", formatJsonData(workgroup.result.data));
  parts.push("</workgroup_output>");
  return parts.join("\n");
}

function collectWorkflowWorkgroups(store: AgentStore, workflow: WorkflowRun): WorkgroupRun[] {
  return workflow.workgroupIds.flatMap((workgroupId) => {
    const workgroup = store.getWorkgroup(workgroupId);
    return workgroup ? [workgroup] : [];
  });
}

function formatWorkflowOutputMessage(output: WorkflowToolOutput): string {
  if (output.action === "create") {
    return [
      `Created workflow ${formatNamedEntityLabel(output.workflow)} on bus ${formatNamedEntityLabel(output.bus)}.`,
      "",
      `Goal: ${output.workflow.goal}`,
      `Flow leader run id: ${output.workflow.leaderRunId ?? "pending"}`,
      "",
      "The flow leader will spawn child workgroups and finish the workflow.",
    ].join("\n");
  }

  if (output.action === "spawn_workgroup") return formatWorkflowWorkgroupCreatedMessage(output);
  if (output.action === "finish")
    return formatWorkflowSummary(output.workflow, "Workflow final output recorded; closing resources.");
  if (output.action === "cancel") return formatWorkflowSummary(output.workflow, "Workflow cancelled.");
  if (output.action === "status") return formatWorkflowSummary(output.workflow);
  return formatWorkflowNotFound(output.workflowId);
}

function formatWorkflowNotFound(id: string): string {
  return `Workflow ${id} not found.`;
}

function formatWorkflowSummary(
  workflow: WorkflowRun,
  headline = `Workflow ${formatNamedEntityLabel(workflow)} is ${workflow.state}.`,
): string {
  const parts = [
    headline,
    "",
    `Goal: ${workflow.goal}`,
    "",
    `Flow leader run id: ${workflow.leaderRunId ?? "pending"}`,
    `Workflow bus: ${workflow.busId}`,
    "",
    `Workgroup ids: ${workflow.workgroupIds.length > 0 ? workflow.workgroupIds.join(", ") : "none"}`,
  ];

  if (workflow.result) parts.push("", "Result:", formatWorkflowResult(workflow.result));
  if (workflow.error) parts.push("", `Error: ${workflow.error}`);
  return parts.join("\n");
}

function formatWorkflowResult(result: AgentResult): string {
  const parts = [`status: ${result.status}`, `summary: ${result.summary}`];
  if (result.data !== undefined) parts.push("data:", formatJsonData(result.data));
  return parts.join("\n");
}

function formatJsonData(data: unknown): string {
  return formatResultData(data);
}

function formatWorkflowWorkgroupCreatedMessage(
  output: Extract<WorkflowToolOutput, { action: "spawn_workgroup" }>,
): string {
  return [
    `Spawned workflow workgroup ${formatNamedEntityLabel(output.workgroup)} for workflow ${formatNamedEntityLabel(output.workflow)}.`,
    "",
    `Bus: ${formatNamedEntityLabel(output.bus)}`,
    `Leader run id: ${output.workgroup.leaderRunId ?? "pending"}`,
    "",
    "The group leader will receive member finish events. The flow leader will receive a workgroup.finished event when the group closes.",
  ].join("\n");
}

function workflowNotRunningEvent(store: AgentStore, workflowId: string): Promise<WorkflowRun> {
  const initialWorkflow = store.getWorkflow(workflowId);
  if (!initialWorkflow || initialWorkflow.state !== "running") {
    return Promise.resolve(initialWorkflow ?? requireWorkflow(store, workflowId));
  }

  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    unsubscribe = store.subscribeWorkflows(
      (workflow) => {
        if (workflow.state === "running") return;

        unsubscribe();
        resolve(workflow);
      },
      (workflow) => workflow.id === workflowId,
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

type RawWorkflowParams = {
  action: "create" | "spawn_workgroup" | "finish" | "status" | "cancel";
  name?: string;
  workflowId?: string;
  goal?: string;
  leader?: RawWorkflowLeaderParams;
  status?: AgentResultStatus;
  summary?: string;
  data?: unknown;
};

type RawWorkflowLeaderParams = {
  profile?: RawAgentProfileParams;
  task?: string;
  name?: string;
};
