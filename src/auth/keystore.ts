import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { initAuthCreds, BufferJSON, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, SignalDataSet } from 'baileys';
import { AUTH_DIR } from '../config.ts';

/**
 * Encrypted Baileys auth keystore. AES-256-GCM with a key derived from
 * WA_ARCHIVE_PASSPHRASE via scrypt. No plaintext fallback -- the entire point is
 * that credentials, Signal sessions, prekeys, sender keys and app-state sync
 * keys never touch disk in the clear, and are never in the SQLite archive at all.
 *
 * Per-key files (not one blob): Signal key writes are frequent and on the hot
 * path, and rewriting a single growing blob would make every set() O(total
 * keys). Crypto is microseconds; fs dominates, so one small file per key wins.
 *
 * Record layout:  magic "WAK1" | iv(12) | authTag(16) | ciphertext
 * A fresh random IV per write (GCM nonce reuse under a fixed key is
 * catastrophic, and rewrites of the same id are common), and AAD binds every
 * record to its slot (`${type}/${id}`) so swapping two files fails auth.
 */

const MAGIC = Buffer.from('WAK1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = Buffer.from('wad-auth-keystore-v1', 'utf8'); // fixed: the file dir is the secret boundary, the passphrase is the secret
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 };

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, 32, SCRYPT_PARAMS);
}

function encryptRecord(key: Buffer, aad: string, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decryptRecord(key: Buffer, aad: string, record: Buffer): Buffer {
  if (record.length < MAGIC.length + IV_LEN + TAG_LEN || !record.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('auth keystore record is malformed or not a WAK1 file');
  }
  let offset = MAGIC.length;
  const iv = record.subarray(offset, (offset += IV_LEN));
  const tag = record.subarray(offset, (offset += TAG_LEN));
  const ciphertext = record.subarray(offset);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Mirror Baileys' own sanitization: '/' and ':' are illegal in slot ids. */
function slotFileName(slot: string): string {
  return `${slot.replace(/\//g, '__').replace(/:/g, '-')}.enc`;
}

export type EncryptedKeystore = {
  state: AuthenticationState;
  saveCreds: () => void;
};

/**
 * Open (or initialize) the encrypted auth state under AUTH_DIR. A verifier file
 * is written on first run and checked on every subsequent open, turning a wrong
 * passphrase into one clear error rather than a cascade of GCM failures after
 * the socket is already live.
 */
export function openEncryptedAuthState(passphrase: string, dir: string = AUTH_DIR): EncryptedKeystore {
  fs.mkdirSync(dir, { recursive: true });
  const key = deriveKey(passphrase);
  verifyPassphrase(key, dir);

  const readSlot = (slot: string): unknown => {
    const file = path.join(dir, slotFileName(slot));
    let record: Buffer;
    try {
      record = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const plaintext = decryptRecord(key, slot, record);
    return JSON.parse(plaintext.toString('utf8'), BufferJSON.reviver);
  };

  const writeSlot = (slot: string, value: unknown): void => {
    const file = path.join(dir, slotFileName(slot));
    const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
    const record = encryptRecord(key, slot, plaintext);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, record);
    fs.renameSync(tmp, file); // atomic replace
  };

  const removeSlot = (slot: string): void => {
    try {
      fs.unlinkSync(path.join(dir, slotFileName(slot)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };

  const creds = (readSlot('creds') as AuthenticationCreds | null) ?? initAuthCreds();

  const keys: AuthenticationState['keys'] = {
    get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): { [id: string]: SignalDataTypeMap[T] } {
      const data: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        let value = readSlot(`${type}-${id}`);
        // Baileys hands app-state-sync keys back as a decoded protobuf object.
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
        }
        if (value) data[id] = value as SignalDataTypeMap[T];
      }
      return data;
    },
    set(data: SignalDataSet): void {
      for (const type in data) {
        const category = data[type as keyof SignalDataSet]!;
        for (const id in category) {
          const value = category[id];
          const slot = `${type}-${id}`;
          if (value) writeSlot(slot, value);
          else removeSlot(slot); // null means delete
        }
      }
    },
  };

  const saveCreds = (): void => writeSlot('creds', creds);

  return { state: { creds, keys }, saveCreds };
}

/**
 * A wrong passphrase must fail loudly and immediately. On first run we seal a
 * known plaintext; on every open we require it to decrypt.
 */
function verifyPassphrase(key: Buffer, dir: string): void {
  const file = path.join(dir, 'verifier.enc');
  const marker = Buffer.from('wad-keystore-verifier', 'utf8');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, encryptRecord(key, 'verifier', marker));
    return;
  }
  let decrypted: Buffer;
  try {
    decrypted = decryptRecord(key, 'verifier', fs.readFileSync(file));
  } catch {
    throw new Error(
      'Auth keystore passphrase is wrong (verifier failed to decrypt). ' +
        'WA_ARCHIVE_PASSPHRASE does not match the one used to create data/auth.',
    );
  }
  if (decrypted.length !== marker.length || !timingSafeEqual(decrypted, marker)) {
    throw new Error('Auth keystore verifier mismatch: refusing to proceed with a suspect passphrase.');
  }
}
