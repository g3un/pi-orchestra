import type { AgentResult } from "../core/subagent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";

const SESSION_SHUTDOWN_RESULT: AgentResult = {
  status: "blocked",
  summary: "Pi session ended before this orchestration scope closed.",
};

export function closeRuntimeOwnedScopes(store: AgentStore, orchestra: OrchestraApi, runIds: string[]): void {
  const ownedRunIds = new Set(runIds);
  if (ownedRunIds.size === 0) return;

  const closedWorkgroupIds = new Set<string>();
  for (const workgroup of store.listWorkgroups()) {
    if (workgroup.state === "closed" || !isWorkgroupOwnedByRuns(workgroup, ownedRunIds)) continue;
    closeWorkgroupRecord(store, orchestra, workgroup);
    closedWorkgroupIds.add(workgroup.id);
  }

  for (const workflow of store.listWorkflows()) {
    if (workflow.state === "closed" || !isWorkflowOwnedByRuns(store, workflow, ownedRunIds, closedWorkgroupIds)) {
      continue;
    }

    for (const workgroupId of workflow.workgroupIds) {
      const workgroup = store.getWorkgroup(workgroupId);
      if (!workgroup || workgroup.state === "closed") continue;
      closeWorkgroupRecord(store, orchestra, workgroup);
      closedWorkgroupIds.add(workgroup.id);
    }
    closeWorkflowRecord(store, orchestra, workflow);
  }
}

function isWorkflowOwnedByRuns(
  store: AgentStore,
  workflow: WorkflowRun,
  ownedRunIds: Set<string>,
  closedWorkgroupIds: Set<string>,
): boolean {
  if (workflow.leaderRunId && ownedRunIds.has(workflow.leaderRunId)) return true;
  return workflow.workgroupIds.some((workgroupId) => {
    if (closedWorkgroupIds.has(workgroupId)) return true;
    const workgroup = store.getWorkgroup(workgroupId);
    return workgroup ? isWorkgroupOwnedByRuns(workgroup, ownedRunIds) : false;
  });
}

function isWorkgroupOwnedByRuns(workgroup: WorkgroupRun, ownedRunIds: Set<string>): boolean {
  if (workgroup.leaderRunId && ownedRunIds.has(workgroup.leaderRunId)) return true;
  return workgroup.memberRunIds.some((runId) => ownedRunIds.has(runId));
}

function closeWorkgroupRecord(store: AgentStore, orchestra: OrchestraApi, workgroup: WorkgroupRun): void {
  const latestWorkgroup = store.getWorkgroup(workgroup.id) ?? workgroup;
  if (latestWorkgroup.state === "closed") return;

  store.saveWorkgroup({
    ...latestWorkgroup,
    state: "closed",
    result: latestWorkgroup.result ?? SESSION_SHUTDOWN_RESULT,
  });
  orchestra.closeBus(latestWorkgroup.busId);
}

function closeWorkflowRecord(store: AgentStore, orchestra: OrchestraApi, workflow: WorkflowRun): void {
  const latestWorkflow = store.getWorkflow(workflow.id) ?? workflow;
  if (latestWorkflow.state === "closed") return;

  store.saveWorkflow({
    ...latestWorkflow,
    state: "closed",
    result: latestWorkflow.result ?? SESSION_SHUTDOWN_RESULT,
  });
  orchestra.closeBus(latestWorkflow.busId);
}
