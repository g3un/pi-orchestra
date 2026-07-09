import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createBusSubscription,
  isBusMessageDelivered,
  markBusMessagesDelivered,
  maxMessageSeq,
  type BusMessage,
  type BusSubscription,
} from "./bus.ts";

test("bus delivery watermark keeps out-of-order deliveries as exceptions", () => {
  const subscription = busSubscription();
  const busMessages = [busMessage("message-1"), busMessage("message-2"), busMessage("message-3")];

  const afterOutOfOrder = markBusMessagesDelivered(subscription, busMessages[1]!);

  assert.equal(afterOutOfOrder.lastDeliveredSeq, 0);
  assert.deepEqual(afterOutOfOrder.deliveredSeqs, [2]);
  assert.equal(isBusMessageDelivered(afterOutOfOrder, busMessages[0]!), false);
  assert.equal(isBusMessageDelivered(afterOutOfOrder, busMessages[1]!), true);
  assert.equal(isBusMessageDelivered(afterOutOfOrder, busMessages[2]!), false);
});

test("bus delivery watermark advances across contiguous delivered and own messages", () => {
  const subscription = busSubscription({ subscriberId: "agent-1" });
  const busMessages = [
    busMessage("message-1", "main"),
    busMessage("message-2", "agent-1"),
    busMessage("message-3", "main"),
  ];

  const delivered = markBusMessagesDelivered(subscription, busMessages[0]!);

  assert.equal(delivered.lastDeliveredSeq, 1);
  assert.deepEqual(delivered.deliveredSeqs, []);
  assert.equal(isBusMessageDelivered(delivered, busMessages[0]!), true);
  assert.equal(isBusMessageDelivered(delivered, busMessages[1]!), false);
  assert.equal(isBusMessageDelivered(delivered, busMessages[2]!), false);
});

test("bus delivery watermark compresses exceptions once gaps are filled", () => {
  const busMessages = [busMessage("message-1"), busMessage("message-2"), busMessage("message-3")];
  const outOfOrder = markBusMessagesDelivered(busSubscription(), [busMessages[1]!, busMessages[2]!]);

  const compressed = markBusMessagesDelivered(outOfOrder, busMessages[0]!);

  assert.equal(compressed.lastDeliveredSeq, 3);
  assert.deepEqual(compressed.deliveredSeqs, []);
});

test("bus delivery treats replaced messages with the same id as the same delivery", () => {
  const originalBusMessages = [busMessage("message-1")];
  const delivered = markBusMessagesDelivered(busSubscription(), originalBusMessages[0]!);
  const replacedMessage = { ...busMessage("message-1"), message: "Replacement body." };

  const afterReplacement = markBusMessagesDelivered(delivered, replacedMessage);

  assert.equal(afterReplacement.lastDeliveredSeq, 1);
  assert.deepEqual(afterReplacement.deliveredSeqs, []);
  assert.equal(isBusMessageDelivered(afterReplacement, replacedMessage), true);
});

test("bus delivery ignores exception ids at or below the watermark", () => {
  const subscription = busSubscription({
    lastDeliveredSeq: 2,
    deliveredSeqs: [1, 3],
  });
  const busMessages = [busMessage("message-1"), busMessage("message-2"), busMessage("message-3")];

  const normalized = markBusMessagesDelivered(subscription, busMessages[2]!);

  assert.equal(normalized.lastDeliveredSeq, 3);
  assert.deepEqual(normalized.deliveredSeqs, []);
});

test("bus delivery watermark follows stored message order past message-10", () => {
  const busMessages = [busMessage("message-9"), busMessage("message-10"), busMessage("message-11")];
  const subscription = busSubscription({ lastDeliveredSeq: 10 });

  assert.equal(isBusMessageDelivered(subscription, busMessages[0]!), true);
  assert.equal(isBusMessageDelivered(subscription, busMessages[1]!), true);
  assert.equal(isBusMessageDelivered(subscription, busMessages[2]!), false);
});

test("maxMessageSeq handles practical large message arrays without spreading", () => {
  const messages = Array.from({ length: 200_000 }, (_, index) => busMessage(`message-${index + 1}`));

  assert.equal(maxMessageSeq(messages), 200_000);
});

function busSubscription(overrides: Partial<BusSubscription> = {}): BusSubscription {
  return createBusSubscription({
    busId: "bus-1",
    subscriberId: "agent-1",
    subscriberKind: "agent",
    lastDeliveredSeq: 0,
    deliveredSeqs: [],
    ...overrides,
  });
}

function busMessage(id: string, from = "main"): BusMessage {
  const match = /-(\d+)$/.exec(id);
  return { id, seq: match ? Number(match[1]) : 1, from, message: `${id} body` };
}
