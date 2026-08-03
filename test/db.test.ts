import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openMemoryDb, openReadOnlyDb, encodeJson, decodeJson } from '../src/db/db.ts';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wad-test-')), 'archive.sqlite');
}

test('schema creates every expected table, view and index', () => {
  const db = openMemoryDb();
  const names = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
      name: string;
    }[]).map((r) => r.name),
  );

  for (const expected of [
    'schema_meta', 'accounts', 'identities', 'identity_addresses', 'identity_merges',
    'chats', 'messages', 'message_versions', 'message_mentions', 'message_events',
    'sync_runs', 'ingest_failures', 'messages_fts', 'media', 'ai_artifacts',
    'agent_messages', 'agent_chats', 'agent_identities', 'agent_message_mentions',
  ]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }

  const indexes = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[]).map((r) => r.name),
  );
  for (const expected of [
    'idx_messages_chat_time', 'idx_messages_sender_time', 'idx_messages_quoted_db_id',
    'idx_messages_type', 'idx_messages_wa_id', 'idx_messages_pending_quote',
  ]) {
    assert.ok(indexes.has(expected), `missing index ${expected}`);
  }
  db.close();
});

test('integrity checks pass on a fresh database', () => {
  const db = openMemoryDb();
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')").run();
  db.close();
});

test('schema_meta records versions', () => {
  const db = openMemoryDb();
  const rows = db.prepare('SELECT key, value FROM schema_meta').all() as { key: string; value: string }[];
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  assert.equal(meta.schema_version, '1');
  assert.ok(meta.parser_version);
  db.close();
});

test('bootstrapping twice is idempotent', () => {
  const dbPath = tempDbPath();
  openDb(dbPath).close();
  const db = openDb(dbPath); // re-runs the schema against an existing file
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.equal((db.prepare('SELECT count(*) c FROM schema_meta').get() as { c: number }).c, 2);
  db.close();
});

test('foreign keys are enforced on every connection', () => {
  const db = openMemoryDb();
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  db.close();
});

test('read-only connection can read but never write', () => {
  const dbPath = tempDbPath();
  const rw = openDb(dbPath);
  rw.prepare('INSERT INTO accounts(created_at_ms) VALUES (?)').run(1_700_000_000_000);
  rw.close();

  const ro = openReadOnlyDb(dbPath);
  assert.equal((ro.prepare('SELECT count(*) c FROM accounts').get() as { c: number }).c, 1);
  assert.deepEqual(ro.prepare('SELECT * FROM agent_messages').all(), []);

  for (const sql of [
    'INSERT INTO accounts(created_at_ms) VALUES (1)',
    'UPDATE accounts SET created_at_ms = 2',
    'DELETE FROM accounts',
    'CREATE TABLE evil(x)',
    'DROP TABLE accounts',
    "INSERT INTO messages_fts(rowid, text_body) VALUES (1, 'x')",
  ]) {
    assert.throws(() => ro.exec(sql), new RegExp('.'), `expected ${sql} to be rejected`);
  }
  ro.close();
});

test('json helpers round-trip Buffers, which plain JSON.stringify does not', () => {
  const original = { mediaKey: Buffer.from([1, 2, 3, 250]), nested: { sha: Buffer.from('abc') }, n: 7 };
  const revived = decodeJson<typeof original>(encodeJson(original));

  assert.ok(Buffer.isBuffer(revived.mediaKey), 'mediaKey should revive as a Buffer');
  assert.deepEqual([...revived.mediaKey], [1, 2, 3, 250]);
  assert.ok(Buffer.isBuffer(revived.nested.sha));
  assert.equal(revived.nested.sha.toString(), 'abc');
  assert.equal(revived.n, 7);

  // Guard against a regression to plain JSON.stringify.
  const naive = JSON.parse(JSON.stringify(original)) as { mediaKey: unknown };
  assert.ok(!Buffer.isBuffer(naive.mediaKey));
});
