import type { AgentProfile, AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { AgentStore } from "./store.ts";

export interface OrchestraApi {
  createBus(options?: CreateBusOptions): Bus;
  getBus(id: string): Bus | undefined;
  publishBus(id: string, message: string, from?: string): Promise<PublishedBusMessage>;

  spawnAgent(profile: AgentProfile, task: string, busId: string, options?: SpawnAgentOptions): Promise<AgentRun>;
  getRun(id: string): AgentRun | undefined;
  listRuns(options?: ListRunsOptions): AgentRun[];
  resumeAgent(id: string, message: string): Promise<AgentRun>;
  closeAgent(id: string): Promise<AgentRun | undefined>;
  waitBus(busId: string, options?: WaitBusOptions): Promise<WaitBusResult>;
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

export interface WaitBusResult {
  bus: Bus;
  runs: AgentRun[];
  runResults: WaitBusRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
}

export interface WaitBusRunResult {
  runId: string;
  name: string;
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

  getRun(id: string): AgentRun | undefined {
    return this.findRun(id);
  }

  listRuns(options: ListRunsOptions = {}): AgentRun[] {
    const runs = this.store.listRuns();
    if (!options.busId) return runs;
    const bus = this.requireBus(options.busId);
    return runs.filter((run) => run.busId === bus.id);
  }

  async resumeAgent(id: string, message: string): Promise<AgentRun> {
    const run = this.requireRun(id);
    if (run.state === "running") throw new Error(`Agent ${id} is already running.`);
    return await this.runtime.resume(run.id, message);
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    const run = this.getRun(id);
    return await this.runtime.close(run?.id ?? id);
  }

  waitBus(busId: string, options: WaitBusOptions = {}): Promise<WaitBusResult> {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_WAIT_BUS_TIMEOUT_MS : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("waitBus timeoutMs must be positive, or null to wait indefinitely.");
    }

    const bus = this.requireBus(busId);
    const initialRuns = this.listRuns({ busId: bus.id });
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
    const bus = this.findBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    return bus;
  }

  private findBus(id: string): Bus | undefined {
    return this.store.getBus(id) ?? this.store.listBuses().find((bus) => bus.name === id);
  }

  private requireRun(id: string): AgentRun {
    const run = this.findRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  private findRun(id: string): AgentRun | undefined {
    return this.store.getRun(id) ?? this.store.listRuns().find((run) => run.name === id);
  }

  private createBusIdentity(name: string | undefined): EntityIdentity {
    return createEntityIdentity(name, "bus", this.store.listBuses(), "Bus");
  }

  private createRunIdentity(profile: AgentProfile, name: string | undefined): EntityIdentity {
    return createEntityIdentity(name, slugify(profile.name) || "agent", this.store.listRuns(), "Agent");
  }
}

interface EntityIdentity {
  id: string;
  name: string;
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
    name: run.name,
    profile: run.profile,
    state: run.state,
  };
  if (run.result !== undefined) runResult.result = run.result;
  return runResult;
}

function createEntityIdentity(
  requestedName: string | undefined,
  autoSeed: string,
  existingEntities: Array<{ id: string; name: string }>,
  entityLabel: string,
): EntityIdentity {
  if (requestedName !== undefined) {
    const name = normalizeName(requestedName, entityLabel);
    const id = slugify(name);
    if (!id) throw new Error(`${entityLabel} name "${name}" must contain letters or numbers.`);
    if (existingEntities.some((entity) => entity.id === id || entity.name === name)) {
      throw new Error(`${entityLabel} name "${name}" is already in use.`);
    }
    return { id, name };
  }

  const base = slugify(autoSeed) || entityLabel.toLowerCase();
  for (let index = 1; ; index++) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!existingEntities.some((entity) => entity.id === id || entity.name === id)) return { id, name: id };
  }
}

function normalizeName(name: string, entityLabel: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${entityLabel} name must not be empty.`);
  if (trimmed.length > 64) throw new Error(`${entityLabel} name must be 64 characters or fewer.`);
  return trimmed;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isTerminalRun(run: AgentRun): boolean {
  return run.state === "finished" || run.state === "failed" || run.state === "closed";
}
