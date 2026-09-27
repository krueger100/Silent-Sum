/**
 * The support side of the conversation.
 *
 * A reply is written with the Admin SDK, which bypasses the Firestore rules, so `sender: 'support'`
 * is a claim no client can make. Who is allowed to call it is decided here and nowhere else: the
 * caller's token must carry the `silentsumSupport` custom claim, set by an operator with the Admin
 * SDK. There is no self-service path to that claim.
 *
 * The reply carries text and a timestamp. It never reads the user's vault, envelope, manifest or
 * entitlements, and it cannot: nothing in this module opens those paths.
 */
import { BillingFailure } from './errors';

/** The longest reply that will be written. Matches the client-side limit on the user's side. */
export const MAX_REPLY_LENGTH = 2000;

export interface SupportMessageRecord {
  readonly v: 1;
  readonly sender: 'support';
  readonly body: string;
  readonly createdAt: number;
  /** The operator account that wrote it, for an audit trail. Never shown to the user. */
  readonly authorUid: string;
}

export interface SupportStore {
  /** Writes one message into `support_threads/<uid>/messages/<id>`. */
  putSupportMessage(uid: string, id: string, record: SupportMessageRecord): Promise<void>;
  /** True when an account exists to answer. Keeps a typo from creating an orphan thread. */
  userExists(uid: string): Promise<boolean>;
}

export interface SupportReplyDeps {
  readonly store: SupportStore;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface SupportReplyInput {
  /** The signed-in caller's uid, and whether their token carries the support claim. */
  readonly callerUid: string;
  readonly isSupport: boolean;
  readonly uid: unknown;
  readonly body: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Writes one support reply. Every refusal happens before anything is written, and the error codes
 * are the callable ones the client already understands.
 */
export async function replyToUser(
  deps: SupportReplyDeps,
  input: SupportReplyInput,
): Promise<{ readonly id: string; readonly createdAt: number }> {
  if (!input.isSupport) {
    throw new BillingFailure('permission-denied', 'This account cannot answer support messages.');
  }
  const uid = text(input.uid);
  if (uid === null || uid.includes('/')) {
    throw new BillingFailure('invalid-argument', 'A user id is required.');
  }
  const body = text(input.body);
  if (body === null) {
    throw new BillingFailure('invalid-argument', 'A reply body is required.');
  }
  if (body.length > MAX_REPLY_LENGTH) {
    throw new BillingFailure('invalid-argument', 'That reply is too long.');
  }
  if (!(await deps.store.userExists(uid))) {
    throw new BillingFailure('invalid-argument', 'No such account.');
  }
  const createdAt = deps.now();
  const id = deps.newId();
  await deps.store.putSupportMessage(uid, id, {
    v: 1,
    sender: 'support',
    body,
    createdAt,
    authorUid: input.callerUid,
  });
  return { id, createdAt };
}
