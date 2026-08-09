# wala — WhatsApp Local Archive

Local, read-only WhatsApp archive built on Baileys. Ingests history + live
messages into SQLite. v1 is text-only; other types are archived raw, not projected.

## Commands

- `npm test` — the whole suite (`node:test`, 103 tests, all offline).
- `npm run replay` — drive synthetic fixtures through the full pipeline, no phone.
- `npm start` — live socket. Requires `WA_ARCHIVE_PASSPHRASE` (fail-fast if unset) and a phone to pair.

## Runtime constraints

- **Node 26 runs `.ts` natively via type-stripping — no build step.** So: no `enum`, no `namespace`, no decorators, no parameter properties. Use `import type` for type-only imports. Imports at top of file only.
- Sole runtime dependency is `baileys`. Tests use `node:test` + `node:assert/strict`. No tsc, no test framework, no ORM.

## Gotchas (already paid for — don't rediscover)

- `node:sqlite` rows have a **null prototype**. Spread (`{ ...row }`) before `assert.deepEqual`, or it fails on otherwise-equal rows.
- Every `*_json` column must be written with `encodeJson` and read with `decodeJson` (BufferJSON) — plain `JSON.stringify` won't revive Buffers, and Baileys decryption then breaks.
- Datetimes are epoch **milliseconds**, suffixed `_ms`. Sole exception: `messages.message_timestamp_raw` is epoch **seconds** (source fidelity).
- Message dedup key is `UNIQUE(chat_id, wa_message_id, from_me)`. `sender_identity_id` is deliberately *outside* it, so learning a LID↔PN mapping later is a safe `UPDATE`.
- `messages_fts` is a **standalone** FTS5 table synced by app code (the single `syncFts` writer in `ingest.ts`), not external-content. Tombstoned rows are absent from it.
- Deletes are tombstones (`is_deleted`), never physical. Edits keep version history in `message_versions`.

## Architecture

- `src/db/` — `schema.sql` (full DDL, documents its own conventions), `db.ts` (open helpers, `encodeJson`/`decodeJson`, `ensureAccount`).
- `src/ingest/normalize.ts` — pure: unwrapping, content typing, content hash. No DB, no deps.
- `src/ingest/resolve.ts` — identity/chat resolution and LID↔PN merge (lowest rowid wins).
- `src/ingest/ingest.ts` — the batch pipeline (savepoints, versions, events, FTS, quotes, quarantine). **Correctness core.**
- `src/query/search.ts` — read-only query surface (`searchMessages`, `getChatWindow`, `ftsQuote`).
- `src/auth/keystore.ts` — AES-256-GCM encrypted Baileys auth state, outside the DB.
- `src/wa/` — Baileys seam. `handlers.ts` maps events → pipeline calls and is fully testable offline; `socket.ts` needs a phone.

## Workflow

Add a fixture in `test/fixtures.ts`, drive it through `ingestBatch` (or a `handlers.ts`
function), assert against the DB. Everything except the live socket is testable with no
phone. Security boundary and schema for consumers: `docs/agent-schema.md`.
