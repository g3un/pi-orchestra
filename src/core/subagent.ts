export const AGENT_RESULT_STATUS_VALUES = ["success", "blocked", "failed"] as const;
export type AgentResultStatus = (typeof AGENT_RESULT_STATUS_VALUES)[number];

// AgentRun uses running/idle/closed for lifecycle; success/blocked/failed are retained in AgentState
// because workflows and older run records use the same shared state vocabulary.
export type AgentState = "idle" | "running" | "closed" | AgentResultStatus;

export interface AgentProfile {
  name: string;
  systemPrompt: string;
  tools: string[];
  model: string | undefined;
}

export interface AgentResult {
  status: AgentResultStatus;
  summary: string;
  data?: unknown;
}

export interface AgentRun {
  id: string;
  name: string;
  profile: string;
  task: string;
  busId: string;
  state: AgentState;
  result?: AgentResult;
}

export interface AgentRunResult {
  runId: string;
  name: string;
  profile: string;
  state: AgentRun["state"];
  result?: AgentRun["result"];
}
