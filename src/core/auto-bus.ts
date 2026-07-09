import { isBusMessageDelivered, type Bus } from "./bus.ts";
import type { OrchestraApi } from "./orchestra.ts";
import type { AgentStore } from "./store.ts";

export function closeStandalonePrivateBusIfUnused(
  store: AgentStore,
  closeBus: (busId: string) => Bus | undefined,
  busId: string,
): Bus | undefined {
  const bus = store.getBus(busId);
  if (!bus || bus.state === "closed") return undefined;
  if (bus.metadata?.autoClose !== "standalone-subagent-private") return undefined;
  if (hasMessageableParticipantsOnBus(store, bus.id)) return undefined;
  return closeBus(bus.id);
}

export async function closeRuntimeOwnedStandalonePrivateBuses(
  store: AgentStore,
  orchestra: OrchestraApi,
  ownerSessionId: string,
): Promise<void> {
  const ownRuns = store.listRuns().filter((run) => run.ownerSessionId === ownerSessionId && run.state !== "closed");

  await Promise.allSettled(ownRuns.map(async (run) => await orchestra.closeAgent(run.id, { busId: undefined })));

  const ownBusIds = store
    .listBuses()
    .filter(
      (bus) =>
        bus.state === "open" &&
        bus.metadata?.autoClose === "standalone-subagent-private" &&
        bus.metadata.ownerSessionId === ownerSessionId,
    )
    .map((bus) => bus.id);

  for (const busId of ownBusIds) closeStandalonePrivateBusIfUnused(store, (id) => orchestra.closeBus(id), busId);
}

export function closeBusRecord(store: AgentStore, busId: string): Bus | undefined {
  const closedBus = store.updateBus(busId, (current) => ({ ...current, state: "closed" }));
  if (!closedBus) return undefined;
  for (const subscription of store.listBusSubscriptions({
    busId,
    subscriberId: undefined,
    subscriberKind: undefined,
  })) {
    store.deleteBusSubscription(subscription.id);
  }
  return closedBus;
}

function hasMessageableParticipantsOnBus(store: AgentStore, busId: string): boolean {
  const runs = store.listRuns();
  const bus = store.getBus(busId);
  if (runs.some((run) => run.busId === busId && run.state !== "closed")) return true;
  if (!bus) return false;

  for (const subscription of store.listBusSubscriptions({
    busId,
    subscriberId: undefined,
    subscriberKind: undefined,
  })) {
    if (subscription.subscriberKind === "main") continue;
    const hasUnreadMessage = bus.messages.some((message) => {
      if (message.from === subscription.subscriberId) return false;
      return !isBusMessageDelivered(subscription, message);
    });
    if (!hasUnreadMessage) continue;
    const subscriber = runs.find((run) => run.id === subscription.subscriberId);
    if (subscriber && subscriber.state !== "closed") return true;
  }

  return false;
}
