import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus } from "../core/bus.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { createProjectSqliteAgentStore, getProjectSqliteStorePath, SqliteAgentStore } from "./sqlite-store.ts";

test("project SQLite store creates .pi/orchestra and persists saved orchestration state", () => {
  withTempStore((store, cwd) => {
    const dbPath = getProjectSqliteStorePath(cwd);
    assert.equal(existsSync(join(cwd, ".pi", "orchestra")), true);
    assert.equal(existsSync(dbPath), true);

    const bus: Bus = { id: "bus-1", name: "Bus 1", messages: [] };
    const busMessage = { id: "message-1", from: "main", message: "Persist this." };
    const savedRun = run({
      id: "agent-1",
      result: { status: "success", summary: "Done.", data: { files: ["src/index.ts"] } },
    });
    const savedWorkflow = workflowRun({ id: "workflow-1", name: "Workflow 1" });

    store.saveBus(bus);
    store.addBusMessage(bus.id, busMessage);
    store.saveRun(savedRun);
    store.saveWorkflow(savedWorkflow);
    store.dispose();

    const reopened = createProjectSqliteAgentStore(cwd);
    try {
      assert.deepEqual(reopened.getBus(bus.id), { ...bus, messages: [busMessage] });
      assert.deepEqual(reopened.getRun(savedRun.id), savedRun);
      assert.deepEqual(reopened.getWorkflow(savedWorkflow.id), savedWorkflow);
      assert.deepEqual(reopened.listBuses(), [{ ...bus, messages: [busMessage] }]);
      assert.deepEqual(reopened.listRuns(), [savedRun]);
      assert.deepEqual(reopened.listWorkflows(), [savedWorkflow]);
    } finally {
      reopened.dispose();
    }
  });
});

test("SQLite store preserves insertion order when updating existing records", () => {
  withTempStore((store) => {
    const first = run({ id: "agent-1", state: "idle" });
    const second = run({ id: "agent-2", state: "idle" });

    store.saveRun(first);
    store.saveRun(second);
    store.saveRun({ ...first, state: "success" });

    assert.deepEqual(
      store.listRuns().map((current) => current.id),
      ["agent-1", "agent-2"],
    );
  });
});

test("SQLite store appends and replaces bus messages by id", () => {
  withTempStore((store) => {
    const bus: Bus = { id: "bus-1", name: "Bus 1", messages: [] };
    store.saveBus(bus);

    store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Initial." });
    store.addBusMessage(bus.id, { id: "message-2", from: "agent", message: "Follow-up." });
    store.addBusMessage(bus.id, { id: "message-1", from: "main", message: "Updated." });

    assert.deepEqual(store.getBus(bus.id)?.messages, [
      { id: "message-1", from: "main", message: "Updated." },
      { id: "message-2", from: "agent", message: "Follow-up." },
    ]);
  });
});

test("SQLite store notifies matching subscribers until unsubscribed", () => {
  withTempStore((store) => {
    const observedRuns: AgentRun[] = [];
    const observedWorkflows: WorkflowRun[] = [];
    const unsubscribeRuns = store.subscribeRuns(
      (updatedRun) => observedRuns.push(updatedRun),
      (updatedRun) => updatedRun.id === "agent-1",
    );
    const unsubscribeWorkflows = store.subscribeWorkflows(
      (updatedWorkflow) => observedWorkflows.push(updatedWorkflow),
      (updatedWorkflow) => updatedWorkflow.id === "workflow-1",
    );

    const savedRun = run({ id: "agent-1" });
    const ignoredRun = run({ id: "agent-2" });
    const savedWorkflow = workflowRun({ id: "workflow-1" });
    const ignoredWorkflow = workflowRun({ id: "workflow-2" });
    store.saveRun(savedRun);
    store.saveRun(ignoredRun);
    store.saveWorkflow(savedWorkflow);
    store.saveWorkflow(ignoredWorkflow);

    unsubscribeRuns();
    unsubscribeWorkflows();
    store.saveRun({ ...savedRun, state: "success" });
    store.saveWorkflow({ ...savedWorkflow, state: "success" });

    assert.deepEqual(observedRuns, [savedRun]);
    assert.deepEqual(observedWorkflows, [savedWorkflow]);
  });
});

test("SQLite store rejects bus messages for missing buses", () => {
  withTempStore((store) => {
    assert.throws(
      () => store.addBusMessage("missing", { id: "message-1", from: "main", message: "No bus." }),
      /Bus missing not found\./,
    );
  });
});

test("SQLite store rejects a database written by a newer schema version", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-store-"));
  try {
    createProjectSqliteAgentStore(cwd).dispose();

    const db = new DatabaseSync(getProjectSqliteStorePath(cwd));
    db.exec("PRAGMA user_version = 999");
    db.close();

    assert.throws(
      () => createProjectSqliteAgentStore(cwd),
      /Unsupported pi-orchestra SQLite store schema version 999\./,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("SQLite store dispose is idempotent", () => {
  withTempStore((store) => {
    store.dispose();
    assert.doesNotThrow(() => store.dispose());
  });
});

function withTempStore(testFn: (store: SqliteAgentStore, cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-store-"));
  const store = createProjectSqliteAgentStore(cwd);
  try {
    testFn(store, cwd);
  } finally {
    store.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "agent-1";
  return {
    id,
    name: overrides.name ?? id,
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow-1",
    name: "workflow-1",
    goal: "Complete the workflow.",
    startedAtMs: 1_700_000_000_000,
    state: "idle",
    currentStageIndex: 0,
    stages: [],
    ...overrides,
  };
}
