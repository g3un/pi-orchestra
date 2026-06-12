import { v7 as uuid7 } from "uuid";
import type { OrchestraApi } from "./core/orchestra.ts";
import type { AgentRun, AgentRunResult } from "./core/subagent.ts";
import type { AgentStore } from "./core/store.ts";
import type { WorkflowRun } from "./core/workflow.ts";

export interface NamedEntity {
  id: string;
  name: string;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeEntityName(name: string, entityLabel: string, maxLength = 64): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${entityLabel} name must not be empty.`);
  if (trimmed.length > maxLength) throw new Error(`${entityLabel} name must be ${maxLength} characters or fewer.`);
  return trimmed;
}

export function createEntityIdentity(
  requestedName: string | undefined,
  autoSeed: string,
  existingEntities: NamedEntity[],
  entityLabel: string,
  maxLength = 64,
): NamedEntity {
  if (requestedName !== undefined) {
    const name = normalizeEntityName(requestedName, entityLabel, maxLength);
    if (hasEntityNameConflict(name, existingEntities))
      throw new Error(`${entityLabel} name "${name}" is already in use.`);
    return { id: createUuid7(), name };
  }

  const base = slugify(autoSeed) || entityLabel.toLowerCase();
  for (let index = 1; ; index++) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (!hasEntityNameConflict(name, existingEntities)) return { id: createUuid7(), name };
  }
}

export function createUuid7(): string {
  return uuid7();
}

function hasEntityNameConflict(name: string, existingEntities: NamedEntity[]): boolean {
  return existingEntities.some((entity) => entity.name === name || entity.id === name);
}

export function findWorkflow(store: AgentStore, id: string): WorkflowRun | undefined {
  return store.getWorkflow(id) ?? store.getWorkflowByName(id);
}

export function requireWorkflow(store: AgentStore, id: string): WorkflowRun {
  const workflow = findWorkflow(store, id);
  if (!workflow) throw new Error(`Workflow ${id} not found.`);
  return workflow;
}

export function resolveBusName(store: AgentStore, busId: string): string {
  return store.getBus(busId)?.name ?? busId;
}

export function resolveRunName(store: AgentStore, runId: string): string {
  return store.getRun(runId)?.name ?? runId;
}

export function resolveWorkgroupName(store: AgentStore, workgroupId: string): string {
  return store.getWorkgroup(workgroupId)?.name ?? workgroupId;
}

export type LifecycleState = AgentRun["state"] | WorkflowRun["state"];

export function isTerminalAgentState(state: LifecycleState): boolean {
  return state === "success" || state === "blocked" || state === "failed" || state === "closed";
}

export function isAgentRunActive(run: AgentRun): boolean {
  return run.state === "running" && run.result === null;
}

export function isAgentRunFinished(run: AgentRun): boolean {
  return run.state === "closed" || run.result !== null;
}

export function indent(text: string, prefix = "  "): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

export function toAgentRunResult(run: AgentRun): AgentRunResult {
  return {
    runId: run.id,
    name: run.name,
    profile: run.profile.name,
    state: run.state,
    result: run.result,
  };
}

export async function closeAgentRuns(orchestra: OrchestraApi, runIds: string[]): Promise<void> {
  await Promise.allSettled(
    [...new Set(runIds)].map(async (runId) => await orchestra.closeAgent(runId, { busId: undefined })),
  );
}
