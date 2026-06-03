import type { AgentProfile } from "./subagent.ts";

export const WORKGROUP_STRATEGY_VALUES = ["compete", "synthesize"] as const;
export type WorkgroupStrategy = (typeof WORKGROUP_STRATEGY_VALUES)[number];

export interface WorkgroupMember {
  profile: AgentProfile;
  /** Optional globally unique short run name. If omitted, one is generated from the profile name. */
  name?: string;
  /** Member-specific assignment or focus within the workgroup goal. */
  assignment?: string;
}
