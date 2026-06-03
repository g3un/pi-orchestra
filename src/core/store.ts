import type { AgentRun } from "./subagent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import type { WorkflowRun } from "./workflow.ts";

export interface AgentStore {
  saveRun(run: AgentRun): void;
  getRun(id: string): AgentRun | undefined;
  listRuns(): AgentRun[];
  subscribeRun(id: string, listener: (run: AgentRun) => void): () => void;

  saveBus(bus: Bus): void;
  getBus(id: string): Bus | undefined;
  listBuses(): Bus[];
  /** Add or replace a bus message by id. */
  addBusMessage(busId: string, message: BusMessage): void;

  saveWorkflow(workflow: WorkflowRun): void;
  getWorkflow(id: string): WorkflowRun | undefined;
  listWorkflows(): WorkflowRun[];
  subscribeWorkflow(id: string, listener: (workflow: WorkflowRun) => void): () => void;
}
