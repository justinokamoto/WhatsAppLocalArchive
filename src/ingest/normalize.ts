import { createHash } from 'node:crypto';
import { jidNormalizedUser } from 'baileys';
import type { proto } from 'baileys';
import type { WAMessage, WAMessageKey } from 'baileys';

/**
 * Compatibility wrappers that carry another Message inside `.message`. Order is
 * irrelevant; presence is what matters. Wrapper names are never discarded --
 * they end up in wrapper_types_json, outermost first.
 */
const WRAPPER_FIELDS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
] as const;

const VIEW_ONCE_WRAPPERS = new Set([
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
]);

/** Subtypes that carry a `caption` rather than ordinary body text. */
const CAPTION_TYPES = new Set(['imageMessage', 'videoMessage', 'documentMessage']);

const MAX_UNWRAP_DEPTH = 8;

export type Unwrapped = {
  /** The innermost Message container. */
  inner: proto.IMessage;
  /** Field name of the outermost wrapper, or the content type when unwrapped. */
  contentTypeRaw: string | null;
  /** Field name of the innermost active content, or 'unknown'. */
  contentTypeCanonical: string;
  /** Wrapper field names, outermost -> innermost. */
  wrapperTypes: string[];
  /** ephemeralMessage expiration observed on the way down, if any. */
  ephemeralSeconds: number | null;
};

/**
 * Every timestamp shape protobuf can hand us: plain number, protobufjs Long
 * ({low, high, unsigned}), decimal string, or bigint. Anything else is a bug we
 * want to hear about rather than silently coerce.
 */
export function toEpochSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) throw new Error(`unparseable timestamp string: ${value}`);
    return parsed;
  }
  if (typeof value === 'object') {
    const long = value as { low?: unknown; high?: unknown; toNumber?: () => number };
    if (typeof long.toNumber === 'function') return Math.trunc(long.toNumber());
    if (typeof long.low === 'number' && typeof long.high === 'number') {
      return long.high * 4294967296 + (long.low >>> 0);
    }
  }
  throw new Error(`unhandled timestamp shape: ${typeof value} ${JSON.stringify(value)}`);
}

export function toEpochMs(value: unknown): number | null {
  const seconds = toEpochSeconds(value);
  return seconds === null ? null : seconds * 1000;
}

/** First key of a Message container holding a non-null value. */
function activeField(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  for (const [key, value] of Object.entries(message)) {
    if (value !== null && value !== undefined) return key;
  }
  return null;
}

/**
 * Peel compatibility wrappers until the real content is reached. Never throws
 * on an unrecognized inner type: unknown content is normal, not an error.
 */
export function unwrapMessage(message: proto.IMessage | null | undefined): Unwrapped {
  const wrapperTypes: string[] = [];
  let ephemeralSeconds: number | null = null;
  let current: proto.IMessage = message ?? {};
  const contentTypeRaw = activeField(current);

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const wrapper = WRAPPER_FIELDS.find((field) => {
      const value = (current as Record<string, unknown>)[field];
      return value !== null && value !== undefined;
    });
    if (!wrapper) break;

    const container = (current as Record<string, unknown>)[wrapper] as {
      message?: proto.IMessage | null;
      expiration?: unknown;
    };
    if (wrapper === 'ephemeralMessage' && container?.expiration !== undefined) {
      ephemeralSeconds = toEpochSeconds(container.expiration);
    }
    if (!container?.message) break; // wrapper with no payload: stop, keep the name

    wrapperTypes.push(wrapper);
    current = container.message;
  }

  return {
    inner: current,
    contentTypeRaw,
    contentTypeCanonical: activeField(current) ?? 'unknown',
    wrapperTypes,
    ephemeralSeconds,
  };
}

/** Body text. Captions deliberately excluded -- they belong in `caption`. */
export function extractText(message: proto.IMessage): string | null {
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  return null;
}

export function extractCaption(message: proto.IMessage, canonicalType: string): string | null {
  if (!CAPTION_TYPES.has(canonicalType)) return null;
  const content = (message as Record<string, { caption?: unknown } | undefined>)[canonicalType];
  return typeof content?.caption === 'string' ? content.caption : null;
}

