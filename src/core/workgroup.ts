import { createEntityIdentity, type NamedEntity } from "../utils.ts";
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

export const WORKGROUP_NAME_MAX_LENGTH = 60;

export interface CreateWorkgroupRunOptions {
  identity: NamedEntity;
  busId: string;
  goal: string;
  leaderRunId: AgentRun["id"] | null;
}

export function createWorkgroupIdentity(
  name: string,
  existingWorkgroups: WorkgroupRun[],
  entityLabel = "Workgroup",
): NamedEntity {
  return createEntityIdentity(
    name,
    "workgroup",
    existingWorkgroups.filter((workgroup) => workgroup.state !== "closed"),
    entityLabel,
    WORKGROUP_NAME_MAX_LENGTH,
    existingWorkgroups,
  );
}

export function createWorkgroupRun(options: CreateWorkgroupRunOptions): WorkgroupRun {
  return {
    ...options.identity,
    busId: options.busId,
    goal: options.goal,
    leaderRunId: options.leaderRunId,
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: Date.now(),
  };
}
