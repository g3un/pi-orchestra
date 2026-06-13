import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createBusSubscription,
  isBusMessageDelivered,
  markBusMessagesDelivered,
  type BusMessage,
  type BusSubscription,
} from "./bus.ts";

test("bus delivery watermark keeps out-of-order deliveries as exceptions", () => {
  const subscription = busSubscription();
  const busMessages = [busMessage("message-1"), busMessage("message-2"), busMessage("message-3")];

  const afterOutOfOrder = markBusMessagesDelivered(subscription, busMessages[1]!, busMessages);

  assert.equal(afterOutOfOrder.lastDeliveredMessageId, null);
  assert.deepEqual(afterOutOfOrder.deliveredMessageIds, ["message-2"]);
  assert.equal(isBusMessageDelivered(afterOutOfOrder, "message-1"), false);
  assert.equal(isBusMessageDelivered(afterOutOfOrder, "message-2"), true);
  assert.equal(isBusMessageDelivered(afterOutOfOrder, "message-3"), false);
});

test("bus delivery watermark advances across contiguous delivered and own messages", () => {
  const subscription = busSubscription({ subscriberId: "agent-1" });
  const busMessages = [
    busMessage("message-1", "main"),
    busMessage("message-2", "agent-1"),
    busMessage("message-3", "main"),
  ];

  const delivered = markBusMessagesDelivered(subscription, busMessages[0]!, busMessages);

  assert.equal(delivered.lastDeliveredMessageId, "message-2");
  assert.deepEqual(delivered.deliveredMessageIds, []);
  assert.equal(isBusMessageDelivered(delivered, "message-1"), true);
  assert.equal(isBusMessageDelivered(delivered, "message-2"), true);
  assert.equal(isBusMessageDelivered(delivered, "message-3"), false);
});

test("bus delivery watermark compresses exceptions once gaps are filled", () => {
  const busMessages = [busMessage("message-1"), busMessage("message-2"), busMessage("message-3")];
  const outOfOrder = markBusMessagesDelivered(busSubscription(), [busMessages[1]!, busMessages[2]!], busMessages);

  const compressed = markBusMessagesDelivered(outOfOrder, busMessages[0]!, busMessages);

  assert.equal(compressed.lastDeliveredMessageId, "message-3");
  assert.deepEqual(compressed.deliveredMessageIds, []);
});

test("bus delivery ignores exception ids at or below the watermark", () => {
  const subscription = busSubscription({
    lastDeliveredMessageId: "message-2",
    deliveredMessageIds: ["message-1", "message-3"],
  });
  const busMessages = [busMessage("message-1"), busMessage("message-2"), busMessage("message-3")];

  const normalized = markBusMessagesDelivered(subscription, busMessages[2]!, busMessages);

  assert.equal(normalized.lastDeliveredMessageId, "message-3");
  assert.deepEqual(normalized.deliveredMessageIds, []);
});

function busSubscription(overrides: Partial<BusSubscription> = {}): BusSubscription {
  return createBusSubscription({
    busId: "bus-1",
    subscriberId: "agent-1",
    subscriberKind: "agent",
    lastDeliveredMessageId: null,
    deliveredMessageIds: [],
    ...overrides,
  });
}

function busMessage(id: string, from = "main"): BusMessage {
  return { id, from, message: `${id} body` };
}
