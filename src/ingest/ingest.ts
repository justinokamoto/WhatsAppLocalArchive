import type { DatabaseSync } from 'node:sqlite';
import type { WAMessage, WAMessageKey } from 'baileys';
import { encodeJson } from '../db/db.ts';
import { BAILEYS_VERSION, PARSER_VERSION } from '../config.ts';
import { normalizeMessage, normalizedParticipant, toEpochSeconds } from './normalize.ts';
import type { Extracted } from './normalize.ts';
import {
  resolveChatId,
  resolveIdentityId,
  ensureSelfIdentity,
  linkAddresses,
  normalizeJid,
} from './resolve.ts';

/** v7 keys can carry an alternate (LID<->PN) address for the same party. */
type IngestKey = WAMessageKey & {
  remoteJidAlt?: string | null;
  participantAlt?: string | null;
  addressingMode?: string | null;
};

export type RunKind = 'history' | 'live' | 'backfill';

export type BatchOpts = {
  sourceEventName: string;
  runKind: RunKind;
  nowMs: number;
  syncType?: number | null;
  chunkOrder?: number | null;
  isLatest?: boolean;
  progress?: number | null;
};

export type BatchResult = {
  seen: number;
  inserted: number;
  updated: number;
  redelivered: number;
  failed: number;
  runId: number;
};

type Action = 'inserted' | 'updated' | 'edited' | 'redelivered';

/** The shape read back from an existing messages row for the change decision. */
type ExistingRow = {
  id: number;
  content_hash: string;
  content_type_canonical: string;
  wrapper_types_json: string;
  text_body: string | null;
  caption: string | null;
  raw_payload_json: string;
  source_event_name: string;
  ingested_at_ms: number;
};

// ------------------------------------------------------------------ FTS sync
// The ONE writer of messages_fts. Idempotent by construction: the DELETE is a
// safe no-op when the rowid is absent, so callers never have to know whether a
// row is currently indexed. Tombstoned rows are intentionally left out.
function syncFts(
  db: DatabaseSync,
  id: number,
  textBody: string | null,
  caption: string | null,
  isDeleted: boolean,
): void {
  db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
  if (!isDeleted && (textBody || caption)) {
    db.prepare('INSERT INTO messages_fts(rowid, text_body, caption) VALUES (?, ?, ?)').run(
      id,
      textBody,
      caption,
    );
  }
}

