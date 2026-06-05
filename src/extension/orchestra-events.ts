import { isBusMessageDelivered, markBusMessagesDelivered, type BusMessage } from "../core/bus.ts";
import type { AgentRun, AgentRunResult, AgentState } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupStrategy } from "../core/workgroup.ts";
import { formatNamedEntityLabel, isAgentRunActive, isTerminalAgentState, toAgentRunResult } from "../utils.ts";

export const ORCHESTRA_EVENT_CUSTOM_TYPE = "pi-orchestra.event";

export type OrchestraMainEvent =
  | {
      type: "subagent.finished";
      busId: string;
      run: AgentRunResult;
    }
  | {
      type: "workgroup.member_finished";
      busId: string;
      strategy: WorkgroupStrategy;
      run: AgentRunResult;
      pendingRunIds: string[];
    }
  | {
      type: "workflow.finished";
      workflow: WorkflowRun;
    }
  | {
      type: "bus.message";
      busId: string;
      message: BusMessage;
    };

export interface WorkgroupRegistration {
  busId: string;
  strategy: WorkgroupStrategy;
  runIds: string[];
}

export interface OrchestraEventControllerOptions {
  store: AgentStore;
  sendEvents: (events: OrchestraMainEvent[], content: string) => void;
  /** Defaults to 50 ms when undefined. Use 0 in tests for immediate delivery. */
  flushDelayMs: number | undefined;
}

interface RegisteredWorkgroup {
  strategy: WorkgroupStrategy;
  runIds: Set<string>;
}

interface LaunchingWorkgroup {
  strategy: WorkgroupStrategy;
  finishedRunIds: Set<string>;
}

interface BusMessageDelivery {
  subscriptionId: string;
  message: BusMessage;
}

