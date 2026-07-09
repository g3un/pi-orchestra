import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBusSubscription, maxMessageSeq, type Bus } from "../core/bus.ts";
import {
  AGENT_RESULT_STATUS_VALUES,
  type AgentProfile,
  type AgentResult,
  type AgentResultStatus,
  type AgentRun,
} from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import {
  createWorkflowIdentity,
  createWorkflowRun,
  WORKFLOW_NAME_MAX_LENGTH,
  type WorkflowRun,
} from "../core/workflow.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import { createBusNameFromOwnerName, createPrefixedName } from "../naming.ts";
import { boundResultData } from "../formatting.ts";
import { closeAgentRuns, findEntity, requireParam, resolveRunName, resolveWorkgroupName } from "../utils.ts";
import { subscribeMainToBus } from "./bus.ts";
import {
  AgentProfileParams,
  spawnSubagent,
  SubagentRunNameParam,
  toAgentProfile,
  withDefaultProfileModelInput,
  type RawAgentProfileParams,
} from "./subagent.ts";
import {
  cancelWorkgroup,
  createAndLaunchWorkgroup,
  type WorkgroupMemberInput,
  type WorkgroupToolDeps,
} from "./workgroup.ts";

export type WorkflowInput =
  | { action: "create"; name: string; goal: string }
  | { action: "add_workgroup"; id: string; name: string; goal: string; members: WorkgroupMemberInput[] }
  | { action: "finish"; id: string; result: AgentResult }
  | { action: "cancel"; id: string }
  | { action: "status"; id: string };

export type WorkflowOutput =
  | { action: "create"; workflow: WorkflowRun; bus: Bus; coordinator: AgentRun; message: string }
  | { action: "add_workgroup"; workflow: WorkflowRun; workgroupId: string; runIds: string[]; message: string }
  | { action: "finish"; workflow: WorkflowRun; message: string }
  | { action: "cancel"; workflow: WorkflowRun; alreadyClosed: boolean; message: string }
  | { action: "status"; workflow: WorkflowRun; coordinator: AgentRun | undefined; message: string }
  | { action: "not_found"; id: string; message: string };

export interface WorkflowTool {
  name: "workflow";
  execute(input: WorkflowInput): Promise<WorkflowOutput>;
}

export interface WorkflowToolDeps extends Omit<WorkgroupToolDeps, "parentRunId"> {
  parentRunId: string | null;
}

