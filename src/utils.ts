import type { OrchestraApi, WaitRunResult } from "./core/orchestra.ts";
import type { AgentRun } from "./core/subagent.ts";
import type { AgentStore } from "./core/store.ts";
import type { WorkflowRun } from "./core/workflow.ts";

export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

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
): NamedEntity {
  if (requestedName !== undefined) {
    const name = normalizeEntityName(requestedName, entityLabel);
    const id = slugify(name);
    if (!id) throw new Error(`${entityLabel} name "${name}" must contain letters or numbers.`);
    if (existingEntities.some((entity) => entity.id === id || entity.name === name)) {
      throw new Error(`${entityLabel} name "${name}" is already in use.`);
    }
    return { id, name };
  }

  const base = slugify(autoSeed) || entityLabel.toLowerCase();
  for (let index = 1; ; index++) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!existingEntities.some((entity) => entity.id === id || entity.name === id)) return { id, name: id };
  }
}

export function formatNamedEntityLabel(entity: NamedEntity): string {
  return entity.name === entity.id ? entity.id : `${entity.name} (${entity.id})`;
}

export function resolveWaitTimeoutMs(label: string, timeoutMs: number | null | undefined): number | null {
  const resolvedTimeoutMs = timeoutMs === undefined ? DEFAULT_WAIT_TIMEOUT_MS : timeoutMs;
  if (resolvedTimeoutMs !== null && (!Number.isFinite(resolvedTimeoutMs) || resolvedTimeoutMs <= 0)) {
    throw new Error(`${label} timeoutMs must be positive, or null to wait indefinitely.`);
  }
  return resolvedTimeoutMs;
}

export function findWorkflow(store: AgentStore, id: string): WorkflowRun | undefined {
  return store.getWorkflow(id) ?? store.listWorkflows().find((workflow) => workflow.name === id);
}

export function requireWorkflow(store: AgentStore, id: string): WorkflowRun {
  const workflow = store.getWorkflow(id);
  if (!workflow) throw new Error(`Workflow ${id} not found.`);
  return workflow;
}

export function isTerminalWorkflowState(state: WorkflowRun["state"]): boolean {
  return state === "finished" || state === "failed" || state === "closed";
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

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function isTerminalRun(run: AgentRun): boolean {
  return run.state === "finished" || run.state === "failed" || run.state === "closed";
}

export function toWaitRunResult(run: AgentRun): WaitRunResult {
  const runResult: WaitRunResult = {
    runId: run.id,
    name: run.name,
    profile: run.profile,
    state: run.state,
  };
  if (run.result !== undefined) runResult.result = run.result;
  return runResult;
}

export async function closeAgentRuns(orchestra: OrchestraApi, runIds: string[]): Promise<void> {
  await Promise.allSettled([...new Set(runIds)].map((runId) => orchestra.closeAgent(runId)));
}
