import type { AgentRun } from "./subagent.ts";
import type { Bus, BusMessage, BusMessageEvent, BusSubscription, ListBusSubscriptionsOptions } from "./bus.ts";
import type { WorkflowRun } from "./workflow.ts";
import type { WorkgroupRun } from "./workgroup.ts";

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
  subscribeBusMessages(
    listener: (event: BusMessageEvent) => void,
    filter: ((event: BusMessageEvent) => boolean) | undefined,
  ): () => void;

  saveBusSubscription(subscription: BusSubscription): void;
  getBusSubscription(id: string): BusSubscription | undefined;
  listBusSubscriptions(options: ListBusSubscriptionsOptions): BusSubscription[];
  deleteBusSubscription(id: string): void;

  saveWorkgroup(workgroup: WorkgroupRun): void;
  getWorkgroup(id: string): WorkgroupRun | undefined;
  listWorkgroups(): WorkgroupRun[];
  subscribeWorkgroups(
    listener: (workgroup: WorkgroupRun) => void,
    filter: ((workgroup: WorkgroupRun) => boolean) | undefined,
  ): () => void;

  saveWorkflow(workflow: WorkflowRun): void;
  getWorkflow(id: string): WorkflowRun | undefined;
  listWorkflows(): WorkflowRun[];
  subscribeWorkflows(
    listener: (workflow: WorkflowRun) => void,
    filter: ((workflow: WorkflowRun) => boolean) | undefined,
  ): () => void;
}
