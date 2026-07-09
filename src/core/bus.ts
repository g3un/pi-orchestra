export const BUS_NAME_MAX_LENGTH = 64;

export type BusState = "open" | "closed";

export interface BusMessage {
  id: string;
  seq: number;
  message: string;
  from: string;
}

export type NewBusMessage = Omit<BusMessage, "seq"> & { seq?: never };

export interface BusMessageEvent {
  busId: string;
  message: BusMessage;
}

import type { AgentStore } from "./store.ts";

export type BusSubscriberKind = "agent" | "main";

export interface BusSubscription {
  id: string;
  busId: string;
  subscriberId: string;
  subscriberKind: BusSubscriberKind;
  lastDeliveredSeq: number;
  deliveredSeqs: number[];
}

export interface ListBusSubscriptionsOptions {
  busId: string | undefined;
  subscriberId: string | undefined;
  subscriberKind: BusSubscriberKind | undefined;
}

export interface BusMetadata {
  autoClose?: "standalone-subagent-private";
  ownerSessionId: string;
}

export interface Bus {
  id: string;
  name: string;
  state: BusState;
  messages: BusMessage[];
  nextMessageSeq: number;
  metadata?: BusMetadata;
}

export interface CreateBusSubscriptionOptions {
  busId: string;
  subscriberId: string;
  subscriberKind: BusSubscriberKind;
  lastDeliveredSeq: number;
  deliveredSeqs: number[];
}

export function createBusSubscriptionId(
  busId: string,
  subscriberKind: BusSubscriberKind,
  subscriberId: string,
): string {
  return `${subscriberKind}:${subscriberId}:bus:${busId}`;
}

export function createBusSubscription(options: CreateBusSubscriptionOptions): BusSubscription {
  return {
    id: createBusSubscriptionId(options.busId, options.subscriberKind, options.subscriberId),
    busId: options.busId,
    subscriberId: options.subscriberId,
    subscriberKind: options.subscriberKind,
    lastDeliveredSeq: options.lastDeliveredSeq,
    deliveredSeqs: [...options.deliveredSeqs].sort((left, right) => left - right),
  };
}

export function isBusMessageDelivered(subscription: BusSubscription, message: BusMessage): boolean {
  return message.seq <= subscription.lastDeliveredSeq || subscription.deliveredSeqs.includes(message.seq);
}

export function markBusMessagesDelivered(
  subscription: BusSubscription,
  messages: BusMessage | BusMessage[],
): BusSubscription {
  const deliveredSeqs = new Set(subscription.deliveredSeqs);
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    if (message.seq > subscription.lastDeliveredSeq) deliveredSeqs.add(message.seq);
  }

  let lastDeliveredSeq = subscription.lastDeliveredSeq;
  while (deliveredSeqs.delete(lastDeliveredSeq + 1)) lastDeliveredSeq += 1;

  return {
    ...subscription,
    lastDeliveredSeq,
    deliveredSeqs: [...deliveredSeqs].filter((seq) => seq > lastDeliveredSeq).sort((left, right) => left - right),
  };
}

export function markBusMessageDeliveredForSubscriber(
  store: Pick<AgentStore, "getBusSubscription" | "saveBusSubscription">,
  busId: string,
  subscriberKind: BusSubscriberKind,
  subscriberId: string,
  message: BusMessage,
): void {
  const subscription = store.getBusSubscription(createBusSubscriptionId(busId, subscriberKind, subscriberId));
  if (!subscription) return;

  store.saveBusSubscription(markBusMessagesDelivered(subscription, message));
}

export function maxMessageSeq(messages: BusMessage[]): number {
  let maxSeq = 0;
  for (const message of messages) {
    if (message.seq > maxSeq) maxSeq = message.seq;
  }
  return maxSeq;
}

export function matchesBusSubscription(subscription: BusSubscription, options: ListBusSubscriptionsOptions): boolean {
  if (options.busId !== undefined && subscription.busId !== options.busId) return false;
  if (options.subscriberId !== undefined && subscription.subscriberId !== options.subscriberId) return false;
  if (options.subscriberKind !== undefined && subscription.subscriberKind !== options.subscriberKind) return false;
  return true;
}
