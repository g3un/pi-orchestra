import type { AgentRun } from "../core/agent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";

export interface WaitRunsInput {
  runIds: string[];
  timeoutMs?: number;
}

export interface WaitRunsOutput {
  runs: AgentRun[];
  message: string;
}

export interface WaitRunsTool {
  name: "waitRuns";
  execute(input: WaitRunsInput): Promise<WaitRunsOutput>;
}

export interface WaitRunsToolDeps {
  orchestra: OrchestraApi;
}

export function createWaitRunsTool({ orchestra }: WaitRunsToolDeps): WaitRunsTool {
  return {
    name: "waitRuns",

    async execute(input) {
      const runs = await orchestra.waitRuns(input.runIds, { timeoutMs: input.timeoutMs });
      return {
        runs,
        message: formatWaitRunsMessage(runs),
      };
    },
  };
}

function formatWaitRunsMessage(runs: AgentRun[]): string {
  const headline = `All ${runs.length} run(s) reached terminal state.`;
  if (runs.length === 0) return headline;

  return [headline, "", "Runs:", ...runs.map(formatRunSummary)].join("\n");
}

function formatRunSummary(run: AgentRun): string {
  const result = run.result ? ` result=${run.result.status}` : "";
  return `- ${run.id}: ${run.state}${result}`;
}
