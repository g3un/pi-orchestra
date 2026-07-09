import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
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
import {
  createBusSubscription,
  isBusMessageDelivered,
  markBusMessageDeliveredForSubscriber,
  markBusMessagesDelivered,
  type Bus,
  type BusMessage,
  type BusSubscription,
} from "../core/bus.ts";
import { formatBusMessages } from "../core/bus-format.ts";
import { formatBusMessageText } from "../formatting.ts";
import type { AgentRuntime, SpawnAgentRuntimeOptions } from "../core/runtime.ts";
import type { AgentStore } from "../core/store.ts";
import { resolveBusName, resolveRunName } from "../utils.ts";

export interface PiAgentRuntimeOptions {
  store: AgentStore;
  cwd: string | undefined;
  resolveModel: ((model: string) => Model<any> | Promise<Model<any> | undefined> | undefined) | undefined;
  resolveCustomTools: ((runId: string) => ToolDefinition[]) | undefined;
  onPromptTaskError?: (runId: string, error: unknown) => void;
  onSpawnRollback?: (runId: string) => void;
  ownerSessionId: string;
}

function safeDisposeSession(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
    // Cleanup errors must not block store/runtime disposal.
  }
}

interface RuntimeEntry {
  session: AgentSession;
  promptTask?: Promise<void>;
}

interface PromptMessage {
  content: string;
  busDeliveries: PendingBusDelivery[];
}

interface PendingBusDelivery {
  subscriptionId: string;
  messages: BusMessage[];
}

const ORCHESTRA_SESSION_RELATIVE_DIR = join(".pi", "orchestra", "sessions");

const FinishAgentParams = Type.Object({
  status: Type.String({ enum: [...AGENT_RESULT_STATUS_VALUES] }),
  summary: Type.String(),
  data: Type.Optional(Type.Unknown()),
});

const PublishBusParams = Type.Object({
  message: Type.String(),
});

const BLOCKED_CHILD_PROFILE_TOOL_NAMES = new Set(["bus"]);

