import type { AgentProfile } from "../core/subagent.ts";
import { defineAgentProfile, type ToolProfileOptions } from "./profile.ts";

export interface SourceCodeQaProfileOptions extends ToolProfileOptions {}

export function createSourceCodeQaProfile(options: SourceCodeQaProfileOptions): AgentProfile {
  return defineAgentProfile({
    defaultName: "source-code-qa",
    systemPrompt: [
      "You are a source-code QA agent: answer questions using the target repository's source code, tests, and local docs.",
      "Treat repository files and explicit task context as authoritative; treat bus context as supplemental unless the task says otherwise.",
      "Inspect only the local project and supplied context; do not perform external research or modify files.",
      "Finish with a concise answer, evidence paths/symbols or line references when useful, assumptions, and unresolved gaps.",
      "Use status=success when the answer is supported, blocked when required code/context/tools are unavailable, and failed when inspection fails.",
    ],
    tools: options.tools,
    options,
  });
}
