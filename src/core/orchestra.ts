import type { AgentProfile, AgentRun } from "./subagent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import type { AgentRuntime } from "./runtime.ts";
import { createEntityIdentity, isTerminalAgentState, resolveWaitTimeoutMs, toWaitRunResult } from "../utils.ts";
import type { AgentStore } from "./store.ts";

export interface OrchestraApi {
  createBus(options?: CreateBusOptions): Bus;
  getBus(id: string): Bus | undefined;
  publishBus(id: string, message: string, from?: string): Promise<PublishedBusMessage>;

  spawnAgent(profile: AgentProfile, task: string, busId: string, options?: SpawnAgentOptions): Promise<AgentRun>;
  getRun(id: string, options?: RunLookupOptions): AgentRun | undefined;
  listRuns(options?: ListRunsOptions): AgentRun[];
  messageAgent(id: string, message: string, options?: RunLookupOptions): Promise<AgentRun>;
  closeAgent(id: string, options?: RunLookupOptions): Promise<AgentRun | undefined>;
  waitBusSettled(busId: string, options?: WaitBusSettledOptions): Promise<WaitBusSettledResult>;
  waitNextRun(busId: string, options?: WaitNextRunOptions): Promise<WaitNextRunResult>;
}

export interface CreateBusOptions {
  name?: string;
}

export interface SpawnAgentOptions {
  name?: string;
}

export interface PublishedBusMessage {
  bus: Bus;
  busMessage: BusMessage;
}

export interface WaitBusSettledResult {
  bus: Bus;
  runs: AgentRun[];
  runResults: WaitRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
}

export interface WaitNextRunResult {
  bus: Bus;
  run?: AgentRun;
  runResult?: WaitRunResult;
  runs: AgentRun[];
  runResults: WaitRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
}

export interface WaitRunResult {
  runId: string;
  name: string;
  profile: string;
  state: AgentRun["state"];
  result?: AgentRun["result"];
}

export interface WaitBusSettledOptions {
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
}

export interface WaitNextRunOptions {
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
  /** Run ids or names that have already been handled by the leader. */
  excludeRunIds?: string[];
}

export interface ListRunsOptions {
  busId?: string;
}

export interface RunLookupOptions {
  /** Optional bus id or name for narrowing run lookup. */
  busId?: string;
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

