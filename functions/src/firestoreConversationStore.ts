/**
 * `ConversationStore` on Firestore and Cloud Storage through the Admin SDK.
 *
 * Layout it removes (see `firebase/firestore.merged.rules` for who may read what):
 *   conversations/{cid}/messages/*     every message in the thread
 *   conversations/{cid}                the thread itself
 *   users/{uid}/contacts/{peerUid}     each side's private label for the other
 *   messages/{cid}/**                  the media objects, in the vault bucket
 *
 * Messages are deleted in batches rather than one call: a thread can hold thousands, a Firestore
 * batch caps at 500 writes, and `listDocuments()` returns references without reading any document
 * bodies -- which matters because those bodies are ciphertext this server has no business loading
 * into memory to throw away.
 */
import { getStorage } from 'firebase-admin/storage';
import type { Firestore } from 'firebase-admin/firestore';

import type { ConversationStore } from './conversations';

/** Firestore's hard cap on writes in one batch. */
const BATCH_LIMIT = 500;

export class FirestoreConversationStore implements ConversationStore {
  constructor(
    private readonly db: Firestore,
    /** The vault bucket. Named explicitly so a deploy can never reach for the default one. */
    private readonly bucketName: string | null,
  ) {}

  async deleteMessages(conversationId: string): Promise<number> {
    const collection = this.db.collection(`conversations/${conversationId}/messages`);
    let removed = 0;
    for (;;) {
      // References only: no document body is read, so no ciphertext passes through this process.
      const refs = await collection.listDocuments();
      if (refs.length === 0) return removed;
      for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
        const batch = this.db.batch();
        for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
        await batch.commit();
      }
      removed += refs.length;
      // `listDocuments` is not paginated, so one pass is normally enough; the loop only matters
      // if something was written while this was running.
      if (refs.length < BATCH_LIMIT) return removed;
    }
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.db.doc(`conversations/${conversationId}`).delete();
  }

  async deleteContactLabel(uid: string, peerUid: string): Promise<void> {
    // Deleting a document that is not there is a no-op in Firestore, which is what makes the
    // whole operation safe to retry.
    await this.db.doc(`users/${uid}/contacts/${peerUid}`).delete();
  }

  async deleteMedia(conversationId: string): Promise<number> {
    if (this.bucketName === null) return 0;
    const prefix = `messages/${conversationId}/`;
    const bucket = getStorage().bucket(this.bucketName);
    const [files] = await bucket.getFiles({ prefix });
    let removed = 0;
    for (const file of files) {
      try {
        await file.delete();
        removed += 1;
      } catch {
        // An object already gone is the state we wanted. Anything else leaves a blob nothing
        // points at, which is inert, and must not fail the deletion of the thread itself.
      }
    }
    return removed;
  }
}
