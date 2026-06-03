import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi, WaitBusSettledResult, WaitNextRunResult, WaitRunResult } from "../core/orchestra.ts";
import { formatNamedEntityLabel, indent } from "../utils.ts";

export type BusInput =
  | {
      action: "create";
      name?: string;
    }
  | {
      action: "status";
      id: string;
    }
  | {
      action: "publish";
      id: string;
      message: string;
      from?: string;
    }
  | {
      action: "wait_settled";
      id: string;
      /** Defaults to 10 minutes. Use null to wait indefinitely. */
      timeoutMs?: number | null;
    }
  | {
      action: "wait_next";
      id: string;
      /** Run ids or names to ignore. */
      excludeRunIds?: string[];
      /** Defaults to 10 minutes. Use null to wait indefinitely. */
      timeoutMs?: number | null;
    };

export interface BusOutput {
  bus?: Bus;
  busMessage?: BusMessage;
  run?: AgentRun;
  runResult?: WaitRunResult;
  runs?: AgentRun[];
  runResults?: WaitRunResult[];
  timedOut?: boolean;
  pendingRunIds?: string[];
  message: string;
}

export interface BusTool {
  name: "bus";
  execute(input: BusInput): Promise<BusOutput>;
}

export interface BusToolDeps {
  orchestra: OrchestraApi;
}

const BusActionParams = Type.String({
  enum: ["create", "status", "publish", "wait_settled", "wait_next"],
  description:
    "Action to perform. A bus is the work grouping boundary: create allocates one work bus, status inspects a work bus by id, publish sends shared context, wait_settled waits for every current attached run to reach terminal state, and wait_next waits for the next current run to reach terminal state.",
});

const BusToolParams = Type.Object(
  {
    action: BusActionParams,
    name: Type.Optional(
      Type.String({
        description:
          "Optional short, human-readable bus name for action=create. If omitted, a short name is generated.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Required for action=status, action=publish, action=wait_settled, and action=wait_next. Bus id or name returned by action=create; one bus groups the subagents for a delegated work item.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=publish. Shared context to add to the work bus for all attached agents.",
      }),
    ),
    excludeRunIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional for action=wait_next. Run ids or names to ignore because they were already handled.",
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
            "Optional for action=wait_settled and action=wait_next. Positive timeout in milliseconds. Defaults to 10 minutes. Use null to wait indefinitely. On timeout, returns the latest collected state.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export function createBusTool({ orchestra }: BusToolDeps): BusTool {
  return {
    name: "bus",

    async execute(input) {
      if (input.action === "create") {
        const bus = orchestra.createBus({ name: input.name });
        return { bus, message: formatBusStatus(bus, `Created bus ${formatNamedEntityLabel(bus)}.`) };
      }

      const bus = orchestra.getBus(input.id);
      if (!bus) return { message: `Bus ${input.id} not found.` };

      if (input.action === "status") {
        return { bus, message: formatBusStatus(bus) };
      }

      if (input.action === "wait_settled") {
        const output = await orchestra.waitBusSettled(bus.id, { timeoutMs: input.timeoutMs });
        return {
          bus: output.bus,
          runs: output.runs,
          runResults: output.runResults,
          timedOut: output.timedOut,
          pendingRunIds: output.pendingRunIds,
          message: formatWaitBusSettledMessage(output),
        };
      }

      if (input.action === "wait_next") {
        const output = await orchestra.waitNextRun(bus.id, {
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
      }

      const published = await orchestra.publishBus(input.id, input.message, input.from ?? "main");
      return {
        bus: published.bus,
        busMessage: published.busMessage,
        message: formatBusStatus(published.bus, `Published message to bus ${formatNamedEntityLabel(published.bus)}.`),
      };
    },
  };
}

export function defineBusPiTool(resolveTool: (ctx: ExtensionContext) => BusTool) {
  return defineTool({
    name: "bus",
    label: "Bus",
    description:
      "Create, inspect, publish to, and wait on shared context buses. A bus is the work grouping boundary: one delegated task or team should share one bus, with one or more subagents attached to it.",
    promptSnippet:
      "Create one bus per delegated work item, spawn related subagents on it, publish shared context to that bus, and use wait actions to collect run results.",
    promptGuidelines: [
      "Use action=create before spawning a subagent or agent team; the returned bus is the work grouping boundary.",
      "Give each bus a short name when useful, and pass the returned bus id or name as subagent action=spawn busId so each subagent joins that work group.",
      "Multiple subagents can attach to the same bus when they are cooperating on the same delegated work item.",
      "Use action=publish to send updated parent context to every active subagent attached to the bus.",
      "Use action=wait_next when acting as a workgroup leader and you want to handle subagent results as they arrive.",
      "Use action=wait_settled when you need the whole bus work group to reach a terminal state before continuing.",
      "Use action=status to inspect the messages already published on a bus.",
    ],
    parameters: BusToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await resolveTool(ctx).execute(toBusInput(params as RawBusParams));

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

function toBusInput(params: RawBusParams): BusInput {
  if (params.action === "create") return { action: "create", name: params.name };

  if (params.action === "status") {
    if (!params.id) throw new Error("bus action=status requires id.");
    return { action: "status", id: params.id };
  }

  if (params.action === "wait_settled") {
    if (!params.id) throw new Error("bus action=wait_settled requires id.");
    return { action: "wait_settled", id: params.id, timeoutMs: params.timeoutMs };
  }

  if (params.action === "wait_next") {
    if (!params.id) throw new Error("bus action=wait_next requires id.");
    return {
      action: "wait_next",
      id: params.id,
      excludeRunIds: params.excludeRunIds,
      timeoutMs: params.timeoutMs,
    };
  }

  if (!params.id) throw new Error("bus action=publish requires id.");
  if (!params.message) throw new Error("bus action=publish requires message.");
  return { action: "publish", id: params.id, message: params.message };
}

function formatBusStatus(
  bus: Bus,
  headline = `Bus ${formatNamedEntityLabel(bus)} has ${bus.messages.length} message(s).`,
): string {
  if (bus.messages.length === 0) return headline;

  return [headline, "", "Messages:", ...bus.messages.map(formatBusMessage)].join("\n");
}

function formatBusMessage(message: BusMessage): string {
  return [`- ${message.id} from ${message.from}:`, indent(message.message)].join("\n");
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

function formatWaitNextRunMessage(result: WaitNextRunResult): string {
  const busLabel = formatNamedEntityLabel(result.bus);
  if (result.run) {
    return [
      `Next terminal run on bus ${busLabel}: ${formatNamedEntityLabel(result.run)} is ${result.run.state}.`,
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

type RawBusParams = {
  action: "create" | "status" | "publish" | "wait_settled" | "wait_next";
  name?: string;
  id?: string;
  message?: string;
  excludeRunIds?: string[];
  timeoutMs?: number | null;
};
