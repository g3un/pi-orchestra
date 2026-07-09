import type { AgentRun } from "../core/subagent.ts";
import {
  matchesBusSubscription,
  type Bus,
  type BusMessage,
  type NewBusMessage,
  type BusMessageEvent,
  type BusSubscription,
  type ListBusSubscriptionsOptions,
} from "../core/bus.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import type { WorkflowRun } from "../core/workflow.ts";

/**
 * In-memory {@link AgentStore}. This store owns live orchestration state for
 * the current Pi process. A separate append-only SQLite debug log mirrors state
 * transitions for debugging and backup.
 */
export class InMemoryAgentStore implements AgentStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly runIdByName = new Map<string, string>();
  private readonly buses = new Map<string, Bus>();
  private readonly busIdByName = new Map<string, string>();
  private readonly busSubscriptionsById = new Map<string, BusSubscription>();
  private readonly workgroups = new Map<string, WorkgroupRun>();
  private readonly workgroupIdByName = new Map<string, string>();
  private readonly workflows = new Map<string, WorkflowRun>();
  private readonly workflowIdByName = new Map<string, string>();
  private readonly runSubscriptions = new Set<StoreSubscription<AgentRun>>();
  private readonly busMessageSubscriptions = new Set<StoreSubscription<BusMessageEvent>>();
  private readonly workgroupSubscriptions = new Set<StoreSubscription<WorkgroupRun>>();
  private readonly workflowSubscriptions = new Set<StoreSubscription<WorkflowRun>>();

  saveRun(run: AgentRun): void {
    const savedRun = snapshot(run);
    saveNamedEntity(this.runs, this.runIdByName, savedRun, {
      label: "Agent",
      isNameActive: (current) => current.state !== "closed",
    });
    notifySubscribers(this.runSubscriptions, snapshot(savedRun));
  }

  getRun(id: string): AgentRun | undefined {
    return snapshotOrUndefined(this.runs.get(id));
  }

  getRunByName(name: string): AgentRun | undefined {
    return snapshotOrUndefined(getNamedEntity(this.runs, this.runIdByName, name, (run) => run.state !== "closed"));
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()].map(snapshot);
  }

  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void {
    return subscribeStore(this.runSubscriptions, listener, filter);
  }

  saveBus(bus: Bus): void {
    saveNamedEntity(this.buses, this.busIdByName, snapshot(bus), {
      label: "Bus",
      isNameActive: (current) => current.state === "open",
    });
  }

  getBus(id: string): Bus | undefined {
    return snapshotOrUndefined(this.buses.get(id));
  }

  getBusByName(name: string): Bus | undefined {
    return snapshotOrUndefined(getNamedEntity(this.buses, this.busIdByName, name, (bus) => bus.state === "open"));
  }

  listBuses(): Bus[] {
    return [...this.buses.values()].map(snapshot);
  }

  updateBus(busId: string, update: (bus: Bus) => Bus): Bus | undefined {
    const bus = this.buses.get(busId);
    if (!bus) return undefined;

    const updatedBus = snapshot(update(snapshot(bus)));
    this.saveBus(updatedBus);
    return snapshot(updatedBus);
  }

  addBusMessage(busId: string, message: NewBusMessage | BusMessage): BusMessage {
    let savedMessage: BusMessage | undefined;
    let appended = false;
    const updatedBus = this.updateBus(busId, (bus) => {
      if (bus.state === "closed") throw new Error(`Bus ${bus.name} is closed.`);

      const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
      const messages = [...bus.messages];
      if (existingIndex >= 0) {
        savedMessage = { ...message, seq: messages[existingIndex]!.seq };
        messages[existingIndex] = snapshot(savedMessage);
        return { ...bus, messages };
      }

      savedMessage = snapshot({ ...message, seq: bus.nextMessageSeq });
      appended = true;
      return { ...bus, nextMessageSeq: bus.nextMessageSeq + 1, messages: [...messages, savedMessage] };
    });
    if (!updatedBus) throw new Error(`Bus ${busId} not found.`);
    if (!savedMessage) throw new Error(`Bus ${busId} message was not saved.`);
    if (appended) notifySubscribers(this.busMessageSubscriptions, { busId, message: snapshot(savedMessage) });
    return snapshot(savedMessage);
  }

  subscribeBusMessages(
    listener: (event: BusMessageEvent) => void,
    filter: ((event: BusMessageEvent) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.busMessageSubscriptions, listener, filter);
  }

  saveBusSubscription(subscription: BusSubscription): void {
    this.busSubscriptionsById.set(subscription.id, snapshot(subscription));
  }

  getBusSubscription(id: string): BusSubscription | undefined {
    return snapshotOrUndefined(this.busSubscriptionsById.get(id));
  }

  listBusSubscriptions(options: ListBusSubscriptionsOptions): BusSubscription[] {
    return [...this.busSubscriptionsById.values()]
      .filter((subscription) => matchesBusSubscription(subscription, options))
      .map(snapshot);
  }

  deleteBusSubscription(id: string): void {
    this.busSubscriptionsById.delete(id);
  }

  saveWorkgroup(workgroup: WorkgroupRun): void {
    const savedWorkgroup = snapshot(workgroup);
    saveNamedEntity(this.workgroups, this.workgroupIdByName, savedWorkgroup, {
      label: "Workgroup",
      isNameActive: (current) => current.state !== "closed",
    });
    notifySubscribers(this.workgroupSubscriptions, snapshot(savedWorkgroup));
  }

  getWorkgroup(id: string): WorkgroupRun | undefined {
    return snapshotOrUndefined(this.workgroups.get(id));
  }

  getWorkgroupByName(name: string): WorkgroupRun | undefined {
    return snapshotOrUndefined(
      getNamedEntity(this.workgroups, this.workgroupIdByName, name, (workgroup) => workgroup.state !== "closed"),
    );
  }

  listWorkgroups(): WorkgroupRun[] {
    return [...this.workgroups.values()].map(snapshot);
  }

  subscribeWorkgroups(
    listener: (workgroup: WorkgroupRun) => void,
    filter: ((workgroup: WorkgroupRun) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.workgroupSubscriptions, listener, filter);
  }

  saveWorkflow(workflow: WorkflowRun): void {
    const savedWorkflow = snapshot(workflow);
    saveNamedEntity(this.workflows, this.workflowIdByName, savedWorkflow, {
      label: "Workflow",
      isNameActive: (current) => current.state !== "closed",
    });
    notifySubscribers(this.workflowSubscriptions, snapshot(savedWorkflow));
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    return snapshotOrUndefined(this.workflows.get(id));
  }

  getWorkflowByName(name: string): WorkflowRun | undefined {
    return snapshotOrUndefined(
      getNamedEntity(this.workflows, this.workflowIdByName, name, (workflow) => workflow.state !== "closed"),
    );
  }

  listWorkflows(): WorkflowRun[] {
    return [...this.workflows.values()].map(snapshot);
  }

  subscribeWorkflows(
    listener: (workflow: WorkflowRun) => void,
    filter: ((workflow: WorkflowRun) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.workflowSubscriptions, listener, filter);
  }

  dispose(): void {
    // The process owns this in-memory state; there is nothing to release.
  }
}

