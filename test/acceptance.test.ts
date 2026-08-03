import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openReadOnlyDb, openMemoryDb, ensureAccount, decodeJson } from '../src/db/db.ts';
import { ingestBatch, tombstoneMessage } from '../src/ingest/ingest.ts';
import type { BatchOpts } from '../src/ingest/ingest.ts';
import { onMessagesDelete, onMessagesUpsert } from '../src/wa/handlers.ts';
import type { HandlerContext } from '../src/wa/handlers.ts';
import { searchMessages, getMessageWithVersions } from '../src/query/search.ts';
import { openEncryptedAuthState } from '../src/auth/keystore.ts';
import {
  makeTextMessage,
  makeExtendedText,
  makeImageWithCaption,
  makeUnknownType,
  makePoisonMessage,
  wrapEdited,
  resetIds,
  BASE_TS,
} from './fixtures.ts';
import type { WAMessage } from 'baileys';

const NOW = 1_754_225_000_000;
const ALICE = '15551230001@s.whatsapp.net';
const ALICE_LID = '88112233@lid';
const BOB = '15551230002@s.whatsapp.net';
const CAROL = '15551230003@s.whatsapp.net';
const GROUP = '123456789-987654@g.us';

const history = (n = NOW): BatchOpts => ({ sourceEventName: 'messaging-history.set', runKind: 'history', nowMs: n });
const live = (n = NOW): BatchOpts => ({ sourceEventName: 'messages.upsert', runKind: 'live', nowMs: n });

const count = (db: ReturnType<typeof openMemoryDb>, table: string): number =>
  (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

function tmpDb(): { db: ReturnType<typeof openDb>; accountId: number; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wad-accept-'));
  const dbPath = path.join(dir, 'archive.sqlite');
  const db = openDb(dbPath);
  const accountId = ensureAccount(db, NOW);
  return { db, accountId, dir, dbPath };
}

function memDb() {
  resetIds();
  const db = openMemoryDb();
  const accountId = ensureAccount(db, NOW);
  return { db, accountId };
}

// #1 — A fresh install imports message history.
test('AC1: a fresh install imports historical messages', () => {
  const { db, accountId, dir } = tmpDb();
  const r = ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'A', remoteJid: ALICE, text: 'first' }),
      makeTextMessage({ id: 'B', remoteJid: BOB, text: 'second' }),
    ],
    history(),
  );
  assert.equal(r.inserted, 2);
  assert.equal(count(db, 'messages'), 2);
  db.close();
  fs.rmSync(dir, { recursive: true });
});

// #2 — Live messages are captured, both directions.
test('AC2: live messages are captured in both directions', () => {
  const { db, accountId } = memDb();
  const ctx: HandlerContext = { db, accountId, now: () => NOW };
  onMessagesUpsert(ctx, {
    type: 'notify',
    messages: [
      makeTextMessage({ id: 'IN', remoteJid: ALICE, fromMe: false, text: 'incoming' }),
      makeTextMessage({ id: 'OUT', remoteJid: ALICE, fromMe: true, text: 'outgoing' }),
    ],
  } as never);
  assert.equal(count(db, 'messages'), 2);
  const dirs = db.prepare('SELECT from_me FROM messages ORDER BY from_me').all() as { from_me: number }[];
  assert.deepEqual(dirs.map((d) => d.from_me), [0, 1]);
  db.close();
});

// #3 — Restart causes no duplicates.
test('AC3: restarting and re-ingesting produces no duplicates', () => {
  const { db, accountId, dir, dbPath } = tmpDb();
  const corpus = (): WAMessage[] => {
    resetIds();
    return [
      makeTextMessage({ id: 'D1', remoteJid: ALICE, text: 'one' }),
      makeExtendedText({ id: 'D2', remoteJid: GROUP, participant: BOB, text: 'two', mentions: [ALICE] }),
      makeImageWithCaption({ id: 'D3', remoteJid: ALICE, caption: 'three' }),
    ];
  };
  ingestBatch(db, accountId, corpus(), history());
  const before = count(db, 'messages');
  db.close();

  const db2 = openDb(dbPath);
  ingestBatch(db2, accountId, corpus(), live());
  assert.equal(count(db2, 'messages'), before, 'no growth on restart + redelivery');
  assert.equal(count(db2, 'message_events'), before, 'no spurious events either');
  db2.close();
  fs.rmSync(dir, { recursive: true });
});

