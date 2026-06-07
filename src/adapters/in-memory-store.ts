import type { AgentRun } from "../core/subagent.ts";
import {
  matchesBusSubscription,
  type Bus,
  type BusMessage,
  type BusMessageEvent,
  type BusSubscription,
  type ListBusSubscriptionsOptions,
} from "../core/bus.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { notifySubscribers, subscribeStore, type StoreSubscription } from "./store-subscriptions.ts";

/**
 * In-memory {@link AgentStore} used as a lightweight fixture in tests.
 * Production code persists state through {@link SqliteAgentStore} instead.
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
    saveNamedEntity(this.runs, this.runIdByName, savedRun);
    notifySubscribers(this.runSubscriptions, snapshot(savedRun));
  }

  getRun(id: string): AgentRun | undefined {
    return snapshotOrUndefined(this.runs.get(id));
  }

  getRunByName(name: string): AgentRun | undefined {
    return snapshotOrUndefined(getNamedEntity(this.runs, this.runIdByName, name));
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()].map(snapshot);
  }

  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void {
    return subscribeStore(this.runSubscriptions, listener, filter);
  }

  saveBus(bus: Bus): void {
    saveNamedEntity(this.buses, this.busIdByName, snapshot(bus));
  }

  getBus(id: string): Bus | undefined {
    return snapshotOrUndefined(this.buses.get(id));
  }

  getBusByName(name: string): Bus | undefined {
    return snapshotOrUndefined(getNamedEntity(this.buses, this.busIdByName, name));
  }

  listBuses(): Bus[] {
    return [...this.buses.values()].map(snapshot);
  }

  addBusMessage(busId: string, message: BusMessage): void {
    const bus = this.buses.get(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);

    const savedMessage = snapshot(message);
    const existingIndex = bus.messages.findIndex((current) => current.id === savedMessage.id);
    const messages = [...bus.messages];
    if (existingIndex >= 0) {
      messages[existingIndex] = savedMessage;
      this.buses.set(bus.id, { ...bus, messages });
      return;
    }

    messages.push(savedMessage);
    this.buses.set(bus.id, { ...bus, messages });
    notifySubscribers(this.busMessageSubscriptions, { busId, message: snapshot(savedMessage) });
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
    saveNamedEntity(this.workgroups, this.workgroupIdByName, savedWorkgroup);
    notifySubscribers(this.workgroupSubscriptions, snapshot(savedWorkgroup));
  }

  getWorkgroup(id: string): WorkgroupRun | undefined {
    return snapshotOrUndefined(this.workgroups.get(id));
  }

  getWorkgroupByName(name: string): WorkgroupRun | undefined {
    return snapshotOrUndefined(getNamedEntity(this.workgroups, this.workgroupIdByName, name));
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
    saveNamedEntity(this.workflows, this.workflowIdByName, savedWorkflow);
    notifySubscribers(this.workflowSubscriptions, snapshot(savedWorkflow));
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    return snapshotOrUndefined(this.workflows.get(id));
  }

  getWorkflowByName(name: string): WorkflowRun | undefined {
    return snapshotOrUndefined(getNamedEntity(this.workflows, this.workflowIdByName, name));
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
}

interface NamedEntity {
  id: string;
  name: string;
}

function saveNamedEntity<T extends NamedEntity>(
  entities: Map<string, T>,
  idByName: Map<string, string>,
  entity: T,
): void {
  const previous = entities.get(entity.id);
  if (previous && idByName.get(previous.name) === entity.id) idByName.delete(previous.name);
  entities.set(entity.id, entity);
  const existingIdForName = idByName.get(entity.name);
  if (!existingIdForName || existingIdForName === entity.id) idByName.set(entity.name, entity.id);
}

function getNamedEntity<T extends NamedEntity>(
  entities: Map<string, T>,
  idByName: Map<string, string>,
  name: string,
): T | undefined {
  const id = idByName.get(name);
  const indexed = id ? entities.get(id) : undefined;
  if (indexed?.name === name) return indexed;
  return [...entities.values()].find((entity) => entity.name === name);
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function snapshotOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : snapshot(value);
}
