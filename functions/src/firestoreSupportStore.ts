/**
 * `SupportStore` over Firestore and Auth, using the Admin SDK.
 *
 * The Admin SDK bypasses the security rules, which is exactly why this is the only place a
 * `sender: 'support'` message can come from. It writes into the same collection the app reads,
 * so a reply appears in the user's open conversation without any further plumbing.
 */
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';

import type { SupportMessageRecord, SupportStore } from './support';
import { SUPPORT_RELAY_WINDOW_MS, type SupportRelayCounters } from './supportRelay';

/** One conversation document per account, under the same owner subtree the app uses. */
export function supportThreadPath(uid: string): string {
  return `users/${uid}/support/thread`;
}

export class FirestoreSupportStore implements SupportStore {
  constructor(
    private readonly db: Firestore,
    private readonly auth: Auth,
  ) {}

  async putSupportMessage(uid: string, id: string, record: SupportMessageRecord): Promise<void> {
    const thread = this.db.doc(supportThreadPath(uid));
    // `merge` so answering never clobbers the user's own read marker on the thread document.
    await thread.set({ v: 1, uid, lastSupportMessageAt: record.createdAt }, { merge: true });
    await thread
      .collection('messages')
      .doc(id)
      .create({ ...record });
  }

  async userExists(uid: string): Promise<boolean> {
    try {
      await this.auth.getUser(uid);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Where the relay's counters live. A `silentsum_*` top-level collection, like the billing ones: no
 * rule matches it, and Firestore denies every path no match allows, so it is closed to every client
 * while the Admin SDK writes it freely.
 */
export const SUPPORT_RELAY_COLLECTION = 'silentsum_support_relay';

/**
 * The counters behind the support relay's rate limit: one document per key per window, incremented
 * in a transaction so two requests arriving together cannot both read the same value.
 *
 * Which keys exist and what the limits are is `supportRelay.ts`'s business, not this file's. All
 * this does is count, which is why the policy is testable and this adapter is thin.
 *
 * `expiresAt` is for a Firestore TTL policy on the collection. Without that policy the counters are
 * still correct -- a new window means a new document id -- they simply accumulate; see
 * firebase/README.md.
 */
export class FirestoreSupportRelayCounters implements SupportRelayCounters {
  constructor(private readonly db: Firestore) {}

  async bump(key: string, window: number): Promise<number> {
    const doc = this.db.collection(SUPPORT_RELAY_COLLECTION).doc(`${key}_${String(window)}`);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(doc);
      const seen = snapshot.get('count');
      const next = (typeof seen === 'number' ? seen : 0) + 1;
      tx.set(
        doc,
        {
          count: next,
          // Two windows' grace, so nothing is collected while its window is still open.
          expiresAt: new Date((window + 2) * SUPPORT_RELAY_WINDOW_MS),
        },
        { merge: true },
      );
      return next;
    });
  }
}
