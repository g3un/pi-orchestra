import type { AgentRun } from "./core/subagent.ts";
import { truncateText } from "./formatting.ts";
import { isAgentRunActive } from "./utils.ts";

export type AgentHealthPhase = "active" | "retrying" | "compacting" | "waiting";

export interface AgentHealthSnapshot {
  phase: AgentHealthPhase;
  finalError?: string;
  contextPercent?: number;
}

export type ResolveAgentHealth = (runId: string) => AgentHealthSnapshot | undefined;

const MAX_HEALTH_ERROR_LENGTH = 120;

export function formatAgentHealth(health: AgentHealthSnapshot | undefined): string | undefined {
  if (!health) return undefined;

  const parts: string[] = health.phase === "active" ? [] : [health.phase];
  if (health.contextPercent !== undefined) parts.push(`ctx=${Math.round(health.contextPercent)}%`);
  if (health.finalError)
    parts.push(`error=${truncateText(formatInline(health.finalError), MAX_HEALTH_ERROR_LENGTH, "…")}`);
  return parts.length > 0 ? `[${parts.join(" ")}]` : undefined;
}

export function formatAggregateAgentHealth(
  runs: AgentRun[],
  resolveHealth: ResolveAgentHealth | undefined,
): string | undefined {
  if (!resolveHealth) return undefined;

  const phases = new Map<AgentHealthPhase, number>();
  let failures = 0;
  let maxContextPercent: number | undefined;
  for (const run of runs) {
    if (!isAgentRunActive(run)) {
      if (run.result?.status === "failed") failures++;
      continue;
    }

    const health = resolveHealth(run.id);
    if (!health) continue;

    if (health.phase !== "active") phases.set(health.phase, (phases.get(health.phase) ?? 0) + 1);
    if (health.finalError) failures++;
    if (health.contextPercent !== undefined)
      maxContextPercent =
        maxContextPercent === undefined ? health.contextPercent : Math.max(maxContextPercent, health.contextPercent);
  }

  const parts = [...phases.entries()].map(([phase, count]) => `${phase}=${count}`);
  if (failures > 0) parts.push(`failures=${failures}`);
  if (maxContextPercent !== undefined) parts.push(`ctx<=${Math.round(maxContextPercent)}%`);
  return parts.length > 0 ? `[health ${parts.join(" ")}]` : undefined;
}

function formatInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
