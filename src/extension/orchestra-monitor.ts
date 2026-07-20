import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatAgentHealth, formatAggregateAgentHealth, type ResolveAgentHealth } from "../agent-health.ts";
import type { AgentRun } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { isAgentRunActive, isAgentRunFinished, pluralize } from "../utils.ts";

const WIDGET_KEY = "pi-orchestra.monitor";
const MAX_VISIBLE_SCOPES = 3;
const MAX_NAME_WIDTH = 24;
const DEFAULT_TICK_MS = 1_000;
const TYPE_PREFIX_LENGTH = 7;

type MonitorLineFormatter = (nowMs: number) => string;

export interface OrchestraMonitorControllerOptions {
  now: (() => number) | undefined;
  resolveAgentHealth: ResolveAgentHealth | undefined;
  /** Defaults to 1000 ms when undefined. Use 0 to disable periodic refreshes in tests. */
  tickMs: number | undefined;
}

export class OrchestraMonitorController {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly resolveAgentHealth: ResolveAgentHealth | undefined;
  private unsubscribe?: () => void;
  private tickTimer?: ReturnType<typeof setInterval>;
  private renderQueued = false;
  private dirty = true;
  private lineFormatters?: MonitorLineFormatter[];
  private ctx?: ExtensionContext;

  constructor(
    private readonly store: AgentStore,
    options: OrchestraMonitorControllerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.resolveAgentHealth = options.resolveAgentHealth;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Returns true when the widget is shown. Initial render failures are cleaned up and rethrown. */
  show(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI) return false;

    this.ctx = ctx;
    if (!this.unsubscribe) {
      const unsubscribeRuns = this.store.subscribeRuns(() => this.requestRender(), undefined);
      const unsubscribeWorkflows = this.store.subscribeWorkflows(() => this.requestRender(), undefined);
      const unsubscribeWorkgroups = this.store.subscribeWorkgroups(() => this.requestRender(), undefined);
      this.unsubscribe = () => {
        // Cleanup callbacks are non-throwing by AgentStore contract.
        unsubscribeRuns();
        unsubscribeWorkflows();
        unsubscribeWorkgroups();
      };
    }
    this.startTicking();

    try {
      return this.render();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    const unsubscribe = this.unsubscribe;
    const ctx = this.ctx;
    this.unsubscribe = undefined;
    this.renderQueued = false;
    this.dirty = true;
    this.lineFormatters = undefined;
    this.stopTicking();
    this.ctx = undefined;

    unsubscribe?.();
    if (ctx) {
      try {
        // Stored Pi contexts can become stale, so property access stays inside this boundary.
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // The monitor is already stopped even if the UI cannot clear its widget.
      }
    }
  }

  private requestRender(): void {
    this.dirty = true;
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
      const ctx = this.ctx;
      const message = error instanceof Error ? error.message : String(error);
      this.dispose();
      try {
        ctx?.ui.notify(`Pi-orchestra monitor stopped: ${message}`, "error");
      } catch {
        // Rendering is already contained; notification failure must be contained too.
      }
      return false;
    }
  }

  private render(): boolean {
    const ctx = this.ctx;
    if (!ctx?.hasUI) return false;

    const nowMs = this.now();
    if (this.dirty || !this.lineFormatters) {
      const lineFormatters = buildOrchestraMonitorLineFormatters(this.store, this.resolveAgentHealth);
      this.lineFormatters = lineFormatters;
      this.dirty = false;
    }
    const lines = this.lineFormatters.map((formatLine) => formatLine(nowMs));
    if (lines.length === 0) {
      this.dispose();
      return false;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width) =>
          lines.map((line) => {
            const content = line.trimStart().startsWith("+")
              ? theme.fg("dim", line)
              : theme.fg("accent", line.slice(0, TYPE_PREFIX_LENGTH)) + line.slice(TYPE_PREFIX_LENGTH);
            return truncateToWidth(` ${content}`, Math.max(0, width));
          }),
        invalidate() {},
      }),
      { placement: "belowEditor" },
    );
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

export function buildOrchestraMonitorLines(
  store: AgentStore,
  nowMs = Date.now(),
  resolveAgentHealth?: ResolveAgentHealth,
): string[] {
  return buildOrchestraMonitorLineFormatters(store, resolveAgentHealth).map((formatLine) => formatLine(nowMs));
}

