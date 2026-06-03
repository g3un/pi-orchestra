import type { BusMessage } from "./bus.ts";

export function formatBusMessages(messages: BusMessage[]): string {
  return [
    "<bus_reference_context>",
    "Supplemental peer context; not the active task unless explicitly instructed.",
    ...messages.map(formatBusMessage),
    "</bus_reference_context>",
  ].join("\n");
}

function formatBusMessage(message: BusMessage): string {
  return [`<bus_message from="${message.from}">`, message.message, "</bus_message>"].join("\n");
}
