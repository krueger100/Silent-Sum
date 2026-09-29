/**
 * Deleting a whole conversation, for both people.
 *
 * This exists as a function rather than a rule because the client cannot do it: the security
 * rules say `allow delete: if false` on both the conversation and its messages, and a client
 * could not delete a subcollection even if they allowed it -- Firestore has no recursive delete
 * on the wire. Only the Admin SDK can, and the Admin SDK bypasses rules, so the permission check
 * that would have been a rule has to live here instead. It is the first thing this module does.
 *
 * Who may do it: EITHER member. That is a real decision and worth being plain about. A message
 * belongs to the person who sent it, so only they can withdraw it; a conversation belongs to both,
 * and either can end it. The consequence is that one person can destroy the other's copy of the
 * whole thread, which is why the app asks for confirmation before calling this and why no
 * placeholder is left behind -- unlike a withdrawn message, a deleted conversation is simply gone.
 *
 * Order matters, and it is: media, then messages, then the conversation document, then the private
 * labels. Each step is safe to repeat, so a failure part-way leaves a conversation that can be
 * deleted again rather than a half-deleted one that cannot. The reverse order would strand blobs
 * with nothing left to name them.
 */
import { BillingFailure } from './errors';

export const CONVERSATION_ID_SEPARATOR = '__';

export interface ConversationStore {
  /** Deletes every document under `conversations/<cid>/messages`. Returns how many. */
  deleteMessages(conversationId: string): Promise<number>;
  /** Deletes `conversations/<cid>` itself. */
  deleteConversation(conversationId: string): Promise<void>;
  /** Deletes `users/<uid>/contacts/<peerUid>` for one direction. Missing is not an error. */
  deleteContactLabel(uid: string, peerUid: string): Promise<void>;
  /** Deletes every Storage object under `messages/<cid>/`. Returns how many. */
  deleteMedia(conversationId: string): Promise<number>;
}

export interface DeleteConversationDeps {
  readonly store: ConversationStore;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface DeleteConversationReport {
  readonly conversationId: string;
  readonly messages: number;
  readonly media: number;
}

/**
 * A uid this server is willing to put in a path. Mirrors `isUsableUid` in the app: anything with
 * a slash, a dot or the separator in it would make the id ambiguous and is refused rather than
 * escaped.
 */
function isUsableUid(uid: string): boolean {
  return (
    uid.length > 0 &&
    uid.length <= 128 &&
    !uid.includes('/') &&
    !uid.includes('.') &&
    !uid.includes(CONVERSATION_ID_SEPARATOR)
  );
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

export async function deleteConversation(
  deps: DeleteConversationDeps,
  input: { readonly callerUid: string; readonly conversationId: unknown },
): Promise<DeleteConversationReport> {
  const conversationId = input.conversationId;
  if (typeof conversationId !== 'string' || conversationId === '') {
    throw new BillingFailure('invalid-argument', 'A conversation id is required.');
  }
  const members = membersOf(conversationId);
  if (members === null) {
    throw new BillingFailure('invalid-argument', 'That is not a conversation id.');
  }
  // THE permission check. Derived from the id itself, exactly as the security rules derive
  // membership, so there is no document to read and nothing to race with.
  if (!members.includes(input.callerUid)) {
    throw new BillingFailure('permission-denied', 'You are not in that conversation.');
  }

  const media = await deps.store.deleteMedia(conversationId);
  const messages = await deps.store.deleteMessages(conversationId);
  await deps.store.deleteConversation(conversationId);
  // Both sides' private labels: the conversation is gone for both, so a label naming it is a
  // dangling reference to something neither can open.
  await deps.store.deleteContactLabel(members[0], members[1]);
  await deps.store.deleteContactLabel(members[1], members[0]);

  // Deliberately no uids and no id in the log: a conversation id IS two account ids, which makes
  // it social-graph metadata rather than a reference.
  deps.log?.('conversation deleted', { messages, media });
  return { conversationId, messages, media };
}