const WorkflowToolParams = Type.Object(
  {
    action: Type.String({ enum: ["create", "add_workgroup", "finish", "cancel", "status"] }),
    id: Type.Optional(Type.String({ description: "Required except create. Workflow name." })),
    name: Type.Optional(
      Type.String({ description: "Required for create/add_workgroup. Workflow or child workgroup name." }),
    ),
    goal: Type.Optional(Type.String({ description: "Required for create/add_workgroup. Goal to accomplish." })),
    members: Type.Optional(
      Type.Array(
        Type.Object(
          { profile: AgentProfileParams, task: Type.String(), name: SubagentRunNameParam },
          { additionalProperties: false },
        ),
        { minItems: 1, description: "Required for add_workgroup. Workgroup members." },
      ),
    ),
    status: Type.Optional(Type.String({ enum: [...AGENT_RESULT_STATUS_VALUES] })),
    summary: Type.Optional(Type.String()),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const WORKFLOW_CANCELLED_SUMMARY = "Workflow cancelled.";

export function createWorkflowTool(deps: WorkflowToolDeps): WorkflowTool {
  const { orchestra, store, parentRunId, ownerSessionId } = deps;
  return {
    name: "workflow",
    async execute(input) {
      if (input.action === "create") {
        if (
          parentRunId &&
          store
            .listWorkflows()
            .some((workflow) => workflow.coordinatorRunId === parentRunId && workflow.state !== "closed")
        )
          throw new Error("Workflow coordinators cannot create nested workflows.");
        const flowName = createPrefixedName("flow", input.name, "Workflow", WORKFLOW_NAME_MAX_LENGTH);
        const identity = createWorkflowIdentity(flowName, store.listWorkflows());
        const bus = orchestra.createBus({ name: createBusNameFromOwnerName(identity.name) });
        let coordinator: AgentRun | undefined;
        try {
          subscribeWorkflowBusOwner(store, bus, parentRunId);
          const coordinatorName = createPrefixedName("agent", `${identity.name}-coordinator`, "Workflow coordinator");
          coordinator = await spawnSubagent(
            orchestra,
            {
              action: "spawn",
              busId: bus.id,
              name: coordinatorName,
              profile: createWorkflowCoordinatorProfile(),
              task: formatWorkflowCoordinatorTask(identity.name, input.goal),
            },
            parentRunId,
          );
          const workflow = createWorkflowRun({
            identity,
            busId: bus.id,
            ownerSessionId,
            goal: input.goal,
            ownerRunId: parentRunId,
            coordinatorRunId: coordinator.id,
          });
          store.saveWorkflow(workflow);
          await orchestra
            .messageAgent(coordinator.id, formatWorkflowRegisteredMessage(workflow), { busId: undefined })
            .catch(() => undefined);
          return { action: "create", workflow, bus, coordinator, message: formatWorkflowStatus(store, workflow) };
        } catch (error) {
          if (coordinator) await orchestra.closeAgent(coordinator.id, { busId: undefined });
          orchestra.closeBus(bus.id);
          throw error;
        }
      }

      const workflow = findWorkflow(store, input.id);
      if (!workflow) return { action: "not_found", id: input.id, message: `Workflow ${input.id} not found.` };

      if (input.action === "status") {
        requireWorkflowParticipant(store, workflow, parentRunId, "status");
        return {
          action: "status",
          workflow,
          coordinator: store.getRun(workflow.coordinatorRunId),
          message: formatWorkflowStatus(store, workflow),
        };
      }

      if (input.action === "cancel") {
        requireWorkflowSupervisor(store, workflow, parentRunId, "cancel");
        const cancellation = await cancelWorkflow(orchestra, store, workflow);
        return {
          action: "cancel",
          ...cancellation,
          message: formatWorkflowTerminal("Cancelled", cancellation.workflow),
        };
      }

      requireWorkflowCoordinator(workflow, parentRunId, input.action);
      if (workflow.state !== "running") throw new Error(`Workflow ${workflow.name} is ${workflow.state}.`);

      if (input.action === "add_workgroup") {
        const launched = await createAndLaunchWorkgroup({
          ...deps,
          parentRunId: workflow.coordinatorRunId,
          name: input.name,
          goal: input.goal,
          members: input.members,
        });
        const latest = store.getWorkflow(workflow.id) ?? workflow;
        const updated = { ...latest, workgroupIds: [...new Set([...latest.workgroupIds, launched.workgroup.id])] };
        store.saveWorkflow(updated);
        return {
          action: "add_workgroup",
          workflow: updated,
          workgroupId: launched.workgroup.id,
          runIds: launched.runs.map((run) => run.id),
          message: `Added workgroup ${launched.workgroup.name} to workflow ${updated.name}.`,
        };
      }

      const openWorkgroups = workflow.workgroupIds.flatMap((id) => {
        const workgroup = store.getWorkgroup(id);
        return workgroup && workgroup.state !== "closed" ? [workgroup] : [];
      });
      if (openWorkgroups.length > 0)
        throw new Error(
          `Workflow ${workflow.name} still has running workgroups: ${openWorkgroups.map((w) => w.name).join(", ")}.`,
        );
      const closed = await closeWorkflowRun(orchestra, store, workflow, {
        includeCoordinator: false,
        result: input.result,
      });
      return { action: "finish", workflow: closed, message: formatWorkflowTerminal("Finished", closed) };
    },
  };
}

export async function closeWorkflowRun(
  orchestra: OrchestraApi,
  store: AgentStore,
  workflow: WorkflowRun,
  options: { includeCoordinator: boolean; result: AgentResult | null | undefined },
): Promise<WorkflowRun> {
  const latest = store.getWorkflow(workflow.id) ?? workflow;
  if (latest.state === "closed") {
    await cleanupWorkflowResources(orchestra, store, latest, options.includeCoordinator);
    return latest;
  }
  const result = options.result === undefined ? latest.result : options.result;
  const closing: WorkflowRun = { ...latest, state: "closing", result };
  store.saveWorkflow(closing);
  await cleanupWorkflowResources(orchestra, store, closing, options.includeCoordinator);
  const closed: WorkflowRun = { ...(store.getWorkflow(workflow.id) ?? closing), state: "closed", result };
  store.saveWorkflow(closed);
  return closed;
}

function createWorkflowCoordinatorProfile(): AgentProfile {
  return {
    name: "workflow-coordinator",
    systemPrompt:
      "You are the workflow coordinator. Use only workflow add_workgroup to create child workgroups, wait for workflow.workgroup_finished events before deciding the next step, and call workflow finish when the goal is complete.",
    tools: ["workflow", "publish_bus"],
    model: undefined,
  };
}

function formatWorkflowCoordinatorTask(name: string, goal: string): string {
  return [
    `Coordinate workflow ${name}.`,
    "",
    "Wait for the workflow registered instruction before calling workflow tools.",
    "",
    `Goal: ${goal}`,
  ].join("\n");
}

function formatWorkflowRegisteredMessage(workflow: WorkflowRun): string {
  return `Workflow ${workflow.name} is registered. You may now use workflow add_workgroup/status/finish for this workflow.`;
}

async function cleanupWorkflowResources(
  orchestra: OrchestraApi,
  store: AgentStore,
  workflow: WorkflowRun,
  includeCoordinator: boolean,
): Promise<void> {
  await Promise.allSettled(
    workflow.workgroupIds.map(async (id) => {
      const workgroup = store.getWorkgroup(id);
      if (workgroup) await cancelWorkgroup(orchestra, store, workgroup);
    }),
  );
  if (includeCoordinator) await closeAgentRuns(orchestra, [workflow.coordinatorRunId]);
  orchestra.closeBus(workflow.busId);
}

async function cancelWorkflow(orchestra: OrchestraApi, store: AgentStore, workflow: WorkflowRun) {
  const latest = store.getWorkflow(workflow.id) ?? workflow;
  const alreadyClosed = latest.state === "closed";
  const result = latest.result ?? { status: "blocked" as const, summary: WORKFLOW_CANCELLED_SUMMARY };
  return {
    workflow: await closeWorkflowRun(orchestra, store, latest, { includeCoordinator: true, result }),
    alreadyClosed,
  };
}

function subscribeWorkflowBusOwner(store: AgentStore, bus: Bus, parentRunId: string | null): void {
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

function findWorkflow(store: AgentStore, id: string): WorkflowRun | undefined {
  return findEntity(
    id,
    "flow",
    (workflowId) => store.getWorkflow(workflowId),
    () => store.listWorkflows(),
    (workflow) => workflow.state !== "closed",
  );
}

function requireWorkflowCoordinator(workflow: WorkflowRun, parentRunId: string | null, action: string): void {
  if (parentRunId === workflow.coordinatorRunId) return;
  throw new Error(`Only coordinator ${workflow.coordinatorRunId} can ${action} workflow ${workflow.name}.`);
}

function requireWorkflowParticipant(
  store: AgentStore,
  workflow: WorkflowRun,
  parentRunId: string | null,
  action: string,
): void {
  if (parentRunId === null || parentRunId === workflow.ownerRunId || parentRunId === workflow.coordinatorRunId) return;
  requireWorkflowSupervisor(store, workflow, parentRunId, action);
}

function requireWorkflowSupervisor(
  store: AgentStore,
  workflow: WorkflowRun,
  parentRunId: string | null,
  action: string,
): void {
  if (parentRunId === null || parentRunId === workflow.ownerRunId) return;
  if (!workflow.ownerRunId) throw new Error(`Only a supervising parent can ${action} workflow ${workflow.name}.`);
  const owner = store.getRun(workflow.ownerRunId);
  if (owner && owner.parentRunId === parentRunId) return;
  throw new Error(`Only a supervising parent can ${action} workflow ${workflow.name}.`);
}

function formatWorkflowStatus(store: AgentStore, workflow: WorkflowRun): string {
  const coordinator = store.getRun(workflow.coordinatorRunId);
  const workgroups = workflow.workgroupIds.map((id) => store.getWorkgroup(id));
  return [
    `Workflow ${workflow.name}.`,
    "",
    `Goal: ${workflow.goal}`,
    `State: ${workflow.state}`,
    `Result: ${workflow.result ? `${workflow.result.status} — ${workflow.result.summary}` : "none"}`,
    `Coordinator: ${coordinator ? `${coordinator.name}: ${coordinator.state}` : resolveRunName(store, workflow.coordinatorRunId)}`,
    "",
    `Workgroups (${workgroups.filter(Boolean).length}):`,
    ...workgroups.map((workgroup, index) =>
      workgroup
        ? `- ${workgroup.name}: ${workgroup.state}`
        : `- ${resolveWorkgroupName(store, workflow.workgroupIds[index])}: missing`,
    ),
  ].join("\n");
}

function formatWorkflowTerminal(verb: string, workflow: WorkflowRun): string {
  return [
    `${verb} workflow ${workflow.name}.`,
    "",
    `Status: ${workflow.result?.status ?? "unknown"}`,
    `Summary: ${workflow.result?.summary ?? "None."}`,
  ].join("\n");
}

export function defineWorkflowPiTool(resolveTool: (ctx: ExtensionContext) => WorkflowTool) {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: "Coordinate sequential workgroups with a workflow coordinator.",
    promptSnippet: "Create a workflow, add child workgroups, then finish or cancel it.",
    promptGuidelines: [
      "Use workflow create to start a native workflow with a coordinator.",
      "Workflow coordinators must use workflow add_workgroup instead of workgroup/subagent directly.",
      "Only the workflow coordinator calls workflow add_workgroup or workflow finish.",
    ],
    parameters: WorkflowToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModelsForWorkflow(toWorkflowInput(params as RawWorkflowParams), ctx);
      const output = await resolveTool(ctx).execute(input);
      return { content: [{ type: "text", text: output.message }], details: boundWorkflowOutputDetails(output) };
    },
  });
}

