import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, ensureAccount } from '../src/db/db.ts';
import { ingestBatch, tombstoneMessage } from '../src/ingest/ingest.ts';
import type { BatchOpts } from '../src/ingest/ingest.ts';
import { searchMessages, getChatWindow, getMessageWithVersions, ftsQuote } from '../src/query/search.ts';
import { makeTextMessage, makeExtendedText, makeImageWithCaption, wrapEdited, resetIds, BASE_TS } from './fixtures.ts';

const NOW = 1_754_225_000_000;
const ALICE = '15551230001@s.whatsapp.net';

const historyOpts: BatchOpts = { sourceEventName: 'messaging-history.set', runKind: 'history', nowMs: NOW };
const liveOpts: BatchOpts = { sourceEventName: 'messages.upsert', runKind: 'live', nowMs: NOW };

function setup() {
  resetIds();
  const db = openMemoryDb();
  const accountId = ensureAccount(db, NOW);
  return { db, accountId };
}

function integrityOk(db: ReturnType<typeof openMemoryDb>): void {
  assert.doesNotThrow(() => db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run());
}

test('ftsQuote neutralizes FTS syntax in raw user text', () => {
  assert.equal(ftsQuote('hello world'), '"hello" "world"');
  assert.equal(ftsQuote('  spaced   out  '), '"spaced" "out"');
  assert.equal(ftsQuote('say "hi"'), '"say" """hi"""');
  assert.equal(ftsQuote('a-b OR c'), '"a-b" "OR" "c"'); // OR is literal, not an operator
  assert.equal(ftsQuote('   '), '""');
});

test('search matches body text, extended text, and captions', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'F1', remoteJid: ALICE, text: 'the quick brown fox' }),
      makeExtendedText({ id: 'F2', remoteJid: ALICE, text: 'lazy dog jumps' }),
      makeImageWithCaption({ id: 'F3', remoteJid: ALICE, caption: 'a photograph of a fox' }),
    ],
    historyOpts,
  );

  assert.equal(searchMessages(db, 'fox').length, 2, 'fox is in a body and a caption');
  assert.equal(searchMessages(db, 'dog').length, 1);
  assert.equal(searchMessages(db, 'photograph').length, 1);
  assert.equal(searchMessages(db, 'nonexistent').length, 0);
  db.close();
});

test('search is diacritic-insensitive but does not stem', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'D1', remoteJid: ALICE, text: 'un café au lait' }),
      makeTextMessage({ id: 'D2', remoteJid: ALICE, text: 'running quickly' }),
    ],
    historyOpts,
  );
  assert.equal(searchMessages(db, 'cafe').length, 1, 'remove_diacritics=2 folds é');
  assert.equal(searchMessages(db, 'run').length, 0, 'unicode61 does not stem');
  db.close();
});

test('a bad query is quoted, not fatal', () => {
  const { db, accountId } = setup();
  ingestBatch(db, accountId, [makeTextMessage({ id: 'B1', remoteJid: ALICE, text: 'plain text here' })], historyOpts);
  assert.doesNotThrow(() => searchMessages(db, '"'));
  assert.doesNotThrow(() => searchMessages(db, '- AND *'));
  db.close();
});

test('tombstoned messages never appear in search', () => {
  const { db, accountId } = setup();
  ingestBatch(db, accountId, [makeTextMessage({ id: 'S1', remoteJid: ALICE, text: 'find me then delete me' })], historyOpts);
  assert.equal(searchMessages(db, 'delete').length, 1);
  tombstoneMessage(db, accountId, { remoteJid: ALICE, id: 'S1' }, { sourceEventName: 'messages.update', nowMs: NOW });
  assert.equal(searchMessages(db, 'delete').length, 0);
  integrityOk(db);
  db.close();
});

test('search after an edit finds the new text only', () => {
  const { db, accountId } = setup();
  const original = makeTextMessage({ id: 'E1', remoteJid: ALICE, text: 'apple banana' });
  ingestBatch(db, accountId, [original], historyOpts);
  ingestBatch(db, accountId, [wrapEdited(original, 'cherry date')], liveOpts);
  assert.equal(searchMessages(db, 'apple').length, 0);
  assert.equal(searchMessages(db, 'cherry').length, 1);
  integrityOk(db);
  db.close();
});

