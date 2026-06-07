import type { AgentRuntime, SpawnAgentRuntimeOptions } from "../../src/core/runtime.ts";
import type { AgentProfile, AgentResult, AgentRun } from "../../src/core/subagent.ts";
import { createBusSubscription, type BusMessage } from "../../src/core/bus.ts";
import type { AgentStore } from "../../src/core/store.ts";

export interface SpawnRecord {
  profile: AgentProfile;
  task: string;
  busId: string;
  options: SpawnAgentRuntimeOptions;
}

export interface MessageRecord {
  id: string;
  message: string;
}

export interface PublishRecord {
  busId: string;
  message: string;
  from: string;
}

export interface ControllableRuntimeOptions {
  store: AgentStore;
  onSpawn?: (run: AgentRun, record: SpawnRecord) => AgentRun | undefined | Promise<AgentRun | undefined>;
}

export class ControllableRuntime implements AgentRuntime {
  readonly spawned: SpawnRecord[] = [];
  readonly messaged: MessageRecord[] = [];
  readonly published: PublishRecord[] = [];
  readonly closedIds: string[] = [];

  private readonly store: AgentStore;
  private readonly onSpawn?: ControllableRuntimeOptions["onSpawn"];
  private messageIndex = 0;

  constructor(options: ControllableRuntimeOptions) {
    this.store = options.store;
    this.onSpawn = options.onSpawn;
  }

  async spawn(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: SpawnAgentRuntimeOptions,
  ): Promise<AgentRun> {
    this.requireBus(busId);

    const run: AgentRun = {
      id: options.id,
      name: options.name,
      profile,
      task,
      busId,
      state: "running",
      sessionFile: `.pi/orchestra/sessions/${options.id}.jsonl`,
      result: null,
    };
    const record = { profile, task, busId, options };
    this.spawned.push(record);
    this.store.saveRun(run);
    this.store.saveBusSubscription(
      createBusSubscription({ busId, subscriberId: run.id, subscriberKind: "agent", deliveredMessageIds: [] }),
    );

    const spawnedRun = await this.onSpawn?.(run, record);
    if (!spawnedRun) return run;

    this.store.saveRun(spawnedRun);
    return spawnedRun;
  }

  async message(id: string, message: string): Promise<AgentRun> {
    this.messaged.push({ id, message });
    const run = this.requireRun(id);
    if (run.state === "running") return run;

    const messagedRun: AgentRun = { ...run, state: "running", result: null };
    this.store.saveRun(messagedRun);
    return messagedRun;
  }

  async publishBus(busId: string, message: string, from: string): Promise<BusMessage> {
    this.requireBus(busId);
    this.published.push({ busId, message, from });
    this.messageIndex += 1;

    const busMessage: BusMessage = { id: `message-${this.messageIndex}`, message, from };
    this.store.addBusMessage(busId, busMessage);
    return busMessage;
  }

  async close(id: string): Promise<AgentRun | undefined> {
    this.closedIds.push(id);
    const run = this.store.getRun(id);
    if (!run) return undefined;

    const closedRun: AgentRun = { ...run, state: "closed" };
    this.store.saveRun(closedRun);
    for (const subscription of this.store.listBusSubscriptions({
      busId: undefined,
      subscriberId: id,
      subscriberKind: "agent",
    })) {
      this.store.deleteBusSubscription(subscription.id);
    }
    return closedRun;
  }

  completeRun(id: string, result: AgentResult): AgentRun {
    const run = this.requireRun(id);
    const completedRun: AgentRun = { ...run, state: result.status, result };
    this.store.saveRun(completedRun);
    return completedRun;
  }

  private requireRun(id: string): AgentRun {
    const run = this.store.getRun(id) ?? this.store.getRunByName(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  private requireBus(id: string): void {
    if (!this.store.getBus(id) && !this.store.getBusByName(id)) {
      throw new Error(`Bus ${id} not found.`);
    }
  }
}
