/**
 * `Directory` over the `silentsumFindUser` callable.
 *
 * Every refusal the server can give maps onto a code the screens have copy for. `unauthenticated`
 * means either "nobody is signed in" or "App Check rejected this build"; unlike billing there is
 * nothing useful the user could do about the second, so both are reported the same way.
 */
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import { DirectoryError, type Directory } from '@/messaging/directory';

/** The deployed function names. Keep in step with `functions/src/index.ts`. */
export const DIRECTORY_FUNCTION = 'silentsumFindUser';
export const PEER_EMAIL_FUNCTION = 'silentsumPeerEmail';

function toDirectoryError(error: unknown): DirectoryError {
  if (error instanceof DirectoryError) return error;
  if (!(error instanceof CallableError)) return new DirectoryError('unavailable');
  switch (error.code) {
    case 'unauthenticated':
      return new DirectoryError('unauthenticated');
    case 'permission-denied':
      return new DirectoryError('pro-required');
    case 'resource-exhausted':
      return new DirectoryError('rate-limited');
    case 'invalid-argument':
      return new DirectoryError('invalid-email');
    default:
      return new DirectoryError('unavailable');
  }
}

export class FirebaseDirectory implements Directory {
  constructor(private readonly callable: CallableInvoker) {}

  async findByEmail(email: string): Promise<string | null> {
    try {
      const result = await this.callable.call<{ found?: unknown; uid?: unknown }>(
        DIRECTORY_FUNCTION,
        { email },
      );
      if (result.found !== true || typeof result.uid !== 'string' || result.uid === '') return null;
      return result.uid;
    } catch (error) {
      throw toDirectoryError(error);
    }
  }

  /**
   * Naming a correspondent never fails loudly.
   *
   * Nothing depends on the answer: with it a row says who is writing, without it the row says
   * their account id. Every refusal the server can give here -- no App Check, budget spent, not a
   * correspondent, offline -- has the same right response, which is to leave the id showing and
   * try again the next time the list is opened.
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
    } catch {
      return null;
    }
  }
}
