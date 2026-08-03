import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, ensureAccount, decodeJson } from '../src/db/db.ts';
import { ingestBatch, tombstoneMessage, tombstoneChat, resolvePendingQuotes } from '../src/ingest/ingest.ts';
import type { BatchOpts } from '../src/ingest/ingest.ts';
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
const BOB = '15551230002@s.whatsapp.net';
const GROUP = '123456789-987654@g.us';

function setup() {
  const db = openMemoryDb();
  const accountId = ensureAccount(db, NOW);
  return { db, accountId };
}

const historyOpts = (n = NOW): BatchOpts => ({
  sourceEventName: 'messaging-history.set',
  runKind: 'history',
  nowMs: n,
});
const liveOpts = (n = NOW): BatchOpts => ({
  sourceEventName: 'messages.upsert',
  runKind: 'live',
  nowMs: n,
});

const count = (db: ReturnType<typeof openMemoryDb>, table: string): number =>
  (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

/** Snapshot of every table the idempotency guarantee touches. */
function snapshot(db: ReturnType<typeof openMemoryDb>) {
  return {
    messages: count(db, 'messages'),
    chats: count(db, 'chats'),
    identities: count(db, 'identities'),
    versions: count(db, 'message_versions'),
    events: count(db, 'message_events'),
    mentions: count(db, 'message_mentions'),
    fts: count(db, 'messages_fts'),
    failures: count(db, 'ingest_failures'),
  };
}

function corpus(): WAMessage[] {
  resetIds();
  return [
    makeTextMessage({ id: 'T1', remoteJid: ALICE, text: 'hello alice' }),
    makeTextMessage({ id: 'T2', remoteJid: ALICE, fromMe: true, text: 'hi from me' }),
    makeTextMessage({ id: 'T3', remoteJid: BOB, text: 'yo bob' }),
    makeExtendedText({
      id: 'T4',
      remoteJid: GROUP,
      participant: ALICE,
      text: 'hey @b',
      mentions: [BOB],
    }),
    makeExtendedText({
      id: 'T5',
      remoteJid: GROUP,
      participant: BOB,
      text: 'replying',
      quoted: { id: 'T4', participant: ALICE, text: 'hey @b' },
    }),
    makeImageWithCaption({ id: 'T6', remoteJid: ALICE, caption: 'a cat photo' }),
    makeUnknownType({ id: 'T7', remoteJid: ALICE }),
  ];
}

test('a fresh batch imports every message exactly once', () => {
  const { db, accountId } = setup();
  const r = ingestBatch(db, accountId, corpus(), historyOpts());
  assert.equal(r.seen, 7);
  assert.equal(r.inserted, 7);
  assert.equal(r.failed, 0);
  assert.equal(count(db, 'messages'), 7);
  // Each fresh insert emits exactly one 'created' event, no version rows.
  assert.equal(count(db, 'message_events'), 7);
  assert.equal(count(db, 'message_versions'), 0);
  // Unknown type is a normal row, not a failure.
  assert.equal(count(db, 'ingest_failures'), 0);
  const unknown = db.prepare("SELECT content_type_canonical FROM messages WHERE wa_message_id = 'T7'").get() as {
    content_type_canonical: string;
  };
  assert.equal(unknown.content_type_canonical, 'someFutureMessage');
  db.close();
});

test('re-ingesting the identical corpus as live upserts changes NOTHING', () => {
  const { db, accountId } = setup();
  ingestBatch(db, accountId, corpus(), historyOpts());
  const before = snapshot(db);

  const r = ingestBatch(db, accountId, corpus(), liveOpts());
  assert.equal(r.inserted, 0);
  assert.equal(r.updated, 0);
  assert.equal(r.redelivered, 7);

  const after = snapshot(db);
  assert.deepEqual(after, before, 'redelivery must not append events, versions, or rows');
  db.close();
});

test('a shuffled redelivery is still a pure no-op', () => {
  const { db, accountId } = setup();
  ingestBatch(db, accountId, corpus(), historyOpts());
  const before = snapshot(db);

  const shuffled = corpus().reverse();
  ingestBatch(db, accountId, shuffled, liveOpts());
  assert.deepEqual(snapshot(db), before);
  db.close();
});

test('idempotency survives a close and reopen from a file', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { openDb } = await import('../src/db/db.ts');

  const dir = mkdtempSync(path.join(tmpdir(), 'wad-'));
  const dbPath = path.join(dir, 'archive.sqlite');

  let db = openDb(dbPath);
  const accountId = ensureAccount(db, NOW);
  ingestBatch(db, accountId, corpus(), historyOpts());
  const before = snapshot(db);
  db.close();

  db = openDb(dbPath);
  ingestBatch(db, accountId, corpus(), liveOpts());
  assert.deepEqual(snapshot(db), before, 'no duplicates after restart');
  db.close();
});

