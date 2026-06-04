import type { AgentRun } from "./subagent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import type { WorkflowRun } from "./workflow.ts";

export interface AgentStore {
  saveRun(run: AgentRun): void;
  getRun(id: string): AgentRun | undefined;
  listRuns(): AgentRun[];
  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void;

  saveBus(bus: Bus): void;
  getBus(id: string): Bus | undefined;
  listBuses(): Bus[];
  /** Add or replace a bus message by id. */
  addBusMessage(busId: string, message: BusMessage): void;

  saveWorkflow(workflow: WorkflowRun): void;
  getWorkflow(id: string): WorkflowRun | undefined;
  listWorkflows(): WorkflowRun[];
  subscribeWorkflows(
    listener: (workflow: WorkflowRun) => void,
    filter: ((workflow: WorkflowRun) => boolean) | undefined,
  ): () => void;
}
