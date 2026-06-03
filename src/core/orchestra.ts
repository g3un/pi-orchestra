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
}

export interface PublishedBusMessage {
  bus: Bus;
  busMessage: BusMessage;
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
    return await this.runtime.resume(id, message);
  }

  async closeAgent(id: string): Promise<AgentRun | undefined> {
    return await this.runtime.close(id);
  }

  private requireBus(id: string): Bus {
    const bus = this.store.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    return bus;
  }
}
