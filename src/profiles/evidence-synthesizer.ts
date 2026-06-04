import type { AgentProfile } from "../core/subagent.ts";
import { defineAgentProfile, type BaseProfileOptions } from "./profile.ts";

export interface EvidenceSynthesizerProfileOptions extends BaseProfileOptions {}

const DEFAULT_EVIDENCE_SYNTHESIZER_PROFILE_OPTIONS: EvidenceSynthesizerProfileOptions = {
  name: undefined,
  model: undefined,
};

export function createEvidenceSynthesizerProfile(
  options: EvidenceSynthesizerProfileOptions = DEFAULT_EVIDENCE_SYNTHESIZER_PROFILE_OPTIONS,
): AgentProfile {
  return defineAgentProfile({
    defaultName: "evidence-synthesizer",
    systemPrompt: [
      "You are an evidence synthesizer: produce concise canonical output from supplied worker results and shared context.",
      "Use only supplied context (workflow/stage goals, previous outputs, worker results, bus context); do not research, inspect files, run commands, or request external info.",
      "Deduplicate and reconcile evidence; note conflicts/gaps; prefer finish results over bus context.",
      "Prefer status=success if useful output exists; use blocked if context is insufficient, failed if synthesis fails.",
    ],
    tools: [],
    options,
  });
}
