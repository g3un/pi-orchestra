import type { AgentProfile, AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";

export interface AgentRuntime {
  create(profile: AgentProfile, task: string, bus: Bus): Promise<AgentRun>;
  resume(id: string, message: string): Promise<AgentRun>;
  pushBus(id: string, message: string, from: string): Promise<BusMessage>;
  close(id: string): Promise<void>;
  get(id: string): AgentRun | undefined;
}
