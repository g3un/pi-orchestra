export type AgentState = "idle" | "running" | "finished" | "failed" | "closed";

export type AgentResultStatus = "success" | "blocked" | "failed";

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
