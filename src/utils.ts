import type { OrchestraApi } from "./core/orchestra.ts";
import type { AgentRun, AgentRunResult } from "./core/subagent.ts";
import type { AgentStore } from "./core/store.ts";

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
  existingActiveEntities: NamedEntity[],
  entityLabel: string,
  maxLength = 64,
  reservedEntities: NamedEntity[] = existingActiveEntities,
): NamedEntity {
  if (requestedName !== undefined) {
    const name = normalizeEntityName(requestedName, entityLabel, maxLength);
    if (hasEntityNameConflict(name, existingActiveEntities, reservedEntities))
      throw new Error(`${entityLabel} name "${name}" is already in use.`);
    return { id: createId(), name };
  }

  const base = slugify(autoSeed) || entityLabel.toLowerCase();
  for (let index = 1; ; index++) {
    const name = index === 1 ? base : `${base}-${index}`;
    normalizeEntityName(name, entityLabel, maxLength);
    if (!hasEntityNameConflict(name, existingActiveEntities, reservedEntities)) return { id: createId(), name };
  }
}

export function createId(): string {
  return crypto.randomUUID();
}

function hasEntityNameConflict(
  name: string,
  existingActiveEntities: NamedEntity[],
  reservedEntities: NamedEntity[],
): boolean {
  // Reserved IDs cannot be reused as names because id-first lookups would permanently shadow them.
  return (
    hasNameConflict(
      name,
      existingActiveEntities.map((entity) => entity.name),
    ) || reservedEntities.some((entity) => entity.id === name)
  );
}

export function hasNameConflict(candidate: string, existingNames: string[]): boolean {
  return existingNames.some((existingName) => namesConflict(existingName, candidate));
}

export function assertAgentRunNameAvailable(
  name: string,
  runs: Array<Pick<AgentRun, "id" | "name" | "state">>,
  label: string,
): void {
  const nonClosedRuns = runs.filter((run) => run.state !== "closed");
  const reservableRunNames = nonClosedRuns.flatMap((run) => [run.id, run.name]);
  if (hasNameConflict(name, reservableRunNames)) throw new Error(`${label} name "${name}" is already in use.`);
}

export function namesConflict(left: string, right: string): boolean {
  const leftVariants = nameConflictVariants(left);
  const rightVariants = new Set(nameConflictVariants(right));
  return leftVariants.some((variant) => rightVariants.has(variant));
}

function nameConflictVariants(name: string): string[] {
  const variants = [name];
  const prefix = name.split("-", 1)[0];
  if (prefix !== "agent" && prefix !== "bus" && prefix !== "group" && prefix !== "flow") return variants;

  let stripped = name;
  const prefixPattern = `${prefix}-`;
  while (stripped.startsWith(prefixPattern)) {
    stripped = stripped.slice(prefixPattern.length);
    variants.push(stripped);
  }
  return variants;
}

export function findEntity<T extends NamedEntity>(
  id: string,
  prefix: "agent" | "bus" | "group" | "flow",
  getById: (id: string) => T | undefined,
  listAll: () => T[],
  isActive: (entity: T) => boolean,
): T | undefined {
  const byId = getById(id);
  if (byId && isActive(byId)) return byId;

  return findByOperationalNames(listAll(), prefixedLookupNames(id, prefix), isActive) ?? byId;
}

function prefixedLookupNames(id: string, prefix: "agent" | "bus" | "group" | "flow"): string[] {
  return id.startsWith(`${prefix}-`) ? [id] : [id, `${prefix}-${id}`];
}

function findByOperationalNames<T extends NamedEntity>(
  entities: T[],
  names: string[],
  isActive: (entity: T) => boolean,
): T | undefined {
  for (const name of names) {
    const active = findLatestByName(entities, name, isActive);
    if (active) return active;
  }
  for (const name of names) {
    const inactive = findLatestByName(entities, name, () => true);
    if (inactive) return inactive;
  }
  return undefined;
}

function findLatestByName<T extends NamedEntity>(
  entities: T[],
  name: string,
  predicate: (entity: T) => boolean,
): T | undefined {
  for (let index = entities.length - 1; index >= 0; index--) {
    const entity = entities[index];
    if (entity.name === name && predicate(entity)) return entity;
  }
  return undefined;
}

export function resolveBusName(store: AgentStore, busId: string): string {
  return store.getBus(busId)?.name ?? busId;
}

export function resolveRunName(store: AgentStore, runId: string): string {
  return store.getRun(runId)?.name ?? runId;
}

export function findAgentRun(store: AgentStore, id: string): AgentRun | undefined {
  return findEntity(
    id,
    "agent",
    (runId) => store.getRun(runId),
    () => store.listRuns(),
    (run) => run.state !== "closed",
  );
}

export function resolveWorkgroupName(store: AgentStore, workgroupId: string): string {
  return store.getWorkgroup(workgroupId)?.name ?? workgroupId;
}

export function resolveWorkflowName(store: AgentStore, workflowId: string): string {
  return store.getWorkflow(workflowId)?.name ?? workflowId;
}

export type LifecycleState = AgentRun["state"];

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

export function requireParam<T extends object, K extends keyof T>(params: T, key: K, label: string): NonNullable<T[K]> {
  const value = params[key];
  if (!value) throw new Error(`${label} requires ${String(key)}.`);
  return value as NonNullable<T[K]>;
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
