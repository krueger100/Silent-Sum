/**
 * `Directory` over the `silentsumFindUser` callable.
 *
 * Every refusal the server can give maps onto a code the screens have copy for. `unauthenticated`
 * means either "nobody is signed in" or "App Check rejected this build"; unlike billing there is
 * nothing useful the user could do about the second, so both are reported the same way.
 */
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import type { CloudUser } from '@/firebase/types';
import { DirectoryError, type Directory } from '@/messaging/directory';

/** The deployed function names. Keep in step with `functions/src/index.ts`. */
export const DIRECTORY_FUNCTION = 'silentsumFindUser';
export const PEER_EMAIL_FUNCTION = 'silentsumPeerEmail';

function toDirectoryError(error: unknown, signedIn: boolean): DirectoryError {
  if (error instanceof DirectoryError) return error;
  if (!(error instanceof CallableError)) return new DirectoryError('unavailable');
  switch (error.code) {
    case 'unauthenticated':
      // The server sends the same refusal for "no ID token" and "no App Check token", because it
      // saw neither. Only this side knows which, and telling a signed-in user to sign in is the
      // one answer that is certainly wrong. Same split as `FirebaseBillingService`.
      //
      // Deliberately NOT keyed on `CallableError.appCheckSent`, though that is now recorded:
      // somebody signed out has no App Check token either, and "sign in" is the one thing they
      // can act on. The flag earns its keep in the development breadcrumb, where it says which
      // token was missing without having to guess.
      return new DirectoryError(signedIn ? 'attestation' : 'unauthenticated');
    case 'permission-denied':
      return new DirectoryError('pro-required');
    case 'resource-exhausted':
      return new DirectoryError('rate-limited');
    case 'invalid-argument':
      return new DirectoryError('invalid-email');
    case 'unavailable':
        // Our own code for "no response at all". The server never spoke.
      return new DirectoryError('offline');
    case 'not-found':
    case 'internal':
    case 'unknown':
      // The server DID answer. A 404 means the function is not deployed or the base URL is
      // wrong; a 500 means it broke. Both are configuration or server faults, and neither is
      // an App Check problem -- reporting them as one sends the reader to the wrong console.
      return new DirectoryError('unavailable');
    default:
      return new DirectoryError('unavailable');
  }
}

export class FirebaseDirectory implements Directory {
  constructor(
    private readonly callable: CallableInvoker,
    /** Reads through to the backend each time, because signing out must change the answer. */
    private readonly currentUser: () => CloudUser | null,
  ) {}

  async findByEmail(email: string): Promise<string | null> {
    try {
      const result = await this.callable.call<{ found?: unknown; uid?: unknown }>(
        DIRECTORY_FUNCTION,
        { email },
      );
      if (result.found !== true || typeof result.uid !== 'string' || result.uid === '') return null;
      return result.uid;
    } catch (error) {
      throw toDirectoryError(error, this.currentUser() !== null);
    }
  }

  /**
   * Naming a correspondent is best effort, but it is not silent.
   *
   * Null means the server answered and has no address to give. A refusal -- no App Check, budget
   * spent, not a correspondent, offline -- throws, because the two call for opposite things: an
   * answer of "nobody" is settled and asking again would waste the hourly budget on it, while a
   * refusal is the one case worth retrying when the list is next opened.
   *
   * This used to swallow both into null, which read as "asked and answered" either way. The
   * caller marked the peer as asked, never asked again, and a row that failed its one lookup
   * showed an account id until the app was killed and reopened.
   */
  async emailForUid(uid: string): Promise<string | null> {
    try {
      const result = await this.callable.call<{ found?: unknown; email?: unknown }>(
        PEER_EMAIL_FUNCTION,
        { uid },
      );
      if (result.found !== true || typeof result.email !== 'string' || result.email === '') {
        return null;
      }
      return result.email;
    } catch (error) {
      // The breadcrumb stays: a lookup that never works leaves every row showing a uid, and
      // without this there is nothing on hand to say why.
      if ((globalThis as { __DEV__?: boolean }).__DEV__ === true) {
        const code = error instanceof CallableError ? error.code : String(error);
        console.warn(`[silentsum] peer e-mail lookup failed: ${code}`);
      }
      throw toDirectoryError(error, this.currentUser() !== null);
    }
  }
}
