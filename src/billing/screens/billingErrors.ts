/**
 * User-facing copy for purchase failures.
 *
 * Raw messages from the callable, the SDK or PayMongo are never shown: they can carry uids,
 * e-mail addresses and endpoint URLs. Only the code is inspected. Account sign-in on the plans
 * screen goes through the same `CloudBackend` as the backup screen, so its errors reuse that
 * screen's sentences.
 */
import { describeCloudError } from '@/backup/screens/cloudErrors';
import { BillingError } from '@/billing/billingService';
import type { CheckoutOutcome } from '@/billing/billingService';
import { CloudError } from '@/firebase/types';

const GENERIC = 'The billing service could not start the payment. Try again in a moment.';

export function describeBillingError(error: unknown): string {
  if (error instanceof CloudError) return describeCloudError(error);
  if (!(error instanceof BillingError)) return 'Something went wrong. Nothing was charged.';
  switch (error.code) {
    case 'unauthenticated':
      return 'Sign in to your backup account first.';
    case 'app-check':
      return (
        'This build could not prove to the server that it is genuine, so the purchase was ' +
        'refused. Install the app from the store and try again, or contact support.'
      );
    case 'unavailable':
      return (
        'The billing service needs a connection and could not be reached. Nothing was charged. ' +
        'The vault does not need a connection.'
      );
    case 'already-owned':
      return 'You already own SilentSum Pro on this account. There is nothing more to buy.';
    case 'invalid-argument':
      return 'The server did not understand that request. Update the app and try again.';
    case 'permission-denied':
      return 'The server refused that request for this account.';
    case 'internal':
    case 'unknown':
      return GENERIC;
  }
}

/** What "I have paid" says for each answer the backend can give. `paid` is handled by the screen. */
export function describeSyncOutcome(outcome: Exclude<CheckoutOutcome, 'paid'>): string {
  switch (outcome) {
    case 'pending':
      return (
        'PayMongo has not confirmed the payment yet. If you finished paying, give it a moment ' +
        'and press again; this screen also updates by itself when the confirmation arrives.'
      );
    case 'failed':
      return 'That payment did not go through. Nothing was charged. You can start again.';
    case 'expired':
      return 'That checkout page expired before it was paid. Nothing was charged. Start again when you are ready.';
    case 'unknown':
      return 'PayMongo has no record of that checkout on this account. Start again if you still want it.';
  }
}
