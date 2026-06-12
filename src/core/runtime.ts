import type { AgentProfile, AgentRun } from "./subagent.ts";
import type { BusMessage } from "./bus.ts";

export interface SpawnAgentRuntimeOptions {
  id: string;
  name: string;
  parentRunId?: string | null;
}

export interface AgentRuntime {
  spawn(profile: AgentProfile, task: string, busId: string, options: SpawnAgentRuntimeOptions): Promise<AgentRun>;
  message(id: string, message: string): Promise<AgentRun>;
  publishBus(busId: string, message: string, from: string): Promise<BusMessage>;
  close(id: string): Promise<AgentRun | undefined>;
}
