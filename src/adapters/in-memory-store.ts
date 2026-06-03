import type { AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";

export class InMemoryAgentStore implements AgentStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly buses = new Map<string, Bus>();
  private readonly workflows = new Map<string, WorkflowRun>();
  private readonly runListeners = new Map<string, Set<(run: AgentRun) => void>>();
  private readonly workflowListeners = new Map<string, Set<(workflow: WorkflowRun) => void>>();

  saveRun(run: AgentRun): void {
    this.runs.set(run.id, run);
    for (const listener of this.runListeners.get(run.id) ?? []) listener(run);
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  subscribeRun(id: string, listener: (run: AgentRun) => void): () => void {
    const listeners = this.runListeners.get(id) ?? new Set<(run: AgentRun) => void>();
    listeners.add(listener);
    this.runListeners.set(id, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.runListeners.delete(id);
    };
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
    for (const listener of this.workflowListeners.get(workflow.id) ?? []) listener(workflow);
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    return this.workflows.get(id);
  }

  listWorkflows(): WorkflowRun[] {
    return [...this.workflows.values()];
  }

  subscribeWorkflow(id: string, listener: (workflow: WorkflowRun) => void): () => void {
    const listeners = this.workflowListeners.get(id) ?? new Set<(workflow: WorkflowRun) => void>();
    listeners.add(listener);
    this.workflowListeners.set(id, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.workflowListeners.delete(id);
    };
  }
}
