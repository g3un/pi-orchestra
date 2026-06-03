import { v7 as uuid7 } from "uuid";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentResult, AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import { formatBusMessages } from "./bus-format.ts";
import type { AgentRuntime } from "./runtime.ts";

export interface PiAgentRuntimeOptions {
  cwd?: string;
  resolveModel?: (model: string) => Model<any> | Promise<Model<any> | undefined> | undefined;
  onRunUpdate?: (run: AgentRun) => void;
  onBusMessage?: (bus: Bus, message: BusMessage) => void;
}

interface RuntimeEntry {
  run: AgentRun;
  session: AgentSession;
  bus: Bus;
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
  private readonly cwd: string;
  private readonly resolveModel?: PiAgentRuntimeOptions["resolveModel"];
  private readonly onRunUpdate?: PiAgentRuntimeOptions["onRunUpdate"];
  private readonly onBusMessage?: PiAgentRuntimeOptions["onBusMessage"];

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.resolveModel = options.resolveModel;
    this.onRunUpdate = options.onRunUpdate;
    this.onBusMessage = options.onBusMessage;
  }

  async spawn(profile: AgentProfile, task: string, bus: Bus): Promise<AgentRun> {
    const run: AgentRun = {
      id: uuid7(),
      profile: profile.name,
      task,
      busId: bus.id,
      state: "running",
    };

    const childTools = this.createChildTools(run);
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

    const entry: RuntimeEntry = { run, session, bus, seenBusMessageIds: new Set() };
    this.entries.set(run.id, entry);
    this.startPromptTask(entry, withBusMessages(entry, buildInitialPrompt(profile, task)));
    return run;
  }

  async resume(id: string, message: string): Promise<AgentRun> {
    const entry = this.requireEntry(id);
    this.assertOpen(entry);
    entry.run.state = "running";
    entry.run.result = undefined;
    this.emitRunUpdate(entry.run);
    this.startPromptTask(entry, withBusMessages(entry, message));
    return entry.run;
  }

  async publishBus(bus: Bus, message: string, from: string): Promise<BusMessage> {
    const busMessage: BusMessage = {
      id: uuid7(),
      message,
      from,
    };

    addOrReplaceBusMessage(bus, busMessage);
    this.emitBusMessage(bus, busMessage);

    const steeringMessage = formatBusMessages([busMessage]);
    for (const entry of this.entries.values()) {
      if (entry.bus.id !== bus.id) continue;
      if (entry.bus !== bus) addOrReplaceBusMessage(entry.bus, busMessage);
      if (entry.run.id === from || this.isClosed(entry) || !entry.session.isStreaming) continue;

      entry.seenBusMessageIds.add(busMessage.id);
      await entry.session.steer(steeringMessage);
    }

    return busMessage;
  }

  async close(id: string): Promise<void> {
    const entry = this.requireEntry(id);
    if (entry.run.state !== "closed") {
      entry.run.state = "closed";
      entry.session.dispose();
      this.emitRunUpdate(entry.run);
    }
  }

  get(id: string): AgentRun | undefined {
    return this.entries.get(id)?.run;
  }

  private startPromptTask(entry: RuntimeEntry, message: string): void {
    const task = this.runPrompt(entry.run.id, message).finally(() => {
      if (entry.promptTask === task) entry.promptTask = undefined;
    });
    entry.promptTask = task;
  }

  private async runPrompt(id: string, message: string): Promise<void> {
    const entry = this.requireEntry(id);
    if (this.isClosed(entry)) return;

    try {
      await entry.session.prompt(message, { expandPromptTemplates: false });
      if (this.isClosed(entry)) return;
      if (entry.run.state === "running") {
        await entry.session.prompt(buildFinishRequiredPrompt(), { expandPromptTemplates: false });
      }
      if (this.isClosed(entry)) return;
      if (entry.run.state === "running") {
        entry.run.state = "failed";
        entry.run.result = {
          status: "failed",
          summary: "Agent stopped without calling finish.",
          data: getLastAssistantText(entry.session),
        };
        this.emitRunUpdate(entry.run);
      }
    } catch (error) {
      if (this.isClosed(entry)) return;
      entry.run.state = "failed";
      entry.run.result = {
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
      };
      this.emitRunUpdate(entry.run);
    }
  }

  private createChildTools(run: AgentRun): ToolDefinition[] {
    const finishAgent = {
      name: "finish",
      label: "Finish",
      description:
        "Required final subagent action. Report that your assigned subagent task is complete. This does not close the agent.",
      parameters: FinishAgentParams,
      execute: async (_toolCallId, params) => {
        const result: AgentResult = {
          status: params.status,
          summary: params.summary,
          data: params.data,
        };
        run.result = result;
        run.state = result.status === "failed" ? "failed" : "finished";
        this.emitRunUpdate(run);
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
        const entry = this.requireEntry(run.id);
        this.assertOpen(entry);
        const busMessage = await this.publishBus(entry.bus, params.message, run.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Published message ${busMessage.id} to bus ${entry.bus.id}.`,
            },
          ],
          details: busMessage,
        };
      },
    } satisfies ToolDefinition<typeof PublishBusParams, BusMessage>;

    return [finishAgent, publishBus];
  }

  private emitRunUpdate(run: AgentRun): void {
    try {
      this.onRunUpdate?.(run);
    } catch {
      // Keep runtime state transitions from being interrupted by persistence errors.
    }
  }

  private emitBusMessage(bus: Bus, message: BusMessage): void {
    try {
      this.onBusMessage?.(bus, message);
    } catch {
      // Keep runtime message delivery from being interrupted by persistence errors.
    }
  }

  private requireEntry(id: string): RuntimeEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Agent ${id} not found.`);
    return entry;
  }

  private assertOpen(entry: RuntimeEntry): void {
    if (entry.run.state === "closed") throw new Error(`Agent ${entry.run.id} is closed.`);
  }

  private isClosed(entry: RuntimeEntry): boolean {
    return entry.run.state === "closed";
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
    "Treat those blocks as supplemental reference information, not as a replacement for the active task unless the parent explicitly says so.",
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

function withBusMessages(entry: RuntimeEntry, message: string): string {
  const busMessages = drainBusMessages(entry);
  if (busMessages.length === 0) return message;
  return [message, "", formatBusMessages(busMessages)].join("\n");
}

function drainBusMessages(entry: RuntimeEntry): BusMessage[] {
  const unreadMessages = entry.bus.messages.filter((message) => {
    if (message.from === entry.run.id) return false;
    return !entry.seenBusMessageIds.has(message.id);
  });

  for (const message of unreadMessages) entry.seenBusMessageIds.add(message.id);
  return unreadMessages;
}

function addOrReplaceBusMessage(bus: Bus, message: BusMessage): void {
  const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
  if (existingIndex >= 0) {
    bus.messages[existingIndex] = message;
    return;
  }

  bus.messages.push(message);
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