function recordEvent(
  db: DatabaseSync,
  messageId: number,
  eventType: string,
  eventAtMs: number,
  sourceEventName: string,
  actorIdentityId: number | null,
  detail: Record<string, unknown> | null,
  nowMs: number,
): void {
  db.prepare(
    `INSERT INTO message_events(message_id, event_type, event_at_ms, actor_identity_id,
        source_event_name, detail_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    eventType,
    eventAtMs,
    actorIdentityId,
    sourceEventName,
    detail ? encodeJson(detail) : null,
    nowMs,
  );
}

// Mentions are fully re-derived on every content change: DELETE then re-insert,
// so a stale mention from a prior version cannot linger.
function syncMentions(
  db: DatabaseSync,
  accountId: number,
  messageId: number,
  mentionedJids: string[],
  nowMs: number,
): void {
  db.prepare('DELETE FROM message_mentions WHERE message_id = ?').run(messageId);
  mentionedJids.forEach((jid, ordinal) => {
    const identityId = resolveIdentityId(db, accountId, jid, nowMs);
    db.prepare(
      `INSERT OR IGNORE INTO message_mentions(message_id, mentioned_jid, mentioned_identity_id, ordinal)
       VALUES (?, ?, ?, ?)`,
    ).run(messageId, jid, identityId, ordinal);
  });
}

/**
 * Before a message's content is overwritten for the first time, snapshot the
 * pre-existing content as version 0 (the original) so the prior copy is never
 * the only copy destroyed. No-op once any version rows already exist.
 */
function backfillOriginalVersion(db: DatabaseSync, existing: ExistingRow): void {
  const have = db
    .prepare('SELECT count(*) AS c FROM message_versions WHERE message_id = ?')
    .get(existing.id) as { c: number };
  if (have.c > 0) return;
  db.prepare(
    `INSERT INTO message_versions(message_id, version_index, is_original, is_current, content_hash,
        content_type_canonical, wrapper_types_json, text_body, caption, raw_payload_json,
        source_event_name, observed_at_ms)
     VALUES (?, 0, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    existing.id,
    existing.content_hash,
    existing.content_type_canonical,
    existing.wrapper_types_json,
    existing.text_body,
    existing.caption,
    existing.raw_payload_json,
    existing.source_event_name,
    existing.ingested_at_ms,
  );
}

/** Append the newly observed content as the current version, demoting the rest. */
function appendVersion(
  db: DatabaseSync,
  messageId: number,
  e: Extracted,
  rawPayloadJson: string,
  sourceEventName: string,
  observedAtMs: number,
): void {
  const next = db
    .prepare('SELECT coalesce(max(version_index), -1) + 1 AS n FROM message_versions WHERE message_id = ?')
    .get(messageId) as { n: number };
  db.prepare('UPDATE message_versions SET is_current = 0 WHERE message_id = ?').run(messageId);
  db.prepare(
    `INSERT INTO message_versions(message_id, version_index, is_original, is_current, content_hash,
        content_type_canonical, wrapper_types_json, text_body, caption, raw_payload_json,
        source_event_name, observed_at_ms)
     VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    next.n,
    e.contentHash,
    e.contentTypeCanonical,
    encodeJson(e.wrapperTypes),
    e.textBody,
    e.caption,
    rawPayloadJson,
    sourceEventName,
    observedAtMs,
  );
}

/**
 * Ingest a single message. Runs inside a per-message SAVEPOINT so a genuine
 * fault quarantines just this one row rather than the whole batch. Returns the
 * action taken, for the batch counters.
 */
function ingestOneMessage(
  db: DatabaseSync,
  accountId: number,
  message: WAMessage,
  opts: BatchOpts,
): Action {
  const { sourceEventName, nowMs } = opts;
  const key = (message.key ?? {}) as IngestKey;

  if (!key.id || !key.remoteJid) {
    throw new Error('message key is missing id or remoteJid');
  }
  const waMessageId = key.id;
  const fromMe = key.fromMe ? 1 : 0;

  // Encoding the raw payload up front means a poison payload fails here, before
  // any row is written, and lands in quarantine rather than corrupting a row.
  const rawPayloadJson = encodeJson(message);

  // Fold LID<->PN aliases into one identity BEFORE resolving anything, so chat
  // and sender resolution see a single collapsed identity.
  if (key.remoteJidAlt) {
    linkAddresses(db, accountId, key.remoteJid, key.remoteJidAlt, nowMs, 'key.remoteJidAlt');
  }
  if (key.participant && key.participantAlt) {
    linkAddresses(db, accountId, key.participant, key.participantAlt, nowMs, 'key.participantAlt');
  }

  const rawSeconds = toEpochSeconds(message.messageTimestamp);
  // sent_at_ms is NOT NULL; when the wire gave us no timestamp we substitute the
  // ingestion time and leave message_timestamp_raw NULL so the swap is visible.
  const sentAtMs = rawSeconds !== null ? rawSeconds * 1000 : nowMs;

  const chatId = resolveChatId(db, accountId, key.remoteJid, nowMs);
  const senderId = resolveSender(db, accountId, key, chatId, nowMs);
  const e = normalizeMessage(message, sentAtMs);

  const pushName = message.pushName ?? null;
  const status =
    message.status !== undefined && message.status !== null ? Number(message.status) : null;

  const existing = db
    .prepare(
      `SELECT id, content_hash, content_type_canonical, wrapper_types_json, text_body, caption,
              raw_payload_json, source_event_name, ingested_at_ms
       FROM messages WHERE chat_id = ? AND wa_message_id = ? AND from_me = ?`,
    )
    .get(chatId, waMessageId, fromMe) as ExistingRow | undefined;

  if (!existing) {
    return insertNewMessage(db, accountId, {
      message,
      key,
      chatId,
      senderId,
      waMessageId,
      fromMe,
      rawSeconds,
      sentAtMs,
      pushName,
      status,
      rawPayloadJson,
      e,
      opts,
    });
  }

  if (existing.content_hash === e.contentHash) {
    // Pure redelivery: repair monotonically, never bump updated_at_ms, never log
    // an event -- otherwise every history/live overlap looks like a change.
    db.prepare(
      `UPDATE messages SET
         status = CASE WHEN ? IS NOT NULL THEN max(coalesce(status, 0), ?) ELSE status END,
         push_name_snapshot = coalesce(push_name_snapshot, ?),
         message_timestamp_raw = coalesce(message_timestamp_raw, ?)
       WHERE id = ?`,
    ).run(status, status, pushName, rawSeconds, existing.id);
    return 'redelivered';
  }

  // Content differs -> a real change. Preserve the prior copy, append the new
  // one, then overwrite the projection columns.
  backfillOriginalVersion(db, existing);
  appendVersion(db, existing.id, e, rawPayloadJson, sourceEventName, nowMs);

  const isEdit = e.hasExplicitEditSignal;
  db.prepare(
    `UPDATE messages SET
       content_type_raw = ?, content_type_canonical = ?, wrapper_types_json = ?,
       text_body = ?, caption = ?,
       is_forwarded = ?, forwarding_score = ?,
       quoted_wa_message_id = ?, quoted_participant_jid = ?, quoted_remote_jid = ?,
       quoted_content_type = ?, quoted_text_snapshot = ?,
       ephemeral_duration_seconds = ?, expires_at_ms = ?, is_view_once = ?,
       push_name_snapshot = coalesce(?, push_name_snapshot),
       status = CASE WHEN ? IS NOT NULL THEN max(coalesce(status, 0), ?) ELSE status END,
       content_hash = ?,
       raw_payload_json = ?, source_event_name = ?,
       edited_at_ms = CASE WHEN ? THEN ? ELSE edited_at_ms END,
       updated_at_ms = ?
     WHERE id = ?`,
  ).run(
    e.contentTypeRaw,
    e.contentTypeCanonical,
    encodeJson(e.wrapperTypes),
    e.textBody,
    e.caption,
    e.isForwarded ? 1 : 0,
    e.forwardingScore,
    e.quotedWaMessageId,
    e.quotedParticipantJid,
    e.quotedRemoteJid,
    e.quotedContentType,
    e.quotedTextSnapshot,
    e.ephemeralDurationSeconds,
    e.expiresAtMs,
    e.isViewOnce ? 1 : 0,
    pushName,
    status,
    status,
    e.contentHash,
    rawPayloadJson,
    sourceEventName,
    isEdit ? 1 : 0,
    nowMs,
    nowMs,
    existing.id,
  );

  syncMentions(db, accountId, existing.id, e.mentionedJids, nowMs);
  syncFts(db, existing.id, e.textBody, e.caption, false);
  recordEvent(db, existing.id, isEdit ? 'edited' : 'updated', nowMs, sourceEventName, senderId, null, nowMs);
  touchChat(db, chatId, sentAtMs, nowMs);
  return isEdit ? 'edited' : 'updated';
}

type InsertArgs = {
  message: WAMessage;
  key: IngestKey;
  chatId: number;
  senderId: number;
  waMessageId: string;
  fromMe: number;
  rawSeconds: number | null;
  sentAtMs: number;
  pushName: string | null;
  status: number | null;
  rawPayloadJson: string;
  e: Extracted;
  opts: BatchOpts;
};

function insertNewMessage(db: DatabaseSync, accountId: number, a: InsertArgs): Action {
  const { key, e, opts } = a;
  // History sync can hand us an already-edited message as the very first sighting.
  const firstSeenEdited = e.wrapperTypes.includes('editedMessage') || e.hasExplicitEditSignal;

  const row = db
    .prepare(
      `INSERT INTO messages(
        account_id, chat_id, wa_message_id, from_me,
        remote_jid_raw, remote_jid_alt, participant_jid_raw, participant_jid_alt,
        normalized_participant_jid, addressing_mode,
        sender_identity_id, message_timestamp_raw, sent_at_ms,
        content_type_raw, content_type_canonical, wrapper_types_json,
        text_body, caption, push_name_snapshot, status, starred, broadcast,
        is_forwarded, forwarding_score,
        quoted_wa_message_id, quoted_participant_jid, quoted_remote_jid,
        quoted_content_type, quoted_text_snapshot,
        ephemeral_duration_seconds, expires_at_ms, is_view_once,
        edited_at_ms, content_hash,
        raw_payload_json, source_event_name, baileys_version, parser_version,
        ingested_at_ms, updated_at_ms
      ) VALUES (?,?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?, ?,?, ?,?,?, ?,?, ?,?,?,?, ?,?)
      RETURNING id`,
    )
    .get(
      accountId,
      a.chatId,
      a.waMessageId,
      a.fromMe,
      key.remoteJid,
      key.remoteJidAlt ?? null,
      key.participant ?? null,
      key.participantAlt ?? null,
      normalizedParticipant(key),
      key.addressingMode ?? null,
      a.senderId,
      a.rawSeconds,
      a.sentAtMs,
      e.contentTypeRaw,
      e.contentTypeCanonical,
      encodeJson(e.wrapperTypes),
      e.textBody,
      e.caption,
      a.pushName,
      a.status,
      a.message.starred ? 1 : 0,
      a.message.broadcast ? 1 : 0,
      e.isForwarded ? 1 : 0,
      e.forwardingScore,
      e.quotedWaMessageId,
      e.quotedParticipantJid,
      e.quotedRemoteJid,
      e.quotedContentType,
      e.quotedTextSnapshot,
      e.ephemeralDurationSeconds,
      e.expiresAtMs,
      e.isViewOnce ? 1 : 0,
      firstSeenEdited ? a.sentAtMs : null,
      e.contentHash,
      a.rawPayloadJson,
      opts.sourceEventName,
      BAILEYS_VERSION,
      PARSER_VERSION,
      opts.nowMs,
      opts.nowMs,
    ) as { id: number };

  const id = row.id;
  syncMentions(db, accountId, id, e.mentionedJids, opts.nowMs);
  syncFts(db, id, e.textBody, e.caption, false);

  if (firstSeenEdited) {
    // No original was ever seen, so version 0 IS the current (edited) content.
    db.prepare(
      `INSERT INTO message_versions(message_id, version_index, is_original, is_current, content_hash,
          content_type_canonical, wrapper_types_json, text_body, caption, raw_payload_json,
          source_event_name, observed_at_ms)
       VALUES (?, 0, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      e.contentHash,
      e.contentTypeCanonical,
      encodeJson(e.wrapperTypes),
      e.textBody,
      e.caption,
      a.rawPayloadJson,
      opts.sourceEventName,
      opts.nowMs,
    );
    recordEvent(db, id, 'edited', opts.nowMs, opts.sourceEventName, a.senderId, { first_seen_already_edited: true }, opts.nowMs);
  } else {
    recordEvent(db, id, 'created', opts.nowMs, opts.sourceEventName, a.senderId, null, opts.nowMs);
  }

  touchChat(db, a.chatId, a.sentAtMs, opts.nowMs);
  return 'inserted';
}

/**
 * Resolve the sender identity. from_me wins first (own group messages carry a
 * participant that is us); then an explicit participant (group / status); then
 * the 1:1 chat's counterparty.
 */
function resolveSender(
  db: DatabaseSync,
  accountId: number,
  key: IngestKey,
  chatId: number,
  nowMs: number,
): number {
  if (key.fromMe) return ensureSelfIdentity(db, accountId, nowMs);
  if (key.participant) return resolveIdentityId(db, accountId, key.participant, nowMs);
  const chat = db.prepare('SELECT identity_id FROM chats WHERE id = ?').get(chatId) as {
    identity_id: number;
  };
  return chat.identity_id;
}

function touchChat(db: DatabaseSync, chatId: number, sentAtMs: number, nowMs: number): void {
  db.prepare(
    `UPDATE chats SET last_message_at_ms = max(coalesce(last_message_at_ms, 0), ?), updated_at_ms = ?
     WHERE id = ?`,
  ).run(sentAtMs, nowMs, chatId);
}

/**
 * Resolve quotes whose target had not yet been ingested when the quoting
 * message arrived. Cheap: the partial index idx_messages_pending_quote covers
 * exactly the unresolved rows.
 */
export function resolvePendingQuotes(db: DatabaseSync, accountId: number): number {
  const pending = db
    .prepare(
      `SELECT id, chat_id, quoted_wa_message_id FROM messages
       WHERE account_id = ? AND quoted_message_db_id IS NULL AND quoted_wa_message_id IS NOT NULL`,
    )
    .all(accountId) as { id: number; chat_id: number; quoted_wa_message_id: string }[];

  let resolved = 0;
  for (const p of pending) {
    const target = db
      .prepare(
        'SELECT id FROM messages WHERE chat_id = ? AND wa_message_id = ? AND id != ? LIMIT 1',
      )
      .get(p.chat_id, p.quoted_wa_message_id, p.id) as { id: number } | undefined;
    if (target) {
      db.prepare('UPDATE messages SET quoted_message_db_id = ? WHERE id = ?').run(target.id, p.id);
      resolved += 1;
    }
  }
  return resolved;
}

function quarantine(
  db: DatabaseSync,
  message: WAMessage,
  sourceEventName: string,
  err: unknown,
  nowMs: number,
): void {
  let waId: string | null = null;
  let remoteJid: string | null = null;
  let rawPayload: string | null = null;
  try {
    waId = message?.key?.id ?? null;
    remoteJid = message?.key?.remoteJid ?? null;
  } catch {
    // key access failed too; leave nulls.
  }
  try {
    rawPayload = encodeJson(message);
  } catch {
    // A poison payload cannot be encoded; the error text still records why.
  }
  const error = err as { message?: string; stack?: string };
  db.prepare(
    `INSERT INTO ingest_failures(occurred_at_ms, source_event_name, wa_message_id, remote_jid,
        error_message, error_stack, raw_payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(nowMs, sourceEventName, waId, remoteJid, error?.message ?? String(err), error?.stack ?? null, rawPayload);
}

function createSyncRun(db: DatabaseSync, accountId: number, opts: BatchOpts): number {
  const row = db
    .prepare(
      `INSERT INTO sync_runs(account_id, run_kind, source_event_name, sync_type, chunk_order,
          is_latest, progress, started_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      accountId,
      opts.runKind,
      opts.sourceEventName,
      opts.syncType ?? null,
      opts.chunkOrder ?? null,
      opts.isLatest === undefined ? null : opts.isLatest ? 1 : 0,
      opts.progress ?? null,
      opts.nowMs,
    ) as { id: number };
  return row.id;
}

/**
 * Ingest a batch of messages in a single transaction, isolating each message in
 * its own savepoint. Shared verbatim by history sync and live upserts -- the
 * only difference is source_event_name and run_kind.
 */
export function ingestBatch(
  db: DatabaseSync,
  accountId: number,
  messages: WAMessage[],
  opts: BatchOpts,
): BatchResult {
  let inserted = 0;
  let updated = 0;
  let redelivered = 0;
  let failed = 0;
  let runId = 0;

  db.exec('BEGIN');
  try {
    runId = createSyncRun(db, accountId, opts);
    for (const message of messages) {
      db.exec('SAVEPOINT msg');
      try {
        const action = ingestOneMessage(db, accountId, message, opts);
        db.exec('RELEASE msg');
        if (action === 'inserted') inserted += 1;
        else if (action === 'redelivered') redelivered += 1;
        else updated += 1;
      } catch (err) {
        db.exec('ROLLBACK TO msg');
        db.exec('RELEASE msg');
        quarantine(db, message, opts.sourceEventName, err, opts.nowMs);
        failed += 1;
      }
    }

    resolvePendingQuotes(db, accountId);
    db.prepare('UPDATE accounts SET last_sync_at_ms = ? WHERE id = ?').run(opts.nowMs, accountId);
    db.prepare(
      `UPDATE sync_runs SET messages_seen = ?, messages_inserted = ?, messages_updated = ?,
          messages_failed = ?, finished_at_ms = ?
       WHERE id = ?`,
    ).run(messages.length, inserted, updated, failed, opts.nowMs, runId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { seen: messages.length, inserted, updated, redelivered, failed, runId };
}

// ------------------------------------------------------------------ tombstones
// Deletes are never physical. A revoke sets is_deleted / deleted_at_ms and drops
// the row from FTS + the agent views, but raw_payload_json is preserved intact.

export type TombstoneResult = 'tombstoned' | 'already' | 'not_found';

export function tombstoneMessage(
  db: DatabaseSync,
  accountId: number,
  target: { remoteJid: string; id: string; fromMe?: boolean },
  opts: { sourceEventName: string; nowMs: number },
): TombstoneResult {
  const chatId = findChatId(db, accountId, target.remoteJid);
  if (chatId === null) return 'not_found';
  const fromMe = target.fromMe ? 1 : 0;
  const row = db
    .prepare(
      'SELECT id, is_deleted FROM messages WHERE chat_id = ? AND wa_message_id = ? AND from_me = ?',
    )
    .get(chatId, target.id, fromMe) as { id: number; is_deleted: number } | undefined;
  // A revoke for a never-seen message is deliberately dropped: it carries no
  // content and synthesizing a row would violate NOT NULL on sent_at_ms.
  if (!row) return 'not_found';
  if (row.is_deleted) return 'already';

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE messages SET is_deleted = 1, deleted_at_ms = ?, updated_at_ms = ? WHERE id = ?').run(
      opts.nowMs,
      opts.nowMs,
      row.id,
    );
    syncFts(db, row.id, null, null, true);
    recordEvent(db, row.id, 'revoked', opts.nowMs, opts.sourceEventName, null, null, opts.nowMs);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return 'tombstoned';
}

/** Tombstone every message in a chat (WhatsApp "clear chat" / delete-for-me). */
export function tombstoneChat(
  db: DatabaseSync,
  accountId: number,
  remoteJid: string,
  opts: { sourceEventName: string; nowMs: number },
): number {
  const chatId = findChatId(db, accountId, remoteJid);
  if (chatId === null) return 0;

  db.exec('BEGIN');
  try {
    const live = db
      .prepare('SELECT id FROM messages WHERE chat_id = ? AND is_deleted = 0')
      .all(chatId) as { id: number }[];
    for (const { id } of live) {
      db.prepare('UPDATE messages SET is_deleted = 1, deleted_at_ms = ?, updated_at_ms = ? WHERE id = ?').run(
        opts.nowMs,
        opts.nowMs,
        id,
      );
      syncFts(db, id, null, null, true);
      recordEvent(db, id, 'revoked', opts.nowMs, opts.sourceEventName, null, { chat_cleared: true }, opts.nowMs);
    }
    db.exec('COMMIT');
    return live.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Chat id for an already-known remote JID, without creating one. */
function findChatId(db: DatabaseSync, accountId: number, remoteJid: string): number | null {
  const normalized = normalizeJid(remoteJid);
  const address = db
    .prepare('SELECT identity_id FROM identity_addresses WHERE account_id = ? AND jid = ?')
    .get(accountId, normalized) as { identity_id: number } | undefined;
  if (!address) return null;
  const chat = db
    .prepare('SELECT id FROM chats WHERE account_id = ? AND identity_id = ?')
    .get(accountId, address.identity_id) as { id: number } | undefined;
  return chat?.id ?? null;
}
