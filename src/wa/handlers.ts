import type { DatabaseSync } from 'node:sqlite';
import type { BaileysEventMap, WAMessage } from 'baileys';
import { ingestBatch, tombstoneMessage, tombstoneChat } from '../ingest/ingest.ts';
import { linkAddresses, bindSelfJid } from '../ingest/resolve.ts';

/**
 * Pure mapping from Baileys events to archive mutations. Deliberately decoupled
 * from the socket so it can be exercised with synthetic events and no phone --
 * every handler takes a plain payload identical to what Baileys emits.
 */
export type HandlerContext = {
  db: DatabaseSync;
  accountId: number;
  /** Injectable clock so tests are deterministic; production passes Date.now. */
  now: () => number;
};

/** History sync chunk: link any LID<->PN mappings first, then ingest as history. */
export function onHistorySet(ctx: HandlerContext, payload: BaileysEventMap['messaging-history.set']): void {
  const nowMs = ctx.now();
  for (const map of payload.lidPnMappings ?? []) {
    if (map?.pn && map?.lid) {
      linkAddresses(ctx.db, ctx.accountId, map.pn, map.lid, nowMs, 'history.lidPnMappings');
    }
  }
  if (payload.messages?.length) {
    ingestBatch(ctx.db, ctx.accountId, payload.messages, {
      sourceEventName: 'messaging-history.set',
      runKind: 'history',
      nowMs,
      syncType: payload.syncType ?? null,
      chunkOrder: payload.chunkOrder ?? null,
      isLatest: payload.isLatest,
      progress: payload.progress ?? null,
    });
  }
}

/** Live (or appended) messages. */
export function onMessagesUpsert(ctx: HandlerContext, payload: BaileysEventMap['messages.upsert']): void {
  if (!payload.messages?.length) return;
  ingestBatch(ctx.db, ctx.accountId, payload.messages, {
    // 'append' is backfill of older messages; 'notify' is genuinely live.
    sourceEventName: `messages.upsert:${payload.type}`,
    runKind: payload.type === 'notify' ? 'live' : 'backfill',
    nowMs: ctx.now(),
  });
}

/**
 * messages.update carries edits (update.message present) and status changes.
 * An edit is re-ingested as a normal content change so the version machinery
 * and the edited/updated distinction apply uniformly.
 */
export function onMessagesUpdate(ctx: HandlerContext, updates: BaileysEventMap['messages.update']): void {
  const edits: WAMessage[] = [];
  for (const { key, update } of updates) {
    if (update?.message) {
      edits.push({ key, ...update } as WAMessage);
    }
  }
  if (edits.length) {
    ingestBatch(ctx.db, ctx.accountId, edits, {
      sourceEventName: 'messages.update',
      runKind: 'live',
      nowMs: ctx.now(),
    });
  }
}

/** messages.delete: a targeted revoke ({keys}) or a whole-chat clear ({jid, all}). */
export function onMessagesDelete(ctx: HandlerContext, payload: BaileysEventMap['messages.delete']): void {
  const nowMs = ctx.now();
  if ('all' in payload) {
    tombstoneChat(ctx.db, ctx.accountId, payload.jid, { sourceEventName: 'messages.delete:all', nowMs });
    return;
  }
  for (const key of payload.keys) {
    if (!key.id || !key.remoteJid) continue;
    tombstoneMessage(
      ctx.db,
      ctx.accountId,
      { remoteJid: key.remoteJid, id: key.id, fromMe: key.fromMe ?? false },
      { sourceEventName: 'messages.delete', nowMs },
    );
  }
}

/** WhatsApp cleared/deleted a chat wholesale. */
export function onChatsDelete(ctx: HandlerContext, jids: BaileysEventMap['chats.delete']): void {
  const nowMs = ctx.now();
  for (const jid of jids) {
    tombstoneChat(ctx.db, ctx.accountId, jid, { sourceEventName: 'chats.delete', nowMs });
  }
}

/** A learned LID<->PN mapping: fold the two addresses onto one identity. */
export function onLidMapping(ctx: HandlerContext, mapping: BaileysEventMap['lid-mapping.update']): void {
  if (mapping?.pn && mapping?.lid) {
    linkAddresses(ctx.db, ctx.accountId, mapping.pn, mapping.lid, ctx.now(), 'lid-mapping.update');
  }
}

/**
 * Bind our own JID to the self identity once the socket knows it (from
 * `sock.user.id`, not from connection.update, which does not carry it). Safe to
 * call on every connection open -- bindSelfJid is idempotent.
 */
export function onOwnJid(ctx: HandlerContext, ownJid: string | null | undefined): void {
  if (ownJid) {
    bindSelfJid(ctx.db, ctx.accountId, ownJid, ctx.now());
  }
}
