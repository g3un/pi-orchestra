import type { AgentRun } from "../core/agent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi, WaitNextRunResult, WaitRunResult } from "../core/orchestra.ts";

export interface WaitNextRunInput {
  busId: string;
  /** Run ids or names to ignore. */
  excludeRunIds?: string[];
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
}

export interface WaitNextRunOutput {
  bus: Bus;
  run?: AgentRun;
  runResult?: WaitRunResult;
  runs: AgentRun[];
  runResults: WaitRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
  message: string;
}

export interface WaitNextRunTool {
  name: "waitNextRun";
  execute(input: WaitNextRunInput): Promise<WaitNextRunOutput>;
}

export interface WaitNextRunToolDeps {
  orchestra: OrchestraApi;
}

export function createWaitNextRunTool({ orchestra }: WaitNextRunToolDeps): WaitNextRunTool {
  return {
    name: "waitNextRun",

    async execute(input) {
      const output = await orchestra.waitNextRun(input.busId, {
        excludeRunIds: input.excludeRunIds,
        timeoutMs: input.timeoutMs,
      });
      return {
        bus: output.bus,
        run: output.run,
        runResult: output.runResult,
        runs: output.runs,
        runResults: output.runResults,
        timedOut: output.timedOut,
        pendingRunIds: output.pendingRunIds,
        message: formatWaitNextRunMessage(output),
      };
    },
  };
}

function formatWaitNextRunMessage(result: WaitNextRunResult): string {
  const busLabel = formatBusLabel(result.bus);
  if (result.run) {
    return [
      `Next completed run on bus ${busLabel}: ${formatRunLabel(result.run)} is ${result.run.state}.`,
      "",
      formatRunResult(result.run),
    ].join("\n");
  }

  if (result.timedOut) {
    return `Timed out waiting for the next run on bus ${busLabel}; ${result.pendingRunIds.length} run(s) still pending.`;
  }

  return `No unhandled current runs remain on bus ${busLabel}.`;
}

function formatRunResult(run: AgentRun): string {
  if (!run.result) return "No result payload recorded.";
  return [`Result: ${run.result.status}`, run.result.summary].join("\n");
}

function formatBusLabel(bus: Bus): string {
  return bus.name === bus.id ? bus.id : `${bus.name} (${bus.id})`;
}

function formatRunLabel(run: AgentRun): string {
  return run.name === run.id ? run.id : `${run.name} (${run.id})`;
}
