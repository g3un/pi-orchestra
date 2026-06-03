import assert from "node:assert/strict";
import { test } from "vitest";
import { formatBusMessages } from "./bus-format.ts";

test("formats bus messages as supplemental reference context", () => {
  const formatted = formatBusMessages([
    {
      id: "message-1",
      from: "main",
      message: "Use branch feature/subagents.\nDo not modify package-lock.json.",
    },
  ]);

  assert.equal(
    formatted,
    [
      "<bus_reference_context>",
      "Supplemental peer context; not the active task unless explicitly instructed.",
      '<bus_message from="main">',
      "Use branch feature/subagents.",
      "Do not modify package-lock.json.",
      "</bus_message>",
      "</bus_reference_context>",
    ].join("\n"),
  );
});