// #4 — Group messages preserve both chat and participant JID, and LID/PN aliasing
// does not double-count.
test('AC4: group messages keep chat+participant JID and dedupe across LID/PN', () => {
  const { db, accountId } = memDb();
  // Pass 1: participant by LID (with PN alt). Pass 2: same message by PN.
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'G', remoteJid: GROUP, participant: ALICE_LID, participantAlt: ALICE, text: 'hi' })],
    history(),
  );
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'G', remoteJid: GROUP, participant: ALICE, text: 'hi' })],
    live(),
  );
  assert.equal(count(db, 'messages'), 1, 'one row despite two addressings');
  const row = db.prepare("SELECT remote_jid_raw, participant_jid_raw FROM messages WHERE wa_message_id = 'G'").get() as {
    remote_jid_raw: string;
    participant_jid_raw: string;
  };
  assert.equal(row.remote_jid_raw, GROUP);
  assert.ok(row.participant_jid_raw === ALICE || row.participant_jid_raw === ALICE_LID);
  db.close();
});

// #5 — Text is searchable.
test('AC5: message text is full-text searchable', () => {
  const { db, accountId } = memDb();
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'S1', remoteJid: ALICE, text: 'plain conversation body' }),
      makeExtendedText({ id: 'S2', remoteJid: ALICE, text: 'extended text body' }),
      makeImageWithCaption({ id: 'S3', remoteJid: ALICE, caption: 'caption body' }),
    ],
    history(),
  );
  assert.equal(searchMessages(db, 'body').length, 3);
  assert.equal(searchMessages(db, 'conversation').length, 1);
  assert.equal(searchMessages(db, 'caption').length, 1);
  db.close();
});

// #6 — Replies can be resolved.
test('AC6: replies resolve to the quoted message, inline and deferred', () => {
  const { db, accountId } = memDb();
  // Inline: target then reply in the same batch.
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'Q1', remoteJid: ALICE, text: 'original' }),
      makeExtendedText({ id: 'Q2', remoteJid: ALICE, text: 'reply', quoted: { id: 'Q1', text: 'original' } }),
    ],
    history(),
  );
  const q1 = db.prepare("SELECT id FROM messages WHERE wa_message_id = 'Q1'").get() as { id: number };
  const q2 = db.prepare("SELECT quoted_message_db_id FROM messages WHERE wa_message_id = 'Q2'").get() as {
    quoted_message_db_id: number;
  };
  assert.equal(q2.quoted_message_db_id, q1.id);

  // Deferred: reply before target, resolved by the next batch's resolvePendingQuotes.
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'Q4', remoteJid: BOB, text: 'early reply', quoted: { id: 'Q3', text: 'later' } })],
    live(),
  );
  assert.equal(
    (db.prepare("SELECT quoted_message_db_id FROM messages WHERE wa_message_id = 'Q4'").get() as { quoted_message_db_id: number | null }).quoted_message_db_id,
    null,
  );
  ingestBatch(db, accountId, [makeTextMessage({ id: 'Q3', remoteJid: BOB, text: 'later' })], live());
  const q3 = db.prepare("SELECT id FROM messages WHERE wa_message_id = 'Q3'").get() as { id: number };
  assert.equal(
    (db.prepare("SELECT quoted_message_db_id FROM messages WHERE wa_message_id = 'Q4'").get() as { quoted_message_db_id: number }).quoted_message_db_id,
    q3.id,
  );
  db.close();
});

// #7 — Mentions are queryable.
test('AC7: mentions are queryable by resolved identity', () => {
  const { db, accountId } = memDb();
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'M', remoteJid: GROUP, participant: ALICE, text: 'ping @b @c', mentions: [BOB, CAROL] })],
    history(),
  );
  const mid = (db.prepare("SELECT id FROM messages WHERE wa_message_id = 'M'").get() as { id: number }).id;
  const mentions = db
    .prepare('SELECT mentioned_jid, mentioned_identity_id, ordinal FROM message_mentions WHERE message_id = ? ORDER BY ordinal')
    .all(mid) as { mentioned_jid: string; mentioned_identity_id: number; ordinal: number }[];
  assert.deepEqual(mentions.map((m) => m.ordinal), [0, 1]);
  const bobId = mentions.find((m) => m.mentioned_jid === BOB)!.mentioned_identity_id;
  const mentioningBob = db.prepare('SELECT count(*) c FROM message_mentions WHERE mentioned_identity_id = ?').get(bobId) as {
    c: number;
  };
  assert.equal(mentioningBob.c, 1);
  db.close();
});

