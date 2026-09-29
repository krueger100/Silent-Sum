/**
 * Ending a conversation, for both people.
 *
 * Its own port rather than a method on `Directory`, which is about finding who to talk to and
 * would be a strange place to keep the one operation that destroys a thread.
 *
 * There is no client-side implementation of this and there cannot be: the security rules refuse
 * to delete a conversation or a message, and no client can delete a subcollection at all. It is a
 * callable, the permission check lives on the server, and this side only carries the request
 * across and reports what the server said.
 */
export type ConversationAdminErrorCode =
  /** Nobody is signed in, or App Check declined to vouch for this build. */
  | 'unauthenticated'
  /** The caller is not in that conversation. The server decides this, never the client. */
  | 'not-a-member'
  | 'invalid'
  | 'unavailable';

export class ConversationAdminError extends Error {
  constructor(readonly code: ConversationAdminErrorCode) {
    super(`ConversationAdminError(${code})`);
    this.name = 'ConversationAdminError';
  }
}

export interface ConversationAdmin {
  /**
   * Deletes the conversation, every message in it and its media, for BOTH members. Irreversible,
   * and it leaves no placeholder behind -- unlike a withdrawn message, the thread is simply gone
   * from the other person's list too.
   */
  deleteForBoth(conversationId: string): Promise<void>;
}

/**
 * The fake, for tests and for a build with no Firebase project. It enforces the same membership
 * gate the deployed function does, so a test cannot pass by skipping what the server would refuse.
 */
export class InMemoryConversationAdmin implements ConversationAdmin {
  readonly deleted: string[] = [];

  constructor(
    private readonly uid: () => string | null,
    /** Removes the conversation, its messages and its media from the fake backend. */
    private readonly purge: (conversationId: string) => Promise<void>,
  ) {}

  async deleteForBoth(conversationId: string): Promise<void> {
    const me = this.uid();
    if (me === null) throw new ConversationAdminError('unauthenticated');
    const parts = conversationId.split('__');
    if (parts.length !== 2 || parts[0] === parts[1] || parts.some((p) => p === '')) {
      throw new ConversationAdminError('invalid');
    }
    // The same membership gate the deployed function applies, so a test cannot pass by skipping
    // what the server would refuse.
    if (!parts.includes(me)) throw new ConversationAdminError('not-a-member');
    await this.purge(conversationId);
    this.deleted.push(conversationId);
  }
}
