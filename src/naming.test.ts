import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createBusNameFromOwnerName, createPrefixedName, getBusOwnerRawNameBudget } from "./naming.ts";
import { hasNameConflict } from "./utils.ts";

describe("orchestra naming", () => {
  test("adds prefixes without collapsing reserved logical prefixes", () => {
    assert.equal(createPrefixedName("agent", "auth", "Subagent"), "agent-auth");
    assert.equal(createPrefixedName("agent", "agent-auth", "Subagent"), "agent-auth");
    assert.equal(createBusNameFromOwnerName("agent-auth"), "bus-agent-auth");
    assert.equal(createBusNameFromOwnerName("agent-bus-auth"), "bus-agent-bus-auth");
  });

  test("derives distinct bus names for agent and group owners", () => {
    assert.equal(createBusNameFromOwnerName("agent-research"), "bus-agent-research");
    assert.equal(createBusNameFromOwnerName("group-research"), "bus-group-research");
    assert.equal(
      createBusNameFromOwnerName(createPrefixedName("agent", "agent-research", "Subagent")),
      "bus-agent-research",
    );
  });

  test("reports logical name length limits before adding prefixes", () => {
    assert.throws(
      () => createPrefixedName("agent", "x".repeat(60), "Subagent"),
      /Subagent name must be 58 characters or fewer before the agent- prefix is added\./,
    );
  });

  test("name conflicts are direction-independent across repeated and first-segment prefixes", () => {
    for (const existing of ["agent-review", "agent-agent-review", "bus-review", "group-review"]) {
      assert.equal(hasNameConflict("review", [existing]), true, existing);
      assert.equal(hasNameConflict(existing, ["review"]), true, existing);
    }
  });

  test("standalone bus owner raw budget is derived from prefix lengths", () => {
    const budget = getBusOwnerRawNameBudget("agent");

    assert.equal(budget, 54);
    assert.doesNotThrow(() => createBusNameFromOwnerName(createPrefixedName("agent", "x".repeat(budget), "Bus")));
    assert.throws(() => createBusNameFromOwnerName(createPrefixedName("agent", "x".repeat(budget + 1), "Bus")));
  });
});
