/**
 * Failures the callables report to the app, in the vocabulary of Firebase callable error codes.
 * `index.ts` turns them into `HttpsError`s; nothing else in this package knows about Firebase.
 */
import { PayMongoApiError } from './paymongo/client';

export type BillingFailureCode =
  | 'invalid-argument'
  | 'failed-precondition'
  | 'permission-denied'
  | 'unauthenticated'
  | 'not-found'
  | 'resource-exhausted'
  | 'unavailable'
  | 'internal';

export class BillingFailure extends Error {
  constructor(
    readonly code: BillingFailureCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingFailure';
  }
}

/**
 * PayMongo being unreachable or broken is `unavailable` (try again later); PayMongo refusing
 * the request is `internal` (the deployment is misconfigured, and the user cannot fix it). The
 * provider's own wording stays in the server log and never reaches the phone.
 */
export function fromPayMongoError(error: unknown): BillingFailure {
  if (error instanceof BillingFailure) return error;
  if (error instanceof PayMongoApiError && (error.status === 0 || error.status >= 500)) {
    return new BillingFailure('unavailable', 'The payment provider could not be reached.');
  }
  return new BillingFailure('internal', 'The payment provider refused the request.');
}
