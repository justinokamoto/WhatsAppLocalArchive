import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openEncryptedAuthState } from '../src/auth/keystore.ts';

const PASS = 'correct horse battery staple';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wad-keys-'));
}

test('creds and every key type round-trip through encryption', () => {
  const dir = tmpDir();
  const { state, saveCreds } = openEncryptedAuthState(PASS, dir);
  saveCreds();

  // A Buffer-bearing session and a sender key.
  const session = Buffer.from([1, 2, 3, 4, 5]);
  const senderKey = Buffer.from('sender-key-bytes');
  state.keys.set({
    session: { 'sig:1': session },
    'sender-key': { 'grp:alice': senderKey },
    'pre-key': { '1': { public: Buffer.from([9, 9]), private: Buffer.from([8, 8]) } },
  } as never);

  // Reopen: a fresh instance must read exactly what was written.
  const reopened = openEncryptedAuthState(PASS, dir);
  const got = reopened.state.keys.get('session', ['sig:1']) as Record<string, Buffer>;
  assert.ok(Buffer.isBuffer(got['sig:1']), 'session revives as a Buffer');
  assert.deepEqual(got['sig:1'], session);

  const gotSender = reopened.state.keys.get('sender-key', ['grp:alice']) as Record<string, Buffer>;
  assert.deepEqual(gotSender['grp:alice'], senderKey);

  const gotPre = reopened.state.keys.get('pre-key', ['1']) as Record<string, { public: Buffer; private: Buffer }>;
  assert.deepEqual(gotPre['1'].public, Buffer.from([9, 9]));
  assert.deepEqual(reopened.state.creds.registrationId, state.creds.registrationId);
  fs.rmSync(dir, { recursive: true });
});

test('app-state-sync-key comes back as a decoded protobuf object', () => {
  const dir = tmpDir();
  const { state } = openEncryptedAuthState(PASS, dir);
  state.keys.set({
    'app-state-sync-key': { key1: { keyData: Buffer.from([1, 2, 3]), fingerprint: { rawId: 7 }, timestamp: 123 } },
  } as never);
  const got = openEncryptedAuthState(PASS, dir).state.keys.get('app-state-sync-key', ['key1']) as Record<string, unknown>;
  // fromObject produces an instance with toJSON, not a bare literal.
  assert.ok(got['key1']);
  assert.equal(typeof (got['key1'] as { toJSON?: unknown }).toJSON, 'function');
  fs.rmSync(dir, { recursive: true });
});

test('setting a key to null deletes its file', () => {
  const dir = tmpDir();
  const ks = openEncryptedAuthState(PASS, dir);
  ks.state.keys.set({ session: { 'a:1': Buffer.from([1]) } } as never);
  assert.ok(fs.existsSync(path.join(dir, 'session-a-1.enc')));

  ks.state.keys.set({ session: { 'a:1': null } } as never);
  assert.ok(!fs.existsSync(path.join(dir, 'session-a-1.enc')));
  // get for a missing key yields an empty result, not a throw.
  assert.deepEqual(ks.state.keys.get('session', ['a:1']), {});
  fs.rmSync(dir, { recursive: true });
});

test('a wrong passphrase fails loudly on open', () => {
  const dir = tmpDir();
  openEncryptedAuthState(PASS, dir).saveCreds();
  assert.throws(() => openEncryptedAuthState('wrong passphrase', dir), /passphrase is wrong|verifier/i);
  fs.rmSync(dir, { recursive: true });
});

test('flipping a single ciphertext byte is detected by the auth tag', () => {
  const dir = tmpDir();
  const ks = openEncryptedAuthState(PASS, dir);
  ks.state.keys.set({ session: { tamper: Buffer.from('secret session') } } as never);
  const file = path.join(dir, 'session-tamper.enc');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 0x01; // flip the last ciphertext byte
  fs.writeFileSync(file, bytes);

  const reopened = openEncryptedAuthState(PASS, dir);
  assert.throws(() => reopened.state.keys.get('session', ['tamper']), /unable to authenticate|bad decrypt|malformed/i);
  fs.rmSync(dir, { recursive: true });
});

test('two writes of the same id use different IVs (no GCM nonce reuse)', () => {
  const dir = tmpDir();
  const ks = openEncryptedAuthState(PASS, dir);
  ks.state.keys.set({ session: { same: Buffer.from('identical plaintext') } } as never);
  const first = fs.readFileSync(path.join(dir, 'session-same.enc'));
  ks.state.keys.set({ session: { same: Buffer.from('identical plaintext') } } as never);
  const second = fs.readFileSync(path.join(dir, 'session-same.enc'));

  // Same plaintext, same key, but the IV (bytes 4..16) must differ, so the
  // whole record differs -- otherwise GCM security is void.
  const ivFirst = first.subarray(4, 16);
  const ivSecond = second.subarray(4, 16);
  assert.notDeepEqual(ivFirst, ivSecond);
  assert.notDeepEqual(first, second);
  fs.rmSync(dir, { recursive: true });
});

test('swapping two key files fails authentication (AAD slot binding)', () => {
  const dir = tmpDir();
  const ks = openEncryptedAuthState(PASS, dir);
  ks.state.keys.set({ session: { one: Buffer.from('first'), two: Buffer.from('second') } } as never);
  const a = path.join(dir, 'session-one.enc');
  const b = path.join(dir, 'session-two.enc');
  const tmp = fs.readFileSync(a);
  fs.writeFileSync(a, fs.readFileSync(b));
  fs.writeFileSync(b, tmp);

  const reopened = openEncryptedAuthState(PASS, dir);
  // The AAD (`session-one` vs `session-two`) no longer matches the ciphertext.
  assert.throws(() => reopened.state.keys.get('session', ['one']), /unable to authenticate|bad decrypt/i);
  fs.rmSync(dir, { recursive: true });
});

test('the encrypted files never contain the plaintext key material', () => {
  const dir = tmpDir();
  const ks = openEncryptedAuthState(PASS, dir);
  const secret = 'SUPER-SECRET-SESSION-MATERIAL';
  ks.state.keys.set({ session: { s: Buffer.from(secret) } } as never);
  const bytes = fs.readFileSync(path.join(dir, 'session-s.enc'));
  assert.equal(bytes.includes(Buffer.from(secret)), false, 'plaintext must not be present on disk');
  fs.rmSync(dir, { recursive: true });
});