test('a later status upgrade moves only messages.status', () => {
  const { db, accountId } = setup();
  const first = makeTextMessage({ id: 'S1', remoteJid: ALICE, text: 'x', status: 2 });
  ingestBatch(db, accountId, [first], historyOpts());
  const before = snapshot(db);

  const upgraded = makeTextMessage({ id: 'S1', remoteJid: ALICE, text: 'x', status: 4 });
  ingestBatch(db, accountId, [upgraded], liveOpts());

  assert.deepEqual(snapshot(db), before, 'a status bump is not a content change');
  const row = db.prepare("SELECT status FROM messages WHERE wa_message_id = 'S1'").get() as { status: number };
  assert.equal(row.status, 4);

  // status never regresses.
  ingestBatch(db, accountId, [makeTextMessage({ id: 'S1', remoteJid: ALICE, text: 'x', status: 1 })], liveOpts());
  const after = db.prepare("SELECT status FROM messages WHERE wa_message_id = 'S1'").get() as { status: number };
  assert.equal(after.status, 4, 'status is monotonic');
  db.close();
});

test('an edit keeps both versions and re-points FTS to the new text', () => {
  const { db, accountId } = setup();
  const original = makeTextMessage({ id: 'E1', remoteJid: ALICE, text: 'original text' });
  ingestBatch(db, accountId, [original], historyOpts());

  const edited = wrapEdited(original, 'edited text');
  const r = ingestBatch(db, accountId, [edited], liveOpts());
  assert.equal(r.updated, 1, 'an edit counts as a change');

  const msg = db.prepare("SELECT id, text_body, edited_at_ms FROM messages WHERE wa_message_id = 'E1'").get() as {
    id: number;
    text_body: string;
    edited_at_ms: number | null;
  };
  assert.equal(msg.text_body, 'edited text');
  assert.notEqual(msg.edited_at_ms, null, 'an explicit edit stamps edited_at_ms');

  const versions = db
    .prepare('SELECT version_index, is_original, is_current, text_body FROM message_versions WHERE message_id = ? ORDER BY version_index')
    .all(msg.id) as { version_index: number; is_original: number; is_current: number; text_body: string }[];
  assert.equal(versions.length, 2);
  assert.deepEqual({ ...versions[0] }, { version_index: 0, is_original: 1, is_current: 0, text_body: 'original text' });
  assert.deepEqual({ ...versions[1] }, { version_index: 1, is_original: 0, is_current: 1, text_body: 'edited text' });

  const events = db.prepare('SELECT event_type FROM message_events WHERE message_id = ? ORDER BY id').all(msg.id) as {
    event_type: string;
  }[];
  assert.deepEqual(events.map((e) => e.event_type), ['created', 'edited']);

  // FTS finds the new text, not the old.
  const hitNew = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'edited'").all();
  const hitOld = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'original'").all();
  assert.equal(hitNew.length, 1);
  assert.equal(hitOld.length, 0);
  db.close();
});

test('enrichment (more complete data, no edit signal) is updated, not edited', () => {
  const { db, accountId } = setup();
  // Live gave us a bare conversation; history later supplies an extendedText with a quote.
  ingestBatch(db, accountId, [makeTextMessage({ id: 'N1', remoteJid: ALICE, text: 'v1' })], liveOpts());
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'N1', remoteJid: ALICE, text: 'v1 richer', forwardingScore: 3 })],
    historyOpts(),
  );

  const msg = db.prepare("SELECT id, edited_at_ms FROM messages WHERE wa_message_id = 'N1'").get() as {
    id: number;
    edited_at_ms: number | null;
  };
  assert.equal(msg.edited_at_ms, null, 'enrichment must NOT set edited_at_ms');
  const events = db.prepare('SELECT event_type FROM message_events WHERE message_id = ? ORDER BY id').all(msg.id) as {
    event_type: string;
  }[];
  assert.deepEqual(events.map((e) => e.event_type), ['created', 'updated']);
  db.close();
});

