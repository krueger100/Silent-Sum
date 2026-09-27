/**
 * The support conversation: what a message is, where it lives, and what may never be typed into it.
 *
 * One thread per account, at `support_threads/<uid>`, with the messages in a subcollection under
 * it. The user writes their own messages directly (Firestore rules gate that on an active Cloud
 * term); support answers through the Admin SDK, which no client can impersonate.
 *
 * Nothing here touches the vault. The chat carries typed text and timestamps, never a key, a PIN,
 * a recovery passphrase or a byte of ciphertext -- `findSensitiveContent` is the guard that keeps
 * it that way even when the person typing does not realise what they are pasting.
 */

/** Who wrote a message. `support` messages can only be written by the server. */
export type SupportSender = 'user' | 'support';

export interface SupportMessage {
  readonly id: string;
  readonly sender: SupportSender;
  readonly body: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
}

export interface SupportThread {
  /** When the user last opened the conversation; everything newer from support is unread. */
  readonly userLastReadAt: number;
}

export const EMPTY_THREAD: SupportThread = { userLastReadAt: 0 };

/**
 * Under `users/<uid>/` like everything else the app stores, so the one owner rule that already
 * governs the vault envelope and manifest governs the conversation too.
 */
export const SUPPORT_CHAT_PATHS = {
  thread: (uid: string): string => `users/${uid}/support/thread`,
  messages: (uid: string): string => `users/${uid}/support/thread/messages`,
  message: (uid: string, id: string): string => `users/${uid}/support/thread/messages/${id}`,
} as const;

/** Long enough for a real problem report, short enough that nobody pastes a vault file into it. */
export const MAX_MESSAGE_LENGTH = 2000;

/** How many messages the app keeps on screen. Older ones stay in Firestore. */
export const MESSAGE_PAGE_SIZE = 200;

/**
 * Timestamps arrive as a number, an ISO string, or one of Firestore's two shapes depending on
 * whether the value came from the server, the local cache or a test double.
 */
export function readMillis(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.toMillis === 'function') {
    const millis: unknown = (record as { toMillis: () => unknown }).toMillis();
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null;
  }
  const seconds = record.seconds ?? record._seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const nanos = record.nanoseconds ?? record._nanoseconds;
  const extra = typeof nanos === 'number' && Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0;
  return seconds * 1000 + extra;
}

function readSender(value: unknown): SupportSender | null {
  return value === 'user' || value === 'support' ? value : null;
}

/** Null for anything that is not a well-formed message, so a corrupt document is skipped, not shown. */
export function parseMessage(id: string, data: Record<string, unknown>): SupportMessage | null {
  const sender = readSender(data.sender);
  const createdAt = readMillis(data.createdAt);
  const body = data.body;
  if (sender === null || createdAt === null) return null;
  if (typeof body !== 'string' || body.trim() === '') return null;
  return { id, sender, body, createdAt };
}

export function parseThread(doc: Record<string, unknown> | null): SupportThread {
  if (doc === null) return EMPTY_THREAD;
  return { userLastReadAt: readMillis(doc.userLastReadAt) ?? 0 };
}

/** Support messages the user has not seen yet. Their own messages are never unread. */
export function unreadCount(messages: readonly SupportMessage[], thread: SupportThread): number {
  let count = 0;
  for (const message of messages) {
    if (message.sender === 'support' && message.createdAt > thread.userLastReadAt) count += 1;
  }
  return count;
}

/** Why a message must not be sent. */
export type SensitiveReason = 'vault-data' | 'recovery-passphrase' | 'pin' | 'key-material';

const VAULT_HEADER = /SSV1/;
/** A run of base64/hex long enough to be ciphertext, a wrapped key or an exported envelope. */
const BLOB = /[A-Za-z0-9+/=]{60,}/;
const HEX_BLOB = /\b[0-9a-fA-F]{40,}\b/;
/** "my pin is 1234", "PIN: 000000" and the like. */
const PIN = /\bpin\b[^0-9]{0,16}\d{4,12}/i;
/** The recovery passphrase is a long run of lower-case words; six or more is never prose here. */
const PASSPHRASE = /\b(?:[a-z]{3,12}[ -]){5,}[a-z]{3,12}\b/;
const KEY_WORDS = /\b(master key|private key|secret key|recovery code|recovery key|seed phrase)\b/i;

/**
 * What in this text must never leave the device. Checked before anything is written, so a refusal
 * happens in the composer rather than after the message is already in Firestore.
 */
export function findSensitiveContent(body: string): SensitiveReason | null {
  if (VAULT_HEADER.test(body) || BLOB.test(body) || HEX_BLOB.test(body)) return 'vault-data';
  if (PIN.test(body)) return 'pin';
  if (KEY_WORDS.test(body)) return 'key-material';
  if (PASSPHRASE.test(body)) return 'recovery-passphrase';
  return null;
}

export type MessageProblem = 'empty' | 'too-long' | SensitiveReason;

export type MessageCheck =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly problem: MessageProblem };

/** Trims, then refuses anything empty, oversized or secret. */
export function checkMessage(body: string): MessageCheck {
  const trimmed = body.trim();
  if (trimmed === '') return { ok: false, problem: 'empty' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { ok: false, problem: 'too-long' };
  const sensitive = findSensitiveContent(trimmed);
  if (sensitive !== null) return { ok: false, problem: sensitive };
  return { ok: true, body: trimmed };
}

export function describeMessageProblem(problem: MessageProblem): string {
  switch (problem) {
    case 'empty':
      return 'Type a message first.';
    case 'too-long':
      return `Keep it under ${String(MAX_MESSAGE_LENGTH)} characters.`;
    case 'vault-data':
      return 'That looks like vault data. Support never needs it, and it cannot be sent from here.';
    case 'pin':
      return 'Never send your PIN. Support will never ask for it.';
    case 'recovery-passphrase':
      return 'That looks like your recovery passphrase. It must never be shared, including with support.';
    case 'key-material':
      return 'Support never needs keys or recovery codes. Describe the problem instead.';
  }
}
