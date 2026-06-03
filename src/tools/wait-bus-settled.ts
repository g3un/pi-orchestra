import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { OrchestraApi, WaitBusSettledResult, WaitRunResult } from "../core/orchestra.ts";
import { formatNamedEntityLabel } from "../utils.ts";

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

const WaitBusSettledToolParams = Type.Object(
  {
    busId: Type.String({
      description:
        "Work bus id or name to wait for. The tool returns when every current run attached to this bus is finished, failed, or closed.",
    }),
    timeoutMs: Type.Optional(
      Type.Union(
        [
          Type.Number({
            exclusiveMinimum: 0,
          }),
          Type.Null(),
        ],
        {
          description:
            "Optional positive timeout in milliseconds. Defaults to 10 minutes. Use null to wait indefinitely. On timeout, waitBusSettled returns the latest collected state for current runs attached to the bus.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

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

export function defineWaitBusSettledPiTool(resolveTool: (ctx: ExtensionContext) => WaitBusSettledTool) {
  return defineTool({
    name: "waitBusSettled",
    label: "Wait Bus Settled",
    description: "Wait until all current agent runs attached to a work bus reach a terminal state.",
    promptSnippet: "Wait for every current subagent on a bus to finish before collecting their statuses.",
    promptGuidelines: [
      "Use waitBusSettled when you need the whole bus work group to finish before continuing.",
      "Pass the busId for the delegated work item; the tool waits for every current run attached to that bus.",
      "By default waitBusSettled times out after 10 minutes. Set timeoutMs to a positive millisecond value, or null to wait indefinitely.",
      "On timeout, the tool returns the latest collected run states for the bus instead of failing.",
    ],
    parameters: WaitBusSettledToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await resolveTool(ctx).execute(toWaitBusSettledInput(params as RawWaitBusSettledParams));

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

function toWaitBusSettledInput(params: RawWaitBusSettledParams): WaitBusSettledInput {
  if (!params.busId) throw new Error("waitBusSettled requires busId.");
  return { busId: params.busId, timeoutMs: params.timeoutMs };
}

function formatWaitBusSettledMessage(result: WaitBusSettledResult): string {
  const busLabel = formatNamedEntityLabel(result.bus);
  const headline = result.timedOut
    ? `Timed out waiting for bus ${busLabel} to settle; ${result.pendingRunIds.length} run(s) still pending.`
    : `All ${result.runs.length} run(s) attached to bus ${busLabel} reached terminal state.`;
  if (result.runs.length === 0) return headline;

  return [headline, "", "Runs:", ...result.runs.map(formatRunSummary)].join("\n");
}

function formatRunSummary(run: AgentRun): string {
  const runLabel = formatNamedEntityLabel(run);
  if (!run.result) return `- ${runLabel}: ${run.state}`;
  return `- ${runLabel}: ${run.state} result=${run.result.status} summary=${run.result.summary}`;
}

type RawWaitBusSettledParams = {
  busId?: string;
  timeoutMs?: number | null;
};