test('a message that arrives already edited from history gets one version and an edited event', () => {
  const { db, accountId } = setup();
  const base = makeTextMessage({ id: 'H1', remoteJid: ALICE, text: 'ignored inner' });
  const alreadyEdited = wrapEdited(base, 'the edited body');
  ingestBatch(db, accountId, [alreadyEdited], historyOpts());

  const msg = db.prepare("SELECT id, text_body, edited_at_ms FROM messages WHERE wa_message_id = 'H1'").get() as {
    id: number;
    text_body: string;
    edited_at_ms: number | null;
  };
  assert.equal(msg.text_body, 'the edited body');
  assert.notEqual(msg.edited_at_ms, null);

  const versions = db.prepare('SELECT version_index, is_original, is_current FROM message_versions WHERE message_id = ?').all(msg.id) as {
    version_index: number;
    is_original: number;
    is_current: number;
  }[];
  assert.equal(versions.length, 1);
  assert.deepEqual({ ...versions[0] }, { version_index: 0, is_original: 0, is_current: 1 });

  const event = db.prepare('SELECT event_type, detail_json FROM message_events WHERE message_id = ?').get(msg.id) as {
    event_type: string;
    detail_json: string;
  };
  assert.equal(event.event_type, 'edited');
  assert.deepEqual(decodeJson(event.detail_json), { first_seen_already_edited: true });
  db.close();
});

test('group messages retain both chat JID and participant JID', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'G1', remoteJid: GROUP, participant: ALICE, text: 'hi group' })],
    historyOpts(),
  );
  const row = db.prepare("SELECT remote_jid_raw, participant_jid_raw FROM messages WHERE wa_message_id = 'G1'").get() as {
    remote_jid_raw: string;
    participant_jid_raw: string;
  };
  assert.equal(row.remote_jid_raw, GROUP);
  assert.equal(row.participant_jid_raw, ALICE);
  db.close();
});

test('a group participant addressed by LID then PN stays a single row and identity', () => {
  const { db, accountId } = setup();
  const lid = '88112233@lid';
  // Pass 1: participant addressed by LID, with the PN as the alt.
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'P1', remoteJid: GROUP, participant: lid, participantAlt: ALICE, text: 'from lid' })],
    historyOpts(),
  );
  // Pass 2: same message, participant now addressed by PN.
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'P1', remoteJid: GROUP, participant: ALICE, text: 'from lid' })],
    liveOpts(),
  );

  assert.equal(count(db, 'messages'), 1, 'aliasing must not double-insert');
  // Alice's two addresses collapse onto one identity (plus the group identity).
  const aliceAddrs = db
    .prepare("SELECT count(*) c FROM identity_addresses WHERE jid IN (?, ?)")
    .get(lid, ALICE) as { c: number };
  assert.equal(aliceAddrs.c, 2);
  const distinctIdentities = db
    .prepare('SELECT count(DISTINCT identity_id) c FROM identity_addresses WHERE jid IN (?, ?)')
    .get(lid, ALICE) as { c: number };
  assert.equal(distinctIdentities.c, 1, 'both addresses resolve to one identity');
  db.close();
});

test('mentions are queryable with distinct ordinals and resolved identities', () => {
  const { db, accountId } = setup();
  const carol = '15551230003@s.whatsapp.net';
  ingestBatch(
    db,
    accountId,
    [
      makeExtendedText({
        id: 'M1',
        remoteJid: GROUP,
        participant: ALICE,
        text: 'ping @b @c @d',
        mentions: [BOB, carol, '15551230004@s.whatsapp.net'],
      }),
    ],
    historyOpts(),
  );
  const msg = db.prepare("SELECT id FROM messages WHERE wa_message_id = 'M1'").get() as { id: number };
  const mentions = db
    .prepare('SELECT mentioned_jid, mentioned_identity_id, ordinal FROM message_mentions WHERE message_id = ? ORDER BY ordinal')
    .all(msg.id) as { mentioned_jid: string; mentioned_identity_id: number; ordinal: number }[];
  assert.equal(mentions.length, 3);
  assert.deepEqual(mentions.map((m) => m.ordinal), [0, 1, 2]);
  for (const m of mentions) assert.notEqual(m.mentioned_identity_id, null);

  // "all messages mentioning Bob"
  const bobIdentity = mentions.find((m) => m.mentioned_jid === BOB)!.mentioned_identity_id;
  const mentioningBob = db
    .prepare('SELECT message_id FROM message_mentions WHERE mentioned_identity_id = ?')
    .all(bobIdentity) as { message_id: number }[];
  assert.equal(mentioningBob.length, 1);
  db.close();
});

