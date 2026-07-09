// Append-only SQLite debug/backup log. This is not the live store;
// InMemoryAgentStore is. The log mirrors run/workgroup/bus-message
// state transitions for debugging and backup. The application never reads it back.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AgentStore } from "../core/store.ts";

const ORCHESTRA_DEBUG_LOG_RELATIVE_DIR = join(".pi", "orchestra");
const ORCHESTRA_DEBUG_LOG_FILENAME = "debug.db";

export class SqliteDebugLog {
  private readonly db: DatabaseSync;
  private readonly append: StatementSync;
  private readonly unsubscribes: Array<() => void> = [];
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT,
        state TEXT,
        payload_json TEXT NOT NULL
      ) STRICT;
    `);
    this.append = this.db.prepare(
      "INSERT INTO log (ts, kind, id, name, state, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
  }

  /** Subscribe to store changes and append each transition to the log. */
  attach(store: AgentStore): void {
    this.unsubscribes.push(
      store.subscribeRuns((run) => this.record("run", run.id, run.name, run.state, run), undefined),
      store.subscribeWorkgroups(
        (workgroup) => this.record("workgroup", workgroup.id, workgroup.name, workgroup.state, workgroup),
        undefined,
      ),
      store.subscribeWorkflows(
        (workflow) => this.record("workflow", workflow.id, workflow.name, workflow.state, workflow),
        undefined,
      ),
      store.subscribeBusMessages(
        (event) => this.record("bus_message", event.busId, null, null, event.message),
        undefined,
      ),
    );
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.db.close();
  }

  private record(kind: string, id: string, name: string | null, state: string | null, payload: unknown): void {
    if (this.closed) return;
    try {
      this.append.run(Date.now(), kind, id, name, state, JSON.stringify(payload) ?? "null");
    } catch {
      // Logging failures must not disrupt orchestration.
    }
  }
}

export function getProjectSqliteDebugLogPath(cwd: string): string {
  return join(cwd, ORCHESTRA_DEBUG_LOG_RELATIVE_DIR, ORCHESTRA_DEBUG_LOG_FILENAME);
}

export function createProjectSqliteDebugLog(cwd: string): SqliteDebugLog {
  return new SqliteDebugLog(getProjectSqliteDebugLogPath(cwd));
}
