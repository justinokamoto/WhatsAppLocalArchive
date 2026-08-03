import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.WA_ARCHIVE_DATA_DIR ?? path.join(PROJECT_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'archive.sqlite');
export const AUTH_DIR = path.join(DATA_DIR, 'auth');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const SCHEMA_PATH = path.join(PROJECT_ROOT, 'src', 'db', 'schema.sql');

/** Bumped whenever normalization changes in a way that would alter stored columns. */
export const PARSER_VERSION = 1;

export const BAILEYS_VERSION: string = require('baileys/package.json').version;

/**
 * The auth keystore is encrypted with no plaintext fallback, so a missing
 * passphrase is a hard error rather than a silent downgrade.
 */
export function requirePassphrase(): string {
  const passphrase = process.env.WA_ARCHIVE_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      'WA_ARCHIVE_PASSPHRASE is not set. The Baileys auth keystore is encrypted ' +
        'and there is no plaintext fallback. Set it to a strong passphrase and retry.',
    );
  }
  return passphrase;
}
