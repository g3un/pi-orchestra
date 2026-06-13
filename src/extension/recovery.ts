import type { AgentRun } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { resolveBusName, resolveRunName } from "../utils.ts";

export interface RecoveryReportOptions {
  liveRunIds?: Iterable<string>;
}

export function formatOrchestraRecoveryReport(store: AgentStore, options: RecoveryReportOptions = {}): string {
  const liveRunIds = new Set(options.liveRunIds ?? []);
  const runs = store.listRuns().filter((run) => run.state !== "closed");
  const workgroups = store.listWorkgroups().filter((workgroup) => workgroup.state !== "closed");
  const workflows = store.listWorkflows().filter((workflow) => workflow.state !== "closed");

  if (runs.length === 0 && workgroups.length === 0 && workflows.length === 0) {
    return ["Pi-orchestra recovery report:", "", "No persisted active pi-orchestra records were found."].join("\n");
  }

  return [
    "Pi-orchestra recovery report:",
    "",
    "These persisted records are active in the local store. They may still belong to another live Pi session; pi-orchestra does not auto-close them.",
    "If they belong to an abandoned session, recover explicitly with subagent close, workgroup cancel, or workflow cancel.",
    "",
    formatRecoverySection("Runs", runs, (run) => formatRunLine(store, run, liveRunIds)),
    formatRecoverySection("Workgroups", workgroups, (workgroup) => formatWorkgroupLine(store, workgroup, liveRunIds)),
    formatRecoverySection("Workflows", workflows, (workflow) => formatWorkflowLine(store, workflow, liveRunIds)),
  ].join("\n");
}

function formatRecoverySection<T>(title: string, records: T[], formatRecord: (record: T) => string): string {
  if (records.length === 0) return `${title}: none`;
  return [title + ":", ...records.map((record) => `- ${formatRecord(record)}`)].join("\n");
}

function formatRunLine(store: AgentStore, run: AgentRun, liveRunIds: Set<string>): string {
  const details = [run.state, `bus=${resolveBusName(store, run.busId)}`, formatRunOwner(store, run)];
  if (liveRunIds.has(run.id)) details.push("session=current");
  appendHints(details, getRunHints(store, run));
  return `${run.name} (${details.join(", ")})`;
}

function formatWorkgroupLine(store: AgentStore, workgroup: WorkgroupRun, liveRunIds: Set<string>): string {
  const leader = workgroup.leaderRunId ? resolveRunName(store, workgroup.leaderRunId) : "main";
  const details = [
    workgroup.state,
    `bus=${resolveBusName(store, workgroup.busId)}`,
    `leader=${leader}`,
    `members=${workgroup.memberRunIds.length}`,
  ];
  if (isWorkgroupOwnedByLiveRun(workgroup, liveRunIds)) details.push("session=current");
  appendHints(details, getWorkgroupHints(store, workgroup));
  return `${workgroup.name} (${details.join(", ")})`;
}

function formatWorkflowLine(store: AgentStore, workflow: WorkflowRun, liveRunIds: Set<string>): string {
  const leader = workflow.leaderRunId ? resolveRunName(store, workflow.leaderRunId) : "none";
  const details = [
    workflow.state,
    `bus=${resolveBusName(store, workflow.busId)}`,
    `leader=${leader}`,
    `workgroups=${workflow.workgroupIds.length}`,
  ];
  if (isWorkflowOwnedByLiveRun(store, workflow, liveRunIds)) details.push("session=current");
  appendHints(details, getWorkflowHints(store, workflow));
  return `${workflow.name} (${details.join(", ")})`;
}

function formatRunOwner(store: AgentStore, run: AgentRun): string {
  return run.parentRunId ? `parent=${resolveRunName(store, run.parentRunId)}` : "parent=main";
}

function appendHints(details: string[], hints: string[]): void {
  if (hints.length > 0) details.push(`hints=${hints.join("; ")}`);
}

function getRunHints(store: AgentStore, run: AgentRun): string[] {
  const hints = getBusHints(store, run.busId);
  if (run.parentRunId && !store.getRun(run.parentRunId)) hints.push("parent missing");
  return hints;
}

function getWorkgroupHints(store: AgentStore, workgroup: WorkgroupRun): string[] {
  const hints = getBusHints(store, workgroup.busId);
  if (workgroup.state === "closing") hints.push("closing cleanup incomplete");
  if (workgroup.leaderRunId && !store.getRun(workgroup.leaderRunId)) hints.push("leader missing");
  return hints;
}

function getWorkflowHints(store: AgentStore, workflow: WorkflowRun): string[] {
  const hints = getBusHints(store, workflow.busId);
  if (workflow.state === "closing") hints.push("closing cleanup incomplete");
  if (workflow.leaderRunId && !store.getRun(workflow.leaderRunId)) hints.push("leader missing");
  for (const workgroupId of workflow.workgroupIds) {
    if (!store.getWorkgroup(workgroupId)) hints.push(`workgroup missing:${workgroupId}`);
  }
  return hints;
}

function getBusHints(store: AgentStore, busId: string): string[] {
  const bus = store.getBus(busId);
  if (!bus) return ["bus missing"];
  return bus.state === "closed" ? ["bus closed"] : [];
}

function isWorkgroupOwnedByLiveRun(workgroup: WorkgroupRun, liveRunIds: Set<string>): boolean {
  if (workgroup.leaderRunId && liveRunIds.has(workgroup.leaderRunId)) return true;
  return workgroup.memberRunIds.some((runId) => liveRunIds.has(runId));
}

function isWorkflowOwnedByLiveRun(store: AgentStore, workflow: WorkflowRun, liveRunIds: Set<string>): boolean {
  if (workflow.leaderRunId && liveRunIds.has(workflow.leaderRunId)) return true;
  return workflow.workgroupIds.some((workgroupId) => {
    const workgroup = store.getWorkgroup(workgroupId);
    return workgroup ? isWorkgroupOwnedByLiveRun(workgroup, liveRunIds) : false;
  });
}
