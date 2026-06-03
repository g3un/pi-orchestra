import type { AgentProfile, AgentRun } from "./agent.ts";
import type { BusMessage } from "./bus.ts";

export interface SpawnAgentRuntimeOptions {
  id: string;
  name: string;
}

export interface AgentRuntime {
  spawn(profile: AgentProfile, task: string, busId: string, options: SpawnAgentRuntimeOptions): Promise<AgentRun>;
  resume(id: string, message: string): Promise<AgentRun>;
  publishBus(busId: string, message: string, from: string): Promise<BusMessage>;
  close(id: string): Promise<AgentRun | undefined>;
}
