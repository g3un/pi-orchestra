import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

const WaitNextRunToolParams = Type.Object(
  {
    busId: Type.String({
      description:
        "Work bus id or name to wait for. The tool returns the next current run on this bus that reaches a terminal state.",
    }),
    excludeRunIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional run ids or names to ignore because the leader has already handled them.",
      }),
    ),
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
            "Optional positive timeout in milliseconds. Defaults to 10 minutes. Use null to wait indefinitely. On timeout, waitNextRun returns the latest collected state without a completed run.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

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

export function defineWaitNextRunPiTool(resolveTool: (ctx: ExtensionContext) => WaitNextRunTool) {
  return defineTool({
    name: "waitNextRun",
    label: "Wait Next Run",
    description: "Wait for the next current run attached to a work bus to reach a terminal state.",
    promptSnippet: "Wait for one more subagent on a bus to finish so the leader can react and coordinate.",
    promptGuidelines: [
      "Use waitNextRun when acting as a workgroup leader and you want to handle subagent results as they arrive.",
      "Pass excludeRunIds with run ids or names you have already handled to avoid receiving the same terminal run again.",
      "By default waitNextRun times out after 10 minutes. Set timeoutMs to a positive millisecond value, or null to wait indefinitely.",
    ],
    parameters: WaitNextRunToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await resolveTool(ctx).execute(toWaitNextRunInput(params as RawWaitNextRunParams));

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

function toWaitNextRunInput(params: RawWaitNextRunParams): WaitNextRunInput {
  if (!params.busId) throw new Error("waitNextRun requires busId.");
  return { busId: params.busId, excludeRunIds: params.excludeRunIds, timeoutMs: params.timeoutMs };
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

type RawWaitNextRunParams = {
  busId?: string;
  excludeRunIds?: string[];
  timeoutMs?: number | null;
};
