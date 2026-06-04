// Records are persisted as JSON payloads keyed by id rather than normalized columns:
// the store is accessed only by primary key (TypeScript owns the shape, querying/filtering
// happens in the application layer), so a document layout avoids joins and lets the domain
// types evolve without schema migrations.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AgentRun } from "../core/subagent.ts";
import type { Bus, BusMessage } from "../core/bus.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import { notifySubscribers, subscribeStore, type StoreSubscription } from "./store-subscriptions.ts";

const SCHEMA_VERSION = 1;
const ORCHESTRA_STORE_RELATIVE_DIR = join(".pi", "orchestra");
const ORCHESTRA_STORE_FILENAME = "store.db";

export interface SqliteAgentStoreOptions {
  databasePath: string;
}

interface PayloadRow {
  payload_json: string;
}

export class SqliteAgentStore implements AgentStore {
  private readonly db: DatabaseSync;
  private readonly statements: StoreStatements;
  private readonly runSubscriptions = new Set<StoreSubscription<AgentRun>>();
  private readonly workflowSubscriptions = new Set<StoreSubscription<WorkflowRun>>();
  private closed = false;

  constructor(options: SqliteAgentStoreOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath, { timeout: 5_000 });
    initializeSchema(this.db);
    this.statements = prepareStatements(this.db);
  }

  saveRun(run: AgentRun): void {
    this.statements.saveRun.run(run.id, stringifyPayload(run, `run ${run.id}`));
    notifySubscribers(this.runSubscriptions, run);
  }

  getRun(id: string): AgentRun | undefined {
    return getPayload(this.statements.getRun, id, `run ${id}`);
  }

  listRuns(): AgentRun[] {
    return listPayloads(this.statements.listRuns, "runs");
  }

  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void {
    return subscribeStore(this.runSubscriptions, listener, filter);
  }

  saveBus(bus: Bus): void {
    this.statements.saveBus.run(bus.id, stringifyPayload(bus, `bus ${bus.id}`));
  }

  getBus(id: string): Bus | undefined {
    return getPayload(this.statements.getBus, id, `bus ${id}`);
  }

  listBuses(): Bus[] {
    return listPayloads(this.statements.listBuses, "buses");
  }

  addBusMessage(busId: string, message: BusMessage): void {
    const bus = this.getBus(busId);
    if (!bus) throw new Error(`Bus ${busId} not found.`);

    const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
    const messages = [...bus.messages];
    if (existingIndex >= 0) {
      messages[existingIndex] = message;
    } else {
      messages.push(message);
    }

    this.saveBus({ ...bus, messages });
  }

  saveWorkflow(workflow: WorkflowRun): void {
    this.statements.saveWorkflow.run(workflow.id, stringifyPayload(workflow, `workflow ${workflow.id}`));
    notifySubscribers(this.workflowSubscriptions, workflow);
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    return getPayload(this.statements.getWorkflow, id, `workflow ${id}`);
  }

  listWorkflows(): WorkflowRun[] {
    return listPayloads(this.statements.listWorkflows, "workflows");
  }

  subscribeWorkflows(
    listener: (workflow: WorkflowRun) => void,
    filter: ((workflow: WorkflowRun) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.workflowSubscriptions, listener, filter);
  }

  dispose(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

interface StoreStatements {
  saveRun: StatementSync;
  getRun: StatementSync;
  listRuns: StatementSync;
  saveBus: StatementSync;
  getBus: StatementSync;
  listBuses: StatementSync;
  saveWorkflow: StatementSync;
  getWorkflow: StatementSync;
  listWorkflows: StatementSync;
}

export function getProjectSqliteStorePath(cwd: string): string {
  return join(cwd, ORCHESTRA_STORE_RELATIVE_DIR, ORCHESTRA_STORE_FILENAME);
}

export function createProjectSqliteAgentStore(cwd: string): SqliteAgentStore {
  return new SqliteAgentStore({ databasePath: getProjectSqliteStorePath(cwd) });
}

function initializeSchema(db: DatabaseSync): void {
  const schemaVersion = getSchemaVersion(db);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported pi-orchestra SQLite store schema version ${schemaVersion}.`);
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS buses (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    ) STRICT;
  `);

  if (schemaVersion < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function prepareStatements(db: DatabaseSync): StoreStatements {
  return {
    saveRun: db.prepare(`
      INSERT INTO runs (id, payload_json)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `),
    getRun: db.prepare("SELECT payload_json FROM runs WHERE id = ?"),
    listRuns: db.prepare("SELECT payload_json FROM runs ORDER BY rowid"),
    saveBus: db.prepare(`
      INSERT INTO buses (id, payload_json)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `),
    getBus: db.prepare("SELECT payload_json FROM buses WHERE id = ?"),
    listBuses: db.prepare("SELECT payload_json FROM buses ORDER BY rowid"),
    saveWorkflow: db.prepare(`
      INSERT INTO workflows (id, payload_json)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `),
    getWorkflow: db.prepare("SELECT payload_json FROM workflows WHERE id = ?"),
    listWorkflows: db.prepare("SELECT payload_json FROM workflows ORDER BY rowid"),
  };
}

function getPayload<T>(statement: StatementSync, id: string, label: string): T | undefined {
  const row = statement.get(id) as PayloadRow | undefined;
  if (!row) return undefined;
  return parsePayload<T>(row.payload_json, label);
}

function listPayloads<T>(statement: StatementSync, label: string): T[] {
  return (statement.all() as unknown as PayloadRow[]).map((row, index) =>
    parsePayload<T>(row.payload_json, `${label}[${index}]`),
  );
}

function stringifyPayload(value: unknown, label: string): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("payload is undefined");
    return json;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not serialize ${label} for SQLite store: ${message}`);
  }
}

function parsePayload<T>(payload: string, label: string): T {
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${label} from SQLite store: ${message}`);
  }
}
