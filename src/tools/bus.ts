import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createBusSubscription,
  createBusSubscriptionId,
  maxMessageSeq,
  type Bus,
  type BusMessage,
  type BusSubscription,
} from "../core/bus.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import type { AgentStore } from "../core/store.ts";
import { requireParam, resolveRunName } from "../utils.ts";
import { DETAIL_MAX_COLLECTION_ITEMS, formatBusMessageText } from "../formatting.ts";

export type BusInput =
  | {
      action: "create";
      name: string | undefined;
    }
  | {
      action: "status";
      name: string;
    }
  | {
      action: "publish";
      name: string;
      message: string;
      from: string;
    }
  | {
      action: "subscribe";
      name: string;
    }
  | {
      action: "unsubscribe";
      name: string;
    };

export interface BusOutput {
  bus?: Bus;
  busMessage?: BusMessage;
  subscription?: BusSubscription;
  message: string;
}

export interface BusTool {
  name: "bus";
  execute(input: BusInput): Promise<BusOutput>;
}

export interface BusToolDeps {
  orchestra: OrchestraApi;
  store: AgentStore;
}

const BusActionParams = Type.String({
  enum: ["create", "status", "publish", "subscribe", "unsubscribe"],
  description: "Manage shared buses: create/status/publish/subscribe/unsubscribe.",
});

const BusToolParams = Type.Object(
  {
    action: BusActionParams,
    name: Type.Optional(
      Type.String({
        description: "Bus name. Optional for create; required for status/publish/subscribe/unsubscribe.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for publish. Shared context message.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createBusTool({ orchestra, store }: BusToolDeps): BusTool {
  return {
    name: "bus",

    async execute(input) {
      if (input.action === "create") {
        const bus = orchestra.createBus({ name: input.name });
        return { bus, message: formatBusStatus(bus, store, `Created bus ${formatBusLabel(bus)}.`) };
      }

      const bus = orchestra.getBus(input.name);
      if (!bus) return { message: formatBusNotFound(input.name) };

      if (input.action === "status") {
        return { bus, message: formatBusStatus(bus, store) };
      }

      if (input.action === "subscribe") {
        if (bus.state === "closed") throw new Error(`Bus ${input.name} is closed.`);
        const subscription = subscribeMainToBus(store, bus);
        return { bus, subscription, message: `Subscribed main to bus ${formatBusLabel(bus)} for new messages.` };
      }

      if (input.action === "unsubscribe") {
        const subscriptionId = createBusSubscriptionId(bus.id, "main", "main");
        store.deleteBusSubscription(subscriptionId);
        return { bus, message: `Unsubscribed main from bus ${formatBusLabel(bus)}.` };
      }

      const published = await orchestra.publishBus(input.name, input.message, input.from ?? "main");
      return {
        bus: published.bus,
        busMessage: published.busMessage,
        message: formatBusStatus(published.bus, store, `Published message to bus ${formatBusLabel(published.bus)}.`),
      };
    },
  };
}

export function defineBusPiTool(resolveTool: (ctx: ExtensionContext) => BusTool) {
  return defineTool({
    name: "bus",
    label: "Bus",
    description: "Manage shared context buses.",
    promptSnippet: "Create, inspect, publish, or subscribe to buses.",
    promptGuidelines: [
      "Use bus for main-owned shared context; child agents use publish_bus instead.",
      "Use bus names for lookup; finish events arrive separately.",
    ],
    parameters: BusToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = toBusInput(params as RawBusParams);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: output.message }],
        details: boundBusOutputDetails(output),
      };
    },
  });
}

function boundBusOutputDetails(output: BusOutput): unknown {
  return {
    ...output,
    bus: output.bus ? boundBusDetails(output.bus) : undefined,
    busMessage: output.busMessage ? boundBusMessageDetails(output.busMessage) : undefined,
  };
}

type BoundedBusDetails = Bus & { omittedMessagesCount: number };

export function boundBusDetails(bus: Bus): BoundedBusDetails {
  const visible = latestBusMessages(bus);
  return {
    ...bus,
    messages: visible.map(boundBusMessageDetails),
    omittedMessagesCount: bus.messages.length - visible.length,
  };
}

function boundBusMessageDetails(message: BusMessage): BusMessage {
  return { ...message, message: formatBusMessageText(message.message) };
}

function toBusInput(params: RawBusParams): BusInput {
  if (params.action === "create") return { action: "create", name: params.name };

  if (params.action === "status") return { action: "status", name: requireParam(params, "name", "bus action=status") };

  if (params.action === "subscribe")
    return { action: "subscribe", name: requireParam(params, "name", "bus action=subscribe") };

  if (params.action === "unsubscribe")
    return { action: "unsubscribe", name: requireParam(params, "name", "bus action=unsubscribe") };

  return {
    action: "publish",
    name: requireParam(params, "name", "bus action=publish"),
    message: requireParam(params, "message", "bus action=publish"),
    from: "main",
  };
}

export function subscribeMainToBus(store: AgentStore, bus: Bus): BusSubscription {
  const id = createBusSubscriptionId(bus.id, "main", "main");
  const subscription =
    store.getBusSubscription(id) ??
    createBusSubscription({
      busId: bus.id,
      subscriberId: "main",
      subscriberKind: "main",
      lastDeliveredSeq: maxMessageSeq(bus.messages),
      deliveredSeqs: [],
    });
  store.saveBusSubscription(subscription);
  return subscription;
}

function formatBusNotFound(name: string): string {
  return `Bus ${name} not found.`;
}

const BUS_STATUS_MAX_MESSAGES = DETAIL_MAX_COLLECTION_ITEMS;

function formatBusStatus(
  bus: Bus,
  store: AgentStore,
  headline = `Bus ${formatBusLabel(bus)} has ${bus.messages.length} message(s).`,
): string {
  const subscriptions = store.listBusSubscriptions({
    busId: bus.id,
    subscriberId: undefined,
    subscriberKind: undefined,
  });
  const statusHeadline = [headline, `State: ${bus.state}`, `Subscribers: ${subscriptions.length}`].join("\n");
  if (bus.messages.length === 0) return statusHeadline;

  const visible = latestBusMessages(bus);
  const omitted = bus.messages.length - visible.length;
  const heading = omitted > 0 ? `Messages (latest ${visible.length} of ${bus.messages.length}):` : "Messages:";
  return [statusHeadline, "", heading, ...visible.map((message) => formatBusMessage(message, store))].join("\n");
}

function latestBusMessages(bus: Bus): BusMessage[] {
  return bus.messages.slice(Math.max(0, bus.messages.length - BUS_STATUS_MAX_MESSAGES));
}

function formatBusMessage(message: BusMessage, store: AgentStore): string {
  return [`- from ${formatBusMessageFrom(message.from, store)}:`, formatBusMessageText(message.message)].join("\n");
}

function formatBusMessageFrom(from: string, store: AgentStore): string {
  if (from === "main") return from;
  return resolveRunName(store, from);
}

function formatBusLabel(bus: Bus): string {
  return bus.name;
}

type RawBusParams = {
  action: "create" | "status" | "publish" | "subscribe" | "unsubscribe";
  name?: string;
  message?: string;
};
