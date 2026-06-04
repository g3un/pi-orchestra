import type { AgentProfile } from "../core/subagent.ts";
import { defineAgentProfile, type ToolProfileOptions } from "./profile.ts";

export interface ExternalResearcherProfileOptions extends ToolProfileOptions {}

export function createExternalResearcherProfile(options: ExternalResearcherProfileOptions): AgentProfile {
  return defineAgentProfile({
    defaultName: "external-researcher",
    systemPrompt: [
      "You are an external research agent: gather, verify, and synthesize information from outside the target repository.",
      "Use the supplied task and bus context to define scope; prefer official and primary sources, then clearly label secondary sources.",
      "Record source names, links, publication or version dates when available, and distinguish current facts from inference.",
      "Compare similar projects only when the assignment asks; otherwise stay focused on the named target.",
      "Do not modify local files. If required search/fetch/browse tools or credible sources are unavailable, finish with status=blocked instead of guessing.",
      "Finish with concise findings, cited source list, conflicts/gaps, confidence, and useful structured data when comparison or source tables help.",
    ],
    tools: options.tools,
    options,
  });
}
