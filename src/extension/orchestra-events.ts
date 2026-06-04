import type { AgentRun, AgentRunResult, AgentState } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupStrategy } from "../core/workgroup.ts";
import { formatNamedEntityLabel, isTerminalAgentState, toAgentRunResult } from "../utils.ts";

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

export class OrchestraEventController {
  private readonly store: AgentStore;
  private readonly sendEvents: OrchestraEventControllerOptions["sendEvents"];
  private readonly flushDelayMs: number;
  private readonly runStates = new Map<string, AgentState>();
  private readonly workflowStates = new Map<string, AgentState>();
  private readonly mainWorkgroupsByBusId = new Map<string, RegisteredWorkgroup>();
  private readonly launchingWorkgroupsByBusId = new Map<string, LaunchingWorkgroup>();
  private readonly queuedEvents: OrchestraMainEvent[] = [];
  private readonly unsubscribeRuns: () => void;
  private readonly unsubscribeWorkflows: () => void;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: OrchestraEventControllerOptions) {
    this.store = options.store;
    this.sendEvents = options.sendEvents;
    this.flushDelayMs = options.flushDelayMs ?? 50;

    for (const run of this.store.listRuns()) this.runStates.set(run.id, run.state);
    for (const workflow of this.store.listWorkflows()) this.workflowStates.set(workflow.id, workflow.state);

    this.unsubscribeRuns = this.store.subscribeRuns((run) => this.handleRunSaved(run), undefined);
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
    this.unsubscribeRuns();
    this.unsubscribeWorkflows();
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queuedEvents.length === 0) return;

    const events = this.queuedEvents.splice(0);
    this.sendEvents(events, formatOrchestraEvents(events));
  }

  private handleRunSaved(run: AgentRun): void {
    const previousState = this.runStates.get(run.id);
    this.runStates.set(run.id, run.state);

    if (!isAgentFinishState(run.state) || isAgentFinishState(previousState)) return;
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

  private handleWorkflowSaved(workflow: WorkflowRun): void {
    const previousState = this.workflowStates.get(workflow.id);
    this.workflowStates.set(workflow.id, workflow.state);

    if (!isTerminalAgentState(workflow.state) || isTerminalWorkflowState(previousState)) return;
    this.queueEvent({ type: "workflow.finished", workflow });
  }

  private isWorkflowBus(busId: string): boolean {
    return this.store.listWorkflows().some((workflow) => workflow.stages.some((stage) => stage.busId === busId));
  }

  private getPendingWorkgroupRunIds(busId: string, runIds: Set<string>): string[] {
    return this.store
      .listRuns()
      .filter((run) => run.busId === busId && runIds.has(run.id) && run.state === "idle")
      .map((run) => run.id);
  }

  private getPendingBusRunIds(busId: string): string[] {
    return this.store
      .listRuns()
      .filter((run) => run.busId === busId && run.state === "idle")
      .map((run) => run.id);
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

  const runLabel = event.run.name === event.run.runId ? event.run.runId : `${event.run.name} (${event.run.runId})`;
  const lines =
    event.type === "workgroup.member_finished"
      ? [
          `- Workgroup member finished on bus ${event.busId}: ${runLabel} is ${event.run.state}.`,
          `  Strategy: ${event.strategy}`,
          `  Pending workgroup run ids: ${event.pendingRunIds.length > 0 ? event.pendingRunIds.join(", ") : "none"}`,
        ]
      : [`- Subagent finished on bus ${event.busId}: ${runLabel} is ${event.run.state}.`];

  lines.push(...formatRunResultLines(event.run));
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
  if (!run.result) return ["  No result payload recorded."];

  const lines = [`  Result: ${run.result.status}`, `  Summary: ${run.result.summary}`];
  if (run.result.data !== undefined) lines.push(`  Data: ${JSON.stringify(run.result.data)}`);
  return lines;
}

function isAgentFinishState(state: AgentState | undefined): boolean {
  return state === "success" || state === "blocked" || state === "failed";
}

function isTerminalWorkflowState(state: AgentState | undefined): boolean {
  return state !== undefined && isTerminalAgentState(state);
}
