// Records are persisted as JSON payloads keyed by id rather than normalized columns:
// the store is accessed only by primary key (querying/filtering happens in the
// application layer), so a document layout avoids joins. The store layout is still
// versioned; incompatible local stores are rejected with a recreate-store message.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AgentRun } from "../core/subagent.ts";
import {
  matchesBusSubscription,
  type Bus,
  type BusMessage,
  type BusMessageEvent,
  type BusSubscription,
  type ListBusSubscriptionsOptions,
} from "../core/bus.ts";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { notifySubscribers, subscribeStore, type StoreSubscription } from "./store-subscriptions.ts";

const SCHEMA_VERSION = 7;
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
  private readonly busMessageSubscriptions = new Set<StoreSubscription<BusMessageEvent>>();
  private readonly workgroupSubscriptions = new Set<StoreSubscription<WorkgroupRun>>();
  private readonly workflowSubscriptions = new Set<StoreSubscription<WorkflowRun>>();
  private closed = false;

  constructor(options: SqliteAgentStoreOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath, { timeout: 5_000 });
    try {
      initializeSchema(this.db, options.databasePath);
      this.statements = prepareStatements(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  saveRun(run: AgentRun): void {
    saveNamedPayload(this.statements.saveRun, run.id, run.name, stringifyPayload(run, `run ${run.id}`), "Agent");
    notifySubscribers(this.runSubscriptions, run);
  }

  getRun(id: string): AgentRun | undefined {
    return getPayload(this.statements.getRun, id, `run ${id}`);
  }

  getRunByName(name: string): AgentRun | undefined {
    return getPayload(this.statements.getRunByName, name, `run ${name}`);
  }

  listRuns(): AgentRun[] {
    return listPayloads(this.statements.listRuns, "runs");
  }

  subscribeRuns(listener: (run: AgentRun) => void, filter: ((run: AgentRun) => boolean) | undefined): () => void {
    return subscribeStore(this.runSubscriptions, listener, filter);
  }

  saveBus(bus: Bus): void {
    saveNamedPayload(this.statements.saveBus, bus.id, bus.name, stringifyPayload(bus, `bus ${bus.id}`), "Bus");
  }

  getBus(id: string): Bus | undefined {
    return getPayload(this.statements.getBus, id, `bus ${id}`);
  }

  getBusByName(name: string): Bus | undefined {
    return getPayload(this.statements.getBusByName, name, `bus ${name}`);
  }

  listBuses(): Bus[] {
    return listPayloads(this.statements.listBuses, "buses");
  }

  addBusMessage(busId: string, message: BusMessage): void {
    let event: BusMessageEvent | undefined;
    this.withImmediateTransaction(() => {
      const bus = this.getBus(busId);
      if (!bus) throw new Error(`Bus ${busId} not found.`);

      const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
      const messages = [...bus.messages];
      if (existingIndex >= 0) {
        messages[existingIndex] = message;
        this.saveBus({ ...bus, messages });
        return;
      }

      messages.push(message);
      this.saveBus({ ...bus, messages });
      event = { busId, message };
    });
    if (event) notifySubscribers(this.busMessageSubscriptions, event);
  }

  subscribeBusMessages(
    listener: (event: BusMessageEvent) => void,
    filter: ((event: BusMessageEvent) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.busMessageSubscriptions, listener, filter);
  }

  saveBusSubscription(subscription: BusSubscription): void {
    this.statements.saveBusSubscription.run(
      subscription.id,
      stringifyPayload(subscription, `bus subscription ${subscription.id}`),
    );
  }

  getBusSubscription(id: string): BusSubscription | undefined {
    return getPayload(this.statements.getBusSubscription, id, `bus subscription ${id}`);
  }

  listBusSubscriptions(options: ListBusSubscriptionsOptions): BusSubscription[] {
    return listPayloads<BusSubscription>(this.statements.listBusSubscriptions, "bus subscriptions").filter(
      (subscription) => matchesBusSubscription(subscription, options),
    );
  }

  deleteBusSubscription(id: string): void {
    this.statements.deleteBusSubscription.run(id);
  }

  saveWorkgroup(workgroup: WorkgroupRun): void {
    saveNamedPayload(
      this.statements.saveWorkgroup,
      workgroup.id,
      workgroup.name,
      stringifyPayload(workgroup, `workgroup ${workgroup.id}`),
      "Workgroup",
    );
    notifySubscribers(this.workgroupSubscriptions, workgroup);
  }

  getWorkgroup(id: string): WorkgroupRun | undefined {
    return getPayload(this.statements.getWorkgroup, id, `workgroup ${id}`);
  }

  getWorkgroupByName(name: string): WorkgroupRun | undefined {
    return getPayload(this.statements.getWorkgroupByName, name, `workgroup ${name}`);
  }

  listWorkgroups(): WorkgroupRun[] {
    return listPayloads(this.statements.listWorkgroups, "workgroups");
  }

  subscribeWorkgroups(
    listener: (workgroup: WorkgroupRun) => void,
    filter: ((workgroup: WorkgroupRun) => boolean) | undefined,
  ): () => void {
    return subscribeStore(this.workgroupSubscriptions, listener, filter);
  }

  saveWorkflow(workflow: WorkflowRun): void {
    saveNamedPayload(
      this.statements.saveWorkflow,
      workflow.id,
      workflow.name,
      stringifyPayload(workflow, `workflow ${workflow.id}`),
      "Workflow",
    );
    notifySubscribers(this.workflowSubscriptions, workflow);
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    return getPayload(this.statements.getWorkflow, id, `workflow ${id}`);
  }

  getWorkflowByName(name: string): WorkflowRun | undefined {
    return getPayload(this.statements.getWorkflowByName, name, `workflow ${name}`);
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

  private withImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }
}

interface StoreStatements {
  saveRun: StatementSync;
  getRun: StatementSync;
  getRunByName: StatementSync;
  listRuns: StatementSync;
  saveBus: StatementSync;
  getBus: StatementSync;
  getBusByName: StatementSync;
  listBuses: StatementSync;
  saveBusSubscription: StatementSync;
  getBusSubscription: StatementSync;
  listBusSubscriptions: StatementSync;
  deleteBusSubscription: StatementSync;
  saveWorkgroup: StatementSync;
  getWorkgroup: StatementSync;
  getWorkgroupByName: StatementSync;
  listWorkgroups: StatementSync;
  saveWorkflow: StatementSync;
  getWorkflow: StatementSync;
  getWorkflowByName: StatementSync;
  listWorkflows: StatementSync;
}

export function getProjectSqliteStorePath(cwd: string): string {
  return join(cwd, ORCHESTRA_STORE_RELATIVE_DIR, ORCHESTRA_STORE_FILENAME);
}

export function createProjectSqliteAgentStore(cwd: string): SqliteAgentStore {
  return new SqliteAgentStore({ databasePath: getProjectSqliteStorePath(cwd) });
}

function initializeSchema(db: DatabaseSync, databasePath: string): void {
  const schemaVersion = getSchemaVersion(db);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported pi-orchestra SQLite store schema version ${schemaVersion}.`);
  }
  if (schemaVersion > 0 && schemaVersion < SCHEMA_VERSION) {
    throw new Error(formatIncompatibleSchemaMessage(schemaVersion, databasePath));
  }
  if (schemaVersion === 0 && hasExistingStoreTables(db)) {
    throw new Error(formatIncompatibleSchemaMessage(schemaVersion, databasePath));
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS buses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS bus_subscriptions (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workgroups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS runs_name_idx ON runs(name);
    CREATE INDEX IF NOT EXISTS buses_name_idx ON buses(name);
    CREATE INDEX IF NOT EXISTS workgroups_name_idx ON workgroups(name);
    CREATE INDEX IF NOT EXISTS workflows_name_idx ON workflows(name);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_active_name_unique_idx
      ON runs(name)
      WHERE json_extract(payload_json, '$.state') = 'running';
    CREATE UNIQUE INDEX IF NOT EXISTS buses_active_name_unique_idx
      ON buses(name)
      WHERE json_extract(payload_json, '$.state') = 'open';
    CREATE UNIQUE INDEX IF NOT EXISTS workgroups_active_name_unique_idx
      ON workgroups(name)
      WHERE json_extract(payload_json, '$.state') != 'closed';
    CREATE UNIQUE INDEX IF NOT EXISTS workflows_active_name_unique_idx
      ON workflows(name)
      WHERE json_extract(payload_json, '$.state') != 'closed';
  `);

  if (schemaVersion < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function hasExistingStoreTables(db: DatabaseSync): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'buses', 'bus_subscriptions', 'workflows', 'workgroups')`,
    )
    .all() as unknown as Array<{ name: string }>;
  return rows.length > 0;
}

function formatIncompatibleSchemaMessage(schemaVersion: number, databasePath: string): string {
  return [
    `Unsupported pi-orchestra SQLite store schema version ${schemaVersion}; expected ${SCHEMA_VERSION}.`,
    "The local orchestration store layout changed and pi-orchestra will not migrate it automatically.",
    `Delete ${databasePath} and run the command again to create a fresh store.`,
  ].join(" ");
}

function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function prepareStatements(db: DatabaseSync): StoreStatements {
  return {
    saveRun: db.prepare(`
      INSERT INTO runs (id, name, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json
    `),
    getRun: db.prepare("SELECT payload_json FROM runs WHERE id = ?"),
    getRunByName: db.prepare(`
      SELECT payload_json FROM runs
      WHERE name = ?
      ORDER BY CASE WHEN json_extract(payload_json, '$.state') = 'running' THEN 0 ELSE 1 END, rowid DESC
      LIMIT 1
    `),
    listRuns: db.prepare("SELECT payload_json FROM runs ORDER BY rowid"),
    saveBus: db.prepare(`
      INSERT INTO buses (id, name, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json
    `),
    getBus: db.prepare("SELECT payload_json FROM buses WHERE id = ?"),
    getBusByName: db.prepare(`
      SELECT payload_json FROM buses
      WHERE name = ?
      ORDER BY CASE WHEN json_extract(payload_json, '$.state') = 'open' THEN 0 ELSE 1 END, rowid DESC
      LIMIT 1
    `),
    listBuses: db.prepare("SELECT payload_json FROM buses ORDER BY rowid"),
    saveBusSubscription: db.prepare(`
      INSERT INTO bus_subscriptions (id, payload_json)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `),
    getBusSubscription: db.prepare("SELECT payload_json FROM bus_subscriptions WHERE id = ?"),
    listBusSubscriptions: db.prepare("SELECT payload_json FROM bus_subscriptions ORDER BY rowid"),
    deleteBusSubscription: db.prepare("DELETE FROM bus_subscriptions WHERE id = ?"),
    saveWorkgroup: db.prepare(`
      INSERT INTO workgroups (id, name, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json
    `),
    getWorkgroup: db.prepare("SELECT payload_json FROM workgroups WHERE id = ?"),
    getWorkgroupByName: db.prepare(`
      SELECT payload_json FROM workgroups
      WHERE name = ?
      ORDER BY CASE WHEN json_extract(payload_json, '$.state') != 'closed' THEN 0 ELSE 1 END, rowid DESC
      LIMIT 1
    `),
    listWorkgroups: db.prepare("SELECT payload_json FROM workgroups ORDER BY rowid"),
    saveWorkflow: db.prepare(`
      INSERT INTO workflows (id, name, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json
    `),
    getWorkflow: db.prepare("SELECT payload_json FROM workflows WHERE id = ?"),
    getWorkflowByName: db.prepare(`
      SELECT payload_json FROM workflows
      WHERE name = ?
      ORDER BY CASE WHEN json_extract(payload_json, '$.state') != 'closed' THEN 0 ELSE 1 END, rowid DESC
      LIMIT 1
    `),
    listWorkflows: db.prepare("SELECT payload_json FROM workflows ORDER BY rowid"),
  };
}

function saveNamedPayload(
  statement: StatementSync,
  id: string,
  name: string,
  payload: string,
  entityLabel: string,
): void {
  try {
    statement.run(id, name, payload);
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) {
      throw new Error(`${entityLabel} name "${name}" is already in use.`);
    }
    throw error;
  }
}

function isSqliteUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
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