function buildOrchestraMonitorLineFormatters(
  store: AgentStore,
  resolveAgentHealth: ResolveAgentHealth | undefined,
): MonitorLineFormatter[] {
  const workflows = store.listWorkflows((workflow) => workflow.state !== "closed");
  const workflowWorkgroupIds = new Set(workflows.flatMap((workflow) => workflow.workgroupIds));
  const workgroups = store.listWorkgroups(
    (workgroup) => workgroup.state !== "closed" || workflowWorkgroupIds.has(workgroup.id),
  );
  const activeWorkgroups = workgroups.filter((workgroup) => workgroup.state !== "closed");
  const workgroupsById = new Map(workgroups.map((workgroup) => [workgroup.id, workgroup]));
  const monitoredBusIds = new Set([
    ...workflows.map((workflow) => workflow.busId),
    ...workgroups.map((workgroup) => workgroup.busId),
  ]);
  const runs = store.listRuns((run) => isAgentRunActive(run) || monitoredBusIds.has(run.busId));
  const ownedRunIds = new Set<string>();

  for (const workflow of workflows) {
    for (const run of collectWorkflowRuns(workflow, workgroupsById, runs)) ownedRunIds.add(run.id);
  }
  for (const workgroup of activeWorkgroups) {
    for (const run of collectWorkgroupRuns(workgroup, runs)) ownedRunIds.add(run.id);
  }

  const scopeBuilders = [
    ...workflows.map((workflow) => () => formatWorkflowLine(workflow, workgroupsById, runs, resolveAgentHealth)),
    ...activeWorkgroups
      .filter((workgroup) => !workflowWorkgroupIds.has(workgroup.id))
      .map((workgroup) => () => formatWorkgroupLine(workgroup, runs, resolveAgentHealth)),
    ...runs
      .filter((run) => isAgentRunActive(run) && !ownedRunIds.has(run.id))
      .map((run) => () => formatAgentLine(run, resolveAgentHealth)),
  ];

  const lineFormatters = scopeBuilders.slice(0, MAX_VISIBLE_SCOPES).map((buildScope) => buildScope());
  const hiddenCount = scopeBuilders.length - lineFormatters.length;
  if (hiddenCount > 0) {
    const hiddenLine = `${" ".repeat(TYPE_PREFIX_LENGTH)}+${hiddenCount} more active ${pluralize("scope", hiddenCount)}`;
    lineFormatters.push(() => hiddenLine);
  }
  return lineFormatters;
}

function formatWorkflowLine(
  workflow: WorkflowRun,
  workgroupsById: Map<string, WorkgroupRun>,
  runs: AgentRun[],
  resolveAgentHealth: ResolveAgentHealth | undefined,
): MonitorLineFormatter {
  const workgroups = workflow.workgroupIds.flatMap((workgroupId) => {
    const workgroup = workgroupsById.get(workgroupId);
    return workgroup ? [workgroup] : [];
  });
  const workflowRuns = collectWorkflowRuns(workflow, workgroupsById, runs);
  const status = workflow.state === "closing" ? "closing" : formatInline(workflow.goal);
  const prefix = `FLOW   ${formatName(workflow.name)}`;
  const groups = `groups ${workgroups.filter((workgroup) => workgroup.state === "closed").length}/${workgroups.length}`;
  const agents = `agents ${workflowRuns.filter(isAgentRunFinished).length}/${workflowRuns.length}`;
  const startedAtMs = workflow.createdAtMs;
  return (nowMs) =>
    [
      `${prefix} [${formatUptimeSince(startedAtMs, nowMs)}]`,
      groups,
      agents,
      formatAggregateAgentHealth(workflowRuns, resolveAgentHealth),
      status,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ");
}

function formatWorkgroupLine(
  workgroup: WorkgroupRun,
  runs: AgentRun[],
  resolveAgentHealth: ResolveAgentHealth | undefined,
): MonitorLineFormatter {
  const workgroupRuns = collectWorkgroupRuns(workgroup, runs);
  const status = workgroup.state === "closing" ? "closing" : formatInline(workgroup.goal);
  const prefix = `GROUP  ${formatName(workgroup.name)}`;
  const agents = `agents ${workgroupRuns.filter(isAgentRunFinished).length}/${workgroupRuns.length}`;
  const startedAtMs = workgroup.createdAtMs;
  return (nowMs) =>
    [
      `${prefix} [${formatUptimeSince(startedAtMs, nowMs)}]`,
      agents,
      formatAggregateAgentHealth(workgroupRuns, resolveAgentHealth),
      status,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ");
}

function formatAgentLine(run: AgentRun, resolveAgentHealth: ResolveAgentHealth | undefined): MonitorLineFormatter {
  const prefix = `AGENT  ${formatName(run.name)}`;
  const profile = formatInline(run.profile.name);
  const task = formatInline(run.task);
  const runId = run.id;
  return () =>
    [prefix, formatAgentHealth(resolveAgentHealth?.(runId)) ?? "", profile, task].filter(Boolean).join(" | ");
}

function collectWorkflowRuns(
  workflow: WorkflowRun,
  workgroupsById: Map<string, WorkgroupRun>,
  runs: AgentRun[],
): AgentRun[] {
  const busIds = new Set([workflow.busId]);
  for (const workgroupId of workflow.workgroupIds) {
    const workgroup = workgroupsById.get(workgroupId);
    if (workgroup) busIds.add(workgroup.busId);
  }
  return runs.filter((run) => busIds.has(run.busId));
}

function collectWorkgroupRuns(workgroup: WorkgroupRun, runs: AgentRun[]): AgentRun[] {
  return runs.filter((run) => run.busId === workgroup.busId);
}

function formatName(name: string): string {
  return truncateToWidth(formatInline(name), MAX_NAME_WIDTH);
}

function formatInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
