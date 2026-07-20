import type { AgentProfile, AgentResult, AgentRun, AgentRunState } from "../../src/core/subagent.ts";

export interface AgentRunFixtureRecord {
  id: string;
  name: string;
  profile: AgentProfile;
  task: string;
  busId: string;
  ownerSessionId: string | undefined;
  parentRunId: string | null;
  state: AgentRunState;
  result: AgentResult | null;
}

export function buildAgentRun(record: AgentRunFixtureRecord): AgentRun {
  if (!record.ownerSessionId) throw new Error(`Fixture ownerSessionId is required for agent run ${record.id}.`);
  const completeRecord = { ...record, ownerSessionId: record.ownerSessionId };
  if (record.state === "running") return { ...completeRecord, state: "running", result: null };
  if (record.state === "closed") return { ...completeRecord, state: "closed" };
  if (!record.result) throw new Error(`Fixture result is required for ${record.state} agent run ${record.id}.`);
  return { ...completeRecord, state: record.state, result: record.result };
}
