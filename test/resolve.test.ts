import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, ensureAccount } from '../src/db/db.ts';
import {
  normalizeJid,
  addressTypeOf,
  identityKindOf,
  chatTypeOf,
  resolveIdentityId,
  resolveChatId,
  linkAddresses,
  mergeIdentities,
  ensureSelfIdentity,
  bindSelfJid,
} from '../src/ingest/resolve.ts';

const NOW = 1_754_225_000_000;
const ALICE_PN = '15551230001@s.whatsapp.net';
const ALICE_LID = '88112233@lid';
const GROUP = '123456789-987654@g.us';

function setup() {
  const db = openMemoryDb();
  const accountId = ensureAccount(db, NOW);
  return { db, accountId };
}

const count = (db: ReturnType<typeof openMemoryDb>, table: string): number =>
  (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

test('normalizeJid strips device suffixes and folds c.us', () => {
  assert.equal(normalizeJid('15551230001:12@s.whatsapp.net'), ALICE_PN);
  assert.equal(normalizeJid('88112233:5@lid'), ALICE_LID);
  assert.equal(normalizeJid('15551230001@c.us'), ALICE_PN);
  assert.equal(normalizeJid(GROUP), GROUP);
});

test('JID classification maps onto schema-allowed values', () => {
  assert.equal(addressTypeOf(ALICE_PN), 'phone_number');
  assert.equal(addressTypeOf(ALICE_LID), 'lid');
  assert.equal(addressTypeOf(GROUP), 'group');
  assert.equal(addressTypeOf('status@broadcast'), 'broadcast');
  assert.equal(addressTypeOf('1234@newsletter'), 'unknown');

  assert.equal(identityKindOf(ALICE_PN), 'user');
  assert.equal(identityKindOf(ALICE_LID), 'user');
  assert.equal(identityKindOf(GROUP), 'group');
  assert.equal(identityKindOf('1234@newsletter'), 'newsletter');

  assert.equal(chatTypeOf(ALICE_PN), 'individual');
  assert.equal(chatTypeOf(GROUP), 'group');
  assert.equal(chatTypeOf('status@broadcast'), 'status');
  assert.equal(chatTypeOf('1234@newsletter'), 'newsletter');
});

test('resolveIdentityId is stable and device-insensitive', () => {
  const { db, accountId } = setup();
  const first = resolveIdentityId(db, accountId, ALICE_PN, NOW);
  const again = resolveIdentityId(db, accountId, ALICE_PN, NOW);
  const withDevice = resolveIdentityId(db, accountId, '15551230001:9@s.whatsapp.net', NOW);

  assert.equal(again, first);
  assert.equal(withDevice, first, 'device suffix must not create a second identity');
  assert.equal(count(db, 'identities'), 1);
  assert.equal(count(db, 'identity_addresses'), 1);
  db.close();
});

test('resolveChatId is keyed by identity, so it is idempotent', () => {
  const { db, accountId } = setup();
  const a = resolveChatId(db, accountId, ALICE_PN, NOW);
  const b = resolveChatId(db, accountId, ALICE_PN, NOW);
  assert.equal(a, b);
  assert.equal(count(db, 'chats'), 1);

  const chat = db.prepare('SELECT chat_type, canonical_remote_jid FROM chats WHERE id = ?').get(a) as {
    chat_type: string;
    canonical_remote_jid: string;
  };
  assert.equal(chat.chat_type, 'individual');
  assert.equal(chat.canonical_remote_jid, ALICE_PN);
  db.close();
});

test('LID and PN start as separate identities, then linkAddresses merges them', () => {
  const { db, accountId } = setup();
  const pnId = resolveIdentityId(db, accountId, ALICE_PN, NOW);
  const lidId = resolveIdentityId(db, accountId, ALICE_LID, NOW);
  assert.notEqual(pnId, lidId, 'without a mapping they are legitimately distinct');
  assert.equal(count(db, 'identities'), 2);

  const kept = linkAddresses(db, accountId, ALICE_PN, ALICE_LID, NOW, 'lid-mapping.update');

  assert.equal(count(db, 'identities'), 1, 'exactly one identity survives');
  assert.equal(kept, Math.min(pnId, lidId), 'lowest rowid wins, deterministically');
  assert.equal(count(db, 'identity_addresses'), 2, 'both addresses retained');

  // Both JIDs now resolve to the survivor.
  assert.equal(resolveIdentityId(db, accountId, ALICE_PN, NOW), kept);
  assert.equal(resolveIdentityId(db, accountId, ALICE_LID, NOW), kept);

  const identity = db.prepare('SELECT canonical_jid FROM identities WHERE id = ?').get(kept) as {
    canonical_jid: string;
  };
  assert.equal(identity.canonical_jid, ALICE_PN, 'phone JID preferred for display');

  const merge = db.prepare('SELECT * FROM identity_merges').get() as { reason: string; kept_identity_id: number };
  assert.equal(merge.reason, 'lid-mapping.update');
  assert.equal(merge.kept_identity_id, kept);

  // No orphans.
  assert.equal(count(db, 'identity_addresses'), 2);
  assert.equal(
    (db.prepare('SELECT count(*) c FROM identity_addresses WHERE identity_id NOT IN (SELECT id FROM identities)').get() as { c: number }).c,
    0,
  );
  db.close();
});

test('merging two chats moves messages and collapses duplicates', () => {
  const { db, accountId } = setup();
  const pnChat = resolveChatId(db, accountId, ALICE_PN, NOW);
  const lidChat = resolveChatId(db, accountId, ALICE_LID, NOW);
  const pnIdentity = resolveIdentityId(db, accountId, ALICE_PN, NOW);
  const lidIdentity = resolveIdentityId(db, accountId, ALICE_LID, NOW);
  assert.notEqual(pnChat, lidChat);

  const insert = db.prepare(
    `INSERT INTO messages(account_id, chat_id, wa_message_id, from_me, remote_jid_raw,
        sender_identity_id, sent_at_ms, content_type_canonical, content_hash,
        raw_payload_json, source_event_name, baileys_version, parser_version,
        ingested_at_ms, updated_at_ms, text_body)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'conversation', 'h', '{}', 'test', '7', 1, ?, ?, ?) RETURNING id`,
  );
  // SHARED exists in both chats (the aliasing duplicate); ONLY_LID exists in one.
  const keepDup = insert.get(accountId, pnChat, 'SHARED', ALICE_PN, pnIdentity, NOW, NOW, NOW, 'shared') as { id: number };
  const dropDup = insert.get(accountId, lidChat, 'SHARED', ALICE_LID, lidIdentity, NOW, NOW, NOW, 'shared') as { id: number };
  const onlyLid = insert.get(accountId, lidChat, 'ONLY_LID', ALICE_LID, lidIdentity, NOW, NOW, NOW, 'only lid') as { id: number };

  db.prepare('INSERT INTO message_events(message_id, event_type, event_at_ms, source_event_name, created_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(dropDup.id, 'created', NOW, 'test', NOW);
  db.prepare('INSERT INTO messages_fts(rowid, text_body, caption) VALUES (?, ?, NULL)').run(dropDup.id, 'shared');

  mergeIdentities(db, accountId, pnIdentity, lidIdentity, NOW, 'test-merge');

  assert.equal(count(db, 'chats'), 1, 'chats collapse to one');
  assert.equal(count(db, 'messages'), 2, 'duplicate SHARED removed, ONLY_LID kept');

  const survivingChat = (db.prepare('SELECT id FROM chats').get() as { id: number }).id;
  assert.equal(survivingChat, pnChat);
  const moved = db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(onlyLid.id) as { chat_id: number };
  assert.equal(moved.chat_id, pnChat, 'surviving message moved to the kept chat');

  // The dup's audit trail was repointed onto the survivor, not lost.
  const event = db.prepare('SELECT message_id FROM message_events').get() as { message_id: number };
  assert.equal(event.message_id, keepDup.id);

  // FTS entry for the deleted dup is gone.
  assert.equal((db.prepare('SELECT count(*) c FROM messages_fts WHERE rowid = ?').get(dropDup.id) as { c: number }).c, 0);

  const merge = db.prepare('SELECT moved_message_count, deleted_duplicate_count FROM identity_merges').get() as {
    moved_message_count: number;
    deleted_duplicate_count: number;
  };
  assert.equal(merge.deleted_duplicate_count, 1);
  assert.equal(merge.moved_message_count, 1);

  // Every message now attributes to the surviving identity.
  assert.equal(
    (db.prepare('SELECT count(*) c FROM messages WHERE sender_identity_id != ?').get(pnIdentity) as { c: number }).c,
    0,
  );
  db.close();
});

test('merge is convergent: re-linking the same pair is a no-op', () => {
  const { db, accountId } = setup();
  resolveChatId(db, accountId, ALICE_PN, NOW);
  resolveChatId(db, accountId, ALICE_LID, NOW);

  const first = linkAddresses(db, accountId, ALICE_PN, ALICE_LID, NOW, 'r1');
  const second = linkAddresses(db, accountId, ALICE_LID, ALICE_PN, NOW, 'r2');
  const third = linkAddresses(db, accountId, ALICE_PN, ALICE_LID, NOW, 'r3');

  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(count(db, 'identities'), 1);
  assert.equal(count(db, 'chats'), 1);
  assert.equal(count(db, 'identity_merges'), 1, 'only the first link performs a merge');
  db.close();
});

test('linking a JID to itself does nothing', () => {
  const { db, accountId } = setup();
  const id = linkAddresses(db, accountId, ALICE_PN, '15551230001:3@s.whatsapp.net', NOW, 'self');
  assert.equal(count(db, 'identities'), 1);
  assert.equal(count(db, 'identity_merges'), 0);
  assert.equal(resolveIdentityId(db, accountId, ALICE_PN, NOW), id);
  db.close();
});

test('group identity is distinct from its participants', () => {
  const { db, accountId } = setup();
  const groupChat = resolveChatId(db, accountId, GROUP, NOW);
  const groupIdentity = resolveIdentityId(db, accountId, GROUP, NOW);
  const aliceIdentity = resolveIdentityId(db, accountId, ALICE_PN, NOW);

  assert.notEqual(groupIdentity, aliceIdentity);
  const chat = db.prepare('SELECT chat_type, identity_id FROM chats WHERE id = ?').get(groupChat) as {
    chat_type: string;
    identity_id: number;
  };
  assert.equal(chat.chat_type, 'group');
  assert.equal(chat.identity_id, groupIdentity);
  db.close();
});

test('self identity bootstraps as a placeholder then binds the real JID', () => {
  const { db, accountId } = setup();
  const placeholder = ensureSelfIdentity(db, accountId, NOW);
  assert.equal(ensureSelfIdentity(db, accountId, NOW), placeholder, 'idempotent');

  const before = db.prepare('SELECT canonical_jid FROM identities WHERE id = ?').get(placeholder) as {
    canonical_jid: string | null;
  };
  assert.equal(before.canonical_jid, null, 'unknown until connection.update');

  const bound = bindSelfJid(db, accountId, '15559998888:3@s.whatsapp.net', NOW);
  assert.equal(bound, placeholder, 'binds into the placeholder, no second identity');

  const account = db.prepare('SELECT own_pn_jid, self_identity_id FROM accounts WHERE id = ?').get(accountId) as {
    own_pn_jid: string;
    self_identity_id: number;
  };
  assert.equal(account.own_pn_jid, '15559998888@s.whatsapp.net');
  assert.equal(account.self_identity_id, placeholder);
  db.close();
});

test('binding a self JID already seen as a counterparty merges rather than duplicates', () => {
  const { db, accountId } = setup();
  const ownJid = '15559998888@s.whatsapp.net';
  // Our own JID observed first as an ordinary participant (happens in groups).
  const strangerId = resolveIdentityId(db, accountId, ownJid, NOW);
  const placeholder = ensureSelfIdentity(db, accountId, NOW);
  assert.notEqual(strangerId, placeholder);

  const bound = bindSelfJid(db, accountId, ownJid, NOW);
  assert.equal(count(db, 'identities'), 1, 'the two collapse into one');
  assert.equal(resolveIdentityId(db, accountId, ownJid, NOW), bound);

  const account = db.prepare('SELECT self_identity_id FROM accounts WHERE id = ?').get(accountId) as {
    self_identity_id: number;
  };
  assert.equal(account.self_identity_id, bound, 'account still points at a live identity');
  db.close();
});

test('a LID self JID lands in own_lid_jid', () => {
  const { db, accountId } = setup();
  bindSelfJid(db, accountId, ALICE_LID, NOW);
  const account = db.prepare('SELECT own_lid_jid, own_pn_jid FROM accounts WHERE id = ?').get(accountId) as {
    own_lid_jid: string | null;
    own_pn_jid: string | null;
  };
  assert.equal(account.own_lid_jid, ALICE_LID);
  assert.equal(account.own_pn_jid, null);
  db.close();
});

test('display names are recorded and not clobbered by later nulls', () => {
  const { db, accountId } = setup();
  const id = resolveIdentityId(db, accountId, ALICE_PN, NOW, 'Alice');
  resolveIdentityId(db, accountId, ALICE_PN, NOW);
  const identity = db.prepare('SELECT display_name FROM identities WHERE id = ?').get(id) as {
    display_name: string;
  };
  assert.equal(identity.display_name, 'Alice');
  db.close();
});
