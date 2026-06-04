export const AGENT_RESULT_STATUS_VALUES = ["success", "blocked", "failed"] as const;
export type AgentResultStatus = (typeof AGENT_RESULT_STATUS_VALUES)[number];

export type AgentState = "idle" | "closed" | AgentResultStatus;

export interface AgentProfile {
  name: string;
  systemPrompt: string;
  tools: string[] | undefined;
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
