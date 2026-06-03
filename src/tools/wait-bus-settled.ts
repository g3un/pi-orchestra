import type { AgentRun } from "../core/agent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi, WaitBusSettledResult, WaitRunResult } from "../core/orchestra.ts";

export interface WaitBusSettledInput {
  busId: string;
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
}

export interface WaitBusSettledOutput {
  bus: Bus;
  runs: AgentRun[];
  runResults: WaitRunResult[];
  timedOut: boolean;
  pendingRunIds: string[];
  message: string;
}

export interface WaitBusSettledTool {
  name: "waitBusSettled";
  execute(input: WaitBusSettledInput): Promise<WaitBusSettledOutput>;
}

export interface WaitBusSettledToolDeps {
  orchestra: OrchestraApi;
}

export function createWaitBusSettledTool({ orchestra }: WaitBusSettledToolDeps): WaitBusSettledTool {
  return {
    name: "waitBusSettled",

    async execute(input) {
      const output = await orchestra.waitBusSettled(input.busId, { timeoutMs: input.timeoutMs });
      return {
        bus: output.bus,
        runs: output.runs,
        runResults: output.runResults,
        timedOut: output.timedOut,
        pendingRunIds: output.pendingRunIds,
        message: formatWaitBusSettledMessage(output),
      };
    },
  };
}

function formatWaitBusSettledMessage(result: WaitBusSettledResult): string {
  const busLabel = formatBusLabel(result.bus);
  const headline = result.timedOut
    ? `Timed out waiting for bus ${busLabel} to settle; ${result.pendingRunIds.length} run(s) still pending.`
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
