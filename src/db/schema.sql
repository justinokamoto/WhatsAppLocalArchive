-- wad: local read-only WhatsApp archive.
--
-- Conventions:
--   * Every datetime column is INTEGER epoch MILLISECONDS UTC, suffixed _ms.
--     The sole exception is messages.message_timestamp_raw, which holds epoch
--     SECONDS exactly as WhatsApp delivered it, for source fidelity.
--   * Booleans are INTEGER 0/1 with CHECK constraints.
--   * Every *_json column is written with Baileys' BufferJSON.replacer and MUST
--     be read back with BufferJSON.reviver, or Buffers will not round-trip.
--   * Layer 1 (source archive) = messages.raw_payload_json + provenance columns.
--     Layer 2 (projection)     = the normalized columns.
--     Layer 3 (AI artifacts)   = ai_artifacts; never overwrites layers 1 or 2.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------------ accounts
CREATE TABLE IF NOT EXISTS accounts (
  id                INTEGER PRIMARY KEY,
  -- NO credentials here, ever. Auth state lives encrypted under data/auth/.
  own_pn_jid        TEXT,
  own_lid_jid       TEXT,
  self_identity_id  INTEGER REFERENCES identities(id),
  created_at_ms     INTEGER NOT NULL,
  last_sync_at_ms   INTEGER
);