// #8 — Edits keep history.
test('AC8: edits preserve version history', () => {
  const { db, accountId } = memDb();
  const original = makeTextMessage({ id: 'E', remoteJid: ALICE, text: 'v1 text' });
  ingestBatch(db, accountId, [original], history());
  ingestBatch(db, accountId, [wrapEdited(original, 'v2 text')], live());

  const id = (db.prepare("SELECT id FROM messages WHERE wa_message_id = 'E'").get() as { id: number }).id;
  const result = getMessageWithVersions(db, id)!;
  assert.equal(result.versions.length, 2);
  assert.equal(result.versions[0].text_body, 'v1 text');
  assert.equal(result.versions[0].is_original, 1);
  assert.equal(result.versions[1].text_body, 'v2 text');
  assert.equal(result.versions[1].is_current, 1);
  assert.equal(searchMessages(db, 'v2').length, 1);
  assert.equal(searchMessages(db, 'v1').length, 0, 'search follows the current version');
  db.close();
});

// #9 — Deletes are tombstones.
test('AC9: deletes are tombstones, never physical removal', () => {
  const { db, accountId } = memDb();
  const m = makeTextMessage({ id: 'DEL', remoteJid: ALICE, text: 'delete me' });
  ingestBatch(db, accountId, [m], history());
  const before = db.prepare("SELECT raw_payload_json FROM messages WHERE wa_message_id = 'DEL'").get() as {
    raw_payload_json: string;
  };
  const ctx: HandlerContext = { db, accountId, now: () => NOW };
  onMessagesDelete(ctx, { keys: [m.key] } as never);

  const row = db.prepare("SELECT is_deleted, raw_payload_json FROM messages WHERE wa_message_id = 'DEL'").get() as {
    is_deleted: number;
    raw_payload_json: string;
  };
  assert.equal(row.is_deleted, 1);
  assert.equal(count(db, 'messages'), 1, 'row is not removed');
  assert.equal(row.raw_payload_json, before.raw_payload_json, 'payload preserved intact');
  assert.equal(count(db, 'agent_messages'), 0, 'hidden from the agent view');
  assert.equal(searchMessages(db, 'delete').length, 0, 'hidden from search');
  db.close();
});

// #10 — Unknown types are preserved without crashing.
test('AC10: unknown types are archived, and a poison message is quarantined', () => {
  const { db, accountId } = memDb();
  // Unknown type on the happy path: a normal row, no failure.
  ingestBatch(db, accountId, [makeUnknownType({ id: 'UNK', remoteJid: ALICE })], history());
  assert.equal(count(db, 'ingest_failures'), 0);
  const unk = db.prepare("SELECT content_type_canonical, raw_payload_json FROM messages WHERE wa_message_id = 'UNK'").get() as {
    content_type_canonical: string;
    raw_payload_json: string;
  };
  assert.equal(unk.content_type_canonical, 'someFutureMessage');
  assert.ok(unk.raw_payload_json.length > 0);

  // A genuinely broken message quarantines without losing the rest of the batch.
  const r = ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'OK1', remoteJid: ALICE, text: 'good' }),
      makePoisonMessage({ id: 'BAD', remoteJid: ALICE }),
      makeTextMessage({ id: 'OK2', remoteJid: ALICE, text: 'also good' }),
    ],
    live(),
  );
  assert.equal(r.inserted, 2);
  assert.equal(r.failed, 1);
  assert.equal(count(db, 'ingest_failures'), 1);
  db.close();
});