export class PiAgentRuntime implements AgentRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly store: AgentStore;
  private readonly cwd: string;
  private readonly resolveModel: PiAgentRuntimeOptions["resolveModel"];
  private readonly resolveCustomTools: NonNullable<PiAgentRuntimeOptions["resolveCustomTools"]>;
  private readonly onPromptTaskError: PiAgentRuntimeOptions["onPromptTaskError"];
  private readonly onSpawnRollback: PiAgentRuntimeOptions["onSpawnRollback"];
  private readonly ownerSessionId: string;
  private readonly pendingBusDeliveryIds = new Set<string>();
  private readonly activeToolRunId = new AsyncLocalStorage<string>();
  private disposed = false;

  constructor(options: PiAgentRuntimeOptions) {
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.resolveModel = options.resolveModel;
    this.resolveCustomTools = options.resolveCustomTools ?? ((_runId: string) => []);
    this.onPromptTaskError = options.onPromptTaskError;
    this.onSpawnRollback = options.onSpawnRollback;
    this.ownerSessionId = options.ownerSessionId;
  }

  async spawn(
    profile: AgentProfile,
    task: string,
    busId: string,
    options: SpawnAgentRuntimeOptions,
  ): Promise<AgentRun> {
    this.assertNotDisposed();
    this.requireBus(busId);

    const baseTools = filterChildProfileTools(requireProfileTools(profile));
    const model = await this.resolveProfileModel(profile);
    const sessionManager = SessionManager.create(this.cwd, getProjectOrchestraSessionDir(this.cwd));
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Could not create a persisted session for the subagent.");

    const run: AgentRun = {
      id: options.id,
      name: options.name,
      profile,
      task,
      busId,
      ownerSessionId: this.ownerSessionId,
      sessionFile,
      parentRunId: options.parentRunId,
      state: "running",
      result: null,
    };

    const childTools = this.createChildTools(run.id);
    const customTools = this.wrapToolExecutors(run.id, this.selectCustomTools(baseTools, childTools, run.id));
    const activeTools = [...new Set([...baseTools, ...childTools.map((tool) => tool.name)])];
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      tools: activeTools,
      customTools,
      sessionManager,
    });

    let savedRun = false;
    try {
      this.store.saveRun(run);
      savedRun = true;
      this.store.saveBusSubscription(createAgentBusSubscription(run.id, busId));
      const entry: RuntimeEntry = { session };
      this.entries.set(run.id, entry);
      this.startPromptTask(
        run.id,
        entry,
        this.withSubscribedBusMessages(run.id, buildInitialPrompt(profile, task, run.name)),
      );
      return run;
    } catch (error) {
      safeDisposeSession(session);
      this.entries.delete(run.id);
      this.deleteAgentBusSubscriptions(run.id);
      if (savedRun) {
        try {
          // Store run notifications are synchronous; suppress them before saving the rollback close.
          this.onSpawnRollback?.(run.id);
          this.store.saveRun({ ...run, state: "closed" });
        } catch {
          // Keep the original spawn failure.
        }
      }
      throw error;
    }
  }

  async message(id: string, message: string): Promise<AgentRun> {
    this.assertNotDisposed();
    const run = this.requireRun(id);
    this.assertOpenRun(run);
    const entry = this.requireEntry(id);
    const messageWithBusContext = this.withSubscribedBusMessages(id, message);

    if (run.state === "running" && (entry.promptTask || entry.session.isStreaming)) {
      try {
        await entry.session.steer(messageWithBusContext.content);
        this.markPendingBusDeliveries(messageWithBusContext.busDeliveries);
      } catch (error) {
        this.clearPendingBusDeliveries(messageWithBusContext.busDeliveries);
        throw error;
      }
      return run;
    }

    const messagedRun: AgentRun = { ...run, state: "running", result: null };
    this.store.saveRun(messagedRun);
    this.startPromptTask(id, entry, messageWithBusContext);
    return messagedRun;
  }

  async publishBus(busId: string, message: string, from: string): Promise<BusMessage> {
    this.assertNotDisposed();
    this.requireBus(busId);
    const busMessage = {
      id: crypto.randomUUID(),
      message,
      from,
    };

    const savedBusMessage = this.store.addBusMessage(busId, busMessage);
    if (from === "main") markBusMessageDeliveredForSubscriber(this.store, busId, "main", "main", savedBusMessage);

    const steeringMessage = this.formatBusMessagesForPrompt([savedBusMessage]);
    const steerTasks: Array<Promise<void>> = [];
    for (const subscription of this.store.listBusSubscriptions({
      busId,
      subscriberId: undefined,
      subscriberKind: "agent",
    })) {
      if (subscription.subscriberId === from) {
        this.markSubscriptionMessagesDelivered(subscription, savedBusMessage);
        continue;
      }
      if (isBusMessageDelivered(subscription, savedBusMessage)) continue;

      const run = this.store.getRun(subscription.subscriberId);
      const entry = this.entries.get(subscription.subscriberId);
      if (!run || !entry || run.state !== "running" || !entry.session.isStreaming) continue;

      steerTasks.push(
        entry.session
          .steer(steeringMessage)
          .then(() => this.markSubscriptionMessagesDelivered(subscription, savedBusMessage)),
      );
    }

    await Promise.all(steerTasks);
    return savedBusMessage;
  }

  listRunIds(): string[] {
    return [...this.entries.keys()];
  }

  async close(id: string): Promise<AgentRun | undefined> {
    const run = this.store.getRun(id);
    if (!run) return undefined;

    const entry = this.entries.get(id);
    if (run.state === "closed") {
      if (entry) safeDisposeSession(entry.session);
      if (this.activeToolRunId.getStore() !== id) await this.waitForPromptTask(entry);
      this.entries.delete(id);
      return run;
    }

    const closedRun: AgentRun = { ...run, state: "closed" };
    this.store.saveRun(closedRun);
    this.deleteAgentBusSubscriptions(id);
    if (entry) safeDisposeSession(entry.session);
    if (this.activeToolRunId.getStore() !== id) await this.waitForPromptTask(entry);
    this.entries.delete(id);
    return this.store.getRun(id) ?? closedRun;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const entries = [...this.entries.entries()];
    for (const [id] of entries) {
      const run = this.store.getRun(id);
      if (!run || run.state === "closed") continue;

      this.store.saveRun({ ...run, state: "closed" });
      this.deleteAgentBusSubscriptions(id);
    }

    for (const [, entry] of entries) safeDisposeSession(entry.session);
    this.entries.clear();
  }

  private async waitForPromptTask(entry: RuntimeEntry | undefined): Promise<void> {
    if (!entry?.promptTask) return;
    await Promise.race([
      entry.promptTask.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
    ]);
  }

  private startPromptTask(id: string, entry: RuntimeEntry, message: PromptMessage): void {
    const task = this.runPrompt(id, message)
      .catch((error) => this.handlePromptTaskError(id, error))
      .finally(() => {
        if (entry.promptTask === task) entry.promptTask = undefined;
      });
    entry.promptTask = task;
  }

  private async runPrompt(id: string, message: PromptMessage): Promise<void> {
    const entry = this.requireEntry(id);
    if (this.isClosed(id)) {
      this.clearPendingBusDeliveries(message.busDeliveries);
      return;
    }

    try {
      await entry.session.prompt(message.content, { expandPromptTemplates: false });
      this.markPendingBusDeliveries(message.busDeliveries);
      if (this.isClosed(id)) return;
      if (this.isRunningWithoutResult(id)) {
        await entry.session.prompt(buildFinishRequiredPrompt(), { expandPromptTemplates: false });
      }
      if (this.isClosed(id)) return;
      const run = this.store.getRun(id);
      if (run && isRunningWithoutResult(run)) {
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
      this.clearPendingBusDeliveries(message.busDeliveries);
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

  private selectCustomTools(profileToolNames: string[], childTools: ToolDefinition[], runId: string): ToolDefinition[] {
    const requestedProfileToolNames = new Set(profileToolNames);
    const requestedCustomTools = this.resolveCustomTools(runId).filter((tool) =>
      requestedProfileToolNames.has(tool.name),
    );
    return dedupeToolsByName([...requestedCustomTools, ...childTools]);
  }

  private wrapToolExecutors(runId: string, tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<ToolDefinition["execute"]>) =>
        await this.activeToolRunId.run(runId, async () => await tool.execute(...args)),
    }));
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
        const ledScope = this.findRunningLedScope(run.id);
        if (ledScope) {
          throw new Error(
            `Agent ${run.name} leads running ${ledScope.type} ${ledScope.name}; use ${ledScope.type} action=finish before finish.`,
          );
        }
        const result: AgentResult = {
          status: params.status as AgentResultStatus,
          summary: params.summary,
          data: params.data,
        };
        this.store.saveRun({
          ...run,
          result,
          state: result.status,
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
              text: `Published message to bus ${this.formatBusName(run.busId)}.`,
            },
          ],
          details: { ...busMessage, message: formatBusMessageText(busMessage.message) },
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
    if (run.state === "closed") throw new Error(`Agent ${run.name} is closed.`);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("PiAgentRuntime is disposed.");
  }

  private handlePromptTaskError(runId: string, error: unknown): void {
    try {
      this.onPromptTaskError?.(runId, error);
    } catch {
      // Prompt task failures are already terminal; the observer must not create another rejection.
    }
  }

  private isClosed(id: string): boolean {
    return this.store.getRun(id)?.state === "closed";
  }

  private isRunningWithoutResult(id: string): boolean {
    const run = this.store.getRun(id);
    return run !== undefined && isRunningWithoutResult(run);
  }

  private findRunningLedScope(runId: string): { type: "workgroup"; name: string } | undefined {
    const workgroup = this.store
      .listWorkgroups()
      .find((current) => current.leaderRunId === runId && current.state === "running");
    return workgroup ? { type: "workgroup", name: workgroup.name } : undefined;
  }

  private requireBus(id: string): Bus {
    const bus = this.store.getBus(id);
    if (!bus) throw new Error(`Bus ${id} not found.`);
    if (bus.state === "closed") throw new Error(`Bus ${bus.name} is closed.`);
    return bus;
  }

  private withSubscribedBusMessages(runId: string, message: string): PromptMessage {
    const busContext = this.drainSubscribedBusMessages(runId);
    this.trackPendingBusDeliveries(busContext.busDeliveries);
    if (busContext.messages.length === 0) return { content: message, busDeliveries: [] };
    return {
      content: [message, "", this.formatBusMessagesForPrompt(busContext.messages)].join("\n"),
      busDeliveries: busContext.busDeliveries,
    };
  }

  private drainSubscribedBusMessages(runId: string): { messages: BusMessage[]; busDeliveries: PendingBusDelivery[] } {
    const subscriptions = this.store.listBusSubscriptions({
      busId: undefined,
      subscriberId: runId,
      subscriberKind: "agent",
    });
    const unreadMessages: BusMessage[] = [];
    const busDeliveries: PendingBusDelivery[] = [];
    for (const subscription of subscriptions) {
      const bus = this.store.getBus(subscription.busId);
      if (!bus) {
        this.store.deleteBusSubscription(subscription.id);
        continue;
      }

      const subscriptionUnreadMessages = bus.messages.filter((message) => {
        if (message.from === runId) return false;
        if (isBusMessageDelivered(subscription, message)) return false;
        return !this.isPendingBusDelivery(subscription.id, message.id);
      });
      if (subscriptionUnreadMessages.length === 0) continue;

      unreadMessages.push(...subscriptionUnreadMessages);
      busDeliveries.push({ subscriptionId: subscription.id, messages: subscriptionUnreadMessages });
    }
    return { messages: unreadMessages, busDeliveries };
  }

  private trackPendingBusDeliveries(deliveries: PendingBusDelivery[]): void {
    for (const delivery of deliveries) {
      for (const message of delivery.messages)
        this.pendingBusDeliveryIds.add(createPendingBusDeliveryId(delivery, message));
    }
  }

  private markPendingBusDeliveries(deliveries: PendingBusDelivery[]): void {
    for (const delivery of deliveries) {
      const subscription = this.store.getBusSubscription(delivery.subscriptionId);
      if (subscription) this.markSubscriptionMessagesDelivered(subscription, delivery.messages);
    }
    this.clearPendingBusDeliveries(deliveries);
  }

  private clearPendingBusDeliveries(deliveries: PendingBusDelivery[]): void {
    for (const delivery of deliveries) {
      for (const message of delivery.messages)
        this.pendingBusDeliveryIds.delete(createPendingBusDeliveryId(delivery, message));
    }
  }

  private isPendingBusDelivery(subscriptionId: string, messageId: string): boolean {
    return this.pendingBusDeliveryIds.has(`${subscriptionId}:message:${messageId}`);
  }

  private markSubscriptionMessagesDelivered(subscription: BusSubscription, messages: BusMessage | BusMessage[]): void {
    const latestSubscription = this.store.getBusSubscription(subscription.id);
    if (!latestSubscription) return;
    this.store.saveBusSubscription(markBusMessagesDelivered(latestSubscription, messages));
  }

  private formatBusMessagesForPrompt(messages: BusMessage[]): string {
    return formatBusMessages(messages, { formatFrom: (from) => this.formatBusMessageFrom(from) });
  }

  private formatBusMessageFrom(from: string): string {
    if (from === "main") return from;
    return resolveRunName(this.store, from);
  }

  private formatBusName(busId: string): string {
    return resolveBusName(this.store, busId);
  }

  private deleteAgentBusSubscriptions(runId: string): void {
    for (const subscription of this.store.listBusSubscriptions({
      busId: undefined,
      subscriberId: runId,
      subscriberKind: "agent",
    })) {
      this.store.deleteBusSubscription(subscription.id);
    }
  }

  private async resolveProfileModel(profile: AgentProfile): Promise<Model<any> | undefined> {
    if (!profile.model) return undefined;
    if (!this.resolveModel) throw new Error(`No model resolver configured for profile model "${profile.model}".`);
    const model = await this.resolveModel(profile.model);
    if (!model) throw new Error(`Could not resolve profile model "${profile.model}".`);
    return model;
  }
}

