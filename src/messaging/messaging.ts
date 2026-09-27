/**
 * The shape of user-to-user messaging: where it lives, what a record looks like, and what the
 * client is allowed to send. Pure -- no Firebase, no crypto, no React.
 *
 * This is a separate domain from the support conversation in `@/support/chat`. Nothing here
 * touches `users/{uid}/support/...`, and the two never share a document. The only things borrowed
 * are two pure helpers (timestamp parsing and the "never send this" guard), because a user is no
 * safer pasting their recovery passphrase to a friend than to support.
 */
import { findSensitiveContent, readMillis, type SensitiveReason } from '@/support/chat/supportChat';

import { MAX_MESSAGE_LENGTH } from '@/messaging/messageCipher';

export { MAX_MESSAGE_LENGTH };

/**
 * A conversation id is its two members' uids, sorted and joined. Deterministic on purpose:
 *
 * - two people can only ever have ONE conversation, so "start a chat" is idempotent and a race
 *   between both sides starting at once converges instead of forking;
 * - membership is readable from the id alone, so the security rules answer "may you see this
 *   message?" without reading the parent document -- no extra read per message, on either side.
 *
 * The cost is that this is a two-party model. A group chat would need a random id and a members
 * list the rules have to fetch.
 */
export const CONVERSATION_ID_SEPARATOR = '__';

/** Newest-first listing cap for conversations, and oldest-first page size within one. */
export const CONVERSATION_PAGE_SIZE = 200;
export const MESSAGE_PAGE_SIZE = 200;

export const MESSAGING_PATHS = {
  /** One published X25519 public key per account. Readable by any signed-in user. */
  publicKey: (uid: string): string => `messagingKeys/${uid}`,
  conversations: (): string => 'conversations',
  conversation: (conversationId: string): string => `conversations/${conversationId}`,
  messages: (conversationId: string): string => `conversations/${conversationId}/messages`,
  message: (conversationId: string, messageId: string): string =>
    `conversations/${conversationId}/messages/${messageId}`,
  /**
   * Where a message's media lives in Storage. Shared between the two participants rather than
   * owned by one, which makes it the only non-owner-scoped prefix in the bucket -- so the object
   * names are two uids and are social-graph metadata that must never be logged.
   */
  mediaObject: (conversationId: string, kind: 'photo' | 'video', messageId: string): string =>
    `messages/${conversationId}/${kind}/${messageId}`,
  thumbObject: (conversationId: string, messageId: string): string =>
    `messages/${conversationId}/thumb/${messageId}`,
  mediaPrefix: (conversationId: string): string => `messages/${conversationId}/`,
} as const;

export class InvalidUidError extends Error {
  constructor() {
    super('invalid account id');
    this.name = 'InvalidUidError';
  }
}

/**
 * A uid we are willing to put in a path or a conversation id. Firebase mints 28 alphanumeric
 * characters; anything with a slash or the separator in it would make the id ambiguous and is
 * refused rather than escaped.
 */
export function isUsableUid(uid: string): boolean {
  return (
    uid.length > 0 &&
    uid.length <= 128 &&
    !uid.includes('/') &&
    !uid.includes('.') &&
    !uid.includes(CONVERSATION_ID_SEPARATOR)
  );
}

