import { jidNormalizedUser, jidDecode, isJidGroup, isJidNewsletter, isJidStatusBroadcast, isJidBroadcast, isLidUser } from 'baileys';
import type { DatabaseSync } from 'node:sqlite';

export type AddressType =
  | 'phone_number' | 'lid' | 'group' | 'broadcast' | 'device' | 'username' | 'unknown';
export type IdentityKind = 'user' | 'group' | 'broadcast' | 'newsletter' | 'unknown';
export type ChatType = 'individual' | 'group' | 'broadcast' | 'status' | 'newsletter' | 'unknown';

/**
 * Canonical form of a JID for identity lookup. jidNormalizedUser strips the
 * device suffix (`user:5@lid` -> `user@lid`) and folds c.us into s.whatsapp.net,
 * which matters because Baileys' LID mappings are device-specific.
 */
export function normalizeJid(jid: string): string {
  return jidNormalizedUser(jid) ?? jid;
}

/** Maps a JID onto one of the schema's allowed address_type values. */
export function addressTypeOf(jid: string): AddressType {
  if (isJidGroup(jid)) return 'group';
  if (isJidBroadcast(jid)) return 'broadcast';
  if (isLidUser(jid)) return 'lid';
  const server = jidDecode(jid)?.server;
  if (server === 's.whatsapp.net' || server === 'c.us' || server === 'hosted') return 'phone_number';
  // Newsletters have no dedicated address_type in the schema.
  return 'unknown';
}

export function identityKindOf(jid: string): IdentityKind {
  if (isJidGroup(jid)) return 'group';
  if (isJidNewsletter(jid)) return 'newsletter';
  if (isJidBroadcast(jid)) return 'broadcast';
  const server = jidDecode(jid)?.server;
  if (server === 'lid' || server === 's.whatsapp.net' || server === 'c.us' || server === 'hosted' || server === 'hosted.lid') {
    return 'user';
  }
  return 'unknown';
}

export function chatTypeOf(jid: string): ChatType {
  if (isJidStatusBroadcast(jid)) return 'status';
  if (isJidGroup(jid)) return 'group';
  if (isJidNewsletter(jid)) return 'newsletter';
  if (isJidBroadcast(jid)) return 'broadcast';
  if (identityKindOf(jid) === 'user') return 'individual';
  return 'unknown';
}

/**
 * Find or create the identity owning `jid`. All LID/phone aliasing is collapsed
 * here, via identity_addresses, so it never leaks into the message dedup key.
 */