test('a reply resolves inline when its target was ingested first', () => {
  const { db, accountId } = setup();
  const target = makeTextMessage({ id: 'Q1', remoteJid: ALICE, text: 'the original' });
  const reply = makeExtendedText({
    id: 'Q2',
    remoteJid: ALICE,
    text: 'a reply',
    quoted: { id: 'Q1', text: 'the original' },
  });
  ingestBatch(db, accountId, [target, reply], historyOpts());

  const targetRow = db.prepare("SELECT id FROM messages WHERE wa_message_id = 'Q1'").get() as { id: number };
  const replyRow = db.prepare("SELECT quoted_message_db_id, quoted_wa_message_id FROM messages WHERE wa_message_id = 'Q2'").get() as {
    quoted_message_db_id: number;
    quoted_wa_message_id: string;
  };
  assert.equal(replyRow.quoted_message_db_id, targetRow.id);
  assert.equal(replyRow.quoted_wa_message_id, 'Q1');
  db.close();
});

test('a reply to a not-yet-seen message resolves later via resolvePendingQuotes', () => {
  const { db, accountId } = setup();
  // The reply arrives before its target.
  const reply = makeExtendedText({
    id: 'Q4',
    remoteJid: ALICE,
    text: 'quoting the future',
    quoted: { id: 'Q3', text: 'not here yet' },
  });
  ingestBatch(db, accountId, [reply], liveOpts());
  let replyRow = db.prepare("SELECT quoted_message_db_id, quoted_wa_message_id FROM messages WHERE wa_message_id = 'Q4'").get() as {
    quoted_message_db_id: number | null;
    quoted_wa_message_id: string;
  };
  assert.equal(replyRow.quoted_message_db_id, null, 'unresolved but the wa id is retained');
  assert.equal(replyRow.quoted_wa_message_id, 'Q3');

  // The target arrives; ingestBatch runs resolvePendingQuotes at the end.
  ingestBatch(db, accountId, [makeTextMessage({ id: 'Q3', remoteJid: ALICE, text: 'not here yet' })], liveOpts());
  const targetRow = db.prepare("SELECT id FROM messages WHERE wa_message_id = 'Q3'").get() as { id: number };
  replyRow = db.prepare("SELECT quoted_message_db_id, quoted_wa_message_id FROM messages WHERE wa_message_id = 'Q4'").get() as {
    quoted_message_db_id: number | null;
    quoted_wa_message_id: string;
  };
  assert.equal(replyRow.quoted_message_db_id, targetRow.id);
  db.close();
});

test('a quote of a never-seen message stays NULL but keeps quoted_wa_message_id', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [makeExtendedText({ id: 'Q5', remoteJid: ALICE, text: 'orphan quote', quoted: { id: 'GHOST', text: 'gone' } })],
    historyOpts(),
  );
  assert.equal(resolvePendingQuotes(db, accountId), 0);
  const row = db.prepare("SELECT quoted_message_db_id, quoted_wa_message_id FROM messages WHERE wa_message_id = 'Q5'").get() as {
    quoted_message_db_id: number | null;
    quoted_wa_message_id: string;
  };
  assert.equal(row.quoted_message_db_id, null);
  assert.equal(row.quoted_wa_message_id, 'GHOST');
  db.close();
});

test('a poison message quarantines itself and the rest of the batch commits', () => {
  const { db, accountId } = setup();
  const batch = [
    makeTextMessage({ id: 'OK1', remoteJid: ALICE, text: 'good 1' }),
    makeTextMessage({ id: 'OK2', remoteJid: ALICE, text: 'good 2' }),
    makePoisonMessage({ id: 'BAD', remoteJid: ALICE }),
    makeTextMessage({ id: 'OK3', remoteJid: ALICE, text: 'good 3' }),
    makeTextMessage({ id: 'OK4', remoteJid: ALICE, text: 'good 4' }),
  ];
  const r = ingestBatch(db, accountId, batch, historyOpts());
  assert.equal(r.inserted, 4);
  assert.equal(r.failed, 1);
  assert.equal(count(db, 'messages'), 4, 'the four good rows committed');
  assert.equal(count(db, 'ingest_failures'), 1);
  const failure = db.prepare('SELECT error_message FROM ingest_failures').get() as { error_message: string };
  assert.match(failure.error_message, /poison/);
  db.close();
});