interface StoreSubscription<T> {
  listener(value: T): void;
  filter: ((value: T) => boolean) | undefined;
}

interface NamedEntity {
  id: string;
  name: string;
}

interface NamedEntitySaveOptions<T> {
  label: string;
  isNameActive(entity: T): boolean;
}

function saveNamedEntity<T extends NamedEntity>(
  entities: Map<string, T>,
  idByName: Map<string, string>,
  entity: T,
  options: NamedEntitySaveOptions<T>,
): void {
  const previous = entities.get(entity.id);
  if (previous && idByName.get(previous.name) === entity.id) idByName.delete(previous.name);

  if (options.isNameActive(entity)) {
    const conflict = [...entities.values()].find(
      (current) => current.id !== entity.id && current.name === entity.name && options.isNameActive(current),
    );
    if (conflict) throw new Error(`${options.label} name "${entity.name}" is already in use.`);
    idByName.set(entity.name, entity.id);
  }

  entities.set(entity.id, entity);
}

function getNamedEntity<T extends NamedEntity>(
  entities: Map<string, T>,
  idByName: Map<string, string>,
  name: string,
  isNameActive: (entity: T) => boolean,
): T | undefined {
  const id = idByName.get(name);
  const indexed = id ? entities.get(id) : undefined;
  if (indexed?.name === name && isNameActive(indexed)) return indexed;
  const values = [...entities.values()];
  for (let index = values.length - 1; index >= 0; index--) {
    const entity = values[index];
    if (entity.name === name) return entity;
  }
  return undefined;
}

function subscribeStore<T>(
  subscriptions: Set<StoreSubscription<T>>,
  listener: (value: T) => void,
  filter: ((value: T) => boolean) | undefined,
): () => void {
  const subscription = { listener, filter };
  subscriptions.add(subscription);
  return () => subscriptions.delete(subscription);
}

function notifySubscribers<T>(subscriptions: Set<StoreSubscription<T>>, value: T): void {
  for (const subscription of subscriptions) {
    if (!subscription.filter || subscription.filter(value)) subscription.listener(value);
  }
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function snapshotOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : snapshot(value);
}
