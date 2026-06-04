export interface StoreSubscription<T> {
  listener(value: T): void;
  filter: ((value: T) => boolean) | undefined;
}

export function subscribeStore<T>(
  subscriptions: Set<StoreSubscription<T>>,
  listener: (value: T) => void,
  filter: ((value: T) => boolean) | undefined,
): () => void {
  const subscription = { listener, filter };
  subscriptions.add(subscription);
  return () => subscriptions.delete(subscription);
}

export function notifySubscribers<T>(subscriptions: Set<StoreSubscription<T>>, value: T): void {
  for (const subscription of subscriptions) {
    if (!subscription.filter || subscription.filter(value)) subscription.listener(value);
  }
}
