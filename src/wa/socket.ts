import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} from 'baileys';
import type { WASocket, WAMessageKey, WAMessage } from 'baileys';
import type { DatabaseSync } from 'node:sqlite';
import type { Boom } from '@hapi/boom';
import { decodeJson } from '../db/db.ts';
import type { EncryptedKeystore } from '../auth/keystore.ts';
import type { HandlerContext } from './handlers.ts';
import {
  onHistorySet,
  onMessagesUpsert,
  onMessagesUpdate,
  onMessagesDelete,
  onChatsDelete,
  onLidMapping,
  onOwnJid,
} from './handlers.ts';

export type StartOptions = {
  db: DatabaseSync;
  accountId: number;
  auth: EncryptedKeystore;
  onQr?: (qr: string) => void;
};

/**
 * DB-backed getMessage for retry decryption. Baileys asks by key; we return the
 * inner proto.IMessage from the stored payload. Keyed on wa_message_id +
 * from_me only, NOT the remote JID, because the hot path may hand us either JID
 * alias for the same message.
 */
function makeGetMessage(db: DatabaseSync) {
  return async (key: WAMessageKey): Promise<proto.IMessage | undefined> => {
    if (!key.id) return undefined;
    const row = db
      .prepare('SELECT raw_payload_json FROM messages WHERE wa_message_id = ? AND from_me = ? LIMIT 1')
      .get(key.id, key.fromMe ? 1 : 0) as { raw_payload_json: string } | undefined;
    if (!row) return undefined;
    const full = decodeJson<WAMessage>(row.raw_payload_json);
    return full.message ?? undefined;
  };
}

/**
 * Bring up the WhatsApp socket, wire every event into the archive pipeline, and
 * keep it connected (reconnecting on transient failures, stopping on logout).
 * Returns the live socket.
 */
export async function startSocket(opts: StartOptions): Promise<WASocket> {
  const { db, accountId, auth } = opts;
  const ctx: HandlerContext = { db, accountId, now: () => Date.now() };

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: auth.state.creds,
      // Cache signal keys in memory; the encrypted store is the source of truth.
      keys: makeCacheableSignalKeyStore(auth.state.keys),
    },
    // Full history sync needs a non-mobile browser signature.
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    // A read-only archive should stay invisible: never present as online.
    markOnlineOnConnect: false,
    getMessage: makeGetMessage(db),
  });

  sock.ev.on('creds.update', auth.saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && opts.onQr) opts.onQr(qr);

    if (connection === 'open') {
      onOwnJid(ctx, sock.user?.id);
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      if (loggedOut) {
        console.error('Logged out by WhatsApp. Delete data/auth and re-pair to reconnect.');
      } else {
        // Transient: restartRequired, connectionClosed, timedOut, etc.
        console.warn(`Connection closed (code ${statusCode}); reconnecting...`);
        void startSocket(opts);
      }
    }
  });

  sock.ev.on('messaging-history.set', (payload) => onHistorySet(ctx, payload));
  sock.ev.on('messages.upsert', (payload) => onMessagesUpsert(ctx, payload));
  sock.ev.on('messages.update', (updates) => onMessagesUpdate(ctx, updates));
  sock.ev.on('messages.delete', (payload) => onMessagesDelete(ctx, payload));
  sock.ev.on('chats.delete', (jids) => onChatsDelete(ctx, jids));
  sock.ev.on('lid-mapping.update', (mapping) => onLidMapping(ctx, mapping));

  return sock;
}