export class OrchestraEventController {
  private readonly store: AgentStore;
  private readonly sendEvents: OrchestraEventControllerOptions["sendEvents"];
  private readonly flushDelayMs: number;
  private readonly runFinished = new Map<string, boolean>();
  private readonly workflowStates = new Map<string, AgentState>();
  private readonly mainWorkgroupsByBusId = new Map<string, RegisteredWorkgroup>();
  private readonly launchingWorkgroupsByBusId = new Map<string, LaunchingWorkgroup>();
  private readonly queuedEvents: OrchestraMainEvent[] = [];
  private readonly queuedBusMessageDeliveries: BusMessageDelivery[] = [];
  private readonly unsubscribeRuns: () => void;
  private readonly unsubscribeBusMessages: () => void;
  private readonly unsubscribeWorkflows: () => void;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: OrchestraEventControllerOptions) {
    this.store = options.store;
    this.sendEvents = options.sendEvents;
    this.flushDelayMs = options.flushDelayMs ?? 50;

    for (const run of this.store.listRuns()) this.runFinished.set(run.id, isAgentFinishRun(run));
    for (const workflow of this.store.listWorkflows()) this.workflowStates.set(workflow.id, workflow.state);

    this.unsubscribeRuns = this.store.subscribeRuns((run) => this.handleRunSaved(run), undefined);
    this.unsubscribeBusMessages = this.store.subscribeBusMessages(
      (event) => this.handleBusMessageSaved(event),
      undefined,
    );
    this.unsubscribeWorkflows = this.store.subscribeWorkflows(
      (workflow) => this.handleWorkflowSaved(workflow),
      undefined,
    );
  }

  beginWorkgroup(busId: string, strategy: WorkgroupStrategy): void {
    this.launchingWorkgroupsByBusId.set(busId, { strategy, finishedRunIds: new Set() });
  }

  registerWorkgroup(registration: WorkgroupRegistration): void {
    const launching = this.launchingWorkgroupsByBusId.get(registration.busId);
    const existing = this.mainWorkgroupsByBusId.get(registration.busId);
    const runIds = new Set<string>(existing?.runIds);
    for (const runId of launching?.finishedRunIds ?? []) runIds.add(runId);
    for (const runId of registration.runIds) runIds.add(runId);

    this.mainWorkgroupsByBusId.set(registration.busId, {
      strategy: registration.strategy,
      runIds,
    });
    this.launchingWorkgroupsByBusId.delete(registration.busId);
  }

  cancelWorkgroupLaunch(busId: string): void {
    this.launchingWorkgroupsByBusId.delete(busId);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queuedEvents.length = 0;
    this.queuedBusMessageDeliveries.length = 0;
    this.unsubscribeRuns();
    this.unsubscribeBusMessages();
    this.unsubscribeWorkflows();
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queuedEvents.length === 0) return;

    const events = [...this.queuedEvents];
    const busMessageDeliveries = [...this.queuedBusMessageDeliveries];
    this.sendEvents(events, formatOrchestraEvents(events));
    this.queuedEvents.splice(0, events.length);
    this.queuedBusMessageDeliveries.splice(0, busMessageDeliveries.length);
    for (const delivery of busMessageDeliveries) this.markBusMessageDelivered(delivery);
  }

  private handleRunSaved(run: AgentRun): void {
    const wasFinished = this.runFinished.get(run.id) ?? false;
    const isFinished = isAgentFinishRun(run);
    this.runFinished.set(run.id, isFinished);

    if (!isFinished || wasFinished) return;
    if (this.isWorkflowBus(run.busId)) return;

    const registeredWorkgroup = this.mainWorkgroupsByBusId.get(run.busId);
    if (registeredWorkgroup?.runIds.has(run.id)) {
      this.queueEvent({
        type: "workgroup.member_finished",
        busId: run.busId,
        strategy: registeredWorkgroup.strategy,
        run: toAgentRunResult(run),
        pendingRunIds: this.getPendingWorkgroupRunIds(run.busId, registeredWorkgroup.runIds),
      });
      return;
    }

    const launchingWorkgroup = this.launchingWorkgroupsByBusId.get(run.busId);
    if (launchingWorkgroup) {
      launchingWorkgroup.finishedRunIds.add(run.id);
      this.queueEvent({
        type: "workgroup.member_finished",
        busId: run.busId,
        strategy: launchingWorkgroup.strategy,
        run: toAgentRunResult(run),
        pendingRunIds: this.getPendingBusRunIds(run.busId),
      });
      return;
    }

    this.queueEvent({ type: "subagent.finished", busId: run.busId, run: toAgentRunResult(run) });
  }

  private handleBusMessageSaved(event: { busId: string; message: BusMessage }): void {
    if (event.message.from === "main") return;

    const subscriptions = this.store.listBusSubscriptions({
      busId: event.busId,
      subscriberId: "main",
      subscriberKind: "main",
    });
    for (const subscription of subscriptions) {
      if (isBusMessageDelivered(subscription, event.message.id)) continue;
      if (this.hasQueuedBusMessageDelivery(subscription.id, event.message.id)) continue;

      this.queuedBusMessageDeliveries.push({ subscriptionId: subscription.id, message: event.message });
      this.queueEvent({ type: "bus.message", busId: event.busId, message: event.message });
    }
  }

  private handleWorkflowSaved(workflow: WorkflowRun): void {
    const previousState = this.workflowStates.get(workflow.id);
    this.workflowStates.set(workflow.id, workflow.state);

    if (!isTerminalAgentState(workflow.state) || (previousState !== undefined && isTerminalAgentState(previousState)))
      return;
    this.queueEvent({ type: "workflow.finished", workflow });
  }

  private isWorkflowBus(busId: string): boolean {
    return this.store.listWorkflows().some((workflow) => workflow.stages.some((stage) => stage.busId === busId));
  }

  private getPendingWorkgroupRunIds(busId: string, runIds: Set<string>): string[] {
    return this.store
      .listRuns()
      .filter((run) => run.busId === busId && runIds.has(run.id) && isAgentRunActive(run))
      .map((run) => run.id);
  }

  private getPendingBusRunIds(busId: string): string[] {
    return this.store
      .listRuns()
      .filter((run) => run.busId === busId && isAgentRunActive(run))
      .map((run) => run.id);
  }

  private hasQueuedBusMessageDelivery(subscriptionId: string, messageId: string): boolean {
    return this.queuedBusMessageDeliveries.some(
      (delivery) => delivery.subscriptionId === subscriptionId && delivery.message.id === messageId,
    );
  }

  private markBusMessageDelivered(delivery: BusMessageDelivery): void {
    const subscription = this.store.getBusSubscription(delivery.subscriptionId);
    if (!subscription) return;

    this.store.saveBusSubscription(markBusMessagesDelivered(subscription, delivery.message));
  }

  private queueEvent(event: OrchestraMainEvent): void {
    this.queuedEvents.push(event);
    if (this.flushDelayMs === 0) {
      this.flush();
      return;
    }

    this.flushTimer ??= setTimeout(() => this.flush(), this.flushDelayMs);
  }
}