// #11 — The agent can read but not write.
test('AC11: a read-only connection can query but every write is rejected', () => {
  const { db, accountId, dir, dbPath } = tmpDb();
  ingestBatch(db, accountId, [makeTextMessage({ id: 'RO', remoteJid: ALICE, text: 'readable' })], history());
  db.close();

  const ro = openReadOnlyDb(dbPath);
  assert.equal((ro.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c, 1);
  assert.equal(searchMessages(ro, 'readable').length, 1);

  for (const sql of [
    "INSERT INTO messages(account_id, chat_id, wa_message_id, from_me, remote_jid_raw, sender_identity_id, sent_at_ms, content_hash, raw_payload_json, source_event_name, baileys_version, parser_version, ingested_at_ms, updated_at_ms) VALUES (1,1,'x',0,'j',1,1,'h','{}','e','7',1,1,1)",
    "UPDATE messages SET text_body = 'hacked'",
    'DELETE FROM messages',
    'CREATE TABLE evil(x)',
    'DROP TABLE messages',
    "INSERT INTO messages_fts(rowid, text_body, caption) VALUES (99, 'x', NULL)",
  ]) {
    assert.throws(() => ro.prepare(sql).run(), new RegExp('readonly|read-only|read only', 'i'), sql);
  }
  // `PRAGMA writable_schema=ON` is a no-op on a read-only connection: it does not
  // throw, but crucially it does NOT grant write ability -- a write afterwards is
  // still rejected. That is the property that matters.
  ro.prepare('PRAGMA writable_schema = ON').run();
  assert.throws(() => ro.prepare("UPDATE messages SET text_body = 'still blocked'").run(), /readonly|read-only|read only/i);
  ro.close();
  fs.rmSync(dir, { recursive: true });
});

// #12 — Credentials are not reachable through the archive.
test('AC12: no credentials in the database; auth files are unreadable without the passphrase', () => {
  const { db, dir } = tmpDb();
  const schema = db.prepare("SELECT group_concat(name) AS names FROM sqlite_master").get() as { names: string };
  assert.doesNotMatch(schema.names, /cred|secret|signal|key(?!_)/i, 'no credential-bearing tables');
  // accounts explicitly holds no secret columns.
  const cols = db.prepare("SELECT group_concat(name) AS names FROM pragma_table_info('accounts')").get() as {
    names: string;
  };
  assert.doesNotMatch(cols.names, /cred|secret|password|token/i);
  db.close();

  // The encrypted keystore cannot be opened with a wrong passphrase.
  const authDir = path.join(dir, 'auth');
  openEncryptedAuthState('right passphrase', authDir).saveCreds();
  assert.throws(() => openEncryptedAuthState('wrong passphrase', authDir), /passphrase|verifier/i);
  fs.rmSync(dir, { recursive: true });
});

// #13 — Media and AI artifacts can be added without restructuring.
test('AC13: media and ai_artifacts attach to a real message via FK', () => {
  const { db, accountId } = memDb();
  ingestBatch(db, accountId, [makeImageWithCaption({ id: 'IMG', remoteJid: ALICE, caption: 'photo' })], history());
  const id = (db.prepare("SELECT id FROM messages WHERE wa_message_id = 'IMG'").get() as { id: number }).id;

  assert.doesNotThrow(() =>
    db
      .prepare(
        "INSERT INTO media(message_id, sha256, download_state, created_at_ms) VALUES (?, 'abc123', 'pending', ?)",
      )
      .run(id, NOW),
  );
  assert.doesNotThrow(() =>
    db
      .prepare(
        "INSERT INTO ai_artifacts(subject_kind, subject_id, artifact_kind, producer, content_text, created_at_ms) VALUES ('message', ?, 'summary', 'test', 'a summary', ?)",
      )
      .run(id, NOW),
  );
  // FK is enforced: a dangling message_id is rejected.
  assert.throws(() =>
    db.prepare("INSERT INTO media(message_id, sha256, download_state, created_at_ms) VALUES (999999, 'x', 'pending', ?)").run(NOW),
    /FOREIGN KEY/i,
  );
  db.close();
});

// #14 — Raw payloads round-trip, Buffers included, so future reprocessing is lossless.
test('AC14: raw_payload_json round-trips including Buffer fields', () => {
  const { db, accountId } = memDb();
  const original = makeImageWithCaption({ id: 'RT', remoteJid: ALICE, caption: 'buffers' });
  ingestBatch(db, accountId, [original], history());
  const stored = db.prepare("SELECT raw_payload_json FROM messages WHERE wa_message_id = 'RT'").get() as {
    raw_payload_json: string;
  };
  const revived = decodeJson<WAMessage>(stored.raw_payload_json);
  assert.ok(Buffer.isBuffer(revived.message?.imageMessage?.mediaKey));
  assert.deepEqual(revived.message?.imageMessage?.mediaKey, original.message?.imageMessage?.mediaKey);
  assert.deepEqual(revived.message?.imageMessage?.fileSha256, original.message?.imageMessage?.fileSha256);
  db.close();
});

// #15 — FTS integrity is maintained across the full lifecycle.
test('AC15: FTS integrity holds across insert, edit, and tombstone', () => {
  const { db, accountId } = memDb();
  const m = makeTextMessage({ id: 'FTS', remoteJid: ALICE, text: 'searchable content' });
  ingestBatch(db, accountId, [m, makeTextMessage({ id: 'FTS2', remoteJid: BOB, text: 'more content' })], history());
  ingestBatch(db, accountId, [wrapEdited(m, 'edited content')], live());
  tombstoneMessage(db, accountId, { remoteJid: BOB, id: 'FTS2' }, { sourceEventName: 'messages.update', nowMs: NOW });
  assert.doesNotThrow(() => db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run());
  db.close();
});
