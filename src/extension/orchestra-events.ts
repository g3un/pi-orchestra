import { closeBusRecord, closeStandalonePrivateBusIfUnused } from "../core/auto-bus.ts";
import {
  isBusMessageDelivered,
  markBusMessageDeliveredForSubscriber,
  markBusMessagesDelivered,
  type BusMessage,
} from "../core/bus.ts";
import type { AgentRun, AgentRunResult } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkgroupRun, WorkgroupState } from "../core/workgroup.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { formatBoundedInlineData, formatBusMessageText, formatFullResultData } from "../formatting.ts";
import { isAgentRunActive, isAgentRunFinished, resolveBusName, resolveRunName, toAgentRunResult } from "../utils.ts";

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
      run: AgentRunResult;
      pendingRunIds: string[];
    }
  | {
      type: "workgroup.finished";
      workgroup: WorkgroupRun;
    }
  | {
      type: "workflow.workgroup_finished";
      workflowId: string;
      workgroup: WorkgroupRun;
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

export interface WorkgroupLaunchRegistration {
  busId: string;
  leaderRunId: string | null;
  runIds: string[];
  runNames?: string[];
}

export type WorkgroupRegistration = WorkgroupLaunchRegistration;

export interface OrchestraEventControllerOptions {
  store: AgentStore;
  sendEvents: (events: OrchestraMainEvent[], content: string) => void;
  sendAgentEvents?: (runId: string, events: OrchestraMainEvent[], content: string) => unknown;
  isRunWaiting: ((runId: string) => boolean) | undefined;
  /** Uses 50 ms when undefined. Set 0 in tests for immediate delivery. */
  flushDelayMs: number | undefined;
}

interface RegisteredWorkgroup {
  runIds: Set<string>;
}

interface LaunchingWorkgroup {
  finishedRunIds: Set<string>;
  leaderRunId: string | null;
  runIds: Set<string>;
  runNames: Set<string>;
}

interface BusMessageDelivery {
  subscriptionId: string;
  message: BusMessage;
}

interface FormatOrchestraEventsOptions {
  formatBusMessageFrom?: (from: string) => string;
  formatBusName?: (busId: string) => string;
  formatRunName?: (runId: string) => string;
  boundedResultData?: boolean;
}

export class OrchestraEventController {
  private readonly store: AgentStore;
  private readonly sendEvents: OrchestraEventControllerOptions["sendEvents"];
  private readonly sendAgentEvents: NonNullable<OrchestraEventControllerOptions["sendAgentEvents"]> | undefined;
  private readonly isRunWaiting: OrchestraEventControllerOptions["isRunWaiting"];
  private readonly flushDelayMs: number;
  private readonly runFinished = new Map<string, boolean>();
  private readonly workgroupMemberRunIndexes = new Map<string, string[]>();
  private readonly workgroupIdByMemberRunId = new Map<string, string>();
  private readonly workgroupLeaderRunIndexes = new Map<string, string | null>();
  private readonly workgroupIdByLeaderRunId = new Map<string, string>();
  private readonly workgroupStates = new Map<string, WorkgroupState>();
  private readonly workflowClosed = new Map<string, boolean>();
  private readonly mainWorkgroupsByBusId = new Map<string, RegisteredWorkgroup>();
  private readonly launchingWorkgroupsByBusId = new Map<string, LaunchingWorkgroup>();
  private readonly queuedEvents: OrchestraMainEvent[] = [];
  private readonly queuedBusMessageDeliveries: BusMessageDelivery[] = [];
  private readonly suppressedRunFinishIds = new Set<string>();
  private readonly suppressedWorkgroupFinishIds = new Set<string>();
  private readonly unsubscribeRuns: () => void;
  private readonly unsubscribeBusMessages: () => void;
  private readonly unsubscribeWorkgroups: () => void;
  private readonly unsubscribeWorkflows: () => void;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: OrchestraEventControllerOptions) {
    this.store = options.store;
    this.sendEvents = options.sendEvents;
    this.sendAgentEvents = options.sendAgentEvents;
    this.isRunWaiting = options.isRunWaiting;
    this.flushDelayMs = options.flushDelayMs ?? 50;

    for (const run of this.store.listRuns()) {
      this.runFinished.set(run.id, isAgentRunFinished(run));
    }
    for (const workgroup of this.store.listWorkgroups()) {
      this.workgroupStates.set(workgroup.id, workgroup.state);
      this.indexWorkgroup(workgroup);
    }
    for (const workflow of this.store.listWorkflows()) {
      this.workflowClosed.set(workflow.id, workflow.state === "closed");
    }

    this.unsubscribeRuns = this.store.subscribeRuns((run) => this.handleRunSaved(run), undefined);
    this.unsubscribeBusMessages = this.store.subscribeBusMessages(
      (event) => this.handleBusMessageSaved(event),
      undefined,
    );
    this.unsubscribeWorkgroups = this.store.subscribeWorkgroups(
      (workgroup) => this.handleWorkgroupSaved(workgroup),
      undefined,
    );
    this.unsubscribeWorkflows = this.store.subscribeWorkflows(
      (workflow) => this.handleWorkflowSaved(workflow),
      undefined,
    );
  }

  beginWorkgroup(registration: WorkgroupLaunchRegistration): void {
    this.launchingWorkgroupsByBusId.set(registration.busId, {
      finishedRunIds: new Set(),
      leaderRunId: registration.leaderRunId,
      runIds: new Set(registration.runIds),
      runNames: new Set(registration.runNames ?? []),
    });
  }

  registerWorkgroup(registration: WorkgroupRegistration): void {
    const launching = this.launchingWorkgroupsByBusId.get(registration.busId);
    this.launchingWorkgroupsByBusId.delete(registration.busId);

    if (registration.leaderRunId) return;

    const existing = this.mainWorkgroupsByBusId.get(registration.busId);
    const runIds = new Set<string>(existing?.runIds);
    for (const runId of launching?.finishedRunIds ?? []) runIds.add(runId);
    for (const runId of registration.runIds) runIds.add(runId);

    this.mainWorkgroupsByBusId.set(registration.busId, { runIds });
  }

  cancelWorkgroupLaunch(busId: string, options: { suppressRunIds: string[] } = { suppressRunIds: [] }): void {
    this.launchingWorkgroupsByBusId.delete(busId);
    for (const runId of options.suppressRunIds) this.suppressedRunFinishIds.add(runId);
  }

  suppressRunFinish(runId: string): void {
    this.suppressedRunFinishIds.add(runId);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queuedEvents.length = 0;
    this.queuedBusMessageDeliveries.length = 0;
    this.unsubscribeRuns();
    this.unsubscribeBusMessages();
    this.unsubscribeWorkgroups();
    this.unsubscribeWorkflows();
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queuedEvents.length === 0) return;

    const events = [...this.queuedEvents];
    const busMessageDeliveries = [...this.queuedBusMessageDeliveries];
    this.sendEvents(events, formatOrchestraEvents(events, this.createFormatOptions()));
    this.queuedEvents.splice(0, events.length);
    this.queuedBusMessageDeliveries.splice(0, busMessageDeliveries.length);
    for (const delivery of busMessageDeliveries) this.markBusMessageDelivered(delivery);
  }

  private handleRunSaved(run: AgentRun): void {
    const launchingWorkgroup = this.launchingWorkgroupsByBusId.get(run.busId);
    if (launchingWorkgroup?.runNames.has(run.name)) launchingWorkgroup.runIds.add(run.id);

    const wasFinished = this.runFinished.get(run.id) ?? false;
    const isFinished = isAgentRunFinished(run);
    if (run.state === "closed") this.closeOwnStandaloneBusIfUnused(run);

    this.runFinished.set(run.id, isFinished);

    if (!isFinished || wasFinished) return;
    if (this.suppressedRunFinishIds.delete(run.id)) return;

    this.closeOwnStandaloneBusIfUnused(run);

    const persistedWorkgroup = this.findWorkgroupForMemberRun(run.id);
    if (persistedWorkgroup) {
      if (persistedWorkgroup.state !== "running") return;
      const event = {
        type: "workgroup.member_finished" as const,
        busId: run.busId,
        run: toAgentRunResult(run),
        pendingRunIds: this.getPendingWorkgroupRunIds(run.busId, new Set(persistedWorkgroup.memberRunIds)),
      };
      if (persistedWorkgroup.leaderRunId) {
        const delivery = this.deliverToRun(persistedWorkgroup.leaderRunId, event);
        if (delivery === "delivered") return;
      }
      this.queueEvent(event);
      return;
    }

    if (launchingWorkgroup?.runIds.has(run.id)) {
      launchingWorkgroup.finishedRunIds.add(run.id);
      const event = {
        type: "workgroup.member_finished" as const,
        busId: run.busId,
        run: toAgentRunResult(run),
        pendingRunIds: this.getPendingWorkgroupRunIds(run.busId, launchingWorkgroup.runIds),
      };
      if (launchingWorkgroup.leaderRunId) {
        const delivery = this.deliverToRun(launchingWorkgroup.leaderRunId, event);
        if (delivery === "delivered") return;
      }
      this.queueEvent(event);
      return;
    }

    const parentEvent = {
      type: "subagent.finished" as const,
      busId: run.busId,
      run: toAgentRunResult(run),
    };
    if (run.parentRunId) {
      const delivery = this.deliverToRun(run.parentRunId, parentEvent);
      if (delivery === "delivered") return;
      this.queueEvent(parentEvent);
      return;
    }

    const registeredWorkgroup = this.mainWorkgroupsByBusId.get(run.busId);
    if (registeredWorkgroup?.runIds.has(run.id)) {
      this.queueEvent({
        type: "workgroup.member_finished",
        busId: run.busId,
        run: toAgentRunResult(run),
        pendingRunIds: this.getPendingWorkgroupRunIds(run.busId, registeredWorkgroup.runIds),
      });
      return;
    }

    this.queueEvent({ type: "subagent.finished", busId: run.busId, run: toAgentRunResult(run) });
  }

  private handleBusMessageSaved(event: { busId: string; message: BusMessage }): void {
    if (event.message.from === "main") {
      this.markMainBusMessageDelivered(event.busId, event.message);
      return;
    }

    const subscriptions = this.store.listBusSubscriptions({
      busId: event.busId,
      subscriberId: "main",
      subscriberKind: "main",
    });
    for (const subscription of subscriptions) {
      if (isBusMessageDelivered(subscription, event.message)) continue;
      if (this.hasQueuedBusMessageDelivery(subscription.id, event.message.id)) continue;

      this.queuedBusMessageDeliveries.push({ subscriptionId: subscription.id, message: event.message });
      this.queueEvent({ type: "bus.message", busId: event.busId, message: event.message });
    }
  }

  private closeOwnStandaloneBusIfUnused(run: AgentRun): void {
    closeStandalonePrivateBusIfUnused(this.store, (busId) => closeBusRecord(this.store, busId), run.busId);
  }

  private handleWorkgroupSaved(workgroup: WorkgroupRun): void {
    const previousState = this.workgroupStates.get(workgroup.id);
    this.workgroupStates.set(workgroup.id, workgroup.state);
    this.indexWorkgroup(workgroup);

    if (workgroup.state !== "closed" || previousState === "closed") return;
    if (this.suppressedWorkgroupFinishIds.delete(workgroup.id)) return;

    const workflow = this.findWorkflowForWorkgroup(workgroup.id);
    if (workflow) {
      if (workflow.state !== "running") return;
      const event = { type: "workflow.workgroup_finished" as const, workflowId: workflow.id, workgroup };
      if (this.deliverToRun(workflow.coordinatorRunId, event) === "delivered") return;
      this.queueEvent(event);
      return;
    }

    const event = { type: "workgroup.finished" as const, workgroup };
    if (workgroup.leaderRunId && this.isRunWaiting?.(workgroup.leaderRunId)) {
      this.deliverToRun(workgroup.leaderRunId, event);
    }
    this.queueEvent(event);
  }

  private handleWorkflowSaved(workflow: WorkflowRun): void {
    const wasClosed = this.workflowClosed.get(workflow.id) ?? false;
    const isClosed = workflow.state === "closed";
    this.workflowClosed.set(workflow.id, isClosed);
    if (!isClosed || wasClosed) return;
    this.queueEvent({ type: "workflow.finished", workflow });
  }

  private deliverToRun(runId: string, event: OrchestraMainEvent): "delivered" | "inactive" | "unreachable" {
    const run = this.store.getRun(runId);
    if (!run) return "unreachable";
    if (!isAgentRunActive(run) || !this.sendAgentEvents) return "inactive";
    return this.sendAgentEvents(
      runId,
      [event],
      formatOrchestraEvents([event], { ...this.createFormatOptions(), boundedResultData: false }),
    ) === false
      ? "inactive"
      : "delivered";
  }

  private findWorkflowForWorkgroup(workgroupId: string): WorkflowRun | undefined {
    return this.store.listWorkflows().find((workflow) => workflow.workgroupIds.includes(workgroupId));
  }

  private findWorkgroupForMemberRun(runId: string) {
    const workgroupId = this.workgroupIdByMemberRunId.get(runId);
    return workgroupId ? this.store.getWorkgroup(workgroupId) : undefined;
  }

  private indexWorkgroup(workgroup: WorkgroupRun): void {
    const previousMemberRunIds = this.workgroupMemberRunIndexes.get(workgroup.id) ?? [];
    for (const runId of previousMemberRunIds) {
      if (this.workgroupIdByMemberRunId.get(runId) === workgroup.id) this.workgroupIdByMemberRunId.delete(runId);
    }

    const previousLeaderRunId = this.workgroupLeaderRunIndexes.get(workgroup.id);
    if (previousLeaderRunId && this.workgroupIdByLeaderRunId.get(previousLeaderRunId) === workgroup.id) {
      this.workgroupIdByLeaderRunId.delete(previousLeaderRunId);
    }

    this.workgroupMemberRunIndexes.set(workgroup.id, [...workgroup.memberRunIds]);
    for (const runId of workgroup.memberRunIds) this.workgroupIdByMemberRunId.set(runId, workgroup.id);

    this.workgroupLeaderRunIndexes.set(workgroup.id, workgroup.leaderRunId);
    if (workgroup.leaderRunId) {
      this.workgroupIdByLeaderRunId.set(workgroup.leaderRunId, workgroup.id);
    }
  }

  private getPendingWorkgroupRunIds(busId: string, runIds: Set<string>): string[] {
    return [...runIds].filter((runId) => {
      const run = this.store.getRun(runId);
      return run !== undefined && run.busId === busId && isAgentRunActive(run);
    });
  }

  private hasQueuedBusMessageDelivery(subscriptionId: string, messageId: string): boolean {
    return this.queuedBusMessageDeliveries.some(
      (delivery) => delivery.subscriptionId === subscriptionId && delivery.message.id === messageId,
    );
  }

  private createFormatOptions(): FormatOrchestraEventsOptions {
    return {
      formatBusMessageFrom: (from) => this.formatBusMessageFrom(from),
      formatBusName: (busId) => this.formatBusName(busId),
      formatRunName: (runId) => this.formatRunName(runId),
    };
  }

  private formatBusMessageFrom(from: string): string {
    if (from === "main") return from;
    return this.formatRunName(from);
  }

  private formatBusName(busId: string): string {
    return resolveBusName(this.store, busId);
  }

  private formatRunName(runId: string): string {
    return resolveRunName(this.store, runId);
  }

  private markBusMessageDelivered(delivery: BusMessageDelivery): void {
    const subscription = this.store.getBusSubscription(delivery.subscriptionId);
    if (!subscription) return;

    this.store.saveBusSubscription(markBusMessagesDelivered(subscription, delivery.message));
  }

  private markMainBusMessageDelivered(busId: string, message: BusMessage): void {
    markBusMessageDeliveredForSubscriber(this.store, busId, "main", "main", message);
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

export function formatOrchestraEvents(events: OrchestraMainEvent[], options?: FormatOrchestraEventsOptions): string {
  const headline = events.length === 1 ? "Pi-orchestra event:" : `Pi-orchestra events (${events.length}):`;
  return [headline, ...events.flatMap((event) => ["", formatOrchestraEvent(event, options)])].join("\n");
}

function formatOrchestraEvent(event: OrchestraMainEvent, options: FormatOrchestraEventsOptions | undefined): string {
  if (event.type === "workgroup.finished") return formatWorkgroupFinishedEvent(event.workgroup, options);
  if (event.type === "workflow.workgroup_finished") return formatWorkflowWorkgroupFinishedEvent(event, options);
  if (event.type === "workflow.finished") return formatWorkflowFinishedEvent(event.workflow, options);
  if (event.type === "bus.message") return formatBusMessageEvent(event, options);

  const busName = options?.formatBusName?.(event.busId) ?? event.busId;
  const runLabel = event.run.name;
  const lines =
    event.type === "workgroup.member_finished"
      ? [
          `- Workgroup member finished on bus ${busName}: ${runLabel} ${formatRunFinishedState(event.run)}.`,
          `  Pending workgroup runs: ${formatPendingRunNames(event.pendingRunIds, options)}`,
        ]
      : [`- Subagent finished on bus ${busName}: ${runLabel} ${formatRunFinishedState(event.run)}.`];

  lines.push(...formatRunResultLines(event.run, options));
  return lines.join("\n");
}

function formatBusMessageEvent(
  event: Extract<OrchestraMainEvent, { type: "bus.message" }>,
  options: FormatOrchestraEventsOptions | undefined,
): string {
  const from = options?.formatBusMessageFrom?.(event.message.from) ?? event.message.from;
  const busName = options?.formatBusName?.(event.busId) ?? event.busId;
  return [`- Bus message on ${busName} from ${from}:`, formatBusMessageText(event.message.message)].join("\n");
}

function formatPendingRunNames(runIds: string[], options: FormatOrchestraEventsOptions | undefined): string {
  if (runIds.length === 0) return "none";
  return runIds.map((runId) => options?.formatRunName?.(runId) ?? runId).join(", ");
}

function formatWorkflowWorkgroupFinishedEvent(
  event: Extract<OrchestraMainEvent, { type: "workflow.workgroup_finished" }>,
  options: FormatOrchestraEventsOptions | undefined,
): string {
  return [
    `- Workflow workgroup finished: ${event.workgroup.name} is ${event.workgroup.state}.`,
    ...formatWorkgroupResultLines(event.workgroup, options),
  ].join("\n");
}

function formatWorkflowFinishedEvent(workflow: WorkflowRun, options: FormatOrchestraEventsOptions | undefined): string {
  const lines = [`- Workflow finished: ${workflow.name} is ${workflow.state}.`];
  if (workflow.result) {
    lines.push(`  Result: ${workflow.result.status}`, `  Summary: ${workflow.result.summary}`);
    if (workflow.result.data !== undefined)
      lines.push(`  Data: ${formatEventResultData(workflow.result.data, options)}`);
  }
  return lines.join("\n");
}

function formatWorkgroupFinishedEvent(
  workgroup: WorkgroupRun,
  options: FormatOrchestraEventsOptions | undefined,
): string {
  const lines = [`- Workgroup finished: ${workgroup.name} is ${workgroup.state}.`];
  lines.push(...formatWorkgroupResultLines(workgroup, options));
  return lines.join("\n");
}

function formatWorkgroupResultLines(
  workgroup: WorkgroupRun,
  options: FormatOrchestraEventsOptions | undefined,
): string[] {
  if (!workgroup.result) return [];
  const lines = [`  Result: ${workgroup.result.status}`, `  Summary: ${workgroup.result.summary}`];
  if (workgroup.result.data !== undefined)
    lines.push(`  Data: ${formatEventResultData(workgroup.result.data, options)}`);
  return lines;
}

function formatRunResultLines(run: AgentRunResult, options: FormatOrchestraEventsOptions | undefined): string[] {
  if (run.result === null) return ["  No result payload recorded."];

  const lines = [`  Result: ${run.result.status}`, `  Summary: ${run.result.summary}`];
  if (run.result.data !== undefined) lines.push(`  Data: ${formatEventResultData(run.result.data, options)}`);
  return lines;
}

function formatEventResultData(data: unknown, options: FormatOrchestraEventsOptions | undefined): string {
  return options?.boundedResultData === false ? formatFullResultData(data) : formatBoundedInlineData(data);
}

function formatRunFinishedState(run: AgentRunResult): string {
  return run.result ? `finished with ${run.result.status}; state=${run.state}` : `is ${run.state}`;
}