function toWorkflowInput(params: RawWorkflowParams): WorkflowInput {
  if (params.action === "create")
    return {
      action: "create",
      name: requireParam(params, "name", "workflow action=create"),
      goal: requireParam(params, "goal", "workflow action=create"),
    };
  if (params.action === "add_workgroup")
    return {
      action: "add_workgroup",
      id: requireParam(params, "id", "workflow action=add_workgroup"),
      name: requireParam(params, "name", "workflow action=add_workgroup"),
      goal: requireParam(params, "goal", "workflow action=add_workgroup"),
      members: requireParam(params, "members", "workflow action=add_workgroup").map(toWorkflowMemberInput),
    };
  if (params.action === "finish") {
    const result: AgentResult = {
      status: requireParam(params, "status", "workflow action=finish"),
      summary: requireParam(params, "summary", "workflow action=finish"),
    };
    if (params.data !== undefined) result.data = params.data;
    return { action: "finish", id: requireParam(params, "id", "workflow action=finish"), result };
  }
  if (params.action === "cancel") return { action: "cancel", id: requireParam(params, "id", "workflow action=cancel") };
  return { action: "status", id: requireParam(params, "id", "workflow action=status") };
}

function toWorkflowMemberInput(member: RawWorkflowMemberParams): WorkgroupMemberInput {
  return {
    profile: toAgentProfile(requireParam(member, "profile", "workflow member")),
    task: requireParam(member, "task", "workflow member"),
    name: requireParam(member, "name", "workflow member"),
  };
}

function withDefaultModelsForWorkflow(input: WorkflowInput, ctx: ExtensionContext): WorkflowInput {
  if (input.action === "create") return input;
  if (input.action !== "add_workgroup") return input;
  return { ...input, members: input.members.map((member) => withDefaultProfileModelInput(member, ctx)) };
}

function boundWorkflowOutputDetails(output: WorkflowOutput): unknown {
  return "workflow" in output ? { ...output, workflow: boundResultData(output.workflow) } : output;
}

type RawWorkflowParams = {
  action: "create" | "add_workgroup" | "finish" | "cancel" | "status";
  id?: string;
  name?: string;
  goal?: string;
  members?: RawWorkflowMemberParams[];
  status?: AgentResultStatus;
  summary?: string;
  data?: unknown;
};

type RawWorkflowMemberParams = { profile?: RawAgentProfileParams; task?: string; name?: string };
