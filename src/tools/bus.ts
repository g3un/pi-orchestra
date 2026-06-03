import type { Bus, BusMessage } from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";

export type BusInput =
  | {
      action: "create";
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

export function createBusTool({ orchestra }: BusToolDeps): BusTool {
  return {
    name: "bus",

    async execute(input) {
      if (input.action === "create") {
        const bus = orchestra.createBus();
        return { bus, message: formatBusStatus(bus, `Created bus ${bus.id}.`) };
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
        message: formatBusStatus(published.bus, `Published message to bus ${published.bus.id}.`),
      };
    },
  };
}

function formatBusStatus(bus: Bus, headline = `Bus ${bus.id} has ${bus.messages.length} message(s).`): string {
  if (bus.messages.length === 0) return headline;

  return [headline, "", "Messages:", ...bus.messages.map(formatBusMessage)].join("\n");
}

function formatBusMessage(message: BusMessage): string {
  return [`- ${message.id} from ${message.from}:`, indent(message.message)].join("\n");
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
