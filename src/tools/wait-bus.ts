import type { AgentRun } from "../core/agent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi, WaitBusResult, WaitBusRunResult } from "../core/orchestra.ts";

export interface WaitBusInput {
  busId: string;
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
}

export interface WaitBusOutput {
  bus: Bus;
  runs: AgentRun[];
  runResults: WaitBusRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
  message: string;
}

export interface WaitBusTool {
  name: "waitBus";
  execute(input: WaitBusInput): Promise<WaitBusOutput>;
}

export interface WaitBusToolDeps {
  orchestra: OrchestraApi;
}

export function createWaitBusTool({ orchestra }: WaitBusToolDeps): WaitBusTool {
  return {
    name: "waitBus",

    async execute(input) {
      const output = await orchestra.waitBus(input.busId, { timeoutMs: input.timeoutMs });
      return {
        bus: output.bus,
        runs: output.runs,
        runResults: output.runResults,
        timedOut: output.timedOut,
        pendingRunIds: output.pendingRunIds,
        message: formatWaitBusMessage(output),
      };
    },
  };
}

function formatWaitBusMessage(result: WaitBusResult): string {
  const headline = result.timedOut
    ? `Timed out waiting for bus ${result.bus.id}; ${result.pendingRunIds.length} run(s) still pending.`
    : `All ${result.runs.length} run(s) attached to bus ${result.bus.id} reached terminal state.`;
  if (result.runs.length === 0) return headline;

  return [headline, "", "Runs:", ...result.runs.map(formatRunSummary)].join("\n");
}

function formatRunSummary(run: AgentRun): string {
  if (!run.result) return `- ${run.id}: ${run.state}`;
  return `- ${run.id}: ${run.state} result=${run.result.status} summary=${run.result.summary}`;
}
