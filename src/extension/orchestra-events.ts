import { isBusMessageDelivered, markBusMessagesDelivered, type BusMessage } from "../core/bus.ts";
import type { AgentRun, AgentRunResult } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun, WorkgroupState } from "../core/workgroup.ts";
import { isAgentRunActive, resolveBusName, resolveRunName, toAgentRunResult } from "../utils.ts";

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

export interface WorkgroupLeaderFailedEvent {
  workgroup: WorkgroupRun;
  run: AgentRunResult;
}

export interface OrchestraEventControllerOptions {
  store: AgentStore;
  sendEvents: (events: OrchestraMainEvent[], content: string) => void;
  sendAgentEvents?: (runId: string, events: OrchestraMainEvent[], content: string) => void;
  onWorkgroupLeaderFailed?: (event: WorkgroupLeaderFailedEvent) => void;
  /** Defaults to 50 ms when undefined. Use 0 in tests for immediate delivery. */
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
}

export class OrchestraEventController {
  private readonly store: AgentStore;
  private readonly sendEvents: OrchestraEventControllerOptions["sendEvents"];
  private readonly sendAgentEvents: NonNullable<OrchestraEventControllerOptions["sendAgentEvents"]> | undefined;
  private readonly onWorkgroupLeaderFailed: OrchestraEventControllerOptions["onWorkgroupLeaderFailed"];
  private readonly flushDelayMs: number;
  private readonly runFinished = new Map<string, boolean>();
  private readonly workflowStates = new Map<string, WorkflowRun["state"]>();
  private readonly workflowIndexes = new Map<string, { busId: string; workgroupIds: string[] }>();
  private readonly workflowIdByWorkgroupId = new Map<string, string>();
  private readonly workflowIdByBusId = new Map<string, string>();
  private readonly workgroupMemberRunIndexes = new Map<string, string[]>();
  private readonly workgroupIdByMemberRunId = new Map<string, string>();
  private readonly workgroupLeaderRunIndexes = new Map<string, string | null>();
  private readonly workgroupIdByLeaderRunId = new Map<string, string>();
  private readonly workgroupStates = new Map<string, WorkgroupState>();
  private readonly mainWorkgroupsByBusId = new Map<string, RegisteredWorkgroup>();
  private readonly launchingWorkgroupsByBusId = new Map<string, LaunchingWorkgroup>();
  private readonly queuedEvents: OrchestraMainEvent[] = [];
  private readonly queuedBusMessageDeliveries: BusMessageDelivery[] = [];
  private readonly suppressedRunFinishIds = new Set<string>();
  private readonly unsubscribeRuns: () => void;
  private readonly unsubscribeBusMessages: () => void;
  private readonly unsubscribeWorkflows: () => void;
  private readonly unsubscribeWorkgroups: () => void;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: OrchestraEventControllerOptions) {
    this.store = options.store;
    this.sendEvents = options.sendEvents;
    this.sendAgentEvents = options.sendAgentEvents;
    this.onWorkgroupLeaderFailed = options.onWorkgroupLeaderFailed;
    this.flushDelayMs = options.flushDelayMs ?? 50;

    for (const run of this.store.listRuns()) this.runFinished.set(run.id, isAgentFinishRun(run));
    for (const workflow of this.store.listWorkflows()) {
      this.workflowStates.set(workflow.id, workflow.state);
      this.indexWorkflow(workflow);
    }
    for (const workgroup of this.store.listWorkgroups()) {
      this.workgroupStates.set(workgroup.id, workgroup.state);
      this.indexWorkgroup(workgroup);
    }

    this.unsubscribeRuns = this.store.subscribeRuns((run) => this.handleRunSaved(run), undefined);
    this.unsubscribeBusMessages = this.store.subscribeBusMessages(
      (event) => this.handleBusMessageSaved(event),
      undefined,
    );
    this.unsubscribeWorkflows = this.store.subscribeWorkflows(
      (workflow) => this.handleWorkflowSaved(workflow),
      undefined,
    );
    this.unsubscribeWorkgroups = this.store.subscribeWorkgroups(
      (workgroup) => this.handleWorkgroupSaved(workgroup),
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

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queuedEvents.length = 0;
    this.queuedBusMessageDeliveries.length = 0;
    this.unsubscribeRuns();
    this.unsubscribeBusMessages();
    this.unsubscribeWorkflows();
    this.unsubscribeWorkgroups();
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
    const isFinished = isAgentFinishRun(run);
    this.runFinished.set(run.id, isFinished);

    if (!isFinished || wasFinished) return;
    if (this.suppressedRunFinishIds.delete(run.id)) return;

    const persistedWorkgroup = this.findWorkgroupForMemberRun(run.id);
    if (persistedWorkgroup) {
      if (persistedWorkgroup.state !== "running") return;
      const event = {
        type: "workgroup.member_finished" as const,
        busId: run.busId,
        run: toAgentRunResult(run),
        pendingRunIds: this.getPendingWorkgroupRunIds(run.busId, new Set(persistedWorkgroup.memberRunIds)),
      };
      if (persistedWorkgroup.leaderRunId && this.sendLeaderWorkgroupEvent(persistedWorkgroup.leaderRunId, event)) {
        return;
      }
      if (this.findWorkflowForWorkgroup(persistedWorkgroup.id)) return;

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
      if (launchingWorkgroup.leaderRunId && this.sendLeaderWorkgroupEvent(launchingWorkgroup.leaderRunId, event)) {
        return;
      }
      if (this.isWorkflowBus(run.busId)) return;

      this.queueEvent(event);
      return;
    }

    const ledWorkgroup = this.findRunningWorkgroupLedByRun(run.id);
    if (ledWorkgroup) {
      this.onWorkgroupLeaderFailed?.({ workgroup: ledWorkgroup, run: toAgentRunResult(run) });
      return;
    }

    if (this.isWorkflowBus(run.busId)) return;

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
    this.indexWorkflow(workflow);

    if (workflow.state !== "closed" || previousState === "closed") return;
    this.queueEvent({ type: "workflow.finished", workflow });
  }

  private handleWorkgroupSaved(workgroup: WorkgroupRun): void {
    const previousState = this.workgroupStates.get(workgroup.id);
    this.workgroupStates.set(workgroup.id, workgroup.state);
    this.indexWorkgroup(workgroup);

    if (workgroup.state !== "closed" || previousState === "closed") return;

    const workflow = this.findWorkflowForWorkgroup(workgroup.id);
    if (workflow) {
      const event = { type: "workgroup.finished" as const, workgroup };
      if (this.sendWorkflowLeaderEvent(workflow, event)) return;
      if (workflow.state === "running") this.queueEvent(event);
      return;
    }

    this.queueEvent({ type: "workgroup.finished", workgroup });
  }

  private sendLeaderWorkgroupEvent(
    leaderRunId: string,
    event: Extract<OrchestraMainEvent, { type: "workgroup.member_finished" }>,
  ): boolean {
    const leaderRun = this.store.getRun(leaderRunId);
    if (!leaderRun || !isAgentRunActive(leaderRun) || !this.sendAgentEvents) return false;

    this.sendAgentEvents(leaderRunId, [event], formatOrchestraEvents([event], this.createFormatOptions()));
    return true;
  }

  private sendWorkflowLeaderEvent(
    workflow: WorkflowRun,
    event: Extract<OrchestraMainEvent, { type: "workgroup.finished" }>,
  ): boolean {
    if (!workflow.leaderRunId || workflow.state !== "running") return false;
    const leaderRun = this.store.getRun(workflow.leaderRunId);
    if (!leaderRun || !isAgentRunActive(leaderRun) || !this.sendAgentEvents) return false;

    this.sendAgentEvents(leaderRun.id, [event], formatOrchestraEvents([event], this.createFormatOptions()));
    return true;
  }

  private findWorkgroupForMemberRun(runId: string) {
    const workgroupId = this.workgroupIdByMemberRunId.get(runId);
    return workgroupId ? this.store.getWorkgroup(workgroupId) : undefined;
  }

  private findRunningWorkgroupLedByRun(runId: string): WorkgroupRun | undefined {
    const workgroupId = this.workgroupIdByLeaderRunId.get(runId);
    const workgroup = workgroupId ? this.store.getWorkgroup(workgroupId) : undefined;
    return workgroup?.state === "running" ? workgroup : undefined;
  }

  private findWorkflowForWorkgroup(workgroupId: string): WorkflowRun | undefined {
    const workflowId = this.workflowIdByWorkgroupId.get(workgroupId);
    return workflowId ? this.store.getWorkflow(workflowId) : undefined;
  }

  private isWorkflowBus(busId: string): boolean {
    return this.workflowIdByBusId.has(busId);
  }

  private indexWorkflow(workflow: WorkflowRun): void {
    const previous = this.workflowIndexes.get(workflow.id);
    if (previous) {
      if (this.workflowIdByBusId.get(previous.busId) === workflow.id) this.workflowIdByBusId.delete(previous.busId);
      for (const workgroupId of previous.workgroupIds) {
        if (this.workflowIdByWorkgroupId.get(workgroupId) === workflow.id) {
          this.workflowIdByWorkgroupId.delete(workgroupId);
        }
        const workgroup = this.store.getWorkgroup(workgroupId);
        if (workgroup && this.workflowIdByBusId.get(workgroup.busId) === workflow.id) {
          this.workflowIdByBusId.delete(workgroup.busId);
        }
      }
    }

    this.workflowIndexes.set(workflow.id, { busId: workflow.busId, workgroupIds: [...workflow.workgroupIds] });
    this.workflowIdByBusId.set(workflow.busId, workflow.id);
    for (const workgroupId of workflow.workgroupIds) {
      this.workflowIdByWorkgroupId.set(workgroupId, workflow.id);
      const workgroup = this.store.getWorkgroup(workgroupId);
      if (workgroup) this.workflowIdByBusId.set(workgroup.busId, workflow.id);
    }
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
    if (workgroup.leaderRunId) this.workgroupIdByLeaderRunId.set(workgroup.leaderRunId, workgroup.id);

    const workflowId = this.workflowIdByWorkgroupId.get(workgroup.id);
    if (workflowId) this.workflowIdByBusId.set(workgroup.busId, workflowId);
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
  if (event.type === "workflow.finished") return formatWorkflowFinishedEvent(event.workflow);
  if (event.type === "workgroup.finished") return formatWorkgroupFinishedEvent(event.workgroup);
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

  lines.push(...formatRunResultLines(event.run));
  return lines.join("\n");
}

function formatBusMessageEvent(
  event: Extract<OrchestraMainEvent, { type: "bus.message" }>,
  options: FormatOrchestraEventsOptions | undefined,
): string {
  const from = options?.formatBusMessageFrom?.(event.message.from) ?? event.message.from;
  const busName = options?.formatBusName?.(event.busId) ?? event.busId;
  return [`- Bus message on ${busName} from ${from}:`, event.message.message].join("\n");
}

function formatPendingRunNames(runIds: string[], options: FormatOrchestraEventsOptions | undefined): string {
  if (runIds.length === 0) return "none";
  return runIds.map((runId) => options?.formatRunName?.(runId) ?? runId).join(", ");
}

function formatWorkgroupFinishedEvent(workgroup: WorkgroupRun): string {
  const lines = [`- Workgroup finished: ${workgroup.name} is ${workgroup.state}.`];
  if (workgroup.result) {
    lines.push(`  Result: ${workgroup.result.status}`, `  Summary: ${workgroup.result.summary}`);
    if (workgroup.result.data !== undefined) lines.push(`  Data: ${JSON.stringify(workgroup.result.data)}`);
  }
  return lines.join("\n");
}

function formatWorkflowFinishedEvent(workflow: WorkflowRun): string {
  const lines = [`- Workflow finished: ${workflow.name} is ${workflow.state}.`];
  if (workflow.result) {
    lines.push(`  Result: ${workflow.result.status}`, `  Summary: ${workflow.result.summary}`);
  }
  if (workflow.error) lines.push(`  Error: ${workflow.error}`);
  return lines.join("\n");
}

function formatRunResultLines(run: AgentRunResult): string[] {
  if (run.result === null) return ["  No result payload recorded."];

  const lines = [`  Result: ${run.result.status}`, `  Summary: ${run.result.summary}`];
  if (run.result.data !== undefined) lines.push(`  Data: ${JSON.stringify(run.result.data)}`);
  return lines;
}

function formatRunFinishedState(run: AgentRunResult): string {
  return run.result ? `finished with ${run.result.status}; state=${run.state}` : `is ${run.state}`;
}

function isAgentFinishRun(run: AgentRun | AgentRunResult): boolean {
  return run.result !== null || run.state === "closed";
}
