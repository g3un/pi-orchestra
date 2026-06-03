import type { AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";

export interface AgentStore {
  saveRun(run: AgentRun): void;
  getRun(id: string): AgentRun | undefined;
  listRuns(): AgentRun[];
  subscribeRun(id: string, listener: (run: AgentRun) => void): () => void;

  saveBus(bus: Bus): void;
  getBus(id: string): Bus | undefined;
  /** Add or replace a bus message by id. */
  addBusMessage(busId: string, message: BusMessage): void;
}
