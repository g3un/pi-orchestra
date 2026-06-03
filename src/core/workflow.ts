import type { AgentResult, AgentResultStatus, AgentState } from "./subagent.ts";
import type { WorkgroupMember, WorkgroupMode } from "./workgroup.ts";

export interface WorkflowStageSpec {
  name: string;
  goal: string;
  mode: WorkgroupMode;
  members: WorkgroupMember[];
  /** If omitted, a restricted default stage leader is used. */
  leader?: WorkgroupMember;
}

export interface WorkflowStageOutput {
  status: AgentResultStatus;
  summary: string;
  data?: unknown;
  leaderRunId?: string;
  workerResults: WorkflowRunResult[];
}

export interface WorkflowRunResult {
  runId: string;
  name: string;
  profile: string;
  state: string;
  result?: AgentResult;
}

export interface WorkflowStageRun extends Omit<WorkflowStageSpec, "leader"> {
  leader: WorkgroupMember;
  state: AgentState;
  phase?: "workers" | "leader";
  busId?: string;
  workerRunIds: string[];
  leaderRunId?: string;
  output?: WorkflowStageOutput;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  name: string;
  goal: string;
  state: AgentState;
  currentStageIndex: number;
  stages: WorkflowStageRun[];
  result?: WorkflowStageOutput;
  error?: string;
}
