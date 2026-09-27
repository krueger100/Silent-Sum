/**
 * `DirectoryStore` over Firestore and Auth, using the Admin SDK.
 *
 * The lookup budget lives in a server-only collection: no security rule grants a client any
 * access to `silentsum_directory_lookups`, so it cannot be read, reset or inflated from a phone.
 */
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';

import { LOOKUP_LIMIT, LOOKUP_WINDOW_MS, type DirectoryStore } from './directory';

export function entitlementsPath(uid: string): string {
  return `users/${uid}/billing/entitlements`;
}

export function lookupBudgetPath(uid: string): string {
  return `silentsum_directory_lookups/${uid}`;
}

export class FirestoreDirectoryStore implements DirectoryStore {
  constructor(
    private readonly db: Firestore,
    private readonly auth: Auth,
  ) {}

  async isPro(uid: string): Promise<boolean> {
    const snapshot = await this.db.doc(entitlementsPath(uid)).get();
    return snapshot.exists && snapshot.get('pro') === true;
  }

  /**
   * One transaction, so two lookups racing each other cannot both read the same count and both
   * decide there was room.
   */
  async consumeLookup(uid: string, now: number): Promise<boolean> {
    const reference = this.db.doc(lookupBudgetPath(uid));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const startedAt = snapshot.exists ? snapshot.get('windowStart') : undefined;
      const used = snapshot.exists ? snapshot.get('count') : undefined;
      const fresh = typeof startedAt !== 'number' || now - startedAt >= LOOKUP_WINDOW_MS;
      const count = fresh || typeof used !== 'number' ? 0 : used;
      if (count >= LOOKUP_LIMIT) return false;
      transaction.set(reference, {
        windowStart: fresh ? now : startedAt,
        count: count + 1,
      });
      return true;
    });
  }

  /** Absent, disabled or malformed all answer the same way: no such account. */
  async uidForEmail(email: string): Promise<string | null> {
    try {
      const user = await this.auth.getUserByEmail(email);
      return user.disabled ? null : user.uid;
    } catch {
      return null;
    }
  }

  /** The same three outcomes in reverse, plus an account that simply has no address. */
  async emailForUid(uid: string): Promise<string | null> {
    try {
      const user = await this.auth.getUser(uid);
      return user.disabled ? null : (user.email ?? null);
    } catch {
      return null;
    }
  }

  /**
   * A conversation id is its two members' uids sorted and joined, so membership is a single
   * document existence check and needs no query and no index.
   */
  async sharesConversation(a: string, b: string): Promise<boolean> {
    const id = [a, b].sort().join('__');
    const snapshot = await this.db.doc(`conversations/${id}`).get();
    return snapshot.exists;
  }
}
