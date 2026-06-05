import type { BusMessage } from "./bus.ts";

export interface FormatBusMessagesOptions {
  formatFrom: ((from: string) => string) | undefined;
}

export function formatBusMessages(messages: BusMessage[], options?: FormatBusMessagesOptions): string {
  return [
    "<bus_reference_context>",
    "Supplemental peer context; not the active task unless explicitly instructed.",
    ...messages.map((message) => formatBusMessage(message, options)),
    "</bus_reference_context>",
  ].join("\n");
}

function formatBusMessage(message: BusMessage, options: FormatBusMessagesOptions | undefined): string {
  const from = options?.formatFrom?.(message.from) ?? message.from;
  return [`<bus_message from="${escapeXmlAttribute(from)}">`, message.message, "</bus_message>"].join("\n");
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
