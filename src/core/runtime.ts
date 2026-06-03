import type { AgentProfile, AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";

export interface AgentRuntime {
  spawn(profile: AgentProfile, task: string, bus: Bus): Promise<AgentRun>;
  resume(id: string, message: string): Promise<AgentRun>;
  publishBus(bus: Bus, message: string, from: string): Promise<BusMessage>;
  close(id: string): Promise<void>;
  get(id: string): AgentRun | undefined;
}
