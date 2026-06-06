import { isBusMessageDelivered, markBusMessagesDelivered, type BusMessage } from "../core/bus.ts";
import type { AgentRun, AgentRunResult } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun, WorkgroupState } from "../core/workgroup.ts";
import { formatNamedEntityLabel, isAgentRunActive, toAgentRunResult } from "../utils.ts";

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
}

export type WorkgroupRegistration = WorkgroupLaunchRegistration;

export interface OrchestraEventControllerOptions {
  store: AgentStore;
  sendEvents: (events: OrchestraMainEvent[], content: string) => void;
  sendAgentEvents?: (runId: string, events: OrchestraMainEvent[], content: string) => void;
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
}

interface BusMessageDelivery {
  subscriptionId: string;
  message: BusMessage;
}

interface FormatOrchestraEventsOptions {
  formatBusMessageFrom: ((from: string) => string) | undefined;
}

export class OrchestraEventController {
  private readonly store: AgentStore;
  private readonly sendEvents: OrchestraEventControllerOptions["sendEvents"];
  private readonly sendAgentEvents: NonNullable<OrchestraEventControllerOptions["sendAgentEvents"]> | undefined;
  private readonly flushDelayMs: number;
  private readonly runFinished = new Map<string, boolean>();
  private readonly workflowStates = new Map<string, WorkflowRun["state"]>();
  private readonly workflowIndexes = new Map<string, { busId: string; workgroupIds: string[] }>();
  private readonly workflowIdByWorkgroupId = new Map<string, string>();
  private readonly workflowIdByBusId = new Map<string, string>();
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
    this.flushDelayMs = options.flushDelayMs ?? 50;

    for (const run of this.store.listRuns()) this.runFinished.set(run.id, isAgentFinishRun(run));
    for (const workflow of this.store.listWorkflows()) {
      this.workflowStates.set(workflow.id, workflow.state);
      this.indexWorkflow(workflow);
    }
    for (const workgroup of this.store.listWorkgroups()) {
      this.workgroupStates.set(workgroup.id, workgroup.state);
      this.indexWorkflowWorkgroupBus(workgroup);
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
    this.sendEvents(
      events,
      formatOrchestraEvents(events, { formatBusMessageFrom: (from) => this.formatBusMessageFrom(from) }),
    );
    this.queuedEvents.splice(0, events.length);
    this.queuedBusMessageDeliveries.splice(0, busMessageDeliveries.length);
    for (const delivery of busMessageDeliveries) this.markBusMessageDelivered(delivery);
  }

  private handleRunSaved(run: AgentRun): void {
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

    const launchingWorkgroup = this.launchingWorkgroupsByBusId.get(run.busId);
    if (launchingWorkgroup) {
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
    this.indexWorkflowWorkgroupBus(workgroup);

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

    this.sendAgentEvents(
      leaderRunId,
      [event],
      formatOrchestraEvents([event], { formatBusMessageFrom: (from) => this.formatBusMessageFrom(from) }),
    );
    return true;
  }

  private sendWorkflowLeaderEvent(
    workflow: WorkflowRun,
    event: Extract<OrchestraMainEvent, { type: "workgroup.finished" }>,
  ): boolean {
    if (!workflow.leaderRunId || workflow.state !== "running") return false;
    const leaderRun = this.store.getRun(workflow.leaderRunId);
    if (!leaderRun || !isAgentRunActive(leaderRun) || !this.sendAgentEvents) return false;

    this.sendAgentEvents(
      leaderRun.id,
      [event],
      formatOrchestraEvents([event], { formatBusMessageFrom: (from) => this.formatBusMessageFrom(from) }),
    );
    return true;
  }

  private findWorkgroupForMemberRun(runId: string) {
    return this.store.listWorkgroups().find((workgroup) => workgroup.memberRunIds.includes(runId));
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

  private indexWorkflowWorkgroupBus(workgroup: WorkgroupRun): void {
    const workflowId = this.workflowIdByWorkgroupId.get(workgroup.id);
    if (workflowId) this.workflowIdByBusId.set(workgroup.busId, workflowId);
  }

  private getPendingWorkgroupRunIds(busId: string, runIds: Set<string>): string[] {
    return this.store
      .listRuns()
      .filter((run) => run.busId === busId && runIds.has(run.id) && isAgentRunActive(run))
      .map((run) => run.id);
  }

  private hasQueuedBusMessageDelivery(subscriptionId: string, messageId: string): boolean {
    return this.queuedBusMessageDeliveries.some(
      (delivery) => delivery.subscriptionId === subscriptionId && delivery.message.id === messageId,
    );
  }

  private formatBusMessageFrom(from: string): string {
    if (from === "main") return from;
    return this.store.getRun(from)?.name ?? from;
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

  const runLabel = event.run.name === event.run.runId ? event.run.runId : `${event.run.name} (${event.run.runId})`;
  const lines =
    event.type === "workgroup.member_finished"
      ? [
          `- Workgroup member finished on bus ${event.busId}: ${runLabel} ${formatRunFinishedState(event.run)}.`,
          `  Pending workgroup run ids: ${event.pendingRunIds.length > 0 ? event.pendingRunIds.join(", ") : "none"}`,
        ]
      : [`- Subagent finished on bus ${event.busId}: ${runLabel} ${formatRunFinishedState(event.run)}.`];

  lines.push(...formatRunResultLines(event.run));
  return lines.join("\n");
}

function formatBusMessageEvent(
  event: Extract<OrchestraMainEvent, { type: "bus.message" }>,
  options: FormatOrchestraEventsOptions | undefined,
): string {
  const from = options?.formatBusMessageFrom?.(event.message.from) ?? event.message.from;
  return [`- Bus message on ${event.busId} from ${from}:`, event.message.message].join("\n");
}

function formatWorkgroupFinishedEvent(workgroup: WorkgroupRun): string {
  const lines = [`- Workgroup finished: ${formatNamedEntityLabel(workgroup)} is ${workgroup.state}.`];
  if (workgroup.result) {
    lines.push(`  Result: ${workgroup.result.status}`, `  Summary: ${workgroup.result.summary}`);
    if (workgroup.result.data !== undefined) lines.push(`  Data: ${JSON.stringify(workgroup.result.data)}`);
  }
  return lines.join("\n");
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
