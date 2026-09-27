/**
 * Starting a purchase: one hosted PayMongo Checkout Session per attempt.
 *
 * Nothing about the account changes here. The session is created with the SERVER's price and
 * product copy, filed under the uid in `silentsum_billing_refs`, and its URL handed back for the
 * app to open. What happens next is PayMongo's page, then PayMongo's webhook (`webhook.ts`).
 */
import { priceFor, productFrom, type BillingConfig } from './config';
import { BillingFailure, fromPayMongoError } from './errors';
import type { PayMongoClient } from './paymongo/client';
import type { BillingStore } from './store';

export interface CreateCheckoutDeps {
  readonly store: BillingStore;
  readonly paymongo: Pick<PayMongoClient, 'createCheckoutSession'>;
  readonly config: BillingConfig;
  readonly now: () => number;
  /** A fresh opaque reference for the session (a UUID in production). */
  readonly newRef: () => string;
  /** Where PayMongo sends the browser afterwards. */
  readonly returnUrl: (outcome: 'success' | 'cancel') => string;
}

export interface CheckoutStart {
  readonly checkoutId: string;
  readonly checkoutUrl: string;
}

export async function createCheckout(
  deps: CreateCheckoutDeps,
  input: { readonly uid: string; readonly product: unknown },
): Promise<CheckoutStart> {
  const product = productFrom(input.product);
  if (product === null)
    throw new BillingFailure('invalid-argument', 'That is not something for sale.');

  if (product === 'pro') {
    const current = await deps.store.getEntitlements(input.uid);
    if (current?.pro === true) {
      throw new BillingFailure('failed-precondition', 'Pro is already on this account.', {
        reason: 'already-owned',
      });
    }
  }

  const ref = deps.newRef();
  const amountCentavos = priceFor(deps.config, product);
  let session;
  try {
    session = await deps.paymongo.createCheckoutSession({
      lineItem: {
        name: deps.config.names[product],
        description: deps.config.taglines[product],
        amountCentavos,
        currency: deps.config.currency,
      },
      paymentMethodTypes: deps.config.paymentMethods,
      successUrl: deps.returnUrl('success'),
      cancelUrl: deps.returnUrl('cancel'),
      description: deps.config.names[product],
      referenceNumber: ref,
      metadata: { uid: input.uid, product, ref },
    });
  } catch (error) {
    throw fromPayMongoError(error);
  }

  await deps.store.putRef({
    kind: 'checkout',
    id: session.id,
    uid: input.uid,
    product,
    ref,
    amountCentavos,
    currency: deps.config.currency,
    status: 'open',
    createdAt: deps.now(),
    paidAt: null,
    paymentId: null,
  });

  return { checkoutId: session.id, checkoutUrl: session.checkoutUrl };
}
