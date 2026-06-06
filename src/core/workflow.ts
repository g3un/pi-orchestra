import type { AgentResult, AgentRun } from "./subagent.ts";
import type { WorkgroupRun } from "./workgroup.ts";

export interface WorkflowRun {
  id: string;
  name: string;
  goal: string;
  startedAtMs: number;
  state: WorkgroupRun["state"];
  /** Private workflow coordination bus for the flow leader. */
  busId: string;
  /** The top-level flow leader subagent run id. */
  leaderRunId: AgentRun["id"] | null;
  /** Workgroups created by the flow leader in creation order. */
  workgroupIds: string[];
  result: AgentResult | null;
  error?: string;
}
