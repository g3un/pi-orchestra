import { v7 as uuid7 } from "uuid";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AGENT_RESULT_STATUS_VALUES,
  type AgentProfile,
  type AgentResult,
  type AgentResultStatus,
  type AgentRun,
} from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import { formatBusMessages } from "../core/bus-format.ts";
import type { AgentRuntime, SpawnAgentRuntimeOptions } from "../core/runtime.ts";
import type { AgentStore } from "../core/store.ts";

export interface PiAgentRuntimeOptions {
  store: AgentStore;
  cwd: string | undefined;
  resolveModel: ((model: string) => Model<any> | Promise<Model<any> | undefined> | undefined) | undefined;
}

interface RuntimeEntry {
  session: AgentSession;
  seenBusMessageIds: Set<string>;
  promptTask?: Promise<void>;
}

const FinishAgentParams = Type.Object({
  status: Type.String({ enum: [...AGENT_RESULT_STATUS_VALUES] }),
  summary: Type.String(),
  data: Type.Optional(Type.Unknown()),
});

const PublishBusParams = Type.Object({
  message: Type.String(),
});

export class PiAgentRuntime implements AgentRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly store: AgentStore;
  private readonly cwd: string;
  private readonly resolveModel: PiAgentRuntimeOptions["resolveModel"];

  constructor(options: PiAgentRuntimeOptions) {
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.resolveModel = options.resolveModel;
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
      profile: profile.name,
      task,
      busId,
      state: "running",
    };

    const childTools = this.createChildTools(run.id);
    const model = await this.resolveProfileModel(profile);
    const baseTools = requireProfileTools(profile);
    const activeTools = [...new Set([...baseTools, ...childTools.map((tool) => tool.name)])];
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      tools: activeTools,
      customTools: childTools,
      sessionManager: SessionManager.inMemory(this.cwd),
    });

    this.store.saveRun(run);
    const entry: RuntimeEntry = { session, seenBusMessageIds: new Set() };
    this.entries.set(run.id, entry);
    this.startPromptTask(
      run.id,
      entry,
      this.withBusMessages(run.id, entry, buildInitialPrompt(profile, task, run.name)),
    );
    return run;
  }

  async message(id: string, message: string): Promise<AgentRun> {
    const entry = this.requireEntry(id);
    const run = this.requireRun(id);
    this.assertOpenRun(run);
    const messageWithBusContext = this.withBusMessages(id, entry, message);

    if (run.state === "running" && entry.session.isStreaming) {
      await entry.session.steer(messageWithBusContext);
      return run;
    }

    const messagedRun: AgentRun = { ...run, state: "running", result: undefined };
    this.store.saveRun(messagedRun);
    this.startPromptTask(id, entry, messageWithBusContext);
    return messagedRun;
  }

  async publishBus(busId: string, message: string, from: string): Promise<BusMessage> {
    this.requireBus(busId);
    const busMessage: BusMessage = {
      id: uuid7(),
      message,
      from,
    };

    this.store.addBusMessage(busId, busMessage);

    const steeringMessage = formatBusMessages([busMessage]);
    const steerTasks: Array<Promise<void>> = [];
    for (const [runId, entry] of this.entries) {
      const run = this.store.getRun(runId);
      if (!run || run.busId !== busId) continue;
      if (run.id === from || run.state !== "running" || !entry.session.isStreaming) continue;

      entry.seenBusMessageIds.add(busMessage.id);
      steerTasks.push(entry.session.steer(steeringMessage));
    }

    await Promise.all(steerTasks);
    return busMessage;
  }

  async close(id: string): Promise<AgentRun | undefined> {
    const run = this.store.getRun(id);
    if (!run) return undefined;

    const entry = this.entries.get(id);
    if (run.state === "closed") {
      entry?.session.dispose();
      return run;
    }

    const closedRun: AgentRun = { ...run, state: "closed" };
    this.store.saveRun(closedRun);
    entry?.session.dispose();
    return closedRun;
  }

  private startPromptTask(id: string, entry: RuntimeEntry, message: string): void {
    const task = this.runPrompt(id, message).finally(() => {
      if (entry.promptTask === task) entry.promptTask = undefined;
    });
    entry.promptTask = task;
  }

  private async runPrompt(id: string, message: string): Promise<void> {
    const entry = this.requireEntry(id);
    if (this.isClosed(id)) return;

    try {
      await entry.session.prompt(message, { expandPromptTemplates: false });
      if (this.isClosed(id)) return;
      if (this.isRunningWithoutResult(id)) {
        await entry.session.prompt(buildFinishRequiredPrompt(), { expandPromptTemplates: false });
      }
      if (this.isClosed(id)) return;
      const run = this.store.getRun(id);
      if (run && isRunningWithoutResult(run)) {
        this.store.saveRun({
          ...run,
          state: "idle",
          result: {
            status: "failed",
            summary: "Agent stopped without calling finish.",
            data: getLastAssistantText(entry.session),
          },
        });
      }
    } catch (error) {
      if (this.isClosed(id)) return;
      const run = this.store.getRun(id);
      if (!run) return;
      this.store.saveRun({
        ...run,
        state: "idle",
        result: {
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private createChildTools(runId: string): ToolDefinition[] {
    const finishAgent = {
      name: "finish",
      label: "Finish",
      description:
        "Required final subagent action. Report that your assigned subagent task is complete. This does not close the agent.",
      parameters: FinishAgentParams,
      execute: async (_toolCallId, params) => {
        const run = this.requireRun(runId);
        this.assertOpenRun(run);
        const result: AgentResult = {
          status: params.status as AgentResultStatus,
          summary: params.summary,
          data: params.data,
        };
        this.store.saveRun({
          ...run,
          result,
          state: "idle",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Finish payload recorded. The leader may message or close you.",
            },
          ],
          details: result,
          terminate: true,
        };
      },
    } satisfies ToolDefinition<typeof FinishAgentParams, AgentResult>;

    const publishBus = {
      name: "publish_bus",
      label: "Publish Bus Message",
      description:
        "Publish peer-reference context to sibling agents. For leader action, use finish(status=blocked). Continue unless the task is done.",
      parameters: PublishBusParams,
      execute: async (_toolCallId, params) => {
        const run = this.requireRun(runId);
        this.assertOpenRun(run);
        const busMessage = await this.publishBus(run.busId, params.message, run.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Published message ${busMessage.id} to bus ${run.busId}.`,
            },
          ],
          details: busMessage,
        };
      },
    } satisfies ToolDefinition<typeof PublishBusParams, BusMessage>;

    return [finishAgent, publishBus];
  }

  private requireEntry(id: string): RuntimeEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Agent ${id} not found.`);
    return entry;
  }

  private requireRun(id: string): AgentRun {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`Agent ${id} not found.`);
    return run;
  }

  private assertOpenRun(run: AgentRun): void {
    if (run.state === "closed") throw new Error(`Agent ${run.id} is closed.`);
  }

  private isClosed(id: string): boolean {
    return this.store.getRun(id)?.state === "closed";
  }

  private isRunningWithoutResult(id: string): boolean {
    const run = this.store.getRun(id);
    return run !== undefined && isRunningWithoutResult(run);
  }

  private requireBus(id: string): Bus {
    const bus = this.store.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    return bus;
  }

  private withBusMessages(runId: string, entry: RuntimeEntry, message: string): string {
    const busMessages = this.drainBusMessages(runId, entry);
    if (busMessages.length === 0) return message;
    return [message, "", formatBusMessages(busMessages)].join("\n");
  }

  private drainBusMessages(runId: string, entry: RuntimeEntry): BusMessage[] {
    const run = this.requireRun(runId);
    const bus = this.requireBus(run.busId);
    const unreadMessages = bus.messages.filter((message) => {
      if (message.from === run.id) return false;
      return !entry.seenBusMessageIds.has(message.id);
    });

    for (const message of unreadMessages) entry.seenBusMessageIds.add(message.id);
    return unreadMessages;
  }

  private async resolveProfileModel(profile: AgentProfile): Promise<Model<any> | undefined> {
    if (!profile.model) return undefined;
    if (!this.resolveModel) throw new Error(`No model resolver configured for profile model "${profile.model}".`);
    const model = await this.resolveModel(profile.model);
    if (!model) throw new Error(`Could not resolve profile model "${profile.model}".`);
    return model;
  }
}

function buildInitialPrompt(profile: AgentProfile, task: string, runName: string): string {
  return [
    `You are subagent run "${runName}" with profile "${profile.name}".`,
    "",
    "## System prompt",
    profile.systemPrompt,
    "",
    "## Task",
    task,
    "",
    "## Completion",
    "- End by calling finish exactly once with status, summary, and useful data; never stop text-only.",
    "- Use publish_bus only for sibling reference context; use finish(status=blocked) for leader action or decisions.",
    "- Bus context may arrive in <bus_reference_context>; treat it as supplemental unless told otherwise.",
  ].join("\n");
}

function requireProfileTools(profile: AgentProfile): string[] {
  if (!Array.isArray(profile.tools)) throw new Error(`Profile "${profile.name}" must specify tools.`);
  return profile.tools;
}

function buildFinishRequiredPrompt(): string {
  return [
    "Your previous response ended without finish.",
    "Call finish now with status success, blocked, or failed; include summary and useful data.",
  ].join("\n");
}

function isRunningWithoutResult(run: AgentRun): boolean {
  return run.state === "running" && run.result === undefined;
}

function getLastAssistantText(session: AgentSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}
