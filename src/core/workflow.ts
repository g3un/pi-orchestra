import type { AgentResult, AgentResultStatus, AgentRun } from "./subagent.ts";

export type WorkflowState = "idle" | "running" | "closed" | AgentResultStatus;

export interface WorkflowStageAgentSpec {
  profile: AgentRun["profile"];
  /** Globally unique short run name. */
  name: AgentRun["name"];
}

export interface WorkflowStageSpec {
  name: string;
  goal: string;
  /** Leads the stage and creates workgroup members as needed. */
  leader: WorkflowStageAgentSpec;
}

export interface WorkflowStageOutput {
  status: AgentResultStatus;
  summary: string;
  data?: unknown;
  leaderRunId?: string;
  memberResults: WorkflowRunResult[];
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
  phase?: "leader";
  /** Milliseconds since epoch when this stage started running. */
  startedAtMs: number;
  busId?: string;
  workgroupId?: string;
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