test('revoking a message tombstones it without destroying the payload', () => {
  const { db, accountId } = setup();
  ingestBatch(db, accountId, [makeTextMessage({ id: 'R1', remoteJid: ALICE, text: 'delete me' })], historyOpts());
  const before = db.prepare("SELECT raw_payload_json FROM messages WHERE wa_message_id = 'R1'").get() as {
    raw_payload_json: string;
  };

  const res = tombstoneMessage(db, accountId, { remoteJid: ALICE, id: 'R1' }, { sourceEventName: 'messages.update', nowMs: NOW });
  assert.equal(res, 'tombstoned');

  const row = db.prepare("SELECT is_deleted, deleted_at_ms, raw_payload_json FROM messages WHERE wa_message_id = 'R1'").get() as {
    is_deleted: number;
    deleted_at_ms: number;
    raw_payload_json: string;
  };
  assert.equal(row.is_deleted, 1);
  assert.equal(row.deleted_at_ms, NOW);
  assert.equal(row.raw_payload_json, before.raw_payload_json, 'source payload preserved');

  // Gone from FTS and the agent view, present in the base table.
  assert.equal(db.prepare("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH 'delete'").get()['c' as never], 0 as never);
  assert.equal(count(db, 'agent_messages'), 0);
  assert.equal(count(db, 'messages'), 1);

  // Re-revoking is a no-op; a revoke for an unknown id does nothing.
  assert.equal(tombstoneMessage(db, accountId, { remoteJid: ALICE, id: 'R1' }, { sourceEventName: 'x', nowMs: NOW }), 'already');
  assert.equal(tombstoneMessage(db, accountId, { remoteJid: ALICE, id: 'NOPE' }, { sourceEventName: 'x', nowMs: NOW }), 'not_found');
  db.close();
});

test('clearing a chat tombstones exactly that chat', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'C1', remoteJid: ALICE, text: 'a1' }),
      makeTextMessage({ id: 'C2', remoteJid: ALICE, text: 'a2' }),
      makeTextMessage({ id: 'C3', remoteJid: BOB, text: 'b1' }),
    ],
    historyOpts(),
  );
  const n = tombstoneChat(db, accountId, ALICE, { sourceEventName: 'chats.delete', nowMs: NOW });
  assert.equal(n, 2);
  assert.equal(count(db, 'agent_messages'), 1, "only Bob's message remains visible");
  assert.equal(count(db, 'messages'), 3, 'nothing physically deleted');
  db.close();
});

test('raw_payload_json round-trips including Buffer fields', () => {
  const { db, accountId } = setup();
  const original = makeImageWithCaption({ id: 'B1', remoteJid: ALICE, caption: 'buffers' });
  ingestBatch(db, accountId, [original], historyOpts());
  const stored = db.prepare("SELECT raw_payload_json FROM messages WHERE wa_message_id = 'B1'").get() as {
    raw_payload_json: string;
  };
  const revived = decodeJson<WAMessage>(stored.raw_payload_json);
  const mediaKey = revived.message?.imageMessage?.mediaKey;
  assert.ok(Buffer.isBuffer(mediaKey), 'mediaKey must revive as a Buffer, not a plain object');
  assert.deepEqual(mediaKey, original.message!.imageMessage!.mediaKey);
  db.close();
});

test('FTS integrity holds after inserts, an edit, and a tombstone', () => {
  const { db, accountId } = setup();
  ingestBatch(db, accountId, corpus(), historyOpts());
  const edited = wrapEdited(makeTextMessage({ id: 'T1', remoteJid: ALICE, text: 'hello alice' }), 'hello again');
  ingestBatch(db, accountId, [edited], liveOpts());
  tombstoneMessage(db, accountId, { remoteJid: BOB, id: 'T3' }, { sourceEventName: 'messages.update', nowMs: NOW });

  const res = db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
  assert.doesNotThrow(() => res.run());
  db.close();
});

test('sync_runs records per-batch counters', () => {
  const { db, accountId } = setup();
  const r = ingestBatch(db, accountId, corpus(), historyOpts());
  const run = db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(r.runId) as {
    run_kind: string;
    messages_seen: number;
    messages_inserted: number;
    finished_at_ms: number;
  };
  assert.equal(run.run_kind, 'history');
  assert.equal(run.messages_seen, 7);
  assert.equal(run.messages_inserted, 7);
  assert.notEqual(run.finished_at_ms, null);
  db.close();
});

test('own messages attribute to the self identity, not a second identity', () => {
  const { db, accountId } = setup();
  ingestBatch(
    db,
    accountId,
    [
      makeTextMessage({ id: 'SELF1', remoteJid: ALICE, fromMe: true, text: 'mine' }),
      makeTextMessage({ id: 'SELF2', remoteJid: BOB, fromMe: true, text: 'also mine' }),
    ],
    historyOpts(),
  );
  const senders = db.prepare('SELECT DISTINCT sender_identity_id FROM messages WHERE from_me = 1').all() as {
    sender_identity_id: number;
  }[];
  assert.equal(senders.length, 1, 'all own messages share one self identity');
  const account = db.prepare('SELECT self_identity_id FROM accounts WHERE id = ?').get(accountId) as {
    self_identity_id: number;
  };
  assert.equal(senders[0].sender_identity_id, account.self_identity_id);
  db.close();
});
