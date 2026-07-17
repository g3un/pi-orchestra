import { closeBusRecord } from "./auto-bus.ts";
import type { AgentProfile, AgentRun } from "./subagent.ts";
import { markBusMessageDeliveredForSubscriber, type Bus, type BusMessage } from "./bus.ts";
import type { AgentRuntime } from "./runtime.ts";
import { createEntityIdentity, findAgentRun, findEntity } from "../utils.ts";
import type { AgentStore } from "./store.ts";

export interface OrchestraApi {
  createBus(options: CreateBusOptions): Bus;
  getBus(id: string): Bus | undefined;
  closeBus(id: string): Bus | undefined;
  publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage>;

  spawnAgent(profile: AgentProfile, task: string, busId: string, options: SpawnAgentOptions): Promise<AgentRun>;
  getRun(id: string, options: RunLookupOptions): AgentRun | undefined;
  listRuns(options: ListRunsOptions): AgentRun[];
  messageAgent(id: string, message: string, options: RunLookupOptions): Promise<AgentRun>;
  closeAgent(id: string, options: RunLookupOptions): Promise<AgentRun | undefined>;
}

export interface CreateBusOptions {
  name: string | undefined;
  metadata?: Bus["metadata"];
}

export interface SpawnAgentOptions {
  name: string | undefined;
  parentRunId: string | null;
}

export interface PublishedBusMessage {
  bus: Bus;
  busMessage: BusMessage;
}

export interface ListRunsOptions {
  busId: string | undefined;
}

export interface RunLookupOptions {
  /** Bus id or name for narrowing run lookup. If undefined, search all runs. */
  busId: string | undefined;
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

  createBus(options: CreateBusOptions): Bus {
    const identity = this.createBusIdentity(options.name);
    const bus: Bus = { ...identity, state: "open", messages: [], nextMessageSeq: 1, metadata: options.metadata };
    this.store.saveBus(bus);
    return bus;
  }

  getBus(id: string): Bus | undefined {
    return this.findBus(id);
  }

  closeBus(id: string): Bus | undefined {
    const bus = this.findBus(id);
    if (!bus) return undefined;
    return closeBusRecord(this.store, bus.id) ?? { ...bus, state: "closed" };
  }

  async publishBus(id: string, message: string, from: string): Promise<PublishedBusMessage> {
    const bus = this.requireOpenBus(id);
    const busMessage = await this.runtime.publishBus(bus.id, message, from);
    this.markSenderBusMessageDelivered(bus.id, from, busMessage);
    return { bus: this.requireBus(bus.id), busMessage };
  }

  async spawnAgent(profile: AgentProfile, task: string, busId: string, options: SpawnAgentOptions): Promise<AgentRun> {
    const bus = this.requireOpenBus(busId);
    return await this.runtime.spawn(profile, task, bus.id, {
      ...this.createRunIdentity(profile, options.name),
      parentRunId: options.parentRunId,
    });
  }

  getRun(id: string, options: RunLookupOptions): AgentRun | undefined {
    return this.findRun(id, options);
  }

  listRuns(options: ListRunsOptions): AgentRun[] {
    const runs = this.store.listRuns();
    if (!options.busId) return runs;
    const bus = this.requireBus(options.busId);
    return runs.filter((run) => run.busId === bus.id);
  }

  async messageAgent(id: string, message: string, options: RunLookupOptions): Promise<AgentRun> {
    const run = this.requireRun(id, options);
    const deliveredRun = await this.runtime.message(run.id, message);
    return this.store.getRun(run.id) ?? deliveredRun;
  }

  async closeAgent(id: string, options: RunLookupOptions): Promise<AgentRun | undefined> {
    const run = this.getRun(id, options);
    if (!run) return undefined;
    return await this.runtime.close(run.id);
  }

  private markSenderBusMessageDelivered(busId: string, from: string, busMessage: BusMessage): void {
    markBusMessageDeliveredForSubscriber(this.store, busId, from === "main" ? "main" : "agent", from, busMessage);
  }

  private requireBus(id: string): Bus {
    const bus = this.findBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    return bus;
  }

  private requireOpenBus(id: string): Bus {
    const bus = this.requireBus(id);
    if (bus.state === "closed") throw new Error(`Bus ${bus.name} is closed.`);
    return bus;
  }

  private findBus(id: string): Bus | undefined {
    return findEntity(
      id,
      "bus",
      (busId) => this.store.getBus(busId),
      () => this.store.listBuses(),
      (bus) => bus.state === "open",
    );
  }

  private requireRun(id: string, options: RunLookupOptions): AgentRun {
    const run = this.findRun(id, options);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  private findRun(id: string, options: RunLookupOptions): AgentRun | undefined {
    const bus = options.busId ? this.requireBus(options.busId) : undefined;
    const run = findAgentRun(this.store, id);
    return run && (!bus || run.busId === bus.id) ? run : undefined;
  }

  private createBusIdentity(name: string | undefined) {
    const buses = this.store.listBuses();
    return createEntityIdentity(
      name,
      "bus",
      buses.filter((bus) => bus.state === "open"),
      "Bus",
      undefined,
      buses.filter((bus) => bus.state === "open"),
    );
  }

  private createRunIdentity(profile: AgentProfile, name: string | undefined) {
    const runs = this.store.listRuns();
    const reusableRuns = runs.filter((run) => run.state !== "closed");
    return createEntityIdentity(name, profile.name, reusableRuns, "Agent", undefined, reusableRuns);
  }
}
