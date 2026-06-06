import { createEntityIdentity } from "../utils.ts";
import type { AgentResult, AgentRun } from "./subagent.ts";

export type WorkgroupState = "running" | "closing" | "closed";

export interface WorkgroupRun {
  id: string;
  name: string;
  busId: string;
  goal: string;
  /** The leader subagent run id, or null when main owns the workgroup. */
  leaderRunId: AgentRun["id"] | null;
  memberRunIds: Array<AgentRun["id"]>;
  state: WorkgroupState;
  result: AgentResult | null;
  createdAtMs: number;
}

export interface CreateWorkgroupRunOptions {
  name: string | undefined;
  autoNameSeed: string;
  existingWorkgroups: WorkgroupRun[];
  busId: string;
  goal: string;
  leaderRunId: AgentRun["id"] | null;
}

export function createWorkgroupRun(options: CreateWorkgroupRunOptions): WorkgroupRun {
  const identity = createEntityIdentity(options.name, options.autoNameSeed, options.existingWorkgroups, "Workgroup");
  return {
    ...identity,
    busId: options.busId,
    goal: options.goal,
    leaderRunId: options.leaderRunId,
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: Date.now(),
  };
}
