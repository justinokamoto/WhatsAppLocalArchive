import qrcodeTerminal from 'qrcode-terminal';
import { openDb, ensureAccount, ensureDataDirs } from './db/db.ts';
import { requirePassphrase } from './config.ts';
import { openEncryptedAuthState } from './auth/keystore.ts';
import { startSocket } from './wa/socket.ts';

/**
 * Entry point. Normal run: open the archive, open the encrypted keystore
 * (fail-fast if WA_ARCHIVE_PASSPHRASE is unset), bring up the socket, and let
 * events flow into the archive until SIGINT.
 *
 * `--replay-fixtures` exercises the full pipeline offline, without a socket, so
 * the whole ingest path can be smoke-tested without a phone.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--replay-fixtures')) {
    await replayFixtures();
    return;
  }

  const passphrase = requirePassphrase();
  ensureDataDirs();

  const db = openDb();
  const accountId = ensureAccount(db, Date.now());
  const auth = openEncryptedAuthState(passphrase);

  const sock = await startSocket({
    db,
    accountId,
    auth,
    onQr: (qr) => {
      console.log('\nScan this QR code with WhatsApp (Linked Devices):\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\nOr run with a pairing code by linking via phone number.\n');
    },
  });

  const shutdown = (): void => {
    console.log('\nShutting down...');
    try {
      sock.end(undefined);
    } catch {
      // socket may already be closed
    }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Archive running. Press Ctrl+C to stop.');
}

/** Offline smoke test: ingest a synthetic corpus and print the resulting counts. */
async function replayFixtures(): Promise<void> {
  const { openMemoryDb } = await import('./db/db.ts');
  const { ingestBatch } = await import('./ingest/ingest.ts');
  const { makeTextMessage, makeExtendedText, makeImageWithCaption, makeUnknownType } = await import(
    '../test/fixtures.ts'
  );

  const db = openMemoryDb();
  const accountId = ensureAccount(db, Date.now());
  const alice = '15551230001@s.whatsapp.net';
  const group = '123456789-987654@g.us';

  const messages = [
    makeTextMessage({ id: 'R1', remoteJid: alice, text: 'hello from replay' }),
    makeExtendedText({ id: 'R2', remoteJid: group, participant: alice, text: 'group message @b', mentions: [alice] }),
    makeImageWithCaption({ id: 'R3', remoteJid: alice, caption: 'a caption' }),
    makeUnknownType({ id: 'R4', remoteJid: alice }),
  ];

  const opts = { sourceEventName: 'messaging-history.set', runKind: 'history' as const, nowMs: Date.now() };
  const first = ingestBatch(db, accountId, messages, opts);
  const second = ingestBatch(db, accountId, messages, { ...opts, sourceEventName: 'messages.upsert', runKind: 'live' });

  console.log('first pass :', first);
  console.log('second pass:', second, '(should be all redelivered)');
  console.log('messages   :', (db.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c);
  console.log('events     :', (db.prepare('SELECT count(*) c FROM message_events').get() as { c: number }).c);
  db.close();
}

await main();
