/**
 * The directory's refusals, and one distinction that matters more than it looks.
 *
 * A callable refuses with `unauthenticated` both when nobody is signed in and when App Check
 * declined to vouch for the build -- the server cannot tell the app which it was, because it never
 * saw a token either way. The client CAN tell, because it knows whether it holds a signed-in user.
 * Reported as "Sign in to your backup account first.", the second case sends a visibly signed-in
 * user to a sign-in screen they are already past, which is how this was first mistaken for a
 * messaging bug. `FirebaseBillingService` already draws this line; these tests hold the directory
 * to the same one.
 */
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import { FirebaseDirectory } from '@/firebase/firebaseDirectory';
import type { CloudUser } from '@/firebase/types';
import { DirectoryError } from '@/messaging/directory';

const SIGNED_IN: CloudUser = { uid: 'u1', email: 'u@example.test' };

function failing(code: string, user: CloudUser | null = SIGNED_IN): FirebaseDirectory {
  const invoker: CallableInvoker = {
    call<T>(): Promise<T> {
      return Promise.reject(new CallableError(code, 'nope'));
    },
  };
  return new FirebaseDirectory(invoker, () => user);
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof DirectoryError ? error.code : `not-a-directory-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('FirebaseDirectory', () => {
  it('reads an unauthenticated refusal for a signed-in user as an App Check refusal', async () => {
    expect(await codeOf(() => failing('unauthenticated').findByEmail('a@b.test'))).toBe(
      'attestation',
    );
  });

  it('still reports a genuine signed-out refusal as unauthenticated', async () => {
    expect(await codeOf(() => failing('unauthenticated', null).findByEmail('a@b.test'))).toBe(
      'unauthenticated',
    );
  });

  it.each([
    ['permission-denied', 'pro-required'],
    ['resource-exhausted', 'rate-limited'],
    ['invalid-argument', 'invalid-email'],
    ['internal', 'unavailable'],
  ])('maps the callable code %s to %s', async (from, to) => {
    expect(await codeOf(() => failing(from).findByEmail('a@b.test'))).toBe(to);
  });

  it('still says nothing rather than throwing when the reverse lookup is refused', async () => {
    // Naming a correspondent is decoration: a refusal leaves the account id showing.
    await expect(failing('unauthenticated').emailForUid('u2')).resolves.toBeNull();
  });
});
