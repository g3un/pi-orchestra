import type { AgentResult, AgentResultStatus } from "./subagent.ts";
import type { WorkgroupMember, WorkgroupStrategy } from "./workgroup.ts";

export type WorkflowState = "idle" | "running" | "closed" | AgentResultStatus;

export interface WorkflowStageSpec {
  name: string;
  goal: string;
  strategy: WorkgroupStrategy;
  members: WorkgroupMember[];
  /** Synthesizes the stage's worker output; must be specified explicitly. */
  leader: WorkgroupMember;
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
  result: AgentResult | null;
}

export interface WorkflowStageRun extends WorkflowStageSpec {
  state: WorkflowState;
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
  state: WorkflowState;
  currentStageIndex: number;
  stages: WorkflowStageRun[];
  result?: WorkflowStageOutput;
  error?: string;
}
