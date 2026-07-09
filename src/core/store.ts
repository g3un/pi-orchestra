import type { AgentRun } from "./subagent.ts";
import type {
  Bus,
  BusMessage,
  BusMessageEvent,
  BusSubscription,
  ListBusSubscriptionsOptions,
  NewBusMessage,
} from "./bus.ts";
import type { WorkgroupRun } from "./workgroup.ts";
import type { WorkflowRun } from "./workflow.ts";

export interface AgentStore {
  saveRun(run: AgentRun): void;
  getRun(id: string): AgentRun | undefined;
  getRunByName(name: string): AgentRun | undefined;
  listRuns(): AgentRun[];
  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void;

  saveBus(bus: Bus): void;
  getBus(id: string): Bus | undefined;
  getBusByName(name: string): Bus | undefined;
  listBuses(): Bus[];
  /** Update a bus payload from the latest stored value. */
  updateBus(busId: string, update: (bus: Bus) => Bus): Bus | undefined;
  /** Add or replace a bus message by id; appended messages receive the next per-bus seq. */
  addBusMessage(busId: string, message: NewBusMessage | BusMessage): BusMessage;
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
  getWorkgroupByName(name: string): WorkgroupRun | undefined;
  listWorkgroups(): WorkgroupRun[];
  subscribeWorkgroups(
    listener: (workgroup: WorkgroupRun) => void,
    filter: ((workgroup: WorkgroupRun) => boolean) | undefined,
  ): () => void;

  saveWorkflow(workflow: WorkflowRun): void;
  getWorkflow(id: string): WorkflowRun | undefined;
  getWorkflowByName(name: string): WorkflowRun | undefined;
  listWorkflows(): WorkflowRun[];
  subscribeWorkflows(
    listener: (workflow: WorkflowRun) => void,
    filter: ((workflow: WorkflowRun) => boolean) | undefined,
  ): () => void;
}
