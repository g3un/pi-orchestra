import type { AgentProfile } from "../core/subagent.ts";

export interface BaseProfileOptions {
  name: string | undefined;
  model: string | undefined;
}

export interface ToolProfileOptions extends BaseProfileOptions {
  tools: string[];
}

interface DefineAgentProfileOptions {
  defaultName: string;
  systemPrompt: readonly string[];
  tools: readonly string[];
  options: BaseProfileOptions;
}

export function defineAgentProfile({
  defaultName,
  systemPrompt,
  tools,
  options,
}: DefineAgentProfileOptions): AgentProfile {
  return {
    name: options.name ?? defaultName,
    systemPrompt: systemPrompt.join("\n"),
    tools: [...tools],
    model: options.model,
  };
}
