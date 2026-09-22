# Agent guide to the WhatsApp archive

This document is for an AI agent (or any read-only consumer) querying the local
WhatsApp archive at `data/archive.sqlite`. It describes how the data is shaped,
how to query it well, and — honestly — what the security boundary does and does
not guarantee.

## How to connect

Open the database **read-only**. In Node:

```js
import { openReadOnlyDb } from '../src/db/db.ts';
const db = openReadOnlyDb();               // DatabaseSync(path, { readOnly: true })
```

Or with the sqlite3 CLI: `sqlite3 -readonly data/archive.sqlite`.

Prefer the helpers in `src/query/search.ts` (`searchMessages`, `getChatWindow`,
`getMessageWithVersions`) — they encapsulate the correct joins, the FTS quoting,
and the tombstone filtering.

## The security boundary — what actually holds

Read this before assuming a wall exists where there isn't one.

**Enforced:**
- **No writes.** The connection is opened with `{ readOnly: true }`; the SQLite
  driver itself rejects `INSERT`/`UPDATE`/`DELETE`/`CREATE`/`DROP` and
  `PRAGMA writable_schema=ON`. This is a hard guarantee, verified in tests.
- **No credentials or key material in the database.** Baileys auth state — the
  device credentials, Signal sessions, prekeys, sender keys, and app-state sync
  keys — live only in `data/auth/`, AES-256-GCM encrypted under a passphrase,
  entirely outside this database. Nothing in `data/archive.sqlite` can decrypt
  media or impersonate the device.

**NOT enforced (do not rely on these as a wall):**
- SQLite has **no per-table or per-column grants**. A read-only connection can
  still `SELECT` from any base table, including `messages.raw_payload_json`,
  which holds the full decoded `WebMessageInfo` (media keys, direct download
  paths, and so on). The `agent_*` views are a **convenience shape, not a
  confidentiality boundary.** If a query only needs projected columns, use the
  views; but a determined reader can still reach the raw payloads.
- If stronger isolation is needed later, the intended path is a separate,
  sanitized database or a service in front of the archive — not a promise this
  file can keep.

## Layers

The archive keeps three layers deliberately separate so AI output can never
overwrite source data:

1. **Source archive** — `messages.raw_payload_json` (BufferJSON-encoded full
   payload) plus provenance columns (`source_event_name`, `baileys_version`,
   `parser_version`, `ingested_at_ms`). This is the ground truth.
2. **Queryable projection** — the normalized columns on `messages`, `chats`,
   `identities`, `message_mentions`, etc. Derived from layer 1.
3. **AI-derived artifacts** — `ai_artifacts`. Anything an agent produces
   (summaries, transcriptions, embeddings, labels) belongs here, keyed by
   `(subject_kind, subject_id, artifact_kind, producer, producer_version)`.
   Writing here requires a writable connection, which the agent does not have in
   v1 — this table exists so the capability can be added without restructuring.

## Core tables

### `messages`
One row per message, deduplicated on `UNIQUE(chat_id, wa_message_id, from_me)`.
Key columns:
- `text_body` — body text (`conversation` / `extendedTextMessage.text`).
- `caption` — media captions live here, **never** in `text_body`.
- `content_type_canonical` — the innermost content type; `'unknown'` for message
  types this version does not model (they are still archived, not dropped).
- `sender_identity_id` — resolved sender (see identities below).
- `sent_at_ms` — epoch **milliseconds** UTC. Every `*_ms` column is milliseconds.
  The lone exception is `message_timestamp_raw`, epoch **seconds** as WhatsApp
  sent it.
- `is_deleted` / `deleted_at_ms` — tombstones. Deletes are never physical; a
  deleted message keeps its row and `raw_payload_json` but is hidden from search
  and the `agent_*` views. Filter `WHERE is_deleted = 0` (the views already do).
- `edited_at_ms` — set when the message was edited; see version history below.
- `quoted_message_db_id` — FK to the quoted message's row, or NULL if the quoted
  message was never seen. `quoted_wa_message_id` is retained regardless.

### `identities` and `identity_addresses`
A person can be addressed two ways in WhatsApp v7: by phone number
(`@s.whatsapp.net`) and by LID (`@lid`). Both collapse to **one** `identities`
row; every observed JID is a row in `identity_addresses` pointing at it. Always
join through `sender_identity_id` / `mentioned_identity_id`, **not** raw JIDs, to
count a person once. `identities.canonical_jid` is a display choice and may
change; the identity rowid is the stable key.

### `chats`
One row per conversation, keyed by `identity_id`. `chat_type` is one of
`individual`, `group`, `broadcast`, `status`, `newsletter`, `unknown`. Group
messages retain both the group JID (`messages.remote_jid_raw`, `@g.us`) and the
sender (`participant_jid_raw`). For `chat_type = 'group'`, `name_snapshot`
holds the group's subject, kept current as it's renamed.

### `message_versions`
Empty for never-edited messages. On an edit, version 0 holds the original and
the highest `version_index` with `is_current = 1` holds the latest. Use
`getMessageWithVersions(db, id)`.

### `message_mentions`
`(message_id, mentioned_jid, mentioned_identity_id, ordinal)`. To find every
message mentioning a person, resolve them to an identity and filter on
`mentioned_identity_id`.

### `message_events`
Append-only audit log: `created`, `updated`, `edited`, `revoked`, etc. Never
updated or deleted.

## Views (convenience projections)

- `agent_messages` — messages with `is_deleted = 0`, plus `sent_at_utc`
  (human-readable) and `was_edited`.
- `agent_chats`, `agent_identities`, `agent_message_mentions` — projected,
  tombstone-filtered shapes for the common joins.

## Full-text search

`messages_fts` is a standalone FTS5 index over `text_body` and `caption`,
tokenized with `unicode61 remove_diacritics 2` (diacritic-insensitive — `cafe`
matches `café` — but **not** stemmed: `run` does not match `running`).
Tombstoned messages are absent from the index.

**Always quote raw user input** before using it in a `MATCH`: raw text is FTS5
syntax and a bare `-`, `*`, `"`, or the word `OR`/`AND`/`NEAR` will either error
or behave as an operator. `ftsQuote()` in `src/query/search.ts` handles this by
wrapping each whitespace-separated token as a literal phrase (implicit AND).

```js
import { searchMessages } from '../src/query/search.ts';
const hits = searchMessages(db, 'dinner reservation', { limit: 20 });
```

## Timestamps

Every `*_ms` column is epoch **milliseconds** UTC. To read as UTC text:
`datetime(sent_at_ms / 1000, 'unixepoch')`. `message_timestamp_raw` is the sole
seconds-based column, kept for source fidelity.

## Caveats

- `raw_proto_bytes` is NULL in v1. Baileys hands us decoded objects, not original
  wire bytes; `raw_payload_json` (BufferJSON-encoded) is the authoritative source
  archive. Read `*_json` columns with `BufferJSON.reviver` or Buffers will not
  revive.
- The database uses WAL. A read-only connection needs read access to the `-wal`
  and `-shm` sidecar files; a read-only connection against a WAL database on a
  read-only *filesystem* will fail to open.
- v1 models text messages (`conversation`, `extendedTextMessage`) only. Other
  types are archived with `content_type_canonical` reflecting their raw type but
  are not otherwise projected. Media, reactions, receipts, and AI artifacts are
  deferred; their tables exist but are unpopulated.
