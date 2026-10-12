/**
 * Deleting a conversation, and the refusal that was telling people to wait for nothing.
 *
 * A callable answers `unauthenticated` both when nobody is signed in and when App Check declined
 * to vouch for the build; only this side knows which, because it knows whether it holds a user.
 * `FirebaseDirectory` and `FirebaseBillingService` both draw that line and report the second as
 * an attestation problem. This one did not: it sent a signed-in user to `unavailable`, whose copy
 * is "The server did not answer as expected. Try again shortly." -- advice that cannot ever come
 * true, because every retry from an unattested build is refused the same way.
 *
 * Observed for real: a sideloaded build (signed with the upload key rather than Play's) had every
 * callable refused with HTTP 401, and deleting a conversation told the user to try again shortly.
 */
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import { FirebaseConversationAdmin } from '@/firebase/firebaseConversationAdmin';
import type { CloudUser } from '@/firebase/types';
import { ConversationAdminError } from '@/messaging/conversationAdmin';

const SIGNED_IN: CloudUser = { uid: 'u1', email: 'u@example.test' };

function failing(code: string, user: CloudUser | null = SIGNED_IN): FirebaseConversationAdmin {
  const invoker: CallableInvoker = {
    call<T>(): Promise<T> {
      return Promise.reject(new CallableError(code, 'nope'));
    },
  };
  return new FirebaseConversationAdmin(invoker, () => user);
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof ConversationAdminError
      ? error.code
      : `not-an-admin-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('FirebaseConversationAdmin', () => {
  it('reads an unauthenticated refusal for a signed-in user as an App Check refusal', async () => {
    expect(await codeOf(() => failing('unauthenticated').deleteForBoth('c1'))).toBe('attestation');
  });

  it('still reports a genuine signed-out refusal as unauthenticated', async () => {
    expect(await codeOf(() => failing('unauthenticated', null).deleteForBoth('c1'))).toBe(
      'unauthenticated',
    );
  });

  it.each([
    ['permission-denied', 'not-a-member'],
    ['invalid-argument', 'invalid'],
    // The server answered, just not usefully, and none of these is App Check.
    ['internal', 'unavailable'],
    ['not-found', 'unavailable'],
  ])('maps %s to %s', async (code, expected) => {
    expect(await codeOf(() => failing(code).deleteForBoth('c1'))).toBe(expected);
  });

  it('passes an admin error of its own straight through', async () => {
    const invoker: CallableInvoker = {
      call<T>(): Promise<T> {
        return Promise.reject(new ConversationAdminError('not-a-member'));
      },
    };
    const admin = new FirebaseConversationAdmin(invoker, () => SIGNED_IN);
    expect(await codeOf(() => admin.deleteForBoth('c1'))).toBe('not-a-member');
  });

  it('reports anything that is not a callable failure as unavailable', async () => {
    const invoker: CallableInvoker = {
      call<T>(): Promise<T> {
        return Promise.reject(new TypeError('boom'));
      },
    };
    const admin = new FirebaseConversationAdmin(invoker, () => SIGNED_IN);
    expect(await codeOf(() => admin.deleteForBoth('c1'))).toBe('unavailable');
  });
});
