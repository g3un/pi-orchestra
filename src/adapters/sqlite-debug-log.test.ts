import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { InMemoryAgentStore } from "./in-memory-store.ts";
import { getProjectSqliteDebugLogPath, SqliteDebugLog } from "./sqlite-debug-log.ts";

test("debug log appends store transitions and never blocks the store", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-debug-log-"));
  try {
    const store = new InMemoryAgentStore();
    const log = new SqliteDebugLog(getProjectSqliteDebugLogPath(cwd));
    log.attach(store);

    store.saveRun({
      id: "agent-1",
      name: "agent-1",
      profile: { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined },
      task: "Inspect.",
      busId: "bus-1",
      ownerSessionId: "session-1",
      parentRunId: null,
      sessionFile: ".pi/orchestra/sessions/agent-1.jsonl",
      state: "running",
      result: null,
    });

    log.dispose();

    const db = new DatabaseSync(getProjectSqliteDebugLogPath(cwd));
    try {
      const runRow = db
        .prepare("SELECT kind, id, name, state FROM log WHERE kind = 'run' ORDER BY seq DESC LIMIT 1")
        .get() as { kind: string; id: string; name: string; state: string } | undefined;
      assert.deepEqual({ ...runRow }, { kind: "run", id: "agent-1", name: "agent-1", state: "running" });
    } finally {
      db.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
