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
  const busLabel = formatBusLabel(result.bus);
  const headline = result.timedOut
    ? `Timed out waiting for bus ${busLabel}; ${result.pendingRunIds.length} run(s) still pending.`
    : `All ${result.runs.length} run(s) attached to bus ${busLabel} reached terminal state.`;
  if (result.runs.length === 0) return headline;

  return [headline, "", "Runs:", ...result.runs.map(formatRunSummary)].join("\n");
}

function formatRunSummary(run: AgentRun): string {
  const runLabel = formatRunLabel(run);
  if (!run.result) return `- ${runLabel}: ${run.state}`;
  return `- ${runLabel}: ${run.state} result=${run.result.status} summary=${run.result.summary}`;
}

function formatBusLabel(bus: Bus): string {
  return bus.name === bus.id ? bus.id : `${bus.name} (${bus.id})`;
}

function formatRunLabel(run: AgentRun): string {
  return run.name === run.id ? run.id : `${run.name} (${run.id})`;
}
