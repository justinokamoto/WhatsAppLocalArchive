import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toEpochSeconds,
  toEpochMs,
  unwrapMessage,
  extractText,
  extractCaption,
  normalizeMessage,
  computeContentHash,
} from '../src/ingest/normalize.ts';
import {
  makeTextMessage,
  makeExtendedText,
  makeImageWithCaption,
  makeUnknownType,
  wrapEphemeral,
  wrapViewOnce,
  wrapEdited,
  wrapDeviceSent,
  BASE_TS,
} from './fixtures.ts';

const ALICE = '15551230001@s.whatsapp.net';
const GROUP = '123456789-987654@g.us';

test('toEpochSeconds handles every shape protobuf produces', () => {
  assert.equal(toEpochSeconds(BASE_TS), BASE_TS);
  assert.equal(toEpochSeconds(String(BASE_TS)), BASE_TS);
  assert.equal(toEpochSeconds(BigInt(BASE_TS)), BASE_TS);
  // protobufjs Long
  assert.equal(toEpochSeconds({ low: BASE_TS, high: 0, unsigned: false }), BASE_TS);
  assert.equal(toEpochSeconds({ toNumber: () => BASE_TS }), BASE_TS);
  assert.equal(toEpochSeconds(null), null);
  assert.equal(toEpochSeconds(undefined), null);
  assert.equal(toEpochMs(BASE_TS), BASE_TS * 1000);
});

test('toEpochSeconds fails fast on nonsense rather than coercing', () => {
  assert.throws(() => toEpochSeconds(true), /unhandled timestamp shape/);
  assert.throws(() => toEpochSeconds('not-a-number'), /unparseable timestamp string/);
});

test('a large Long survives (high word set)', () => {
  // 2^32 + 5 seconds
  assert.equal(toEpochSeconds({ low: 5, high: 1, unsigned: true }), 4294967301);
});

test('plain conversation needs no unwrapping', () => {
  const u = unwrapMessage({ conversation: 'hi' });
  assert.deepEqual(u.wrapperTypes, []);
  assert.equal(u.contentTypeRaw, 'conversation');
  assert.equal(u.contentTypeCanonical, 'conversation');
  assert.equal(extractText(u.inner), 'hi');
});

test('extendedTextMessage text is extracted', () => {
  const u = unwrapMessage({ extendedTextMessage: { text: 'hello there' } });
  assert.equal(u.contentTypeCanonical, 'extendedTextMessage');
  assert.equal(extractText(u.inner), 'hello there');
});

test('3-deep nest ephemeral(viewOnce(edited)) unwraps and records order', () => {
  const base = makeTextMessage({ remoteJid: ALICE, text: 'inner text' });
  const nested = wrapEphemeral(wrapViewOnce(wrapEdited(base, 'edited text'), 'v2'), 604800);

  const u = unwrapMessage(nested.message);
  assert.deepEqual(u.wrapperTypes, ['ephemeralMessage', 'viewOnceMessageV2', 'editedMessage']);
  assert.equal(u.contentTypeRaw, 'ephemeralMessage');
  assert.equal(u.contentTypeCanonical, 'conversation');
  assert.equal(extractText(u.inner), 'edited text');
  assert.equal(u.ephemeralSeconds, 604800);
});

test('all view-once variants are recognized as view-once', () => {
  for (const variant of ['v1', 'v2', 'v2ext'] as const) {
    const m = wrapViewOnce(makeTextMessage({ remoteJid: ALICE, text: 'x' }), variant);
    assert.equal(normalizeMessage(m, BASE_TS * 1000).isViewOnce, true, variant);
  }
});

test('deviceSentMessage is unwrapped, not mistaken for content', () => {
  const m = wrapDeviceSent(makeTextMessage({ remoteJid: ALICE, text: 'sent from phone' }));
  const e = normalizeMessage(m, BASE_TS * 1000);
  assert.deepEqual(e.wrapperTypes, ['deviceSentMessage']);
  assert.equal(e.contentTypeCanonical, 'conversation');
  assert.equal(e.textBody, 'sent from phone');
});

test('a wrapper with no inner payload keeps its name and does not crash', () => {
  const u = unwrapMessage({ ephemeralMessage: { expiration: 60 } });
  assert.equal(u.contentTypeCanonical, 'ephemeralMessage');
  assert.deepEqual(u.wrapperTypes, []);
});

test('unknown types normalize to unknown without throwing, preserving raw name', () => {
  const m = makeUnknownType({ remoteJid: ALICE });
  const e = normalizeMessage(m, BASE_TS * 1000);
  assert.equal(e.contentTypeCanonical, 'someFutureMessage');
  assert.equal(e.textBody, null);
  assert.equal(e.caption, null);
});

test('an empty message object yields unknown rather than crashing', () => {
  assert.equal(normalizeMessage({ key: { id: 'x', remoteJid: ALICE, fromMe: false }, message: {} } as never, 0).contentTypeCanonical, 'unknown');
  assert.equal(normalizeMessage({ key: { id: 'x', remoteJid: ALICE, fromMe: false } } as never, 0).contentTypeCanonical, 'unknown');
});