test('getChatWindow returns chronological order and paginates', () => {
  const { db, accountId } = setup();
  const msgs = Array.from({ length: 5 }, (_, i) =>
    makeTextMessage({ id: `W${i}`, remoteJid: ALICE, text: `message ${i}`, tsSeconds: BASE_TS + i }),
  );
  ingestBatch(db, accountId, msgs, historyOpts);
  const chatId = (db.prepare('SELECT id FROM chats LIMIT 1').get() as { id: number }).id;

  const all = getChatWindow(db, chatId, { limit: 10 });
  assert.deepEqual(all.map((m) => m.text_body), ['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);

  // Newest window of 2, then page back.
  const recent = getChatWindow(db, chatId, { limit: 2 });
  assert.deepEqual(recent.map((m) => m.text_body), ['message 3', 'message 4']);
  const older = getChatWindow(db, chatId, { limit: 2, beforeMs: recent[0].sent_at_ms });
  assert.deepEqual(older.map((m) => m.text_body), ['message 1', 'message 2']);
  db.close();
});

test('getChatWindow hides tombstoned messages', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'V1', remoteJid: ALICE, text: 'keep' }),
      makeTextMessage({ id: 'V2', remoteJid: ALICE, text: 'remove' }),
    ],
    historyOpts,
  );
  const chatId = (db.prepare('SELECT id FROM chats LIMIT 1').get() as { id: number }).id;
  tombstoneMessage(db, accountId, { remoteJid: ALICE, id: 'V2' }, { sourceEventName: 'x', nowMs: NOW });
  assert.deepEqual(getChatWindow(db, chatId).map((m) => m.text_body), ['keep']);
  db.close();
});

test('getMessageWithVersions returns history for an edited message and null for unknown', () => {
  const { db, accountId } = setup();
  const original = makeTextMessage({ id: 'H1', remoteJid: ALICE, text: 'first' });
  ingestBatch(db, accountId, [original], historyOpts);
  ingestBatch(db, accountId, [wrapEdited(original, 'second')], liveOpts);

  const id = (db.prepare("SELECT id FROM messages WHERE wa_message_id = 'H1'").get() as { id: number }).id;
  const result = getMessageWithVersions(db, id)!;
  assert.equal(result.text_body, 'second');
  assert.notEqual(result.edited_at_ms, null);
  assert.equal(result.versions.length, 2);
  assert.deepEqual(result.versions.map((v) => v.text_body), ['first', 'second']);
  assert.equal(result.versions[0].is_original, 1);
  assert.equal(result.versions[1].is_current, 1);

  assert.equal(getMessageWithVersions(db, 999999), null);

  // A never-edited message has an empty version list.
  ingestBatch(db, accountId, [makeTextMessage({ id: 'H2', remoteJid: ALICE, text: 'unchanged' })], historyOpts);
  const id2 = (db.prepare("SELECT id FROM messages WHERE wa_message_id = 'H2'").get() as { id: number }).id;
  assert.equal(getMessageWithVersions(db, id2)!.versions.length, 0);
  db.close();
});

test('search runs against a genuine read-only connection', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { openDb, openReadOnlyDb } = await import('../src/db/db.ts');

  const dir = mkdtempSync(path.join(tmpdir(), 'wad-fts-'));
  const dbPath = path.join(dir, 'archive.sqlite');
  const rw = openDb(dbPath);
  const accountId = ensureAccount(rw, NOW);
  ingestBatch(rw, accountId, [makeTextMessage({ id: 'RO1', remoteJid: ALICE, text: 'readonly search works' })], historyOpts);
  rw.close();

  const ro = openReadOnlyDb(dbPath);
  assert.equal(searchMessages(ro, 'readonly').length, 1);
  const chatId = (ro.prepare('SELECT id FROM chats LIMIT 1').get() as { id: number }).id;
  assert.equal(getChatWindow(ro, chatId).length, 1);
  ro.close();
});
