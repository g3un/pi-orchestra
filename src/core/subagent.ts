export const AGENT_RESULT_STATUS_VALUES = ["success", "blocked", "failed"] as const;
export type AgentResultStatus = (typeof AGENT_RESULT_STATUS_VALUES)[number];

export type AgentRunState = "running" | "closed" | AgentResultStatus;

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

interface AgentRunBase {
  id: string;
  name: string;
  profile: AgentProfile;
  task: string;
  busId: string;
  /** Pi session file for this child agent. */
  sessionFile: string;
}

export type AgentRun =
  | (AgentRunBase & {
      state: "running";
      result: null;
    })
  | (AgentRunBase & {
      state: "closed";
      result: AgentResult | null;
    })
  | (AgentRunBase & {
      state: AgentResultStatus;
      result: AgentResult;
    });

export interface AgentRunResult {
  runId: string;
  name: string;
  profile: string;
  state: AgentRun["state"];
  result: AgentRun["result"];
}