/** ContextInfo from whichever subtype is active. */
export function extractContextInfo(
  message: proto.IMessage,
  canonicalType: string,
): proto.IContextInfo | null {
  const content = (message as Record<string, { contextInfo?: proto.IContextInfo | null } | undefined>)[
    canonicalType
  ];
  return content?.contextInfo ?? null;
}

export type Extracted = {
  contentTypeRaw: string | null;
  contentTypeCanonical: string;
  wrapperTypes: string[];
  textBody: string | null;
  caption: string | null;
  mentionedJids: string[];
  isForwarded: boolean;
  forwardingScore: number | null;
  quotedWaMessageId: string | null;
  quotedParticipantJid: string | null;
  quotedRemoteJid: string | null;
  quotedContentType: string | null;
  quotedTextSnapshot: string | null;
  ephemeralDurationSeconds: number | null;
  expiresAtMs: number | null;
  isViewOnce: boolean;
  hasExplicitEditSignal: boolean;
  contentHash: string;
};

export function normalizeMessage(message: WAMessage, sentAtMs: number): Extracted {
  const unwrapped = unwrapMessage(message.message);
  const inner = unwrapped.inner;
  const canonical = unwrapped.contentTypeCanonical;

  const context = extractContextInfo(inner, canonical);
  const quoted = context?.quotedMessage ?? null;

  const ephemeralDurationSeconds =
    unwrapped.ephemeralSeconds ??
    (context?.expiration !== undefined && context.expiration !== null
      ? toEpochSeconds(context.expiration)
      : null);

  const isViewOnce =
    unwrapped.wrapperTypes.some((w) => VIEW_ONCE_WRAPPERS.has(w)) ||
    message.key?.isViewOnce === true ||
    (inner as Record<string, { viewOnce?: boolean } | undefined>)[canonical]?.viewOnce === true;

  const forwardingScore =
    context?.forwardingScore !== undefined && context.forwardingScore !== null
      ? Number(context.forwardingScore)
      : null;

  const extracted: Omit<Extracted, 'contentHash'> = {
    contentTypeRaw: unwrapped.contentTypeRaw,
    contentTypeCanonical: canonical,
    wrapperTypes: unwrapped.wrapperTypes,
    textBody: extractText(inner),
    caption: extractCaption(inner, canonical),
    mentionedJids: (context?.mentionedJid ?? []).filter((j): j is string => typeof j === 'string'),
    isForwarded: context?.isForwarded === true,
    forwardingScore,
    quotedWaMessageId: context?.stanzaId ?? null,
    quotedParticipantJid: context?.participant ?? null,
    quotedRemoteJid: context?.remoteJid ?? null,
    quotedContentType: quoted ? activeField(quoted) : null,
    quotedTextSnapshot: quoted ? extractText(quoted) : null,
    ephemeralDurationSeconds,
    expiresAtMs:
      ephemeralDurationSeconds !== null && ephemeralDurationSeconds > 0
        ? sentAtMs + ephemeralDurationSeconds * 1000
        : null,
    isViewOnce: Boolean(isViewOnce),
    hasExplicitEditSignal:
      unwrapped.wrapperTypes.includes('editedMessage') ||
      Boolean(inner.protocolMessage?.editedMessage) ||
      Boolean(message.message?.protocolMessage?.editedMessage),
  };

  return { ...extracted, contentHash: computeContentHash(extracted) };
}

/**
 * SHA-256 over SEMANTIC content only. The same logical message arriving via
 * messaging-history.set and via messages.upsert differs in status, pushName,
 * participant JID formatting and field presence, so hashing the envelope would
 * flag every redelivery as an edit.
 */
export function computeContentHash(e: Omit<Extracted, 'contentHash'>): string {
  const canonicalForm = [
    e.contentTypeCanonical,
    [...e.wrapperTypes].sort().join(','),
    e.textBody ?? '',
    e.caption ?? '',
    e.quotedWaMessageId ?? '',
    [...e.mentionedJids].sort().join(','),
    e.isViewOnce ? '1' : '0',
    e.ephemeralDurationSeconds ?? '',
    e.isForwarded ? '1' : '0',
    e.forwardingScore ?? '',
  ].join(' ');
  return createHash('sha256').update(canonicalForm, 'utf8').digest('hex');
}

/** Normalized participant JID, kept for debugging and spec compatibility only. */
export function normalizedParticipant(key: WAMessageKey): string | null {
  return key.participant ? (jidNormalizedUser(key.participant) ?? null) : null;
}
