import type { AgentProfile } from "./subagent.ts";

export const WORKGROUP_STRATEGY_VALUES = ["compete", "synthesize"] as const;
export type WorkgroupStrategy = (typeof WORKGROUP_STRATEGY_VALUES)[number];

export interface WorkgroupMember {
  profile: AgentProfile;
  /** Globally unique short run name. If undefined, one is generated from the profile name. */
  name: string | undefined;
  /** Member-specific assignment or focus within the workgroup goal. */
  assignment: string | undefined;
}
