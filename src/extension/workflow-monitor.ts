import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun, WorkflowStageRun } from "../core/workflow.ts";
import { formatNamedEntityLabel, isTerminalAgentState } from "../utils.ts";

const WIDGET_KEY = "pi-orchestra.workflow-monitor";
const MAX_MONITORED_WORKFLOWS = 2;
const MAX_WIDGET_LINES = 10;

export class WorkflowMonitorController {
  private unsubscribe?: () => void;
  private ctx?: ExtensionContext;

  constructor(private readonly store: AgentStore) {}

  hasActiveWorkflows(): boolean {
    return listActiveWorkflows(this.store).length > 0;
  }

  show(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI) return false;

    this.ctx = ctx;
    if (!this.unsubscribe) {
      const unsubscribeRuns = this.store.subscribeRuns(() => this.render());
      const unsubscribeWorkflows = this.store.subscribeWorkflows(() => this.render());
      this.unsubscribe = () => {
        unsubscribeRuns();
        unsubscribeWorkflows();
      };
    }

    return this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    if (this.ctx?.hasUI) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    this.ctx = undefined;
  }

  private render(): boolean {
    const ctx = this.ctx;
    if (!ctx?.hasUI) return false;

    const lines = buildWorkflowMonitorLines(this.store);
    if (lines.length === 0) {
      this.dispose();
      return false;
    }

    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    return true;
  }
}

export function buildWorkflowMonitorLines(store: AgentStore): string[] {
  const workflows = listActiveWorkflows(store);
  if (workflows.length === 0) return [];

  const lines: string[] = [];
  for (const workflow of workflows.slice(0, MAX_MONITORED_WORKFLOWS)) {
    appendWorkflowLines(lines, store, workflow);
    if (lines.length >= MAX_WIDGET_LINES) break;
  }

  const hiddenWorkflowCount = workflows.length - MAX_MONITORED_WORKFLOWS;
  if (hiddenWorkflowCount > 0 && lines.length < MAX_WIDGET_LINES) {
    lines.push(`... +${hiddenWorkflowCount} more active ${pluralize("workflow", hiddenWorkflowCount)}`);
  }

  return lines.slice(0, MAX_WIDGET_LINES);
}

function appendWorkflowLines(lines: string[], store: AgentStore, workflow: WorkflowRun): void {
  if (lines.length >= MAX_WIDGET_LINES) return;

  const stage = getCurrentStage(workflow);
  const stageLabel = stage ? formatStageLabel(store, workflow, stage) : "none · agents 0/0";
  lines.push(`${formatNamedEntityLabel(workflow)} | ${stageLabel}`);
}

function listActiveWorkflows(store: AgentStore): WorkflowRun[] {
  return store.listWorkflows().filter((workflow) => !isTerminalAgentState(workflow.state));
}

function getCurrentStage(workflow: WorkflowRun): WorkflowStageRun | undefined {
  return (
    workflow.stages[workflow.currentStageIndex] ?? workflow.stages.find((stage) => !isTerminalAgentState(stage.state))
  );
}

function formatStageLabel(store: AgentStore, workflow: WorkflowRun, stage: WorkflowStageRun): string {
  const stageIndex = workflow.stages.indexOf(stage);
  const stagePosition = stageIndex >= 0 ? `${stageIndex + 1}/${workflow.stages.length}` : `?/${workflow.stages.length}`;
  return `${stage.name} · step ${stagePosition} · agents ${formatStageProgress(store, stage)}`;
}

function formatStageProgress(store: AgentStore, stage: WorkflowStageRun): string {
  const progress = calculateStageProgress(store, stage);
  return `${progress.completed}/${progress.total}`;
}

function calculateStageProgress(store: AgentStore, stage: WorkflowStageRun): { completed: number; total: number } {
  const runs = collectStageRuns(store, stage);
  const completed = runs.filter((run) => isTerminalAgentState(run.state)).length;
  const workerRunCount = runs.filter((run) => run.id !== stage.leaderRunId).length;
  const workerTotal = Math.max(stage.members.length, stage.workerRunIds.length, workerRunCount);
  const leaderTotal = stage.phase === "leader" || stage.leaderRunId !== undefined ? 1 : 0;
  const total = Math.max(workerTotal + leaderTotal, runs.length);
  return { completed: Math.min(completed, total), total };
}

function collectStageRuns(store: AgentStore, stage: WorkflowStageRun): AgentRun[] {
  const runsById = new Map<string, AgentRun>();

  for (const runId of stage.workerRunIds) {
    const run = store.getRun(runId);
    if (run) runsById.set(run.id, run);
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

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}
