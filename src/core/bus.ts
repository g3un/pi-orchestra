export const BUS_NAME_MAX_LENGTH = 64;

export type BusState = "open" | "closed";

export interface BusMessage {
  id: string;
  message: string;
  from: string;
}

export interface BusMessageEvent {
  busId: string;
  message: BusMessage;
}

export type BusSubscriberKind = "agent" | "main";

export interface BusSubscription {
  id: string;
  busId: string;
  subscriberId: string;
  subscriberKind: BusSubscriberKind;
  lastDeliveredMessageId: string | null;
  deliveredMessageIds: string[];
}

export interface ListBusSubscriptionsOptions {
  busId: string | undefined;
  subscriberId: string | undefined;
  subscriberKind: BusSubscriberKind | undefined;
}

export interface Bus {
  id: string;
  name: string;
  state: BusState;
  messages: BusMessage[];
}

export interface CreateBusSubscriptionOptions {
  busId: string;
  subscriberId: string;
  subscriberKind: BusSubscriberKind;
  lastDeliveredMessageId: string | null;
  deliveredMessageIds: string[];
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
    lastDeliveredMessageId: options.lastDeliveredMessageId,
    deliveredMessageIds: [...options.deliveredMessageIds].sort(),
  };
}

export function isBusMessageDelivered(subscription: BusSubscription, messageId: string): boolean {
  return isAtOrBelowDeliveryWatermark(subscription, messageId) || subscription.deliveredMessageIds.includes(messageId);
}

export function markBusMessagesDelivered(
  subscription: BusSubscription,
  messages: BusMessage | BusMessage[],
  busMessages: BusMessage[],
): BusSubscription {
  const deliveredMessageIds = new Set(subscription.deliveredMessageIds);
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    if (!isAtOrBelowDeliveryWatermark(subscription, message.id)) deliveredMessageIds.add(message.id);
  }

  let lastDeliveredMessageId = subscription.lastDeliveredMessageId;
  for (const message of [...busMessages].sort(compareBusMessagesById)) {
    if (lastDeliveredMessageId !== null && message.id <= lastDeliveredMessageId) {
      deliveredMessageIds.delete(message.id);
      continue;
    }

    if (message.from !== subscription.subscriberId && !deliveredMessageIds.has(message.id)) break;

    lastDeliveredMessageId = message.id;
    deliveredMessageIds.delete(message.id);
  }

  const remainingDeliveredMessageIds = [...deliveredMessageIds]
    .filter((messageId) => lastDeliveredMessageId === null || messageId > lastDeliveredMessageId)
    .sort();
  return { ...subscription, lastDeliveredMessageId, deliveredMessageIds: remainingDeliveredMessageIds };
}

export function maxMessageId(messageIds: string[]): string | null {
  return messageIds.length > 0 ? messageIds.reduce((maxId, id) => (id > maxId ? id : maxId)) : null;
}

export function matchesBusSubscription(subscription: BusSubscription, options: ListBusSubscriptionsOptions): boolean {
  if (options.busId !== undefined && subscription.busId !== options.busId) return false;
  if (options.subscriberId !== undefined && subscription.subscriberId !== options.subscriberId) return false;
  if (options.subscriberKind !== undefined && subscription.subscriberKind !== options.subscriberKind) return false;
  return true;
}

function isAtOrBelowDeliveryWatermark(subscription: BusSubscription, messageId: string): boolean {
  return subscription.lastDeliveredMessageId !== null && messageId <= subscription.lastDeliveredMessageId;
}

function compareBusMessagesById(left: BusMessage, right: BusMessage): number {
  return left.id.localeCompare(right.id);
}