export function resolveIdentityId(
  db: DatabaseSync,
  accountId: number,
  jid: string,
  nowMs: number,
  displayName?: string | null,
): number {
  const normalized = normalizeJid(jid);

  const existing = db
    .prepare('SELECT identity_id FROM identity_addresses WHERE account_id = ? AND jid = ?')
    .get(accountId, normalized) as { identity_id: number } | undefined;

  if (existing) {
    db.prepare('UPDATE identity_addresses SET last_seen_at_ms = ? WHERE account_id = ? AND jid = ?')
      .run(nowMs, accountId, normalized);
    if (displayName) {
      db.prepare(
        'UPDATE identities SET display_name = ?, updated_at_ms = ? WHERE id = ? AND (display_name IS NULL OR display_name = ?)',
      ).run(displayName, nowMs, existing.identity_id, displayName);
    }
    return existing.identity_id;
  }

  const identity = db
    .prepare(
      `INSERT INTO identities(account_id, kind, display_name, canonical_jid, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(accountId, identityKindOf(normalized), displayName ?? null, normalized, nowMs, nowMs) as {
    id: number;
  };

  db.prepare(
    `INSERT INTO identity_addresses(account_id, identity_id, jid, address_type, is_current, first_seen_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(accountId, identity.id, normalized, addressTypeOf(normalized), nowMs, nowMs);

  return identity.id;
}

/** Attach an additional observed JID to an existing identity. */
export function addAddress(
  db: DatabaseSync,
  accountId: number,
  identityId: number,
  jid: string,
  nowMs: number,
): void {
  const normalized = normalizeJid(jid);
  db.prepare(
    `INSERT INTO identity_addresses(account_id, identity_id, jid, address_type, is_current, first_seen_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(account_id, jid) DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms`,
  ).run(accountId, identityId, normalized, addressTypeOf(normalized), nowMs, nowMs);
}

/** Find or create the chat for a remote JID, keyed by resolved identity. */
export function resolveChatId(
  db: DatabaseSync,
  accountId: number,
  remoteJid: string,
  nowMs: number,
  nameSnapshot?: string | null,
): number {
  const normalized = normalizeJid(remoteJid);
  const identityId = resolveIdentityId(db, accountId, normalized, nowMs);

  const existing = db
    .prepare('SELECT id FROM chats WHERE account_id = ? AND identity_id = ?')
    .get(accountId, identityId) as { id: number } | undefined;

  if (existing) {
    if (nameSnapshot) {
      db.prepare('UPDATE chats SET name_snapshot = ?, updated_at_ms = ? WHERE id = ?')
        .run(nameSnapshot, nowMs, existing.id);
    }
    return existing.id;
  }

  const chat = db
    .prepare(
      `INSERT INTO chats(account_id, identity_id, canonical_remote_jid, chat_type, name_snapshot, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(accountId, identityId, normalized, chatTypeOf(normalized), nameSnapshot ?? null, nowMs, nowMs) as {
    id: number;
  };
  return chat.id;
}

/**
 * Record that two JIDs are the same person, merging their identities if they
 * were previously believed distinct. Called for lid-mapping.update, history
 * sync's lidPnMappings, and any message key carrying remoteJidAlt/participantAlt.
 */
export function linkAddresses(
  db: DatabaseSync,
  accountId: number,
  jidA: string,
  jidB: string,
  nowMs: number,
  reason: string,
): number {
  const a = normalizeJid(jidA);
  const b = normalizeJid(jidB);
  if (a === b) return resolveIdentityId(db, accountId, a, nowMs);

  const idA = resolveIdentityId(db, accountId, a, nowMs);
  const idB = resolveIdentityId(db, accountId, b, nowMs);
  if (idA === idB) return idA;

  return mergeIdentities(db, accountId, idA, idB, nowMs, reason);
}

/**
 * Collapse two identities into one. The lowest rowid survives, which makes the
 * operation deterministic and convergent under repeated application.
 *
 * sender_identity_id is NOT part of the messages dedup key, so repointing it
 * can never raise a uniqueness conflict -- that is the property that makes this
 * safe to run after messages have already been imported.
 */
export function mergeIdentities(
  db: DatabaseSync,
  accountId: number,
  identityA: number,
  identityB: number,
  nowMs: number,
  reason: string,
): number {
  const keepId = Math.min(identityA, identityB);
  const dropId = Math.max(identityA, identityB);
  if (keepId === dropId) return keepId;

  db.prepare('UPDATE identity_addresses SET identity_id = ? WHERE identity_id = ?').run(keepId, dropId);

  const chatKeep = db
    .prepare('SELECT id FROM chats WHERE account_id = ? AND identity_id = ?')
    .get(accountId, keepId) as { id: number } | undefined;
  const chatDrop = db
    .prepare('SELECT id FROM chats WHERE account_id = ? AND identity_id = ?')
    .get(accountId, dropId) as { id: number } | undefined;

  let movedMessages = 0;
  let deletedDuplicates = 0;

  if (chatDrop && !chatKeep) {
    db.prepare('UPDATE chats SET identity_id = ?, updated_at_ms = ? WHERE id = ?')
      .run(keepId, nowMs, chatDrop.id);
  } else if (chatDrop && chatKeep) {
    // Collapse messages present in BOTH chats onto the surviving row.
    const duplicates = db
      .prepare(
        `SELECT d.id AS dup_id, k.id AS keep_id
         FROM messages d
         JOIN messages k
           ON k.chat_id = ? AND k.wa_message_id = d.wa_message_id AND k.from_me = d.from_me
         WHERE d.chat_id = ?`,
      )
      .all(chatKeep.id, chatDrop.id) as { dup_id: number; keep_id: number }[];

    for (const { dup_id, keep_id } of duplicates) {
      db.prepare('UPDATE message_versions SET message_id = ? WHERE message_id = ?').run(keep_id, dup_id);
      db.prepare('UPDATE message_events SET message_id = ? WHERE message_id = ?').run(keep_id, dup_id);
      db.prepare('UPDATE OR IGNORE message_mentions SET message_id = ? WHERE message_id = ?').run(keep_id, dup_id);
      db.prepare('DELETE FROM message_mentions WHERE message_id = ?').run(dup_id);
      db.prepare('UPDATE messages SET quoted_message_db_id = ? WHERE quoted_message_db_id = ?').run(keep_id, dup_id);
      db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(dup_id);
      db.prepare('DELETE FROM messages WHERE id = ?').run(dup_id);
      deletedDuplicates += 1;
    }

    const moved = db
      .prepare('UPDATE messages SET chat_id = ?, updated_at_ms = ? WHERE chat_id = ?')
      .run(chatKeep.id, nowMs, chatDrop.id);
    movedMessages = Number(moved.changes);

    // Fold chat metadata onto the survivor, preferring present/most-recent values.
    db.prepare(
      `UPDATE chats SET
         last_message_at_ms = max(coalesce(last_message_at_ms, 0), coalesce((SELECT last_message_at_ms FROM chats WHERE id = ?), 0)),
         name_snapshot = coalesce(name_snapshot, (SELECT name_snapshot FROM chats WHERE id = ?)),
         ephemeral_duration_seconds = coalesce(ephemeral_duration_seconds, (SELECT ephemeral_duration_seconds FROM chats WHERE id = ?)),
         updated_at_ms = ?
       WHERE id = ?`,
    ).run(chatDrop.id, chatDrop.id, chatDrop.id, nowMs, chatKeep.id);

    db.prepare('DELETE FROM chats WHERE id = ?').run(chatDrop.id);
  }

  // Cannot conflict: sender_identity_id is deliberately outside the dedup key.
  db.prepare('UPDATE messages SET sender_identity_id = ? WHERE sender_identity_id = ?').run(keepId, dropId);
  db.prepare('UPDATE message_mentions SET mentioned_identity_id = ? WHERE mentioned_identity_id = ?').run(keepId, dropId);
  db.prepare('UPDATE accounts SET self_identity_id = ? WHERE self_identity_id = ?').run(keepId, dropId);
  db.prepare('UPDATE message_events SET actor_identity_id = ? WHERE actor_identity_id = ?').run(keepId, dropId);

  // Prefer a phone-number JID as the display choice: it is human-meaningful.
  // The identity key is always the rowid, never this.
  db.prepare(
    `UPDATE identities SET
       canonical_jid = (SELECT jid FROM identity_addresses WHERE identity_id = ?
                        ORDER BY (address_type = 'phone_number') DESC, is_current DESC, id ASC LIMIT 1),
       display_name = coalesce(display_name, (SELECT display_name FROM identities WHERE id = ?)),
       updated_at_ms = ?
     WHERE id = ?`,
  ).run(keepId, dropId, nowMs, keepId);

  db.prepare(
    `INSERT INTO identity_merges(account_id, kept_identity_id, dropped_identity_id, reason,
        moved_message_count, deleted_duplicate_count, merged_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(accountId, keepId, dropId, reason, movedMessages, deletedDuplicates, nowMs);

  db.prepare('DELETE FROM identities WHERE id = ?').run(dropId);

  // Keep the surviving chat's canonical JID aligned with the identity's choice.
  db.prepare(
    `UPDATE chats SET canonical_remote_jid = coalesce(
         (SELECT canonical_jid FROM identities WHERE id = ?), canonical_remote_jid)
     WHERE account_id = ? AND identity_id = ?`,
  ).run(keepId, accountId, keepId);

  return keepId;
}

/** Ensure the account has a self identity, creating a placeholder if needed. */
export function ensureSelfIdentity(db: DatabaseSync, accountId: number, nowMs: number): number {
  const account = db
    .prepare('SELECT self_identity_id FROM accounts WHERE id = ?')
    .get(accountId) as { self_identity_id: number | null } | undefined;
  if (account?.self_identity_id) return account.self_identity_id;

  const identity = db
    .prepare(
      `INSERT INTO identities(account_id, kind, display_name, canonical_jid, created_at_ms, updated_at_ms)
       VALUES (?, 'user', 'me', NULL, ?, ?) RETURNING id`,
    )
    .get(accountId, nowMs, nowMs) as { id: number };
  db.prepare('UPDATE accounts SET self_identity_id = ? WHERE id = ?').run(identity.id, accountId);
  return identity.id;
}

/**
 * Bind our own JID to the self identity once connection.update reveals it,
 * reusing the merge machinery rather than special-casing the bootstrap.
 */
export function bindSelfJid(
  db: DatabaseSync,
  accountId: number,
  ownJid: string,
  nowMs: number,
): number {
  const selfId = ensureSelfIdentity(db, accountId, nowMs);
  const normalized = normalizeJid(ownJid);

  const existing = db
    .prepare('SELECT identity_id FROM identity_addresses WHERE account_id = ? AND jid = ?')
    .get(accountId, normalized) as { identity_id: number } | undefined;

  const merged = existing && existing.identity_id !== selfId
    ? mergeIdentities(db, accountId, selfId, existing.identity_id, nowMs, 'self-jid-bootstrap')
    : selfId;

  addAddress(db, accountId, merged, normalized, nowMs);
  db.prepare('UPDATE identities SET canonical_jid = coalesce(canonical_jid, ?), updated_at_ms = ? WHERE id = ?')
    .run(normalized, nowMs, merged);

  const column = isLidUser(normalized) ? 'own_lid_jid' : 'own_pn_jid';
  db.prepare(`UPDATE accounts SET ${column} = ?, self_identity_id = ? WHERE id = ?`)
    .run(normalized, merged, accountId);
  return merged;
}