export function formatOrchestraEvents(events: OrchestraMainEvent[]): string {
  const headline = events.length === 1 ? "Pi-orchestra event:" : `Pi-orchestra events (${events.length}):`;
  return [headline, ...events.flatMap((event) => ["", formatOrchestraEvent(event)])].join("\n");
}

function formatOrchestraEvent(event: OrchestraMainEvent): string {
  if (event.type === "workflow.finished") return formatWorkflowFinishedEvent(event.workflow);
  if (event.type === "bus.message") return formatBusMessageEvent(event);

  const runLabel = event.run.name === event.run.runId ? event.run.runId : `${event.run.name} (${event.run.runId})`;
  const lines =
    event.type === "workgroup.member_finished"
      ? [
          `- Workgroup member finished on bus ${event.busId}: ${runLabel} ${formatRunFinishedState(event.run)}.`,
          `  Strategy: ${event.strategy}`,
          `  Pending workgroup run ids: ${event.pendingRunIds.length > 0 ? event.pendingRunIds.join(", ") : "none"}`,
        ]
      : [`- Subagent finished on bus ${event.busId}: ${runLabel} ${formatRunFinishedState(event.run)}.`];

  lines.push(...formatRunResultLines(event.run));
  return lines.join("\n");
}

function formatBusMessageEvent(event: Extract<OrchestraMainEvent, { type: "bus.message" }>): string {
  return [`- Bus message on ${event.busId} from ${event.message.from}:`, event.message.message].join("\n");
}

function formatWorkflowFinishedEvent(workflow: WorkflowRun): string {
  const lines = [`- Workflow finished: ${formatNamedEntityLabel(workflow)} is ${workflow.state}.`];
  if (workflow.result) {
    lines.push(`  Result: ${workflow.result.status}`, `  Summary: ${workflow.result.summary}`);
  }
  if (workflow.error) lines.push(`  Error: ${workflow.error}`);
  return lines.join("\n");
}

function formatRunResultLines(run: AgentRunResult): string[] {
  if (!run.result) return ["  No result payload recorded."];

  const lines = [`  Result: ${run.result.status}`, `  Summary: ${run.result.summary}`];
  if (run.result.data !== undefined) lines.push(`  Data: ${JSON.stringify(run.result.data)}`);
  return lines;
}

function formatRunFinishedState(run: AgentRunResult): string {
  return run.result ? `finished with ${run.result.status}; state=${run.state}` : `is ${run.state}`;
}

function isAgentFinishRun(run: AgentRun | AgentRunResult): boolean {
  return run.result !== undefined || isAgentResultState(run.state);
}

function isAgentResultState(state: AgentState | undefined): boolean {
  return state === "success" || state === "blocked" || state === "failed";
}
