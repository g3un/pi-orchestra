import { createEntityIdentity, type NamedEntity } from "../utils.ts";
import type { AgentResult, AgentRun } from "./subagent.ts";

export type WorkflowState = "running" | "closing" | "closed";

export interface WorkflowRun {
  id: string;
  name: string;
  busId: string;
  ownerSessionId: string;
  goal: string;
  ownerRunId: AgentRun["id"] | null;
  coordinatorRunId: AgentRun["id"];
  workgroupIds: string[];
  state: WorkflowState;
  result: AgentResult | null;
  createdAtMs: number;
}

// Stored name includes flow-, and workflow create also generates
// agent-{workflow.name}-coordinator. Keep the workflow name short enough for
// the existing 64-char agent name limit.
export const WORKFLOW_NAME_MAX_LENGTH = 46;

export interface CreateWorkflowRunOptions {
  identity: NamedEntity;
  busId: string;
  ownerSessionId: string;
  goal: string;
  ownerRunId: AgentRun["id"] | null;
  coordinatorRunId: AgentRun["id"];
}

export function createWorkflowIdentity(
  name: string,
  existingWorkflows: WorkflowRun[],
  entityLabel = "Workflow",
): NamedEntity {
  return createEntityIdentity(
    name,
    "workflow",
    existingWorkflows.filter((workflow) => workflow.state !== "closed"),
    entityLabel,
    WORKFLOW_NAME_MAX_LENGTH,
    existingWorkflows,
  );
}

export function createWorkflowRun(options: CreateWorkflowRunOptions): WorkflowRun {
  return {
    ...options.identity,
    busId: options.busId,
    ownerSessionId: options.ownerSessionId,
    goal: options.goal,
    ownerRunId: options.ownerRunId,
    coordinatorRunId: options.coordinatorRunId,
    workgroupIds: [],
    state: "running",
    result: null,
    createdAtMs: Date.now(),
  };
}

export function findRunningCoordinatedWorkflow(
  workflows: WorkflowRun[],
  coordinatorRunId: AgentRun["id"],
): WorkflowRun | undefined {
  return workflows.find((workflow) => workflow.coordinatorRunId === coordinatorRunId && workflow.state === "running");
}
