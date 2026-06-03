import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
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
    };

export interface BusOutput {
  bus?: Bus;
  busMessage?: BusMessage;
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
  enum: ["create", "status", "publish"],
  description:
    "Action to perform. A bus is the work grouping boundary: create allocates one work bus, status inspects a work bus by id, and publish sends shared context to every active subagent attached to that bus.",
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
          "Required for action=status and action=publish. Bus id or name returned by action=create; one bus groups the subagents for a delegated work item.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=publish. Shared context to add to the work bus for all attached agents.",
      }),
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
      "Create, inspect, and publish shared context buses. A bus is the work grouping boundary: one delegated task or team should share one bus, with one or more subagents attached to it.",
    promptSnippet:
      "Create one bus per delegated work item, spawn related subagents on it, then publish shared context to that bus.",
    promptGuidelines: [
      "Use action=create before spawning a subagent or agent team; the returned bus is the work grouping boundary.",
      "Give each bus a short name when useful, and pass the returned bus id or name as subagent action=spawn busId so each subagent joins that work group.",
      "Multiple subagents can attach to the same bus when they are cooperating on the same delegated work item.",
      "Use action=publish to send updated parent context to every active subagent attached to the bus.",
      "Use action=status to inspect the messages already published on a bus.",
    ],
    parameters: BusToolParams,
    executionMode: "parallel",
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

type RawBusParams = {
  action: "create" | "status" | "publish";
  name?: string;
  id?: string;
  message?: string;
};