export function conversationIdFor(a: string, b: string): string {
  if (!isUsableUid(a) || !isUsableUid(b) || a === b) throw new InvalidUidError();
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${first}${CONVERSATION_ID_SEPARATOR}${second}`;
}

/** The two uids in a conversation id, or null when it is not one. */
export function membersOf(conversationId: string): readonly [string, string] | null {
  const parts = conversationId.split(CONVERSATION_ID_SEPARATOR);
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return null;
  if (!isUsableUid(a) || !isUsableUid(b) || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

export function peerOf(conversationId: string, me: string): string | null {
  const members = membersOf(conversationId);
  if (members === null) return null;
  if (members[0] === me) return members[1];
  if (members[1] === me) return members[0];
  return null;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/** A published key, as stored. */
export interface PublishedKey {
  readonly uid: string;
  readonly publicKey: string;
  readonly updatedAt: number;
}

export function parsePublishedKey(
  uid: string,
  doc: Record<string, unknown> | null,
): PublishedKey | null {
  if (doc === null) return null;
  const publicKey = doc.publicKey;
  if (typeof publicKey !== 'string' || publicKey === '') return null;
  return { uid, publicKey, updatedAt: readMillis(doc.updatedAt) ?? 0 };
}

export function publishedKeyRecord(
  uid: string,
  publicKey: string,
  now: number,
): Record<string, unknown> {
  return { v: 1, uid, publicKey, updatedAt: now };
}

/** A conversation as the list screen needs it. */
export interface Conversation {
  readonly id: string;
  readonly peerUid: string;
  readonly createdAt: number;
  readonly lastMessageAt: number;
  readonly lastMessageFrom: string | null;
  /** How many messages the peer has sent that this account has not opened yet. */
  readonly unread: number;
  readonly readAt: number;
}

function numberAt(map: unknown, key: string): number {
  if (typeof map !== 'object' || map === null) return 0;
  const value = (map as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Null for anything that is not a conversation this account belongs to. */
export function parseConversation(
  id: string,
  data: Record<string, unknown>,
  me: string,
): Conversation | null {
  const peerUid = peerOf(id, me);
  if (peerUid === null) return null;
  const members = data.members;
  // The id is the authority, but a document whose members disagree with it is malformed.
  if (!Array.isArray(members) || members.length !== 2) return null;
  if (!members.includes(me) || !members.includes(peerUid)) return null;
  const lastMessageFrom = data.lastMessageFrom;
  return {
    id,
    peerUid,
    createdAt: readMillis(data.createdAt) ?? 0,
    lastMessageAt: readMillis(data.lastMessageAt) ?? 0,
    lastMessageFrom: typeof lastMessageFrom === 'string' ? lastMessageFrom : null,
    unread: numberAt(data.unread, me),
    readAt: numberAt(data.readAt, me),
  };
}

export function conversationRecord(
  members: readonly [string, string],
  createdBy: string,
  now: number,
): Record<string, unknown> {
  return {
    v: 1,
    members: [members[0], members[1]],
    createdAt: now,
    createdBy,
    lastMessageAt: now,
    lastMessageFrom: null,
    unread: { [members[0]]: 0, [members[1]]: 0 },
    readAt: { [members[0]]: 0, [members[1]]: 0 },
  };
}

/** Newest conversation first; ties broken by id so the order never flickers. */
export function byRecency(a: Conversation, b: Conversation): number {
  if (a.lastMessageAt !== b.lastMessageAt) return b.lastMessageAt - a.lastMessageAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * What a message carries besides text.
 *
 * `null` is text -- the state of every message sent before media existed, and the reason nothing
 * needed migrating. `'unknown'` is a kind this build does not understand, which is kept rather
 * than dropped: a silent gap is the one failure a reader cannot tell from "they never wrote".
 */
export type StoredMessageKind = 'photo' | 'video' | 'unknown' | null;

/** A message exactly as stored: the body is ciphertext and stays that way until it is opened. */
export interface StoredMessage {
  readonly id: string;
  readonly from: string;
  readonly box: string;
  readonly nonce: string;
  readonly createdAt: number;
  readonly kind: StoredMessageKind;
  /** The Storage path of the media, or null for text. */
  readonly object: string | null;
  /** Ciphertext length of the media; 0 for text. */
  readonly bytes: number;
  /** The Storage path of the preview. Null for text, and for media that produced none. */
  readonly thumbObject: string | null;
}

function readKind(value: unknown): StoredMessageKind {
  if (value === undefined || value === null) return null;
  return value === 'photo' || value === 'video' ? value : 'unknown';
}

function readPath(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseStoredMessage(
  id: string,
  data: Record<string, unknown>,
): StoredMessage | null {
  const from = data.from;
  const box = data.box;
  const nonce = data.nonce;
  const createdAt = readMillis(data.createdAt);
  if (typeof from !== 'string' || from === '') return null;
  if (typeof box !== 'string' || box === '') return null;
  if (typeof nonce !== 'string' || nonce === '') return null;
  if (createdAt === null) return null;

  const kind = readKind(data.kind);
  const object = readPath(data.object);
  // A media record whose object is missing is a bubble that can never be filled, so it is not a
  // message at all. An unknown kind is different: it is refused only if it also lacks an object,
  // because a future kind this build cannot open should still show as something that was sent.
  if (kind !== null && object === null) return null;
  const bytes = typeof data.bytes === 'number' && Number.isFinite(data.bytes) ? data.bytes : 0;

  return {
    id,
    from,
    box,
    nonce,
    createdAt,
    kind,
    object,
    bytes: kind === null ? 0 : bytes,
    thumbObject: readPath(data.thumbObject),
  };
}

/**
 * A text message, byte-identical to what this app has always written.
 *
 * It must NOT start writing a `kind` field: every existing reader would see a change it did not
 * need, and "absent means text" is what makes the new field free.
 */
export function messageRecord(
  from: string,
  sealed: { readonly box: string; readonly nonce: string },
  now: number,
): Record<string, unknown> {
  return { v: 1, from, box: sealed.box, nonce: sealed.nonce, createdAt: now };
}

/** A message carrying a photo or a video. The `box` holds the media's own nonce, not its bytes. */
export function mediaRecord(
  from: string,
  kind: 'photo' | 'video',
  sealed: { readonly box: string; readonly nonce: string },
  media: {
    readonly object: string;
    readonly bytes: number;
    readonly thumbObject: string | null;
  },
  now: number,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    v: 1,
    from,
    box: sealed.box,
    nonce: sealed.nonce,
    createdAt: now,
    kind,
    object: media.object,
    bytes: media.bytes,
  };
  // Omitted rather than written as null: the rules allow the field to be absent, and a null would
  // have to be special-cased by every reader.
  if (media.thumbObject !== null) record.thumbObject = media.thumbObject;
  return record;
}

/** A message after it has been opened, which is the only form the UI ever sees. */
export interface DecryptedMessage {
  readonly id: string;
  readonly from: string;
  readonly createdAt: number;
  readonly mine: boolean;
  /** Null when this record does not open: tampered, or sent to a key we no longer hold. */
  readonly body: string | null;
  /** Null for text. See {@link StoredMessageKind}. */
  readonly kind: StoredMessageKind;
  /** The Storage path of the media, or null for text. */
  readonly object: string | null;
  /** The Storage path of the preview, or null for text and for media that produced none. */
  readonly thumbObject: string | null;
}

// ---------------------------------------------------------------------------------------------
// What may be sent
// ---------------------------------------------------------------------------------------------

export type MessageProblem = 'empty' | 'too-long' | SensitiveReason;

export type MessageCheck =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly problem: MessageProblem };

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
      return 'That looks like vault data. It cannot be sent, even encrypted.';
    case 'pin':
      return 'Never send your PIN, to anyone.';
    case 'recovery-passphrase':
      return 'That looks like your recovery passphrase. Sharing it gives away the whole vault.';
    case 'key-material':
      return 'Keys and recovery codes must never be sent in a message.';
  }
}

/** A plain e-mail check, only strict enough to keep obvious typos out of a lookup. */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 320;
}