  createBus(options: CreateBusOptions = {}): Bus {
    const identity = this.createBusIdentity(options.name);
    const bus: Bus = { ...identity, messages: [] };
    this.store.saveBus(bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.findBus(id);
  }

  async publishBus(id: string, message: string, from = "main"): Promise<PublishedBusMessage> {
    const bus = this.requireBus(id);
    const busMessage = await this.runtime.publishBus(bus.id, message, from);
    return { bus: this.requireBus(bus.id), busMessage };
  }

  async spawnAgent(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: SpawnAgentOptions = {},
  ): Promise<AgentRun> {
    const bus = this.requireBus(busId);
    return await this.runtime.spawn(profile, task, bus.id, this.createRunIdentity(profile, options.name));
  }

  getRun(id: string, options: RunLookupOptions = {}): AgentRun | undefined {
    return this.findRun(id, options);
  }

  listRuns(options: ListRunsOptions = {}): AgentRun[] {
    const runs = this.store.listRuns();
    if (!options.busId) return runs;
    const bus = this.requireBus(options.busId);
    return runs.filter((run) => run.busId === bus.id);
  }

  async messageAgent(id: string, message: string, options: RunLookupOptions = {}): Promise<AgentRun> {
    const run = this.requireRun(id, options);
    return await this.runtime.message(run.id, message);
  }

  async closeAgent(id: string, options: RunLookupOptions = {}): Promise<AgentRun | undefined> {
    const run = this.getRun(id, options);
    return await this.runtime.close(run?.id ?? id);
  }

  waitBusSettled(busId: string, options: WaitBusSettledOptions = {}): Promise<WaitBusSettledResult> {
    const timeoutMs = resolveWaitTimeoutMs("waitBusSettled", options.timeoutMs);
    const bus = this.requireBus(busId);
    const initialRuns = this.listRuns({ busId: bus.id });
    if (initialRuns.every((run) => isTerminalAgentState(run.state))) {
      return Promise.resolve(buildWaitBusSettledResult(bus, initialRuns, false));
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

      const resolveIfDone = () => {
        const runs = getLatestRuns();
        if (runs.some((run) => !isTerminalAgentState(run.state))) return;

        settled = true;
        cleanup();
        resolve(buildWaitBusSettledResult(bus, runs, false));
      };

      if (timeoutMs !== null) {
        timeout = setTimeout(() => {
          if (settled) return;

          settled = true;
          cleanup();
          resolve(buildWaitBusSettledResult(bus, getLatestRuns(), true));
        }, timeoutMs);
      }

      for (const run of initialRuns) {
        if (isTerminalAgentState(run.state)) continue;
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

  waitNextRun(busId: string, options: WaitNextRunOptions = {}): Promise<WaitNextRunResult> {
    const timeoutMs = resolveWaitTimeoutMs("waitNextRun", options.timeoutMs);
    const bus = this.requireBus(busId);
    const initialRuns = this.listRuns({ busId: bus.id });
    const excludedRunIds = this.resolveExcludedRunIds(initialRuns, options.excludeRunIds ?? []);
    const candidateRuns = initialRuns.filter((run) => !excludedRunIds.has(run.id));
    const alreadyDone = candidateRuns.find((run) => isTerminalAgentState(run.state));
    if (alreadyDone || candidateRuns.length === 0) {
      return Promise.resolve(buildWaitNextRunResult(bus, initialRuns, alreadyDone, false, excludedRunIds));
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

      const resolveWithRun = (run: AgentRun) => {
        settled = true;
        cleanup();
        resolve(buildWaitNextRunResult(bus, getLatestRuns(), run, false, excludedRunIds));
      };

      if (timeoutMs !== null) {
        timeout = setTimeout(() => {
          if (settled) return;

          settled = true;
          cleanup();
          resolve(buildWaitNextRunResult(bus, getLatestRuns(), undefined, true, excludedRunIds));
        }, timeoutMs);
      }

      for (const run of initialRuns) {
        if (isTerminalAgentState(run.state)) continue;
        unsubscribeAll.push(
          this.store.subscribeRun(run.id, (updatedRun) => {
            if (settled) return;
            latestRuns.set(updatedRun.id, updatedRun);
            if (!excludedRunIds.has(updatedRun.id) && isTerminalAgentState(updatedRun.state))
              resolveWithRun(updatedRun);
          }),
        );
      }
    });
  }

  private requireBus(id: string): Bus {
    const bus = this.findBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    return bus;
  }

  private findBus(id: string): Bus | undefined {
    return this.store.getBus(id) ?? this.store.listBuses().find((bus) => bus.name === id);
  }

  private requireRun(id: string, options: RunLookupOptions = {}): AgentRun {
    const run = this.findRun(id, options);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  private findRun(id: string, options: RunLookupOptions = {}): AgentRun | undefined {
    const bus = options.busId ? this.requireBus(options.busId) : undefined;
    const runById = this.store.getRun(id);
    if (runById && (!bus || runById.busId === bus.id)) return runById;

    return this.store.listRuns().find((run) => run.name === id && (!bus || run.busId === bus.id));
  }

  private resolveExcludedRunIds(busRuns: AgentRun[], excludedRunIds: string[]): Set<string> {
    const resolvedIds = new Set<string>();
    for (const id of excludedRunIds) {
      const run = busRuns.find((current) => current.id === id || current.name === id);
      resolvedIds.add(run?.id ?? id);
    }
    return resolvedIds;
  }

  private createBusIdentity(name: string | undefined) {
    return createEntityIdentity(name, "bus", this.store.listBuses(), "Bus");
  }

  private createRunIdentity(profile: AgentProfile, name: string | undefined) {
    return createEntityIdentity(name, profile.name, this.store.listRuns(), "Agent");
  }
}

function buildWaitBusSettledResult(bus: Bus, runs: AgentRun[], timedOut: boolean): WaitBusSettledResult {
  return {
    bus,
    runs,
    runResults: runs.map(toWaitRunResult),
    timedOut,
    pendingRunIds: runs.filter((run) => !isTerminalAgentState(run.state)).map((run) => run.id),
  };
}

function buildWaitNextRunResult(
  bus: Bus,
  runs: AgentRun[],
  run: AgentRun | undefined,
  timedOut: boolean,
  excludedRunIds: Set<string>,
): WaitNextRunResult {
  return {
    bus,
    run,
    runResult: run ? toWaitRunResult(run) : undefined,
    runs,
    runResults: runs.map(toWaitRunResult),
    timedOut,
    pendingRunIds: runs
      .filter((current) => !excludedRunIds.has(current.id) && !isTerminalAgentState(current.state))
      .map((current) => current.id),
  };
}