test('captions live in caption, never in text_body, and are extracted', () => {
  const m = makeImageWithCaption({ remoteJid: ALICE, caption: 'a photo of a cat' });
  const e = normalizeMessage(m, BASE_TS * 1000);
  assert.equal(e.contentTypeCanonical, 'imageMessage');
  assert.equal(e.caption, 'a photo of a cat');
  assert.equal(e.textBody, null);
  assert.equal(extractCaption({ conversation: 'x' }, 'conversation'), null);
});

test('mentions, quotes and forwarding are extracted from contextInfo', () => {
  const m = makeExtendedText({
    remoteJid: GROUP,
    participant: ALICE,
    text: 'hey @a @b',
    mentions: ['15551230002@s.whatsapp.net', '15551230003@s.whatsapp.net'],
    quoted: { id: 'QUOTED123', participant: ALICE, text: 'original' },
    forwardingScore: 5,
  });
  const e = normalizeMessage(m, BASE_TS * 1000);
  assert.deepEqual(e.mentionedJids, ['15551230002@s.whatsapp.net', '15551230003@s.whatsapp.net']);
  assert.equal(e.quotedWaMessageId, 'QUOTED123');
  assert.equal(e.quotedParticipantJid, ALICE);
  assert.equal(e.quotedContentType, 'conversation');
  assert.equal(e.quotedTextSnapshot, 'original');
  assert.equal(e.isForwarded, true);
  assert.equal(e.forwardingScore, 5);
});

test('ephemeral duration yields expires_at', () => {
  const sentAtMs = BASE_TS * 1000;
  const e = normalizeMessage(wrapEphemeral(makeTextMessage({ remoteJid: ALICE, text: 'x' }), 3600), sentAtMs);
  assert.equal(e.ephemeralDurationSeconds, 3600);
  assert.equal(e.expiresAtMs, sentAtMs + 3600 * 1000);
});

test('non-ephemeral messages have no expiry', () => {
  const e = normalizeMessage(makeTextMessage({ remoteJid: ALICE, text: 'x' }), BASE_TS * 1000);
  assert.equal(e.ephemeralDurationSeconds, null);
  assert.equal(e.expiresAtMs, null);
});

test('editedMessage sets an explicit edit signal; a plain message does not', () => {
  const plain = makeTextMessage({ remoteJid: ALICE, text: 'v1' });
  assert.equal(normalizeMessage(plain, BASE_TS * 1000).hasExplicitEditSignal, false);
  assert.equal(normalizeMessage(wrapEdited(plain, 'v2'), BASE_TS * 1000).hasExplicitEditSignal, true);
});

test('content hash ignores envelope metadata but tracks real content', () => {
  const a = makeTextMessage({ id: 'SAME', remoteJid: ALICE, text: 'hello', status: 2, pushName: 'Alice' });
  const b = makeTextMessage({ id: 'SAME', remoteJid: ALICE, text: 'hello', status: 4, pushName: 'Alice B.', tsSeconds: BASE_TS + 99 });
  const c = makeTextMessage({ id: 'SAME', remoteJid: ALICE, text: 'hello!' });

  const ha = normalizeMessage(a, BASE_TS * 1000).contentHash;
  const hb = normalizeMessage(b, (BASE_TS + 99) * 1000).contentHash;
  const hc = normalizeMessage(c, BASE_TS * 1000).contentHash;

  assert.equal(ha, hb, 'status/pushName/timestamp must not affect the hash');
  assert.notEqual(ha, hc, 'changed text must change the hash');
});

test('content hash is order-insensitive for mentions but sensitive to membership', () => {
  const base = { remoteJid: GROUP, participant: ALICE, text: 'hi', id: 'M1' };
  const h1 = normalizeMessage(makeExtendedText({ ...base, mentions: ['a@s.whatsapp.net', 'b@s.whatsapp.net'] }), 0).contentHash;
  const h2 = normalizeMessage(makeExtendedText({ ...base, mentions: ['b@s.whatsapp.net', 'a@s.whatsapp.net'] }), 0).contentHash;
  const h3 = normalizeMessage(makeExtendedText({ ...base, mentions: ['a@s.whatsapp.net'] }), 0).contentHash;
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('hash distinguishes text from caption with identical strings', () => {
  const asText = computeContentHash({
    contentTypeCanonical: 'conversation', wrapperTypes: [], textBody: 'same', caption: null,
    mentionedJids: [], isForwarded: false, forwardingScore: null, quotedWaMessageId: null,
    quotedParticipantJid: null, quotedRemoteJid: null, quotedContentType: null,
    quotedTextSnapshot: null, ephemeralDurationSeconds: null, expiresAtMs: null,
    isViewOnce: false, hasExplicitEditSignal: false, contentTypeRaw: 'conversation',
  });
  const asCaption = computeContentHash({
    contentTypeCanonical: 'conversation', wrapperTypes: [], textBody: null, caption: 'same',
    mentionedJids: [], isForwarded: false, forwardingScore: null, quotedWaMessageId: null,
    quotedParticipantJid: null, quotedRemoteJid: null, quotedContentType: null,
    quotedTextSnapshot: null, ephemeralDurationSeconds: null, expiresAtMs: null,
    isViewOnce: false, hasExplicitEditSignal: false, contentTypeRaw: 'conversation',
  });
  assert.notEqual(asText, asCaption);
});
