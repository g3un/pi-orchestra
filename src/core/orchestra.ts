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
  listRuns(options?: ListRunsOptions): AgentRun[];
  resumeAgent(id: string, message: string): Promise<AgentRun>;
  closeAgent(id: string): Promise<AgentRun | undefined>;
  waitBus(busId: string, options?: WaitBusOptions): Promise<WaitBusResult>;
}

export interface PublishedBusMessage {
  bus: Bus;
  busMessage: BusMessage;
}

export interface WaitBusResult {
  bus: Bus;
  runs: AgentRun[];
  runResults: WaitBusRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
}

export interface WaitBusRunResult {
  runId: string;
  profile: string;
  state: AgentRun["state"];
  result?: AgentRun["result"];
}

export interface WaitBusOptions {
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
}

export interface ListRunsOptions {
  busId?: string;
}

export interface OrchestraDeps {
  runtime: AgentRuntime;
  store: AgentStore;
}

const DEFAULT_WAIT_BUS_TIMEOUT_MS = 10 * 60 * 1000;

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

  listRuns(options: ListRunsOptions = {}): AgentRun[] {
    const runs = this.store.listRuns();
    if (!options.busId) return runs;
    return runs.filter((run) => run.busId === options.busId);
  }

  async resumeAgent(id: string, message: string): Promise<AgentRun> {
    const run = this.requireRun(id);
    if (run.state === "running") throw new Error(`Agent ${id} is already running.`);
    return await this.runtime.resume(id, message);
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    return await this.runtime.close(id);
  }

  waitBus(busId: string, options: WaitBusOptions = {}): Promise<WaitBusResult> {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_WAIT_BUS_TIMEOUT_MS : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("waitBus timeoutMs must be positive, or null to wait indefinitely.");
    }

    const bus = this.requireBus(busId);
    const initialRuns = this.listRuns({ busId });
    if (initialRuns.every(isTerminalRun)) {
      return Promise.resolve(buildWaitBusResult(bus, initialRuns, false));
    }

    return new Promise((resolve) => {
      const latestRuns = new Map(initialRuns.map((run) => [run.id, run]));
      const unsubscribeAll: Array<() => void> = [];
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        for (const unsubscribe of unsubscribeAll.splice(0)) unsubscribe();
      };

      const getLatestRuns = () => initialRuns.map((run) => latestRuns.get(run.id) ?? run);
      const getPendingRunIds = (runs: AgentRun[]) => runs.filter((run) => !isTerminalRun(run)).map((run) => run.id);

      const resolveIfDone = () => {
        const runs = getLatestRuns();
        if (getPendingRunIds(runs).length > 0) return;

        settled = true;
        cleanup();
        resolve(buildWaitBusResult(bus, runs, false));
      };

      if (timeoutMs !== null) {
        timeout = setTimeout(() => {
          if (settled) return;

          settled = true;
          cleanup();
          resolve(buildWaitBusResult(bus, getLatestRuns(), true));
        }, timeoutMs);
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

function buildWaitBusResult(bus: Bus, runs: AgentRun[], timedOut: boolean): WaitBusResult {
  return {
    bus,
    runs,
    runResults: runs.map(toWaitBusRunResult),
    timedOut,
    pendingRunIds: runs.filter((run) => !isTerminalRun(run)).map((run) => run.id),
  };
}

function toWaitBusRunResult(run: AgentRun): WaitBusRunResult {
  const runResult: WaitBusRunResult = {
    runId: run.id,
    profile: run.profile,
    state: run.state,
  };
  if (run.result !== undefined) runResult.result = run.result;
  return runResult;
}

function isTerminalRun(run: AgentRun): boolean {
  return run.state === "finished" || run.state === "failed" || run.state === "closed";
}
