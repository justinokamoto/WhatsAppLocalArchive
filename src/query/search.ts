import type { DatabaseSync } from 'node:sqlite';

/**
 * Read-only query surface. Every function here is designed to run against an
 * openReadOnlyDb() connection: pure SELECTs, no writes. This is the shape the
 * agent is meant to use, though (see docs/agent-schema.md) the read-only driver
 * flag, not these helpers, is what actually blocks writes.
 */

export type SearchHit = {
  id: number;
  chat_id: number;
  sent_at_ms: number;
  sent_at_utc: string;
  from_me: number;
  sender_identity_id: number;
  content_type_canonical: string;
  text_body: string | null;
  caption: string | null;
  snippet: string;
};

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Raw text is FTS5
 * *syntax*: a bare hyphen, apostrophe, or the word "AND" is either a parse error
 * or a silent operator. We split on whitespace and wrap each token in double
 * quotes (escaping embedded quotes as ""), producing an implicit-AND phrase
 * query that treats every token as a literal.
 */
export function ftsQuote(query: string): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Full-text search over live (non-tombstoned) messages, newest first. Tombstoned
 * messages are absent from messages_fts by construction, so they cannot appear.
 */
export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: { limit?: number; chatId?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 50;
  const match = ftsQuote(query);
  const chatFilter = opts.chatId !== undefined ? 'AND m.chat_id = ?' : '';
  const params: (string | number)[] = [match];
  if (opts.chatId !== undefined) params.push(opts.chatId);
  params.push(limit);

  return db
    .prepare(
      `SELECT m.id, m.chat_id, m.sent_at_ms,
              datetime(m.sent_at_ms / 1000, 'unixepoch') AS sent_at_utc,
              m.from_me, m.sender_identity_id, m.content_type_canonical,
              m.text_body, m.caption,
              snippet(messages_fts, -1, '[', ']', '...', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
         AND m.is_deleted = 0
         ${chatFilter}
       ORDER BY m.sent_at_ms DESC
       LIMIT ?`,
    )
    .all(...params) as SearchHit[];
}

export type ChatMessage = {
  id: number;
  wa_message_id: string;
  from_me: number;
  sender_identity_id: number;
  sent_at_ms: number;
  sent_at_utc: string;
  content_type_canonical: string;
  text_body: string | null;
  caption: string | null;
  quoted_message_db_id: number | null;
  is_forwarded: number;
  was_edited: number;
};

/**
 * A window of a chat's messages in chronological order. `beforeMs` pages
 * backwards through history; omit it for the most recent window.
 */
export function getChatWindow(
  db: DatabaseSync,
  chatId: number,
  opts: { limit?: number; beforeMs?: number } = {},
): ChatMessage[] {
  const limit = opts.limit ?? 50;
  const beforeFilter = opts.beforeMs !== undefined ? 'AND sent_at_ms < ?' : '';
  const params: number[] = [chatId];
  if (opts.beforeMs !== undefined) params.push(opts.beforeMs);
  params.push(limit);

  // Fetch newest-first for the LIMIT, then hand back oldest-first for reading.
  const rows = db
    .prepare(
      `SELECT id, wa_message_id, from_me, sender_identity_id, sent_at_ms,
              datetime(sent_at_ms / 1000, 'unixepoch') AS sent_at_utc,
              content_type_canonical, text_body, caption, quoted_message_db_id, is_forwarded,
              (edited_at_ms IS NOT NULL) AS was_edited
       FROM messages
       WHERE chat_id = ? AND is_deleted = 0
         ${beforeFilter}
       ORDER BY sent_at_ms DESC
       LIMIT ?`,
    )
    .all(...params) as ChatMessage[];
  return rows.reverse();
}

export type MessageVersion = {
  version_index: number;
  is_original: number;
  is_current: number;
  text_body: string | null;
  caption: string | null;
  content_type_canonical: string | null;
  source_event_name: string;
  observed_at_ms: number;
};

export type MessageWithVersions = {
  id: number;
  wa_message_id: string;
  chat_id: number;
  from_me: number;
  sender_identity_id: number;
  sent_at_ms: number;
  content_type_canonical: string;
  text_body: string | null;
  caption: string | null;
  is_deleted: number;
  edited_at_ms: number | null;
  versions: MessageVersion[];
};

/**
 * A single message plus its full version history (empty for never-edited
 * messages). Returns null if the id is unknown. Tombstoned rows are returned
 * with is_deleted = 1 so callers can render "this message was deleted".
 */
export function getMessageWithVersions(db: DatabaseSync, messageId: number): MessageWithVersions | null {
  const msg = db
    .prepare(
      `SELECT id, wa_message_id, chat_id, from_me, sender_identity_id, sent_at_ms,
              content_type_canonical, text_body, caption, is_deleted, edited_at_ms
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as Omit<MessageWithVersions, 'versions'> | undefined;
  if (!msg) return null;

  const versions = db
    .prepare(
      `SELECT version_index, is_original, is_current, text_body, caption,
              content_type_canonical, source_event_name, observed_at_ms
       FROM message_versions WHERE message_id = ? ORDER BY version_index`,
    )
    .all(messageId) as MessageVersion[];
  return { ...msg, versions };
}
