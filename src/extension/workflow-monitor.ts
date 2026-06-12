import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { isAgentRunFinished, isTerminalAgentState, pluralize } from "../utils.ts";

const WIDGET_KEY = "pi-orchestra.workflow-monitor";
const MAX_MONITORED_WORKFLOWS = 2;
const MAX_WIDGET_LINES = 10;
const DEFAULT_TICK_MS = 1_000;

export interface WorkflowMonitorControllerOptions {
  now: (() => number) | undefined;
  /** Defaults to 1000 ms when undefined. Use 0 to disable uptime ticks in tests. */
  tickMs: number | undefined;
}

export class WorkflowMonitorController {
  private readonly now: () => number;
  private readonly tickMs: number;
  private unsubscribe?: () => void;
  private tickTimer?: ReturnType<typeof setInterval>;
  private renderQueued = false;
  private ctx?: ExtensionContext;

  constructor(
    private readonly store: AgentStore,
    options: WorkflowMonitorControllerOptions = { now: undefined, tickMs: undefined },
  ) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  hasActiveWorkflows(): boolean {
    return listActiveWorkflows(this.store).length > 0;
  }

  show(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI) return false;

    this.ctx = ctx;
    if (!this.unsubscribe) {
      const unsubscribeRuns = this.store.subscribeRuns(() => this.requestRender(), undefined);
      const unsubscribeWorkflows = this.store.subscribeWorkflows(() => this.requestRender(), undefined);
      const unsubscribeWorkgroups = this.store.subscribeWorkgroups(() => this.requestRender(), undefined);
      this.unsubscribe = () => {
        unsubscribeRuns();
        unsubscribeWorkflows();
        unsubscribeWorkgroups();
      };
    }
    this.startTicking();

    return this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.renderQueued = false;
    this.stopTicking();

    if (this.ctx?.hasUI) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    this.ctx = undefined;
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      if (!this.renderQueued) return;
      this.renderQueued = false;
      this.safeRender();
    });
  }

  private safeRender(): boolean {
    try {
      return this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx?.ui.notify(`Pi-orchestra workflow monitor stopped: ${message}`, "error");
      this.dispose();
      return false;
    }
  }

  private render(): boolean {
    const ctx = this.ctx;
    if (!ctx?.hasUI) return false;

    const lines = buildWorkflowMonitorLines(this.store, this.now());
    if (lines.length === 0) {
      this.dispose();
      return false;
    }

    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    return true;
  }

  private startTicking(): void {
    if (this.tickMs <= 0 || this.tickTimer) return;
    const timer = setInterval(() => this.safeRender(), this.tickMs);
    (timer as typeof timer & { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  private stopTicking(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }
}

export function buildWorkflowMonitorLines(store: AgentStore, nowMs = Date.now()): string[] {
  const workflows = listActiveWorkflows(store);
  if (workflows.length === 0) return [];

  const lines: string[] = [];
  for (const workflow of workflows.slice(0, MAX_MONITORED_WORKFLOWS)) {
    appendWorkflowLines(lines, store, workflow, nowMs);
    if (lines.length >= MAX_WIDGET_LINES) break;
  }

  const hiddenWorkflowCount = workflows.length - MAX_MONITORED_WORKFLOWS;
  if (hiddenWorkflowCount > 0 && lines.length < MAX_WIDGET_LINES) {
    lines.push(`... +${hiddenWorkflowCount} more active ${pluralize("workflow", hiddenWorkflowCount)}`);
  }

  return lines.slice(0, MAX_WIDGET_LINES);
}

function appendWorkflowLines(lines: string[], store: AgentStore, workflow: WorkflowRun, nowMs: number): void {
  if (lines.length >= MAX_WIDGET_LINES) return;

  const workgroupActivity = calculateWorkgroupActivity(store, workflow);
  const agentActivity = calculateAgentActivity(store, workflow);
  lines.push(
    `${workflow.name} [${formatUptimeSince(workflow.startedAtMs, nowMs)}] — ${formatWorkflowStatusLine(workflow)}`,
    `  groups active ${workgroupActivity.active}, done ${workgroupActivity.done}; agents active ${agentActivity.active}, done ${agentActivity.done}`,
  );
}

function listActiveWorkflows(store: AgentStore): WorkflowRun[] {
  return store.listWorkflows().filter((workflow) => !isTerminalAgentState(workflow.state));
}

function formatWorkflowStatusLine(workflow: WorkflowRun): string {
  return workflow.statusLine ?? "waiting for flow leader status";
}

function calculateWorkgroupActivity(store: AgentStore, workflow: WorkflowRun): { active: number; done: number } {
  const workgroups = workflow.workgroupIds.flatMap((workgroupId) => {
    const workgroup = store.getWorkgroup(workgroupId);
    return workgroup ? [workgroup] : [];
  });
  const done = workgroups.filter((workgroup) => workgroup.state === "closed").length;
  return { active: workgroups.length - done, done };
}

function calculateAgentActivity(store: AgentStore, workflow: WorkflowRun): { active: number; done: number } {
  const runs = collectWorkflowRuns(store, workflow);
  const done = runs.filter(isAgentRunFinished).length;
  return { active: runs.length - done, done };
}

function collectWorkflowRuns(store: AgentStore, workflow: WorkflowRun): AgentRun[] {
  const runsById = new Map<string, AgentRun>();

  if (workflow.leaderRunId) {
    const leaderRun = store.getRun(workflow.leaderRunId);
    if (leaderRun) runsById.set(leaderRun.id, leaderRun);
  }

  if (workflow.busId) {
    for (const run of store.listRuns().filter((current) => current.busId === workflow.busId)) {
      runsById.set(run.id, run);
    }
  }

  for (const workgroupId of workflow.workgroupIds) {
    const workgroup = store.getWorkgroup(workgroupId);
    if (!workgroup) continue;

    if (workgroup.leaderRunId) {
      const groupLeaderRun = store.getRun(workgroup.leaderRunId);
      if (groupLeaderRun) runsById.set(groupLeaderRun.id, groupLeaderRun);
    }

    for (const runId of workgroup.memberRunIds) {
      const run = store.getRun(runId);
      if (run) runsById.set(run.id, run);
    }

    for (const run of store.listRuns().filter((current) => current.busId === workgroup.busId)) {
      runsById.set(run.id, run);
    }
  }

  return [...runsById.values()];
}

function formatUptimeSince(startedAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  const seconds = elapsedSeconds % 60;
  const totalMinutes = Math.floor(elapsedSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (totalMinutes > 0) return `${totalMinutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
