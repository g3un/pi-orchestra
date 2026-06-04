import type { AgentResult, AgentResultStatus, AgentState } from "./subagent.ts";
import type { WorkgroupMember, WorkgroupStrategy } from "./workgroup.ts";

export interface WorkflowStageSpec {
  name: string;
  goal: string;
  strategy: WorkgroupStrategy;
  members: WorkgroupMember[];
  /** If undefined, a restricted default stage leader is used. */
  leader: WorkgroupMember | undefined;
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
  /** Milliseconds since epoch when this stage started running. */
  startedAtMs: number;
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
  startedAtMs: number;
  state: AgentState;
  currentStageIndex: number;
  stages: WorkflowStageRun[];
  result?: WorkflowStageOutput;
  error?: string;
}
