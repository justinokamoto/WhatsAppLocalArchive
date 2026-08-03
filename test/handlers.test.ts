import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, ensureAccount } from '../src/db/db.ts';
import {
  onHistorySet,
  onMessagesUpsert,
  onMessagesUpdate,
  onMessagesDelete,
  onChatsDelete,
  onLidMapping,
  onOwnJid,
} from '../src/wa/handlers.ts';
import type { HandlerContext } from '../src/wa/handlers.ts';
import { makeTextMessage, makeExtendedText, wrapEdited, resetIds } from './fixtures.ts';

const NOW = 1_754_225_000_000;
const ALICE = '15551230001@s.whatsapp.net';
const ALICE_LID = '88112233@lid';
const BOB = '15551230002@s.whatsapp.net';

function setup(): HandlerContext {
  resetIds();
  const db = openMemoryDb();
  const accountId = ensureAccount(db, NOW);
  return { db, accountId, now: () => NOW };
}

const count = (ctx: HandlerContext, table: string): number =>
  (ctx.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

test('onHistorySet links lidPnMappings before ingesting, yielding one identity', () => {
  const ctx = setup();
  onHistorySet(ctx, {
    chats: [],
    contacts: [],
    lidPnMappings: [{ pn: ALICE, lid: ALICE_LID }],
    messages: [makeTextMessage({ id: 'H1', remoteJid: ALICE, text: 'hi' })],
  } as never);

  assert.equal(count(ctx, 'messages'), 1);
  // Alice's PN and LID collapse onto one identity (self placeholder is separate).
  const distinct = ctx.db
    .prepare('SELECT count(DISTINCT identity_id) c FROM identity_addresses WHERE jid IN (?, ?)')
    .get(ALICE, ALICE_LID) as { c: number };
  assert.equal(distinct.c, 1);
  ctx.db.close();
});

test('onMessagesUpsert with type notify ingests as live', () => {
  const ctx = setup();
  onMessagesUpsert(ctx, { type: 'notify', messages: [makeTextMessage({ id: 'U1', remoteJid: ALICE, text: 'live' })] } as never);
  const run = ctx.db.prepare("SELECT run_kind, source_event_name FROM sync_runs ORDER BY id DESC LIMIT 1").get() as {
    run_kind: string;
    source_event_name: string;
  };
  assert.equal(run.run_kind, 'live');
  assert.equal(run.source_event_name, 'messages.upsert:notify');
  assert.equal(count(ctx, 'messages'), 1);
  ctx.db.close();
});

test('onMessagesUpsert with type append ingests as backfill', () => {
  const ctx = setup();
  onMessagesUpsert(ctx, { type: 'append', messages: [makeTextMessage({ id: 'A1', remoteJid: ALICE, text: 'old' })] } as never);
  const run = ctx.db.prepare('SELECT run_kind FROM sync_runs ORDER BY id DESC LIMIT 1').get() as { run_kind: string };
  assert.equal(run.run_kind, 'backfill');
  ctx.db.close();
});

test('onMessagesUpdate applies an edit through the version machinery', () => {
  const ctx = setup();
  const original = makeTextMessage({ id: 'ED1', remoteJid: ALICE, text: 'before' });
  onMessagesUpsert(ctx, { type: 'notify', messages: [original] } as never);

  const edited = wrapEdited(original, 'after');
  onMessagesUpdate(ctx, [{ key: edited.key, update: { message: edited.message } }] as never);

  const msg = ctx.db.prepare("SELECT id, text_body, edited_at_ms FROM messages WHERE wa_message_id = 'ED1'").get() as {
    id: number;
    text_body: string;
    edited_at_ms: number | null;
  };
  assert.equal(msg.text_body, 'after');
  assert.notEqual(msg.edited_at_ms, null);
  assert.equal(count(ctx, 'message_versions'), 2);
  ctx.db.close();
});

test('onMessagesUpdate ignores status-only updates (no message payload)', () => {
  const ctx = setup();
  const original = makeTextMessage({ id: 'ST1', remoteJid: ALICE, text: 'x' });
  onMessagesUpsert(ctx, { type: 'notify', messages: [original] } as never);
  const eventsBefore = count(ctx, 'message_events');
  onMessagesUpdate(ctx, [{ key: original.key, update: { status: 4 } }] as never);
  assert.equal(count(ctx, 'message_events'), eventsBefore, 'a status-only update writes no event');
  ctx.db.close();
});

test('onMessagesDelete with keys tombstones one message', () => {
  const ctx = setup();
  const m = makeTextMessage({ id: 'DL1', remoteJid: ALICE, text: 'delete me' });
  onMessagesUpsert(ctx, { type: 'notify', messages: [m] } as never);
  onMessagesDelete(ctx, { keys: [m.key] } as never);
  assert.equal(count(ctx, 'agent_messages'), 0);
  assert.equal(count(ctx, 'messages'), 1, 'row preserved');
  ctx.db.close();
});

test('onMessagesDelete with {jid, all} clears the whole chat', () => {
  const ctx = setup();
  onMessagesUpsert(ctx, {
    type: 'notify',
    messages: [
      makeTextMessage({ id: 'X1', remoteJid: ALICE, text: 'a' }),
      makeTextMessage({ id: 'X2', remoteJid: ALICE, text: 'b' }),
      makeTextMessage({ id: 'X3', remoteJid: BOB, text: 'c' }),
    ],
  } as never);
  onMessagesDelete(ctx, { jid: ALICE, all: true } as never);
  assert.equal(count(ctx, 'agent_messages'), 1, "only Bob's message visible");
  ctx.db.close();
});

test('onChatsDelete tombstones the named chats', () => {
  const ctx = setup();
  onMessagesUpsert(ctx, { type: 'notify', messages: [makeTextMessage({ id: 'CD1', remoteJid: ALICE, text: 'bye' })] } as never);
  onChatsDelete(ctx, [ALICE] as never);
  assert.equal(count(ctx, 'agent_messages'), 0);
  ctx.db.close();
});

test('onLidMapping merges a LID and PN observed separately', () => {
  const ctx = setup();
  onMessagesUpsert(ctx, {
    type: 'notify',
    messages: [
      makeExtendedText({ id: 'L1', remoteJid: '123-1@g.us', participant: ALICE, text: 'pn' }),
      makeExtendedText({ id: 'L2', remoteJid: '123-1@g.us', participant: ALICE_LID, text: 'lid' }),
    ],
  } as never);
  const before = ctx.db
    .prepare('SELECT count(DISTINCT identity_id) c FROM identity_addresses WHERE jid IN (?, ?)')
    .get(ALICE, ALICE_LID) as { c: number };
  assert.equal(before.c, 2, 'distinct until the mapping is learned');

  onLidMapping(ctx, { pn: ALICE, lid: ALICE_LID } as never);
  const after = ctx.db
    .prepare('SELECT count(DISTINCT identity_id) c FROM identity_addresses WHERE jid IN (?, ?)')
    .get(ALICE, ALICE_LID) as { c: number };
  assert.equal(after.c, 1, 'merged after the mapping');
  ctx.db.close();
});

test('onOwnJid binds our JID to the self identity', () => {
  const ctx = setup();
  onOwnJid(ctx, '15559998888:2@s.whatsapp.net');
  const account = ctx.db.prepare('SELECT own_pn_jid, self_identity_id FROM accounts WHERE id = ?').get(ctx.accountId) as {
    own_pn_jid: string;
    self_identity_id: number;
  };
  assert.equal(account.own_pn_jid, '15559998888@s.whatsapp.net');
  assert.notEqual(account.self_identity_id, null);
  // Idempotent.
  onOwnJid(ctx, '15559998888@s.whatsapp.net');
  assert.equal(count(ctx, 'identities'), 1);
  ctx.db.close();
});
