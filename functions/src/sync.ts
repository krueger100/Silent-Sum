/**
 * "I have paid": the app asking the backend to look at PayMongo's own record of a session,
 * for the case where the webhook is late or lost. It applies a paid session through exactly the
 * same path as the webhook, so it can never grant anything the webhook would not have.
 */
import { applyPaidCheckout } from './apply';
import type { BillingConfig } from './config';
import { BillingFailure, fromPayMongoError } from './errors';
import type { PayMongoClient } from './paymongo/client';
import { readCheckoutSession } from './paymongo/events';
import type { BillingStore } from './store';

export interface SyncDeps {
  readonly store: BillingStore;
  readonly paymongo: Pick<PayMongoClient, 'retrieveCheckoutSession'>;
  readonly config: BillingConfig;
  readonly now: () => number;
}

export type SyncOutcome = 'paid' | 'pending' | 'expired' | 'failed' | 'unknown';

export async function syncCheckout(
  deps: SyncDeps,
  input: { readonly uid: string; readonly checkoutId: unknown },
): Promise<SyncOutcome> {
  if (typeof input.checkoutId !== 'string' || input.checkoutId === '') {
    throw new BillingFailure('invalid-argument', 'checkoutId must be a string.');
  }
  // Only sessions this backend created, and only for the account that created them. Anything
  // else is "unknown" -- and PayMongo is not asked about it.
  const ref = await deps.store.getRef(input.checkoutId);
  if (ref === null || ref.kind !== 'checkout' || ref.uid !== input.uid) return 'unknown';
  if (ref.status === 'paid') return 'paid';

  let resource: Record<string, unknown>;
  try {
    resource = await deps.paymongo.retrieveCheckoutSession(ref.id);
  } catch (error) {
    throw fromPayMongoError(error);
  }
  const session = readCheckoutSession(resource);
  if (session === null) {
    throw new BillingFailure(
      'internal',
      'The payment provider answered with something unexpected.',
    );
  }

  if (session.payments.some((payment) => payment.status === 'paid')) {
    const report = await applyPaidCheckout(
      { store: deps.store, config: deps.config, now: deps.now },
      { session, eventId: null, source: 'sync' },
    );
    const accepted = report.results.some(
      (result) =>
        result.endsWith(':applied') ||
        result.endsWith(':duplicate') ||
        result.endsWith(':unchanged'),
    );
    // Paid, but for the wrong amount or an unknown session: nothing is granted, and the app is
    // told to keep waiting rather than told a lie either way. The operator sees it in the log.
    return accepted ? 'paid' : 'pending';
  }
  if (session.status === 'expired') {
    await deps.store.updateRef(ref.id, { status: 'expired' });
    return 'expired';
  }
  if (
    session.payments.length > 0 &&
    session.payments.every((payment) => payment.status === 'failed')
  ) {
    await deps.store.updateRef(ref.id, { status: 'failed' });
    return 'failed';
  }
  return 'pending';
}
