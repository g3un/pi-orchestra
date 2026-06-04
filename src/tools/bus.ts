import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import { formatNamedEntityLabel } from "../utils.ts";

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
  description: "create/status/publish shared context buses; completion is delivered through pi-orchestra events.",
});

const BusToolParams = Type.Object(
  {
    action: BusActionParams,
    name: Type.Optional(
      Type.String({
        description: "Optional short bus name for action=create.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Required except create. Bus id/name returned by action=create.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for action=publish. Shared context for attached agents.",
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
      if (!bus) return { message: formatBusNotFound(input.id) };

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
    description: "Create, inspect, and publish to work buses.",
    promptSnippet: "Use one bus per delegated work item; spawn related subagents or workgroups on it.",
    promptGuidelines: [
      "Use bus create before spawning related subagents or workgroups; reuse it for that work item.",
      "Use bus publish to send shared context to attached agents; bus status shows published messages.",
      "Do not wait on buses; pi-orchestra delivers subagent and workgroup finish events automatically.",
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

  if (!params.id) throw new Error("bus action=publish requires id.");
  if (!params.message) throw new Error("bus action=publish requires message.");
  return { action: "publish", id: params.id, message: params.message };
}

function formatBusNotFound(id: string): string {
  return `Bus ${id} not found.`;
}

function formatBusStatus(
  bus: Bus,
  headline = `Bus ${formatNamedEntityLabel(bus)} has ${bus.messages.length} message(s).`,
): string {
  if (bus.messages.length === 0) return headline;

  return [headline, "", "Messages:", ...bus.messages.map(formatBusMessage)].join("\n");
}

function formatBusMessage(message: BusMessage): string {
  return [`- ${message.id} from ${message.from}:`, message.message].join("\n");
}

type RawBusParams = {
  action: "create" | "status" | "publish";
  name?: string;
  id?: string;
  message?: string;
};
