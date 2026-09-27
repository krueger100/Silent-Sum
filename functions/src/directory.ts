/**
 * Resolving one e-mail address to one account id, for starting a conversation.
 *
 * This is the only way one user learns another's id, and it is deliberately narrow: an exact
 * address in, an id or "no" out. There is no prefix search, no listing, and the answer never
 * carries anything else about the account -- not a display name, not a creation date, nothing.
 *
 * Two gates sit in front of it. The caller must hold Pro, checked against the server-written
 * entitlement document and never against anything the client claims; and each caller gets a
 * budget per hour, so a paid account cannot be used to walk a list of addresses either.
 */
import { BillingFailure } from './errors';

/** How long one lookup budget lasts, and how many lookups fit in it. */
export const LOOKUP_WINDOW_MS = 3_600_000;
export const LOOKUP_LIMIT = 30;

const MAX_EMAIL_LENGTH = 320;

export interface DirectoryStore {
  /** Pro, as the entitlement document written by the webhook records it. */
  isPro(uid: string): Promise<boolean>;
  /**
   * Takes one lookup from `uid`'s budget for the current window, returning false when it is
   * already spent. Must be atomic: two lookups at once may not both see the same count.
   */
  consumeLookup(uid: string, now: number): Promise<boolean>;
  /** The account id for exactly this address, or null when there is none. */
  uidForEmail(email: string): Promise<string | null>;
  /** The address of exactly this account, or null when there is none. */
  emailForUid(uid: string): Promise<string | null>;
  /** Whether a conversation between these two accounts exists. Order must not matter. */
  sharesConversation(a: string, b: string): Promise<boolean>;
}

export interface DirectoryDeps {
  readonly store: DirectoryStore;
  readonly now: () => number;
}

export interface FindUserInput {
  readonly callerUid: string;
  readonly email: unknown;
}

/**
 * `uid` is present only when `found`. A missing account and a malformed address are NOT the same
 * answer: a bad address is the caller's mistake and is reported, while "no such account" is a
 * legitimate result that says nothing more than that.
 */
export interface FindUserResult {
  readonly found: boolean;
  readonly uid?: string;
}

function normaliseEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BillingFailure('invalid-argument', 'An e-mail address is required.');
  }
  const email = value.trim().toLowerCase();
  if (email === '' || email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BillingFailure('invalid-argument', 'That is not an e-mail address.');
  }
  return email;
}

export async function findUserByEmail(
  deps: DirectoryDeps,
  input: FindUserInput,
): Promise<FindUserResult> {
  const email = normaliseEmail(input.email);
  if (!(await deps.store.isPro(input.callerUid))) {
    throw new BillingFailure('permission-denied', 'Messaging is a SilentSum Pro feature.');
  }
  if (!(await deps.store.consumeLookup(input.callerUid, deps.now()))) {
    throw new BillingFailure(
      'resource-exhausted',
      'Too many lookups. Try again in an hour.',
    );
  }
  const uid = await deps.store.uidForEmail(email);
  return uid === null ? { found: false } : { found: true, uid };
}

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function normaliseUid(value: unknown): string {
  if (typeof value !== 'string' || !UID_PATTERN.test(value)) {
    throw new BillingFailure('invalid-argument', 'An account id is required.');
  }
  return value;
}

export interface FindPeerEmailInput {
  readonly callerUid: string;
  readonly uid: unknown;
}

export interface FindPeerEmailResult {
  readonly found: boolean;
  readonly email?: string;
}

/**
 * The address of somebody who is already talking to you.
 *
 * The forward lookup exists so you can start a conversation; this exists so the other side can be
 * named once it has started. Without it a recipient sees a raw account id, which tells them
 * nothing about who is writing to them -- and an id they cannot read is exactly the condition a
 * phishing attempt needs.
 *
 * The gate is membership, not Pro, and it is what keeps this from being an id-to-address oracle:
 * the answer is only ever given for an account the caller already shares a conversation with, and
 * conversations can only be created by the account that resolved the address in the first place.
 * So this reveals nothing that was not already half-known, to nobody who was not already a
 * correspondent. Pro is deliberately NOT required: receiving and reading never need it anywhere
 * else in the app, and a non-Pro recipient staring at a hex id would be the worse outcome.
 *
 * The same hourly budget as the forward lookup still applies, because this is still the directory.
 */
export async function findPeerEmail(
  deps: DirectoryDeps,
  input: FindPeerEmailInput,
): Promise<FindPeerEmailResult> {
  const uid = normaliseUid(input.uid);
  if (uid === input.callerUid) {
    throw new BillingFailure('invalid-argument', 'That is your own account.');
  }
  if (!(await deps.store.sharesConversation(input.callerUid, uid))) {
    throw new BillingFailure(
      'permission-denied',
      'You are not in a conversation with that account.',
    );
  }
  if (!(await deps.store.consumeLookup(input.callerUid, deps.now()))) {
    throw new BillingFailure('resource-exhausted', 'Too many lookups. Try again in an hour.');
  }
  const email = await deps.store.emailForUid(uid);
  return email === null ? { found: false } : { found: true, email };
}
