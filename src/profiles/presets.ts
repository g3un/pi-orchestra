import type { AgentProfile } from "../core/subagent.ts";
import { createCodeReviewerProfile } from "./code-reviewer.ts";
import { createExternalResearcherProfile } from "./external-researcher.ts";
import { createSourceCodeQaProfile } from "./source-code-qa.ts";
import type { ToolProfileOptions } from "./profile.ts";

type AgentProfilePresetFactory = (options: ToolProfileOptions) => AgentProfile;

export const AGENT_PROFILE_PRESETS = {
  "source-code-qa": createSourceCodeQaProfile,
  "external-researcher": createExternalResearcherProfile,
  "code-reviewer": createCodeReviewerProfile,
} satisfies Record<string, AgentProfilePresetFactory>;

export type AgentProfilePreset = keyof typeof AGENT_PROFILE_PRESETS;

export const AGENT_PROFILE_PRESET_VALUES = Object.keys(AGENT_PROFILE_PRESETS) as AgentProfilePreset[];

export interface AgentProfilePresetOptions extends ToolProfileOptions {
  preset: AgentProfilePreset;
}

export function createAgentProfileFromPreset(options: AgentProfilePresetOptions): AgentProfile {
  const createProfile = (AGENT_PROFILE_PRESETS as Record<string, AgentProfilePresetFactory | undefined>)[
    options.preset
  ];
  if (!createProfile) {
    throw new Error(
      `Unknown profile preset "${String(options.preset)}". Available presets: ${AGENT_PROFILE_PRESET_VALUES.join(", ")}.`,
    );
  }

  return createProfile(options);
}
