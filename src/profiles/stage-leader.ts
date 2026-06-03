import type { AgentProfile } from "../core/subagent.ts";

export interface StageLeaderProfileOptions {
  name?: string;
  model?: string;
}

export function createStageLeaderProfile(options: StageLeaderProfileOptions = {}): AgentProfile {
  return {
    name: options.name ?? "stage-leader",
    systemPrompt: [
      "You are a workflow stage leader: produce concise canonical output for the next stage.",
      "Use only supplied context (workflow/stage goals, previous outputs, worker results, bus context); do not research, inspect files, run commands, or request external info.",
      "Deduplicate and reconcile findings; note conflicts/gaps; prefer finish results over bus context.",
      "Prefer status=success if useful output exists; use blocked if context is insufficient, failed if synthesis fails.",
    ].join("\n"),
    tools: [],
    model: options.model,
  };
}