-- ---------------------------------------------------------------- identities
-- One row per logical counterparty (person, group, broadcast list, newsletter).
-- The identity ROWID is the stable key. canonical_jid is a DISPLAY choice only
-- and may change as LID <-> PN mappings are learned.
CREATE TABLE IF NOT EXISTS identities (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  kind           TEXT NOT NULL CHECK (kind IN ('user','group','broadcast','newsletter','unknown')),
  display_name   TEXT,
  canonical_jid  TEXT,
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_canonical ON identities(account_id, canonical_jid);

-- Every JID ever observed for an identity. This table is what collapses the
-- LID / phone-number aliasing: both addresses point at one identity_id.
CREATE TABLE IF NOT EXISTS identity_addresses (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id),
  identity_id       INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  jid               TEXT NOT NULL,
  address_type      TEXT NOT NULL CHECK (address_type IN
                      ('phone_number','lid','group','broadcast','device','username','unknown')),
  is_current        INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  first_seen_at_ms  INTEGER NOT NULL,
  last_seen_at_ms   INTEGER NOT NULL,
  UNIQUE (account_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_identity_addresses_identity ON identity_addresses(identity_id);

-- Audit trail of identity merges, so a surprising history is explainable.
CREATE TABLE IF NOT EXISTS identity_merges (
  id                      INTEGER PRIMARY KEY,
  account_id              INTEGER NOT NULL,
  kept_identity_id        INTEGER NOT NULL,
  dropped_identity_id     INTEGER NOT NULL,
  reason                  TEXT NOT NULL,
  moved_message_count     INTEGER NOT NULL DEFAULT 0,
  deleted_duplicate_count INTEGER NOT NULL DEFAULT 0,
  merged_at_ms            INTEGER NOT NULL
);

-- --------------------------------------------------------------------- chats
-- Keyed by identity, NOT by raw JID: one conversation per counterparty even if
-- it is addressed sometimes by @lid and sometimes by @s.whatsapp.net.
CREATE TABLE IF NOT EXISTS chats (
  id                          INTEGER PRIMARY KEY,
  account_id                  INTEGER NOT NULL REFERENCES accounts(id),
  identity_id                 INTEGER NOT NULL REFERENCES identities(id),
  canonical_remote_jid        TEXT NOT NULL,
  chat_type                   TEXT NOT NULL CHECK (chat_type IN
                                ('individual','group','broadcast','status','newsletter','unknown')),
  name_snapshot               TEXT,
  last_message_at_ms          INTEGER,
  archived                    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  pinned                      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  muted_until_ms              INTEGER,
  ephemeral_duration_seconds  INTEGER,
  raw_conversation_json       TEXT,
  created_at_ms               INTEGER NOT NULL,
  updated_at_ms               INTEGER NOT NULL,
  UNIQUE (account_id, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_chats_canonical_jid ON chats(account_id, canonical_remote_jid);
CREATE INDEX IF NOT EXISTS idx_chats_last_message  ON chats(last_message_at_ms DESC);

-- ------------------------------------------------------------------ messages
CREATE TABLE IF NOT EXISTS messages (
  id                          INTEGER PRIMARY KEY,
  account_id                  INTEGER NOT NULL REFERENCES accounts(id),
  chat_id                     INTEGER NOT NULL REFERENCES chats(id),
  wa_message_id               TEXT    NOT NULL,          -- key.id
  from_me                     INTEGER NOT NULL CHECK (from_me IN (0,1)),

  -- Raw observed addressing, preserved verbatim and never canonicalized.
  remote_jid_raw              TEXT NOT NULL,             -- key.remoteJid
  remote_jid_alt              TEXT,                      -- key.remoteJidAlt
  participant_jid_raw         TEXT,                      -- key.participant
  participant_jid_alt         TEXT,                      -- key.participantAlt
  normalized_participant_jid  TEXT,                      -- debug/compat only
  addressing_mode             TEXT,                      -- key.addressingMode

  -- Resolved sender. NOT NULL: in 1:1 chats it is derived from from_me plus the
  -- chat's counterparty, so it is always knowable. Deliberately EXCLUDED from
  -- the uniqueness tuple so that learning a LID mapping later can UPDATE it
  -- without ever manufacturing a duplicate.
  sender_identity_id          INTEGER NOT NULL REFERENCES identities(id),

  message_timestamp_raw       INTEGER,                   -- epoch SECONDS, as sent
  sent_at_ms                  INTEGER NOT NULL,          -- epoch ms UTC

  content_type_raw            TEXT,                      -- innermost protobuf field name
  content_type_canonical      TEXT NOT NULL DEFAULT 'unknown',
  wrapper_types_json          TEXT NOT NULL DEFAULT '[]',-- ordered outer -> inner

  text_body                   TEXT,                      -- conversation | extendedTextMessage.text
  caption                     TEXT,                      -- media captions live here, NOT text_body
  push_name_snapshot          TEXT,
  status                      INTEGER,
  starred                     INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  broadcast                   INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0,1)),
  is_forwarded                INTEGER NOT NULL DEFAULT 0 CHECK (is_forwarded IN (0,1)),
  forwarding_score            INTEGER,

  quoted_wa_message_id        TEXT,                      -- contextInfo.stanzaId
  quoted_participant_jid      TEXT,
  quoted_remote_jid           TEXT,
  quoted_content_type         TEXT,
  quoted_text_snapshot        TEXT,
  quoted_message_db_id        INTEGER REFERENCES messages(id),

  ephemeral_duration_seconds  INTEGER,
  expires_at_ms               INTEGER,
  is_view_once                INTEGER NOT NULL DEFAULT 0 CHECK (is_view_once IN (0,1)),

  is_deleted                  INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  deleted_at_ms               INTEGER,
  edited_at_ms                INTEGER,

  -- sha256 over SEMANTIC content only (never envelope metadata). Drives the
  -- redelivery-vs-edit decision.
  content_hash                TEXT NOT NULL,

  raw_payload_json            TEXT NOT NULL,             -- full WebMessageInfo, BufferJSON-encoded
  raw_proto_bytes             BLOB,                      -- NULL in v1; see docs/agent-schema.md
  source_event_name           TEXT NOT NULL,
  baileys_version             TEXT NOT NULL,
  parser_version              INTEGER NOT NULL,
  ingested_at_ms              INTEGER NOT NULL,
  updated_at_ms               INTEGER NOT NULL,

  -- Dedup key. All three columns are NOT NULL, which matters: SQLite treats
  -- NULLs as distinct, so a nullable column in a UNIQUE index dedups NOTHING.
  UNIQUE (chat_id, wa_message_id, from_me)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time    ON messages(chat_id, sent_at_ms);
CREATE INDEX IF NOT EXISTS idx_messages_sender_time  ON messages(sender_identity_id, sent_at_ms);
CREATE INDEX IF NOT EXISTS idx_messages_quoted_db_id ON messages(quoted_message_db_id);
CREATE INDEX IF NOT EXISTS idx_messages_type         ON messages(content_type_canonical);
CREATE INDEX IF NOT EXISTS idx_messages_wa_id        ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_pending_quote
  ON messages(chat_id, quoted_wa_message_id)
  WHERE quoted_message_db_id IS NULL AND quoted_wa_message_id IS NOT NULL;

-- ---------------------------------------------------------- message_versions
-- Empty for never-edited messages. On the FIRST content divergence we backfill
-- version_index 0 from the existing row BEFORE overwriting it, so the prior
-- copy is never the only copy destroyed.
CREATE TABLE IF NOT EXISTS message_versions (
  id                      INTEGER PRIMARY KEY,
  message_id              INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version_index           INTEGER NOT NULL,
  is_original             INTEGER NOT NULL DEFAULT 0 CHECK (is_original IN (0,1)),
  is_current              INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  content_hash            TEXT NOT NULL,
  content_type_canonical  TEXT,
  wrapper_types_json      TEXT,
  text_body               TEXT,
  caption                 TEXT,
  raw_payload_json        TEXT,
  source_event_name       TEXT NOT NULL,
  observed_at_ms          INTEGER NOT NULL,
  UNIQUE (message_id, version_index)
);

-- ---------------------------------------------------------- message_mentions
CREATE TABLE IF NOT EXISTS message_mentions (
  id                    INTEGER PRIMARY KEY,
  message_id            INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mentioned_jid         TEXT NOT NULL,
  mentioned_identity_id INTEGER REFERENCES identities(id),
  ordinal               INTEGER NOT NULL,
  UNIQUE (message_id, mentioned_jid)
);
CREATE INDEX IF NOT EXISTS idx_mentions_identity ON message_mentions(mentioned_identity_id);

-- ------------------------------------------------------------ message_events
-- Append-only audit log. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS message_events (
  id                INTEGER PRIMARY KEY,
  message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL CHECK (event_type IN
                      ('created','updated','edited','revoked','reaction_added','reaction_removed',
                       'receipt','starred','unstarred','system_event')),
  event_at_ms       INTEGER NOT NULL,
  actor_identity_id INTEGER REFERENCES identities(id),
  source_event_name TEXT NOT NULL,
  detail_json       TEXT,
  created_at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_events_message ON message_events(message_id, event_at_ms);
CREATE INDEX IF NOT EXISTS idx_message_events_type    ON message_events(event_type, event_at_ms);

-- ----------------------------------------------------------------- sync_runs
CREATE TABLE IF NOT EXISTS sync_runs (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  run_kind           TEXT NOT NULL CHECK (run_kind IN ('history','live','backfill')),
  source_event_name  TEXT,
  sync_type          INTEGER,
  chunk_order        INTEGER,
  is_latest          INTEGER,
  progress           INTEGER,
  messages_seen      INTEGER NOT NULL DEFAULT 0,
  messages_inserted  INTEGER NOT NULL DEFAULT 0,
  messages_updated   INTEGER NOT NULL DEFAULT 0,
  messages_failed    INTEGER NOT NULL DEFAULT 0,
  chats_seen         INTEGER NOT NULL DEFAULT 0,
  contacts_seen      INTEGER NOT NULL DEFAULT 0,
  started_at_ms      INTEGER NOT NULL,
  finished_at_ms     INTEGER,
  notes              TEXT
);

-- ----------------------------------------------------------- ingest_failures
-- Quarantine for genuine exceptions. NO foreign keys and no CHECKs on purpose:
-- this insert happens right after a savepoint rollback and must not be able to
-- fail for the same reason the message did.
CREATE TABLE IF NOT EXISTS ingest_failures (
  id                INTEGER PRIMARY KEY,
  occurred_at_ms    INTEGER NOT NULL,
  source_event_name TEXT,
  wa_message_id     TEXT,
  remote_jid        TEXT,
  error_message     TEXT,
  error_stack       TEXT,
  raw_payload_json  TEXT
);

-- ------------------------------------------------------ full-text search
-- STANDALONE, not content='messages'. External-content FTS5 combined with
-- conditional indexing (skipping tombstoned rows) provably corrupts the index:
-- the 'delete' command requires the exact originally-indexed column values, so
-- issuing it for a rowid that was never indexed damages the b-tree
-- (SQLITE_CORRUPT, reproduced). Standalone costs one duplicated copy of the
-- text and makes DELETE-by-rowid a safe no-op, so the sync helper is
-- unconditionally idempotent.
-- unicode61 + remove_diacritics=2 over porter: porter stems English only and
-- mangles the multilingual text typical of chat archives.
-- detail defaults to 'full' so phrase and NEAR queries work.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text_body,
  caption,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- --------------------------------------------- DEFERRED in v1, created now so
-- --------------------------------------------- adding them needs no core change
CREATE TABLE IF NOT EXISTS media (
  id                INTEGER PRIMARY KEY,
  message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sha256            TEXT NOT NULL,     -- data/media/sha256/ab/cd/<sha256>
  relative_path     TEXT,
  mime_type         TEXT,
  byte_size         INTEGER,
  width             INTEGER,
  height            INTEGER,
  duration_seconds  INTEGER,
  page_count        INTEGER,
  file_name         TEXT,
  download_state    TEXT NOT NULL DEFAULT 'pending'
                      CHECK (download_state IN ('pending','downloaded','failed','skipped','expired')),
  download_error    TEXT,
  downloaded_at_ms  INTEGER,
  created_at_ms     INTEGER NOT NULL,
  UNIQUE (message_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media(sha256);

CREATE TABLE IF NOT EXISTS ai_artifacts (
  id                INTEGER PRIMARY KEY,
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN ('message','media','chat','identity')),
  subject_id        INTEGER NOT NULL,
  artifact_kind     TEXT NOT NULL,
  producer          TEXT NOT NULL,
  producer_version  TEXT,
  content_text      TEXT,
  content_json      TEXT,
  confidence        REAL,
  created_at_ms     INTEGER NOT NULL,
  UNIQUE (subject_kind, subject_id, artifact_kind, producer, producer_version)
);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_subject ON ai_artifacts(subject_kind, subject_id);

-- ---------------------------------------------------------------- agent views
-- Shape and convenience for the agent. NOT a confidentiality boundary: a
-- read-only connection can still SELECT from the base tables, because SQLite
-- has no per-table grants. The enforced guarantees are (1) no write access,
-- via DatabaseSync(path, {readOnly:true}), and (2) auth state and Signal keys
-- are not in this database at all. See docs/agent-schema.md.
CREATE VIEW IF NOT EXISTS agent_messages AS
SELECT m.id, m.chat_id, m.sent_at_ms,
       datetime(m.sent_at_ms / 1000, 'unixepoch') AS sent_at_utc,
       m.sender_identity_id, m.from_me, m.content_type_canonical,
       m.text_body, m.caption, m.quoted_message_db_id, m.is_forwarded,
       m.edited_at_ms IS NOT NULL AS was_edited
FROM messages m
WHERE m.is_deleted = 0;

CREATE VIEW IF NOT EXISTS agent_chats AS
SELECT c.id, c.chat_type, c.name_snapshot, c.identity_id,
       c.last_message_at_ms,
       datetime(c.last_message_at_ms / 1000, 'unixepoch') AS last_message_at_utc,
       c.archived, c.pinned
FROM chats c;

CREATE VIEW IF NOT EXISTS agent_identities AS
SELECT i.id, i.kind, i.display_name FROM identities i;

CREATE VIEW IF NOT EXISTS agent_message_mentions AS
SELECT mm.message_id, mm.mentioned_identity_id, mm.ordinal
FROM message_mentions mm
JOIN messages m ON m.id = mm.message_id
WHERE m.is_deleted = 0;
