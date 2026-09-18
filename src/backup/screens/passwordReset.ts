/**
 * "Forgot account password?" -- the one recovery this app can actually offer.
 *
 * It is worth being precise about what is being recovered, because the whole design depends on the
 * three secrets never being confused with one another. The account password says WHERE the
 * ciphertext lives; the recovery passphrase is the only thing that unwraps the key inside the
 * backup envelope; the PIN unwraps the same key locally. Resetting the first changes nothing about
 * the other two, nothing about the envelope, and nothing about a single uploaded byte -- Firebase
 * could not decrypt any of it before the reset and cannot after it.
 *
 * So this is not a backdoor and cannot become one. It is a mail to an inbox the user already
 * controls, and everything it leads to still stops at the passphrase.
 *
 * Two behaviours are enforced here rather than left to each screen, so the two sign-in forms
 * cannot drift apart:
 *
 *  - **The answer never says whether an account exists.** A project with e-mail enumeration
 *    protection off reports `user-not-found`; one with it on resolves silently. Both are reported
 *    to the user as the same sentence, so the screen is not an oracle for "is this address
 *    registered" -- which, for an app whose whole point is that its users are not obvious, matters
 *    more than the small convenience of a precise error.
 *  - **A blank address is refused locally**, before the network, because the provider's own code
 *    for it differs by platform.
 */
import { describeCloudError } from '@/backup/screens/cloudErrors';
import { CloudError, type CloudBackend } from '@/firebase/types';

/**
 * Shown next to the link on both forms. The sentence users need at the moment they are most
 * likely to assume the account password is what protects their photos.
 */
export const RESET_REASSURANCE =
  'Resetting your account password does not affect your encrypted backup. Your recovery ' +
  'passphrase is still required to restore it.';

/** Deliberately the same whether or not the address has an account. */
export function resetRequestedMessage(email: string): string {
  return (
    `If an account exists for ${email}, a password-reset link is on its way. Open it, choose a ` +
    'new password, then sign in here with it.'
  );
}

export type PasswordResetOutcome =
  | { readonly kind: 'requested'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/** Codes that mean "no such account". Answered as success: see the note above. */
const SILENT_CODES: ReadonlySet<string> = new Set([
  'user-not-found',
  'wrong-password',
  'invalid-credential',
  'invalid-login-credentials',
]);

/**
 * Asks the backend to mail a reset link and turns the result into one sentence to show.
 *
 * Never throws: both screens render the outcome, and a rejected promise on a link the user tapped
 * by mistake would be an unhandled rejection rather than a message.
 */
export async function requestPasswordReset(
  cloud: CloudBackend,
  rawEmail: string,
): Promise<PasswordResetOutcome> {
  const email = rawEmail.trim();
  if (email === '') {
    return { kind: 'failed', message: 'Enter the email address of your backup account first.' };
  }
  try {
    await cloud.sendPasswordReset(email);
    return { kind: 'requested', message: resetRequestedMessage(email) };
  } catch (cause) {
    if (cause instanceof CloudError && SILENT_CODES.has(cause.code.toLowerCase())) {
      return { kind: 'requested', message: resetRequestedMessage(email) };
    }
    return { kind: 'failed', message: describeCloudError(cause) };
  }
}