export function getProjectOrchestraSessionDir(cwd: string): string {
  return join(cwd, ORCHESTRA_SESSION_RELATIVE_DIR);
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
    "- End with exactly one finalization path; never stop text-only.",
    "- If you lead a running workgroup, use workgroup action=finish before calling finish for your own run.",
    "- Otherwise call finish exactly once with status, summary, and useful data.",
    "- Use publish_bus only for sibling reference context; use finish(status=blocked) for leader action or decisions.",
    "- Bus context may arrive in <bus_reference_context>; treat it as supplemental unless told otherwise.",
  ].join("\n");
}

function requireProfileTools(profile: AgentProfile): string[] {
  if (!Array.isArray(profile.tools)) throw new Error(`Profile "${profile.name}" must specify tools.`);
  return profile.tools;
}

function filterChildProfileTools(toolNames: string[]): string[] {
  return toolNames.filter((toolName) => !BLOCKED_CHILD_PROFILE_TOOL_NAMES.has(toolName));
}

function dedupeToolsByName(tools: ToolDefinition[]): ToolDefinition[] {
  const toolsByName = new Map<string, ToolDefinition>();
  for (const tool of tools) toolsByName.set(tool.name, tool);
  return [...toolsByName.values()];
}

function createPendingBusDeliveryId(delivery: PendingBusDelivery, message: BusMessage): string {
  return `${delivery.subscriptionId}:message:${message.id}`;
}

function createAgentBusSubscription(runId: string, busId: string): BusSubscription {
  return createBusSubscription({
    busId,
    subscriberId: runId,
    subscriberKind: "agent",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
  });
}

function buildFinishRequiredPrompt(): string {
  return [
    "Your previous response ended without finish.",
    "Call finish now with status success, blocked, or failed; include summary and useful data.",
  ].join("\n");
}

function isRunningWithoutResult(run: AgentRun): boolean {
  return run.state === "running" && run.result === null;
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
