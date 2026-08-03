import type { WAMessage } from 'baileys';
import type { proto } from 'baileys';

let counter = 0;
/** Deterministic ids: Math.random() would make failures unreproducible. */
export function nextId(prefix = 'MSG'): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(12, '0')}`;
}

export function resetIds(): void {
  counter = 0;
}

export const BASE_TS = 1_754_225_000; // epoch seconds

export type KeyOpts = {
  id?: string;
  remoteJid: string;
  fromMe?: boolean;
  participant?: string;
  remoteJidAlt?: string;
  participantAlt?: string;
  addressingMode?: string;
};

function makeKey(o: KeyOpts) {
  return {
    id: o.id ?? nextId(),
    remoteJid: o.remoteJid,
    fromMe: o.fromMe ?? false,
    ...(o.participant ? { participant: o.participant } : {}),
    ...(o.remoteJidAlt ? { remoteJidAlt: o.remoteJidAlt } : {}),
    ...(o.participantAlt ? { participantAlt: o.participantAlt } : {}),
    ...(o.addressingMode ? { addressingMode: o.addressingMode } : {}),
  };
}

function envelope(
  key: ReturnType<typeof makeKey>,
  message: proto.IMessage,
  o: { tsSeconds?: unknown; pushName?: string; status?: number },
): WAMessage {
  return {
    key,
    message,
    messageTimestamp: (o.tsSeconds ?? BASE_TS) as never,
    ...(o.pushName ? { pushName: o.pushName } : {}),
    ...(o.status !== undefined ? { status: o.status as never } : {}),
  } as WAMessage;
}

/** A plain `conversation` message. */
export function makeTextMessage(
  o: KeyOpts & { text: string; tsSeconds?: unknown; pushName?: string; status?: number },
): WAMessage {
  return envelope(makeKey(o), { conversation: o.text }, o);
}

/** An `extendedTextMessage`, optionally with mentions, a quote, or forwarding. */
export function makeExtendedText(
  o: KeyOpts & {
    text: string;
    tsSeconds?: unknown;
    pushName?: string;
    status?: number;
    mentions?: string[];
    quoted?: { id: string; participant?: string; remoteJid?: string; text?: string };
    forwardingScore?: number;
    ephemeralSeconds?: number;
  },
): WAMessage {
  const contextInfo: proto.IContextInfo = {};
  if (o.mentions?.length) contextInfo.mentionedJid = o.mentions;
  if (o.quoted) {
    contextInfo.stanzaId = o.quoted.id;
    if (o.quoted.participant) contextInfo.participant = o.quoted.participant;
    if (o.quoted.remoteJid) contextInfo.remoteJid = o.quoted.remoteJid;
    contextInfo.quotedMessage = { conversation: o.quoted.text ?? 'quoted body' };
  }
  if (o.forwardingScore !== undefined) {
    contextInfo.isForwarded = true;
    contextInfo.forwardingScore = o.forwardingScore;
  }
  if (o.ephemeralSeconds !== undefined) contextInfo.expiration = o.ephemeralSeconds;

  return envelope(
    makeKey(o),
    {
      extendedTextMessage: {
        text: o.text,
        ...(Object.keys(contextInfo).length ? { contextInfo } : {}),
      },
    },
    o,
  );
}

export function makeImageWithCaption(
  o: KeyOpts & { caption: string; tsSeconds?: unknown; mentions?: string[] },
): WAMessage {
  const contextInfo: proto.IContextInfo = {};
  if (o.mentions?.length) contextInfo.mentionedJid = o.mentions;
  return envelope(
    makeKey(o),
    {
      imageMessage: {
        caption: o.caption,
        mimetype: 'image/jpeg',
        mediaKey: Buffer.from([9, 8, 7, 6]),
        fileSha256: Buffer.from('deadbeef'),
        ...(Object.keys(contextInfo).length ? { contextInfo } : {}),
      },
    },
    o,
  );
}

/** A message type this version does not model. Must NOT be treated as an error. */
export function makeUnknownType(o: KeyOpts & { tsSeconds?: unknown }): WAMessage {
  return envelope(
    makeKey(o),
    { someFutureMessage: { payload: 'from the future', n: 42 } } as unknown as proto.IMessage,
    o,
  );
}

/**
 * Throws while being read, to exercise the savepoint/quarantine path. A merely
 * unknown type will NOT throw, so it cannot test that path.
 */
export function makePoisonMessage(o: KeyOpts & { tsSeconds?: unknown }): WAMessage {
  const msg = envelope(makeKey(o), { conversation: 'never read' }, o);
  Object.defineProperty(msg, 'message', {
    get() {
      throw new Error('boom: poison message');
    },
    enumerable: true,
    configurable: true,
  });
  return msg;
}

// ------------------------------------------------------------------ wrappers

function rewrap(m: WAMessage, field: string, extra: Record<string, unknown> = {}): WAMessage {
  return {
    ...m,
    message: { [field]: { message: m.message, ...extra } } as proto.IMessage,
  } as WAMessage;
}

export function wrapEphemeral(m: WAMessage, seconds: number): WAMessage {
  return rewrap(m, 'ephemeralMessage', { expiration: seconds });
}

export function wrapViewOnce(m: WAMessage, variant: 'v1' | 'v2' | 'v2ext' = 'v2'): WAMessage {
  const field =
    variant === 'v1' ? 'viewOnceMessage' : variant === 'v2' ? 'viewOnceMessageV2' : 'viewOnceMessageV2Extension';
  return rewrap(m, field);
}

export function wrapDocumentWithCaption(m: WAMessage): WAMessage {
  return rewrap(m, 'documentWithCaptionMessage');
}

export function wrapDeviceSent(m: WAMessage): WAMessage {
  return rewrap(m, 'deviceSentMessage', { destinationJid: m.key.remoteJid });
}

/** Same key, new text, wrapped in editedMessage -- the shape of a real edit. */
export function wrapEdited(m: WAMessage, newText: string): WAMessage {
  return {
    ...m,
    message: {
      editedMessage: { message: { conversation: newText } },
    } as proto.IMessage,
  } as WAMessage;
}
