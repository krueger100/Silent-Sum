/**
 * `ConversationAdmin` over the `silentsumDeleteConversation` callable.
 *
 * Every refusal the server can give maps onto a code the screens have copy for. As with the
 * directory, `unauthenticated` means either "nobody is signed in" or "App Check rejected this
 * build", and only this side can tell them apart -- so a signed-in user is never told to sign in.
 */
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import type { CloudUser } from '@/firebase/types';
import { ConversationAdminError, type ConversationAdmin } from '@/messaging/conversationAdmin';

/** The deployed function name. Keep in step with `functions/src/index.ts`. */
export const DELETE_CONVERSATION_FUNCTION = 'silentsumDeleteConversation';

function toAdminError(error: unknown, signedIn: boolean): ConversationAdminError {
  if (error instanceof ConversationAdminError) return error;
  if (!(error instanceof CallableError)) return new ConversationAdminError('unavailable');
  switch (error.code) {
    case 'unauthenticated':
      // Signed in already? Then the server saw no App Check token, not an absent user. Telling a
      // signed-in person to sign in is the one answer that is certainly wrong.
      //
      // `unavailable` was the second-wrong answer, and the one this used to give: its copy says
      // to try again shortly, and an unattested build is refused identically every time. Say
      // attestation, which names the one thing that does fix it -- installing from the store.
      return new ConversationAdminError(signedIn ? 'attestation' : 'unauthenticated');
    case 'permission-denied':
      return new ConversationAdminError('not-a-member');
    case 'invalid-argument':
      return new ConversationAdminError('invalid');
    default:
      return new ConversationAdminError('unavailable');
  }
}

export class FirebaseConversationAdmin implements ConversationAdmin {
  constructor(
    private readonly callable: CallableInvoker,
    private readonly currentUser: () => CloudUser | null,
  ) {}

  async deleteForBoth(conversationId: string): Promise<void> {
    try {
      await this.callable.call<unknown>(DELETE_CONVERSATION_FUNCTION, { conversationId });
    } catch (error) {
      throw toAdminError(error, this.currentUser() !== null);
    }
  }
}
