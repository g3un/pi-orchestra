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
  };
}

export function isBusMessageDelivered(subscription: BusSubscription, messageId: string): boolean {
  return subscription.lastDeliveredMessageId !== null && messageId <= subscription.lastDeliveredMessageId;
}

export function markBusMessagesDelivered(
  subscription: BusSubscription,
  messages: BusMessage | BusMessage[],
): BusSubscription {
  const deliveredMessageIds = [
    ...(subscription.lastDeliveredMessageId ? [subscription.lastDeliveredMessageId] : []),
    ...(Array.isArray(messages) ? messages : [messages]).map((message) => message.id),
  ];
  return { ...subscription, lastDeliveredMessageId: maxMessageId(deliveredMessageIds) };
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
