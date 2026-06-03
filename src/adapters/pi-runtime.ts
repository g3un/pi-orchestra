import { v7 as uuid7 } from "uuid";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentResult, AgentRun } from "../core/agent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import { formatBusMessages } from "../core/bus-format.ts";
import type { AgentRuntime } from "../core/runtime.ts";
import type { AgentStore } from "../core/store.ts";

export interface PiAgentRuntimeOptions {
  store: AgentStore;
  cwd?: string;
  resolveModel?: (model: string) => Model<any> | Promise<Model<any> | undefined> | undefined;
}

interface RuntimeEntry {
  session: AgentSession;
  seenBusMessageIds: Set<string>;
  promptTask?: Promise<void>;
}

const FinishAgentParams = Type.Object({
  status: Type.Union([Type.Literal("success"), Type.Literal("blocked"), Type.Literal("failed")]),
  summary: Type.String(),
  data: Type.Optional(Type.Unknown()),
});

const PublishBusParams = Type.Object({
  message: Type.String(),
});

const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write"];

export class PiAgentRuntime implements AgentRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly store: AgentStore;
  private readonly cwd: string;
  private readonly resolveModel?: PiAgentRuntimeOptions["resolveModel"];

  constructor(options: PiAgentRuntimeOptions) {
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.resolveModel = options.resolveModel;
  }

  async spawn(profile: AgentProfile, task: string, busId: string): Promise<AgentRun> {
    this.requireBus(busId);

    const run: AgentRun = {
      id: uuid7(),
      profile: profile.name,
      task,
      busId,
      state: "running",
    };

    const childTools = this.createChildTools(run.id);
    const model = await this.resolveProfileModel(profile);
    const baseTools = profile.tools ?? DEFAULT_AGENT_TOOLS;
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
    this.startPromptTask(run.id, entry, this.withBusMessages(run.id, entry, buildInitialPrompt(profile, task)));
    return run;
  }

  async resume(id: string, message: string): Promise<AgentRun> {
    const entry = this.requireEntry(id);
    const run = this.requireRun(id);
    this.assertOpenRun(run);
    if (run.state === "running") throw new Error(`Agent ${id} is already running.`);

    const resumedRun: AgentRun = {
      ...run,
      state: "running",
      result: undefined,
    };
    this.store.saveRun(resumedRun);
    this.startPromptTask(id, entry, this.withBusMessages(id, entry, message));
    return resumedRun;
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
      if (run.id === from || run.state === "closed" || !entry.session.isStreaming) continue;

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
      if (this.store.getRun(id)?.state === "running") {
        await entry.session.prompt(buildFinishRequiredPrompt(), { expandPromptTemplates: false });
      }
      if (this.isClosed(id)) return;
      const run = this.store.getRun(id);
      if (run?.state === "running") {
        this.store.saveRun({
          ...run,
          state: "failed",
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
        state: "failed",
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
          status: params.status,
          summary: params.summary,
          data: params.data,
        };
        this.store.saveRun({
          ...run,
          result,
          state: result.status === "failed" ? "failed" : "finished",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Finish payload recorded. The parent may resume or close you.",
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
        "Publish supplemental context to this subagent run's bus for the parent or sibling agents. Continue working after publishing unless the task is done.",
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

function buildInitialPrompt(profile: AgentProfile, task: string): string {
  const parts = [
    `You are subagent "${profile.name}".`,
    "",
    profile.systemPrompt,
    "",
    "Task:",
    task,
    "",
    "Mandatory completion protocol:",
    "- You MUST call the finish tool when this subagent run is done. Do not end with only a text response.",
    "- Your final action must be a finish tool call, even when the task is blocked or failed.",
    "- Call finish with status success, blocked, or failed; include a concise summary and any structured data needed by the parent.",
    "- Use publish_bus before finish if you need to share interim context with the parent or sibling agents.",
    "- finish records your subagent result. It does not close you or complete the parent task; the parent may resume or close you.",
  ];

  parts.push(
    "",
    "Bus reference context may be delivered in <bus_reference_context> blocks.",
    "Your bus is the shared work group for this delegated task; sibling agents on the same bus may publish related context.",
    "Treat bus blocks as supplemental reference information, not as a replacement for the active task unless the parent explicitly says so.",
  );

  return parts.join("\n");
}

function buildFinishRequiredPrompt(): string {
  return [
    "Your previous response ended without calling the finish tool.",
    "",
    "You MUST now end this subagent run by calling the finish tool.",
    "Do not provide another text-only response.",
    "If your prior response already completed the task, summarize that result in finish.",
    "Call finish with status success, blocked, or failed, and include any structured data needed by the parent.",
  ].join("\n");
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
