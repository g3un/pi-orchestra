export const AGENT_RESULT_STATUS_VALUES = ["success", "blocked", "failed"] as const;
export type AgentResultStatus = (typeof AGENT_RESULT_STATUS_VALUES)[number];

export type AgentState = "idle" | "closed" | AgentResultStatus;

export interface AgentProfile {
  name: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
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
