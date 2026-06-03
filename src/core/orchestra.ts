import { v7 as uuid7 } from "uuid";
import type { AgentProfile, AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { AgentStore } from "./store.ts";

export interface OrchestraApi {
  createBus(): Bus;
  getBus(id: string): Bus | undefined;
  publishBus(id: string, message: string, from?: string): Promise<PublishedBusMessage>;

  spawnAgent(profile: AgentProfile, task: string, busId: string): Promise<AgentRun>;
  getRun(id: string): AgentRun | undefined;
  resumeAgent(id: string, message: string): Promise<AgentRun>;
  closeAgent(id: string): Promise<AgentRun | undefined>;
  waitRuns(runIds: string[], options?: WaitRunsOptions): Promise<AgentRun[]>;
}

export interface PublishedBusMessage {
  bus: Bus;
  busMessage: BusMessage;
}

export interface WaitRunsOptions {
  timeoutMs?: number;
}

export interface OrchestraDeps {
  runtime: AgentRuntime;
  store: AgentStore;
}

export class Orchestra implements OrchestraApi {
  private readonly runtime: AgentRuntime;
  private readonly store: AgentStore;

  constructor({ runtime, store }: OrchestraDeps) {
    this.runtime = runtime;
    this.store = store;
  }

  createBus(): Bus {
    const bus: Bus = { id: uuid7(), messages: [] };
    this.store.saveBus(bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.store.getBus(id);
  }

  async publishBus(id: string, message: string, from = "main"): Promise<PublishedBusMessage> {
    this.requireBus(id);
    const busMessage = await this.runtime.publishBus(id, message, from);
    return { bus: this.requireBus(id), busMessage };
  }

  async spawnAgent(profile: AgentProfile, task: string, busId: string): Promise<AgentRun> {
    this.requireBus(busId);
    return await this.runtime.spawn(profile, task, busId);
  }

  getRun(id: string): AgentRun | undefined {
    return this.store.getRun(id);
  }

  async resumeAgent(id: string, message: string): Promise<AgentRun> {
    const run = this.requireRun(id);
    if (run.state === "running") throw new Error(`Agent ${id} is already running.`);
    return await this.runtime.resume(id, message);
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    return await this.runtime.close(id);
  }

  waitRuns(runIds: string[], options: WaitRunsOptions = {}): Promise<AgentRun[]> {
    if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
      throw new Error("waitRuns timeoutMs must be non-negative.");
    }

    const initialRuns = runIds.map((id) => {
      const run = this.store.getRun(id);
      if (!run) throw new Error(`Agent ${id} not found.`);
      return run;
    });
    if (initialRuns.every(isTerminalRun)) return Promise.resolve(initialRuns);

    return new Promise((resolve, reject) => {
      const latestRuns = new Map(initialRuns.map((run) => [run.id, run]));
      const unsubscribeAll: Array<() => void> = [];
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        for (const unsubscribe of unsubscribeAll.splice(0)) unsubscribe();
      };

      const resolveIfDone = () => {
        const runs = runIds.map((id) => latestRuns.get(id));
        if (!runs.every((run): run is AgentRun => run !== undefined && isTerminalRun(run))) return;

        settled = true;
        cleanup();
        resolve(runs);
      };

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (settled) return;

          settled = true;
          cleanup();
          const waitingIds = runIds.filter((id) => {
            const run = latestRuns.get(id);
            return !run || !isTerminalRun(run);
          });
          reject(new Error(`Timed out waiting for agent run(s): ${waitingIds.join(", ")}.`));
        }, options.timeoutMs);
      }

      for (const run of initialRuns) {
        if (isTerminalRun(run)) continue;
        unsubscribeAll.push(
          this.store.subscribeRun(run.id, (updatedRun) => {
            if (settled) return;
            latestRuns.set(updatedRun.id, updatedRun);
            resolveIfDone();
          }),
        );
      }

      resolveIfDone();
    });
  }

  private requireBus(id: string): Bus {
    const bus = this.store.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    return bus;
  }

  private requireRun(id: string): AgentRun {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }
}

function isTerminalRun(run: AgentRun): boolean {
  return run.state === "finished" || run.state === "failed" || run.state === "closed";
}
