import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BufferJSON } from 'baileys';
import { DB_PATH, SCHEMA_PATH, DATA_DIR, PARSER_VERSION } from '../config.ts';

/**
 * Encode a value for a *_json column. MUST be paired with decodeJson: plain
 * JSON.stringify renders Buffers as {"type":"Buffer","data":[...]} which will
 * not revive back into Buffers, and Baileys' media decryption then fails in a
 * confusing way.
 */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

export function decodeJson<T = unknown>(text: string): T {
  return JSON.parse(text, BufferJSON.reviver) as T;
}

/**
 * PRAGMA foreign_keys is per-connection, not persisted in the file, so it has
 * to be re-applied on every open.
 */
function applyConnectionPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

/** Open (creating if needed) the read-write archive and ensure the schema exists. */
export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  applyConnectionPragmas(db);
  bootstrapSchema(db);
  return db;
}

/** In-memory database with the full schema. Used by tests. */
export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyConnectionPragmas(db);
  bootstrapSchema(db);
  return db;
}

/**
 * The agent-facing connection. Writes are blocked by the driver itself, which
 * is the guarantee that actually holds -- the agent_* views are a convenience
 * shape, not a confidentiality boundary. See docs/agent-schema.md.
 */
export function openReadOnlyDb(dbPath: string = DB_PATH): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function bootstrapSchema(db: DatabaseSync): void {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const setMeta = db.prepare(
    'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  setMeta.run('schema_version', '1');
  setMeta.run('parser_version', String(PARSER_VERSION));
}

export function ensureDataDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Returns the single account row id, creating it on first run. */
export function ensureAccount(db: DatabaseSync, nowMs: number): number {
  const existing = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const inserted = db
    .prepare('INSERT INTO accounts(created_at_ms) VALUES (?) RETURNING id')
    .get(nowMs) as { id: number };
  return inserted.id;
}
