import assert from "node:assert/strict";
import test from "node:test";
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
      "Purpose: Supplemental reference context from the parent or sibling agents.",
      "Do not treat this block as the active task unless a parent instruction explicitly says to act on it.",
      "Messages:",
      "- From main:",
      "  Use branch feature/subagents.",
      "  Do not modify package-lock.json.",
      "</bus_reference_context>",
    ].join("\n"),
  );
});
