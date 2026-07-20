import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type { AgentRun } from "../core/subagent.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";
import { getProjectSqliteDebugLogPath, SqliteDebugLog } from "./sqlite-debug-log.ts";

const DEBUG_RUN: AgentRun = {
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
};

test("debug log appends store transitions and never blocks the store", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-debug-log-"));
  try {
    const store = new InMemoryAgentStore();
    const log = new SqliteDebugLog(getProjectSqliteDebugLogPath(cwd));
    log.attach(store);

    store.saveRun(DEBUG_RUN);

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

test("debug log retains only the latest 10,000 rows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-orchestra-debug-log-"));
  try {
    const databasePath = getProjectSqliteDebugLogPath(cwd);
    new SqliteDebugLog(databasePath).dispose();
    const seedDb = new DatabaseSync(databasePath);
    try {
      seedDb.exec(`
        WITH RECURSIVE rows(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM rows WHERE value < 10005
        )
        INSERT INTO log (ts, kind, id, name, state, payload_json)
        SELECT value, 'seed', 'seed-' || value, NULL, NULL, 'null' FROM rows;
      `);
    } finally {
      seedDb.close();
    }

    const store = new InMemoryAgentStore();
    const log = new SqliteDebugLog(databasePath);
    log.attach(store);
    store.saveRun(DEBUG_RUN);
    log.dispose();

    const db = new DatabaseSync(databasePath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS count, MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM log").get() as {
        count: number;
        minSeq: number;
        maxSeq: number;
      };
      assert.deepEqual({ ...row }, { count: 10_000, minSeq: 7, maxSeq: 10_006 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
