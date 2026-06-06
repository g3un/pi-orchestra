import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun, WorkflowStageRun } from "../core/workflow.ts";
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
      const unsubscribeRuns = this.store.subscribeRuns(() => this.render(), undefined);
      const unsubscribeWorkflows = this.store.subscribeWorkflows(() => this.render(), undefined);
      this.unsubscribe = () => {
        unsubscribeRuns();
        unsubscribeWorkflows();
      };
    }
    this.startTicking();

    return this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopTicking();

    if (this.ctx?.hasUI) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    this.ctx = undefined;
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
    const timer = setInterval(() => this.render(), this.tickMs);
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

  const stage = getCurrentStage(workflow);
  const workflowLabel = `${workflow.name} [${formatUptimeSince(workflow.startedAtMs, nowMs)}]`;
  const stageLabel = stage
    ? formatStageLabel(store, workflow, stage, nowMs)
    : `none (0/${workflow.stages.length}) | agents (0/0)`;
  lines.push(`${workflowLabel} | ${stageLabel}`);
}

function listActiveWorkflows(store: AgentStore): WorkflowRun[] {
  return store.listWorkflows().filter((workflow) => !isTerminalAgentState(workflow.state));
}

function getCurrentStage(workflow: WorkflowRun): WorkflowStageRun | undefined {
  return (
    workflow.stages[workflow.currentStageIndex] ?? workflow.stages.find((stage) => !isTerminalAgentState(stage.state))
  );
}

function formatStageLabel(store: AgentStore, workflow: WorkflowRun, stage: WorkflowStageRun, nowMs: number): string {
  const stageIndex = workflow.stages.indexOf(stage);
  const stagePosition = stageIndex >= 0 ? `${stageIndex + 1}/${workflow.stages.length}` : `?/${workflow.stages.length}`;
  const stageUptime = formatUptimeSince(stage.startedAtMs, nowMs);
  return `${stage.name} [${stageUptime}] (${stagePosition}) | agents (${formatStageProgress(store, stage)})`;
}

function formatStageProgress(store: AgentStore, stage: WorkflowStageRun): string {
  const progress = calculateStageProgress(store, stage);
  return `${progress.completed}/${progress.total}`;
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

function calculateStageProgress(store: AgentStore, stage: WorkflowStageRun): { completed: number; total: number } {
  const runs = collectStageRuns(store, stage);
  const completed = runs.filter(isAgentRunFinished).length;
  const memberRunCount = runs.filter((run) => run.id !== stage.leaderRunId).length;
  const memberRunIds = stage.workgroupId ? (store.getWorkgroup(stage.workgroupId)?.memberRunIds ?? []) : [];
  const memberTotal = Math.max(memberRunIds.length, memberRunCount);
  const leaderTotal = stage.phase === "leader" || stage.leaderRunId !== undefined ? 1 : 0;
  const total = Math.max(memberTotal + leaderTotal, runs.length);
  return { completed: Math.min(completed, total), total };
}

function collectStageRuns(store: AgentStore, stage: WorkflowStageRun): AgentRun[] {
  const runsById = new Map<string, AgentRun>();

  if (stage.workgroupId) {
    for (const runId of store.getWorkgroup(stage.workgroupId)?.memberRunIds ?? []) {
      const run = store.getRun(runId);
      if (run) runsById.set(run.id, run);
    }
  }

  if (stage.leaderRunId) {
    const leaderRun = store.getRun(stage.leaderRunId);
    if (leaderRun) runsById.set(leaderRun.id, leaderRun);
  }

  if (stage.busId) {
    for (const run of store.listRuns().filter((current) => current.busId === stage.busId)) {
      runsById.set(run.id, run);
    }
  }

  return [...runsById.values()];
}
