import type { AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { notifySubscribers, subscribeStore, type StoreSubscription } from "./store-subscriptions.ts";

/**
 * In-memory {@link AgentStore} used as a lightweight fixture in tests.
 * Production code persists state through {@link SqliteAgentStore} instead.
 */
export class InMemoryAgentStore implements AgentStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly buses = new Map<string, Bus>();
  private readonly workflows = new Map<string, WorkflowRun>();
  private readonly runSubscriptions = new Set<StoreSubscription<AgentRun>>();
  private readonly workflowSubscriptions = new Set<StoreSubscription<WorkflowRun>>();

  saveRun(run: AgentRun): void {
    this.runs.set(run.id, run);
    notifySubscribers(this.runSubscriptions, run);
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void {
    return subscribeStore(this.runSubscriptions, listener, filter);
  }

  saveBus(bus: Bus): void {
    this.buses.set(bus.id, bus);
  }

  getBus(id: string): Bus | undefined {
    return this.buses.get(id);
  }

  listBuses(): Bus[] {
    return [...this.buses.values()];
  }

  addBusMessage(busId: string, message: BusMessage): void {
    const bus = this.buses.get(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);

    const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
    if (existingIndex >= 0) {
      bus.messages[existingIndex] = message;
      return;
    }

    bus.messages.push(message);
  }

  saveWorkflow(workflow: WorkflowRun): void {
    this.workflows.set(workflow.id, workflow);
    notifySubscribers(this.workflowSubscriptions, workflow);
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    return this.workflows.get(id);
  }

  listWorkflows(): WorkflowRun[] {
    return [...this.workflows.values()];
  }

  subscribeWorkflows(
    listener: (workflow: WorkflowRun) => void,
    filter: ((workflow: WorkflowRun) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.workflowSubscriptions, listener, filter);
  }
}
