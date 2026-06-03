import type { AgentProfile } from "./subagent.ts";

export const WORKGROUP_MODE_VALUES = ["compete", "synthesize"] as const;
export type WorkgroupMode = (typeof WORKGROUP_MODE_VALUES)[number];

export interface WorkgroupMember {
  profile: AgentProfile;
  /** Optional globally unique short run name. If omitted, one is generated from the profile name. */
  name?: string;
  /** Member-specific assignment or focus within the workgroup goal. */
  assignment?: string;
}
