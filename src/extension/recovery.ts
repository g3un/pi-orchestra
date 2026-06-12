import type { AgentRun } from "../core/subagent.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { resolveBusName, resolveRunName } from "../utils.ts";

export function formatOrchestraRecoveryReport(store: AgentStore): string {
  const runs = store.listRuns().filter((run) => run.state === "running");
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
    formatRecoverySection("Runs", runs, (run) => formatRunLine(store, run)),
    formatRecoverySection("Workgroups", workgroups, (workgroup) => formatWorkgroupLine(store, workgroup)),
    formatRecoverySection("Workflows", workflows, (workflow) => formatWorkflowLine(store, workflow)),
  ].join("\n");
}

function formatRecoverySection<T>(title: string, records: T[], formatRecord: (record: T) => string): string {
  if (records.length === 0) return `${title}: none`;
  return [title + ":", ...records.map((record) => `- ${formatRecord(record)}`)].join("\n");
}

function formatRunLine(store: AgentStore, run: AgentRun): string {
  const owner = run.parentRunId ? `parent=${resolveRunName(store, run.parentRunId)}` : "parent=main";
  return `${run.name} (${run.state}, bus=${resolveBusName(store, run.busId)}, ${owner})`;
}

function formatWorkgroupLine(store: AgentStore, workgroup: WorkgroupRun): string {
  const leader = workgroup.leaderRunId ? resolveRunName(store, workgroup.leaderRunId) : "main";
  return `${workgroup.name} (${workgroup.state}, bus=${resolveBusName(store, workgroup.busId)}, leader=${leader}, members=${workgroup.memberRunIds.length})`;
}

function formatWorkflowLine(store: AgentStore, workflow: WorkflowRun): string {
  const leader = workflow.leaderRunId ? resolveRunName(store, workflow.leaderRunId) : "none";
  return `${workflow.name} (${workflow.state}, bus=${resolveBusName(store, workflow.busId)}, leader=${leader}, workgroups=${workflow.workgroupIds.length})`;
}
